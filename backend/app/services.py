"""Transactional recording authority and job scheduling. Call inside db.tx()."""

import secrets
from datetime import datetime, timezone
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
    provider_models={},
    notes_view="write",
    ai_notes_view="preview",
    # What Back does: "up" goes to the parent page (meeting → its folder → Home); "history" retraces visited pages.
    back_behavior="up",
)
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
        Meeting: "id title notes notes_revision enhanced_notes enhanced_revision template_id language folder_id archived created_at updated_at status",
        Folder: "id name color icon created_at",
        Recording: "id meeting_id device_id label mime_type status created_at duration bytes chunk_count",
        Device: "id name meeting_id ready backup_enabled last_seen recording_id",
        Segment: "id recording_id start end text language",
        Template: "id name instructions structure is_default kind",
        Job: "id kind status progress error created_at",
        Generation: "id content created_at provider model template_name notes_revision",
    }[type(obj)].split()
    result = {key: getattr(obj, key) for key in fields}
    for key in ["created_at", "updated_at", "last_seen"]:
        if key in result:
            result[key] = iso(result[key])
    if isinstance(obj, Device):
        result["online"] = now() - obj.last_seen < 12
    return result


def settings(s):
    return DEFAULTS | getkv(s, "settings")


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


def transcribe(s, r):
    jobs = list(
        s.scalars(
            select(Job).where(
                Job.kind == "transcribe",
                Job.meeting_id == r.meeting_id,
                Job.status.in_(["queued", "running"]),
            )
        )
    )
    for j in jobs:
        if j.payload.get("recording_id") == r.id:
            return j
    r.status = "queued"
    return enqueue(s, "transcribe", r.meeting_id, {"recording_id": r.id})


def generate(s, m, template_id=None):
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
    payload = {
        "notes": m.notes,
        "notes_revision": m.notes_revision,
        "enhanced_revision": m.enhanced_revision,
        "settings": settings(s),
        "multi": len(order) > 1,
        "template_name": template.name if template else "Meeting notes",
        "instructions": template.instructions if template else "",
        "structure": template.structure if template else "",
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
        elif r.status == "ready" and r.device_id:
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
