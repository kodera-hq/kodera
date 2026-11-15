"""Operation-owned authority fences and bounded current-peer reconciliation."""

from __future__ import annotations

from uuid import UUID

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import connection

from apps.identity.selectors import active_organisation_identities, identity_user_ids
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.orgs.authority_selectors import (
    active_organisation_member_ids,
    active_organisation_memberships_by_user,
    organisation_issuer_realm,
)
from apps.orgs.community import is_community
from apps.workspaces.selectors import (
    restricted_workspace_membership_ids,
    workspace_organisation,
)
from services.identity.access_tokens import VerifiedAccessToken
from services.identity.trusted_issuers import is_trusted_issuer

from .broker_rpc import BrokerGateway
from .services import ProximityBroker, ProximityRefusalError, authorise_proximity_workspace

# Fail closed before taking an excessive number of PostgreSQL advisory locks. This is an
# operation capacity, not permission to omit any participant from a successful response.
MAX_DISCLOSURE_PRINCIPALS = 512


def _unavailable() -> ProximityRefusalError:
    return ProximityRefusalError(503, reason="proximity_authority_unavailable")


def _inventory(broker: ProximityBroker | BrokerGateway, workspace_id: UUID) -> set[UUID]:
    inventory = broker.inventory(workspace_id=workspace_id)
    values = inventory.get("principal_keys")
    if (
        set(inventory) != {"principal_keys"}
        or not isinstance(values, list)
        or len(values) > MAX_DISCLOSURE_PRINCIPALS
    ):
        raise _unavailable()
    result = set()
    try:
        for value in values:
            if not isinstance(value, str) or str(UUID(value)) != value or UUID(value).int == 0:
                raise ValueError("invalid private principal")
            result.add(UUID(value))
    except (ValueError, TypeError):
        raise _unavailable() from None
    if len(result) != len(values):
        raise _unavailable()
    return result


def _users(identities: set[UUID]) -> set[UUID]:
    return identity_user_ids(identity_ids=identities)


def _try_privacy_fence(prefix: str, identifier: UUID) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_try_advisory_xact_lock_shared(hashtextextended(%s||%s::text,0))",
            [prefix, identifier],
        )
        if cursor.fetchone()[0] is not True:
            raise _unavailable()


def _freeze_restrictions(organisation_id: UUID, workspace_id: UUID, user_ids: set[UUID]) -> None:
    members = active_organisation_member_ids(organisation_id=organisation_id, user_ids=user_ids)
    with connection.cursor() as cursor:
        # Existing restriction writes need a row fence too. New child inserts take a
        # workspace FK key-share lock, excluded by the operation's workspace UPDATE lock.
        cursor.execute(
            "SELECT id FROM workspaces_workspacememberrestriction WHERE workspace_id=%s AND membership_id=ANY(%s::uuid[]) FOR SHARE NOWAIT",
            [workspace_id, members],
        )
        cursor.fetchall()


def _current_targets(organisation_id: UUID, workspace_id: UUID, identities: set[UUID]) -> set[str]:
    rows = active_organisation_identities(identity_ids=identities)
    members = active_organisation_memberships_by_user(
        organisation_id=organisation_id,
        user_ids={row.user_id for row in rows},
    )
    denied = restricted_workspace_membership_ids(
        workspace_id=workspace_id,
        membership_ids=members.values(),
    )
    issuer, realm = organisation_issuer_realm(organisation_id=organisation_id)
    community = is_community(organisation_id)
    return {
        str(row.id)
        for row in rows
        if row.user_id in members
        and members[row.user_id] not in denied
        and (
            community
            or (
                row.organisation_id == organisation_id
                and row.issuer == issuer
                and row.realm == realm
            )
        )
        and is_trusted_issuer(row.issuer, trusted=settings.KODERA_AUTH_TRUST)
    }


def admit_operation(
    *,
    verified: VerifiedAccessToken,
    workspace_id: UUID,
    broker: ProximityBroker | BrokerGateway,
    disclose_peers: bool,
) -> TenantCaller:
    """Keep these fences in the caller's READ COMMITTED transaction through RPC/result creation.

    Privacy fences precede workspace/authority rows. Advisory attempts and the organisation
    SHARE fence never wait: an unrelated account cutoff can own the organisation row before
    requesting workspace emission, so waiting there would reverse its lock order.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("proximity admission requires the operation transaction")
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_isolation")
        if cursor.fetchone()[0] != "read committed":
            raise _unavailable()
    try:
        organisation_id = workspace_organisation(workspace_id=workspace_id)
        # Provisional read only: no workspace lock is taken before the privacy fences.
        provisional = read_tenant_caller(
            verified=verified, organisation_id=organisation_id, allow_community=True
        )
    except (ObjectDoesNotExist, TenantCallerNotFoundError):
        raise ProximityRefusalError(404) from None
    except TenantCallerUnknownError:
        raise ProximityRefusalError(403, kind="identity-unknown") from None
    if provisional.organisation_state != "active":
        raise ProximityRefusalError(403)
    inventory = _inventory(broker, workspace_id) if disclose_peers else set()
    fenced_users = _users(inventory | {provisional.identity_id})
    _try_privacy_fence("privacy_erasure_cutoff:", organisation_id)
    for user_id in sorted(fenced_users):
        _try_privacy_fence("privacy_account_cutoff:", user_id)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM workspaces_workspace WHERE id=%s AND organisation_id=%s FOR UPDATE NOWAIT",
            [workspace_id, organisation_id],
        )
        if cursor.fetchone() is None:
            raise ProximityRefusalError(404)
        cursor.execute(
            "SELECT id FROM orgs_organisation WHERE id=%s FOR SHARE NOWAIT", [organisation_id]
        )
        if cursor.fetchone() is None:
            raise ProximityRefusalError(404)
    _freeze_restrictions(organisation_id, workspace_id, fenced_users)
    caller = authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
    if disclose_peers:
        current = _inventory(broker, workspace_id)
        if not _users(current | {caller.identity_id}) <= fenced_users:
            raise _unavailable()
        permitted = _current_targets(organisation_id, workspace_id, current)
        departed = sorted(
            str(identifier) for identifier in current if str(identifier) not in permitted
        )
        for offset in range(0, len(departed), 128):
            broker.forget(workspace_id=workspace_id, principal_keys=departed[offset : offset + 128])
    elif not _users({caller.identity_id}) <= fenced_users:
        raise _unavailable()
    return caller
