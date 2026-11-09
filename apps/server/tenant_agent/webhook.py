"""LiveKit's webhook, on the VM's internal network only: every `participant_joined` runs the roster
guard on that room, so a stale grant is removed as soon as it is used.

LiveKit signs each delivery with a JWT (HS256, the VM's API key and secret) whose `sha256` claim is
the base64 SHA-256 of the body. A delivery that does not verify is refused and changes nothing.
Bodies are bounded before they are read, and at most two guard runs proceed at once: a burst of
joins queues rather than starting one engine call each.
"""

import base64
import hashlib
import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt

from .docker_exec import ExecError
from .engines import EngineError
from .guard import RosterGuard

log = logging.getLogger("tenant_agent.webhook")
_MAX_BODY = 64 * 1024
_RUNS = threading.BoundedSemaphore(2)


def verify(body: bytes, authorization: str, key: str, secret: str) -> bool:
    token = authorization.removeprefix("Bearer ").strip()
    try:
        claims = jwt.decode(
            token, secret, algorithms=["HS256"], issuer=key, options={"require": ["exp", "iss"]}
        )
    except jwt.PyJWTError:
        return False
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    return hmac.compare_digest(str(claims.get("sha256", "")), digest)


def make_server(
    bind: str, port: int, guard: RosterGuard, key: str, secret: str
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def _answer(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802 - the http.server hook name
            if self.headers.get("Transfer-Encoding"):
                return self._answer(411)
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._answer(411)
            if not 0 < length <= _MAX_BODY:
                return self._answer(413)
            body = self.rfile.read(length)
            if not verify(body, self.headers.get("Authorization", ""), key, secret):
                return self._answer(401)
            try:
                event = json.loads(body)
            except ValueError:
                return self._answer(400)
            room = ""
            if isinstance(event, dict) and event.get("event") == "participant_joined":
                room = str((event.get("room") or {}).get("name", ""))
            if room:
                with _RUNS:
                    try:
                        report = guard.enforce(room)
                    except (EngineError, ExecError):
                        log.exception("roster guard failed on %s", room)
                        return self._answer(503)  # LiveKit retries; the sweep does too
                if report.removed:
                    log.info("roster guard removed %s from %s", len(report.removed), room)
                if report.failed_rooms:
                    return self._answer(503)
            return self._answer(200)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - base signature
            return

    return ThreadingHTTPServer((bind, port), Handler)
