import time
from sqlalchemy import select, update
from app.db import *


def token(c, name="Laptop Claude Code"):
    r = c.post("/api/agent-tokens", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def rpc(c, tok, method, params=None, id=1, headers=None):
    body = {"jsonrpc": "2.0", "id": id, "method": method}
    if params is not None:
        body["params"] = params
    return c.post(
        "/mcp",
        json=body,
        headers={"Authorization": f"Bearer {tok}", "Accept": "application/json, text/event-stream"} | (headers or {}),
    )


def call(c, tok, name, **args):
    r = rpc(c, tok, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    return result["content"][0]["text"], result["isError"]


def seed(c):
    folder = c.post("/api/folders", json={"name": "Research"}).json()
    a = c.post(
        "/api/meetings",
        json={"title": "Budget review", "folder_id": folder["id"], "starts_at": "2026-11-10T15:00:00Z"},
    ).json()
    c.patch(
        f"/api/meetings/{a['id']}",
        json={"notes": "Talked about the GPU budget\n- [ ] Email Alice the quote\n- [x] Done thing", "notes_revision": 0},
    )
    b = c.post("/api/meetings", json={"title": "Standup", "starts_at": "2026-11-12T15:00:00Z"}).json()
    with tx() as s:
        r = Recording(meeting_id=b["id"], label="Laptop mic", token="x", status="ready", duration=120)
        s.add(r)
        s.flush()
        for i, text in enumerate(["Morning everyone", "The cluster migration slipped a week", "Bob owns the fix"]):
            s.add(Segment(recording_id=r.id, start=i * 30.0, end=i * 30.0 + 10, text=text, raw_text=text, language="en"))
        s.execute(
            update(Meeting).where(Meeting.id == b["id"]).values(enhanced_notes="## Actions\n- [ ] Bob fixes migration [[0:30]]")
        )
    return folder, a, b


def test_token_lifecycle_and_auth(client):
    assert rpc(client, "", "ping").status_code == 401
    assert rpc(client, "huh_wrong", "ping").status_code == 401
    t = token(client)
    assert t["token"].startswith("huh_") and t["hint"] == t["token"][:8]
    listed = client.get("/api/agent-tokens").json()
    assert [x["id"] for x in listed] == [t["id"]]
    assert "token" not in listed[0] and listed[0]["last_used_at"] is None
    with tx() as s:
        assert t["token"] not in str(s.get(AgentToken, t["id"]).__dict__)
    assert rpc(client, t["token"], "ping").json() == {"jsonrpc": "2.0", "id": 1, "result": {}}
    assert client.get("/api/agent-tokens").json()[0]["last_used_at"]
    # The browser session alone doesn't open /mcp.
    assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    # Foreign web pages can't use it either.
    assert rpc(client, t["token"], "ping", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.delete(f"/api/agent-tokens/{t['id']}").json() == {"ok": True}
    assert rpc(client, t["token"], "ping").status_code == 401
    assert client.post("/api/agent-tokens", json={"name": "  "}).status_code == 422
    # An agent token never unlocks the app's own API.
    t2 = token(client)
    client.cookies.clear()
    assert client.get("/api/meetings", headers={"Authorization": f"Bearer {t2['token']}"}).status_code == 401


def test_protocol(client):
    t = token(client)["token"]
    r = rpc(client, t, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    init = r.json()["result"]
    assert init["protocolVersion"] == "2025-06-18"
    assert init["capabilities"] == {"tools": {"listChanged": False}}
    assert init["serverInfo"]["name"] == "huh" and "instructions" in init
    assert rpc(client, t, "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]["protocolVersion"] == "2025-11-25"
    n = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={"Authorization": f"Bearer {t}"})
    assert n.status_code == 202 and not n.content
    tools = rpc(client, t, "tools/list").json()["result"]["tools"]
    assert {x["name"] for x in tools} == {"search_meetings", "list_meetings", "get_meeting", "get_transcript", "list_folders", "list_todos"}
    assert all(x["annotations"]["readOnlyHint"] and x["inputSchema"]["type"] == "object" for x in tools)
    assert rpc(client, t, "resources/list").json()["error"]["code"] == -32601
    assert rpc(client, t, "tools/call", {"name": "drop_tables"}).json()["error"]["code"] == -32602
    bad = client.post("/mcp", content=b"{nope", headers={"Authorization": f"Bearer {t}", "content-type": "application/json"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == -32700
    assert rpc(client, t, "ping", headers={"MCP-Protocol-Version": "1999-01-01"}).status_code == 400
    batch = client.post(
        "/mcp",
        json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}],
        headers={"Authorization": f"Bearer {t}"},
    )
    assert batch.json() == [{"jsonrpc": "2.0", "id": 1, "result": {}}]
    assert client.get("/mcp", headers={"Authorization": f"Bearer {t}"}).status_code == 405
    # OAuth discovery probes get a 404, not the app's HTML.
    assert client.get("/.well-known/oauth-protected-resource").status_code == 404


def test_tools_read_the_notebook(client):
    folder, a, b = seed(client)
    t = token(client)["token"]

    text, err = call(client, t, "search_meetings", query="gpu budget")
    assert not err and "Budget review" in text and a["id"] in text and "My notes" in text
    text, _ = call(client, t, "search_meetings", query="cluster")
    assert "Standup" in text and "Transcript 0:30, get_transcript offset 1" in text
    # Words that don't appear together still find the meeting.
    text, _ = call(client, t, "search_meetings", query="Alice quote")
    assert "Budget review" in text and "by word" in text
    assert "No meetings" in call(client, t, "search_meetings", query="zebra")[0]
    assert call(client, t, "search_meetings", query="x")[1]

    text, _ = call(client, t, "list_meetings")
    assert text.index("Standup") < text.index("Budget review") and "folder: Research" in text
    assert "transcript (3 lines, 2 min)" in text
    text, _ = call(client, t, "list_meetings", from_date="2026-11-11", to_date="2026-11-12")
    assert "Standup" in text and "Budget review" not in text
    text, _ = call(client, t, "list_meetings", folder="research")
    assert "Budget review" in text and "Standup" not in text
    assert call(client, t, "list_meetings", from_date="last week")[1]
    assert call(client, t, "list_meetings", folder="Nope")[1]

    text, _ = call(client, t, "get_meeting", meeting_id=a["id"])
    assert "Email Alice the quote" in text and "Folder: Research" in text and "Transcript: none" in text
    assert call(client, t, "get_meeting", meeting_id="missing")[1]

    text, _ = call(client, t, "get_transcript", meeting_id=b["id"], offset=1, limit=1)
    assert "[0:30] The cluster migration slipped a week" in text and "Morning" not in text
    assert "offset 2" in text
    assert "no transcript" in call(client, t, "get_transcript", meeting_id=a["id"])[0]

    text, _ = call(client, t, "list_folders")
    assert "Research — 1 meeting(s)" in text and "(no folder) — 1 meeting(s)" in text

    text, _ = call(client, t, "list_todos")
    assert "Email Alice the quote" in text and "Bob fixes migration" in text
    assert "Done thing" not in text and "[[" not in text
    assert "Bob" not in call(client, t, "list_todos", folder="Research")[0]

    # Archived meetings drop out of lists by default but stay searchable.
    client.patch(f"/api/meetings/{a['id']}", json={"archived": True})
    assert "Budget review" not in call(client, t, "list_meetings")[0]
    assert "Budget review" in call(client, t, "list_meetings", include_archived=True)[0]
    assert "archived" in call(client, t, "search_meetings", query="budget")[0]
    assert "Budget review" not in call(client, t, "search_meetings", query="budget", include_archived=False)[0]


def test_search_endpoint_still_works(client):
    seed(client)
    hits = client.get("/api/search", params={"q": "cluster"}).json()["results"]
    assert hits and hits[0]["field"] == "transcript" and hits[0]["start"] == 30.0
