import os, tempfile
from pathlib import Path
import pytest

_root = tempfile.TemporaryDirectory(prefix="huh-tests-")
os.environ["DATA_DIR"] = _root.name
os.environ["MODEL_CACHE_DIR"] = str(Path(_root.name) / "models")
os.environ["DATABASE_URL"] = "sqlite:///" + str(Path(_root.name) / "test.db")
os.environ["OAUTH_LISTENER_ENABLED"] = "false"
from app.db import Base, engine
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    with TestClient(app) as c:
        assert (
            c.post(
                "/api/auth/setup", json={"password": "correct horse battery staple"}
            ).status_code
            == 200
        )
        yield c
