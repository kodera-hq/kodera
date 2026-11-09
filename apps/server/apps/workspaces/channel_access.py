"""A channel's access, read and changed as a whole: docs/specs/ESPACE_STRUCTURE.md §§2.1, 6, 9.

The access is one document over the stored policy model: `mode` is `Channel.policy_mode`,
`visibility` the resolved `ResourcePolicy`'s, the two member lists its `allow_member` and
`deny_member` rules, and each flag its set of `deny_capability` rules. With `inherit`, the
document describes the policy the channel resolves to (its category's default, else the
workspace's), read-only. `explicit` gives the channel a policy of its own, created when it was
inheriting; `inherit` detaches it, and the detached policy is kept: policies are never deleted.
Every rule write raises the policy's revision through the database's trigger.

The access tag covers `(channel_id, policy_mode, policy_id, policy_revision)`: a revision alone is
not identity. A caller who could not view the channel before the change and can after it granted
themselves: the change is audited with `self_grant: true`, and a pending notice is stored for the
next channel membership set, which the tenant agent posts in the channel once (AUTHZ.md §6 rule 8).

The channel set's input, built from this access, is `channel_sets.channel_set_input` (§13).
"""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.db.models import F
from django.utils import timezone

from apps.orgs.selectors import current_member_roles
from services.identity.access_tokens import VerifiedAccessToken
from services.workspace_policy.projection import evaluate

from .administration import (
    Fields,
    StructureInvalidError,
    Write,
    channel_row,
    emit,
    found,
    precondition,
    read_caller,
    record,
    require_administrator,
    tag,
    unchanged,
)
from .models import (
    Category,
    Channel,
    ChannelNotice,
    ResourcePolicy,
    ResourcePolicyRule,
    Workspace,
)
from .structure import WorkspaceNotFoundError, WorkspaceUnavailableError

VIEW = "channel.view"
# §6: what each flag denies to `org_member` and `org_billing`.
READ_ONLY = ("file.upload", "message.edit_own", "message.post", "message.reply")
LISTEN_ONLY = ("media.share", "media.speak", "media.video")
# The capability sets the two flags add or remove, whole, when a flag changes; every other stored
# deny, and a partial set, is kept as it is.
FLAGS = (("read_only", frozenset(READ_ONLY)), ("listen_only", frozenset(LISTEN_ONLY)))
FIELDS = ("mode", "visibility", "allow_members", "deny_members", "read_only", "listen_only")
INHERIT = Channel.PolicyMode.INHERIT
EXPLICIT = Channel.PolicyMode.EXPLICIT


@dataclass(frozen=True, slots=True)
class Access:
    channel_id: UUID
    kind: str
    lifecycle: str
    mode: str
    policy_id: UUID
    revision: int
    visibility: str
    allow_members: tuple[UUID, ...]
    deny_members: tuple[UUID, ...]
    denied: frozenset[str]

    @property
    def read_only(self) -> bool:
        return set(READ_ONLY) <= self.denied

    @property
    def listen_only(self) -> bool:
        return set(LISTEN_ONLY) <= self.denied

    @property
    def etag(self) -> str:
        return tag(
            {
                "channel_id": str(self.channel_id),
                "policy_mode": self.mode,
                "policy_id": str(self.policy_id),
                "policy_revision": self.revision,
            }
        )

    def document(self) -> dict[str, object]:
        """The access as the contract's `ChannelAccess`, member lists in a stable order."""
        return {
            "channel_id": str(self.channel_id),
            "mode": self.mode,
            "visibility": self.visibility,
            "allow_members": [str(member) for member in self.allow_members],
            "deny_members": [str(member) for member in self.deny_members],
            "read_only": self.read_only,
            "listen_only": self.listen_only,
        }


def _members(ids: set[UUID]) -> tuple[UUID, ...]:
    return tuple(sorted(ids, key=str))


def resolve(channel_id: UUID, *, inherit: bool = False) -> Access:
    """The access of a channel as stored; with `inherit`, the policy it would inherit."""
    channel = Channel.objects.select_related("category", "workspace").get(id=channel_id)
    if channel.policy_mode == EXPLICIT and not inherit:
        policy_id = channel.explicit_policy_id
    elif channel.category is not None and channel.category.default_policy_id is not None:
        policy_id = channel.category.default_policy_id
    else:
        policy_id = channel.workspace.default_policy_id
    if policy_id is None:
        raise WorkspaceUnavailableError()
    policy = ResourcePolicy.objects.filter(id=policy_id, workspace_id=channel.workspace_id).first()
    if policy is None:
        raise WorkspaceUnavailableError()
    allow: set[UUID] = set()
    deny: set[UUID] = set()
    denied: set[str] = set()
    for kind, member, capability in ResourcePolicyRule.objects.filter(policy=policy).values_list(
        "kind", "membership_id", "capability"
    ):
        if kind == ResourcePolicyRule.Kind.ALLOW_MEMBER and member is not None:
            allow.add(member)
        elif kind == ResourcePolicyRule.Kind.DENY_MEMBER and member is not None:
            deny.add(member)
        elif kind == ResourcePolicyRule.Kind.DENY_CAPABILITY and capability is not None:
            denied.add(capability)
        else:
            raise WorkspaceUnavailableError()
    return Access(
        channel_id=channel.id,
        kind=channel.kind,
        lifecycle=channel.lifecycle,
        mode=INHERIT if inherit else channel.policy_mode,
        policy_id=policy.id,
        revision=policy.revision,
        visibility=policy.visibility,
        allow_members=_members(allow),
        deny_members=_members(deny),
        denied=frozenset(denied),
    )


@dataclass(frozen=True, slots=True)
class _Rules:
    allow: set[UUID]
    deny: set[UUID]
    denied: set[str]


def _rules(policy_ids: set[UUID]) -> dict[UUID, _Rules]:
    rules = {pk: _Rules(set(), set(), set()) for pk in policy_ids}
    for policy_id, kind, member, capability in ResourcePolicyRule.objects.filter(
        policy_id__in=policy_ids
    ).values_list("policy_id", "kind", "membership_id", "capability"):
        if kind == ResourcePolicyRule.Kind.ALLOW_MEMBER and member is not None:
            rules[policy_id].allow.add(member)
        elif kind == ResourcePolicyRule.Kind.DENY_MEMBER and member is not None:
            rules[policy_id].deny.add(member)
        elif kind == ResourcePolicyRule.Kind.DENY_CAPABILITY and capability is not None:
            rules[policy_id].denied.add(capability)
        else:
            raise WorkspaceUnavailableError()
    return rules


def resolve_all(workspace_id: UUID) -> dict[UUID, tuple[Access, str, str]]:
    """Every non-deleted channel's access, with its name and topic, in four queries: what
    `resolve` returns channel by channel, for the channel set's input (ESPACE_STRUCTURE.md §13)."""
    default = Workspace.objects.values_list("default_policy_id", flat=True).get(id=workspace_id)
    category_defaults = dict(
        Category.objects.filter(workspace_id=workspace_id).values_list("id", "default_policy_id")
    )
    channels = list(
        Channel.objects.filter(workspace_id=workspace_id)
        .exclude(lifecycle=Channel.Lifecycle.DELETED)
        .values_list(
            "id",
            "kind",
            "lifecycle",
            "policy_mode",
            "explicit_policy_id",
            "category_id",
            "name",
            "topic",
        )
    )
    chosen: dict[UUID, UUID] = {}
    for pk, _, _, mode, explicit, category_id, _, _ in channels:
        inherited = category_defaults.get(category_id) if category_id is not None else None
        policy_id = explicit if mode == EXPLICIT else inherited or default
        if policy_id is None:
            raise WorkspaceUnavailableError()
        chosen[pk] = policy_id
    policies = {
        pk: (revision, visibility)
        for pk, revision, visibility in ResourcePolicy.objects.filter(
            workspace_id=workspace_id, id__in=set(chosen.values())
        ).values_list("id", "revision", "visibility")
    }
    rules = _rules(set(policies))
    found = {}
    for pk, kind, lifecycle, mode, _, _, name, topic in channels:
        policy_id = chosen[pk]
        if policy_id not in policies:
            raise WorkspaceUnavailableError()
        revision, visibility = policies[policy_id]
        rule = rules[policy_id]
        access = Access(
            channel_id=pk,
            kind=kind,
            lifecycle=lifecycle,
            mode=mode,
            policy_id=policy_id,
            revision=revision,
            visibility=visibility,
            allow_members=_members(rule.allow),
            deny_members=_members(rule.deny),
            denied=frozenset(rule.denied),
        )
        found[pk] = (access, name, topic)
    return found


def may_view(
    access: Access,
    *,
    organisation_id: UUID,
    membership_id: UUID,
    authority_revision: int,
) -> bool:
    """`channel.view` for one current active membership on the access alone, by the projection
    kernel over Core's own current revisions, as `getWorkspace` evaluates it (AUTHZ.md §6 rule 8).
    The lifecycle is not part of the question: an archived channel, an audio room included, keeps
    the viewers its access gives it, so a self-grant on it is a self-grant and its room is not
    emptied (ESPACE_STRUCTURE.md §§2.1, 9)."""
    decision = evaluate(
        {
            "actor_org": str(organisation_id),
            "resource_org": str(organisation_id),
            "member_id": str(membership_id),
            "active_member": True,
            "resolved": True,
            "is_dm": False,
            "authority_revision": authority_revision,
            "projected_authority_revision": authority_revision,
            "policy_revision": access.revision,
            "projected_policy_revision": access.revision,
            "projection_state": "ready",
            "eligible": [VIEW],
            "denied": sorted(access.denied),
            "action": VIEW,
            "kind": access.kind,
            # A plain string: the kernel admits only exact `str` values.
            "lifecycle": "active",
            "visibility": access.visibility,
            "role_ids": [],
            "allow_members": [str(member) for member in access.allow_members],
            "allow_roles": [],
            "deny_members": [str(member) for member in access.deny_members],
            "deny_roles": [],
            "dm_members": [],
        }
    )
    return decision["allowed"]


def read_access(
    *, verified: VerifiedAccessToken, organisation_id: UUID, channel_id: UUID
) -> Access:
    """getChannelAccess, in a REPEATABLE READ READ ONLY snapshot of its own (§§2.1, 6)."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("the access read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        require_administrator(read_caller(verified, organisation_id))
        workspace_id = (
            Workspace.objects.filter(organisation_id=organisation_id)
            .values_list("id", flat=True)
            .first()
        )
        if workspace_id is None:
            raise WorkspaceNotFoundError()
        row = found(channel_row(workspace_id, channel_id))
        return resolve(row.id)


@dataclass(frozen=True, slots=True)
class _Document:
    mode: str
    visibility: str
    allow_members: tuple[UUID, ...]
    deny_members: tuple[UUID, ...]
    read_only: bool
    listen_only: bool


def _document(body: dict[str, Any]) -> _Document:
    fields = Fields(body, required=FIELDS, optional=())
    document = _Document(
        mode=fields.choice("mode", (INHERIT, EXPLICIT)),
        visibility=fields.choice("visibility", tuple(ResourcePolicy.Visibility.values)),
        allow_members=fields.members("allow_members"),
        deny_members=fields.members("deny_members"),
        read_only=fields.boolean("read_only"),
        listen_only=fields.boolean("listen_only"),
    )
    fields.done()
    return document


def _validate(document: _Document, current: Access, inherited: Access, organisation: UUID) -> None:
    """§6's `422`s. A membership already on a list may stay there: only an added one must be a
    current membership, so a suspended member stays denied."""
    errors: list[tuple[str, str]] = []
    if document.read_only and current.kind != Channel.Kind.TEXT:
        errors.append(("/read_only", "not_applicable"))
    if document.listen_only and current.kind != Channel.Kind.AUDIO:
        errors.append(("/listen_only", "not_applicable"))
    if document.visibility == ResourcePolicy.Visibility.ORGANISATION and document.allow_members:
        errors.append(("/allow_members", "not_restricted"))
    if set(document.allow_members) & set(document.deny_members):
        errors.append(("/deny_members", "allowed_and_denied"))
    members = current_member_roles(organisation_id=organisation)
    for key, wanted, stored in (
        ("allow_members", document.allow_members, current.allow_members),
        ("deny_members", document.deny_members, current.deny_members),
    ):
        if any(member not in members for member in set(wanted) - set(stored)):
            errors.append((f"/{key}", "not_a_member"))
    if document.mode == INHERIT:
        for key, value, resolved in (
            ("visibility", document.visibility, inherited.visibility),
            ("allow_members", set(document.allow_members), set(inherited.allow_members)),
            ("deny_members", set(document.deny_members), set(inherited.deny_members)),
            ("read_only", document.read_only, inherited.read_only),
            ("listen_only", document.listen_only, inherited.listen_only),
        ):
            if value != resolved:
                errors.append((f"/{key}", "inherited"))
    if errors:
        raise StructureInvalidError(errors)


def _capabilities(document: _Document, base: Access) -> set[str]:
    """The denies the document leaves: `base`'s, every one of them, with a flag's whole set added
    when the flag turns on and removed when it turns off. An unchanged flag touches nothing, so a
    partial set survives, and a flag turned on then off restores what was there before."""
    denied = set(base.denied)
    for flag, capabilities in FLAGS:
        wanted, had = getattr(document, flag), capabilities <= base.denied
        if wanted and not had:
            denied |= capabilities
        elif had and not wanted:
            denied -= capabilities
    return denied


def _write_rules(policy_id: UUID, stored: Access | None, document: _Document, base: Access) -> None:
    """Bring the policy's rules to the document: delete what goes, insert what comes. `stored` is
    the policy's own rules, None for a new policy; `base` is the access the change starts from,
    the inherited one when the channel goes explicit, whose denies the new policy copies."""
    kinds = ResourcePolicyRule.Kind
    for kind, wanted, had in (
        (
            kinds.ALLOW_MEMBER,
            set(document.allow_members),
            set(stored.allow_members if stored else ()),
        ),
        (kinds.DENY_MEMBER, set(document.deny_members), set(stored.deny_members if stored else ())),
    ):
        ResourcePolicyRule.objects.filter(
            policy_id=policy_id, kind=kind, membership_id__in=had - wanted
        ).delete()
        for member in sorted(wanted - had, key=str):
            ResourcePolicyRule.objects.create(policy_id=policy_id, kind=kind, membership_id=member)
    capabilities = _capabilities(document, base)
    held = set(stored.denied) if stored else set()
    ResourcePolicyRule.objects.filter(
        policy_id=policy_id, kind=kinds.DENY_CAPABILITY, capability__in=held - capabilities
    ).delete()
    for capability in sorted(capabilities - held):
        ResourcePolicyRule.objects.create(
            policy_id=policy_id, kind=kinds.DENY_CAPABILITY, capability=capability
        )


def _same(document: _Document, access: Access) -> bool:
    return (
        document.mode == access.mode
        and document.visibility == access.visibility
        and set(document.allow_members) == set(access.allow_members)
        and set(document.deny_members) == set(access.deny_members)
        and document.read_only == access.read_only
        and document.listen_only == access.listen_only
    )


def change_access(
    *, write: Write, channel_id: UUID, body: dict[str, Any], if_match: str | None
) -> Access:
    """patchChannelAccess, in the caller's transaction after `begin`."""
    document = _document(body)
    row = found(channel_row(write.workspace_id, channel_id))
    current = resolve(row.id)
    precondition(if_match, current.etag, required=True)
    caller = write.caller
    _validate(document, current, resolve(row.id, inherit=True), caller.organisation_id)
    if _same(document, current):
        unchanged()
        return current
    if document.mode == INHERIT:
        # Detached, never deleted: the old policy stays, and going explicit again makes a new one.
        Channel.objects.filter(id=row.id).update(
            policy_mode=INHERIT,
            explicit_policy=None,
            version=F("version") + 1,
            updated_at=timezone.now(),
        )
    elif current.mode == INHERIT:
        policy = ResourcePolicy.objects.create(
            workspace_id=write.workspace_id, visibility=document.visibility
        )
        # A channel's own policy starts as the one it inherited, every deny included.
        _write_rules(policy.id, None, document, current)
        Channel.objects.filter(id=row.id).update(
            policy_mode=EXPLICIT,
            explicit_policy=policy,
            version=F("version") + 1,
            updated_at=timezone.now(),
        )
    else:
        if document.visibility != current.visibility:
            ResourcePolicy.objects.filter(id=current.policy_id).update(
                visibility=document.visibility
            )
        _write_rules(current.policy_id, current, document, current)
    after = resolve(row.id)

    def viewed(state: Access) -> bool:
        return may_view(
            state,
            organisation_id=caller.organisation_id,
            membership_id=caller.membership_id,
            authority_revision=caller.authority_revision,
        )

    self_grant = not viewed(current) and viewed(after)
    if self_grant:
        # At most one pending notice per member and channel (channel_notice_pending_unique).
        ChannelNotice.objects.bulk_create(
            [ChannelNotice(channel_id=row.id, membership_id=caller.membership_id)],
            ignore_conflicts=True,
        )
    metadata: dict[str, object] = {
        "channel_id": str(row.id),
        "kind": row.kind,
        "mode": after.mode,
        "visibility": after.visibility,
        "read_only": after.read_only,
        "listen_only": after.listen_only,
        "etag": after.etag,
    }
    for key, before, now in (
        ("allow_members", current.allow_members, after.allow_members),
        ("deny_members", current.deny_members, after.deny_members),
    ):
        metadata[f"{key}_added"] = [str(m) for m in _members(set(now) - set(before))]
        metadata[f"{key}_removed"] = [str(m) for m in _members(set(before) - set(now))]
    if self_grant:
        metadata["self_grant"] = True
    record(write, "workspace.channel_access_changed", row.id, metadata)
    emit(write, "channel.access_changed")
    return after
