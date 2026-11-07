"""Huh's single-owner Sign in with ChatGPT registration (OAuth PKCE).
OAuth data lives encrypted in the shared database.
"""

import asyncio, base64, hashlib, secrets, os, time
from urllib.parse import urlencode, urlsplit, parse_qs
import httpx, jwt
from .db import tx, getkv, putkv, uid
from .security import encrypt, decrypt

ISSUER = "https://auth.openai.com"
TOKEN = ISSUER + "/api/accounts/oauth/token"
RESOURCE = "https://api.openai.com/v1"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REDIRECT = (
    f"http://127.0.0.1:{os.getenv('CHATGPT_CALLBACK_PORT', '1457')}/auth/callback"
)


class OAuthError(RuntimeError):
    pass


def load(s):
    value = getkv(s, "oauth").get("encrypted")
    return decrypt(value) if value else {}


def save(s, value):
    putkv(s, "oauth", {"encrypted": encrypt(value)})


def status():
    with tx() as s:
        v = load(s)
    return dict(
        signed_in=bool(v.get("refresh_token")),
        plan_enabled=bool(
            v.get("refresh_token")
            and "chatgpt.tokens.use.direct" in v.get("scope", "").split()
        ),
        email=v.get("email"),
        pending=bool(v.get("pending") and v["pending"]["time"] > time.time() - 900),
        usage_url="https://chatgpt.com/settings/usage",
        last_error=v.get("last_error"),
    )


def begin():
    with tx() as s:
        v = load(s)
        v.setdefault("host_id", "urn:uuid:" + uid())
        verifier = secrets.token_urlsafe(64)
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        client = v.get("client_id", "dynamic_agent_client")
        v.pop("exchange_id", None)
        v["pending"] = dict(
            verifier=verifier,
            state=state,
            nonce=nonce,
            time=time.time(),
            client=client,
            redirect=REDIRECT,
        )
        save(s, v)
        params = dict(
            client_id=client,
            ext_agent_host_id=v["host_id"],
            response_type="code",
            redirect_uri=REDIRECT,
            scope=SCOPE,
            resource=RESOURCE,
            state=state,
            nonce=nonce,
            code_challenge_method="S256",
            code_challenge=base64.urlsafe_b64encode(
                hashlib.sha256(verifier.encode()).digest()
            )
            .rstrip(b"=")
            .decode(),
        )
        if client == "dynamic_agent_client":
            params["agent_name_hint"] = "Huh"
        elif v.get("id_token"):
            params["id_token_hint"] = v["id_token"]
        return ISSUER + "/api/accounts/authorize?" + urlencode(params)


def verify(token, client, nonce=None):
    try:
        # Discover published JWKS; constrain discovery to trusted issuer and HTTPS host.
        discovery = httpx.get(ISSUER + "/.well-known/openid-configuration", timeout=20)
        discovery.raise_for_status()
        uri = discovery.json()["jwks_uri"]
        if (
            urlsplit(uri).scheme != "https"
            or urlsplit(uri).hostname != "auth.openai.com"
        ):
            raise ValueError()
        key = jwt.PyJWKClient(uri).get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            issuer=ISSUER,
            audience=client,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
        if nonce is not None and claims.get("nonce") != nonce:
            raise ValueError()
        if (
            isinstance(claims["aud"], list)
            and len(claims["aud"]) > 1
            and claims.get("azp") != client
        ):
            raise ValueError()
        return claims
    except Exception:
        raise OAuthError("ID token signature or identity validation failed") from None


def token_request(data):
    try:
        response = httpx.post(TOKEN, data=data, timeout=30)
        if response.status_code != 200:
            raise OAuthError(
                f"ChatGPT token request failed (HTTP {response.status_code}); sign in again if expired"
            )
        return response.json()
    except httpx.HTTPError:
        raise OAuthError("Could not reach ChatGPT token endpoint") from None


def store_tokens(v, b, claims=None):
    if not b.get("access_token") or not b.get("refresh_token"):
        raise OAuthError("Incomplete OAuth token response")
    v.update(
        {
            k: b[k]
            for k in ["access_token", "refresh_token", "id_token", "scope"]
            if k in b
        }
    )
    v["expires_at"] = time.time() + int(b.get("expires_in", 3600))
    v.pop("last_error", None)
    if claims:
        v.update(sub=claims["sub"], email=claims.get("email"))


def complete(url):
    parts = urlsplit(url)
    if parts.scheme + "://" + parts.netloc + parts.path != REDIRECT or parts.fragment:
        raise OAuthError(
            "Paste the exact full loopback callback URL, including its original port"
        )
    query = parse_qs(parts.query, keep_blank_values=True)
    if any(len(v) != 1 for v in query.values()):
        raise OAuthError("Duplicate callback parameters")
    p = {k: v[0] for k, v in query.items()}
    with tx() as s:
        v = load(s)
        pending = v.get("pending")
        if (
            not pending
            or time.time() - pending["time"] > 900
            or not secrets.compare_digest(p.get("state", ""), pending["state"])
        ):
            raise OAuthError("Unknown or expired sign-in attempt")
        v.pop("pending")
        v["exchange_id"] = pending["state"]
        save(s, v)
    # One-use state committed before any network operation.
    if p.get("error"):
        raise OAuthError("ChatGPT authorization was declined or failed")
    client = p.get("client_id", pending["client"])
    if client == "dynamic_agent_client" or (
        pending["client"] != "dynamic_agent_client" and client != pending["client"]
    ):
        raise OAuthError("Invalid returned registration")
    if not p.get("code"):
        raise OAuthError("Missing authorization code")
    body = token_request(
        dict(
            grant_type="authorization_code",
            client_id=client,
            code=p["code"],
            code_verifier=pending["verifier"],
            redirect_uri=pending["redirect"],
            resource=RESOURCE,
        )
    )
    claims = verify(body.get("id_token", ""), client, pending["nonce"])
    with tx() as s:
        current = load(s)
        if current.get("exchange_id") != pending["state"]:
            raise OAuthError("This sign-in was cancelled or superseded")
        current.pop("exchange_id", None)
        if current.get("sub") and current["sub"] != claims["sub"]:
            raise OAuthError(
                "Returned account does not match the selected account; sign out first"
            )
        current["client_id"] = client
        store_tokens(current, body, claims)
        save(s, current)
    return status()


def access_token():
    # Shared transaction lock prevents refresh-token reuse across API and worker.
    with tx() as s:
        v = load(s)
        if not v.get("refresh_token"):
            raise OAuthError("Sign in with ChatGPT in Settings first")
        if "chatgpt.tokens.use.direct" not in v.get("scope", "").split():
            raise OAuthError("ChatGPT plan usage was not authorized")
        if v.get("expires_at", 0) < time.time() + 300:
            b = token_request(
                dict(
                    grant_type="refresh_token",
                    client_id=v["client_id"],
                    refresh_token=v["refresh_token"],
                    resource=RESOURCE,
                )
            )
            claims = (
                verify(b["id_token"], v["client_id"]) if b.get("id_token") else None
            )
            if claims and claims["sub"] != v.get("sub"):
                raise OAuthError("Refreshed identity mismatch")
            store_tokens(v, b, claims)
            save(s, v)
        return v["access_token"]


def signout():
    with tx() as s:
        v = load(s)
        save(s, {"host_id": v.get("host_id", "urn:uuid:" + uid())})
    revoked = False
    if v.get("refresh_token"):
        try:
            revoked = httpx.post(
                ISSUER + "/api/accounts/oauth/revoke",
                data={
                    "token": v["refresh_token"],
                    "token_type_hint": "refresh_token",
                    "client_id": v["client_id"],
                },
                timeout=15,
            ).is_success
        except httpx.HTTPError:
            pass
    return status() | {"revoked": revoked}


async def listener():
    async def handle(reader, writer):
        code = 400
        message = "Invalid callback"
        try:
            line = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            method, target, _ = line.split(b"\r\n", 1)[0].decode().split(" ", 2)
            if method == "GET" and urlsplit(target).path == "/auth/callback":
                await asyncio.to_thread(
                    complete, REDIRECT + "?" + urlsplit(target).query
                )
                code = 200
                message = "Huh connected. You can close this tab."
        except Exception:
            message = "Sign-in failed. Return to Huh and start a new attempt."
        body = message.encode()
        writer.write(
            f"HTTP/1.1 {code} Result\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    return await asyncio.start_server(
        handle,
        os.getenv("CHATGPT_CALLBACK_BIND", "127.0.0.1"),
        int(os.getenv("CHATGPT_CALLBACK_PORT", "1457")),
        limit=16384,
    )
