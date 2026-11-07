"""Run inside the GPU worker container with a public speech fixture mounted at /sample.flac."""
import time
import ctranslate2
from faster_whisper import WhisperModel
started = time.monotonic()
print('GPU count:', ctranslate2.get_cuda_device_count(), flush=True)
model = WhisperModel('large-v3-turbo', device='cuda', compute_type='float16', download_root='/models')
print('Model ready after', round(time.monotonic() - started, 1), 'seconds', flush=True)
segments, info = model.transcribe('/sample.flac', vad_filter=True, multilingual=True)
text = ' '.join(s.text.strip() for s in segments)
print('Language:', info.language, 'Duration:', info.duration, flush=True)
print('Transcript:', text, flush=True)
assert 'country' in text.lower() and 'you' in text.lower(), 'Expected speech missing from GPU transcription'
print('PASS: large-v3-turbo CUDA float16 speech transcription,', round(time.monotonic() - started, 1), 'seconds including model load/download', flush=True)
