"""Buffer small API bodies before Django, reserving half of each gthread worker.

Gunicorn 27 ignores the WSGI Connection response header. Its bound Response.force_close
is therefore required on refusals, so the parser never drains a rejected body on reuse.
A read-side socket shutdown enforces the absolute deadline even inside a trickling
Gunicorn read loop; socket timeouts alone bound only the gap between received bytes.
"""

from __future__ import annotations

import io
import json
import socket
import threading
import time
from typing import Any

from gunicorn.http.errors import ParseException

BODY_READ_SECONDS = 10.0
BODY_MAX_BYTES = 1048576
BODY_READ_SLOTS = 2  # config/gunicorn.py: four request threads per worker


class BodyGuard:
    def __init__(self, application: Any) -> None:
        self.application = application
        self.slots = threading.BoundedSemaphore(BODY_READ_SLOTS)

    @staticmethod
    def _refuse(environ: Any, start_response: Any, status: str, detail: str) -> list[bytes]:
        body = json.dumps({"detail": detail}, separators=(",", ":")).encode()
        headers = [("Content-Type", "application/json"), ("Content-Length", str(len(body)))]
        # WSGI forbids hop-by-hop headers on generic servers (including wsgiref).
        # Gunicorn discards Connection: close, but force_close drives should_close().
        if "gunicorn.socket" in environ:
            headers.append(("Connection", "close"))
            start_response.__self__.force_close()
            # Gunicorn 27 lingers in close_graceful on the worker's main poller thread.
            # End the read side now so rejected slow clients cannot stall that poller.
            try:
                environ["gunicorn.socket"].shutdown(socket.SHUT_RD)
            except OSError:
                pass
        if status.startswith("503"):
            headers.append(("Retry-After", "1"))
        start_response(status, headers)
        return [body]

    def __call__(self, environ: Any, start_response: Any) -> Any:
        raw_length = environ.get("CONTENT_LENGTH", "")
        length = None
        if raw_length:
            if raw_length.isascii() and raw_length.isdecimal():
                try:
                    length = int(raw_length)
                except ValueError:
                    length = -1
            else:
                length = -1
        transfer = "HTTP_TRANSFER_ENCODING" in environ
        carries_body = (
            transfer
            or length not in (None, 0)
            or (environ.get("REQUEST_METHOD") in {"POST", "PUT", "PATCH"} and length is None)
        )
        if not carries_body:
            return self.application(environ, start_response)
        if not self.slots.acquire(blocking=False):
            return self._refuse(
                environ,
                start_response,
                "503 Service Unavailable",
                "Request body reader capacity busy.",
            )
        try:
            if length == -1:
                return self._refuse(
                    environ, start_response, "400 Bad Request", "Invalid request body length."
                )
            if length is not None and length > BODY_MAX_BYTES:
                return self._refuse(
                    environ, start_response, "413 Payload Too Large", "Request body exceeds 1 MiB."
                )
            try:
                body = self._read(environ, None if transfer else length)
            except TimeoutError:
                return self._refuse(
                    environ,
                    start_response,
                    "408 Request Timeout",
                    "Request body read deadline exceeded.",
                )
            except OverflowError:
                return self._refuse(
                    environ, start_response, "413 Payload Too Large", "Request body exceeds 1 MiB."
                )
            except (OSError, ValueError, ParseException):
                return self._refuse(
                    environ,
                    start_response,
                    "400 Bad Request",
                    "Invalid or incomplete request body.",
                )
            environ["wsgi.input"] = io.BytesIO(body)
            environ["CONTENT_LENGTH"] = str(len(body))
            environ.pop("HTTP_TRANSFER_ENCODING", None)
        finally:
            self.slots.release()
        return self.application(environ, start_response)

    @staticmethod
    def _read(environ: Any, length: int | None) -> bytes:
        sock = environ.get("gunicorn.socket")
        previous_timeout = sock.gettimeout() if sock is not None else None
        expired = threading.Event()
        deadline = time.monotonic() + BODY_READ_SECONDS

        def expire() -> None:
            expired.set()
            try:
                sock.shutdown(socket.SHUT_RD)
            except OSError:
                pass

        timer = threading.Timer(BODY_READ_SECONDS, expire) if sock is not None else None
        if timer is not None:
            timer.daemon = True
            timer.start()
        try:
            body = bytearray()
            while length is None or len(body) < length:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or expired.is_set():
                    raise TimeoutError()
                if sock is not None:
                    sock.settimeout(remaining)
                size = min(65536, BODY_MAX_BYTES + 1 - len(body))
                if length is not None:
                    size = min(size, length - len(body))
                try:
                    chunk = environ["wsgi.input"].read(size)
                except (OSError, ParseException):
                    if time.monotonic() >= deadline or expired.is_set():
                        raise TimeoutError() from None
                    raise
                if time.monotonic() > deadline or expired.is_set():
                    raise TimeoutError()
                if not chunk:
                    if length is not None and len(body) != length:
                        raise ValueError("truncated body")
                    break
                body.extend(chunk)
                if len(body) > BODY_MAX_BYTES:
                    raise OverflowError()
            return bytes(body)
        finally:
            if timer is not None:
                timer.cancel()
                timer.join()
            if sock is not None:
                sock.settimeout(previous_timeout)
