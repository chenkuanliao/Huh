import json, time, uuid
import pytest
from sqlalchemy import delete, select
from app.db import *
from app import worker, providers, oauth
from app.security import decrypt


def meeting(c):
    return c.post("/api/meetings", json={"title": "Review"}).json()["id"]


def device(c, mid, name="Laptop", backup=True):
    id = str(uuid.uuid4())
    hb = {
        "id": id,
        "name": name,
        "meeting_id": mid,
        "ready": True,
        "backup_enabled": backup,
    }
    assert c.post("/api/devices/heartbeat", json=hb).status_code == 200
    return id, hb


def command(c, hb):
    return c.post("/api/devices/heartbeat", json=hb).json()["command"]


def start(c, mid, id, hb):
    assert (
        c.post(
            f"/api/meetings/{mid}/recording-control",
            json={"action": "start", "device_id": id},
        ).status_code
        == 200
    )
    cmd = command(c, hb)
    assert (
        c.post(
            f"/api/recordings/{cmd['recording_id']}/started",
            json={"token": cmd["token"]},
        ).status_code
        == 200
    )
    return cmd


def upload(c, mid, data=b"abcdef", mode="additional"):
    r = c.post(
        f"/api/meetings/{mid}/uploads",
        json={
            "filename": "voice.m4a",
            "mime_type": "audio/mp4",
            "size": len(data),
            "mode": mode,
        },
    ).json()
    h = {"content-type": "audio/mp4", "x-recording-token": r["token"]}
    assert (
        c.put(
            f"/api/recordings/{r['recording_id']}/chunks/0", content=data, headers=h
        ).status_code
        == 200
    )
    return r, h


def test_auth_csrf_session_and_keys(client):
    assert client.get("/api/auth/status").json()["authenticated"]
    assert (
        client.post(
            "/api/auth/setup", json={"password": "another-long-password"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/meetings", json={}, headers={"Origin": "https://evil.test"}
        ).status_code
        == 403
    )
    response = client.put(
        "/api/settings",
        json={"api_keys": {"openai": "secret-api-test"}, "provider": "openai"},
    )
    assert response.json()["api_key_status"]["openai"]
    assert "secret-api-test" not in response.text
    with tx() as s:
        encrypted = getkv(s, "keys")["openai"]
        assert "secret-api-test" not in encrypted
        assert decrypt(encrypted) == "secret-api-test"
    assert client.put("/api/settings", json={"api_keys": {"openai": ""}}).json()[
        "api_key_status"
    ]["openai"]
    assert not client.put("/api/settings", json={"api_keys": {"openai": None}}).json()[
        "api_key_status"
    ]["openai"]
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/meetings").status_code == 401
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"password": "correct horse battery staple"}
        ).status_code
        == 200
    )


def test_revision_conflict_and_generation_preserves_new_edits(client, monkeypatch):
    mid = meeting(client)
    assert (
        client.patch(
            f"/api/meetings/{mid}", json={"notes": "Priorities", "notes_revision": 0}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/meetings/{mid}", json={"notes": "stale", "notes_revision": 0}
        ).status_code
        == 409
    )
    assert (
        client.patch(
            f"/api/meetings/{mid}", json={"notes": "missing revision"}
        ).status_code
        == 409
    )
    r, h = upload(client, mid)
    with tx() as s:
        rec = s.get(Recording, r["recording_id"])
        rec.status = "transcribed"
        s.add(
            Segment(
                recording_id=rec.id,
                start=0,
                end=1,
                text="evidence",
                raw_text="evidence",
                language="en",
            )
        )
    j = client.post(f"/api/meetings/{mid}/generate", json={}).json()
    client.patch(
        f"/api/meetings/{mid}",
        json={"enhanced_notes": "My hand edit", "enhanced_revision": 0},
    )
    monkeypatch.setattr(providers, "infer", lambda *a: "Generated evidence notes")
    job = worker.claim_job()
    assert job.id == j["id"]
    worker.process(job)
    d = client.get(f"/api/meetings/{mid}").json()
    assert d["enhanced_notes"] == "My hand edit"
    assert d["notes"] == "Priorities"
    assert d["generations"][0]["content"] == "Generated evidence notes"
    assert d["generations"][0]["notes_revision"] == 1
    assert d["jobs"][0]["status"] == "completed"


def test_handoff_ack_and_stop(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    b, hb = device(client, mid, "Phone")
    start(client, mid, a, ha)
    st = client.post(
        f"/api/meetings/{mid}/recording-control",
        json={"action": "switch", "device_id": b},
    ).json()
    assert st["status"] == "switching" and st["active_device_id"] == a
    assert command(client, ha) is None
    cb = command(client, hb)
    assert (
        client.post(
            f"/api/recordings/{cb['recording_id']}/started", json={"token": "wrong"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/recordings/{cb['recording_id']}/started", json={"token": cb["token"]}
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/recordings/{cb['recording_id']}/started", json={"token": cb["token"]}
        ).status_code
        == 200
    )
    assert command(client, ha)["type"] == "stop"
    assert (
        client.get(f"/api/meetings/{mid}/recording-state").json()["active_device_id"]
        == b
    )
    client.post(f"/api/meetings/{mid}/recording-control", json={"action": "stop"})
    assert command(client, hb)["type"] == "stop"
    assert (
        client.post(
            f"/api/recordings/{cb['recording_id']}/started", json={"token": cb["token"]}
        ).status_code
        == 409
    )


def test_armed_ordered_failover_and_start_timeout(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    b, hb = device(client, mid, "Unarmed", False)
    c, hc = device(client, mid, "Backup")
    start(client, mid, a, ha)
    client.patch(
        f"/api/meetings/{mid}/recording-policy",
        json={"auto_fallback": True, "backup_order": [b, c]},
    )
    with tx() as s:
        s.get(Device, a).last_seen = now() - 20
    st = client.get(f"/api/meetings/{mid}/recording-state").json()
    assert (
        st["status"] == "starting"
        and st["active_device_id"] is None
        and st["pending_device_id"] == c
    )
    cmd = command(client, hc)
    with tx() as s:
        s.get(Recording, cmd["recording_id"]).created_at = now() - 20
    st = client.get(f"/api/meetings/{mid}/recording-state").json()
    assert st["status"] == "paused" and st["active_device_id"] is None
    assert (
        client.post(
            f"/api/recordings/{cmd['recording_id']}/started",
            json={"token": cmd["token"]},
        ).status_code
        == 409
    )


def test_pause_resume_keeps_one_recording_and_defers_processing(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    b, hb = device(client, mid, "Backup")
    active = start(client, mid, a, ha)
    rid = active["recording_id"]
    endpoint = f"/api/meetings/{mid}/recording-control"
    client.patch(f"/api/meetings/{mid}/recording-policy", json={"auto_fallback": True, "backup_order": [b]})
    ha.update(recording_id=rid, capture_state="recording")
    for _ in range(2):
        assert client.post(endpoint, json={"action": "pause"}).json()["status"] == "paused"
        assert command(client, ha)["type"] == "pause"
        ha["capture_state"] = "paused"
        assert command(client, ha) is None
        assert command(client, hb) is None
        assert client.get(f"/api/meetings/{mid}/recording-state").json()["status"] == "paused"
        assert client.post(endpoint, json={"action": "resume"}).json()["status"] == "recording"
        cmd = command(client, ha)
        assert cmd["type"] == "resume" and cmd["recording_id"] == rid
        ha["capture_state"] = "recording"
    with tx() as s:
        assert len(list(s.scalars(select(Recording).where(Recording.meeting_id == mid)))) == 1
        assert not list(s.scalars(select(Job).where(Job.meeting_id == mid)))
    client.post(endpoint, json={"action": "pause"})
    assert client.put(f"/api/recordings/{rid}/chunks/0", content=b"saved audio", headers={"content-type": "audio/webm", "x-recording-token": active["token"]}).status_code == 200
    assert client.post(endpoint, json={"action": "stop"}).json()["status"] == "idle"
    assert command(client, ha)["type"] == "stop"
    assert client.post(f"/api/recordings/{rid}/finish", json={"token": active["token"], "chunk_count": 1, "duration": 12}).status_code == 200
    with tx() as s:
        jobs = list(s.scalars(select(Job).where(Job.meeting_id == mid)))
        assert len(jobs) == 1 and jobs[0].kind == "transcribe"
        assert s.get(Recording, rid).duration == 12


def test_unexpected_capture_end_starts_armed_backup(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    b, hb = device(client, mid, "Backup")
    active = start(client, mid, a, ha)
    client.patch(
        f"/api/meetings/{mid}/recording-policy",
        json={"auto_fallback": True, "backup_order": [b]},
    )
    endpoint = f"/api/recordings/{active['recording_id']}"
    assert client.put(
        endpoint + "/chunks/0", content=b"retained audio",
        headers={"content-type": "audio/webm", "x-recording-token": active["token"]},
    ).status_code == 200
    assert client.post(
        endpoint + "/finish", json={"token": active["token"], "chunk_count": 1},
    ).status_code == 200
    state = client.get(f"/api/meetings/{mid}/recording-state").json()
    assert state["status"] == "starting" and state["pending_device_id"] == b
    assert command(client, hb)["type"] == "start"


def test_idempotent_chunks_completeness_and_range(client):
    mid = meeting(client)
    r, h = upload(client, mid)
    rid = r["recording_id"]
    endpoint = f"/api/recordings/{rid}"
    assert client.put(endpoint + "/chunks/0", content=b"abcdef", headers=h).json() == {
        "index": 0,
        "bytes": 6,
    }
    assert (
        client.put(endpoint + "/chunks/0", content=b"different", headers=h).status_code
        == 409
    )
    assert (
        client.put(endpoint + "/chunks/2", content=b"gap", headers=h).status_code == 409
    )
    assert (
        client.post(
            endpoint + "/finish", json={"token": r["token"], "chunk_count": 2}
        ).status_code
        == 409
    )
    assert (
        client.post(
            endpoint + "/finish", json={"token": r["token"], "chunk_count": 1}
        ).status_code
        == 200
    )
    assert (
        client.post(
            endpoint + "/finish", json={"token": r["token"], "chunk_count": 1}
        ).status_code
        == 200
    )
    assert client.get(endpoint + "/audio").content == b"abcdef"
    partial = client.get(endpoint + "/audio", headers={"Range": "bytes=1-3"})
    assert partial.status_code == 206 and partial.content == b"bcd"
    with tx() as s:
        assert len(list(s.scalars(select(Job).where(Job.kind == "transcribe")))) == 1
        assert s.get(Recording, rid).bytes == 6


def test_complete_import_excludes_only_after_finish(client):
    mid = meeting(client)
    old, _ = upload(client, mid)
    new, _ = upload(client, mid, mode="complete")
    with tx() as s:
        assert not s.get(Recording, old["recording_id"]).excluded
    client.post(
        f"/api/recordings/{new['recording_id']}/finish",
        json={"token": new["token"], "chunk_count": 1},
    )
    with tx() as s:
        assert s.get(Recording, old["recording_id"]).excluded
        assert not s.get(Recording, new["recording_id"]).excluded


def test_job_recovery_claim_fencing_retry(client, monkeypatch):
    client.post("/api/stt/models/download", json={"model": "tiny"})
    first = worker.claim_job()
    assert first and worker.claim_job() is None
    with tx() as s:
        s.get(Job, first.id).lease = now() - 1
    second = worker.claim_job()
    assert second.id == first.id and second.claim != first.claim
    with tx() as s:
        with pytest.raises(RuntimeError):
            worker.current(s, first)
    monkeypatch.setattr(
        worker,
        "download_job",
        lambda j: (_ for _ in ()).throw(RuntimeError("Download failed")),
    )
    worker.process(second)
    with tx() as s:
        job = s.get(Job, second.id)
        assert job.status == "queued" and job.error == "Download failed"
        job.available = 0
    third = worker.claim_job()
    worker.process(third)
    with tx() as s:
        assert s.get(Job, third.id).status == "failed"


def test_oauth_pkce_exact_redirect_and_one_use(client, monkeypatch):
    from urllib.parse import urlsplit, parse_qs

    info = client.post("/api/chatgpt/sign-in").json()
    p = parse_qs(urlsplit(info["authorize_url"]).query)
    assert p["agent_name_hint"] == ["Huh"] and p["code_challenge_method"] == ["S256"]
    assert p["redirect_uri"] == [oauth.REDIRECT]
    assert (
        client.post(
            "/api/chatgpt/callback",
            json={
                "url": oauth.REDIRECT.replace("1457", "1458")
                + "?state="
                + p["state"][0]
                + "&code=x"
            },
        ).status_code
        == 502
    )
    url = oauth.REDIRECT + "?state=" + p["state"][0] + "&code=x&client_id=oaiapp_test"
    monkeypatch.setattr(
        oauth,
        "token_request",
        lambda data: {
            "access_token": "at",
            "refresh_token": "rt",
            "id_token": "id",
            "scope": "chatgpt.tokens.use.direct",
            "expires_in": 3600,
        },
    )
    monkeypatch.setattr(
        oauth,
        "verify",
        lambda token, client, nonce: {"sub": "owner", "email": "owner@example.test"},
    )
    result = client.post("/api/chatgpt/callback", json={"url": url})
    assert result.status_code == 200 and result.json()["plan_enabled"]
    assert "access_token" not in result.text
    assert client.post("/api/chatgpt/callback", json={"url": url}).status_code == 502
    with tx() as s:
        assert "refresh_token" not in json.dumps(getkv(s, "oauth"))


def test_templates_validation_export(client):
    tid = client.post(
        "/api/templates",
        json={
            "name": "Standup",
            "instructions": "Keep concise",
            "structure": "## Tasks",
        },
    ).json()["id"]
    mid = client.post("/api/meetings", json={"template_id": tid}).json()["id"]
    assert (
        client.patch("/api/templates/" + tid, json={"name": "Daily"}).json()["name"]
        == "Daily"
    )
    assert client.get(f"/api/meetings/{mid}/export").status_code == 200
    assert client.post(f"/api/meetings/{mid}/generate", json={}).status_code == 409
    assert client.delete("/api/templates/" + tid).status_code == 200
    assert client.get("/api/meetings/" + mid).json()["template_id"] is None
    assert (
        client.post(
            f"/api/meetings/{mid}/uploads",
            json={"filename": "a", "mime_type": "text/html", "size": 3},
        ).status_code
        == 415
    )
    assert client.get("/api/stt/models").json()["cuda_available"] is None
    assert client.get("/api/settings").json()["stt_language"] == "mixed"
    assert client.delete("/api/meetings/" + mid).status_code == 200
    assert client.get("/api/meetings/" + mid).status_code == 404


@pytest.mark.parametrize(
    "provider",
    [
        "chatgpt",
        "openai",
        "anthropic",
        "google",
        "openrouter",
        "opencode",
        "nvidia",
        "custom",
    ],
)
def test_provider_wire_formats(client, monkeypatch, provider):
    import httpx

    client.put(
        "/api/settings",
        json={
            "api_keys": {
                p: "test-secret"
                for p in [
                    "openai",
                    "anthropic",
                    "google",
                    "openrouter",
                    "opencode",
                    "nvidia",
                ]
            }
        },
    )
    monkeypatch.setattr(oauth, "access_token", lambda: "oauth-secret")
    seen = []

    def handle(req):
        seen.append(req)
        body = json.loads(req.content)
        if provider in ["openai", "chatgpt"]:
            assert req.url.path == "/v1/responses"
            assert body["store"] is False and body["stream"] is True
            assert body["input"][0]["content"][0]["type"] == "input_text"
            return httpx.Response(
                200,
                text='data: {"type":"response.output_text.delta","delta":"Notes"}\n\ndata: {"type":"response.completed"}\n\n',
            )
        if provider == "anthropic":
            assert (
                req.headers["x-api-key"] == "test-secret" and body["system"] == "system"
            )
            return httpx.Response(
                200,
                json={
                    "content": [{"type": "text", "text": "Notes"}],
                    "stop_reason": "end_turn",
                },
            )
        if provider == "google":
            assert (
                req.headers["x-goog-api-key"] == "test-secret"
                and body["systemInstruction"]
            )
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "finishReason": "STOP",
                            "content": {"parts": [{"text": "Notes"}]},
                        }
                    ]
                },
            )
        assert body["messages"][0]["role"] == "system"
        return httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"content": "Notes"}}]
            },
        )

    original = httpx.Client
    monkeypatch.setattr(
        providers.httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(handle), **kw),
    )
    assert (
        providers.infer(
            {
                "provider": provider,
                "model": "test-model",
                "base_url": "http://localhost:1234/v1",
            },
            "system",
            "prompt",
        )
        == "Notes"
    )
    assert len(seen) == 1


def test_provider_interrupted_stream_is_failure(client, monkeypatch):
    import httpx

    monkeypatch.setattr(oauth, "access_token", lambda: "secret")
    original = httpx.Client
    monkeypatch.setattr(
        providers.httpx,
        "Client",
        lambda **kw: original(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(
                    200,
                    text='data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                )
            ),
            **kw,
        ),
    )
    with pytest.raises(providers.ProviderError, match="before completion"):
        providers.infer({"provider": "chatgpt", "model": "test"}, "system", "prompt")


def test_jwks_signature_nonce_issuer_audience(client, monkeypatch):
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class Discovery:
        def raise_for_status(self):
            pass

        def json(self):
            return {"jwks_uri": "https://auth.openai.com/.well-known/jwks.json"}

    class Key:
        def __init__(self, *a):
            pass

        def get_signing_key_from_jwt(self, *a):
            class Signed:
                pass

            value = Signed()
            value.key = key.public_key()
            return value

    monkeypatch.setattr(oauth.httpx, "get", lambda *a, **k: Discovery())
    monkeypatch.setattr(oauth.jwt, "PyJWKClient", Key)
    claims = {
        "iss": oauth.ISSUER,
        "aud": "client",
        "sub": "owner",
        "exp": time.time() + 60,
        "nonce": "expected",
    }
    token = jwt.encode(claims, key, algorithm="RS256")
    assert oauth.verify(token, "client", "expected")["sub"] == "owner"
    for audience, nonce in [("wrong", "expected"), ("client", "wrong")]:
        with pytest.raises(oauth.OAuthError):
            oauth.verify(token, audience, nonce)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(oauth.OAuthError):
        oauth.verify(jwt.encode(claims, other, algorithm="RS256"), "client", "expected")


def test_transcribe_retry_replaces_segments_and_generates_once(
    client, monkeypatch, tmp_path
):
    from types import SimpleNamespace
    import wave

    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(
        f"/api/recordings/{r['recording_id']}/finish",
        json={"token": r["token"], "chunk_count": 1},
    )
    client.put("/api/settings", json={"traditional_chinese": False})
    path = tmp_path / "sample.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(b"\0" * 32000)

    class Model:
        def transcribe(self, path, **kw):
            assert kw["multilingual"] is True and kw["vad_filter"] is False
            word = lambda p: SimpleNamespace(probability=p)
            return iter(
                [
                    SimpleNamespace(start=0, end=1, text="Hello 你好", language="zh", words=[word(0.9)] * 2),
                    # Filler over silence is dropped; the same words over speech are kept.
                    SimpleNamespace(start=5, end=6, text=" Thank you.", words=[word(0.6)] * 2),
                    SimpleNamespace(start=8, end=9, text=" Thank you.", words=[word(0.6)] * 2),
                ]
            ), SimpleNamespace(language="zh")

    monkeypatch.setattr(worker, "get_model", lambda c: Model())
    monkeypatch.setattr(worker, "speech_regions", lambda p: [(0, 1.2), (7.9, 9.1)])
    monkeypatch.setattr(worker, "audio_windows", lambda *a: [path])
    job = worker.claim_job()
    worker.transcribe_job(job)
    worker.transcribe_job(job)
    with tx() as s:
        segments = list(s.scalars(select(Segment)))
        assert [x.text for x in segments] == ["Hello 你好", "Thank you."]
        assert segments[1].start == 8
        assert len(list(s.scalars(select(Job).where(Job.kind == "generate")))) == 1


def test_paused_failover_can_resume_when_backup_becomes_ready(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    b, hb = device(client, mid, "Backup")
    start(client, mid, a, ha)
    client.patch(
        f"/api/meetings/{mid}/recording-policy",
        json={"auto_fallback": True, "backup_order": [b]},
    )
    with tx() as s:
        s.get(Device, a).last_seen = now() - 20
        s.get(Device, b).last_seen = now() - 20
    assert (
        client.get(f"/api/meetings/{mid}/recording-state").json()["status"] == "paused"
    )
    response = client.post("/api/devices/heartbeat", json=hb).json()
    assert response["command"]["type"] == "start"
    assert (
        client.get(f"/api/meetings/{mid}/recording-state").json()["pending_device_id"]
        == b
    )


def test_request_limits_and_cache_inspection_without_gpu(client):
    assert (
        client.post(
            "/api/meetings",
            content=b" " * 1048577,
            headers={"Content-Type": "application/json"},
        ).status_code
        == 413
    )
    path = (
        CACHE
        / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "revision"
    )
    path.mkdir(parents=True, exist_ok=True)
    for name in ["model.bin", "config.json", "tokenizer.json"]:
        (path / name).write_text("test")
    models = client.get("/api/stt/models").json()["models"]
    assert next(m for m in models if m["id"] == "large-v3-turbo")["downloaded"]


def test_oauth_exchange_cannot_reconnect_after_signout(client, monkeypatch):
    from urllib.parse import urlsplit, parse_qs

    info = client.post("/api/chatgpt/sign-in").json()
    state = parse_qs(urlsplit(info["authorize_url"]).query)["state"][0]

    def exchange(data):
        with tx() as s:
            v = oauth.load(s)
            oauth.save(s, {"host_id": v["host_id"]})
        return {
            "access_token": "at",
            "refresh_token": "rt",
            "id_token": "id",
            "scope": "chatgpt.tokens.use.direct",
        }

    monkeypatch.setattr(oauth, "token_request", exchange)
    monkeypatch.setattr(oauth, "verify", lambda *a: {"sub": "owner"})
    response = client.post(
        "/api/chatgpt/callback",
        json={
            "url": oauth.REDIRECT + "?state=" + state + "&code=x&client_id=oaiapp_test"
        },
    )
    assert response.status_code == 502
    assert not client.get("/api/chatgpt/status").json()["signed_in"]


def test_oauth_expired_pending_rejected_before_exchange(client, monkeypatch):
    from urllib.parse import urlsplit, parse_qs

    info = client.post("/api/chatgpt/sign-in").json()
    state = parse_qs(urlsplit(info["authorize_url"]).query)["state"][0]
    with tx() as s:
        v = oauth.load(s)
        v["pending"]["time"] = now() - 901
        oauth.save(s, v)
    monkeypatch.setattr(
        oauth,
        "token_request",
        lambda *a: pytest.fail("Expired callback must not exchange a code"),
    )
    response = client.post(
        "/api/chatgpt/callback",
        json={
            "url": oauth.REDIRECT + "?state=" + state + "&code=x&client_id=oaiapp_test"
        },
    )
    assert response.status_code == 502


def test_template_kinds_defaults_and_seed(client):
    rows = client.get("/api/templates").json()
    notes = [t for t in rows if t["kind"] == "notes"]
    ai = [t for t in rows if t["kind"] == "ai"]
    assert notes and ai and sum(t["is_default"] for t in rows) == 1
    note = client.post(
        "/api/templates", json={"name": "Agenda", "structure": "## Agenda", "kind": "notes"}
    ).json()
    assert note["kind"] == "notes"
    assert client.post("/api/templates", json={"name": "x", "kind": "bad"}).status_code == 422
    assert client.post("/api/templates", json={"name": " "}).status_code == 422
    # Note templates cannot drive generation or become the AI default.
    assert client.post("/api/meetings", json={"template_id": note["id"]}).status_code == 422
    mid = client.post("/api/meetings", json={}).json()["id"]
    assert (
        client.patch(f"/api/meetings/{mid}", json={"template_id": note["id"]}).status_code
        == 422
    )
    assert (
        client.patch("/api/templates/" + note["id"], json={"is_default": True}).status_code
        == 422
    )
    old = next(t for t in ai if t["is_default"])
    new = client.post(
        "/api/templates", json={"name": "Mine", "instructions": "x", "structure": "y"}
    ).json()
    assert client.delete("/api/templates/" + old["id"]).status_code == 409
    assert client.patch("/api/templates/" + new["id"], json={"is_default": True}).json()[
        "is_default"
    ]
    defaults = [t["id"] for t in client.get("/api/templates").json() if t["is_default"]]
    assert defaults == [new["id"]]
    assert client.delete("/api/templates/" + old["id"]).status_code == 200


def test_settings_remember_model_per_provider(client):
    s = client.put("/api/settings", json={"provider": "openai", "model": "gpt-a"}).json()
    s = client.put("/api/settings", json={"provider": "anthropic", "model": "claude-b"}).json()
    assert s["provider_models"] == {"openai": "gpt-a", "anthropic": "claude-b"}
    s = client.put("/api/settings", json={"provider": "openai", "model": ""}).json()
    assert s["provider_models"]["openai"] == "gpt-a"
    assert client.put("/api/settings", json={"provider_models": []}).status_code == 422
    assert (
        client.put("/api/settings", json={"provider_models": {"nope": "x"}}).status_code
        == 422
    )


def test_retranscribe_finished_recording(client):
    mid = meeting(client)
    r, h = upload(client, mid)
    rid = r["recording_id"]
    assert client.post(f"/api/recordings/{rid}/transcribe").status_code == 409
    client.post(f"/api/recordings/{rid}/finish", json={"token": r["token"], "chunk_count": 1})
    with tx() as s:
        s.get(Recording, rid).status = "transcribed"
    first = client.post(f"/api/recordings/{rid}/transcribe").json()
    assert first["kind"] == "transcribe" and first["status"] == "queued"
    # Repeated clicks reuse the queued job.
    assert client.post(f"/api/recordings/{rid}/transcribe").json()["id"] == first["id"]


def test_provider_errors_include_reason_without_secrets():
    import httpx

    response = httpx.Response(
        400,
        json={"error": {"code": "model_not_found", "message": "Bad key sk-abcdefghijkl and model x"}},
        request=httpx.Request("POST", "https://example.invalid"),
    )
    text = providers.describe(response)
    assert "HTTP 400" in text and "model_not_found" in text
    assert "sk-abcdefghijkl" not in text and "[redacted]" in text


def test_editor_default_views(client):
    s = client.get("/api/settings").json()
    assert s["notes_view"] == "live" and s["ai_notes_view"] == "preview"
    assert client.put("/api/settings", json={"notes_view": "write"}).json()["notes_view"] == "write"
    assert client.put("/api/settings", json={"ai_notes_view": "live"}).json()["ai_notes_view"] == "live"
    assert client.put("/api/settings", json={"ai_notes_view": "write"}).json()["ai_notes_view"] == "write"
    assert client.put("/api/settings", json={"notes_view": "edit"}).status_code == 422


def test_old_saved_source_view_migrates_to_live_once(client):
    from app import db

    with db.tx() as s:
        db.putkv(s, "settings", {**db.getkv(s, "settings"), "notes_view": "write"})
        db.putkv(s, "migrations", {})
    db.init()
    assert client.get("/api/settings").json()["notes_view"] == "live"
    # A Source choice made after the migration is kept.
    assert client.put("/api/settings", json={"notes_view": "write"}).json()["notes_view"] == "write"
    db.init()
    assert client.get("/api/settings").json()["notes_view"] == "write"


def test_back_behavior_setting(client):
    assert client.get("/api/settings").json()["back_behavior"] == "up"
    assert client.put("/api/settings", json={"back_behavior": "history"}).json()["back_behavior"] == "history"
    assert client.put("/api/settings", json={"back_behavior": "sideways"}).status_code == 422


def test_dashboard_summarizes_meetings(client):
    mid = meeting(client)
    empty = client.get("/api/dashboard").json()
    assert empty["meetings"] == {} and empty["jobs"] == []
    r, h = upload(client, mid)
    client.post(
        f"/api/recordings/{r['recording_id']}/finish",
        json={"token": r["token"], "chunk_count": 1, "duration": 42},
    )
    d = client.get("/api/dashboard").json()
    assert d["meetings"][mid]["recordings"] == 1
    assert d["meetings"][mid]["recorded_seconds"] == 42
    assert any(j["kind"] == "transcribe" and j["meeting_id"] == mid for j in d["jobs"])


def test_citations_become_hidden_time_markers():
    refs = {"T1": (1, 5.2), "T2": (1, 754.9), "T3": (2, 3725)}
    text = "- Ship it [[T1]]\n- Budget [[T2, t3]]\n- Mine [[notes]]\n- Bad [[T99]]"
    assert worker.resolve_citations(text, refs, False) == (
        "- Ship it [[0:05]]\n- Budget [[12:34, 1:02:05]]\n- Mine [[notes]]\n- Bad "
    )
    assert worker.resolve_citations("x [[T3]]", refs, True) == "x [[1:02:05#2]]"


def test_generation_prompt_requests_hidden_citations(client, monkeypatch):
    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    with tx() as s:
        s.add(Segment(recording_id=r["recording_id"], start=61, end=63, text="We ship Friday", raw_text="We ship Friday", language="en"))
        s.get(Recording, r["recording_id"]).status = "transcribed"
    client.post(f"/api/meetings/{mid}/generate", json={})
    seen = {}

    def infer(cfg, system, prompt):
        seen.update(system=system, prompt=prompt)
        return "## Decisions\n- Ship on Friday [[T1]]"

    monkeypatch.setattr(providers, "infer", infer)
    with tx() as s:
        s.execute(delete(Job).where(Job.kind != "generate"))
    job = worker.claim_job()
    worker.generate_job(job)
    assert "[T1 voice.m4a 1:01] We ship Friday" in seen["prompt"]
    assert "never mention sources" in seen["system"]
    assert client.get(f"/api/meetings/{mid}").json()["enhanced_notes"] == "## Decisions\n- Ship on Friday [[1:01]]"


def test_main_language_detection():
    assert worker.main_language(["We ship Friday and review the budget", ""]) == "English"
    assert worker.main_language(["我們星期五發布，然後檢查預算和時間表", "好的"]) == "Chinese"
    assert worker.main_language(["我們星期五發布 the new budget plan for Q3", "好"]) is None
    assert worker.main_language(["", "  "]) is None
    rule = worker.language_rule("auto", True, ["We ship Friday"])
    assert "Main language: English" in rule and "Traditional" not in rule
    zh = worker.language_rule("Traditional Chinese (繁體中文)", True, ["We ship Friday"])
    assert "Write the whole note in Traditional Chinese" in zh and "original language" in zh
    assert "Traditional Chinese characters" not in worker.language_rule("English", True, ["我們"])


def test_generation_language_override_and_meeting_choice(client, monkeypatch):
    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    with tx() as s:
        s.add(Segment(recording_id=r["recording_id"], start=1, end=2, text="We ship Friday", raw_text="", language="en"))
        s.get(Recording, r["recording_id"]).status = "transcribed"
        s.execute(delete(Job))
    seen = []
    monkeypatch.setattr(providers, "infer", lambda cfg, system, prompt: seen.append(system) or "- ok")

    def run(body):
        client.post(f"/api/meetings/{mid}/generate", json=body)
        worker.generate_job(worker.claim_job())

    run({})
    assert "Main language: English" in seen[-1]
    assert client.patch(f"/api/meetings/{mid}", json={"notes_language": "Traditional Chinese (繁體中文)"}).json()["notes_language"] == "Traditional Chinese (繁體中文)"
    run({})
    assert "Write the whole note in Traditional Chinese" in seen[-1]
    run({"output_language": "Japanese"})
    assert "Write the whole note in Japanese" in seen[-1]
    gens = client.get(f"/api/meetings/{mid}").json()["generations"]
    assert [g["output_language"] for g in gens][:2] == ["Japanese", "Traditional Chinese (繁體中文)"]
    assert client.patch(f"/api/meetings/{mid}", json={"notes_language": None}).json()["notes_language"] is None


def test_search_across_meetings(client):
    mid = meeting(client)
    client.patch(f"/api/meetings/{mid}", json={"notes": "Discuss the 100% budget_plan", "notes_revision": 0})
    r, h = upload(client, mid)
    with tx() as s:
        s.add(Segment(recording_id=r["recording_id"], start=12, end=14, text="The Budget is approved", raw_text="", language="en"))
    found = client.get("/api/search", params={"q": "budget"}).json()["results"]
    assert {x["field"] for x in found} == {"notes", "transcript"}
    t = next(x for x in found if x["field"] == "transcript")
    assert t["start"] == 12 and t["recording_id"] == r["recording_id"] and "Budget" in t["snippet"]
    # LIKE wildcards are literal.
    assert [x["field"] for x in client.get("/api/search", params={"q": "100%"}).json()["results"]] == ["notes"]
    assert client.get("/api/search", params={"q": "s_t"}).json()["results"] == []
    assert client.get("/api/search", params={"q": "x"}).json()["results"] == []


def test_audio_prefers_seekable_playback_copy(client):
    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    original = client.get(f"/api/recordings/{r['recording_id']}/audio")
    assert original.status_code == 200 and original.content == b"abcdef"
    (DATA / "recordings" / r["recording_id"] / "playback.m4a").write_bytes(b"0123456789")
    part = client.get(f"/api/recordings/{r['recording_id']}/audio", headers={"Range": "bytes=2-4"})
    assert part.status_code == 206 and part.content == b"234"
    assert part.headers["content-type"] == "audio/mp4"


def test_export_hides_source_markers(client):
    mid = meeting(client)
    client.patch(f"/api/meetings/{mid}", json={"enhanced_notes": "- Ship [[1:01, notes]]\n- Plan [[12:34#2]]", "enhanced_revision": 0})
    text = client.get(f"/api/meetings/{mid}/export").text
    assert "- Ship\n- Plan" in text and "[[" not in text


def test_delete_meeting_removes_everything(client):
    mid = meeting(client)
    r, h = upload(client, mid)
    rid = r["recording_id"]
    client.post(f"/api/recordings/{rid}/finish", json={"token": r["token"], "chunk_count": 1})
    folder = DATA / "recordings" / rid
    # Upload pieces are dropped once the assembled audio is committed; finish stays idempotent.
    assert (folder / "audio").exists() and not (folder / "0").exists()
    assert client.post(f"/api/recordings/{rid}/finish", json={"token": r["token"], "chunk_count": 1}).status_code == 200
    with tx() as s:
        s.add(Segment(recording_id=rid, start=0, end=1, text="hi", raw_text="hi", language="en"))
        s.add(Generation(meeting_id=mid, job_id="j-" + mid, content="x", provider="p", model="m", template_name="t", notes_revision=0))
        putkv(s, "generated:" + mid, {"fingerprint": "x"})
    (folder / "playback.m4a").write_bytes(b"x")
    assert client.delete(f"/api/meetings/{mid}").status_code == 200
    assert not folder.exists()
    with tx() as s:
        for cls in [Meeting, Recording, Segment, Chunk, Generation]:
            assert not list(s.scalars(select(cls)))
        assert not list(s.scalars(select(Job).where(Job.meeting_id == mid)))
        assert s.get(KV, "generated:" + mid) is None


def test_orphan_sweep_cleans_unreachable_data(client):
    import os

    keep = meeting(client)
    r, h = upload(client, keep)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    kept = DATA / "recordings" / r["recording_id"]
    (kept / "7").write_bytes(b"leftover piece")
    stray = DATA / "recordings" / "not-a-recording"
    stray.mkdir(parents=True)
    os.utime(stray, (time.time() - 3600, time.time() - 3600))
    fresh = DATA / "recordings" / "uploading-now"
    fresh.mkdir()
    scratch = DATA / "huh-stt-crashed"
    scratch.mkdir()
    with tx() as s:
        s.add(Segment(recording_id="gone", start=0, end=1, text="x", raw_text="x", language="en"))
        s.add(Generation(meeting_id="gone", job_id="j-gone", content="x", provider="p", model="m", template_name="t", notes_revision=0))
        s.add(Job(kind="generate", meeting_id="gone"))
        putkv(s, "generated:gone", {"fingerprint": "x"})
        putkv(s, "generated:" + keep, {"fingerprint": "y"})
    worker.sweep_orphans(startup=True)
    assert not stray.exists() and fresh.exists() and not scratch.exists()
    assert (kept / "audio").exists() and not (kept / "7").exists()
    with tx() as s:
        assert not list(s.scalars(select(Segment).where(Segment.recording_id == "gone")))
        assert not list(s.scalars(select(Generation).where(Generation.meeting_id == "gone")))
        assert not list(s.scalars(select(Job).where(Job.meeting_id == "gone")))
        assert s.get(KV, "generated:gone") is None and s.get(KV, "generated:" + keep) is not None
        assert s.get(Recording, r["recording_id"]) is not None
    fresh.rmdir()


def test_new_ai_version_shows_even_if_my_notes_changed(client, monkeypatch):
    mid = meeting(client)
    r, h = upload(client, mid)
    with tx() as s:
        rec = s.get(Recording, r["recording_id"])
        rec.status = "transcribed"
        s.add(Segment(recording_id=rec.id, start=0, end=1, text="evidence", raw_text="evidence", language="en"))
    client.post(f"/api/meetings/{mid}/generate", json={})
    # Typing in My notes while the AI works must not hide the new version.
    client.patch(f"/api/meetings/{mid}", json={"notes": "typed meanwhile", "notes_revision": 0})
    monkeypatch.setattr(providers, "infer", lambda *a: "Fresh AI notes")
    worker.process(worker.claim_job())
    assert client.get(f"/api/meetings/{mid}").json()["enhanced_notes"] == "Fresh AI notes"


def test_folders_organise_meetings(client):
    mid = meeting(client)
    before = client.get(f"/api/meetings/{mid}").json()["updated_at"]
    assert client.post("/api/folders", json={"name": "  "}).status_code == 422
    f = client.post("/api/folders", json={"name": " Research "}).json()
    assert f["name"] == "Research"
    assert client.patch(f"/api/folders/{f['id']}", json={"name": "Lab"}).json()["name"] == "Lab"
    assert [x["name"] for x in client.get("/api/folders").json()] == ["Lab"]
    m = client.patch(f"/api/meetings/{mid}", json={"folder_id": f["id"]}).json()
    # Filing a meeting doesn't count as editing it.
    assert m["folder_id"] == f["id"] and m["updated_at"] == before
    missing = "00000000-0000-0000-0000-000000000000"
    assert client.patch(f"/api/meetings/{mid}", json={"folder_id": missing}).status_code == 404
    # Deleting a folder keeps its meetings.
    assert client.delete(f"/api/folders/{f['id']}").status_code == 200
    assert client.get(f"/api/meetings/{mid}").json()["folder_id"] is None
    assert client.get("/api/folders").json() == []
    f = client.post("/api/folders", json={"name": "Lab"}).json()
    assert client.post("/api/meetings", json={"folder_id": f["id"]}).json()["folder_id"] == f["id"]


def test_folder_color_and_icon(client):
    f = client.post("/api/folders", json={"name": "Design", "color": "teal", "icon": "palette"}).json()
    assert (f["color"], f["icon"]) == ("teal", "palette")
    # Changing the look alone keeps the name; null resets to the default look.
    f = client.patch(f"/api/folders/{f['id']}", json={"color": "pink"}).json()
    assert (f["name"], f["color"], f["icon"]) == ("Design", "pink", "palette")
    f = client.patch(f"/api/folders/{f['id']}", json={"color": None, "icon": None}).json()
    assert f["color"] is None and f["icon"] is None
    assert client.patch(f"/api/folders/{f['id']}", json={"color": "#ff0000"}).status_code == 422
    assert client.patch(f"/api/folders/{f['id']}", json={"icon": "<svg>"}).status_code == 422
    assert client.post("/api/folders", json={"name": "X", "color": 3}).status_code == 422


def test_archived_meetings_rank_last_in_search(client):
    old = meeting(client)
    new = meeting(client)
    client.patch(f"/api/meetings/{old}", json={"notes": "roadmap draft", "notes_revision": 0})
    client.patch(f"/api/meetings/{new}", json={"notes": "roadmap final", "notes_revision": 0})
    # The most recently edited meeting is archived, yet it must come after the active one.
    client.patch(f"/api/meetings/{old}", json={"title": "Old"})
    assert client.patch(f"/api/meetings/{old}", json={"archived": "yes"}).status_code == 422
    assert client.patch(f"/api/meetings/{old}", json={"archived": True}).json()["archived"] is True
    found = client.get("/api/search", params={"q": "roadmap"}).json()["results"]
    assert [(x["meeting_id"], x["archived"]) for x in found] == [(new, False), (old, True)]
    # Archiving never deletes anything.
    assert client.get(f"/api/meetings/{old}").json()["notes"] == "roadmap draft"
    client.patch(f"/api/meetings/{old}", json={"archived": False})
    assert client.get("/api/search", params={"q": "roadmap"}).json()["results"][0]["meeting_id"] == old


def test_glossary_layers_reach_the_generation_prompt(client, monkeypatch):
    fid = client.post("/api/folders", json={"name": "Lab"}).json()["id"]
    mid = meeting(client)
    # Each level validates and trims; blank rows are dropped.
    assert client.put("/api/settings", json={"glossary": [{"term": " Huh ", "meaning": "our notebook app"}, {"term": "", "meaning": ""}]}).json()["glossary"] == [
        {"term": "Huh", "meaning": "our notebook app"}
    ]
    f = client.patch(f"/api/folders/{fid}", json={"glossary": [{"term": "K-Lab", "meaning": "often heard as 'cay lab'"}, {"term": "huh", "meaning": "the lab's fork"}]}).json()
    assert [e["term"] for e in f["glossary"]] == ["K-Lab", "huh"]
    before = client.get(f"/api/meetings/{mid}").json()["updated_at"]
    m = client.patch(f"/api/meetings/{mid}", json={"folder_id": fid, "glossary": [{"term": "QBR", "meaning": "quarterly business review"}]}).json()
    assert m["glossary"] == [{"term": "QBR", "meaning": "quarterly business review"}]
    assert m["updated_at"] == before  # context is organisation, not an edit
    for bad in ["nope", [{"term": 3}], [{"term": "", "meaning": "orphan"}], [{"term": "x" * 201}], [{"term": "t"}] * 301]:
        assert client.patch(f"/api/meetings/{mid}", json={"glossary": bad}).status_code == 422
    assert client.get("/api/folders").json()[0]["glossary"][0]["term"] == "K-Lab"

    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    with tx() as s:
        s.add(Segment(recording_id=r["recording_id"], start=1, end=2, text="cay lab QBR", raw_text="cay lab QBR", language="en"))
        s.get(Recording, r["recording_id"]).status = "transcribed"
        s.execute(delete(Job))
    client.post(f"/api/meetings/{mid}/generate", json={})
    seen = {}

    def infer(cfg, system, prompt):
        seen.update(system=system)
        return "- K-Lab QBR [[T1]]"

    monkeypatch.setattr(providers, "infer", infer)
    worker.generate_job(worker.claim_job())
    system = seen["system"]
    assert "GLOSSARY" in system and "- QBR: quarterly business review" in system
    assert "- K-Lab: often heard as 'cay lab'" in system
    # The folder's "huh" replaces the all-notes "Huh" (case-insensitive), not both.
    assert "- huh: the lab's fork" in system and "our notebook app" not in system


def test_no_glossary_leaves_prompt_unchanged():
    assert worker.glossary_prompt([]) == "" and worker.glossary_prompt(None) == ""


def test_ai_order_settings(client):
    s = client.get("/api/settings").json()
    assert s["ai_order"] == [{"provider": "chatgpt", "model": ""}]
    s = client.put(
        "/api/settings",
        json={"ai_order": [
            {"provider": "chatgpt", "model": "gpt-a"},
            {"provider": "nvidia", "model": "n-b"},
            {"provider": "nvidia", "model": "n-b"},
        ]},
    ).json()
    assert s["ai_order"] == [{"provider": "chatgpt", "model": "gpt-a"}, {"provider": "nvidia", "model": "n-b"}]
    assert (s["provider"], s["model"]) == ("chatgpt", "gpt-a")
    # Picking a provider directly makes it first; the others stay as backups.
    s = client.put("/api/settings", json={"provider": "nvidia", "model": "n-b"}).json()
    assert s["ai_order"] == [{"provider": "nvidia", "model": "n-b"}, {"provider": "chatgpt", "model": "gpt-a"}]
    assert client.put("/api/settings", json={"ai_order": [{"provider": "nope", "model": "x"}]}).status_code == 422
    assert client.put("/api/settings", json={"ai_order": "x"}).status_code == 422
    assert client.put("/api/settings", json={"ai_order": [{"provider": "openai", "model": "m"}] * 1 + [{"provider": "openai", "model": str(i)} for i in range(20)]}).status_code == 422


def transcript_meeting(client, texts):
    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    with tx() as s:
        for i, text in enumerate(texts):
            s.add(Segment(recording_id=r["recording_id"], start=i, end=i + 1, text=text, raw_text=text, language="en"))
        s.get(Recording, r["recording_id"]).status = "transcribed"
        s.execute(delete(Job))
    return mid


def test_generation_falls_back_down_the_ai_order(client, monkeypatch):
    client.put(
        "/api/settings",
        json={"ai_order": [
            {"provider": "chatgpt", "model": "signed-out"},
            {"provider": "openai", "model": "gpt-a"},
            {"provider": "nvidia", "model": "n-b"},
        ]},
    )
    client.put("/api/settings", json={"api_keys": {"openai": "sk-test-a", "nvidia": "nvapi-test-b"}})
    # Long enough for several reduction steps before the final note.
    mid = transcript_meeting(client, ["word " * 3000 for _ in range(4)])
    calls = []

    def infer(cfg, system, prompt):
        calls.append((cfg["provider"], prompt[:20]))
        if cfg["provider"] == "chatgpt":
            raise oauth.OAuthError("Sign in with ChatGPT in Settings first")
        if cfg["provider"] == "openai" and prompt.startswith("Template"):
            raise providers.ProviderError("Provider request failed (HTTP 429 — usage_limit)", 429)
        return "- point [[T1]]"

    monkeypatch.setattr(providers, "infer", infer)
    client.post(f"/api/meetings/{mid}/generate", json={})
    worker.process(worker.claim_job())
    d = client.get(f"/api/meetings/{mid}").json()
    job = d["jobs"][0]
    assert job["status"] == "completed"
    g = d["generations"][0]
    assert (g["provider"], g["model"]) == ("nvidia", "n-b")
    # The signed-out model is skipped quietly; the out-of-usage one is announced once.
    assert len(job["notices"]) == 1
    n = job["notices"][0]
    assert n["from"] == {"provider": "openai", "model": "gpt-a"} and n["to"] == {"provider": "nvidia", "model": "n-b"}
    assert "usage" in n["reason"]
    # Finished reduction steps are not redone on the backup: only the failed final step moves over.
    reductions = [c for c in calls if c[0] == "openai" and c[1].startswith("Extract")]
    assert reductions and not [c for c in calls if c[0] == "nvidia" and c[1].startswith("Extract")]
    assert [c for c in calls if c[0] == "nvidia"] == [("nvidia", "Template instruction")]
    with tx() as s:
        assert "steps" not in s.get(Job, job["id"]).payload


def test_generation_resumes_from_checkpoints_after_every_model_failed(client, monkeypatch):
    client.put("/api/settings", json={"ai_order": [{"provider": "openai", "model": "gpt-a"}, {"provider": "nvidia", "model": "n-b"}]})
    client.put("/api/settings", json={"api_keys": {"openai": "sk-test-a", "nvidia": "nvapi-test-b"}})
    mid = transcript_meeting(client, ["word " * 3000 for _ in range(4)])
    down = {"openai", "nvidia"}
    calls = []

    def infer(cfg, system, prompt):
        calls.append(cfg["provider"])
        if prompt.startswith("Template") and cfg["provider"] in down:
            raise providers.ProviderError("Provider request failed (HTTP 503)", 503)
        return "- point [[T1]]"

    monkeypatch.setattr(providers, "infer", infer)
    client.post(f"/api/meetings/{mid}/generate", json={})
    worker.process(worker.claim_job())
    job = client.get(f"/api/meetings/{mid}").json()["jobs"][0]
    assert job["status"] == "queued" and "No AI model in your order" in job["error"]
    assert job["notices"][-1]["exhausted"] and job["notices"][0]["to"]["provider"] == "nvidia"
    reductions = len(calls) - 2
    down.discard("nvidia")
    calls.clear()
    with tx() as s:
        s.get(Job, job["id"]).available = 0
    worker.process(worker.claim_job())
    d = client.get(f"/api/meetings/{mid}").json()
    assert d["jobs"][0]["status"] == "completed" and reductions > 0
    # The retry reused every checkpointed reduction: only the final step ran again.
    assert calls == ["openai", "nvidia"]
    assert d["generations"][0]["provider"] == "nvidia"


def test_provider_failure_kinds():
    kind = lambda e: providers.failure(e)[0]
    assert kind(providers.ProviderError("Configure an API key for nvidia")) == "skipped"
    assert kind(oauth.OAuthError("Sign in with ChatGPT in Settings first")) == "skipped"
    assert kind(providers.ProviderError("Select a model in Settings first")) == "skipped"
    assert kind(providers.ProviderError("x", 429)) == "usage"
    assert kind(providers.ProviderError("Provider response failed — usage limit reached")) == "usage"
    assert kind(providers.ProviderError("x", 401)) == "auth"
    assert kind(providers.ProviderError("Provider transport or response format error")) == "other"


def test_ai_notices_endpoint(client):
    mid = meeting(client)
    with tx() as s:
        s.add(Job(kind="generate", meeting_id=mid, payload={"notices": [{"at": "x", "reason": "failed"}], "settings": {"api_key": "nope"}}))
        s.add(Job(kind="generate", meeting_id=mid, payload={}))
    r = client.get("/api/ai/notices").json()["jobs"]
    assert len(r) == 1 and r[0]["meeting_title"] == "Review" and r[0]["notices"][0]["reason"] == "failed"
    assert "settings" not in r[0]


def test_unchanged_reads_get_304_and_responses_are_compressed(client):
    mid = meeting(client)
    first = client.get(f"/api/meetings/{mid}")
    etag = first.headers["etag"]
    assert first.headers["cache-control"] == "no-store"
    # Unchanged: an empty 304 that still names the tag.
    again = client.get(f"/api/meetings/{mid}", headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == etag
    # Changed: the full body and a new tag.
    body = first.json()
    client.patch(f"/api/meetings/{mid}", json={"notes": "word " * 400, "notes_revision": body["notes_revision"]})
    changed = client.get(f"/api/meetings/{mid}", headers={"If-None-Match": etag, "Accept-Encoding": "gzip"})
    assert changed.status_code == 200 and changed.headers["etag"] != etag
    assert changed.headers["content-encoding"] == "gzip" and changed.json()["notes"].startswith("word")
    # Writes and audio are never tagged or compressed.
    assert "etag" not in client.patch(f"/api/meetings/{mid}", json={"title": "x"}).headers
    r, _ = upload(client, mid, data=b"\0" * 4096)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    audio = client.get(f"/api/recordings/{r['recording_id']}/audio", headers={"Accept-Encoding": "gzip", "Range": "bytes=0-9"})
    assert audio.status_code == 206 and "content-encoding" not in audio.headers and len(audio.content) == 10


def test_built_assets_are_cached_forever_and_the_page_is_revalidated(client, tmp_path, monkeypatch):
    from app import main

    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "index.html").write_text("<!doctype html>")
    monkeypatch.setattr(main, "STATIC_ROOT", tmp_path)
    asset = client.get("/assets/index-abc123.js")
    assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
    assert client.get("/").headers["cache-control"] == "no-cache"
    assert client.get("/some/meeting").headers["cache-control"] == "no-cache"


def test_auto_process_off_waits_for_the_owner(client):
    assert client.get("/api/settings").json()["auto_process"] is True
    assert client.put("/api/settings", json={"auto_process": False}).json()["auto_process"] is False
    mid = meeting(client)
    r, h = upload(client, mid)
    rid = r["recording_id"]
    client.post(f"/api/recordings/{rid}/finish", json={"token": r["token"], "chunk_count": 1})
    d = client.get(f"/api/meetings/{mid}").json()
    assert d["jobs"] == [] and d["recordings"][0]["status"] == "ready"
    # Starting it by hand queues transcription as usual.
    job = client.post(f"/api/meetings/{mid}/transcribe").json()
    assert job["kind"] == "transcribe" and job["status"] == "queued"


def test_pause_resume_and_cancel_jobs(client, monkeypatch):
    mid = meeting(client)
    r, h = upload(client, mid)
    rid = r["recording_id"]
    client.post(f"/api/recordings/{rid}/finish", json={"token": r["token"], "chunk_count": 1})
    jid = client.get(f"/api/meetings/{mid}").json()["jobs"][0]["id"]
    ctl = lambda action: client.post(f"/api/jobs/{jid}/control", json={"action": action})

    # Paused while queued: the worker skips it and the recording waits.
    assert ctl("pause").json()["status"] == "paused"
    assert worker.claim_job() is None
    assert client.get(f"/api/meetings/{mid}").json()["recordings"][0]["status"] == "ready"
    assert ctl("pause").status_code == 409
    # "Transcribe now" resumes the paused job instead of starting a second one.
    assert client.post(f"/api/meetings/{mid}/transcribe").json()["id"] == jid
    with tx() as s:
        assert len(list(s.scalars(select(Job).where(Job.meeting_id == mid)))) == 1
        assert s.get(Job, jid).status == "queued"

    # Paused while running: the worker stops at its next checkpoint and keeps the paused status.
    job = worker.claim_job()

    def transcribe_job(j):
        ctl("pause")
        worker.progress(j, 0.5)
        raise AssertionError("should have stopped")

    monkeypatch.setattr(worker, "transcribe_job", transcribe_job)
    worker.process(job)
    with tx() as s:
        j = s.get(Job, jid)
        assert j.status == "paused" and not j.error
    assert ctl("resume").json()["status"] == "queued"
    assert client.get(f"/api/meetings/{mid}").json()["recordings"][0]["status"] == "queued"

    # Cancelled: never runs again; the audio can still be transcribed later.
    assert ctl("cancel").json()["status"] == "cancelled"
    assert worker.claim_job() is None
    assert ctl("resume").status_code == 409
    assert client.get(f"/api/meetings/{mid}").json()["recordings"][0]["status"] == "ready"
    assert client.post(f"/api/meetings/{mid}/transcribe").json()["id"] != jid


def test_cancel_running_generation_stops_before_next_ai_step(client, monkeypatch):
    mid = transcript_meeting(client, ["word " * 3000 for _ in range(4)])
    client.put("/api/settings", json={"ai_order": [{"provider": "openai", "model": "gpt-a"}], "api_keys": {"openai": "sk-test"}})
    jid = client.post(f"/api/meetings/{mid}/generate", json={}).json()["id"]
    calls = []

    def infer(cfg, system, prompt):
        calls.append(prompt[:10])
        client.post(f"/api/jobs/{jid}/control", json={"action": "cancel"})
        return "- point [[T1]]"

    monkeypatch.setattr(providers, "infer", infer)
    worker.process(worker.claim_job())
    d = client.get(f"/api/meetings/{mid}").json()
    assert len(calls) == 1 and d["generations"] == []
    assert d["jobs"][0]["status"] == "cancelled"


def test_force_delete_while_recording_and_device_drops_capture(client):
    mid = meeting(client)
    a, ha = device(client, mid)
    cmd = start(client, mid, a, ha)
    rid = cmd["recording_id"]
    ha.update(recording_id=rid, capture_state="recording")
    assert client.delete(f"/api/meetings/{mid}").status_code == 409
    # Finish was pressed but the recording device never came back: still blocked without force.
    client.post(f"/api/meetings/{mid}/recording-control", json={"action": "stop"})
    assert client.delete(f"/api/meetings/{mid}").status_code == 409
    assert client.delete(f"/api/meetings/{mid}?force=true").status_code == 200
    with tx() as s:
        assert s.get(Meeting, mid) is None and s.get(Recording, rid) is None
    # The recording device learns its capture is gone and drops it, instead of erroring forever.
    res = client.post("/api/devices/heartbeat", json=ha)
    assert res.status_code == 200
    assert res.json()["command"]["type"] == "discard"
    ha.update(recording_id=None, capture_state="idle")
    assert client.post("/api/devices/heartbeat", json=ha).json()["command"] is None


def test_force_delete_stops_running_work(client, monkeypatch):
    mid = meeting(client)
    r, h = upload(client, mid)
    client.post(f"/api/recordings/{r['recording_id']}/finish", json={"token": r["token"], "chunk_count": 1})
    job = worker.claim_job()

    def transcribe_job(j):
        assert client.delete(f"/api/meetings/{mid}").status_code == 200
        worker.progress(j, 0.5)

    monkeypatch.setattr(worker, "transcribe_job", transcribe_job)
    worker.process(job)
    with tx() as s:
        assert s.get(Job, job.id) is None


def test_meeting_time_defaults_and_edits(client):
    m = client.post("/api/meetings", json={"title": "Sync"}).json()
    # A new note's meeting starts when it was created and lasts an hour.
    assert m["starts_at"] == m["created_at"] and m["duration_minutes"] == 60
    before = m["updated_at"]
    # Times may be given in any offset; they are stored as the same instant (shown back in UTC).
    m = client.patch(
        f"/api/meetings/{m['id']}", json={"starts_at": "2027-01-05T09:30:00-06:00", "duration_minutes": 45}
    ).json()
    assert m["starts_at"] == "2027-01-05T15:30:00Z" and m["duration_minutes"] == 45
    # Rescheduling is organisation, not an edit.
    assert m["updated_at"] == before
    for bad in [{"starts_at": "2027-01-05T09:30:00"}, {"starts_at": "soon"}, {"starts_at": 5},
                {"duration_minutes": 0}, {"duration_minutes": 24 * 60 + 1}, {"duration_minutes": "60"},
                {"duration_minutes": True}]:
        assert client.patch(f"/api/meetings/{m['id']}", json=bad).status_code == 422, bad
    m = client.post("/api/meetings", json={"starts_at": "2030-06-01T12:00:00Z", "duration_minutes": 90}).json()
    assert (m["starts_at"], m["duration_minutes"]) == ("2030-06-01T12:00:00Z", 90)
    text = client.get(f"/api/meetings/{m['id']}/export?format=md").text
    assert "Sat, Jun 1, 2030 · 7:00 AM – 8:30 AM CDT" in text


def test_time_zone_setting(client):
    assert client.get("/api/settings").json()["time_zone"] == "America/Chicago"
    assert client.put("/api/settings", json={"time_zone": "Asia/Taipei"}).json()["time_zone"] == "Asia/Taipei"
    assert client.put("/api/settings", json={"time_zone": "Mars/Olympus"}).status_code == 422
    assert client.put("/api/settings", json={"time_zone": ""}).status_code == 422
    assert client.get("/api/settings").json()["time_zone"] == "Asia/Taipei"


def test_meeting_time_backfilled_for_older_meetings(client):
    m = client.post("/api/meetings", json={}).json()
    with tx() as s:
        s.execute(text("UPDATE meetings SET starts_at = NULL"))
    init()
    got = client.get(f"/api/meetings/{m['id']}").json()
    assert got["starts_at"] == got["created_at"] and got["duration_minutes"] == 60
