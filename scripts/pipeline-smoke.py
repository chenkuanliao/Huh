"""Full isolated test: HTTP coordination + actual GPU speech + test-only LLM transport.

Start qa/compose.test.yaml with app, db, worker and mock-llm against fresh test volumes.
The fake LLM tests transport and job persistence, not real summary quality.
"""
import pathlib
import time
import smoke

call = smoke.call
meeting = call('POST', '/meetings', {'title': 'Public speech pipeline test'})
mid = meeting['id']
call('PUT', '/settings', {'provider': 'custom', 'model': 'test-model', 'base_url': 'http://mock-llm:9999/v1', 'api_keys': {'custom': 'integration-only'}, 'stt_model': 'large-v3-turbo', 'stt_language': 'mixed'})
path = pathlib.Path(__file__).resolve().parent.parent / '.artifacts/jfk.flac'
size = path.stat().st_size
upload = call('POST', f'/meetings/{mid}/uploads', {'filename': 'jfk.flac', 'mime_type': 'audio/flac', 'size': size, 'mode': 'complete'})
rid, token = upload['recording_id'], upload['token']
with path.open('rb') as f:
    index = 0
    while chunk := f.read(upload.get('chunk_size', 1048576)):
        call('PUT', f'/recordings/{rid}/chunks/{index}', raw=chunk, headers={'Content-Type': 'audio/flac', 'X-Recording-Token': token})
        index += 1
call('POST', f'/recordings/{rid}/finish', {'token': token, 'chunk_count': index})
deadline = time.monotonic() + 240
last = None
while time.monotonic() < deadline:
    meeting = call('GET', f'/meetings/{mid}')
    statuses = [(j['kind'], j['status']) for j in meeting['jobs']]
    if statuses != last:
        print('Pipeline:', statuses, flush=True)
        last = statuses
    failed = [j for j in meeting['jobs'] if j['status'] == 'failed']
    if failed:
        raise AssertionError([(j['kind'], j.get('error')) for j in failed])
    if meeting['generations']:
        transcript = ' '.join(s['text'] for s in meeting['transcript'])
        assert 'country' in transcript.lower(), transcript
        assert meeting['enhanced_notes'], 'Generated notes were not persisted'
        assert meeting['generations'][0]['provider'] == 'custom'
        print('PASS: real CUDA transcription -> durable transcript -> test-only provider adapter -> saved generation and enhanced notes', flush=True)
        print('Transcript:', transcript, flush=True)
        break
    time.sleep(2)
else:
    raise AssertionError('Pipeline timed out: ' + repr(last))
