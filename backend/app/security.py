import base64, hashlib, json, os, secrets
from cryptography.fernet import Fernet
from .db import DATA


def secret_key():
    value = os.getenv("SECRET_KEY")
    if value:
        return value.encode()
    path = DATA / "secret.key"
    temporary = DATA / ("secret." + secrets.token_hex(12) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(secrets.token_bytes(48))
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        temporary.unlink(missing_ok=True)
    return path.read_bytes()


cipher = Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret_key()).digest()))


def encrypt(value):
    return cipher.encrypt(json.dumps(value).encode()).decode()


def decrypt(value):
    return json.loads(cipher.decrypt(value.encode()))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()
