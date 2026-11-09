"""The Keycloak admin calls of the realm access delivery: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.

`keycloak_admin(target, source=…, origins=…)` loads the realm's worker credential, asks the realm's
token endpoint for an access token with `client_credentials`, and yields a client that calls the
realm's Admin REST API with it, for one delivery only. Both origins are pinned by the worker's
settings (`KODERA_REALM_ISSUER_ORIGIN`, the public host that serves the token endpoint, and
`KODERA_REALM_ADMIN_ORIGIN`, the admin host: production's public host answers 403 on `/admin`);
nothing a delivery row carries chooses where the secret or the token is sent. Every failure is raised as a RealmCallError whose `kind`
says what the delivery does with it (§6.1.3):

- `transport`: the request positively never left: the connection was refused, the name did not
  resolve, connecting timed out, or the TLS handshake failed, all before `request()` wrote a byte;
- `credential`: the realm's credential is missing, unreadable or refused, a deployment fault;
- `temporary`: a 5xx or 429, or the connection lost or timed out once a request was sent, on a
  read: nothing was asked to change, so a retry is safe;
- `ambiguous`: the same on a write (`PUT`, `POST …/logout`, `DELETE …/consents/…`): Keycloak may
  have received it and may still be executing it, so its outcome is unknown and never retried;
- `permanent`: any other 4xx, or a redirect, which is never followed with a bearer token.

Nothing raised or logged here carries a token, a secret, a user representation or a response body:
an error carries its kind, the HTTP status and the class name of the underlying exception.
"""

from __future__ import annotations

import http.client
import io
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
import urllib.parse
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    from worker.credentials import ClientCredential, DirectoryCredentialSource

TIMEOUT_S = 10.0
# Keycloak's default and largest page of a user listing (UsersResource.getUsers, `max`).
LIST_PAGE = 100
MAX_BODY = 1024 * 1024
Kind = Literal["transport", "credential", "temporary", "ambiguous", "permanent"]


class RealmCallError(Exception):
    def __init__(self, kind: Kind, *, http_status: int | None = None, cause: str = "") -> None:
        super().__init__(f"{kind} http_status={http_status} {cause}".strip())
        self.kind: Kind = kind
        self.http_status = http_status


class RealmUserAbsentError(Exception):
    """The realm user does not exist (a 404 on a user path)."""


@dataclass(frozen=True)
class RealmTarget:
    """The realm a delivery acts in, named by Core's own identity and organisation rows."""

    realm: str


@dataclass(frozen=True)
class RealmOrigins:
    """The pinned origins: `issuer`, the public host serving `/realms/{realm}/…` and the token
    endpoint; `admin`, the host serving `/admin/realms/{realm}/…`."""

    issuer: str
    admin: str


class RealmAdmin(Protocol):
    """What the delivery calls, at the Keycloak boundary; the tests provide a fake."""

    def get_user(self, user_id: str) -> dict[str, Any] | None: ...
    def set_enabled(self, user_id: str, enabled: bool) -> None: ...
    def logout(self, user_id: str) -> None: ...
    def consents(self, user_id: str) -> list[dict[str, Any]]: ...
    def revoke_consent(self, user_id: str, client_id: str) -> None: ...
    def sessions(self, user_id: str) -> list[dict[str, Any]]: ...
    def count_users(self) -> int: ...
    def enabled_user_ids(self, *, deadline: float | None = None) -> set[str]: ...


class RealmAccountAdmin(Protocol):
    """What the realm account delivery calls (docs/specs/INVITATIONS.md §4)."""

    def users_by_email(self, email: str) -> list[dict[str, Any]]: ...
    def create_user(self, representation: dict[str, Any]) -> None: ...
    def logout(self, user_id: str) -> None: ...
    def execute_actions_email(
        self,
        user_id: str,
        actions: list[str],
        lifespan_s: int,
        *,
        client_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> None: ...


# A realm name as a URL path segment and a file name.
REALM_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_origin(value: str) -> str:
    """An origin setting, `https://host[:port][/prefix]`, or `http` on a loopback host only, with
    no user, query or fragment; returned without a trailing slash. Raises ValueError otherwise."""
    parts = urllib.parse.urlsplit(value.strip())
    host = parts.hostname or ""
    if (
        not host
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or (parts.scheme != "https" and not (parts.scheme == "http" and _loopback(host)))
    ):
        raise ValueError("a Keycloak origin is https, or http on a loopback host, without a user")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def _realm_segment(realm: str) -> str:
    if REALM_NAME.fullmatch(realm) is None:
        raise RealmCallError("permanent", cause="realm_name_refused")
    return realm


def realm_issuer(realm: str, origins: RealmOrigins) -> str:
    """The issuer a realm of this Keycloak has: what Core's identity rows must name."""
    return f"{origins.issuer}/realms/{_realm_segment(realm)}"


def realm_urls(realm: str, origins: RealmOrigins) -> tuple[str, str]:
    """The realm's token endpoint, on the public origin, and its admin base, on the admin origin."""
    segment = _realm_segment(realm)
    return (
        f"{origins.issuer}/realms/{segment}/protocol/openid-connect/token",
        f"{origins.admin}/admin/realms/{segment}",
    )


class _Connection(http.client.HTTPConnection):
    """An HTTP/1.1 connection that never opens itself implicitly (`auto_open` off) and refuses to
    reconnect once used: a request cut by its deadline can never be sent again on it."""

    def __init__(self, host: str, port: int | None, sock: Any = None, scheme: str = "http") -> None:
        # The scheme's own default port, so `Host` names a port only when it is not that default
        # (http.client's putrequest compares with default_port, 80 for a plain HTTPConnection).
        self.default_port = 443 if scheme == "https" else 80
        super().__init__(host, port)
        self.auto_open = 0
        self._used = sock is not None
        if sock is not None:
            self.sock = sock

    def connect(self) -> None:
        if self._used:
            raise OSError("refused to reconnect: a connection is used once")
        self._used = True
        super().connect()


class _DeadlineExpiredError(TimeoutError):
    """The call's absolute deadline passed."""


class _DeadlineSocket:
    """The connected socket, as http.client sees it: every send and every read first checks the
    absolute deadline and sets the socket's timeout to the time left, in the calling thread. So the
    deadline bounds the headers and a trickled body too, and nothing is written after it."""

    def __init__(self, sock: socket.socket, end: float) -> None:
        self._sock = sock
        self._end = end
        self.started_sending = False
        # As socket.socket does: closing waits for the readers made by makefile() to close, since
        # http.client closes its connection while the response is still being read.
        self._readers = 0
        self._closed = False

    def left(self) -> float:
        remaining = self._end - time.monotonic()
        if remaining <= 0:
            raise _DeadlineExpiredError("deadline")
        return remaining

    def sendall(self, data: bytes) -> None:
        remaining = self.left()  # checked immediately before any byte is written
        self.started_sending = True
        self._sock.settimeout(remaining)
        self._sock.sendall(data)

    def makefile(self, mode: str = "rb", *args: Any, **kwargs: Any) -> io.BufferedReader:
        self._readers += 1
        return io.BufferedReader(_DeadlineReader(self, self._sock))

    def reader_closed(self) -> None:
        self._readers -= 1
        if self._closed and self._readers <= 0:
            self._sock.close()

    def close(self) -> None:
        self._closed = True
        if self._readers <= 0:
            self._sock.close()


class _DeadlineReader(io.RawIOBase):
    def __init__(self, owner: _DeadlineSocket, sock: socket.socket) -> None:
        self._owner = owner
        self._sock = sock

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        self._sock.settimeout(self._owner.left())
        return self._sock.recv_into(buffer)

    def close(self) -> None:
        if not self.closed:
            self._owner.reader_closed()
        super().close()


def _resolve(host: str, port: int, remaining: float) -> list[Any]:
    """The DNS lookup, the one step run on a helper thread: it sends nothing to Keycloak, so a
    lookup abandoned at the deadline is harmless."""
    found: dict[str, Any] = {}

    def lookup() -> None:
        try:
            found["infos"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as error:
            found["error"] = error

    resolver = threading.Thread(target=lookup, daemon=True)
    resolver.start()
    resolver.join(remaining)
    if resolver.is_alive():
        raise _DeadlineExpiredError("dns")
    if "error" in found:
        raise found["error"]
    infos: list[Any] = found["infos"]
    return infos


def _open(url: str, end: float) -> tuple[_DeadlineSocket, str, str, int, str]:
    """Resolve, connect and, for https, complete the TLS handshake, all before the deadline and
    without sending a request byte. Raises OSError (a deadline included) when it cannot."""
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    target = parts.path + (f"?{parts.query}" if parts.query else "")

    def left() -> float:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise _DeadlineExpiredError("deadline")
        return remaining

    last: OSError = OSError("no address")
    sock: socket.socket | None = None
    for family, kind, proto, _, address in _resolve(host, port, left()):
        candidate = socket.socket(family, kind, proto)
        try:
            candidate.settimeout(left())
            candidate.connect(address)
        except OSError as error:
            candidate.close()
            last = error
            continue
        sock = candidate
        break
    if sock is None:
        raise last
    try:
        if parts.scheme == "https":
            sock.settimeout(left())
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        left()  # a connection ready only after the deadline sends nothing
    except BaseException:
        sock.close()
        raise
    return _DeadlineSocket(sock, end), target, host, port, parts.scheme


def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: bytes | None = None,
    deadline: float | None = None,
) -> tuple[int, bytes]:
    """One request, entirely in the calling thread, under one absolute deadline.

    The DNS lookup (on a helper thread, since it sends nothing), the connection and the TLS
    handshake come first, each bounded by the time left: any failure there, the deadline passing
    included, is `transport`, the request positively never left. The deadline is then checked
    immediately before the first byte is written; a request whose deadline has passed is never
    sent, and the connection refuses to reconnect, so no request outlives its call. Once a byte may
    have been written, any failure is `temporary`, which a write turns into `ambiguous`
    (HttpRealmAdmin._write). Every read checks the deadline too, so neither slow headers nor a
    body trickled one byte per socket timeout can hold the call past it. No redirect is followed:
    http.client never does, and a 3xx is answered as `permanent`."""
    end = time.monotonic() + TIMEOUT_S
    if deadline is not None:
        end = min(end, deadline)
    if end - time.monotonic() <= 0:
        raise RealmCallError("transport", cause="deadline_before_send")
    try:
        sock, target, host, port, scheme = _open(url, end)
    except (OSError, http.client.HTTPException) as error:
        raise RealmCallError("transport", cause=type(error).__name__) from None
    connection = _Connection(host, port, sock, scheme)
    response: http.client.HTTPResponse | None = None
    try:
        connection.request(method, target, body=body, headers=headers)
        response = connection.getresponse()
        chunks: list[bytes] = []
        size = 0
        while size < MAX_BODY:
            chunk = response.read1(MAX_BODY - size)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        # A body cut short, by the deadline or by the peer, is never returned.
        if response.length:
            raise http.client.IncompleteRead(b"".join(chunks), response.length)
        return int(response.status), b"".join(chunks)
    except (OSError, http.client.HTTPException) as error:
        kind: Kind = "temporary" if sock.started_sending else "transport"
        raise RealmCallError(kind, cause=type(error).__name__) from None
    finally:
        if response is not None:
            response.close()
        connection.close()
        sock.close()


def _classify(status: int) -> RealmCallError:
    if status in (401, 403):
        return RealmCallError("credential", http_status=status)
    if status == 429 or status >= 500:
        return RealmCallError("temporary", http_status=status)
    return RealmCallError("permanent", http_status=status)


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        raise RealmCallError("temporary", cause="unreadable_body") from None


def access_token(
    token_url: str, credential: ClientCredential, *, deadline: float | None = None
) -> str:
    """A `client_credentials` access token of the realm's worker client."""
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": credential.client_id,
            "client_secret": credential.secret,
        }
    ).encode()
    status, raw = _request(
        "POST",
        token_url,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        body=body,
        deadline=deadline,
    )
    if status in (400, 401):
        raise RealmCallError("credential", http_status=status)
    if status != 200:
        raise _classify(status)
    token = _json(raw).get("access_token") if raw else None
    if not isinstance(token, str) or not token:
        raise RealmCallError("credential", http_status=status, cause="no_access_token")
    return token


class HttpRealmAdmin:
    def __init__(self, admin_base: str, token: str) -> None:
        self._base = admin_base
        self._token = token

    def __repr__(self) -> str:
        return f"HttpRealmAdmin({self._base})"

    def _user(self, user_id: str, tail: str = "") -> str:
        return f"{self._base}/users/{urllib.parse.quote(user_id, safe='')}{tail}"

    def _call(
        self, method: str, url: str, payload: object = None, *, deadline: float | None = None
    ) -> tuple[int, bytes]:
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        return _request(method, url, headers=headers, body=body, deadline=deadline)

    def enabled_user_ids(self, *, deadline: float | None = None) -> set[str]:
        """Every enabled user of the realm, by id, in full pages of brief representations
        (`GET users?enabled=true&briefRepresentation=true`, UsersResource.getUsers in 26.0.7).
        A read: each page is bounded by `deadline` as well as its own timeout."""
        found: set[str] = set()
        first = 0
        while True:
            query = urllib.parse.urlencode(
                {"enabled": "true", "briefRepresentation": "true", "first": first, "max": LIST_PAGE}
            )
            status, raw = self._call("GET", f"{self._base}/users?{query}", deadline=deadline)
            if status != 200:
                raise _classify(status)
            page = _json(raw)
            if not isinstance(page, list) or not all(isinstance(user, dict) for user in page):
                raise RealmCallError("temporary", http_status=status, cause="unexpected_body")
            for user in page:
                if isinstance(user.get("id"), str):
                    found.add(user["id"])
            if len(page) < LIST_PAGE:
                return found
            first += LIST_PAGE

    def _expect(self, status: int, ok: tuple[int, ...]) -> None:
        if status == 404:
            raise RealmUserAbsentError()
        if status not in ok:
            raise _classify(status)

    def _write(self, method: str, url: str, payload: object = None) -> int:
        """A write: once it may have left, a failure is `ambiguous`, never `temporary`. Only a
        failure before anything was sent (refused, unresolved, TLS) stays `transport`."""
        try:
            status, _ = self._call(method, url, payload)
        except RealmCallError as error:
            if error.kind == "temporary":
                raise RealmCallError("ambiguous", cause=str(error)) from None
            raise
        if status >= 500:
            raise RealmCallError("ambiguous", http_status=status)
        return status

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        status, raw = self._call("GET", self._user(user_id))
        if status == 404:
            return None
        self._expect(status, (200,))
        found = _json(raw)
        if not isinstance(found, dict):
            raise RealmCallError("temporary", http_status=status, cause="unexpected_body")
        return found

    def set_enabled(self, user_id: str, enabled: bool) -> None:
        # Only the flag: Keycloak 26.0.7's updateUser keeps the user's attributes when the
        # representation carries none (UserResource.updateUser, `rep.getAttributes() == null`).
        status = self._write("PUT", self._user(user_id), {"enabled": enabled})
        self._expect(status, (200, 204))

    def count_users(self) -> int:
        """The positive control of an absent user: the realm's admin API answers."""
        status, raw = self._call("GET", f"{self._base}/users/count")
        if status != 200:
            raise _classify(status)
        found = _json(raw)
        if type(found) is not int:
            raise RealmCallError("temporary", http_status=status, cause="unexpected_body")
        return found

    def logout(self, user_id: str) -> None:
        status = self._write("POST", self._user(user_id, "/logout"))
        self._expect(status, (200, 204))

    def _list(self, url: str) -> list[dict[str, Any]]:
        status, raw = self._call("GET", url)
        self._expect(status, (200,))
        found = _json(raw)
        if not isinstance(found, list) or not all(isinstance(item, dict) for item in found):
            raise RealmCallError("temporary", http_status=status, cause="unexpected_body")
        return found

    def consents(self, user_id: str) -> list[dict[str, Any]]:
        return self._list(self._user(user_id, "/consents"))

    def revoke_consent(self, user_id: str, client_id: str) -> None:
        url = self._user(user_id, "/consents/" + urllib.parse.quote(client_id, safe=""))
        status = self._write("DELETE", url)
        # 404: "Consent nor offline token not found" (UserResource.revokeConsent), already revoked;
        # the read-back requires the consents list empty, so a 404 that hides a grant is caught.
        if status in (200, 204, 404):
            return
        raise _classify(status)

    def sessions(self, user_id: str) -> list[dict[str, Any]]:
        return self._list(self._user(user_id, "/sessions"))

    # ---- realm accounts (docs/specs/INVITATIONS.md §4) ----

    def users_by_email(self, email: str) -> list[dict[str, Any]]:
        """The users whose address is exactly `email` (`GET users?email=…&exact=true`)."""
        query = urllib.parse.urlencode(
            {"email": email, "exact": "true", "briefRepresentation": "false"}
        )
        status, raw = self._call("GET", f"{self._base}/users?{query}")
        if status != 200:
            raise _classify(status)
        found = _json(raw)
        if not isinstance(found, list) or not all(isinstance(user, dict) for user in found):
            raise RealmCallError("temporary", http_status=status, cause="unexpected_body")
        return found

    def create_user(self, representation: dict[str, Any]) -> None:
        """`POST users`. A `409` is a user that already holds the address or the username: the
        caller reads the address again, so a repeat of a create that landed converges."""
        status = self._write("POST", f"{self._base}/users", representation)
        if status in (201, 409):
            return
        raise _classify(status)

    def execute_actions_email(
        self,
        user_id: str,
        actions: list[str],
        lifespan_s: int,
        *,
        client_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> None:
        """Have the realm mail the user a link to complete `actions`
        (`PUT users/{id}/execute-actions-email`). Sent twice, the user gets two links. With a
        client and a redirect the client lists, Keycloak ends on a link back to it rather than on
        its own "account updated" page."""
        params: dict[str, str | int] = {"lifespan": lifespan_s}
        if client_id is not None and redirect_uri is not None:
            params |= {"client_id": client_id, "redirect_uri": redirect_uri}
        query = urllib.parse.urlencode(params)
        status = self._write(
            "PUT", self._user(user_id, f"/execute-actions-email?{query}"), list(actions)
        )
        self._expect(status, (200, 204))


@contextmanager
def keycloak_admin(
    target: RealmTarget,
    *,
    source: DirectoryCredentialSource,
    origins: RealmOrigins,
    deadline: float | None = None,
) -> Iterator[RealmAdmin]:
    """An admin client of the target realm for one delivery, its credential and token dropped
    when the delivery ends."""
    from worker.credentials import CredentialUnavailableError

    token_url, admin_base = realm_urls(target.realm, origins)
    try:
        with source.load(target.realm) as credential:
            token = access_token(token_url, credential, deadline=deadline)
    except CredentialUnavailableError as error:
        raise RealmCallError("credential", cause=type(error).__name__) from None
    admin = HttpRealmAdmin(admin_base, token)
    del token
    try:
        yield admin
    finally:
        admin._token = ""


ISSUER_ORIGIN = "KODERA_REALM_ISSUER_ORIGIN"
ADMIN_ORIGIN = "KODERA_REALM_ADMIN_ORIGIN"


def origins_from_environment(environ: Mapping[str, str]) -> RealmOrigins | None:
    """The worker's pinned Keycloak origins, or None when neither is set; one without the other, or
    a malformed one, raises ValueError naming the variable (the settings stop the process)."""
    issuer, admin = environ.get(ISSUER_ORIGIN, ""), environ.get(ADMIN_ORIGIN, "")
    if not issuer and not admin:
        return None
    parsed = {}
    for name, value in ((ISSUER_ORIGIN, issuer), (ADMIN_ORIGIN, admin)):
        try:
            parsed[name] = parse_origin(value)
        except ValueError:
            raise ValueError(f"{name} is not an https origin (http only on loopback)") from None
    return RealmOrigins(issuer=parsed[ISSUER_ORIGIN], admin=parsed[ADMIN_ORIGIN])
