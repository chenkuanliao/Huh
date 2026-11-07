"""Provider-specific wire formats. Falling back to another provider happens only through the
owner's explicit AI order (Settings.ai_order); never to a provider they did not list."""

import json, re
from urllib.parse import quote, urlsplit
import httpx
from .db import tx, getkv
from .security import decrypt
from . import oauth

BASES = {
    "openai": "https://api.openai.com/v1",
    "chatgpt": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "openrouter": "https://openrouter.ai/api/v1",
    "opencode": "https://opencode.ai/zen/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
}


class ProviderError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def order(settings):
    """The owner's ranked [{provider, model}] list; older settings without one use provider/model."""
    entries = settings.get("ai_order")
    if entries:
        return [{"provider": e["provider"], "model": e.get("model", "")} for e in entries]
    return [{"provider": settings.get("provider", "chatgpt"), "model": settings.get("model", "")}]


def failure(exc):
    """Why a model could not be used, as (kind, short reason). kind "skipped" means it was never
    usable (not connected, no model) and is passed over quietly; anything else is announced."""
    text = str(exc)
    status = getattr(exc, "status", None)
    low = text.lower()
    if (
        "configure an api key" in low
        or "sign in with chatgpt" in low
        or "plan usage was not authorized" in low
        or "valid provider base url" in low
    ):
        return "skipped", "not connected"
    if "select a model" in low:
        return "skipped", "no model chosen"
    if status == 429 or any(w in low for w in ("quota", "usage limit", "rate limit", "insufficient", "credit", "billing")):
        return "usage", "is out of usage or rate-limited"
    if status in (401, 403):
        return "auth", "rejected the sign-in or API key"
    if status == 404:
        return "other", "model not found"
    return "other", "failed"


def config(settings):
    p = settings["provider"]
    base = BASES.get(p)
    if p == "custom":
        base = settings.get("base_url", "").rstrip("/")
    if (
        not base
        or urlsplit(base).scheme not in ["http", "https"]
        or urlsplit(base).username
        or urlsplit(base).password
    ):
        raise ProviderError("Configure a valid provider base URL")
    if p == "chatgpt":
        key = oauth.access_token()
    else:
        with tx() as s:
            encrypted = getkv(s, "keys").get(p)
        key = decrypt(encrypted) if encrypted else ""
        if not key and p != "custom":
            raise ProviderError("Configure an API key for " + p)
    headers = {"Authorization": "Bearer " + key} if key else {}
    if p == "anthropic":
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    if p == "google":
        headers = {"x-goog-api-key": key}
    if p == "openrouter":
        headers.update({"HTTP-Referer": "http://localhost", "X-Title": "Huh"})
    return p, base, headers


def describe(response):
    """Readable failure including the provider's own error code/message, with key-like strings redacted."""
    detail = ""
    try:
        response.read()
        body = response.json()
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(body, list) and body and isinstance(body[0], dict):
            error = body[0].get("error")
        if isinstance(error, dict):
            code = error.get("code") or error.get("type") or error.get("status")
            message = error.get("message") or ""
            detail = ": ".join(str(x) for x in [code, message] if x)
        elif isinstance(error, str):
            detail = error
        elif isinstance(body, dict) and isinstance(body.get("detail"), str):
            detail = body["detail"]
    except Exception:
        pass
    detail = re.sub(r"(sk|nvapi|AIza|sk-ant|sk-or)[-_A-Za-z0-9*]{6,}", "[redacted]", detail)[:300]
    hint = {
        401: "check the API key or sign in again",
        403: "access denied for this account or model",
        404: "the model or endpoint was not found",
        429: "rate or usage limit reached",
    }.get(response.status_code, "check the model and account")
    return f"Provider request failed (HTTP {response.status_code}{' — ' + detail if detail else ''}); {hint}"


def checked(response):
    if not response.is_success:
        raise ProviderError(describe(response), response.status_code)
    return response.json()


def models(settings):
    p, base, h = config(settings)
    try:
        with httpx.Client(timeout=30) as c:
            data = checked(c.get(base + "/models", headers=h))
    except httpx.HTTPError:
        raise ProviderError("Provider connection failed") from None
    if p == "chatgpt":
        return [
            {"id": m["slug"], "name": m.get("display_name", m["slug"])}
            for m in data.get("models", [])
            if m.get("visibility") == "list"
        ]
    if p == "google":
        return [
            {
                "id": m["name"].removeprefix("models/"),
                "name": m.get("displayName", m["name"]),
            }
            for m in data.get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])
        ]
    return [
        {"id": m["id"], "name": m.get("name") or m.get("display_name") or m["id"]}
        for m in data.get("data", [])
    ]


def infer(settings, system, prompt):
    p, base, h = config(settings)
    model = settings.get("model")
    if not model:
        raise ProviderError("Select a model in Settings first")
    try:
        with httpx.Client(timeout=httpx.Timeout(180, connect=20)) as c:
            if p in ["chatgpt", "openai"]:
                body = {
                    "model": model,
                    "instructions": system,
                    # Structured message input, as accepted by plan-funded ChatGPT access.
                    "input": [
                        {
                            "role": "user",
                            "content": [{"type": "input_text", "text": prompt}],
                        }
                    ],
                    "store": False,
                    "stream": True,
                }
                output = []
                complete = False
                with c.stream("POST", base + "/responses", headers=h, json=body) as r:
                    if not r.is_success:
                        raise ProviderError(describe(r), r.status_code)
                    for line in r.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            continue
                        event = json.loads(raw)
                        typ = event.get("type")
                        if typ == "response.output_text.delta":
                            output.append(event.get("delta", ""))
                        elif typ == "response.completed":
                            complete = True
                        elif typ in ["response.failed", "response.incomplete", "error"]:
                            err = event.get("error") or (event.get("response") or {}).get("error") or {}
                            reason = (event.get("response") or {}).get("incomplete_details") or {}
                            why = err.get("message") or err.get("code") or reason.get("reason") or ""
                            raise ProviderError(
                                "Provider response failed or was incomplete"
                                + (f" — {str(why)[:200]}" if why else "")
                            )
                if not complete:
                    raise ProviderError("Provider stream ended before completion")
                text = "".join(output)
            elif p == "anthropic":
                b = checked(
                    c.post(
                        base + "/messages",
                        headers=h,
                        json={
                            "model": model,
                            "max_tokens": 4096,
                            "system": system,
                            "messages": [{"role": "user", "content": prompt}],
                        },
                    )
                )
                if b.get("stop_reason") == "max_tokens":
                    raise ProviderError("Provider output reached its token limit")
                text = "".join(
                    v.get("text", "")
                    for v in b.get("content", [])
                    if v.get("type") == "text"
                )
            elif p == "google":
                b = checked(
                    c.post(
                        base + "/models/" + quote(model, safe="") + ":generateContent",
                        headers=h,
                        json={
                            "systemInstruction": {"parts": [{"text": system}]},
                            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                            "generationConfig": {"maxOutputTokens": 4096},
                        },
                    )
                )
                candidates = b.get("candidates", [])
                if not candidates or candidates[0].get("finishReason") != "STOP":
                    raise ProviderError("Provider response was blocked or incomplete")
                text = "".join(
                    x.get("text", "")
                    for x in candidates[0].get("content", {}).get("parts", [])
                )
            else:
                b = checked(
                    c.post(
                        base + "/chat/completions",
                        headers=h,
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": system},
                                {"role": "user", "content": prompt},
                            ],
                            "max_tokens": 4096,
                        },
                    )
                )
                choice = b.get("choices", [{}])[0]
                if choice.get("finish_reason") != "stop":
                    raise ProviderError("Provider response was incomplete")
                text = choice.get("message", {}).get("content", "")
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise ProviderError("Provider transport or response format error") from None
    if not isinstance(text, str) or not text.strip():
        raise ProviderError("Provider returned no text")
    return text
