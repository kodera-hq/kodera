"""The tenant's Synapse, driven through its client-server and admin APIs (ADR-0018).

The agent holds one account on the homeserver: a server administrator that creates every channel's
room, owns its power levels and state, and converges its membership. Nothing else may create rooms
or invite (the Kodera Synapse module refuses it). A Keycloak subject is the Matrix localpart:
Synapse's OIDC mapping uses the realm's stable `sub`.
"""

import hashlib
import http.client
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import federation
from .engines import EngineError

log = logging.getLogger("tenant_agent.synapse")
# A Matrix user localpart (the spec's historical grammar, which Keycloak's UUID subjects satisfy).
_LOCALPART = re.compile(r"[a-z0-9._=\-/+]{1,255}")
POLICY = "io.kodera.room.policy"
OCCUPANCY = "io.kodera.room.occupancy"


def livekit_room(room_id: str) -> str:
    """The LiveKit room of an audio channel's Matrix room. Whatever admits members to a channel's
    call must name its LiveKit room by this same rule."""
    return "kodera-" + hashlib.sha256(room_id.encode()).hexdigest()[:32]


class SynapseUnavailableError(EngineError):
    """The homeserver did not answer at all (refused, reset, timed out): a transport failure, not
    an HTTP status. Every later call of the same pass would wait as long, so a pass stops at it."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as the error it is: the admin token never follows one."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class Synapse:
    def __init__(
        self,
        url: str,
        token: str,
        server_name: str,
        room_access_user: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._url, self._token, self.server_name = url.rstrip("/"), token, server_name
        self.room_access_user, self._timeout = room_access_user, timeout
        self._me: str | None = None
        self._sso_provider: str | None = None
        # No proxy and no redirect: the token goes to the configured homeserver and nowhere else.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    # -- transport ---------------------------------------------------------------------------

    def _call(
        self, method: str, path: str, body: Any = None, *, ok: tuple[int, ...] = (200,)
    ) -> tuple[int, Any]:
        request = urllib.request.Request(  # noqa: S310 - the VM's own homeserver, from config
            self._url + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                raw = response.read()
                status = response.status
        except urllib.error.HTTPError as exc:  # an answer, redirects included: before URLError
            exc.close()  # its connection, which the error holds open otherwise
            if exc.code in ok:
                return exc.code, {}
            raise EngineError(f"synapse {method} {path.split('?')[0]} answered {exc.code}") from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise SynapseUnavailableError(f"synapse {method}: {exc}") from exc
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError as exc:
            raise EngineError(f"synapse {method} {path.split('?')[0]}: unreadable answer") from exc

    @staticmethod
    def _q(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    # -- names -------------------------------------------------------------------------------

    def me(self) -> str:
        if self._me is None:
            _, answer = self._call("GET", "/_matrix/client/v3/account/whoami")
            self._me = str(answer["user_id"])
        return self._me

    def user_id(self, subject: str) -> str | None:
        """The Matrix user of a realm subject, or None when the subject cannot be a localpart."""
        localpart = subject.lower()
        return f"@{localpart}:{self.server_name}" if _LOCALPART.fullmatch(localpart) else None

    def alias(self, channel_id: str) -> str:
        return f"#kodera-ch-{channel_id}:{self.server_name}"

    # -- rooms -------------------------------------------------------------------------------

    def resolve(self, channel_id: str) -> str | None:
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/directory/room/{self._q(self.alias(channel_id))}",
            ok=(200, 404),
        )
        return str(answer["room_id"]) if status == 200 else None

    def create(
        self,
        channel_id: str,
        name: str,
        topic: str,
        initial_state: list[dict[str, Any]],
        power_levels: dict[str, Any],
        *,
        federation_servers: tuple[str, ...] = (),
    ) -> str:
        try:
            federation_servers = federation.servers(federation_servers, empty=True)
        except ValueError:
            raise EngineError("invalid partner homeserver names") from None
        if self.server_name in federation_servers:
            raise EngineError("a partner homeserver must be external")
        expected_acl = federation.acl(self.server_name, federation_servers)
        supplied_acl = [item for item in initial_state if item.get("type") == "m.room.server_acl"]
        if len(supplied_acl) > 1 or any(
            item.get("state_key", "") != "" or item.get("content") != expected_acl
            for item in supplied_acl
        ):
            raise EngineError("initial server ACL must exactly match the room federation mode")
        initial_state = [item for item in initial_state if item.get("type") != "m.room.server_acl"]
        _, answer = self._call(
            "POST",
            "/_matrix/client/v3/createRoom",
            {
                "room_alias_name": f"kodera-ch-{channel_id}",
                "creation_content": {
                    "m.federate": bool(federation_servers),
                    federation.MODE: "partner" if federation_servers else "internal",
                },
                # Pinned: power_levels() relies on version 12's creator rule.
                "room_version": "12",
                "preset": "private_chat",
                "visibility": "private",
                "name": name,
                "topic": topic,
                "initial_state": [
                    *initial_state,
                    {
                        "type": "m.room.server_acl",
                        "state_key": "",
                        "content": expected_acl,
                    },
                    {
                        "type": "m.room.guest_access",
                        "state_key": "",
                        "content": {"guest_access": "forbidden"},
                    },
                    # New members read the channel's history, as a workspace channel should.
                    {
                        "type": "m.room.history_visibility",
                        "state_key": "",
                        "content": {"history_visibility": "shared"},
                    },
                ],
                "power_level_content_override": power_levels,
            },
        )
        return str(answer["room_id"])

    def require_federation_mode(self, room_id: str, partners: tuple[str, ...]) -> None:
        content = self.state(room_id, "m.room.create")
        expected = "partner" if partners else "internal"
        if (
            not isinstance(content, dict)
            or content.get(federation.MODE) != expected
            or content.get("m.federate") is not bool(partners)
        ):
            raise EngineError(
                "room federation mode differs; explicit replacement/migration is required"
            )

    def creator(self, room_id: str) -> str | None:
        """Who created the room (admin API): a room under a channel's alias is the channel's only
        if the agent made it."""
        _, answer = self._call("GET", f"/_synapse/admin/v1/rooms/{self._q(room_id)}")
        creator = answer.get("creator")
        return str(creator) if creator is not None else None

    def state(self, room_id: str, event_type: str) -> dict[str, Any] | None:
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/state/{self._q(event_type)}/",
            ok=(200, 404),
        )
        return answer if status == 200 else None

    def put_state(self, room_id: str, event_type: str, content: dict[str, Any]) -> None:
        self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/state/{self._q(event_type)}/",
            content,
        )

    def members(self, room_id: str) -> dict[str, str]:
        """user id → membership (join, invite, leave, ban) of everyone the room has known."""
        _, answer = self._call("GET", f"/_matrix/client/v3/rooms/{self._q(room_id)}/members")
        return {
            str(event["state_key"]): str(event["content"].get("membership"))
            for event in answer.get("chunk", [])
            if event.get("type") == "m.room.member"
        }

    def join(self, room_id: str, user_id: str) -> bool:
        """Join a member to the room (admin API). False when the account does not exist."""
        status, _ = self._call(
            "POST",
            f"/_synapse/admin/v1/join/{self._q(room_id)}",
            {"user_id": user_id},
            ok=(200, 404),
        )
        return status == 200

    def invite(self, room_id: str, user_id: str) -> None:
        self._call(
            "POST", f"/_matrix/client/v3/rooms/{self._q(room_id)}/invite", {"user_id": user_id}
        )

    def kick(self, room_id: str, user_id: str) -> None:
        self._call(
            "POST",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/kick",
            {"user_id": user_id, "reason": "access changed in Kodera"},
        )

    def moderation_bans(self, room_id: str) -> tuple[set[str], set[str]]:
        """All current room bans, then only those this agent may reverse."""
        _, answer = self._call(
            "GET", f"/_matrix/client/v3/rooms/{self._q(room_id)}/members?membership=ban"
        )
        entries = answer.get("chunk")
        if not isinstance(entries, list):
            raise EngineError("the homeserver's banned membership list is invalid")
        everyone, owned = set(), set()
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("content"), dict):
                raise EngineError("the homeserver's banned membership event is invalid")
            if entry["content"].get("membership") != "ban":
                continue
            user = entry.get("state_key")
            if not isinstance(user, str):
                raise EngineError("the homeserver's banned membership target is invalid")
            everyone.add(user)
            if (
                entry.get("sender") == self.me()
                and entry["content"].get("reason") == "workspace moderation in Kodera"
            ):
                owned.add(user)
        return everyone, owned

    def ban(self, room_id: str, user_id: str) -> None:
        self._call(
            "POST",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/ban",
            {"user_id": user_id, "reason": "workspace moderation in Kodera"},
        )

    def unban(self, room_id: str, user_id: str) -> None:
        self._call(
            "POST", f"/_matrix/client/v3/rooms/{self._q(room_id)}/unban", {"user_id": user_id}
        )

    def notice(self, room_id: str, notice_id: str, body: str) -> None:
        # The transaction id is the notice id: a resend by the same account is deduplicated.
        self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/send/m.room.message/{self._q(notice_id)}",
            {"msgtype": "m.notice", "body": body},
        )

    # -- accounts (ADR-0016's member set) ----------------------------------------------------

    def active_users(self) -> set[str]:
        """Every local account that is not deactivated, paged through the admin API."""
        found: set[str] = set()
        page: str | None = "0"
        while page is not None:
            _, answer = self._call(
                "GET",
                f"/_synapse/admin/v2/users?deactivated=false&guests=false&limit=500&from={page}",
            )
            found.update(str(user["name"]) for user in answer.get("users", []))
            next_token = answer.get("next_token")
            page = str(next_token) if next_token is not None else None
        return found

    def sso_provider(self) -> str | None:
        """The homeserver's one sign-in provider, as Synapse names it in `user_external_ids`
        (`oidc-<idp_id>`), read from the login flows it offers. None unless it offers exactly one:
        an account bound to a guessed provider would not be the one the member signs in to."""
        if self._sso_provider is None:
            _, answer = self._call("GET", "/_matrix/client/v3/login")
            flows = [f for f in answer.get("flows", []) if f.get("type") == "m.login.sso"]
            providers = [p.get("id") for f in flows for p in f.get("identity_providers", [])]
            if len(providers) != 1 or not isinstance(providers[0], str):
                log.warning("no account is made ahead of sign-in: sign-in providers %s", providers)
                return None
            self._sso_provider = providers[0]
        return self._sso_provider

    def account(self, user_id: str) -> dict[str, Any] | None:
        """The account as the admin API reads it (`deactivated` among its fields), or None."""
        status, found = self._call(
            "GET", f"/_synapse/admin/v2/users/{self._q(user_id)}", ok=(200, 404)
        )
        return found if status == 200 else None

    def create_account(self, user_id: str, subject: str) -> bool:
        """Make a member's account before they first sign in, bound to their realm subject, so
        their first sign-in lands on it: Synapse looks the provider and the subject up before it
        maps a new localpart. No password, so only that sign-in can use it. Called only for an
        account `account` found missing. False when nothing was made."""
        provider = self.sso_provider()
        if provider is None:
            return False
        self._call(
            "PUT",
            f"/_synapse/admin/v2/users/{self._q(user_id)}",
            {"external_ids": [{"auth_provider": provider, "external_id": subject}]},
            ok=(200, 201),
        )
        return True

    def set_deactivated(self, user_id: str, deactivated: bool) -> bool:
        """Deactivate or reactivate an account; False when it does not exist."""
        status, _ = self._call("GET", f"/_synapse/admin/v2/users/{self._q(user_id)}", ok=(200, 404))
        if status == 404:
            return False
        self._call(
            "PUT", f"/_synapse/admin/v2/users/{self._q(user_id)}", {"deactivated": deactivated}
        )
        return True

    def erase(self, user_id: str) -> None:
        """Deactivate with Synapse's erase flag: the account's messages are no longer served to
        anyone who joins a room later. Final; a missing account has nothing to erase."""
        self._call(
            "POST",
            f"/_synapse/admin/v1/deactivate/{self._q(user_id)}",
            {"erase": True},
            ok=(200, 404),
        )

    def converge(
        self,
        inactive: list[str],
        released: list[str],
        *,
        full: bool,
        erased: list[str] | None = None,
        done: Any = None,
    ) -> dict[str, int]:
        """Deactivate each inactive subject's account, reactivate each released one, then erase each
        erased one once (ADR-0016, ADR-0018 "Leaving and erasure"). Deactivation comes first, so a
        failing erasure never holds one back. Deactivation leaves every room; the next channel set
        or re-application joins a reactivated member back. `done` is the agent's ledger of
        erasures already made, and an erased account is never reactivated: Synapse's reactivation
        could clear its erased flag."""
        already = done.erased_accounts() if done is not None else set()
        active = self.active_users()
        deactivated = reactivated = 0
        for subject in inactive:
            user = self.user_id(subject)
            if user is not None and user in active and self.set_deactivated(user, True):
                deactivated += 1
        for subject in released:
            user = self.user_id(subject)
            if user is not None and user in already:
                log.warning("not reactivating %s: the account was erased", user)
                continue
            if user is not None and user not in active and self.set_deactivated(user, False):
                reactivated += 1
        erased_count = 0
        for subject in erased or []:
            user = self.user_id(subject)
            if user is None or user in already:
                continue
            self.erase(user)
            if done is not None:
                done.record_erased(user)
            erased_count += 1
        return {"deactivated": deactivated, "reactivated": reactivated, "erased": erased_count}
