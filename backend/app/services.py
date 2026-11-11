"""Transactional recording authority and job scheduling. Call inside db.tx()."""

import secrets
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import HTTPException
from sqlalchemy import select
from .db import *
from .security import encrypt

DEFAULTS = dict(
    provider="chatgpt",
    model="",
    base_url="",
    system_prompt="",
    output_language="auto",
    stt_model="large-v3-turbo",
    stt_language="mixed",
    stt_device="cuda",
    stt_compute_type="float16",
    traditional_chinese=True,
    # After a recording finishes: transcribe and write AI notes right away (True), or wait for the owner (False).
    auto_process=True,
    provider_models={},
    notes_view="live",
    ai_notes_view="preview",
    # What Back does: "up" goes to the parent page (meeting → its folder → Home); "history" retraces visited pages.
    back_behavior="up",
    # Glossary entries [{term, meaning}] given to the AI for every meeting.
    glossary=[],
    # Ranked [{provider, model}]: AI notes use the first one that works and fall back down the list.
    # Empty means "just provider/model" (settings saved before the order existed).
    ai_order=[],
    # IANA time zone that meeting dates and times are shown and picked in. Meetings are stored as
    # instants, so changing it shows the same moment in the new zone.
    time_zone="America/Chicago",
)
AI_ORDER_MAX = 12
PROVIDERS = {
    "chatgpt",
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "opencode",
    "nvidia",
    "custom",
}
STT_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
    "distil-large-v3",
]


def fail(message, code=409):
    raise HTTPException(code, message)


def require(s, cls, id):
    obj = s.get(cls, id)
    if not obj:
        fail("Not found", 404)
    return obj


def iso(value):
    return (
        datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
    )


def public(obj):
    fields = {
        Meeting: "id title notes notes_revision enhanced_notes enhanced_revision template_id language notes_language folder_id archived glossary created_at updated_at starts_at duration_minutes status",
        Folder: "id name color icon glossary created_at",
        Recording: "id meeting_id device_id label mime_type status created_at duration bytes chunk_count",
        Device: "id name meeting_id ready backup_enabled last_seen recording_id",
        Segment: "id recording_id start end text language",
        Template: "id name instructions structure is_default kind",
        Job: "id kind status progress error created_at",
        Generation: "id content created_at provider model template_name notes_revision output_language",
    }[type(obj)].split()
    result = {key: getattr(obj, key) for key in fields}
    if "starts_at" in result and result["starts_at"] is None:
        result["starts_at"] = obj.created_at
    if "duration_minutes" in result and not result["duration_minutes"]:
        result["duration_minutes"] = 60
    if "glossary" in result:
        result["glossary"] = result["glossary"] or []
    for key in ["created_at", "updated_at", "last_seen", "starts_at"]:
        if key in result:
            result[key] = iso(result[key])
    if isinstance(obj, Device):
        result["online"] = now() - obj.last_seen < 12
    if isinstance(obj, Job):
        # Fallbacks between models in the owner's AI order, newest last (no provider bodies or secrets).
        result["notices"] = list((obj.payload or {}).get("notices") or [])[-10:]
    return result


def settings(s):
    return DEFAULTS | getkv(s, "settings")


def ai_order(v):
    """The effective ranked AI order: the saved list, or the single provider/model of older settings."""
    if v.get("ai_order"):
        return [dict(e) for e in v["ai_order"]]
    return [{"provider": v.get("provider", "chatgpt"), "model": v.get("model", "")}]


def ai_order_entries(value):
    """Validates [{provider, model}] from a client; drops exact duplicates, keeps the order."""
    if not isinstance(value, list) or len(value) > AI_ORDER_MAX:
        fail(f"The AI order is a list of at most {AI_ORDER_MAX} models", 422)
    out, seen = [], set()
    for item in value:
        if not isinstance(item, dict):
            fail("Invalid AI order entry", 422)
        p, model = item.get("provider"), item.get("model", "")
        if p not in PROVIDERS:
            fail("Unknown provider", 422)
        if not isinstance(model, str) or len(model) > 1000:
            fail("Invalid model", 422)
        model = model.strip()
        if (p, model) in seen:
            continue
        seen.add((p, model))
        out.append({"provider": p, "model": model})
    return out


MEETING_MAX_MINUTES = 24 * 60


def instant(value, name):
    """An ISO 8601 date-time with an explicit offset (e.g. 2026-11-10T15:00:00Z) as UTC epoch seconds."""
    if not isinstance(value, str) or len(value) > 64:
        fail(f"Invalid {name}", 422)
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        fail(f"Invalid {name}", 422)
    if parsed.tzinfo is None:
        fail(f"{name} needs a time zone offset", 422)
    if not 1900 <= parsed.year <= 2200:
        fail(f"Invalid {name}", 422)
    return parsed.timestamp()


def meeting_minutes(value):
    """A meeting length in whole minutes, 1 minute to 24 hours."""
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MEETING_MAX_MINUTES:
        fail("Meeting length must be between 1 minute and 24 hours", 422)
    return value


def time_zone(value):
    """An IANA time zone name such as America/Chicago."""
    if not isinstance(value, str) or not value or len(value) > 64:
        fail("Invalid time zone", 422)
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        fail("Unknown time zone", 422)
    return value


def meeting_when(starts_at, minutes, zone):
    """'Tue, Nov 10, 2026 · 2:00 PM – 3:00 PM CST' in the owner's time zone (for exports)."""
    try:
        tz = ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone.utc
    start = datetime.fromisoformat(starts_at.replace("Z", "+00:00")).astimezone(tz)
    end = datetime.fromtimestamp(start.timestamp() + minutes * 60, tz)
    clock = lambda x: x.strftime("%I:%M %p").lstrip("0")
    day = lambda x: f"{x:%a}, {x:%b} {x.day}, {x.year}"
    tail = clock(end) if end.date() == start.date() else f"{day(end)} · {clock(end)}"
    return f"{day(start)} · {clock(start)} – {tail} {end.tzname()}"


GLOSSARY_MAX_ENTRIES = 300


def glossary_entries(value):
    """Validates [{term, meaning?}] from a client; trims text and drops blank rows."""
    if not isinstance(value, list) or len(value) > GLOSSARY_MAX_ENTRIES:
        fail(f"A glossary is a list of at most {GLOSSARY_MAX_ENTRIES} entries", 422)
    out = []
    for item in value:
        if not isinstance(item, dict):
            fail("Invalid glossary entry", 422)
        term, meaning = item.get("term", ""), item.get("meaning", "")
        if not isinstance(term, str) or not isinstance(meaning, str):
            fail("Invalid glossary entry", 422)
        term, meaning = term.strip(), meaning.strip()
        if len(term) > 200 or len(meaning) > 2000:
            fail("A glossary term is limited to 200 characters and its meaning to 2000", 422)
        if term:
            out.append({"term": term, "meaning": meaning})
        elif meaning:
            fail("Every glossary entry needs a term", 422)
    return out


def meeting_glossary(s, m):
    """Everything the AI should know for this meeting: all-notes, then folder, then meeting
    entries. A more specific entry replaces a broader one with the same term."""
    folder = s.get(Folder, m.folder_id) if m.folder_id else None
    merged = {}
    for entries in (
        settings(s).get("glossary") or [],
        (folder.glossary or []) if folder else [],
        m.glossary or [],
    ):
        for e in entries:
            key = e["term"].casefold()
            merged.pop(key, None)
            merged[key] = {"term": e["term"], "meaning": e.get("meaning", "")}
    return list(merged.values())


def recordings(s, mid):
    return list(
        s.scalars(
            select(Recording)
            .where(Recording.meeting_id == mid)
            .order_by(Recording.created_at)
        )
    )


def enqueue(s, kind, mid=None, payload=None):
    j = Job(kind=kind, meeting_id=mid, payload=payload or {})
    s.add(j)
    s.flush()
    return j


JOB_ACTIVE = ["queued", "running", "paused"]


def transcribe(s, r):
    jobs = list(
        s.scalars(
            select(Job).where(
                Job.kind == "transcribe",
                Job.meeting_id == r.meeting_id,
                Job.status.in_(JOB_ACTIVE),
            )
        )
    )
    for j in jobs:
        if j.payload.get("recording_id") == r.id:
            if j.status == "paused":
                # Asking to transcribe a paused recording resumes its job instead of starting another.
                resume_job(s, j)
            return j
    r.status = "queued"
    return enqueue(s, "transcribe", r.meeting_id, {"recording_id": r.id})


def pause_job(s, j):
    """Pauses a queued or running job. A running worker notices at its next checkpoint and stops;
    the job keeps its checkpoints (AI steps already done) for when it resumes."""
    if j.status not in ["queued", "running"]:
        fail("Only waiting or running work can be paused")
    j.status = "paused"
    j.lease = 0
    if j.kind == "transcribe":
        r = s.get(Recording, (j.payload or {}).get("recording_id"))
        if r and r.status == "queued":
            r.status = "ready"


def resume_job(s, j):
    if j.status != "paused":
        fail("Only paused work can be resumed")
    j.status = "queued"
    j.available = now()
    j.attempts = 0
    j.error = None
    if j.kind == "transcribe":
        r = s.get(Recording, (j.payload or {}).get("recording_id"))
        if r and r.status in ["ready", "error"]:
            r.status = "queued"


def cancel_job(s, j):
    """Stops a job for good. Audio and transcripts are kept; the work can be started again later."""
    if j.status not in JOB_ACTIVE:
        fail("This work has already finished")
    j.status = "cancelled"
    j.lease = 0
    j.error = None
    if j.kind == "transcribe":
        r = s.get(Recording, (j.payload or {}).get("recording_id"))
        if r and r.status == "queued":
            r.status = "ready"


def generate(s, m, template_id=None, output_language=None):
    rs = [r for r in recordings(s, m.id) if not r.excluded]
    segs = list(
        s.scalars(
            select(Segment)
            .where(Segment.recording_id.in_([r.id for r in rs]))
            .order_by(Segment.recording_id, Segment.start)
        )
    )
    if not segs:
        fail("A transcript is required before generation")
    template = (
        s.get(Template, template_id or m.template_id)
        if (template_id or m.template_id)
        else None
    )
    if template is None or template.kind != "ai":
        # Note templates only pre-fill the user's notes; generation uses an AI template.
        template = s.scalar(
            select(Template).where(Template.is_default == True, Template.kind == "ai")
        )
    labels = {r.id: r.label for r in rs}
    # 1-based position among all of the meeting's recordings, matching the client's ordering.
    order = {r.id: i for i, r in enumerate(recordings(s, m.id), 1)}
    cfg = settings(s)
    # One-off choice > this meeting's choice > the global "Language of AI notes" setting.
    cfg["output_language"] = output_language or m.notes_language or cfg["output_language"]
    payload = {
        "notes": m.notes,
        "notes_revision": m.notes_revision,
        "enhanced_revision": m.enhanced_revision,
        "settings": cfg,
        "multi": len(order) > 1,
        "template_name": template.name if template else "Meeting notes",
        "instructions": template.instructions if template else "",
        "structure": template.structure if template else "",
        "glossary": meeting_glossary(s, m),
        "transcript": [
            {
                "source": labels[x.recording_id],
                "rec": order[x.recording_id],
                "start": x.start,
                "end": x.end,
                "text": x.text,
            }
            for x in segs
        ],
    }
    # A new run replaces AI-notes work the owner had paused for this meeting.
    for old in s.scalars(
        select(Job).where(Job.kind == "generate", Job.meeting_id == m.id, Job.status == "paused")
    ):
        old.status = "cancelled"
    return enqueue(s, "generate", m.id, payload)


def maybe_generate(s, m):
    rs = [r for r in recordings(s, m.id) if not r.excluded]
    if (
        m.state["status"] != "idle"
        or not rs
        or any(r.status != "transcribed" for r in rs)
    ):
        return
    # Fingerprint avoids duplicate automatic generation after repeated stop/finish.
    fingerprint = ":".join(r.id for r in rs) + ":" + str(m.notes_revision)
    if getkv(s, "generated:" + m.id).get("fingerprint") == fingerprint:
        return
    generate(s, m)
    putkv(s, "generated:" + m.id, {"fingerprint": fingerprint})


def eligible(d, mid, backup=False):
    return (
        d
        and d.meeting_id == mid
        and d.ready
        and now() - d.last_seen < 12
        and (not backup or d.backup_enabled)
    )


def start(s, m, d):
    state = dict(m.state)
    if not eligible(d, m.id):
        fail("Device is not online and microphone-ready")
    if d.id in [state.get("active_device_id"), state.get("pending_device_id")]:
        fail("Device already active or starting")
    # One device cannot capture two meetings, including delayed stop acknowledgements.
    if s.scalar(
        select(Recording)
        .where(
            Recording.device_id == d.id,
            Recording.status.in_(["starting", "recording", "stopping"]),
        )
        .limit(1)
    ):
        fail("Device still has an unfinished capture")
    r = Recording(
        meeting_id=m.id,
        device_id=d.id,
        label=d.name,
        token=encrypt(secrets.token_urlsafe(32)),
    )
    s.add(r)
    s.flush()
    state.update(
        status="switching" if state.get("active_device_id") else "starting",
        pending_device_id=d.id,
        message=None,
    )
    m.state = state
    m.status = state["status"]
    return r


def stop(s, m):
    for r in recordings(s, m.id):
        if r.status in ["starting", "recording"]:
            r.status = "stopping"
        elif r.status == "ready" and r.device_id and settings(s)["auto_process"]:
            transcribe(s, r)
    state = dict(m.state)
    state.update(
        status="idle", active_device_id=None, pending_device_id=None, message=None, user_paused=False
    )
    m.state = state
    m.status = "idle"
    maybe_generate(s, m)


def monitor(s, m):
    state = dict(m.state)
    # An intentional pause must never activate a backup microphone.
    if state.get("user_paused"):
        return
    pending = state.get("pending_device_id")
    active = state.get("active_device_id")
    failed = set()
    rs = recordings(s, m.id)
    if pending:
        r = next(
            (
                r
                for r in reversed(rs)
                if r.device_id == pending and r.status == "starting"
            ),
            None,
        )
        if not r or now() - r.created_at > 15:
            if r:
                r.status = "stopping"
            failed.add(pending)
            state["pending_device_id"] = None
    if active:
        d = s.get(Device, active)
        if not eligible(d, m.id) or d.capture_state in ["error", "ended"]:
            failed.add(active)
            state["active_device_id"] = None
            for r in rs:
                if r.device_id == active and r.status == "recording":
                    r.status = "stopping"
    if not failed and state["status"] != "paused":
        return
    state.update(
        status="starting"
        if state.get("pending_device_id")
        else ("recording" if state.get("active_device_id") else "paused"),
        message="Capture interrupted; waiting for an armed backup."
        if not state.get("active_device_id")
        else "Replacement did not start; original source remains active.",
    )
    m.state = state
    m.status = state["status"]
    if not state.get("pending_device_id") and state.get("auto_fallback"):
        for id in state.get("backup_order", []):
            d = s.get(Device, id)
            if (
                id not in failed
                and id != state.get("active_device_id")
                and eligible(d, m.id, True)
            ):
                if s.scalar(
                    select(Recording).where(
                        Recording.device_id == id,
                        Recording.status.in_(["starting", "recording", "stopping"]),
                    )
                ):
                    continue
                start(s, m, d)
                break


def acknowledge(s, r):
    m = require(s, Meeting, r.meeting_id)
    if r.status == "recording":
        return
    if r.status != "starting" or m.state.get("pending_device_id") != r.device_id:
        fail("Start command is no longer current")
    if now() - r.created_at > 15:
        fail("Start command expired")
    for old in recordings(s, m.id):
        if old.id != r.id and old.status == "recording":
            old.status = "stopping"
    r.status = "recording"
    state = dict(m.state)
    state.update(
        status="recording",
        active_device_id=r.device_id,
        pending_device_id=None,
        message=None,
    )
    m.state = state
    m.status = "recording"
