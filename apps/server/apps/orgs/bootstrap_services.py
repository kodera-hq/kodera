"""Current bootstrap authority covers expiry writes and response materialization."""

from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_authz_denied
from apps.identity.selectors import current_staff_grant, is_storable_subject
from apps.identity.staff import MFA_METHODS, StaffPrincipalError, resolve_staff_principal
from apps.identity.staff_roles import configured_staff_issuer
from services.identity.access_tokens import VerifiedAccessToken

from .api.bootstrap_permissions import (
    BOOTSTRAP_OPERATIONS,
    BootstrapAuthority,
    BootstrapForbiddenError,
    BootstrapNotFoundError,
    BootstrapStaffUnauthenticatedError,
    BootstrapUnknownIdentityError,
    authorise_bootstrap_operation,
)
from .api.bootstrap_serializers import serialize_bootstrap
from .bootstrap_selectors import bootstrap_view
from .claim_readiness import expire_claims
from .models import OwnerBinding


def read_bootstrap(
    *, verified: VerifiedAccessToken, lane: str, target_id: UUID, request_id: str
) -> bytes:
    if connection.in_atomic_block:
        raise RuntimeError("bootstrap read requires its own transaction")
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'")
            authorise_bootstrap_operation(
                operation_id="getOrganisationBootstrap",
                verified=verified,
                lane=lane,
                target_id=target_id,
            )
            view = bootstrap_view(organisation_id=target_id)
            if view is None:
                raise BootstrapNotFoundError()
            expire_claims(organisation_id=target_id, request_id=request_id)
            view = bootstrap_view(organisation_id=target_id)
            if view is None:
                raise BootstrapNotFoundError()
            return serialize_bootstrap(view)
    except BootstrapForbiddenError as refusal:
        with transaction.atomic():
            record_authz_denied(
                actor_type=refusal.actor_type,
                actor_id=refusal.actor_id,
                organisation_id=target_id if refusal.actor_type == "tenant" else None,
                target_urn=f"urn:kodera:organisation:{target_id}",
                request_id=request_id,
                required_scope="organisation_bootstrap:read",
                reason=refusal.reason,
            )
        raise


def _authorise_bootstrap_operation(
    *, operation_id: str, verified: VerifiedAccessToken, lane: str, target_id: UUID
) -> BootstrapAuthority:
    if operation_id not in BOOTSTRAP_OPERATIONS:
        raise BootstrapForbiddenError()
    # Staff before customer: a staff token, or the staff issuer on another lane, keeps the staff
    # lane's answers and never reaches the customer `identity-unknown` (AUTHZ.md §2 step 6).
    issuer = verified.issuer if type(verified) is VerifiedAccessToken else None
    staff = lane != "customer" or (issuer is not None and issuer == configured_staff_issuer())
    if type(verified) is not VerifiedAccessToken or not is_storable_subject(verified.subject):
        raise BootstrapStaffUnauthenticatedError() if staff else BootstrapUnknownIdentityError()
    if not connection.in_atomic_block:
        raise RuntimeError("bootstrap authorization requires its held transaction")
    if lane == "staff":
        if operation_id != "getOrganisationBootstrap":
            raise BootstrapForbiddenError()
        try:
            principal = resolve_staff_principal(verified, lane)
        except StaffPrincipalError:
            raise BootstrapForbiddenError(
                reason="mfa_missing"
                if not MFA_METHODS.intersection(verified.amr or ())
                else "role_missing"
            ) from None
        for role in ("staff_operator", "staff_support"):
            grant = current_staff_grant(
                identity_id=principal.identity_id, role=role, lock_principal=True
            )
            if grant is not None:
                return BootstrapAuthority(principal.identity_id, "staff", grant)
        raise BootstrapForbiddenError(actor_id=principal.identity_id)
    if staff:
        raise BootstrapStaffUnauthenticatedError()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT i.id, i.organisation_id FROM identity_identity i JOIN identity_user u ON u.id=i.user_id WHERE i.issuer=%s AND i.subject=%s AND i.organisation_id IS NOT NULL AND i.enabled AND i.deleted_at IS NULL AND u.enabled AND u.deleted_at IS NULL FOR SHARE OF i,u",
            [verified.issuer, verified.subject],
        )
        identity = cursor.fetchone()
    if identity is None:
        raise BootstrapUnknownIdentityError()
    identity_id, organisation_id = identity
    if organisation_id != target_id:
        raise BootstrapNotFoundError()
    if not OwnerBinding.objects.filter(
        organisation_id=target_id, identity_id=identity_id, issuer=verified.issuer
    ).exists():
        raise BootstrapForbiddenError(actor_id=identity_id, actor_type="tenant")
    return BootstrapAuthority(identity_id, "tenant")
