"""One held consume/replay transaction; the delivered token grants no ordinary capability."""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db import DatabaseError, connection, transaction

from apps.audit.services import record_authz_denied, record_consumption_event, record_owner_event
from apps.identity.selectors import current_staff_identity, is_storable_subject
from apps.jobs.kinds import Lock
from apps.jobs.locks import try_lock, unlock
from core.idempotency.store import (
    EnterAuthority,
    FinalAuthority,
    FreshAuthority,
    MetadataAuthority,
    ReplayAuthority,
)
from services.identity.access_tokens import (
    RecentAuthenticationReason,
    RegisteredFactorReason,
    VerifiedAccessToken,
    evaluate_recent_authentication,
    evaluate_registered_factor,
    observe_recent_authentication_reason,
    observe_registered_factor_reason,
    recent_authentication_horizon,
)

from .claim_readiness import database_now
from .claim_tokens import claim_id_for_token, verify_claim_secret
from .models import Membership, Organisation, OwnerClaim, SlugReservation

_PREFLIGHT = "SELECT i.id,i.user_id,i.organisation_id FROM identity_identity i JOIN identity_user u ON u.id=i.user_id WHERE i.issuer=%s AND i.subject=%s AND i.organisation_id IS NOT NULL AND i.enabled AND i.deleted_at IS NULL AND u.enabled AND u.deleted_at IS NULL"
_USER_HOLD = "SELECT id,email,display_name FROM identity_user WHERE id=%s AND enabled AND deleted_at IS NULL FOR NO KEY UPDATE NOWAIT"
_IDENTITY_HOLD = "SELECT id FROM identity_identity WHERE id=%s AND user_id=%s AND organisation_id=%s AND issuer=%s AND subject=%s AND enabled AND deleted_at IS NULL FOR SHARE NOWAIT"
_ORGANISATIONS_HOLD = "SELECT id,state,slug,realm,name,created_at,updated_at,deleted_at FROM orgs_organisation WHERE id IN (SELECT organisation_id FROM identity_identity WHERE user_id=%s UNION SELECT organisation_id FROM orgs_membership WHERE user_id=%s UNION SELECT %s::uuid) ORDER BY id FOR NO KEY UPDATE NOWAIT"


class ConsumerUnknownError(Exception):
    """No current persisted customer identity/person: `403 identity-unknown`; never a receipt."""


class StaffConsumerUnknownError(Exception):
    """A staff-lane token naming no stored staff identity: `401`, as the staff intake answers it
    (ORGANISATION_INTAKE.md); the staff lane is outside `identity-unknown`. Never a receipt and
    never an audit row."""


class ConsumeGuardError(Exception):
    """Closed current denial, audited after replay rollback when raised by a guard."""

    def __init__(self, kind: str, *, reason: str = "role_missing"):
        super().__init__("consume authority refused")
        if kind not in {
            "malformed-request",
            "forbidden",
            "not-found",
            "owner-claim-identity-mismatch",
            "owner-claim-contact-unverified",
            "mfa-required",
            "owner-claim-expired",
            "owner-claim-revoked",
            "owner-claim-consumed",
            "invalid-state-transition",
            "service-unavailable",
        } or reason not in {
            "role_missing",
            "mfa_missing",
            "issued",
            "consumed",
            "expired",
            "revoked",
        }:
            raise ValueError("consume refusal code refused")
        self.kind, self.reason = kind, reason


@dataclass(frozen=True, slots=True)
class ConsumerPrincipal:
    identity_id: UUID
    user_id: UUID
    organisation_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class ConsumeInput:
    token: str
    display_name: str | None
    has_display_name: bool


@dataclass(frozen=True, slots=True, repr=False)
class ConsumedResult:
    organisation: tuple[Any, ...]
    membership_id: UUID
    membership_created_at: datetime
    user_id: UUID
    identity_id: UUID
    email: str
    display_name: str | None


@dataclass(frozen=True, slots=True, repr=False)
class HeldConsumer:
    email: str
    display_name: str | None
    organisation: tuple[Any, ...]


def resolve_consumer(*, verified: VerifiedAccessToken, lane: str) -> ConsumerPrincipal:
    if lane != "customer":
        raise ConsumeGuardError("forbidden")
    if type(verified) is not VerifiedAccessToken or not is_storable_subject(verified.subject):
        raise ConsumerUnknownError()
    with connection.cursor() as cursor:
        cursor.execute(_PREFLIGHT, [verified.issuer, verified.subject])
        row = cursor.fetchone()
    if row is None:
        raise ConsumerUnknownError()
    return ConsumerPrincipal(*row)


def _hold_principal(principal: ConsumerPrincipal, verified: VerifiedAccessToken) -> HeldConsumer:
    with connection.cursor() as cursor:
        cursor.execute(_USER_HOLD, [principal.user_id])
        user = cursor.fetchone()
        if user is None:
            raise ConsumerUnknownError()
        cursor.execute(
            _IDENTITY_HOLD,
            [
                principal.identity_id,
                principal.user_id,
                principal.organisation_id,
                verified.issuer,
                verified.subject,
            ],
        )
        if cursor.fetchone() is None:
            raise ConsumerUnknownError()
        cursor.execute(
            _ORGANISATIONS_HOLD, [principal.user_id, principal.user_id, principal.organisation_id]
        )
        organisations = cursor.fetchall()
    target = next((row for row in organisations if row[0] == principal.organisation_id), None)
    if target is None:
        raise ConsumerUnknownError()
    return HeldConsumer(user[1], user[2], tuple(target))


def _is_busy(error: BaseException) -> bool:
    return getattr(error.__cause__, "sqlstate", None) == "55P03"


def _denial(principal: ConsumerPrincipal, request_id: str, reason: str) -> None:
    record_authz_denied(
        actor_type="tenant",
        actor_id=principal.identity_id,
        organisation_id=principal.organisation_id,
        target_urn=f"urn:kodera:organisation:{principal.organisation_id}",
        request_id=request_id,
        required_scope="owner_claim:act",
        reason=reason,
    )


class Consumption:
    def __init__(
        self,
        *,
        principal: ConsumerPrincipal,
        verified: VerifiedAccessToken,
        body: bytes,
        request_id: str,
        parser: Callable[[bytes], ConsumeInput] | None = None,
        lane: str = "customer",
        console_client_id: str | None = None,
    ):
        self.principal, self.verified = principal, verified
        self.body, self.request_id = body, request_id
        self.held: HeldConsumer | None = None
        self.audited = False
        self.parser = parser
        self.lane = lane
        self.console_client_id = console_client_id
        self.factor_horizon: datetime | None = None
        self.final_read_monotonic: float | None = None

    def _context(self):
        try:
            if self.parser is None:
                raise ValueError("consume parser missing")
            requested = self.parser(self.body)
        except ValueError:
            raise ConsumeGuardError("malformed-request") from None
        claim_id = claim_id_for_token(requested.token)
        if claim_id is None:
            raise ConsumeGuardError("not-found")
        # No located-claim lock or mutable state is inspected until bounded whole-token proof.
        row = (
            OwnerClaim.objects.filter(id=claim_id, organisation_id=self.principal.organisation_id)
            .values("id", "token_hash")
            .first()
        )
        if row is None or not verify_claim_secret(requested.token, bytes(row["token_hash"])):
            raise ConsumeGuardError("not-found")
        claim = (
            OwnerClaim.objects.filter(id=claim_id, organisation_id=self.principal.organisation_id)
            .select_for_update(nowait=True)
            .only(
                "id", "intended_identity_id", "state", "expires_at", "consumed_at", "membership_id"
            )
            .first()
        )
        if claim is None:
            raise ConsumeGuardError("not-found")
        if claim.intended_identity_id != self.principal.identity_id:
            raise ConsumeGuardError("owner-claim-identity-mismatch", reason=claim.state)
        return requested, claim

    def _bound_role(self, claim: OwnerClaim) -> str:
        if self.held is None:
            raise RuntimeError("consume handler requires current held authority")
        if self.held.organisation[7] is not None:
            raise ConsumeGuardError("forbidden", reason=claim.state)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT identity_id FROM orgs_ownerbinding WHERE organisation_id=%s AND identity_id=%s AND issuer=%s FOR SHARE NOWAIT",
                [self.principal.organisation_id, self.principal.identity_id, self.verified.issuer],
            )
            if cursor.fetchone() is None:
                raise ConsumeGuardError("forbidden", reason=claim.state)
            cursor.execute(
                "SELECT id,role,state,accepted_at FROM orgs_membership WHERE organisation_id=%s AND user_id=%s AND deleted_at IS NULL FOR SHARE NOWAIT",
                [self.principal.organisation_id, self.principal.user_id],
            )
            memberships = cursor.fetchall()
        state = self.held.organisation[1]
        if state == "active" and any(
            row[1] == "org_owner" and row[2] == "active" and row[3] is not None
            for row in memberships
        ):
            return "org_owner"
        if state == "prospect" and not memberships:
            return "bootstrap"
        raise ConsumeGuardError("forbidden", reason=claim.state)

    def _facts(self, claim: OwnerClaim, now: datetime) -> None:
        if self.verified.email_verified is not True:
            raise ConsumeGuardError("owner-claim-contact-unverified", reason=claim.state)
        factor = evaluate_registered_factor(
            verified=self.verified,
            lane=self.lane,
            console_client_id=self.console_client_id,
            database_now=now,
        )
        if factor.reason is RegisteredFactorReason.FUTURE_IAT:
            observe_registered_factor_reason(factor.reason)
        if factor.value is not True:
            raise ConsumeGuardError("mfa-required", reason=claim.state)
        # `amr` is the SSO session's, so its `otp` is current only for a recent login.
        recency = evaluate_recent_authentication(verified=self.verified, database_now=now)
        if recency is not RecentAuthenticationReason.RECENT:
            observe_recent_authentication_reason(recency)
            raise ConsumeGuardError("mfa-required", reason=claim.state)
        # `final_authority` re-reads the clock before COMMIT: the login must still be recent then.
        recent_until = recent_authentication_horizon(self.verified)
        if factor.horizon is None or recent_until is None:
            raise ConsumeGuardError("mfa-required", reason=claim.state)
        self.factor_horizon = min(factor.horizon, recent_until)

    def authority(self, event) -> None:
        if isinstance(event, EnterAuthority):
            self.held = _hold_principal(self.principal, self.verified)
            return
        if isinstance(event, FreshAuthority):
            return
        try:
            _, claim = self._context()
        except ConsumeGuardError as refusal:
            if isinstance(event, ReplayAuthority) and (
                (refusal.kind == "malformed-request" and event.status == 400)
                or (refusal.kind == "not-found" and event.status == 404)
                or (refusal.kind == "owner-claim-identity-mismatch" and event.status == 403)
            ):
                _denial(self.principal, self.request_id, refusal.reason)
                self.audited = True
                return
            raise
        self._bound_role(claim)
        if isinstance(event, MetadataAuthority) or (
            isinstance(event, ReplayAuthority) and event.status < 400
        ):
            self._facts(claim, database_now())
        if isinstance(event, MetadataAuthority) or (
            isinstance(event, ReplayAuthority) and event.status >= 400
        ):
            _denial(self.principal, self.request_id, claim.state)
            self.audited = True

    def fresh(self) -> ConsumedResult | ConsumeGuardError:
        if not connection.in_atomic_block or self.held is None:
            raise RuntimeError("consume handler requires current held authority")
        try:
            requested, claim = self._context()
            self._bound_role(claim)
            now = database_now()
            self._facts(claim, now)
            if claim.state == "issued" and claim.expires_at <= now:
                OwnerClaim.objects.filter(id=claim.id, state="issued").update(
                    state="expired", revoked_at=now
                )
                claim.state = "expired"
                record_owner_event(
                    action="owner_claim.expired",
                    organisation_id=self.principal.organisation_id,
                    target_id=claim.id,
                    actor_id=None,
                    request_id=self.request_id,
                    metadata={},
                )
            terminal = {
                "expired": "owner-claim-expired",
                "revoked": "owner-claim-revoked",
                "consumed": "owner-claim-consumed",
            }
            if claim.state in terminal:
                raise ConsumeGuardError(terminal[claim.state], reason=claim.state)
            if (
                self.held.organisation[1] != "prospect"
                or Membership.objects.filter(
                    organisation_id=self.principal.organisation_id,
                    role="org_owner",
                    state="active",
                    accepted_at__isnull=False,
                    deleted_at__isnull=True,
                ).exists()
            ):
                raise ConsumeGuardError("invalid-state-transition", reason=claim.state)
            membership = Membership.objects.create(
                user_id=self.principal.user_id,
                organisation_id=self.principal.organisation_id,
                role="org_owner",
                state="active",
                accepted_at=now,
            )
            if requested.has_display_name:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "UPDATE identity_user SET display_name=%s,updated_at=%s WHERE id=%s",
                        [requested.display_name, now, self.principal.user_id],
                    )
                name = requested.display_name
            else:
                name = self.held.display_name
            OwnerClaim.objects.filter(id=claim.id, state="issued").update(
                state="consumed",
                consumed_at=now,
                consumed_by_identity_id=self.principal.identity_id,
                membership_id=membership.id,
            )
            if (
                SlugReservation.objects.filter(
                    organisation_id=self.principal.organisation_id, state="provisional"
                ).update(state="permanent", protected_at=now, updated_at=now)
                != 1
            ):
                raise RuntimeError("consume reservation promotion refused")
            if (
                Organisation.objects.filter(
                    id=self.principal.organisation_id, state="prospect", deleted_at__isnull=True
                ).update(state="active", updated_at=now)
                != 1
            ):
                raise RuntimeError("consume activation refused")
            for action, target in (
                ("owner_claim.consumed", claim.id),
                ("membership.created", membership.id),
                ("organisation.activated", self.principal.organisation_id),
            ):
                record_consumption_event(
                    action=action,
                    organisation_id=self.principal.organisation_id,
                    target_id=target,
                    actor_id=self.principal.identity_id,
                    request_id=self.request_id,
                )
            return ConsumedResult(
                self.held.organisation,
                membership.id,
                membership.created_at,
                self.principal.user_id,
                self.principal.identity_id,
                self.held.email,
                name,
            )
        except ConsumeGuardError as refusal:
            _denial(self.principal, self.request_id, refusal.reason)
            self.audited = True
            return refusal

    def final_authority(self, event: FinalAuthority) -> None:
        if event.kind != "fresh_success":
            return
        now = database_now()
        self.final_read_monotonic = time.monotonic()
        if self.factor_horizon is None or now >= self.factor_horizon:
            raise ConsumeGuardError("service-unavailable")

    def observe_commit_lag(self) -> None:
        if self.final_read_monotonic is not None:
            observe_consume_commit_lag(max(0.0, time.monotonic() - self.final_read_monotonic))


def observe_consume_commit_lag(seconds: float) -> None:
    """Bounded metrics seam; the observation contains no request or identity data."""


@contextmanager
def consumption_operation(
    *,
    verified: VerifiedAccessToken,
    lane: str,
    body: bytes,
    parser: Callable[[bytes], ConsumeInput],
    request_id: str,
) -> Iterator[Consumption]:
    from django.conf import settings

    if connection.in_atomic_block:
        raise RuntimeError("consume requires its own replay transaction")
    if lane == "staff":
        staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        if staff is None:
            raise StaffConsumerUnknownError()
        with transaction.atomic():
            record_authz_denied(
                actor_type="staff",
                actor_id=staff.id,
                organisation_id=None,
                target_urn="urn:kodera:owner_claim",
                request_id=request_id,
                required_scope="owner_claim:act",
                reason="role_missing",
            )
        raise ConsumeGuardError("forbidden")
    principal = resolve_consumer(verified=verified, lane=lane)
    lock = Lock("organisation", principal.organisation_id, "exclusive")
    acquired = False
    try:
        acquired = try_lock(lock)
        if not acquired:
            raise ConsumeGuardError("service-unavailable")
        operation = Consumption(
            principal=principal,
            verified=verified,
            body=body,
            parser=parser,
            request_id=request_id,
            lane=lane,
            console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
        )
        try:
            yield operation
        except DatabaseError as error:
            if not _is_busy(error):
                raise
            raise ConsumeGuardError("service-unavailable") from None
    except ConsumeGuardError as refusal:
        if refusal.kind != "service-unavailable":
            with transaction.atomic():
                _denial(principal, request_id, refusal.reason)
        raise
    finally:
        if acquired:
            unlock([lock])


def record_adapter_denial(operation: Consumption) -> None:
    if not operation.audited:
        with transaction.atomic():
            _denial(operation.principal, operation.request_id, "role_missing")
