"""Exercise a disposable Huh server over HTTP, never a populated personal install.

python3 scripts/smoke.py http://127.0.0.1:18787
Uses a new random owner password. Run only against a disposable test volume.
"""
import http.cookiejar
import io
import json
import os
import pathlib
import secrets
import sys
import urllib.error
import urllib.request
import uuid
import wave

base = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18787').rstrip('/')
jar = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, data=None, expected=200, headers=None, raw=None):
    payload = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    h = {'Origin': base}
    if data is not None:
        h['Content-Type'] = 'application/json'
    h.update(headers or {})
    req = urllib.request.Request(base + '/api' + path, data=payload, headers=h, method=method)
    try:
        response = client.open(req, timeout=30)
    except urllib.error.HTTPError as exc:
        response = exc
    body = response.read()
    assert response.code == expected, f'{method} {path}: {response.code}, expected {expected}: {body[:500]!r}'
    if body and 'application/json' in response.headers.get('Content-Type', ''):
        return json.loads(body)
    return body

status = call('GET', '/auth/status')
assert status['setup_required'], 'Refusing to run: this server already has an owner. Use a disposable database.'
call('GET', '/meetings', expected=401)
password = secrets.token_urlsafe(24)
if os.getenv('HUH_TEST_AUTH_FILE'):
    auth_path = pathlib.Path(os.environ['HUH_TEST_AUTH_FILE'])
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    with open(auth_path, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
        json.dump({'password': password}, out)
call('POST', '/auth/setup', {'password': password})
assert call('GET', '/auth/status')['authenticated']
templates = call('GET', '/templates')
assert templates, 'Built-in templates missing'
meeting = call('POST', '/meetings', {'title': 'Integration recording handoff', 'template_id': templates[0]['id']})
mid = meeting['id']
changed = call('PATCH', f'/meetings/{mid}', {'notes': 'Discussed bilingual notes. 決定下週再確認。', 'notes_revision': meeting['notes_revision']})
assert changed['notes_revision'] > meeting['notes_revision']
call('PATCH', f'/meetings/{mid}', {'notes': 'stale edit', 'notes_revision': meeting['notes_revision']}, expected=409)
assert call('GET', f'/meetings/{mid}')['notes'] == changed['notes']

first, second = str(uuid.uuid4()), str(uuid.uuid4())
def beat(did, **extra):
    return call('POST', '/devices/heartbeat', {'id': did, 'name': 'Desktop' if did == first else 'MacBook', 'meeting_id': mid, 'ready': True, 'backup_enabled': True, **extra})
beat(first)
beat(second)
call('PATCH', f'/meetings/{mid}/recording-policy', {'auto_fallback': True, 'backup_order': [first, second]})
state = call('POST', f'/meetings/{mid}/recording-control', {'action': 'start', 'device_id': first})
assert state['status'] == 'starting', state
cmd1 = beat(first)['command']
assert cmd1 and cmd1['type'] == 'start', cmd1
r1, t1 = cmd1['recording_id'], cmd1['token']
call('POST', f'/recordings/{r1}/started', {'token': t1})
state = call('GET', f'/meetings/{mid}/recording-state')
assert state['active_device_id'] == first and state['status'] == 'recording', state
call('POST', f'/meetings/{mid}/recording-control', {'action': 'switch', 'device_id': second})
assert beat(first, recording_id=r1, capture_state='recording')['command'] is None, 'Old recorder stopped before replacement ack'
cmd2 = beat(second)['command']
assert cmd2 and cmd2['type'] == 'start', cmd2
r2, t2 = cmd2['recording_id'], cmd2['token']
call('POST', f'/recordings/{r2}/started', {'token': t2})
assert beat(first, recording_id=r1, capture_state='recording')['command']['type'] == 'stop'
state = call('GET', f'/meetings/{mid}/recording-state')
assert state['active_device_id'] == second, state

buf = io.BytesIO()
with wave.open(buf, 'wb') as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(16000)
    out.writeframes(b'\0\0' * 16000)
audio = buf.getvalue()
for rid, token in [(r1, t1), (r2, t2)]:
    hdr = {'Content-Type': 'audio/wav', 'X-Recording-Token': token}
    call('PUT', f'/recordings/{rid}/chunks/0', raw=audio, headers=hdr)
    call('PUT', f'/recordings/{rid}/chunks/0', raw=audio, headers=hdr)
    call('PUT', f'/recordings/{rid}/chunks/0', raw=audio + b'x', headers=hdr, expected=409)
    call('POST', f'/recordings/{rid}/finish', {'token': token, 'chunk_count': 2, 'duration': 1}, expected=409)
    if rid == r2:
        call('POST', f'/meetings/{mid}/recording-control', {'action': 'stop'})
    call('POST', f'/recordings/{rid}/finish', {'token': token, 'chunk_count': 1, 'duration': 1})

uploaded = call('POST', f'/meetings/{mid}/uploads', {'filename': 'voice-memo.wav', 'mime_type': 'audio/wav', 'size': len(audio), 'mode': 'additional'})
uid, token = uploaded['recording_id'], uploaded['token']
call('PUT', f'/recordings/{uid}/chunks/0', raw=audio, headers={'Content-Type': 'audio/wav', 'X-Recording-Token': token})
call('POST', f'/recordings/{uid}/finish', {'token': token, 'chunk_count': 1, 'duration': 1})
detail = call('GET', f'/meetings/{mid}')
assert len(detail['recordings']) == 3
assert all(r['chunk_count'] == 1 for r in detail['recordings'])
assert call('GET', f'/recordings/{uid}/audio') == audio
assert b'Integration recording handoff' in call('GET', f'/meetings/{mid}/export?format=md')
settings = call('GET', '/settings')
assert 'api_keys' not in settings
call('PUT', '/settings', {'api_keys': {'custom': 'test-secret-not-a-real-key'}})
settings = call('GET', '/settings')
assert settings['api_key_status']['custom']
assert 'test-secret' not in json.dumps(settings)
call('PUT', '/settings', {'api_keys': {'custom': None}})
assert not call('GET', '/settings')['api_key_status'].get('custom', False)
call('POST', '/auth/logout')
call('GET', f'/meetings/{mid}', expected=401)
call('POST', '/auth/login', {'password': password})
assert call('GET', f'/meetings/{mid}')['id'] == mid
print('PASS: owner auth, revisions/conflicts, templates, device handoff, chunk retries/integrity, incomplete upload rejection, audio import/playback, export, secret redaction, login persistence')
