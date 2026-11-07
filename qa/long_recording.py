"""Process a synthetic sparse two-hour m4a on the disposable integration stack.

This checks long-file decoding/window offsets, not microphone or bilingual quality.
Uses only the generated test owner password saved by scripts/smoke.py.
"""
import json
import pathlib
import sys
import time

import httpx

root = pathlib.Path(__file__).resolve().parent.parent
base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18787"
assert base == "http://127.0.0.1:18787", "Use the disposable test stack only"
password = json.loads((root / ".artifacts/test-auth.json").read_text())["password"]
client = httpx.Client(base_url=base + "/api", timeout=30, headers={"Origin": base})


def call(method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


call("POST", "/auth/login", json={"password": password})
mid = call("POST", "/meetings", json={"title": "Synthetic two-hour processing test"})["id"]
path = root / ".artifacts/two-hour-sparse.m4a"
upload = call("POST", f"/meetings/{mid}/uploads", json={
    "filename": path.name, "mime_type": "audio/mp4", "size": path.stat().st_size, "mode": "complete",
})
rid = upload["recording_id"]
count = 0
with path.open("rb") as audio:
    while chunk := audio.read(upload["chunk_size"]):
        call("PUT", f"/recordings/{rid}/chunks/{count}", content=chunk,
             headers={"Content-Type": "audio/mp4", "X-Recording-Token": upload["token"]})
        count += 1
call("POST", f"/recordings/{rid}/finish", json={"token": upload["token"], "chunk_count": count})
deadline = time.monotonic() + 600
last = None
while time.monotonic() < deadline:
    detail = call("GET", f"/meetings/{mid}")
    status = [(j["kind"], j["status"], round(j["progress"], 2)) for j in detail["jobs"]]
    if status != last:
        print("Long-file pipeline:", status, flush=True)
        last = status
    assert not any(j["status"] == "failed" for j in detail["jobs"]), detail["jobs"]
    if detail["generations"]:
        segments = detail["transcript"]
        assert any(s["start"] < 20 and "country" in s["text"].lower() for s in segments), segments
        assert any(s["start"] > 7180 and "country" in s["text"].lower() for s in segments), segments
        assert 7199 <= detail["recordings"][0]["duration"] <= 7201
        print("PASS: two-hour m4a decoded in bounded windows; speech retained at both ends with absolute timestamps; generation saved", flush=True)
        break
    time.sleep(2)
else:
    raise AssertionError("Long-file pipeline timed out")
