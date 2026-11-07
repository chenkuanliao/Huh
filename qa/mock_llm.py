"""Test-only OpenAI-compatible server. Never included in the production Compose stack."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

RUNS = [0]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.reply({'data': [{'id': 'test-model'}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        assert body.get('model') == 'test-model'
        assert body.get('messages'), 'Missing grounded prompt'
        RUNS[0] += 1  # distinct output per run so version history can be tested
        self.reply({'choices': [{'finish_reason': 'stop', 'message': {'content': f'# Meeting notes\n\n## Summary\nA public speech sample was transcribed. [[T1]]\n\n## Decisions\nNo meeting decisions were stated.\n\n## Action items\nNone stated.\n\nRun {RUNS[0]}.'}}]})
    def reply(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
HTTPServer(('0.0.0.0', 9999), Handler).serve_forever()
