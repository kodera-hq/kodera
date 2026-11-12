"""room-access's two listeners.

- **Token** (`POST /token`), behind the tenant's edge: the browser's one call, with the member's
  own Matrix token. CORS answers only the configured Console origins. Bodies are bounded.
- **Webhook** (`POST /livekit/webhook`), on the VM's internal network only: LiveKit's signed
  deliveries, which trigger the guard and an occupancy refresh for that room.

Token issuance is rate limited per identity (`GrantLimiter`): one Matrix user's requests per
rolling minute, and before that one presented credential's, so that neither a member nor a looping
client can drive Synapse and LiveKit at will. Past the limit the answer is `429` with
`Retry-After`, and no upstream is called.

Each listener serves at most a fixed number of connections at once and refuses the next one
outright. A connection that goes silent, or does not deliver its body within the read deadline,
is cut off, so a slow client holds a slot for seconds and cannot exhaust the pool.
"""

import hashlib
import json
import logging
import math
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .clients import LiveKit, UpstreamError
from .service import RateLimitedError, RefusedError, Service

log = logging.getLogger("room_access.server")
MAX_TOKEN_BODY = 4 * 1024
MAX_WEBHOOK_BODY = 64 * 1024
MAX_HEADER_LINE = 8 * 1024
MAX_HEADER_BYTES = 16 * 1024
MAX_HEADERS = 32
_REFRESHES = threading.BoundedSemaphore(4)  # a burst of joins queues rather than fanning out
# A connection silent this long is cut off, and headers and body each have a whole-phase deadline.
READ_TIMEOUT_S = 10.0
# Connections each listener serves at once; the next one is closed unanswered.
TOKEN_WORKERS = 64
WEBHOOK_WORKERS = 16


# One identity's token requests per rolling minute, unless ROOM_ACCESS_GRANTS_PER_MINUTE says
# otherwise: a call needs one token per device and a refresh every ten minutes.
GRANTS_PER_MINUTE = 30
GRANT_WINDOW_S = 60.0
GRANT_KEYS = 20_000


class GrantLimiter:
    """A rolling minute of admitted token requests per key, in this process: room-access is one
    process per tenant VM, so the count is the tenant's.

    Two keys are charged for one request: the credential it presents, before anything is asked of
    Synapse, and the Matrix user that credential resolves to, before anything is asked of LiveKit.
    Neither is something a caller can choose at will: the first is the secret itself, kept as a
    digest, and the second is what Synapse says the secret is. A refused request records nothing,
    so hammering a full bucket does not extend the wait. Memory is bounded: past `max_keys` the
    idle buckets go first, then the least recently used."""

    def __init__(
        self,
        limit: int = GRANTS_PER_MINUTE,
        *,
        window_s: float = GRANT_WINDOW_S,
        max_keys: int = GRANT_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit < 1:
            raise ValueError("the grant limit is at least one per minute")
        self.limit = limit
        self._window_s = window_s
        self._max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def wait(self, key: str) -> int | None:
        """None when the request is admitted (and recorded); else the seconds to wait."""
        with self._lock:
            now = self._clock()
            horizon = now - self._window_s
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = self._buckets[key] = deque()
                self._bound(horizon)
            else:
                self._buckets.move_to_end(key)
            while bucket and bucket[0] <= horizon:
                bucket.popleft()
            if len(bucket) >= self.limit:
                oldest = bucket[len(bucket) - self.limit]
                return max(1, math.ceil(oldest + self._window_s - now))
            bucket.append(now)
            return None

    def credential(self, matrix_token: str) -> int | None:
        return self.wait("credential:" + hashlib.sha256(matrix_token.encode()).hexdigest())

    def identity(self, user_id: str) -> int | None:
        return self.wait("identity:" + user_id)

    def _bound(self, horizon: float) -> None:
        if len(self._buckets) <= self._max_keys:
            return
        for idle in [key for key, kept in self._buckets.items() if not kept or kept[-1] <= horizon]:
            del self._buckets[idle]
        while len(self._buckets) > self._max_keys:
            self._buckets.popitem(last=False)


class _BoundedHeaderStream:
    """Wraps `rfile` so the entire request line + headers must arrive within `deadline_s`
    and within fixed line/count/byte bounds, defeating byte-drip slowloris before `do_POST`."""

    def __init__(self, raw: Any, connection: Any, deadline_s: float) -> None:
        self._raw = raw
        self._conn = connection
        self._deadline = time.monotonic() + deadline_s
        self._buf = bytearray()
        self._header_bytes = 0
        self._lines = 0

    def readline(self, size: int = -1) -> bytes:
        limit = MAX_HEADER_LINE if size < 0 else min(size, MAX_HEADER_LINE + 1)
        while b"\n" not in self._buf and len(self._buf) < limit:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("header read deadline exceeded")
            self._conn.settimeout(remaining)
            chunk = self._raw.read1(4096)
            if not chunk:
                break
            self._buf += chunk
        nl = self._buf.find(b"\n")
        end = len(self._buf) if nl < 0 else min(nl + 1, limit)
        if size >= 0:
            end = min(end, size)
        line = bytes(self._buf[:end])
        del self._buf[:end]
        self._lines += 1
        self._header_bytes += len(line)
        if (
            len(line) > MAX_HEADER_LINE
            or (nl < 0 and line and len(line) >= MAX_HEADER_LINE)
            or self._lines > MAX_HEADERS + 2
            or self._header_bytes > MAX_HEADER_BYTES
        ):
            raise TimeoutError("header bounds exceeded")
        return line

    def read1(self, size: int = -1) -> bytes:
        if self._buf:
            take = len(self._buf) if size < 0 else min(size, len(self._buf))
            out = bytes(self._buf[:take])
            del self._buf[:take]
            return out
        return self._raw.read1(size)

    def close(self) -> None:
        self._raw.close()


class _BoundedServer(ThreadingHTTPServer):
    """A thread per connection, never more than `workers` at once."""

    def __init__(
        self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], workers: int
    ) -> None:
        self._slots = threading.BoundedSemaphore(workers)
        super().__init__(address, handler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def _read(handler: BaseHTTPRequestHandler, limit: int, deadline_s: float) -> bytes | int:
    """The body, or the status that refuses it. A body that does not arrive whole before the
    deadline is refused (408) however slowly it trickles in."""
    if handler.headers.get("Transfer-Encoding"):
        return 411
    try:
        length = int(handler.headers.get("Content-Length", ""))
    except ValueError:
        return 411
    if not 0 < length <= limit:
        return 413
    deadline = time.monotonic() + deadline_s
    body = bytearray()
    try:
        while len(body) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            handler.connection.settimeout(remaining)
            chunk = handler.rfile.read1(length - len(body))
            if not chunk:
                handler.close_connection = True
                return 400
            body += chunk
    except TimeoutError:
        handler.close_connection = True
        return 408
    return bytes(body)


def make_token_server(
    bind: str,
    port: int,
    service: Service,
    origins: frozenset[str],
    *,
    timeout_s: float = READ_TIMEOUT_S,
    workers: int = TOKEN_WORKERS,
    limiter: GrantLimiter | None = None,
) -> ThreadingHTTPServer:
    # Always limited: a caller that passes no limiter gets the default one, never none.
    grants = limiter if limiter is not None else GrantLimiter()

    def limited(user_id: str) -> None:
        wait = grants.identity(user_id)
        if wait is not None:
            raise RateLimitedError(wait)

    class Handler(BaseHTTPRequestHandler):
        timeout = timeout_s

        def setup(self) -> None:
            super().setup()
            self.rfile = _BoundedHeaderStream(self.rfile, self.connection, timeout_s)  # type: ignore[assignment]

        def _send(
            self,
            status: int,
            body: dict[str, Any] | None = None,
            *,
            retry_after_s: int | None = None,
        ) -> None:
            raw = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            origin = self.headers.get("Origin", "")
            # Exact match with a configured origin, or no CORS header at all: never `*`, never
            # the origin that was sent.
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Expose-Headers", "Retry-After")
            # Whatever the origin: the answer depends on it, so no cache may share it.
            self.send_header("Vary", "Origin")
            if retry_after_s is not None:
                self.send_header("Retry-After", str(retry_after_s))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self) -> None:  # noqa: N802 - the http.server hook name
            if self.path != "/token" or self.headers.get("Origin", "") not in origins:
                return self._send(403)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/token":
                return self._send(404)
            body = _read(self, MAX_TOKEN_BODY, timeout_s)
            if isinstance(body, int):
                return self._send(body)
            bearer = self.headers.get("Authorization", "")
            if not bearer.startswith("Bearer ") or len(bearer) > 2048:
                return self._send(401, {"error": "unauthenticated"})
            matrix_token = bearer[7:]
            if not matrix_token or any(
                c.isspace() or ord(c) < 0x21 or ord(c) > 0x7E for c in matrix_token
            ):
                return self._send(401, {"error": "unauthenticated"})
            # Before Synapse is asked who this is: one credential's requests per minute.
            wait = grants.credential(matrix_token)
            if wait is not None:
                return self._rate_limited(wait)
            try:
                request = json.loads(body)
                grant = service.grant(
                    matrix_token,
                    request.get("room_id") if isinstance(request, dict) else None,
                    admit=limited,
                )
            except ValueError:
                return self._send(400, {"error": "malformed"})
            except RateLimitedError as refused:
                return self._rate_limited(refused.retry_after_s)
            except RefusedError as refused:
                errors = {400: "malformed", 401: "unauthenticated", 403: "forbidden"}
                return self._send(refused.status, {"error": errors[refused.status]})
            except UpstreamError:
                log.warning("token refused: an upstream failed", exc_info=True)
                return self._send(503, {"error": "unavailable"})
            return self._send(
                200, {"url": grant.url, "token": grant.token, "listen_only": grant.listen_only}
            )

        def _rate_limited(self, wait: int) -> None:
            return self._send(
                429, {"error": "rate_limited", "retry_after_s": wait}, retry_after_s=wait
            )

        def do_GET(self) -> None:  # noqa: N802
            return self._send(200, {"status": "ok"}) if self.path == "/health" else self._send(404)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - base signature
            return

    return _BoundedServer((bind, port), Handler, workers)


def make_webhook_server(
    bind: str,
    port: int,
    livekit: LiveKit,
    on_event: Callable[[dict[str, Any]], None],
    *,
    timeout_s: float = READ_TIMEOUT_S,
    workers: int = WEBHOOK_WORKERS,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = timeout_s

        def setup(self) -> None:
            super().setup()
            self.rfile = _BoundedHeaderStream(self.rfile, self.connection, timeout_s)  # type: ignore[assignment]

        def _answer(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            body = _read(self, MAX_WEBHOOK_BODY, timeout_s)
            if isinstance(body, int):
                return self._answer(body)
            if not livekit.verify_webhook(body, self.headers.get("Authorization", "")):
                return self._answer(401)
            try:
                event = json.loads(body)
            except ValueError:
                return self._answer(400)
            if isinstance(event, dict):
                with _REFRESHES:
                    on_event(event)
            return self._answer(200)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    return _BoundedServer((bind, port), Handler, workers)
