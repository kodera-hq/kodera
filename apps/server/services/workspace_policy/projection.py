"""Fail-closed permission decisions over a trusted, coherent authority snapshot."""

from typing import Literal, TypedDict, cast

Reason = Literal[
    "allow", "not_found", "unavailable", "projection_unavailable", "forbidden", "archived"
]


class Decision(TypedDict):
    allowed: bool
    reason: Reason


class _Snapshot(TypedDict):
    actor_org: str
    resource_org: str
    member_id: str
    active_member: bool
    resolved: bool
    is_dm: bool
    authority_revision: int
    projected_authority_revision: int
    policy_revision: int
    projected_policy_revision: int
    projection_state: str
    eligible: list[str]
    denied: list[str]
    action: str
    kind: str
    lifecycle: str
    visibility: str
    role_ids: list[str]
    allow_members: list[str]
    allow_roles: list[str]
    deny_members: list[str]
    deny_roles: list[str]
    dm_members: list[str]


_HISTORY_ACTIONS = frozenset(
    {
        "channel.history",
        "message.search",
        "message.reply",
        "message.edit_own",
        "message.delete_own",
        "message.delete_any",
        "message.react",
        "message.pin",
        "file.read",
        "file.delete_own",
        "file.delete_any",
    }
)
_TEXT_ACTIONS = _HISTORY_ACTIONS | {"message.post", "file.upload"}
_MEDIA_PUBLISH_ACTIONS = frozenset({"media.speak", "media.video", "media.share"})
_MEDIA_ACTIONS = _MEDIA_PUBLISH_ACTIONS | {"media.connect", "media.moderate"}
_CAPABILITIES = _TEXT_ACTIONS | _MEDIA_ACTIONS | {"channel.view"}
_ARCHIVE_READS = frozenset({"channel.view", "channel.history", "message.search", "file.read"})
_STRINGS = frozenset(
    {
        "actor_org",
        "resource_org",
        "member_id",
        "action",
        "kind",
        "lifecycle",
        "visibility",
        "projection_state",
    }
)
_BOOLEANS = frozenset({"active_member", "resolved", "is_dm"})
_REVISIONS = frozenset(
    {
        "authority_revision",
        "projected_authority_revision",
        "policy_revision",
        "projected_policy_revision",
    }
)
_LISTS = frozenset(
    {
        "eligible",
        "denied",
        "role_ids",
        "allow_members",
        "allow_roles",
        "deny_members",
        "deny_roles",
        "dm_members",
    }
)
_FIELDS = _STRINGS | _BOOLEANS | _REVISIONS | _LISTS
_ENUMS = {
    "action": _CAPABILITIES,
    "kind": frozenset({"text", "audio"}),
    "visibility": frozenset({"organisation", "restricted"}),
    "projection_state": frozenset({"pending", "ready", "failed"}),
    "lifecycle": frozenset({"provisioning", "active", "archived", "deletion_pending", "deleted"}),
}


def _nonblank(value: object) -> bool:
    return type(value) is str and bool(value.strip())


def _string_list(value: object) -> bool:
    if type(value) is not list or not all(_nonblank(item) for item in value):
        return False
    return len(value) == len(set(value))


def _validated(value: object) -> _Snapshot | None:
    if type(value) is not dict or set(value) != _FIELDS:
        return None
    data = cast(dict[str, object], value)
    if not all(_nonblank(data[field]) for field in _STRINGS):
        return None
    if not all(type(data[field]) is bool for field in _BOOLEANS):
        return None
    for field in _REVISIONS:
        revision = data[field]
        if type(revision) is not int or revision <= 0:
            return None
    if not all(_string_list(data[field]) for field in _LISTS):
        return None
    for field, choices in _ENUMS.items():
        if data[field] not in choices:
            return None
    snapshot = cast(_Snapshot, value)
    if not set(snapshot["eligible"]) <= _CAPABILITIES:
        return None
    if not set(snapshot["denied"]) <= _CAPABILITIES:
        return None
    if snapshot["is_dm"]:
        if snapshot["kind"] != "text" or len(snapshot["dm_members"]) != 2:
            return None
    elif snapshot["dm_members"]:
        return None
    return snapshot


def _decision(reason: Reason) -> Decision:
    return {"allowed": reason == "allow", "reason": reason}


def evaluate(value: object) -> Decision:
    """Intersect authority, resource access, prerequisites and lifecycle without I/O.

    Snapshot validation does not authenticate its source or establish freshness.
    Callers must resolve current authority and enforce message author/parent,
    active DM pair and operation/revocation fencing at the real service boundary.
    """
    snapshot = _validated(value)
    if snapshot is None or not snapshot["resolved"]:
        return _decision("unavailable")
    if not snapshot["active_member"] or snapshot["actor_org"] != snapshot["resource_org"]:
        return _decision("not_found")
    member = snapshot["member_id"]
    roles = set(snapshot["role_ids"])
    if member in snapshot["deny_members"] or roles.intersection(snapshot["deny_roles"]):
        return _decision("not_found")
    if snapshot["is_dm"]:
        if member not in snapshot["dm_members"]:
            return _decision("not_found")
    elif (
        snapshot["visibility"] == "restricted"
        and member not in snapshot["allow_members"]
        and not roles.intersection(snapshot["allow_roles"])
    ):
        return _decision("not_found")
    if (
        snapshot["projection_state"] != "ready"
        or snapshot["authority_revision"] != snapshot["projected_authority_revision"]
        or snapshot["policy_revision"] != snapshot["projected_policy_revision"]
    ):
        return _decision("projection_unavailable")
    action = snapshot["action"]
    required = {"channel.view", action}
    if action in _HISTORY_ACTIONS:
        required.add("channel.history")
    if action in _MEDIA_PUBLISH_ACTIONS:
        required.add("media.connect")
    if not required.issubset(snapshot["eligible"]) or required.intersection(snapshot["denied"]):
        return _decision("forbidden")
    if (action in _MEDIA_ACTIONS and snapshot["kind"] != "audio") or (
        action in _TEXT_ACTIONS and snapshot["kind"] != "text"
    ):
        return _decision("forbidden")
    if snapshot["lifecycle"] not in {"active", "archived"}:
        return _decision("unavailable")
    if snapshot["lifecycle"] == "archived" and (
        snapshot["kind"] == "audio" or action not in _ARCHIVE_READS
    ):
        return _decision("archived")
    return _decision("allow")
