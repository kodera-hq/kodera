"""getWorkspace: the structure the caller may view, and the setup state.

docs/specs/PILOT_WORKSPACE_ONBOARDING.md §5 and docs/api/AUTHZ.md §6 rule 8. The caller, the setup
facts and every row are read in one REPEATABLE READ READ ONLY snapshot this module owns. Each
channel is shown only when the projection kernel allows `channel.view` over the caller's facts and
the channel's resolved policy (its explicit policy, else its category's default, else the
workspace's). The kernel's projection gate is given Core's own current revisions with
`projection_state = ready`: this read is served by the system of record, not by a projection.
Each channel also carries its stored `room_state`, whether its Matrix room exists
(docs/specs/ESPACE_STRUCTURE.md §5); the structure read itself does not depend on it.
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction

from apps.legal.services import has_accepted_agreements
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken
from services.workspace_policy.projection import evaluate

from .models import Category, Channel, ResourcePolicy, ResourcePolicyRule, Workspace
from .setup import Setup, read_setup

# AUTHZ.md §5, row Workspace: every tenant role reads its own organisation's structure, and
# org_owner and org_admin initialise it.
READING_ROLES = frozenset({"org_owner", "org_admin", "org_billing", "org_member"})
INITIALISING_ROLES = frozenset({"org_owner", "org_admin"})
VIEW = "channel.view"


class WorkspaceCallerUnknownError(Exception):
    """The verified token names no enabled identity: `403 identity-unknown`."""


class WorkspaceNotFoundError(Exception):
    """Not the caller's organisation, or no current membership in it: `404`."""


class WorkspaceUnavailableError(Exception):
    """A stored row this read relies on is missing or out of its vocabulary: never guessed."""


@dataclass(frozen=True, slots=True)
class ChannelView:
    id: UUID
    kind: str
    name: str
    template_key: str | None
    topic: str
    lifecycle: str
    room_state: str


@dataclass(frozen=True, slots=True)
class CategoryView:
    id: UUID
    name: str
    template_key: str | None
    channels: tuple[ChannelView, ...]


@dataclass(frozen=True, slots=True)
class WorkspaceView:
    organisation_id: UUID
    setup: Setup
    can_initialise: bool
    workspace_id: UUID | None
    categories: tuple[CategoryView, ...]
    uncategorised_channels: tuple[ChannelView, ...]


@dataclass(frozen=True, slots=True)
class _Policy:
    visibility: str
    revision: int
    allow_members: tuple[str, ...]
    deny_members: tuple[str, ...]
    denied: tuple[str, ...]


def _require_reading_role(caller: TenantCaller) -> None:
    """Refuse a caller whose stored role is outside the four reading roles."""
    if caller.role not in READING_ROLES:
        raise WorkspaceNotFoundError()


def read_workspace(*, verified: VerifiedAccessToken, organisation_id: UUID) -> WorkspaceView:
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("the workspace read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        try:
            caller = read_tenant_caller(
                verified=verified, organisation_id=organisation_id, allow_community=True
            )
        except TenantCallerUnknownError:
            raise WorkspaceCallerUnknownError() from None
        except TenantCallerNotFoundError:
            raise WorkspaceNotFoundError() from None
        _require_reading_role(caller)
        setup = read_setup(organisation_id=organisation_id, issuer=caller.issuer)
        workspace = (
            Workspace.objects.filter(organisation_id=organisation_id)
            .values_list("id", "organisation_id", "default_policy_id")
            .first()
        )
        if workspace is None:
            return WorkspaceView(
                organisation_id=organisation_id,
                setup=setup,
                can_initialise=(
                    caller.role in INITIALISING_ROLES
                    and caller.organisation_state == "active"
                    and setup.state == "ready"
                    and has_accepted_agreements(organisation_id=organisation_id)
                ),
                workspace_id=None,
                categories=(),
                uncategorised_channels=(),
            )
        from .moderation import member_restrictions

        if member_restrictions(workspace[0], caller.membership_id)[0]:
            raise WorkspaceNotFoundError()
        categories, uncategorised = _visible_structure(caller, *workspace)
        return WorkspaceView(
            organisation_id=organisation_id,
            setup=setup,
            can_initialise=False,
            workspace_id=workspace[0],
            categories=categories,
            uncategorised_channels=uncategorised,
        )


def _visible_structure(
    caller: TenantCaller, workspace_id: UUID, owner: UUID, default_policy_id: UUID | None
) -> tuple[tuple[CategoryView, ...], tuple[ChannelView, ...]]:
    categories = list(
        Category.objects.filter(workspace_id=workspace_id)
        .order_by("position", "id")
        .values_list("id", "name", "template_key", "default_policy_id")
    )
    channels = list(
        Channel.objects.filter(workspace_id=workspace_id)
        .order_by("position", "id")
        .values_list(
            "id",
            "category_id",
            "kind",
            "name",
            "template_key",
            "topic",
            "lifecycle",
            "policy_mode",
            "explicit_policy_id",
            "room_state",
        )
    )
    category_defaults = {row[0]: row[3] for row in categories}
    wanted = {default_policy_id, *category_defaults.values(), *(row[8] for row in channels)}
    policies = _policies(workspace_id, {pk for pk in wanted if pk is not None})

    def policy(pk: UUID | None) -> _Policy:
        if pk is None or pk not in policies:
            raise WorkspaceUnavailableError()
        return policies[pk]

    def may_view(resolved: _Policy, kind: str, lifecycle: str) -> bool:
        # An archived channel, an audio room included, is shown as archived to whoever its access
        # admits: visibility is a question of access, and the lifecycle is reported, not
        # evaluated (ESPACE_STRUCTURE.md §§3, 5). Any other lifecycle stays unavailable.
        evaluated = "active" if lifecycle == "archived" else lifecycle
        return _allowed(caller, owner, resolved, kind=kind, lifecycle=evaluated)

    visible: dict[UUID | None, list[ChannelView]] = {}
    for pk, category_id, kind, name, key, topic, lifecycle, mode, explicit, room in channels:
        if category_id is not None and category_id not in category_defaults:
            raise WorkspaceUnavailableError()
        if mode == Channel.PolicyMode.EXPLICIT:
            resolved = policy(explicit)
        elif mode == Channel.PolicyMode.INHERIT and explicit is None:
            inherited = category_defaults.get(category_id) if category_id is not None else None
            resolved = policy(inherited if inherited is not None else default_policy_id)
        else:
            raise WorkspaceUnavailableError()
        if may_view(resolved, kind, lifecycle):
            visible.setdefault(category_id, []).append(
                ChannelView(pk, kind, name, key, topic, lifecycle, room)
            )

    shown = []
    for pk, name, key, category_default in categories:
        own = visible.get(pk, [])
        # A channel created in it now: a text channel, active, under the category's resolution.
        creatable = policy(category_default if category_default is not None else default_policy_id)
        if own or may_view(creatable, "text", "active"):
            shown.append(CategoryView(pk, name, key, tuple(own)))
    return tuple(shown), tuple(visible.get(None, []))


def _policies(workspace_id: UUID, ids: set[UUID]) -> dict[UUID, _Policy]:
    rules: dict[UUID, dict[str, set[str]]] = {
        pk: {"allow": set(), "deny": set(), "denied": set()} for pk in ids
    }
    for policy_id, kind, membership_id, capability in ResourcePolicyRule.objects.filter(
        policy_id__in=ids
    ).values_list("policy_id", "kind", "membership_id", "capability"):
        if kind == ResourcePolicyRule.Kind.ALLOW_MEMBER and membership_id is not None:
            rules[policy_id]["allow"].add(str(membership_id))
        elif kind == ResourcePolicyRule.Kind.DENY_MEMBER and membership_id is not None:
            rules[policy_id]["deny"].add(str(membership_id))
        elif kind == ResourcePolicyRule.Kind.DENY_CAPABILITY and capability is not None:
            rules[policy_id]["denied"].add(capability)
        else:
            raise WorkspaceUnavailableError()
    return {
        pk: _Policy(
            visibility,
            revision,
            tuple(sorted(rules[pk]["allow"])),
            tuple(sorted(rules[pk]["deny"])),
            tuple(sorted(rules[pk]["denied"])),
        )
        for pk, visibility, revision in ResourcePolicy.objects.filter(
            workspace_id=workspace_id, id__in=ids
        ).values_list("id", "visibility", "revision")
    }


def _allowed(
    caller: TenantCaller, owner: UUID, policy: _Policy, *, kind: str, lifecycle: str
) -> bool:
    decision = evaluate(
        {
            "actor_org": str(caller.organisation_id),
            "resource_org": str(owner),
            "member_id": str(caller.membership_id),
            "active_member": True,
            "resolved": True,
            "is_dm": False,
            "authority_revision": caller.authority_revision,
            "projected_authority_revision": caller.authority_revision,
            "policy_revision": policy.revision,
            "projected_policy_revision": policy.revision,
            "projection_state": "ready",
            "eligible": [VIEW],
            "denied": list(policy.denied),
            "action": VIEW,
            "kind": kind,
            "lifecycle": lifecycle,
            "visibility": policy.visibility,
            "role_ids": [],
            "allow_members": list(policy.allow_members),
            "allow_roles": [],
            "deny_members": list(policy.deny_members),
            "deny_roles": [],
            "dm_members": [],
        }
    )
    if decision["reason"] == "unavailable" and lifecycle in ("active", "archived"):
        raise WorkspaceUnavailableError()
    return decision["allowed"]
