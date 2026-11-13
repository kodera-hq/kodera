"""Bounded, authenticated pure-state transformation; no database lock crosses a callback."""

import base64
import hmac
import http.client
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from django.conf import settings

from .errors import RefusalError
from .tickets import key

MAX_STATE = 2 * 1024 * 1024
MAX_RPC = 8 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class State:
    snapshot: bytes
    update: bytes
    markdown: str
    links: tuple[str, ...]


def binary(value: Any) -> bytes:
    if not isinstance(value, str) or len(value) > MAX_STATE * 4 // 3 + 4:
        raise ValueError
    decoded = base64.b64decode(value, validate=True)
    if len(decoded) > MAX_STATE or base64.b64encode(decoded).decode() != value:
        raise ValueError
    return decoded


def transform(
    *,
    snapshot: bytes = b"",
    updates: list[bytes] | None = None,
    markdown: str | None = None,
    update: bytes | None = None,
) -> State:
    value = getattr(settings, "KODERA_COLLAB_ENGINE_URL", None)
    if not isinstance(value, str):
        raise RefusalError(503, "service-unavailable")
    connection = None
    response = None
    try:
        endpoint = urlsplit(value)
        if (
            endpoint.scheme != "http"
            or not endpoint.hostname
            or endpoint.username
            or endpoint.password
            or endpoint.path != "/internal/transform"
            or endpoint.query
            or endpoint.fragment
            or not endpoint.port
        ):
            raise ValueError
        shared_key = key()
        request: dict[str, Any] = {
            "operation": "replace"
            if markdown is not None
            else "apply"
            if update is not None
            else "inspect",
            "snapshot": base64.b64encode(snapshot).decode(),
            "updates": [base64.b64encode(part).decode() for part in (updates or [])],
            "nonce": str(uuid4()),
        }
        if markdown is not None:
            request["markdown"] = markdown
        if update is not None:
            request["update"] = base64.b64encode(update).decode()
        body = json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode()
        if len(body) > MAX_RPC:
            raise ValueError
        timestamp = str(int(time.time()))
        signature = hmac.digest(
            shared_key, b"kodera-transform:v1\n" + timestamp.encode() + b"\n" + body, "sha256"
        ).hex()
        connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=5)
        connection.request(
            "POST",
            endpoint.path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "X-Kodera-Time": timestamp,
                "Authorization": "KoderaTransform " + signature,
                "Connection": "close",
            },
        )
        response = connection.getresponse()
        raw = response.read(MAX_RPC + 1)
        if len(raw) > MAX_RPC:
            raise ValueError
        expected = hmac.digest(
            shared_key,
            b"kodera-transform-response:v1\n" + signature.encode() + b"\n" + raw,
            "sha256",
        ).hex()
        if not hmac.compare_digest(response.getheader("X-Kodera-Mac", ""), expected):
            raise ValueError
        if response.status == 422:
            raise RefusalError(422)
        if response.status != 200:
            raise ValueError
        result = json.loads(raw)
        if not isinstance(result, dict) or set(result) != {
            "snapshot",
            "update",
            "markdown",
            "links",
        }:
            raise ValueError
        text, links = result["markdown"], result["links"]
        if (
            not isinstance(text, str)
            or len(text) > 262144
            or not isinstance(links, list)
            or len(links) > 5000
            or not all(isinstance(link, str) and 1 <= len(link) <= 255 for link in links)
            or len(set(links)) != len(links)
        ):
            raise ValueError
        return State(binary(result["snapshot"]), binary(result["update"]), text, tuple(links))
    except RefusalError:
        raise
    except (ValueError, TypeError, KeyError, OSError, http.client.HTTPException):
        raise RefusalError(503, "service-unavailable") from None
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()
