# Huh — implementation contract

Build a production-minded personal meeting notebook, self-hosted on a Linux PC in Docker. All clients can edit and record through HTTPS (e.g. Tailscale Serve). Transcription targets a single NVIDIA GPU (CPU fallback supported). Single owner, authenticated session. React/TypeScript/Vite frontend, Python FastAPI backend, PostgreSQL, Python GPU worker. No external paid service required for app startup. No simulated successful AI output.

## Shared REST contract
All paths below under /api; JSON unless specified. Error shape {detail:string}; conflicts HTTP409. Dates ISO UTC strings. IDs UUID strings.
- GET /health {status, database, worker?}
- GET /auth/status {authenticated:boolean, setup_required:boolean}
- POST /auth/setup {password} -> session cookie (first owner setup only)
- POST /auth/login {password} -> session cookie
- POST /auth/logout
- GET /meetings -> Meeting[]
- POST /meetings {title?, template_id?, folder_id?} -> Meeting
- GET /meetings/{id} -> MeetingDetail
- PATCH /meetings/{id} {title?, notes?, notes_revision?, enhanced_notes?, enhanced_revision?, template_id?, language?, notes_language?, folder_id?, archived?, glossary?} -> Meeting; folder_id/archived/glossary alone don't bump updated_at; optimistic revision checks on editable text; notes/enhanced_notes are markdown plain strings.
- DELETE /meetings/{id}[?force=true] — 409 while a recording is starting/recording/stopping/uploading unless force; force drops the capture and stops the meeting's jobs (the device gets a `discard` command)
- POST /meetings/{id}/generate {template_id?, output_language?} -> Job (enqueue; transcript needed; empty user notes allowed). Language: output_language > meeting notes_language > settings output_language. The note keeps one main language; names/terms may stay as spoken. "auto" resolves to the dominant transcript+notes language (all-English meetings get English only).
- POST /meetings/{id}/transcribe {} -> Job (queues pending complete recordings, then generation)
- GET /meetings/{id}/export?format=md -> file
- GET /search?q= -> {results:[{meeting_id,title,field,snippet,updated_at,archived,recording_id?,start?,segment_id?}]}; archived meetings always rank after active ones
- GET /folders -> Folder[]; POST /folders {name, color?, icon?} -> Folder; PATCH /folders/{id} {name?, color?, icon?, glossary?} -> Folder; DELETE /folders/{id} (meetings move out, nothing else is deleted)
Folder {id,name,color,icon,glossary,created_at}; color is null or one of slate|red|orange|amber|green|teal|blue|indigo|violet|pink; icon is null or a kebab-case icon key drawn by the client
Meeting {id,title,notes,notes_revision,enhanced_notes,enhanced_revision,template_id,language,notes_language,folder_id,archived,glossary,created_at,updated_at,status}
Glossary: GlossaryEntry[] {term (1–200 chars), meaning (≤2000, may be empty)}, at most 300; blank rows dropped. Settings.glossary applies to every meeting, Folder.glossary to its meetings, Meeting.glossary to one meeting. Generation snapshots the merged list (all notes → folder → meeting; a narrower entry replaces a broader one with the same case-insensitive term) into the system prompt as background for recognising misheard/abbreviated terms, never as meeting content.
Archive keeps a meeting intact but hides it from the main list and dashboard; it stays searchable, ranked last.
MeetingDetail extends Meeting with {recordings:Recording[],transcript:TranscriptSegment[],generations:Generation[],jobs:Job[],recording_state:RecordingState}
TranscriptSegment {id,recording_id,start:number,end:number,text:string,language?:string}
Generation {id,content,created_at,provider,model,template_name,notes_revision,output_language?}
Job {id,kind,status,progress,error?,created_at,notices?:AINotice[]}; status queued|running|paused|cancelled|completed|failed
- POST /jobs/{id}/control {action:'pause'|'resume'|'cancel'} -> Job (transcribe/generate only). A running job stops at its next checkpoint; pause keeps AI checkpoints; cancel keeps audio/transcripts and returns the recording to ready. Transcribing a recording with a paused job resumes it; a new generation cancels paused ones.
AINotice {at,from:{provider,model}|null,from_label,reason,to:{provider,model}|null,to_label,exhausted?,final?}: a model in the AI order failed mid-generation and the next one took over (or, with exhausted, none worked)
Recording {id,meeting_id,device_id?,label,mime_type,status,created_at,duration?,bytes,chunk_count}

## Recording coordination (polling every 2 seconds, no WebSocket dependency)
Devices are page sessions with stable sessionStorage device UUID (different tabs different IDs). Mic enumeration/permission occurs locally after explicit Enable microphone user action; only ready, explicitly armed devices eligible. UI retains local selected MediaDeviceInfo id, server only sees name. Microphone stream maintained while armed; audio capture only on commands. Mobile background capture is NOT guaranteed; display this honestly. Recorder component global (survives meeting route changes).
- POST /devices/heartbeat {id,name,meeting_id?,ready:boolean,recording_id?:string|null,backup_enabled:boolean,capture_state?:string} -> {device:Device,command:Command|null}
- GET /meetings/{id}/devices -> Device[]
Device {id,name,meeting_id,ready,online,backup_enabled,last_seen,recording_id?}
Command {type:'start'|'stop'|'pause'|'resume'|'discard',meeting_id,recording_id,token?:string}; token is supplied for start/stop
- GET /meetings/{id}/recording-state -> RecordingState
RecordingState {status:'idle'|'starting'|'recording'|'switching'|'paused',active_device_id:string|null,pending_device_id:string|null,message:string|null,backup_order:string[],auto_fallback:boolean,user_paused?:boolean}
- POST /meetings/{id}/recording-control {action:'start'|'switch'|'stop'|'pause'|'resume',device_id?:string} -> RecordingState. Intentional pause retains the active source and its MediaRecorder, suppresses backup takeover, and does not finish audio or enqueue AI work. Resume continues the same file; elapsed duration excludes pauses. Stop (labelled Finish) works while paused and automatically starts processing after upload completes. Keep the recording browser open while paused.
- PATCH /meetings/{id}/recording-policy {auto_fallback:boolean,backup_order:string[]} -> RecordingState
- POST /recordings/{id}/started {token} -> Recording; confirms new capture before old device gets stop command. Idempotent. Device must verify capture stream live first.
- PUT /recordings/{id}/chunks/{index} raw bytes, Content-Type actual mime; X-Recording-Token for live device chunks. SHA256 duplicate validation, ordered indexes. Return {index,bytes}. Save chunks atomically. Blob fragments assembled in sequence before decoding; never assume each MediaRecorder blob independently decodable.
- POST /recordings/{id}/finish {token?,chunk_count,duration?} -> Recording; completeness required. Mark ready, enqueue transcription+generation automatically. If others still active defer generation until stop/all complete. On switch keep per-source timeline, avoid blind concatenation. Worker stores timestamps per recording and generation uses source labels/timing; no unsupported perfect dedup claim.
- POST /meetings/{id}/uploads {filename,mime_type,size,mode:'additional'|'complete'} -> {recording_id,token,chunk_size:1048576}; chunk/finish endpoints same. Complete mode marks previous sources excluded (preserve files), additional retains both. Resumable client IndexedDB buffer, idempotent chunk APIs. User selects file, uploads incrementally (do not whole-file memory load).
- GET /recordings/{id}/audio -> authenticated audio response with range support where practical
Server monitors heartbeat expiry (~12s) and start timeout (~15s), triggers explicitly configured ready backups, marks paused if none. Never false status recording without started ack. Offline original may upload later; preserve sources. Single active authority per meeting, serialize state transitions. Background browser cannot be promised as fallback.

## Templates / Settings
- GET /templates -> Template[]
- POST /templates {name,instructions,structure} -> Template
- PATCH /templates/{id} same -> Template
- DELETE /templates/{id}
Template {id,name,instructions,structure,is_default?}
- GET /settings -> Settings (no credentials)
- PUT /settings partial -> Settings. Input may include api_keys object provider->key; blank leaves unchanged; explicit clear via null.
Settings {provider,model,base_url,system_prompt,output_language,stt_model,stt_language,stt_device,stt_compute_type,traditional_chinese,auto_process,notes_view,ai_notes_view,back_behavior,glossary,ai_order,api_key_status:Record<string,boolean>}; back_behavior "up" (default: meeting → its folder → Home) | "history" (previously visited page)
auto_process (default true): finished recordings are transcribed and AI notes written automatically; false leaves them ready until POST /meetings/{id}/transcribe. Defaults provider chatgpt, output_language auto, stt_model large-v3-turbo, stt_language mixed (options auto/en/zh/mixed), stt_device cuda, stt_compute_type float16, traditional_chinese true.
Providers IDs chatgpt/openai/anthropic/google/openrouter/opencode/nvidia/custom. Keep provider adapters and platform-specific parameters; no fallback to any provider the owner did not list.
AI order: Settings.ai_order is the owner's ranked [{provider,model}] list (≤12, exact duplicates dropped; GET always returns at least one entry, derived from provider/model for older settings). PUT ai_order sets it and provider/model mirror its first entry; PUT provider/model alone moves that pair to the top. Generation runs each inference step on the first entry that works: entries not connected or without a model are skipped quietly; any other provider failure (usage/rate limit, auth, outage, incomplete output) drops that entry for the rest of the attempt and reruns only the failed step, with that step's full context, on the next entry, recording an AINotice on the job. Finished steps are checkpointed on the job (keyed by their prompt) so retries resume; checkpoints are cleared on success. If every entry fails the attempt fails with each entry's reason (normal job retries apply). Generation.provider/model record the model that actually wrote the note.
- GET /ai/notices -> {jobs:[{id,meeting_id,meeting_title,status,notices}]} generate jobs from the last day that have notices; the client polls it for app-wide pop-ups
- POST /settings/test {provider?,model?} -> {ok,message}; actual small inference explicitly requested by user
- GET /models?provider= -> {models:[{id,name}]} (configured provider, may return error when disconnected; editable manual model field supported)
- GET /stt/models -> {models:[{id,name,downloaded}],device,cuda_available?}
- POST /stt/models/download {model} -> Job; worker caches local weights persistently
- GET /chatgpt/status -> {signed_in,plan_enabled,email?,pending?,usage_url?,last_error?}
- POST /chatgpt/sign-in -> {authorize_url,redirect_uri,listener_active?,listener_error?}
- POST /chatgpt/callback {url} -> public status; paste remote failed loopback URL workflow
- POST /chatgpt/sign-out
Use the app's own client registration and data directory; current official docs require JWKS ID token signature verification. Implement OAuth PKCE state nonce exact redirect, pending attempt TTL and one-use. Store secrets encrypted/server-only. Browser auth + owner session required for credentials endpoints. Allow localhost OAuth listener narrow callback endpoint.

## Reliability and AI
Durable DB jobs with claims/recovery after crash, retries without duplicate transcripts. SQLAlchemy common models/session. Worker loads faster-whisper lazily, per-segment multilingual detection for mixed mode, VAD timestamps, OpenCC Traditional Chinese conversion preserving raw output. ffmpeg supports m4a Safari/mp4/WebM. Long recordings use bounded segments/processing; retain original and report errors. Summary should emphasize written notes with transcript evidence, preserve original notes, save generation history; no fabricated owners/dates. Snapshot notes revision when generation enqueued; never clobber edits made later; generation result always saved, only update enhanced_notes if enhanced revision unchanged. Long transcripts staged summarization within budget. Secrets never returned/logged. Validate input sizes/audio formats; cookies HttpOnly/SameSite, origin check for mutations to prevent CSRF; credential setup must be accessible only local/Tailscale port (Docker binds loopback). Auth needed for all data routes.

## UI
Polished editorial notebook: warm off-white canvas, dark ink, quiet green accent, sidebar meeting search/list; meeting title + live status, Notes / Enhanced / Transcript tabs; recorder bar with source select, start/stop/switch, device preparedness; mobile responsive all functionality (phones: see Phone layout). Markdown text editor acceptable with readable preview, autosave and explicit conflict handling. Empty state actionable, no fake demo data. Settings and templates dialogs/pages fully functional. Visible background/iPhone limitations. No misleading complete success before server ack. Show pending upload queue/retry. History restore/view. Upload audio supports Voice Memos (.m4a), hints Save to Files. Prefer lucide-react icons. No image assets necessary.

## Phone layout
Phones get their own layout (`frontend/src/Mobile.tsx`, styles under `body.phone` in `style.css`); tablets and laptops keep the desktop one. It's for when the computer isn't around: take notes, record, glance at or fix notes, tick to-dos. The user is an expert, so the phone shows no tips or explanations.
- The note is the page. A meeting opens as just its title and note, for reading; Edit (pencil in the top bar) starts typing and Done ends it. Only an empty note (a new one) opens ready to type. While typing everything else steps aside (`body.phone-typing`) and the top bar shows the title and save state. Recording is one tap (Record in the top bar); the recorder bar shows only while recording.
- Everything else lives one level down: the ⋯ menu (bottom sheet) holds meeting actions, AI controls, versions, glossary and recording setup; the view switcher under the title picks My notes / AI notes / Transcript / History.
- Navigation is a bottom tab bar (Meetings, To-dos, +, Search, Settings). Search replaces keyboard shortcuts. Menus, dropdowns and dialogs are bottom sheets: drag the grabber up for full screen, down to dismiss; touches never scroll the page behind.
- While typing, swipe right on a bullet/checkbox line to indent it, left to outdent (Tab / Shift+Tab). Swipes are read on a strip over the note's left edge (iOS claims drags inside a focused text box for selection); the line flashes green when it moves, red when it can't. Reading views hide list items with nothing written yet.
- Drag-to-reorder lists: drag by a handle with `touch-action: none` (the page never scrolls along with the card), and scroll the page when the card is held near the top or bottom edge so items can move past the screen.
- Big touch targets (44px+), 16px fields (iOS zooms otherwise), safe areas respected, nothing scrolls under the status bar.
- Left out on the phone: hotkeys, drag and drop, side by side, the sidebar, focus mode.
- **Every new feature needs a phone decision**: (a) the same on the phone, (b) tucked into ⋯ / Settings, or (c) desktop only. Default to (b) if it's useful away from the computer, (c) if it's for heavy editing or setup. Never add explanatory text or extra controls to the reading/typing view. Check new UI at 375px wide (iPhone 12 mini, Safari).

## Ownership
Frontend agent owns frontend/** only. Backend agent owns backend/** only (including requirements, tests, worker). Root owns Dockerfile(s), compose.yaml, README, .env.example, scripts, integration. Backend Python entry app.main:app; worker `python -m app.worker`. Frontend npm build -> frontend/dist; app serves /app/static built frontend if exists, SPA fallback except /api. Backend requirements split requirements.txt (API/common) and requirements-worker.txt (includes base + faster-whisper/OpenCC); root can adjust. Configuration env DATABASE_URL, DATA_DIR=/data, MODEL_CACHE_DIR=/models, SECRET_KEY (optional auto-generated /data secret), CHATGPT_CALLBACK_PORT=1457, CHATGPT_CALLBACK_BIND=0.0.0.0 for Docker listener, COOKIE_SECURE=false for localhost (HTTPS safe behind tailnet).
