"""The two servers room-access talks to: the tenant's Synapse, as its own account, and LiveKit's
server API with the VM's key. Standard library plus PyJWT, as the tenant agent."""

import base64
import hashlib
import hmac
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import jwt


class UpstreamError(Exception):
    """Synapse or LiveKit could not be reached or answered something unusable."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as the error it is: no token follows one."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


# No proxy and no redirect: tokens go to the configured upstream and nowhere else.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _request(
    url: str, method: str, headers: dict[str, str], body: Any, timeout: float, ok: tuple[int, ...]
) -> tuple[int, Any]:
    request = urllib.request.Request(  # noqa: S310 - the VM's own servers, from config
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method=method,
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        exc.close()
        if exc.code in ok:
            return exc.code, {}
        raise UpstreamError(f"{method} {url.split('?')[0]} answered {exc.code}") from exc
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as exc:
        raise UpstreamError(f"{method}: {exc}") from exc


def _q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


class Matrix:
    """Synapse's client-server API, as room-access's account (or, for whoami, as the caller)."""

    def __init__(self, url: str, token: str, timeout: float = 5.0) -> None:
        self._url, self._token, self._timeout = url, token, timeout
        self._since: str | None = None
        self._me: str | None = None

    def _call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        token: str | None = None,
        ok: tuple[int, ...] = (200,),
    ) -> tuple[int, Any]:
        bearer = self._token if token is None else token
        headers = {"Authorization": f"Bearer {bearer}"}
        return _request(self._url + path, method, headers, body, self._timeout, ok)

    def whoami(self, token: str) -> tuple[str, str] | None:
        """The caller's (user id, device id), from their own token, or None if Synapse refuses it."""
        status, answer = self._call(
            "GET", "/_matrix/client/v3/account/whoami", token=token, ok=(200, 401, 403)
        )
        if status != 200 or not isinstance(answer.get("user_id"), str):
            return None
        return answer["user_id"], str(answer.get("device_id") or "nodevice")

    def state(self, room_id: str, event_type: str) -> dict[str, Any] | None:
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/rooms/{_q(room_id)}/state/{_q(event_type)}/",
            ok=(200, 403, 404),
        )
        return answer if status == 200 else None

    def state_event(self, room_id: str, event_type: str) -> dict[str, Any] | None:
        """The whole state event (sender included), not its content alone."""
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/rooms/{_q(room_id)}/state/{_q(event_type)}/?format=event",
            ok=(200, 403, 404),
        )
        return answer if status == 200 and isinstance(answer, dict) else None

    def membership(self, room_id: str, user_id: str) -> str | None:
        member = self.state_key(room_id, "m.room.member", user_id)
        return str(member.get("membership")) if member else None

    def state_key(self, room_id: str, event_type: str, key: str) -> dict[str, Any] | None:
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/rooms/{_q(room_id)}/state/{_q(event_type)}/{_q(key)}",
            ok=(200, 403, 404),
        )
        return answer if status == 200 else None

    def joined_members(self, room_id: str) -> set[str]:
        """One read per room per pass."""
        _, answer = self._call("GET", f"/_matrix/client/v3/rooms/{_q(room_id)}/joined_members")
        return set(answer.get("joined", {}))

    def put_state(self, room_id: str, event_type: str, content: dict[str, Any]) -> None:
        self._call(
            "PUT", f"/_matrix/client/v3/rooms/{_q(room_id)}/state/{_q(event_type)}/", content
        )

    def _whoami_self(self) -> str:
        if self._me is None:
            me = self.whoami(self._token)
            if me is None:
                raise UpstreamError("Synapse refuses this service's own token")
            self._me = me[0]
        return self._me

    def accept_invites(self, inviter: str) -> list[str]:
        """Join every room `inviter` (the agent) has invited this account to: each new audio room.
        An invitation from anyone else is declined: a member's direct message is not an audio room.
        One whose sender cannot be read is left pending."""
        me = self._whoami_self()
        query = {"timeout": "0", "filter": json.dumps({"room": {"timeline": {"limit": 0}}})}
        if self._since:
            query["since"] = self._since
        _, answer = self._call("GET", "/_matrix/client/v3/sync?" + urllib.parse.urlencode(query))
        self._since = answer.get("next_batch", self._since)
        joined = []
        for room_id, invite in answer.get("rooms", {}).get("invite", {}).items():
            events = (invite or {}).get("invite_state", {}).get("events", [])
            senders = {
                event.get("sender")
                for event in events
                if isinstance(event, dict)
                and event.get("type") == "m.room.member"
                and event.get("state_key") == me
                and (event.get("content") or {}).get("membership") == "invite"
            }
            if senders == {inviter}:
                self._call("POST", f"/_matrix/client/v3/rooms/{_q(room_id)}/join", {})
                joined.append(room_id)
            elif senders:
                self._call("POST", f"/_matrix/client/v3/rooms/{_q(room_id)}/leave", {})
        return joined


class LiveKit:
    """LiveKit's server API (Twirp, JSON), with short-lived tokens signed by the VM's key."""

    def __init__(self, url: str, key: str, secret: str, timeout: float = 5.0) -> None:
        self._url, self.key, self._secret, self._timeout = url, key, secret, timeout

    def _admin(self, video: dict[str, Any]) -> str:
        now = int(time.time())
        claims = {
            "iss": self.key,
            "sub": "kodera-room-access",
            "nbf": now - 5,
            "exp": now + 60,
            "video": video,
        }
        return jwt.encode(claims, self._secret, algorithm="HS256")

    def _post(self, method: str, body: dict[str, Any], video: dict[str, Any]) -> dict[str, Any]:
        _, answer = _request(
            f"{self._url}/twirp/livekit.RoomService/{method}",
            "POST",
            {"Authorization": f"Bearer {self._admin(video)}"},
            body,
            self._timeout,
            ok=(404,),
        )
        return dict(answer)

    def create_room(self, name: str, room_id: str) -> None:
        self._post(
            "CreateRoom",
            {"name": name, "metadata": room_id, "empty_timeout": 30},
            {"roomCreate": True},
        )

    def rooms(self) -> list[dict[str, Any]]:
        return list(self._post("ListRooms", {}, {"roomList": True}).get("rooms", []))

    def participants(self, room: str) -> list[dict[str, Any]]:
        answer = self._post("ListParticipants", {"room": room}, {"roomAdmin": True, "room": room})
        return list(answer.get("participants", []))

    def remove(self, room: str, identity: str) -> None:
        self._post(
            "RemoveParticipant",
            {"room": room, "identity": identity},
            {"roomAdmin": True, "room": room},
        )

    def set_publish(self, room: str, identity: str, can_publish: bool) -> None:
        self._post(
            "UpdateParticipant",
            {
                "room": room,
                "identity": identity,
                "permission": {
                    "canSubscribe": True,
                    "canPublish": can_publish,
                    "canPublishData": can_publish,
                },
            },
            {"roomAdmin": True, "room": room},
        )

    def token(self, room: str, identity: str, *, can_publish: bool, ttl_s: int) -> str:
        now = int(time.time())
        claims = {
            "iss": self.key,
            "sub": identity,
            "nbf": now - 5,
            "exp": now + ttl_s,
            "video": {
                "roomJoin": True,
                "room": room,
                "canSubscribe": True,
                "canPublish": can_publish,
                "canPublishData": can_publish,
            },
        }
        return jwt.encode(claims, self._secret, algorithm="HS256")

    def verify_webhook(self, body: bytes, authorization: str) -> bool:
        """LiveKit signs each delivery with a JWT whose `sha256` claim is the body's digest."""
        token = authorization.removeprefix("Bearer ").strip()
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                issuer=self.key,
                options={"require": ["exp", "iss"]},
            )
        except jwt.PyJWTError:
            return False
        digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
        return hmac.compare_digest(str(claims.get("sha256", "")), digest)
