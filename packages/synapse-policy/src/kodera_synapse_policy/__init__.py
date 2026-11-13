"""Keep a Kodera instance's rooms under the control plane's policy.

Kodera's control plane decides who is in which channel room and the tenant agent's
administrative account applies it (ADR-0018). Synapse's client API is open to any Matrix
client a member signs in with, so this module refuses what would route around that:

- room creation, except a bounded private direct message between local users, and except by the agent;
- invites, except the bounded set a member's direct message is created with, except by a joined member of
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
from synapse.module_api.errors import Codes, ConfigError, SynapseError

from .federation import MODE, acl, acl_matches, creation_mode, server_list

__version__ = "0.1.6"

DM_INVITEES = "io.kodera.dm.invitees"
MAX_DM_INVITEES = 8
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
        self._server = self._agent.partition(":")[2]
        self._federation_servers = frozenset(config.get("federation_domain_allowlist", ()))
        api.register_spam_checker_callbacks(
            user_may_create_room=self.user_may_create_room,
            user_may_invite=self.user_may_invite,
            user_may_join_room=self.user_may_join_room,
            user_may_send_3pid_invite=self.user_may_send_3pid_invite,
            user_may_create_room_alias=self.user_may_create_room_alias,
            user_may_publish_room=self.user_may_publish_room,
            check_event_for_spam=self.check_event_for_spam,
        )
        api.register_third_party_rules_callbacks(
            check_event_allowed=self.check_event_allowed, on_create_room=self.on_create_room
        )

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
        servers = server_list(config.get("federation_domain_allowlist", []), empty=True)
        if servers is None or agent.partition(":")[2] in (servers or ()):
            raise ConfigError("federation_domain_allowlist must list at most 32 distinct public homeserver names without ports or wildcards")
        return {"agent_user_id": agent, "room_access_user_id": room_access, "federation_domain_allowlist": list(servers)}

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
        if not await self._active_dm_users(user_id, *room_config["invite"]):
            return Codes.FORBIDDEN
        return NOT_SPAM

    def _is_direct_message(self, creator: str, config: dict[str, Any]) -> bool:
        invite = config.get("invite")
        if config.get("is_direct") is not True or not isinstance(invite, list) or not 1 <= len(invite) <= MAX_DM_INVITEES:
            return False
        if creator == self._room_access or not _is_valid_user_id(creator) or not self._api.is_mine(creator):
            return False
        if not all(
            _is_valid_user_id(invitee) and invitee != creator and self._api.is_mine(invitee)
            and invitee not in {self._agent, self._room_access}
            for invitee in invite
        ) or len(set(invite)) != len(invite):
            return False
        creation = config.get("creation_content") or {}
        return (
            not config.get("invite_3pid")
            and not config.get("room_alias_name")
            and not config.get("initial_state")
            and not config.get("power_level_content_override")
            and config.get("visibility") == "private"
            and config.get("preset") == "private_chat"
            and isinstance(creation, dict)
            and creation.get("type") is None
            and creation.get(MODE) in (None, "internal")
        )

    async def _active_dm_users(self, *users: str) -> bool:
        for user_id in users:
            info = await self._api.get_userinfo_by_id(user_id)
            if (
                info is None
                or getattr(info, "is_deactivated", True) is not False
                or getattr(info, "is_guest", True) is not False
                or getattr(info, "approved", True) is not True
                or getattr(info, "locked", False) is not False
                or getattr(info, "suspended", False) is not False
            ):
                return False
        return True

    async def on_create_room(self, requester: Any, request_content: dict[str, Any], is_requester_admin: bool) -> None:
        creator = requester.user.to_string()
        direct = creator != self._agent and self._is_direct_message(creator, request_content)
        creation = request_content.get("creation_content") or {}
        if not isinstance(creation, dict):
            raise SynapseError(403, "Room creation content must be an object", errcode=Codes.FORBIDDEN)
        partner = creation.get(MODE) == "partner"
        initial = request_content.get("initial_state") or []
        if not isinstance(initial, list):
            raise SynapseError(403, "Room initial state must be a list", errcode=Codes.FORBIDDEN)
        policies = [item for item in initial if isinstance(item, dict) and item.get("type") == "io.kodera.room.policy" and item.get("state_key", "") == ""]
        partners: tuple[str, ...] = ()
        if partner:
            content = policies[0].get("content") if len(policies) == 1 else None
            partners = self._partner_content(content) or ()
            if creator != self._agent or not partners or creation.get("m.federate") is not True or request_content.get("preset") != "private_chat" or request_content.get("visibility", "private") != "private":
                raise SynapseError(403, "Partner federation requires an explicit trusted bounded room policy", errcode=Codes.FORBIDDEN)
        else:
            if creation.get(MODE) not in (None, "internal") or any(isinstance(item.get("content"), Mapping) and item["content"].get("allow_federated_invites") is True for item in policies):
                raise SynapseError(403, "Internal rooms cannot enable partner federation", errcode=Codes.FORBIDDEN)
        creation = dict(creation, **{"m.federate": partner, MODE: "partner" if partner else "internal"})
        creation["io.kodera.room.initial_partner_servers"] = list(partners)
        request_content["creation_content"] = creation
        expected = acl(self._server, partners)
        acls = [item for item in initial if isinstance(item, dict) and item.get("type") == "m.room.server_acl" and item.get("state_key", "") == ""]
        if len(acls) > 1 or (acls and acls[0].get("content") != expected):
            raise SynapseError(403, "Room server ACL must match its immutable federation mode", errcode=Codes.FORBIDDEN)
        if not acls:
            request_content["initial_state"] = [*initial, {"type": "m.room.server_acl", "state_key": "", "content": expected}]
        if direct:
            # Room creation state is immutable. Bind every sequential initial invite to
            # the validated request rather than a racy current membership count.
            creation = dict(request_content.get("creation_content") or {})
            creation[DM_INVITEES] = list(request_content["invite"])
            request_content["creation_content"] = creation

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str) -> Any:
        if inviter == self._room_access or invitee in {self._agent, self._room_access}:
            return Codes.FORBIDDEN
        if not _is_valid_user_id(invitee):
            return Codes.FORBIDDEN
        if inviter == self._agent and self._api.is_mine(invitee):
            return NOT_SPAM
        state = await self._api.get_room_state(room_id)
        if not self._api.is_mine(invitee) and not self._partner_federation_allowed(state, invitee):
            return Codes.FORBIDDEN
        if inviter == self._agent:
            return NOT_SPAM
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
        if not self._api.is_mine(invitee) or not await self._active_dm_users(inviter, invitee):
            return Codes.FORBIDDEN
        # A new DM admits only its immutable creation-time invitees. Legacy DMs
        # without that marker retain their single first-invite boundary.
        create = state.get(("m.room.create", ""))
        creation_content = getattr(create, "content", {})
        if isinstance(creation_content, Mapping) and DM_INVITEES in creation_content:
            invitees = creation_content[DM_INVITEES]
            return NOT_SPAM if (
                create.sender == inviter
                and self._is_direct_message(inviter, {
                    "is_direct": True, "invite": list(invitees) if isinstance(invitees, (list, tuple)) else invitees,
                    "preset": "private_chat", "visibility": "private"
                })
                and invitee in invitees
            ) else Codes.FORBIDDEN
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
        if not self._api.is_mine(user) and not self._partner_federation_allowed(state, user):
            return Codes.FORBIDDEN
        if not _has_governance(content):
            return NOT_SPAM
        if not self._governance_valid(policy_event):
            return Codes.FORBIDDEN
        if user in content.get('banned', ()):
            return Codes.FORBIDDEN
        if content.get("archived", False) is not False:
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
        if type(content.get("archived", False)) is not bool:
            return False
        if type(content.get("local_only", False)) is not bool:
            return False
        for key in ("members", "exempt"):
            values = content.get(key)
            if not isinstance(values, (list, tuple)) or not all(_is_valid_user_id(value) for value in values):
                return False
        banned, muted = content.get('banned', ()), content.get('muted_until', {})
        if not isinstance(banned, (list, tuple)) or not all(_is_valid_user_id(value) for value in banned):
            return False
        if not isinstance(muted, Mapping) or not all(_is_valid_user_id(value) and isinstance(until, str) for value, until in muted.items()):
            return False
        return content["audience"] != "listed" or set(content["exempt"]) <= set(content["members"])

    def _partner_content(self, content: Any, *, allow_archived: bool = False) -> tuple[str, ...] | None:
        if not isinstance(content, Mapping):
            return None
        servers = server_list(content.get("federation_servers"))
        if not servers or self._server in servers or not set(servers) <= self._federation_servers:
            return None
        if not (
            type(content.get("version")) is int and content["version"] == 1
            and content.get("kind") == "text"
            and content.get("allow_member_invites") is True
            and content.get("allow_federated_invites") is True
            and content.get("local_only") is False
            and content.get("audience") == "all"
            and content.get("read_only") is False
            and (content.get("archived", False) is False or (allow_archived and content.get("archived") is True))
        ):
            return None
        return servers

    def _partner_federation_allowed(self, state: Any, user: str | None = None) -> bool:
        """A room cannot acquire federation by changing a mutable policy on a legacy room."""
        policy = state.get(("io.kodera.room.policy", ""))
        create = state.get(("m.room.create", ""))
        partners = self._partner_content(getattr(policy, "content", None))
        expected = acl(self._server, partners or ())
        return (
            getattr(policy, "sender", None) == self._agent
            and getattr(create, "sender", None) == self._agent
            and creation_mode(getattr(create, "content", None)) == "partner"
            and partners is not None and self._governance_valid(policy)
            and getattr(state.get(("m.room.server_acl", "")), "sender", None) == self._agent
            and acl_matches(getattr(state.get(("m.room.server_acl", "")), "content", None), expected)
            and (user is None or (_is_valid_user_id(user) and user.partition(":")[2] in partners))
        )

    def _federation_boundary_allows(self, event: Any, state: Any) -> bool:
        # This runs before the administrative account's governance exemption. A local
        # service may reconcile local users and remove remote users, never bypass a room's
        # remote admission boundary. Matrix's native event authorization still applies.
        create = state.get(("m.room.create", ""))
        creation = getattr(create, "content", None)
        if event.type == "io.kodera.room.policy" and event.content.get("allow_federated_invites") is True:
            if creation_mode(creation) != "partner" or self._partner_content(event.content, allow_archived=True) is None:
                return False
        if creation_mode(creation) == "partner" and event.type == "m.room.join_rules" and event.content.get('join_rule') != "invite":
            return False
        if event.type == "m.room.server_acl":
            policy = state.get(("io.kodera.room.policy", ""))
            partners = self._partner_content(getattr(policy, "content", None)) if creation_mode(creation) == "partner" else ()
            # Synapse checks the initial ACL before the initial policy is visible. The creation
            # hook binds its exact approved servers immutably. This bootstrap admits no remote
            # membership: admission still requires the complete trusted policy and ACL state.
            if policy is None and creation_mode(creation) == "partner":
                partners = server_list(creation.get("io.kodera.room.initial_partner_servers"))
                if event.sender != self._agent or getattr(create, "sender", None) != self._agent or not partners or self._server in partners or not set(partners) <= self._federation_servers:
                    return False
            if not acl_matches(event.content, acl(self._server, partners or ())):
                return False
        membership = event.content.get("membership") if event.type == "m.room.member" else None
        target = getattr(event, "state_key", None)
        if membership in {"join", "invite", "knock"}:
            if not _is_valid_user_id(target) or not self._api.is_mine(target):
                if not self._partner_federation_allowed(state, target):
                    return False
        if not self._api.is_mine(event.sender):
            if membership == "leave" and target == event.sender:
                return True
            return self._partner_federation_allowed(state, event.sender)
        return True

    def _governance_allows(self, event: Any, state: Any) -> bool:
        if not self._federation_boundary_allows(event, state):
            return False
        if event.sender == self._agent:
            return True
        policy_event = state.get(("io.kodera.room.policy", ""))
        content = getattr(policy_event, "content", None)
        if not _has_governance(content):
            return True
        if not self._governance_valid(policy_event):
            return False
        if event.sender in content.get('banned', ()):
            return event.type == 'm.room.member' and getattr(event, 'state_key', None) == event.sender and event.content.get('membership') == 'leave'
        if event.type == 'm.room.member' and event.content.get('membership') in {'join', 'invite', 'knock'} and getattr(event, 'state_key', None) in content.get('banned', ()):
            return False
        if event.type in {'m.room.message', 'm.sticker'} and _active_mute(content, event.sender):
            return False
        if content.get("archived") is True:
            own_leave = (
                event.type == "m.room.member" and getattr(event, "state_key", None) == event.sender
                and event.content.get("membership") == "leave"
            )
            return own_leave or (event.type == OCCUPANCY and event.sender == self._room_access)
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
        key in content for key in ("read_only", "audience", "members", "exempt", "banned", "muted_until")
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


def _active_mute(content: Mapping, user: str) -> bool:
    from datetime import UTC, datetime
    value = content.get('muted_until', {}).get(user)
    if value is None:
        return False
    try:
        until = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return until.tzinfo is None or until > datetime.now(UTC)
    except (TypeError, ValueError, AttributeError):
        return True
