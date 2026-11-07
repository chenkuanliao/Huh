import asyncio, contextlib, hashlib, os, re, secrets, shutil
from pathlib import Path
from uuid import UUID
from urllib.parse import urlsplit
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, FileResponse
from fastapi.exceptions import RequestValidationError
from starlette.middleware.gzip import GZipMiddleware
from sqlalchemy import select, delete
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from .db import *
from .services import *
from .security import encrypt, decrypt, digest
from . import oauth, providers
from .model_cache import downloaded

ph = PasswordHasher()
COOKIE = "huh_session"
MIMES = {
    "audio/webm",
    "video/webm",
    "audio/mp4",
    "video/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "application/ogg",
    "audio/flac",
    "audio/aac",
}
MAX_AUDIO = 20 * 1024**3


def valid_id(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        fail("Expected UUID", 422)


def string(v, name, limit=200000):
    if not isinstance(v, str) or len(v) > limit:
        fail(f"Invalid {name}", 422)
    return v


def boolean(v, name):
    if not isinstance(v, bool):
        fail(f"Invalid {name}", 422)
    return v


def mime(v):
    string(v, "mime_type", 128)
    if v.split(";")[0].strip().lower() not in MIMES:
        fail("Unsupported audio type", 415)
    return v


def auth(s, request):
    token = request.cookies.get(COOKIE, "")
    v = getkv(s, "session:" + digest(token)) if token else {}
    return bool(v.get("expires", 0) > now())


def session(s, response):
    token = secrets.token_urlsafe(32)
    putkv(s, "session:" + digest(token), {"expires": now() + 86400 * 30})
    response.set_cookie(
        COOKIE,
        token,
        max_age=86400 * 30,
        httponly=True,
        samesite="strict",
        secure=os.getenv("COOKIE_SECURE", "false").lower() == "true",
        path="/",
    )


def tick():
    with tx() as s:
        for m in s.scalars(select(Meeting)):
            monitor(s, m)


async def monitor_loop():
    while True:
        try:
            await asyncio.to_thread(tick)
        except Exception:
            pass  # Next cycle retries; DB health endpoint exposes connectivity.
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app):
    init()
    with tx() as s:
        seed_templates(s)
    server = None
    app.state.listener_error = None
    if os.getenv("OAUTH_LISTENER_ENABLED", "true") == "true":
        try:
            server = await oauth.listener()
        except OSError:
            app.state.listener_error = (
                "Callback port unavailable. Paste the remote callback URL instead."
            )
    app.state.listener_active = bool(server)
    task = asyncio.create_task(monitor_loop())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    if server:
        server.close()
        await server.wait_closed()


NOTE_TEMPLATES = [
    (
        "Meeting agenda",
        "## Attendees\n- \n\n## Agenda\n1. \n\n## Notes\n- \n\n## Decisions\n- \n\n## Next steps\n- [ ] ",
    ),
    (
        "1:1 check-in",
        "## Wins since last time\n- \n\n## Blockers\n- \n\n## Discussion\n- \n\n## Follow-ups\n- [ ] ",
    ),
    (
        "Research meeting",
        "## Progress\n- \n\n## Results / data\n- \n\n## Open questions\n- \n\n## Feedback\n- \n\n## To do before next meeting\n- [ ] ",
    ),
    (
        "Standup",
        "## Yesterday\n- \n\n## Today\n- \n\n## Blocked on\n- ",
    ),
]
AI_TEMPLATES = [
    (
        "Action-focused",
        "Lead with decisions and action items. Keep the summary to three sentences. List owners and due dates only when they were explicitly stated.",
        "## Decisions\n## Action items\n## Open questions\n## Brief summary",
    ),
    (
        "Research discussion",
        "Capture results, interpretations, feedback received, and agreed next experiments. Keep technical terms, numbers, and citations exactly as spoken or written.",
        "## Summary\n## Results discussed\n## Feedback and ideas\n## Next experiments\n## Open questions",
    ),
]


def seed_templates(s):
    if not s.scalar(select(Template).where(Template.kind == "ai").limit(1)):
        s.add(
            Template(
                name="Meeting notes",
                instructions="Prioritize written notes. Support them with transcript evidence. Do not invent owners, dates, or decisions.",
                structure="## Summary\n## Key points\n## Decisions\n## Action items",
                is_default=True,
                kind="ai",
            )
        )
    seeded = dict(getkv(s, "seeded"))
    # Starter templates are added once; deleting them later is respected.
    if not seeded.get("templates_v2"):
        for name, body in NOTE_TEMPLATES:
            s.add(Template(name=name, instructions="", structure=body, kind="notes"))
        for name, instructions, structure in AI_TEMPLATES:
            s.add(
                Template(
                    name=name, instructions=instructions, structure=structure, kind="ai"
                )
            )
        seeded["templates_v2"] = True
        putkv(s, "seeded", seeded)


def ai_template(s, tid):
    t = require(s, Template, tid)
    if t.kind != "ai":
        fail("Choose an AI template for generated notes", 422)
    return t


app = FastAPI(title="Huh", lifespan=lifespan)


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    return JSONResponse({"detail": "Internal server error"}, status_code=500)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse(
        {"detail": "Invalid request body or parameters"}, status_code=422
    )


@app.exception_handler(oauth.OAuthError)
@app.exception_handler(providers.ProviderError)
async def provider_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.middleware("http")
async def protect(request, call_next):
    if request.url.path.startswith("/api"):
        if request.method not in ["GET", "HEAD", "OPTIONS"]:
            origin = request.headers.get("origin")
            allowed = {str(request.base_url).rstrip("/")} | set(
                filter(None, os.getenv("ALLOWED_ORIGINS", "").split(","))
            )
            if (origin and origin not in allowed) or request.headers.get(
                "sec-fetch-site"
            ) == "cross-site":
                return JSONResponse(
                    {"detail": "Cross-origin mutation denied"}, status_code=403
                )
            if "/chunks/" not in request.url.path:
                body = bytearray()
                async for part in request.stream():
                    body.extend(part)
                    if len(body) > 1024 * 1024:
                        return JSONResponse(
                            {"detail": "Request exceeds 1 MiB"}, status_code=413
                        )
                request._body = bytes(body)
        public_paths = {
            "/api/health",
            "/api/auth/status",
            "/api/auth/setup",
            "/api/auth/login",
        }
        if request.url.path not in public_paths:
            with tx() as s:
                if not auth(s, request):
                    return JSONResponse(
                        {"detail": "Authentication required"}, status_code=401
                    )
    response = await call_next(request)
    if (
        request.method == "GET"
        and request.url.path.startswith("/api")
        and response.status_code == 200
        and response.headers.get("content-type", "").startswith("application/json")
    ):
        response = await with_etag(request, response)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    return response


async def with_etag(request, response):
    """Tag JSON reads with a hash of their body so a client that already holds them gets a tiny 304.

    The client keeps the data in memory and sends If-None-Match itself; nothing is written to the browser's cache."""
    body = b"".join([chunk async for chunk in response.body_iterator])
    etag = '"' + hashlib.blake2b(body, digest_size=12).hexdigest() + '"'
    if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers={"ETag": etag})
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(body, status_code=200, headers=headers | {"ETag": etag})


class Compress:
    """Gzip JSON, HTML, JS and CSS (the phone usually reaches this server over Tailscale), but never audio,
    which is already compressed and is fetched with Range requests."""

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=5)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not scope["path"].endswith("/audio"):
            return await self.gzip(scope, receive, send)
        return await self.app(scope, receive, send)


app.add_middleware(Compress)


@app.get("/api/health")
def health():
    with tx() as s:
        worker = getkv(s, "worker")
    return {
        "status": "ok",
        "database": "ok",
        "worker": {
            "online": worker.get("last_seen", 0) > now() - 90,
            "last_seen": iso(worker["last_seen"]) if worker.get("last_seen") else None,
            "cuda_available": worker.get("cuda_available"),
        },
    }


@app.get("/api/auth/status")
def auth_status(request: Request):
    with tx() as s:
        return {
            "authenticated": auth(s, request),
            "setup_required": not bool(getkv(s, "owner")),
        }


@app.post("/api/auth/setup")
def setup(body: dict, response: Response):
    password = string(body.get("password"), "password", 1024)
    if len(password) < 10:
        fail("Password must contain at least 10 characters", 422)
    with tx() as s:
        if getkv(s, "owner"):
            fail("Owner already configured")
        putkv(s, "owner", {"password": ph.hash(password)})
        session(s, response)
    return {"authenticated": True, "setup_required": False}


@app.post("/api/auth/login")
def login(body: dict, response: Response, request: Request):
    password = string(body.get("password"), "password", 1024)
    with tx() as s:
        key = "login:" + digest(request.client.host if request.client else "unknown")
        attempts = getkv(s, key)
        if attempts.get("until", 0) > now():
            fail("Too many login attempts; try later", 429)
        owner = getkv(s, "owner")
        ok = False
        try:
            ok = bool(owner and ph.verify(owner["password"], password))
        except (VerifyMismatchError, InvalidHashError):
            pass
        if not ok:
            count = attempts.get("count", 0) + 1
            putkv(s, key, {"count": count, "until": now() + 60 if count >= 5 else 0})
        else:
            putkv(s, key, {})
            session(s, response)
    if not ok:
        fail("Invalid password", 401)
    return {"authenticated": True, "setup_required": False}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    with tx() as s:
        s.execute(
            delete(KV).where(
                KV.key == "session:" + digest(request.cookies.get(COOKIE, ""))
            )
        )
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/meetings")
def list_meetings():
    with tx() as s:
        return [
            public(m)
            for m in s.scalars(select(Meeting).order_by(Meeting.updated_at.desc()))
        ]


def snippet(text, q, width=70):
    i = text.lower().find(q.lower())
    if i < 0:
        return text[: width * 2].strip()
    start = max(0, i - width)
    end = min(len(text), i + len(q) + width)
    return ("…" if start else "") + " ".join(text[start:end].split()) + ("…" if end < len(text) else "")


@app.get("/api/search")
def search(q: str = ""):
    """Search titles, notes, AI notes and transcripts across every meeting.

    Archived meetings are still searchable, but always rank after everything else."""
    q = q.strip()
    if len(q) < 2:
        return {"results": []}
    if len(q) > 200:
        fail("Search is too long", 422)
    pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    like = lambda col: col.ilike(pattern, escape="\\")
    results = []
    with tx() as s:
        for m in s.scalars(
            select(Meeting)
            .where(like(Meeting.title) | like(Meeting.notes) | like(Meeting.enhanced_notes))
            .order_by(Meeting.archived, Meeting.updated_at.desc())
            .limit(30)
        ):
            for field, text in [("title", m.title), ("notes", m.notes), ("enhanced", m.enhanced_notes)]:
                if q.lower() in (text or "").lower():
                    results.append(dict(meeting_id=m.id, title=m.title, field=field, snippet=snippet(text, q),
                                        updated_at=public(m)["updated_at"], archived=m.archived))
        rows = s.execute(
            select(Segment, Recording, Meeting)
            .join(Recording, Segment.recording_id == Recording.id)
            .join(Meeting, Recording.meeting_id == Meeting.id)
            .where(like(Segment.text), Recording.excluded == False)
            .order_by(Meeting.archived, Meeting.updated_at.desc(), Segment.start)
            .limit(60)
        ).all()
        for seg, r, m in rows:
            results.append(
                dict(meeting_id=m.id, title=m.title, field="transcript", snippet=snippet(seg.text, q),
                     recording_id=r.id, start=seg.start, segment_id=seg.id, updated_at=public(m)["updated_at"],
                     archived=m.archived)
            )
    # Stable sort: active meetings first, archived last, otherwise keep the order above.
    results.sort(key=lambda r: r["archived"])
    return {"results": results}


@app.get("/api/dashboard")
def dashboard():
    """Per-meeting activity for the home dashboard; date grouping happens in the client's timezone."""
    with tx() as s:
        from sqlalchemy import func

        stats = {}
        for mid, seconds, count in s.execute(
            select(Recording.meeting_id, func.sum(Recording.duration), func.count(Recording.id))
            .where(Recording.excluded == False)
            .group_by(Recording.meeting_id)
        ):
            stats[mid] = {"recorded_seconds": float(seconds or 0), "recordings": count}
        for mid, count in s.execute(
            select(Recording.meeting_id, func.count(Segment.id))
            .join(Segment, Segment.recording_id == Recording.id)
            .group_by(Recording.meeting_id)
        ):
            stats.setdefault(mid, {"recorded_seconds": 0, "recordings": 0})["segments"] = count
        for mid, count in s.execute(
            select(Generation.meeting_id, func.count(Generation.id)).group_by(Generation.meeting_id)
        ):
            stats.setdefault(mid, {"recorded_seconds": 0, "recordings": 0})["generations"] = count
        titles = dict(s.execute(select(Meeting.id, Meeting.title)).all())
        jobs = [
            public(j) | {"meeting_id": j.meeting_id, "meeting_title": titles.get(j.meeting_id)}
            for j in s.scalars(
                select(Job)
                .where(
                    Job.kind.in_(["transcribe", "generate"]),
                    Job.status.in_(["queued", "running"])
                    | ((Job.status == "failed") & (Job.created_at > now() - 86400 * 3)),
                )
                .order_by(Job.created_at.desc())
                .limit(20)
            )
            if j.meeting_id in titles
        ]
        return {
            "meetings": {
                mid: {"recorded_seconds": 0, "recordings": 0, "segments": 0, "generations": 0} | v
                for mid, v in stats.items()
                if mid in titles
            },
            "jobs": jobs,
        }


@app.post("/api/meetings")
def create_meeting(body: dict):
    with tx() as s:
        tid = body.get("template_id")
        if tid:
            ai_template(s, tid)
        fid = body.get("folder_id")
        m = Meeting(
            title=string(body.get("title", "Untitled meeting"), "title", 500),
            template_id=tid,
            folder_id=require(s, Folder, valid_id(fid)).id if fid else None,
        )
        s.add(m)
        s.flush()
        return public(m)


@app.get("/api/meetings/{mid}")
def detail(mid: str):
    with tx() as s:
        m = require(s, Meeting, mid)
        monitor(s, m)
        rs = recordings(s, mid)
        return public(m) | {
            "recordings": [public(r) for r in rs],
            "transcript": [
                public(x)
                for x in s.scalars(
                    select(Segment)
                    .where(
                        Segment.recording_id.in_([r.id for r in rs if not r.excluded])
                    )
                    .order_by(Segment.recording_id, Segment.start)
                )
            ],
            "generations": [
                public(x)
                for x in s.scalars(
                    select(Generation)
                    .where(Generation.meeting_id == mid)
                    .order_by(Generation.created_at.desc())
                )
            ],
            "jobs": [
                public(x)
                for x in s.scalars(
                    select(Job)
                    .where(Job.meeting_id == mid)
                    .order_by(Job.created_at.desc())
                )
            ],
            "recording_state": m.state,
        }


@app.patch("/api/meetings/{mid}")
def edit_meeting(mid: str, body: dict):
    with tx() as s:
        m = require(s, Meeting, mid)
        for field, revision in [
            ("notes", "notes_revision"),
            ("enhanced_notes", "enhanced_revision"),
        ]:
            if field in body:
                if body.get(revision) != getattr(m, revision):
                    fail("Revision conflict; reload before saving")
                setattr(m, field, string(body[field], field))
                setattr(m, revision, getattr(m, revision) + 1)
        for field in ["title", "language"]:
            if field in body:
                setattr(m, field, string(body[field], field, 500))
        if "notes_language" in body:
            value = body["notes_language"]
            m.notes_language = string(value, "notes_language", 200).strip() or None if value else None
        if "template_id" in body:
            if body["template_id"]:
                ai_template(s, body["template_id"])
            m.template_id = body["template_id"]
        if "folder_id" in body:
            m.folder_id = require(s, Folder, valid_id(body["folder_id"])).id if body["folder_id"] else None
        if "archived" in body:
            m.archived = boolean(body["archived"], "archived")
        if "glossary" in body:
            m.glossary = glossary_entries(body["glossary"])
        # Filing, archiving and AI context are organisation, not edits; keep the meeting's place in "recent".
        if set(body) - {"folder_id", "archived", "glossary"}:
            m.updated_at = now()
        s.flush()
        return public(m)


@app.delete("/api/meetings/{mid}")
def delete_meeting(mid: str):
    with tx() as s:
        m = require(s, Meeting, mid)
        rs = recordings(s, mid)
        if any(r.status in ["starting", "recording", "stopping"] for r in rs):
            fail("Stop and finish capture before deleting")
        for cls in [Chunk, Segment]:
            s.execute(delete(cls).where(cls.recording_id.in_([r.id for r in rs])))
        for cls in [Recording, Generation, Job]:
            s.execute(delete(cls).where(cls.meeting_id == mid))
        for d in s.scalars(select(Device).where(Device.meeting_id == mid)):
            d.meeting_id = None
        s.execute(delete(KV).where(KV.key == "generated:" + mid))
        s.delete(m)
    for r in rs:
        shutil.rmtree(DATA / "recordings" / r.id, ignore_errors=True)
    return {"ok": True}


def folder_name(body):
    name = string(body.get("name"), "name", 200).strip()
    if not name:
        fail("Folder name is required", 422)
    return name


FOLDER_COLORS = {"slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"}
FOLDER_ICON = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


def folder_look(f, body):
    """Applies optional color/icon/glossary from the body; null resets to the default look."""
    if "glossary" in body:
        f.glossary = glossary_entries(body["glossary"])
    if "color" in body:
        c = body["color"]
        if c is not None and c not in FOLDER_COLORS:
            fail("Invalid color", 422)
        f.color = c
    if "icon" in body:
        i = body["icon"]
        if i is not None and not (isinstance(i, str) and FOLDER_ICON.match(i)):
            fail("Invalid icon", 422)
        f.icon = i


@app.get("/api/folders")
def list_folders():
    with tx() as s:
        return [public(f) for f in s.scalars(select(Folder).order_by(Folder.name, Folder.created_at))]


@app.post("/api/folders")
def create_folder(body: dict):
    with tx() as s:
        f = Folder(name=folder_name(body))
        folder_look(f, body)
        s.add(f)
        s.flush()
        return public(f)


@app.patch("/api/folders/{fid}")
def rename_folder(fid: str, body: dict):
    with tx() as s:
        f = require(s, Folder, fid)
        if "name" in body:
            f.name = folder_name(body)
        folder_look(f, body)
        s.flush()
        return public(f)


@app.delete("/api/folders/{fid}")
def delete_folder(fid: str):
    """Removes the folder only; its meetings move back to the main list."""
    with tx() as s:
        f = require(s, Folder, fid)
        for m in s.scalars(select(Meeting).where(Meeting.folder_id == fid)):
            m.folder_id = None
        s.delete(f)
    return {"ok": True}


@app.post("/api/meetings/{mid}/generate")
def generate_meeting(mid: str, body: dict):
    with tx() as s:
        language = body.get("output_language")
        language = string(language, "output_language", 200).strip() if language else None
        return public(generate(s, require(s, Meeting, mid), body.get("template_id"), language or None))


@app.post("/api/meetings/{mid}/transcribe")
def transcribe_meeting(mid: str):
    with tx() as s:
        m = require(s, Meeting, mid)
        jobs = [
            transcribe(s, r)
            for r in recordings(s, mid)
            if r.status in ["ready", "error", "queued"] and not r.excluded
        ]
        if jobs:
            return public(jobs[0])
        return public(generate(s, m))


@app.get("/api/meetings/{mid}/export")
def export(mid: str, format: str = "md"):
    if format != "md":
        fail("Only Markdown export is supported", 422)
    d = detail(mid)
    text = (
        "# "
        + d["title"]
        + "\n\n## Notes\n\n"
        + d["notes"]
        + "\n\n## AI notes\n\n"
        # Hidden source markers ([[12:34]], [[notes]]) are for in-app hover only.
        + re.sub(r"[ \t]*\[\[[^\[\]\n]{1,300}\]\]", "", d["enhanced_notes"])
        + "\n\n## Transcript\n\n"
    )
    labels = {r["id"]: r["label"] for r in d["recordings"]}
    text += "\n".join(
        f"[{labels[x['recording_id']]} {x['start']:.1f}–{x['end']:.1f}s] {x['text']}"
        for x in d["transcript"]
    )
    return Response(
        text,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="meeting-{mid}.md"'},
    )


@app.post("/api/devices/heartbeat")
def heartbeat(body: dict):
    id = valid_id(body.get("id"))
    mid = body.get("meeting_id")
    ready = boolean(body.get("ready"), "ready")
    backup = boolean(body.get("backup_enabled"), "backup_enabled")
    with tx() as s:
        if mid:
            require(s, Meeting, mid)
        d = s.get(Device, id)
        if not d:
            d = Device(id=id, name="")
            s.add(d)
        if (
            d.meeting_id
            and d.meeting_id != mid
            and s.scalar(
                select(Recording).where(
                    Recording.device_id == id,
                    Recording.status.in_(["starting", "recording", "stopping"]),
                )
            )
        ):
            fail("Device must finish capture before changing meetings")
        d.name = string(body.get("name"), "name", 200)
        d.meeting_id = mid
        d.ready = ready
        d.backup_enabled = backup
        d.last_seen = now()
        d.capture_state = string(body.get("capture_state", "idle"), "capture_state", 50)
        d.recording_id = body.get("recording_id")
        s.flush()
        if mid:
            monitor(s, require(s, Meeting, mid))
        command = None
        # Stop old captures before delivering a new start on this device.
        rows = list(
            s.scalars(
                select(Recording)
                .where(
                    Recording.device_id == id,
                    Recording.status.in_(["starting", "stopping"]),
                )
                .order_by(Recording.created_at)
            )
        )
        if rows:
            r = rows[0]
            command = dict(
                type="start" if r.status == "starting" else "stop",
                meeting_id=r.meeting_id,
                recording_id=r.id,
                token=decrypt(r.token),
            )
        elif mid:
            m = require(s, Meeting, mid)
            if m.state.get("active_device_id") == id:
                r = next((r for r in reversed(recordings(s, mid)) if r.device_id == id and r.status == "recording"), None)
                desired = "paused" if m.state.get("user_paused") else "recording"
                if r and d.capture_state in ["recording", "paused"] and d.capture_state != desired:
                    command = dict(type="pause" if desired == "paused" else "resume", meeting_id=mid, recording_id=r.id)
        return {"device": public(d), "command": command}


@app.get("/api/meetings/{mid}/devices")
def devices(mid: str):
    with tx() as s:
        require(s, Meeting, mid)
        return [
            public(d) for d in s.scalars(select(Device).where(Device.meeting_id == mid))
        ]


@app.get("/api/meetings/{mid}/recording-state")
def state(mid: str):
    with tx() as s:
        m = require(s, Meeting, mid)
        monitor(s, m)
        return m.state


@app.patch("/api/meetings/{mid}/recording-policy")
def policy(mid: str, body: dict):
    with tx() as s:
        m = require(s, Meeting, mid)
        st = dict(m.state)
        if "auto_fallback" in body:
            st["auto_fallback"] = boolean(body["auto_fallback"], "auto_fallback")
        if "backup_order" in body:
            if (
                not isinstance(body["backup_order"], list)
                or len(body["backup_order"]) > 100
            ):
                fail("Invalid backup order", 422)
            st["backup_order"] = list(
                dict.fromkeys(valid_id(v) for v in body["backup_order"])
            )
        m.state = st
        return st


@app.post("/api/meetings/{mid}/recording-control")
def control(mid: str, body: dict):
    with tx() as s:
        m = require(s, Meeting, mid)
        monitor(s, m)
        action = body.get("action")
        if action == "stop":
            stop(s, m)
        elif action in ["pause", "resume"]:
            st = dict(m.state)
            if not st.get("active_device_id") or st.get("pending_device_id"):
                fail("An active recording is required")
            paused = action == "pause"
            st.update(user_paused=paused, status="paused" if paused else "recording",
                      message="Paused. Resume when ready, or finish to transcribe and generate AI notes." if paused else None)
            m.state = st
            m.status = st["status"]
        elif action in ["start", "switch"]:
            if m.state.get("user_paused"):
                fail("Resume or finish the paused recording first")
            if m.state.get("pending_device_id"):
                fail("A device is already starting")
            if action == "start" and m.state.get("active_device_id"):
                fail("A device is already recording; use switch")
            start(s, m, require(s, Device, body.get("device_id", "")))
        else:
            fail("Invalid recording action", 422)
        return m.state


def check_token(r, value):
    if not isinstance(value, str) or not secrets.compare_digest(
        decrypt(r.token), value
    ):
        fail("Invalid recording token", 403)


@app.post("/api/recordings/{rid}/started")
def started(rid: str, body: dict):
    with tx() as s:
        r = require(s, Recording, rid)
        check_token(r, body.get("token"))
        acknowledge(s, r)
        return public(r)


@app.post("/api/meetings/{mid}/uploads")
def upload(mid: str, body: dict):
    size = body.get("size")
    mode = body.get("mode", "additional")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_AUDIO:
        fail("Invalid upload size (maximum 20 GiB)", 422)
    if mode not in ["additional", "complete"]:
        fail("Invalid upload mode", 422)
    with tx() as s:
        require(s, Meeting, mid)
        token = secrets.token_urlsafe(32)
        r = Recording(
            meeting_id=mid,
            label=string(body.get("filename"), "filename", 500),
            mime_type=mime(body.get("mime_type")),
            status="uploading",
            expected_size=size,
            mode=mode,
            token=encrypt(token),
        )
        s.add(r)
        s.flush()
        return {"recording_id": r.id, "token": token, "chunk_size": 1048576}


@app.put("/api/recordings/{rid}/chunks/{index}")
async def chunk(rid: str, index: int, request: Request):
    if not 0 <= index < 1000000:
        fail("Invalid chunk index", 422)
    data = bytearray()
    async for block in request.stream():
        data.extend(block)
        if len(data) > 8 * 1024 * 1024:
            fail("Chunk exceeds 8 MiB", 413)
    if not data:
        fail("Empty chunk", 422)
    content_type = mime(request.headers.get("content-type", ""))
    sha = hashlib.sha256(data).hexdigest()
    with tx() as s:
        r = require(s, Recording, rid)
        check_token(r, request.headers.get("x-recording-token"))
        existing = s.get(Chunk, (rid, index))
        if existing:
            if existing.digest != sha:
                fail("Chunk index already contains different bytes")
            return {"index": index, "bytes": existing.size}
        if r.status not in ["starting", "recording", "stopping", "uploading"]:
            fail("Recording is already complete")
        if index != r.chunk_count:
            fail("Chunks must be uploaded in order; retry the next missing index")
        if r.bytes + len(data) > MAX_AUDIO or (
            r.expected_size is not None and r.bytes + len(data) > r.expected_size
        ):
            fail("Recording exceeds declared size", 413)
        if index == 0:
            r.mime_type = content_type
        elif content_type != r.mime_type:
            fail("Chunk MIME type changed")
        directory = DATA / "recordings" / rid
        directory.mkdir(parents=True, exist_ok=True)
        temp = directory / (str(index) + "." + secrets.token_hex(8) + ".tmp")
        with temp.open("xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, directory / str(index))
        s.add(Chunk(recording_id=rid, index=index, digest=sha, size=len(data)))
        r.bytes += len(data)
        r.chunk_count += 1
        return {"index": index, "bytes": len(data)}


def remove_pieces(directory):
    """Uploaded pieces are redundant once the assembled `audio` file is committed."""
    for piece in directory.glob("[0-9]*"):
        if piece.name.isdigit():
            piece.unlink(missing_ok=True)


@app.post("/api/recordings/{rid}/finish")
def finish(rid: str, body: dict):
    count = body.get("chunk_count")
    duration = body.get("duration")
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        fail("Recording requires at least one chunk", 422)
    if duration is not None and (
        not isinstance(duration, (int, float)) or not 0 <= duration <= 604800
    ):
        fail("Invalid duration", 422)
    with tx() as s:
        r = require(s, Recording, rid)
        check_token(r, body.get("token"))
        if r.chunk_count != count or (
            r.expected_size is not None and r.bytes != r.expected_size
        ):
            fail("Recording is incomplete")
        if r.status in ["ready", "queued", "transcribed", "error"]:
            return public(r)
        directory = DATA / "recordings" / rid
        assembled = directory / "audio"
        # A retried finish after pieces were cleaned up reuses the assembled file.
        if not (assembled.exists() and assembled.stat().st_size == r.bytes):
            temporary = directory / "audio.tmp"
            with temporary.open("wb") as out:
                for i in range(count):
                    path = directory / str(i)
                    if not path.exists():
                        fail("Recording chunk missing on disk")
                    with path.open("rb") as src:
                        shutil.copyfileobj(src, out, 1024 * 1024)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, assembled)
        r.duration = duration
        r.status = "ready"
        m = require(s, Meeting, r.meeting_id)
        if r.mode == "complete":
            for other in recordings(s, m.id):
                if other.id != r.id:
                    other.excluded = True
        st = dict(m.state)
        if st.get("active_device_id") == r.device_id and r.device_id:
            st["active_device_id"] = None
            st["status"] = "starting" if st.get("pending_device_id") else "paused"
            st["message"] = "Capture ended unexpectedly; waiting for an armed backup."
        if st.get("pending_device_id") == r.device_id and r.device_id:
            st["pending_device_id"] = None
            st["status"] = "recording" if st.get("active_device_id") else "paused"
        m.state = st
        m.status = st["status"]
        monitor(s, m)
        if not m.state.get("user_paused"):
            transcribe(s, r)
        result = public(r)
    remove_pieces(DATA / "recordings" / rid)
    return result


@app.get("/api/recordings/{rid}/audio")
def audio(rid: str):
    with tx() as s:
        r = require(s, Recording, rid)
    folder = DATA / "recordings" / r.id
    playback = folder / "playback.m4a"
    if playback.exists():
        # Seekable copy with an exact duration (see worker.make_playback).
        return FileResponse(playback, media_type="audio/mp4", filename=f"{r.label}.m4a", content_disposition_type="inline")
    path = folder / "audio"
    if not path.exists():
        fail("Recording is not complete", 409)
    return FileResponse(path, media_type=r.mime_type, filename=r.label, content_disposition_type="inline")


@app.post("/api/recordings/{rid}/transcribe")
def retranscribe(rid: str):
    """Run speech recognition again on a finished recording (e.g. after model or language changes)."""
    with tx() as s:
        r = require(s, Recording, rid)
        if r.status not in ["ready", "error", "queued", "transcribed"]:
            fail("Recording is not finished yet")
        return public(transcribe(s, r))


@app.get("/api/templates")
def templates():
    with tx() as s:
        return [public(t) for t in s.scalars(select(Template).order_by(Template.name))]


def make_default(s, t, value):
    if value and t.kind != "ai":
        fail("Only AI templates can be the default", 422)
    if value:
        for other in s.scalars(select(Template).where(Template.is_default == True)):
            other.is_default = False
    t.is_default = value


@app.post("/api/templates")
def create_template(body: dict):
    with tx() as s:
        kind = body.get("kind", "ai")
        if kind not in ["ai", "notes"]:
            fail("Invalid template kind", 422)
        t = Template(
            kind=kind,
            **{
                k: string(body.get(k, ""), k, 20000 if k != "name" else 200)
                for k in ["name", "instructions", "structure"]
            },
        )
        if not t.name.strip():
            fail("Template name is required", 422)
        s.add(t)
        s.flush()
        if "is_default" in body:
            make_default(s, t, boolean(body["is_default"], "is_default"))
        return public(t)


@app.patch("/api/templates/{tid}")
def edit_template(tid: str, body: dict):
    with tx() as s:
        t = require(s, Template, tid)
        for k in ["name", "instructions", "structure"]:
            if k in body:
                setattr(t, k, string(body[k], k, 20000 if k != "name" else 200))
        if not t.name.strip():
            fail("Template name is required", 422)
        if "is_default" in body:
            make_default(s, t, boolean(body["is_default"], "is_default"))
        return public(t)


@app.delete("/api/templates/{tid}")
def delete_template(tid: str):
    with tx() as s:
        t = require(s, Template, tid)
        if t.is_default:
            fail("Choose another default AI template before deleting this one")
        for m in s.scalars(select(Meeting).where(Meeting.template_id == tid)):
            m.template_id = None
        s.delete(t)
    return {"ok": True}


def public_settings(s):
    v = settings(s)
    return v | {
        "ai_order": ai_order(v),
        "api_key_status": {p: bool(getkv(s, "keys").get(p)) for p in PROVIDERS}
    }


@app.get("/api/settings")
def read_settings():
    with tx() as s:
        return public_settings(s)


@app.put("/api/settings")
def write_settings(body: dict):
    with tx() as s:
        v = settings(s)
        previous = ai_order(v)
        for k in DEFAULTS:
            if k in ("provider_models", "glossary", "ai_order"):
                continue
            if k in body:
                v[k] = (
                    boolean(body[k], k)
                    if k == "traditional_chinese"
                    else string(body[k], k, 20000 if k == "system_prompt" else 1000)
                )
        if v["provider"] not in PROVIDERS:
            fail("Unknown provider", 422)
        if "ai_order" in body:
            v["ai_order"] = ai_order_entries(body["ai_order"])
            if v["ai_order"]:
                v["provider"], v["model"] = v["ai_order"][0]["provider"], v["ai_order"][0]["model"]
        elif "provider" in body or "model" in body:
            # Choosing a provider/model directly makes it the first choice; the rest stay as backups.
            top = {"provider": v["provider"], "model": v["model"].strip()}
            rest = [
                e for e in previous
                if e != top and not (e["provider"] == top["provider"] and not e["model"])
            ]
            v["ai_order"] = ai_order_entries([top] + rest[: AI_ORDER_MAX - 1])
        # Remember the chosen model per provider so switching back restores it.
        remembered = dict(v.get("provider_models") or {})
        if "provider_models" in body:
            if not isinstance(body["provider_models"], dict):
                fail("Invalid provider models", 422)
            for p, model in body["provider_models"].items():
                if p not in PROVIDERS:
                    fail("Unknown provider", 422)
                remembered[p] = string(model, "model", 1000)
        if v["model"]:
            remembered[v["provider"]] = v["model"]
        v["provider_models"] = remembered
        if "glossary" in body:
            v["glossary"] = glossary_entries(body["glossary"])
        if (
            v["stt_model"] not in STT_MODELS
            or v["stt_language"] not in ["auto", "en", "zh", "mixed"]
            or v["stt_device"] not in ["cpu", "cuda"]
        ):
            fail("Invalid speech settings", 422)
        if v["stt_compute_type"] not in [
            "float16",
            "float32",
            "int8",
            "int8_float16",
            "int8_float32",
            "default",
            "auto",
        ]:
            fail("Invalid compute type", 422)
        if v["notes_view"] not in ["write", "preview"] or v["ai_notes_view"] not in [
            "write",
            "preview",
        ]:
            fail("Invalid editor view", 422)
        if v["back_behavior"] not in ["up", "history"]:
            fail("Invalid back behavior", 422)
        if v["base_url"] and (
            urlsplit(v["base_url"]).scheme not in ["http", "https"]
            or urlsplit(v["base_url"]).username
            or urlsplit(v["base_url"]).password
        ):
            fail("Invalid base URL", 422)
        keys = dict(getkv(s, "keys"))
        if not isinstance(body.get("api_keys", {}), dict):
            fail("Invalid API keys", 422)
        for p, key in body.get("api_keys", {}).items():
            if p not in PROVIDERS or p == "chatgpt":
                fail("Invalid API key provider", 422)
            if key is None:
                keys.pop(p, None)
            elif string(key, "api_key", 8192).strip():
                keys[p] = encrypt(key.strip())
        putkv(s, "keys", keys)
        putkv(s, "settings", v)
        return public_settings(s)


@app.post("/api/settings/test")
def test_provider(body: dict):
    with tx() as s:
        v = settings(s)
    for k in ["provider", "model"]:
        if k in body:
            v[k] = body[k]
    if v["provider"] not in PROVIDERS:
        fail("Unknown provider", 422)
    try:
        providers.infer(v, "You are a connection test.", "Reply with OK.")
        return {"ok": True, "message": "Provider inference completed."}
    except (providers.ProviderError, oauth.OAuthError) as e:
        return {"ok": False, "message": str(e)}


@app.get("/api/models")
def list_models(provider: str | None = None):
    with tx() as s:
        v = settings(s)
    if provider:
        v["provider"] = provider
    if v["provider"] not in PROVIDERS:
        fail("Unknown provider", 422)
    return {"models": providers.models(v)}


@app.get("/api/stt/models")
def stt_models():
    with tx() as s:
        v = settings(s)
        worker = getkv(s, "worker")
    return {
        "models": [
            {"id": m, "name": m, "downloaded": downloaded(m)} for m in STT_MODELS
        ],
        "device": v["stt_device"],
        "cuda_available": worker.get("cuda_available"),
    }


@app.post("/api/stt/models/download")
def download(body: dict):
    model = body.get("model")
    if model not in STT_MODELS:
        fail("Unknown speech model", 422)
    with tx() as s:
        return public(enqueue(s, "download", payload={"model": model}))


@app.get("/api/ai/notices")
def ai_notices():
    """Recent switches between models in the AI order, for app-wide pop-ups."""
    with tx() as s:
        jobs = list(
            s.scalars(
                select(Job)
                .where(Job.kind == "generate", Job.created_at > now() - 86400)
                .order_by(Job.created_at.desc())
                .limit(30)
            )
        )
        titles = dict(
            s.execute(
                select(Meeting.id, Meeting.title).where(Meeting.id.in_([j.meeting_id for j in jobs]))
            ).all()
        )
        return {
            "jobs": [
                {"id": j.id, "meeting_id": j.meeting_id, "meeting_title": titles.get(j.meeting_id), "status": j.status, "notices": public(j)["notices"]}
                for j in jobs
                if (j.payload or {}).get("notices")
            ]
        }


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    with tx() as s:
        return public(require(s, Job, jid))


@app.get("/api/chatgpt/status")
def chatgpt_status():
    return oauth.status()


@app.post("/api/chatgpt/sign-in")
def signin():
    return {
        "authorize_url": oauth.begin(),
        "redirect_uri": oauth.REDIRECT,
        "listener_active": getattr(app.state, "listener_active", False),
        "listener_error": getattr(app.state, "listener_error", None),
    }


@app.post("/api/chatgpt/callback")
def callback(body: dict):
    return oauth.complete(string(body.get("url"), "url", 16000))


@app.post("/api/chatgpt/sign-out")
def signout():
    return oauth.signout()


STATIC_ROOT = Path("/app/static")


@app.get("/{path:path}")
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        fail("Not found", 404)
    root = STATIC_ROOT
    target = (root / path).resolve()
    if target.is_relative_to(root) and target.is_file():
        # Vite puts a content hash in every file name under assets/, so those never change.
        immutable = target.is_relative_to(root / "assets")
        return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
    if (root / "index.html").exists():
        # Always revalidate the page itself so a deploy is picked up on the next load.
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
    fail("Frontend is not built", 404)
