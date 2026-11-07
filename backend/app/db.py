"""Shared durable schema. Transactions serialize writes with a singleton lock row."""

import os, time, uuid
from pathlib import Path
from contextlib import contextmanager
from sqlalchemy import (
    create_engine,
    String,
    Text,
    Integer,
    BigInteger,
    Float,
    Boolean,
    JSON,
    ForeignKey,
    select,
    text,
    inspect,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATA = Path(os.getenv("DATA_DIR", "/data"))
CACHE = Path(os.getenv("MODEL_CACHE_DIR", "/models"))
DATA.mkdir(parents=True, exist_ok=True)
url = os.getenv("DATABASE_URL", "sqlite:///" + str(DATA / "huh.db"))
engine = create_engine(
    url,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False, "timeout": 30}
    if url.startswith("sqlite")
    else {},
)
Session = sessionmaker(engine, expire_on_commit=False)


def uid():
    return str(uuid.uuid4())


def now():
    return time.time()


class Base(DeclarativeBase):
    pass


class KV(Base):
    __tablename__ = "kv"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)


class Meeting(Base):
    __tablename__ = "meetings"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    title: Mapped[str] = mapped_column(Text, default="Untitled meeting")
    notes: Mapped[str] = mapped_column(Text, default="")
    notes_revision: Mapped[int] = mapped_column(Integer, default=0)
    enhanced_notes: Mapped[str] = mapped_column(Text, default="")
    enhanced_revision: Mapped[int] = mapped_column(Integer, default=0)
    template_id: Mapped[str | None] = mapped_column(String, nullable=True)
    language: Mapped[str] = mapped_column(String, default="auto")
    folder_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    # Archived meetings are kept, but hidden from the main list and ranked last in search.
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_at: Mapped[float] = mapped_column(Float, default=now)
    updated_at: Mapped[float] = mapped_column(Float, default=now)
    status: Mapped[str] = mapped_column(String, default="idle")
    state: Mapped[dict] = mapped_column(
        JSON,
        default=lambda: dict(
            status="idle",
            active_device_id=None,
            pending_device_id=None,
            message=None,
            backup_order=[],
            auto_fallback=False,
        ),
    )


class Folder(Base):
    __tablename__ = "folders"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(Text)
    # Appearance only: a palette key and an icon key the client knows how to draw.
    color: Mapped[str | None] = mapped_column(String, nullable=True)
    icon: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now)


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    meeting_id: Mapped[str | None] = mapped_column(String, nullable=True)
    ready: Mapped[bool] = mapped_column(Boolean, default=False)
    backup_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[float] = mapped_column(Float, default=now)
    recording_id: Mapped[str | None] = mapped_column(String, nullable=True)
    capture_state: Mapped[str] = mapped_column(String, default="idle")


class Recording(Base):
    __tablename__ = "recordings"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meetings.id"), index=True)
    device_id: Mapped[str | None] = mapped_column(String, nullable=True)
    label: Mapped[str] = mapped_column(String)
    mime_type: Mapped[str] = mapped_column(String, default="audio/webm")
    status: Mapped[str] = mapped_column(String, default="starting")
    created_at: Mapped[float] = mapped_column(Float, default=now)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    token: Mapped[str] = mapped_column(Text)
    expected_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)
    mode: Mapped[str] = mapped_column(String, default="additional")


class Chunk(Base):
    __tablename__ = "chunks"
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id"), primary_key=True
    )
    index: Mapped[int] = mapped_column(Integer, primary_key=True)
    digest: Mapped[str] = mapped_column(String)
    size: Mapped[int] = mapped_column(Integer)


class Segment(Base):
    __tablename__ = "segments"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    recording_id: Mapped[str] = mapped_column(ForeignKey("recordings.id"), index=True)
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text)
    raw_text: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(String)


class Template(Base):
    __tablename__ = "templates"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String)
    instructions: Mapped[str] = mapped_column(Text)
    structure: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    # "ai": instructions for generated notes. "notes": an outline inserted into the user's own notes.
    kind: Mapped[str] = mapped_column(String, default="ai", server_default="ai")


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    meeting_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    lease: Mapped[float] = mapped_column(Float, default=0)
    claim: Mapped[str | None] = mapped_column(String, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available: Mapped[float] = mapped_column(Float, default=0)


class Generation(Base):
    __tablename__ = "generations"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    meeting_id: Mapped[str] = mapped_column(String, index=True)
    job_id: Mapped[str] = mapped_column(String, unique=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[float] = mapped_column(Float, default=now)
    provider: Mapped[str] = mapped_column(String)
    model: Mapped[str] = mapped_column(String)
    template_name: Mapped[str] = mapped_column(String)
    notes_revision: Mapped[int] = mapped_column(Integer)


def init():
    with engine.begin() as c:
        # API and worker may start together on a fresh database.
        if engine.dialect.name == "postgresql":
            c.execute(text("SELECT pg_advisory_xact_lock(825712943)"))
        else:
            c.execute(text("BEGIN IMMEDIATE"))
        Base.metadata.create_all(c)
        # Additive migration for installations created before template kinds existed.
        columns = {col["name"] for col in inspect(c).get_columns("templates")}
        if "kind" not in columns:
            c.execute(
                text("ALTER TABLE templates ADD COLUMN kind VARCHAR NOT NULL DEFAULT 'ai'")
            )
        # Additive migration for installations created before folders and the archive existed.
        columns = {col["name"] for col in inspect(c).get_columns("meetings")}
        if "folder_id" not in columns:
            c.execute(text("ALTER TABLE meetings ADD COLUMN folder_id VARCHAR"))
            c.execute(text("CREATE INDEX IF NOT EXISTS ix_meetings_folder_id ON meetings (folder_id)"))
        if "archived" not in columns:
            c.execute(text("ALTER TABLE meetings ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false"))
        folder_columns = {col["name"] for col in inspect(c).get_columns("folders")}
        for col in ("color", "icon"):
            if col not in folder_columns:
                c.execute(text(f"ALTER TABLE folders ADD COLUMN {col} VARCHAR"))
        if engine.dialect.name == "postgresql":
            c.execute(
                text(
                    "INSERT INTO kv (key,value) VALUES ('lock','{}') ON CONFLICT DO NOTHING"
                )
            )
        else:
            c.execute(text("INSERT OR IGNORE INTO kv (key,value) VALUES ('lock','{}')"))


@contextmanager
def tx():
    with Session() as s:
        try:
            if engine.dialect.name == "sqlite":
                s.execute(text("BEGIN IMMEDIATE"))
            else:
                s.execute(select(KV).where(KV.key == "lock").with_for_update())
            yield s
            s.commit()
        except BaseException:
            s.rollback()
            raise


def getkv(s, key, default=None):
    row = s.get(KV, key)
    return row.value if row else (default or {})


def putkv(s, key, value):
    row = s.get(KV, key)
    if row:
        row.value = value
    else:
        s.add(KV(key=key, value=value))
