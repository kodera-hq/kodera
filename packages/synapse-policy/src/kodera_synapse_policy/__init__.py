"""Keep a Kodera instance's rooms under the control plane's policy.

Kodera's control plane decides who is in which channel room and the tenant agent's
administrative account applies it (ADR-0018). Synapse's client API is open to any Matrix
client a member signs in with, so this module refuses what would route around that:

- room creation, except a direct message between two local users, and except by the agent;
- invites, except the one a member's direct message is created with, except by a joined member of
  a room whose ``io.kodera.room.policy`` sets ``allow_member_invites: true`` (for local users, or
  federated users when ``allow_federated_invites: true`` is also set), and except by the agent;
- invites by e-mail or phone (third-party identifiers) and room aliases, except by the agent;
- publishing any room to the directory;
- end-to-end encryption in any room, from its creation on, for the agent too, also when the
  agent's account is a server admin, which Synapse exempts from the room-creation check: both
  turning it on and ciphertext itself, which a client can post without turning it on;
- turning a room public: a join rule other than ``invite``, a world-readable history,
  aliases, server ACLs, room upgrades and space links, unless the agent sends them;
- Kodera's own room state, whatever the room's power levels: a room's policy
  (``io.kodera.room.policy``) from anyone but the agent, and its audio occupancy
  (``io.kodera.room.occupancy``) from anyone but the agent and the room-access service. In a
  direct message its creator holds every power level, so levels alone do not keep a member from
  declaring their own room an audio channel.

The agent's additive read_only/audience/members/exempt policy also protects announcement
posting and private-room membership when a room's power levels are accidentally permissive.
"""

from __future__ import annotations

from typing import Any
from collections.abc import Mapping

from synapse.module_api import NOT_SPAM, ModuleApi
from synapse.module_api.errors import Codes, ConfigError

__version__ = "0.1.5"

DM_PRESETS = frozenset({"private_chat", "trusted_private_chat"})
# State a member may never send, whatever its content.
LOCKED_STATE = frozenset(
    {
        "m.room.aliases",
        "m.room.canonical_alias",
        "m.room.server_acl",
        "m.room.third_party_invite",
        "m.room.tombstone",
        "m.space.child",
        "m.space.parent",
        "io.kodera.room.policy",
        "m.call.member",
        "org.matrix.msc3401.call.member",
        "org.matrix.msc4143.rtc.member",
    }
)
# Written by the room-access service (and the agent) only; `room_access_user_id` names it.
OCCUPANCY = "io.kodera.room.occupancy"
# Events that put end-to-end encryption in a room: the state that turns it on, and ciphertext. A
# client can post ``m.room.encrypted`` in a room where encryption is off, with the keys shared by
# to-device message, so refusing the state event alone would not keep a room in the clear.
ENCRYPTION = frozenset({"m.room.encryption", "m.room.encrypted"})


class KoderaPolicy:
    def __init__(self, config: dict[str, Any], api: ModuleApi) -> None:
        self._agent = config["agent_user_id"]
        self._room_access = config.get("room_access_user_id")
        self._api = api
        api.register_spam_checker_callbacks(
            user_may_create_room=self.user_may_create_room,
            user_may_invite=self.user_may_invite,
            user_may_join_room=self.user_may_join_room,
            user_may_send_3pid_invite=self.user_may_send_3pid_invite,
            user_may_create_room_alias=self.user_may_create_room_alias,
            user_may_publish_room=self.user_may_publish_room,
            check_event_for_spam=self.check_event_for_spam,
        )
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event_allowed)

    @staticmethod
    def parse_config(config: dict[str, Any]) -> dict[str, Any]:
        agent = config.get("agent_user_id") if isinstance(config, dict) else None
        if not isinstance(agent, str) or not agent.startswith("@") or ":" not in agent:
            raise ConfigError("agent_user_id must be a full Matrix user ID, such as @agent:example.org")
        # Optional: without it, nobody but the agent writes occupancy.
        room_access = config.get("room_access_user_id")
        if room_access is not None and (
            not isinstance(room_access, str) or not room_access.startswith("@") or ":" not in room_access
        ):
            raise ConfigError("room_access_user_id must be a full Matrix user ID, such as @rooms:example.org")
        return {"agent_user_id": agent, "room_access_user_id": room_access}

    async def user_may_create_room(
        self, user_id: str, room_config: dict[str, Any] | None = None
    ) -> Any:
        # A room's initial state never reaches check_event_for_spam, so encryption asked for at
        # creation is refused here, the agent's included.
        if room_config is not None and _asks_for_encryption(room_config):
            return Codes.FORBIDDEN
        if user_id == self._agent:
            return NOT_SPAM
        # Synapse before 1.132 passes no room_config: nothing tells a direct message apart.
        if room_config is None or not self._is_direct_message(user_id, room_config):
            return Codes.FORBIDDEN
        return NOT_SPAM

    def _is_direct_message(self, creator: str, config: dict[str, Any]) -> bool:
        invite = config.get("invite")
        if config.get("is_direct") is not True or not isinstance(invite, list) or len(invite) != 1:
            return False
        invitee = invite[0]
        if not isinstance(invitee, str) or invitee == creator or not self._api.is_mine(invitee):
            return False
        if creator == self._room_access or invitee in {self._agent, self._room_access}:
            return False
        creation = config.get("creation_content") or {}
        return (
            not config.get("invite_3pid")
            and not config.get("room_alias_name")
            and not config.get("initial_state")
            and not config.get("power_level_content_override")
            and config.get("visibility", "private") == "private"
            and config.get("preset", "trusted_private_chat") in DM_PRESETS
            and isinstance(creation, dict)
            and creation.get("type") is None
        )

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str) -> Any:
        if inviter == self._room_access or invitee in {self._agent, self._room_access}:
            return Codes.FORBIDDEN
        if not _is_valid_user_id(invitee):
            return Codes.FORBIDDEN
        if inviter == self._agent:
            return NOT_SPAM
        state = await self._api.get_room_state(room_id)
        policy_event = state.get(("io.kodera.room.policy", ""))
        policy_content = getattr(policy_event, "content", None)
        if _has_governance(policy_content):
            if not self._governance_valid(policy_event):
                return Codes.FORBIDDEN
            if policy_content.get("audience") == "listed" and (
                inviter not in policy_content["members"] or invitee not in policy_content["members"]
            ):
                return Codes.FORBIDDEN
        if isinstance(policy_content, Mapping) and policy_content.get("allow_member_invites") is True:
            if _membership_of(state.get(("m.room.member", inviter))) != "join":
                return Codes.FORBIDDEN
            if self._api.is_mine(invitee) or policy_content.get("allow_federated_invites") is True:
                return NOT_SPAM
            return Codes.FORBIDDEN
        # Without a channel invite policy, a member invites once: into the direct message they
        # just created, where nobody else has ever had a membership.
        create = state.get(("m.room.create", ""))
        others = {key for (kind, key) in state if kind == "m.room.member"} - {inviter}
        if create is None or create.sender != inviter or others or not self._api.is_mine(invitee):
            return Codes.FORBIDDEN
        return NOT_SPAM

    async def user_may_join_room(self, user: str, room: str, is_invited: bool) -> Any:
        if user == self._agent:
            return NOT_SPAM
        state = await self._api.get_room_state(room)
        policy_event = state.get(("io.kodera.room.policy", ""))
        content = getattr(policy_event, "content", None)
        if not _has_governance(content):
            return NOT_SPAM
        if not self._governance_valid(policy_event):
            return Codes.FORBIDDEN
        if content["audience"] == "listed" and user not in content["members"]:
            return Codes.FORBIDDEN
        return NOT_SPAM

    async def user_may_send_3pid_invite(
        self, inviter: str, medium: str, address: str, room_id: str
    ) -> Any:
        return NOT_SPAM if inviter == self._agent else Codes.FORBIDDEN

    async def user_may_create_room_alias(self, user_id: str, room_alias: Any) -> Any:
        return NOT_SPAM if user_id == self._agent else Codes.FORBIDDEN

    async def user_may_publish_room(self, user_id: str, room_id: str) -> Any:
        return Codes.FORBIDDEN

    async def check_event_allowed(self, event: Any, state_events: Any) -> tuple[bool, dict | None]:
        # Synapse asks this of every event it creates, with no admin exemption: a room's initial
        # state, encryption a server setting forces on at creation, the state an upgrade copies,
        # and every timeline event, ciphertext included.
        return event.type not in ENCRYPTION and self._governance_allows(event, state_events), None

    async def check_event_for_spam(self, event: Any) -> Any:
        # Synapse runs this, not check_event_allowed, on events from other servers.
        if event.type in ENCRYPTION:
            return Codes.FORBIDDEN
        if getattr(event, "room_id", None):
            state = await self._api.get_room_state(event.room_id)
            if not self._governance_allows(event, state):
                return Codes.FORBIDDEN
        if not event.is_state():
            return NOT_SPAM
        if event.sender == self._agent:
            return NOT_SPAM
        if event.type == OCCUPANCY:
            return NOT_SPAM if event.sender == self._room_access else Codes.FORBIDDEN
        content = event.content
        if (
            event.type in LOCKED_STATE
            or (event.type == "m.room.join_rules" and content.get("join_rule") != "invite")
            or (
                event.type == "m.room.history_visibility"
                and content.get("history_visibility") == "world_readable"
            )
        ):
            return Codes.FORBIDDEN
        return NOT_SPAM

    def _governance_valid(self, policy_event: Any) -> bool:
        content = getattr(policy_event, "content", {})
        if getattr(policy_event, "sender", None) != self._agent:
            return False
        if content.get("audience") not in ("all", "listed") or type(content.get("read_only")) is not bool:
            return False
        for key in ("members", "exempt"):
            values = content.get(key)
            if not isinstance(values, (list, tuple)) or not all(_is_valid_user_id(value) for value in values):
                return False
        return content["audience"] != "listed" or set(content["exempt"]) <= set(content["members"])

    def _governance_allows(self, event: Any, state: Any) -> bool:
        if event.sender == self._agent:
            return True
        policy_event = state.get(("io.kodera.room.policy", ""))
        content = getattr(policy_event, "content", None)
        if not _has_governance(content):
            return True
        if not self._governance_valid(policy_event):
            return False
        if event.type == "m.room.member":
            membership = event.content.get("membership")
            target = getattr(event, "state_key", None)
            if membership in {"join", "invite", "knock"} and content["audience"] == "listed":
                if target not in content["members"]:
                    return False
                if membership == "invite" and event.sender not in content["members"]:
                    return False
            # A user's own join/leave is not an announcement state edit. Matrix's
            # native membership authorization still applies after this additional gate.
            if target == event.sender and membership in {"join", "leave"}:
                return True
        if content["audience"] == "listed" and event.sender not in content["members"]:
            return False
        if content["read_only"] and (
            event.is_state() or event.type in {"m.room.message", "m.sticker"}
        ):
            if event.sender in content["exempt"]:
                return True
            levels = getattr(state.get(("m.room.power_levels", "")), "content", {})
            # Ignore users_default: making it permissive must not promote every member.
            users = levels.get("users", {}) if isinstance(levels, Mapping) else {}
            power = users.get(event.sender, 0) if isinstance(users, Mapping) else 0
            return (
                type(power) is int and power >= 50
                and _membership_of(state.get(("m.room.member", event.sender))) == "join"
            )
        return True


def _has_governance(content: Any) -> bool:
    return isinstance(content, Mapping) and any(
        key in content for key in ("read_only", "audience", "members", "exempt")
    )


def _asks_for_encryption(config: dict[str, Any]) -> bool:
    initial_state = config.get("initial_state")
    if not isinstance(initial_state, list):
        return False
    return any(isinstance(state, dict) and state.get("type") == "m.room.encryption" for state in initial_state)


def _is_valid_user_id(user_id: Any) -> bool:
    if not isinstance(user_id, str) or not user_id.startswith("@") or any(c.isspace() for c in user_id):
        return False
    localpart, sep, domain = user_id[1:].partition(":")
    return bool(sep and localpart and domain and not domain.startswith(":"))


def _membership_of(member_event: Any) -> str | None:
    if member_event is None:
        return None
    membership = getattr(member_event, "membership", None)
    if isinstance(membership, str):
        return membership
    content = getattr(member_event, "content", None)
    if isinstance(content, Mapping):
        value = content.get("membership")
        if isinstance(value, str):
            return value
    return None
