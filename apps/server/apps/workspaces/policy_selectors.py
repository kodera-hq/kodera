"""Snapshot-bound internal policy facts; neither a permission nor a projection."""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction
from psycopg import sql

from apps.identity.selectors import current_identity, is_storable_subject
from apps.orgs.authority_selectors import (
    MemberAuthorityFacts,
    MemberAuthorityNotFoundError,
    MemberAuthorityUnavailableError,
    read_member_authority_in_snapshot,
)
from apps.orgs.selectors import active_membership_id, has_current_read_grant
from services.identity.access_tokens import VerifiedAccessToken

from .models import POLICY_CAPABILITIES, Channel, ResourcePolicy, ResourcePolicyRule


class ParentPolicyNotFoundError(Exception):
    def __init__(self) -> None:
        super().__init__("parent policy not found")


class ParentPolicyUnavailableError(Exception):
    def __init__(self) -> None:
        super().__init__("parent policy unavailable")


@dataclass(frozen=True, slots=True, repr=False)
class ParentPolicyFacts:
    organisation_id: UUID
    workspace_id: UUID
    channel_id: UUID
    membership_id: UUID
    kind: str
    lifecycle: str
    policy_id: UUID
    policy_revision: int
    selected_from: str
    visibility: str
    allow_members: tuple[UUID, ...]
    deny_members: tuple[UUID, ...]
    denied: tuple[str, ...]
    binding_fingerprint: tuple[object, ...]


# The composer's own isolation, composed rather than spelled as the standalone literal.
_COMPOSITION_ISOLATION = "REPEATABLE READ"


@dataclass(frozen=True, slots=True, repr=False)
class MemberParentPolicyFacts:
    """Member authority and parent-policy facts from one committed snapshot; no permission."""

    authority: MemberAuthorityFacts
    policy: ParentPolicyFacts


def _is_trusted_input(verified: object, channel_id: object) -> bool:
    return (
        isinstance(verified, VerifiedAccessToken)
        and isinstance(channel_id, UUID)
        and is_storable_subject(verified.subject)
    )


def resolve_parent_policy(*, verified: VerifiedAccessToken, channel_id: UUID) -> ParentPolicyFacts:
    """Resolve one stored policy in a short, independently owned read snapshot.

    The caller supplies trusted verifier output. Facts must not escape as an ACL
    response or be cached as permission; later emission needs its own real fence.
    """
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("parent policy reader requires its own transaction")
    if not _is_trusted_input(verified, channel_id):
        raise ParentPolicyNotFoundError()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return _read_parent_policy_facts(verified=verified, channel_id=channel_id)


def read_parent_policy_in_snapshot(
    *, verified: VerifiedAccessToken, channel_id: UUID
) -> ParentPolicyFacts:
    """Internal composition seam; the caller owns the same qualified read snapshot.

    Refuses, before any workspace read, a call outside an atomic block or inside one
    that is not REPEATABLE READ READ ONLY. It neither starts nor ends a transaction.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("parent policy requires a read-only repeatable-read snapshot")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')"
        )
        if cursor.fetchone() != (_COMPOSITION_ISOLATION.lower(), "on"):
            raise RuntimeError("parent policy requires a read-only repeatable-read snapshot")
    if not _is_trusted_input(verified, channel_id):
        raise ParentPolicyNotFoundError()
    return _read_parent_policy_facts(verified=verified, channel_id=channel_id)


def resolve_member_parent_policy(
    *, verified: VerifiedAccessToken, channel_id: UUID
) -> MemberParentPolicyFacts:
    """Member authority and parent policy read together in one owned read-only snapshot.

    Both records come from the same committed cut: a consumer may compare the authority
    revision, and the bound policy's id with its revision, to stored values later. The
    facts are not a permission and must not be cached as one.
    """
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("member parent policy reader requires its own transaction")
    if not _is_trusted_input(verified, channel_id):
        raise ParentPolicyNotFoundError()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("SET TRANSACTION ISOLATION LEVEL {} READ ONLY").format(
                    sql.SQL(_COMPOSITION_ISOLATION)
                )
            )
        try:
            authority = read_member_authority_in_snapshot(verified=verified)
        except MemberAuthorityNotFoundError:
            raise ParentPolicyNotFoundError() from None
        except MemberAuthorityUnavailableError:
            raise ParentPolicyUnavailableError() from None
        policy = read_parent_policy_in_snapshot(verified=verified, channel_id=channel_id)
        if (
            authority.organisation_id != policy.organisation_id
            or authority.membership_id != policy.membership_id
        ):
            raise ParentPolicyNotFoundError()
        return MemberParentPolicyFacts(authority=authority, policy=policy)


def _read_parent_policy_facts(
    *, verified: VerifiedAccessToken, channel_id: UUID
) -> ParentPolicyFacts:
    """The one policy materializer; only the two local wrappers above call it."""
    identity = current_identity(issuer=verified.issuer, subject=verified.subject)
    if identity is None:
        raise ParentPolicyNotFoundError()
    person, principal = identity
    if not has_current_read_grant(
        user_id=person.id,
        organisation_id=principal.organisation_id,
        issuer=principal.issuer,
        realm=principal.realm,
    ):
        raise ParentPolicyNotFoundError()
    # The org-read grant also supports suspended organisations. This first
    # content-policy reader has a narrower, explicitly active-only boundary.
    membership_id = active_membership_id(
        user_id=person.id, organisation_id=principal.organisation_id
    )
    if membership_id is None:
        raise ParentPolicyNotFoundError()

    # No workspace table is read until the real current-membership check.
    channel = (
        Channel.objects.select_related("workspace", "category")
        .filter(
            id=channel_id,
            workspace__organisation_id=principal.organisation_id,
        )
        .first()
    )
    if channel is None:
        raise ParentPolicyNotFoundError()
    if channel.kind not in Channel.Kind.values or channel.lifecycle not in Channel.Lifecycle.values:
        raise ParentPolicyUnavailableError()
    category = channel.category
    if channel.category_id is not None and (
        category is None or category.workspace_id != channel.workspace_id
    ):
        raise ParentPolicyUnavailableError()

    category_default = None
    workspace_default = None
    if channel.policy_mode == Channel.PolicyMode.EXPLICIT:
        policy_id = channel.explicit_policy_id
        selected_from = "channel"
    elif channel.policy_mode == Channel.PolicyMode.INHERIT and channel.explicit_policy_id is None:
        category_default = category.default_policy_id if category is not None else None
        if category_default is not None:
            policy_id = category_default
            selected_from = "category"
        else:
            workspace_default = channel.workspace.default_policy_id
            policy_id = workspace_default
            selected_from = "workspace"
    else:
        raise ParentPolicyUnavailableError()
    if policy_id is None:
        raise ParentPolicyUnavailableError()
    policy = ResourcePolicy.objects.filter(id=policy_id, workspace_id=channel.workspace_id).first()
    if (
        policy is None
        or policy.visibility not in ResourcePolicy.Visibility.values
        or policy.revision <= 0
    ):
        raise ParentPolicyUnavailableError()

    allow_members: set[UUID] = set()
    deny_members: set[UUID] = set()
    denied: set[str] = set()
    for kind, member, capability, organisation in ResourcePolicyRule.objects.filter(
        policy_id=policy.id,
    ).values_list("kind", "membership_id", "capability", "membership__organisation_id"):
        if kind in (ResourcePolicyRule.Kind.ALLOW_MEMBER, ResourcePolicyRule.Kind.DENY_MEMBER):
            if (
                member is None
                or capability is not None
                or organisation != principal.organisation_id
            ):
                raise ParentPolicyUnavailableError()
            target = allow_members if kind == ResourcePolicyRule.Kind.ALLOW_MEMBER else deny_members
            target.add(member)
        elif kind == ResourcePolicyRule.Kind.DENY_CAPABILITY:
            if member is not None or capability not in POLICY_CAPABILITIES:
                raise ParentPolicyUnavailableError()
            denied.add(capability)
        else:
            raise ParentPolicyUnavailableError()
    return ParentPolicyFacts(
        organisation_id=principal.organisation_id,
        workspace_id=channel.workspace_id,
        channel_id=channel.id,
        membership_id=membership_id,
        kind=channel.kind,
        lifecycle=channel.lifecycle,
        policy_id=policy.id,
        policy_revision=policy.revision,
        selected_from=selected_from,
        visibility=policy.visibility,
        allow_members=tuple(sorted(allow_members)),
        deny_members=tuple(sorted(deny_members)),
        denied=tuple(sorted(denied)),
        binding_fingerprint=(
            channel.workspace_id,
            channel.id,
            channel.category_id,
            channel.policy_mode,
            channel.explicit_policy_id,
            channel.lifecycle,
            category_default,
            workspace_default,
            selected_from,
            policy.id,
            policy.revision,
        ),
    )
