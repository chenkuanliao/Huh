# Huh

A self-hosted meeting notebook. Take notes during a meeting from any of your devices, record from your laptop or phone, get a private transcript produced on your own GPU, and turn your notes plus the transcript into clean AI notes.

- **Notes first** — Markdown notes with live preview, checklists, note templates, Tab/Shift+Tab indentation and a distraction-free focus mode with side-by-side preview.
- **Record from any device** — start/stop from one device, record on another (e.g. a phone), switch microphones mid-recording, optional backup devices, resumable uploads.
- **Local transcription** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on an NVIDIA GPU (CPU works too), English, Chinese or mixed-language meetings, optional Traditional Chinese conversion.
- **AI notes** — generated from your notes and the transcript by the provider you choose (ChatGPT plan sign-in, OpenAI, Anthropic, Google Gemini, OpenRouter, OpenCode Zen, NVIDIA NIM or any OpenAI-compatible/local server). Sources are hidden in the text and shown on hover; every version is kept.
- **Find anything** — Ctrl/⌘+F inside a meeting, Ctrl/⌘+K across all meetings (titles, notes, AI notes and transcripts).
- **Dashboard** — this week at a glance, recent meetings and every open to-do.

It is designed for **one owner** on a home server, reachable from your other devices over HTTPS (for example via Tailscale). It is not a multi-user hosted service.

## Requirements

- Docker Engine with Compose v2
- For GPU transcription: an NVIDIA GPU, driver, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) (or the host override described below)
- About 2–4 GB of disk for a speech model, downloaded on first use and cached

No API key is needed to start the app.

## Quick start

```bash
cp .env.example .env      # optional — defaults work for local use
./scripts/up.sh           # builds and starts db, app and worker
```

Open **http://localhost:8787**, create the owner password, then open **Settings** to:

1. **AI notes** — pick a provider and sign in or paste an API key; models load automatically.
2. **Transcription** — pick a speech model (Large v3 Turbo is a good default) and the spoken language.

### GPU without NVIDIA Container Toolkit (Linux)

If the toolkit isn't installed, you can generate a local override that passes the GPU device nodes and mounts the host driver libraries read-only. It doesn't change the host or the Docker daemon:

```bash
python3 scripts/configure-host-gpu.py   # writes compose.host-gpu.yaml (gitignored, host-specific)
./scripts/up.sh                          # picks the override up automatically
```

Re-run it after upgrading the NVIDIA driver.

### CPU only

```bash
docker compose -f compose.yaml -f compose.cpu.yaml up -d --build
```

Then choose **CPU** under Settings → Transcription → Advanced. Long recordings are much faster on a GPU.

## Using it from other devices

Browsers only allow microphone access over HTTPS (or on `localhost`). The simplest way is [Tailscale Serve](https://tailscale.com/kb/1312/serve) on the host:

```bash
tailscale serve --bg --https=8787 http://127.0.0.1:8787
```

Then set the HTTPS address Tailscale prints in `.env` and restart:

```ini
ALLOWED_ORIGINS=https://<your-machine>.<your-tailnet>.ts.net:8787
COOKIE_SECURE=true
```

The app and the OAuth callback listen on loopback only, and the database is never published. Every device signs in with the same owner password.

**Phones:** mobile browsers pause web recording when the screen locks or the browser goes to the background. Keep the screen on while recording on a phone, or record in Voice Memos and import the file afterwards (Share → Save to Files → Import audio).

### ChatGPT sign-in from another device

Sign-in redirects to `http://127.0.0.1:1457/…`, which only resolves on the server. When you sign in from another device, that last page will fail to load. That's expected: copy its full address into the box Settings shows you. Treat that address as a secret.

## Configuration

All settings are optional; see [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Local port for the web app |
| `CHATGPT_CALLBACK_PORT` | `1457` | Local port for the ChatGPT sign-in callback |
| `POSTGRES_PASSWORD` | `huh-local-database` | Internal database password (not exposed) |
| `SECRET_KEY` | generated | Encryption key for stored credentials; generated into the data volume if empty |
| `COOKIE_SECURE` | `false` | Set `true` when you only use HTTPS |
| `ALLOWED_ORIGINS` | — | HTTPS origin(s) used behind a TLS proxy such as Tailscale Serve |

For a local model server (Ollama, LM Studio, vLLM…) choose **Custom / local** in Settings and use `http://host.docker.internal:<port>/v1`.

## Data and privacy

- Docker volumes hold the database, audio and encrypted credentials (`data`), and speech models (`models`). `docker compose down` keeps them; `down -v` deletes them. Back up the database and data volumes together.
- Audio and transcripts stay on your server. Only the text sent for AI notes goes to the provider you choose (nothing does if you use a local model).
- API keys and ChatGPT tokens are encrypted at rest and never sent to browsers.
- Deleting a meeting removes its notes, AI notes and history, recordings, transcript, and the matching data on the device you delete from. A background sweep removes anything left unreachable after crashes.

Useful commands:

```bash
docker compose ps
docker compose logs --tail=100 app worker
```

If you use the GPU override, pass `-f compose.yaml -f compose.host-gpu.yaml` to Compose (`scripts/up.sh` does this for you).

## Development

| Path | What |
|---|---|
| `backend/app` | FastAPI API (`app.main:app`), worker (`python -m app.worker`), providers, OAuth |
| `backend/tests` | Backend tests (SQLite, no GPU needed) |
| `frontend/src` | React + TypeScript + Vite UI |
| `qa/` | Browser tests (Playwright) and a test-only mock LLM |
| `scripts/` | Start-up, GPU override and smoke-test helpers |
| `SPEC.md` | API and behaviour contract |

```bash
# Backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt -r backend/requirements-test.txt
cd backend && python -m pytest -q

# Frontend
cd frontend && npm ci && npm run typecheck && npm test && npm run build
```

### End-to-end tests

The browser tests run against a separate, disposable stack (its own volumes and ports) so they never touch your real data:

```bash
docker compose -p huh-test -f compose.yaml -f qa/compose.test.yaml up -d --build
HUH_TEST_AUTH_FILE=.artifacts/test-auth.json python3 scripts/smoke.py http://127.0.0.1:18787   # creates the test owner
cd qa && npm ci && npx playwright install chromium && HUH_TEST_AUTH_FILE=../.artifacts/test-auth.json npm test
docker compose -p huh-test -f compose.yaml -f qa/compose.test.yaml down
```

Test audio lives in the gitignored `.artifacts/` folder: `jfk.flac` is the public-domain sample from the [openai/whisper](https://github.com/openai/whisper/tree/main/tests) repository, and `voice-memo.m4a` is the same clip converted with `ffmpeg -i jfk.flac -c:a aac voice-memo.m4a`. The test stack shares the `huh_models` volume so speech models aren't downloaded twice.

### Contributing

Work happens on branches and pull requests against `main`. Keep secrets, personal data and machine-specific files out of commits — `.gitignore` already excludes `.env`, `.artifacts/`, `compose.host-gpu.yaml` and local notes.
