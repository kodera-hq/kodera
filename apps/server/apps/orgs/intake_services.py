"""The staff intake, `createOrganisation`: docs/specs/ORGANISATION_INTAKE.md.

Two halves. `authorise_intake` runs before the replay store, in transactions of its own: the
caller must be the staff principal of a verified staff token with a second factor, holding a current
`staff_operator` grant, so that a replay is never served to someone who could not make the request
now (IDEMPOTENCY_REPLAY.md §2.3). `record_intake` is the effect, called inside the replay store's
transaction: it reads the grant again and holds it, reserves the slug by the database's unique
constraints, creates the organisation in `prospect`, enqueues the `realm_create` job with the
`organisation.intake_recorded` audit row, and writes the intake record, all of it one commit
(FIRST_OWNER_BOOTSTRAP.md §3.1). It makes no outbound call.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, NoReturn
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction

from apps.audit.services import record_intake_recorded, record_staff_denial
from apps.identity.selectors import current_staff_grant, current_staff_identity
from apps.identity.staff import MFA_METHODS, StaffPrincipalError, resolve_staff_principal
from apps.identity.staff_roles import configured_staff_issuer

# The queue's enqueue alone, not apps.jobs.services: that module re-exports the decision functions,
# which import the outbox, and the API image installs no outbox (ORGANISATION_INTAKE.md §4).
from apps.jobs._enqueue import enqueue_job
from apps.jobs.keys import derive_key
from apps.jobs.selectors import job_by_idempotency_key, job_summary
from apps.jobs.types import JobRequest
from core import faults
from core.db.ids import new_uuid7
from core.sealing import seal
from services.identity.access_tokens import VerifiedAccessToken

from .models import (
    INSTRUCTION_REF,
    RESERVED_ORGANISATION_SLUGS,
    SYNTHETIC_ORGANISATION_PREFIX,
    Organisation,
    OrganisationIntake,
    SlugReservation,
)

SCOPE = "organisation:create"
OPERATOR = "staff_operator"
REALM_CREATE = "realm_create"
# A refusal precedes any organisation, and the body of a refused caller is not read: the attempted
# target is the organisation collection.
INTAKE_TARGET = "urn:kodera:organisation:*"
STAFF_REALM_SUFFIX = "/realms/kodera-staff"
# The organisation slug rule of contract 0.11.0 and orgs organisation_slug_valid, 5-20 characters.
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{3,18}[a-z0-9]\Z")
# Names no organisation may take: the closed list and synthetic prefix of orgs.models.
RESERVED_SLUGS = frozenset(RESERVED_ORGANISATION_SLUGS)
INSTRUCTION_REF_PATTERN = re.compile(INSTRUCTION_REF.removesuffix("$") + r"\Z")
# The unique constraints a slug already held meets: the organisation's issuer, which names the
# realm, and the reservation of the name itself.
SLUG_TAKEN_CONSTRAINTS = frozenset(
    {"organisation_issuer_unique", "reservation_namespace_slug_unique"}
)
SEAL_CONTEXT = b"kodera-organisation-intake:"
# What a `403 mfa-required` names as `required_amr` (CONVENTIONS.md §6).
REQUIRED_AMR = tuple(sorted(MFA_METHODS))


def is_reserved_slug(slug: str) -> bool:
    """Namespace exclusions after syntactic validation; synthetic realms never enter Core."""
    return slug in RESERVED_SLUGS or slug.startswith(SYNTHETIC_ORGANISATION_PREFIX)


class IntakeRefusedError(Exception):
    """The caller may not record an intake. `kind` is `unauthenticated`, `forbidden` or
    `mfa_required`; the message names no reason beyond it."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class StaffGrantLostError(Exception):
    """The grant read before the replay store was gone when the effect read it again."""


@dataclass(frozen=True, slots=True)
class IntakeActor:
    identity_id: UUID


@dataclass(frozen=True, slots=True)
class IntakeOperationReference:
    """A canonical intake reference bound to the intention that produced it.

    Construction accepts only the authoritative binding fields and computes the digest itself, so
    a caller cannot supply or later replace a valid-looking value.
    """

    identity_id: UUID
    path: str
    idempotency_key: str
    value: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "value",
            derive_key(
                [
                    f"urn:kodera:identity:{self.identity_id}",
                    "POST",
                    self.path,
                    REALM_CREATE,
                    self.idempotency_key,
                    0,
                ]
            ),
        )

    def belongs_to(self, *, actor: IntakeActor, path: str, idempotency_key: str) -> bool:
        return (
            self.identity_id == actor.identity_id
            and self.path == path
            and self.idempotency_key == idempotency_key
        )


@dataclass(frozen=True, slots=True)
class IntendedOwner:
    email: str = ""
    display_name: str | None = None


@dataclass(frozen=True, slots=True)
class IntakeRequest:
    """A validated `OrganisationCreateRequest`. `profile` holds the optional members the
    Organisation table does not store yet, as received; they are sealed with the contact."""

    slug: str
    name: str
    instruction_ref: str
    intended_owner: IntendedOwner
    profile: dict[str, Any]


@dataclass(frozen=True, slots=True)
class IntakeView:
    organisation_id: UUID
    slug: str
    name: str
    state: str
    organisation_created_at: datetime
    organisation_updated_at: datetime
    instruction_ref: str
    recorded_at: datetime
    intended_owner_email_masked: str
    job_id: UUID
    realm_state: str


@dataclass(frozen=True, slots=True)
class Recorded:
    view: IntakeView


@dataclass(frozen=True, slots=True)
class SlugTaken:
    slug: str


@dataclass(frozen=True, slots=True)
class KeyReused:
    first_seen_at: datetime


IntakeOutcome = Recorded | SlugTaken | KeyReused


# ------------------------------------------------------------------------- availability ----


def intake_available() -> bool:
    """Whether this process may record an intake at all: the database admits it (§3.8 of the
    pilot amendment, KODERA_INTAKE_ADMITTED), a contact seal key is configured, and so is the
    staff issuer every organisation issuer is derived from."""
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    return (
        getattr(settings, "KODERA_INTAKE_ADMITTED", False) is True
        and isinstance(key, bytes)
        and len(key) == 32
        and configured_staff_issuer() is not None
    )


def organisation_issuer(slug: str) -> str:
    """The issuer of the organisation's realm: the one identity provider's, which the staff
    issuer names (ADR-0006, ADR-0015), with the realm `slug`."""
    staff = configured_staff_issuer()
    if staff is None or not staff.endswith(STAFF_REALM_SUFFIX):
        raise RuntimeError("no staff issuer is configured: no organisation issuer can be derived")
    return staff.removesuffix(STAFF_REALM_SUFFIX) + "/realms/" + slug


# ------------------------------------------------------------------------- authorisation ----


def _deny(*, identity_id: UUID | None, request_id: str, reason: str, kind: str) -> NoReturn:
    if identity_id is not None:
        with transaction.atomic():
            record_staff_denial(
                actor_id=identity_id,
                target_urn=INTAKE_TARGET,
                request_id=request_id,
                required_scope=SCOPE,
                reason=reason,
            )
    raise IntakeRefusedError(kind)


def authorise_intake(*, verified: VerifiedAccessToken, lane: str, request_id: str) -> IntakeActor:
    """The staff actor of this request, or IntakeRefusedError.

    A customer token is `forbidden` whatever roles it names (AUTHZ.md §3: a staff role is never
    read from a token). A staff token of the one staff issuer without a second factor is
    `mfa_required`, audited when it names a stored staff identity. A token that resolves no stored,
    enabled staff identity is `unauthenticated` (AUTHZ.md §2 step 6). A staff identity without a
    current `staff_operator` grant is `forbidden`, audited.
    """
    if lane != "staff":
        raise IntakeRefusedError("forbidden")
    if verified.issuer != configured_staff_issuer():
        raise IntakeRefusedError("unauthenticated")
    if not MFA_METHODS.intersection(verified.amr or ()):
        stored = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        _deny(
            identity_id=None if stored is None else stored.id,
            request_id=request_id,
            reason="mfa_missing",
            kind="mfa_required",
        )
    try:
        principal = resolve_staff_principal(verified, lane)
    except StaffPrincipalError:
        raise IntakeRefusedError("unauthenticated") from None
    with transaction.atomic():
        grant = current_staff_grant(identity_id=principal.identity_id, role=OPERATOR)
    if grant is None:
        _deny(
            identity_id=principal.identity_id,
            request_id=request_id,
            reason="role_missing",
            kind="forbidden",
        )
    return IntakeActor(identity_id=principal.identity_id)


# ------------------------------------------------------------------------------- effect ----


def mask_email(email: str) -> str:
    """The first and last character of a local part of three or more, nothing of a shorter one,
    and the domain in clear (the contract's
    `intended_owner_email_masked`)."""
    local, _, domain = email.rpartition("@")
    if len(local) <= 2:
        # Two characters shown of a two-character local part would be the whole of it.
        return f"***@{domain}"
    return f"{local[0]}***{local[-1]}@{domain}"


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _desired_spec_hash(slug: str, issuer: str) -> str:
    return hashlib.sha256(
        _canonical({"kind": REALM_CREATE, "realm": slug, "issuer": issuer})
    ).hexdigest()


def intake_operation_reference(
    *, actor: IntakeActor, path: str, idempotency_key: str
) -> IntakeOperationReference:
    """Return the intake's stable, opaque correlation reference.

    The route computes this once after current authority is established and passes the same value
    through the replay adapter and the durable job write. Direct service callers may use this
    helper before calling :func:`record_intake` for the same invariant.
    """
    return IntakeOperationReference(
        identity_id=actor.identity_id,
        path=path,
        idempotency_key=idempotency_key,
    )


def _realm_state(status: str) -> str:
    """The `BootstrapStepState` this answer reports for the realm. `ready` is never reported here:
    it needs the trust-list condition of FIRST_OWNER_BOOTSTRAP.md §5.4, which the bootstrap view
    applies, not the intake."""
    if status == "queued":
        return "pending"
    if status in {"failed", "cancelled"}:
        return "failed"
    return "running"


def _constraint(error: IntegrityError) -> str | None:
    diagnostics = getattr(error.__cause__, "diag", None)
    return getattr(diagnostics, "constraint_name", None)


def _view(organisation: Organisation, intake: OrganisationIntake, status: str) -> IntakeView:
    return IntakeView(
        organisation_id=organisation.id,
        slug=organisation.slug,
        name=organisation.name,
        state=organisation.state,
        organisation_created_at=organisation.created_at,
        organisation_updated_at=organisation.updated_at,
        instruction_ref=intake.instruction_ref,
        recorded_at=intake.created_at,
        intended_owner_email_masked=intake.intended_owner_email_masked,
        job_id=intake.bootstrap_job_id,
        realm_state=_realm_state(status),
    )


def _earlier(job_key: str, desired_spec_hash: str) -> IntakeOutcome | None:
    """The intake an earlier request under the same intention key recorded, after its replay
    entry expired: the same organisation and the same job, never a second (§3.6). Another slug
    under that key is key reuse."""
    job = job_by_idempotency_key(job_key)
    if job is None:
        return None
    if job.desired_spec_hash != desired_spec_hash:
        return KeyReused(first_seen_at=job.created_at)
    intake = OrganisationIntake.objects.select_related("organisation").get(bootstrap_job_id=job.id)
    return Recorded(_view(intake.organisation, intake, job.status))


def record_intake(
    *,
    actor: IntakeActor,
    request: IntakeRequest,
    request_id: str,
    path: str,
    idempotency_key: str,
    operation_ref: IntakeOperationReference | None = None,
) -> IntakeOutcome:
    """The intake's effect, in the caller's transaction (the replay store's)."""
    if current_staff_grant(identity_id=actor.identity_id, role=OPERATOR) is None:
        raise StaffGrantLostError()
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes):
        raise RuntimeError("no contact seal key is configured: the intake is unavailable")
    issuer = organisation_issuer(request.slug)
    desired_spec_hash = _desired_spec_hash(request.slug, issuer)
    if operation_ref is None:
        operation_ref = intake_operation_reference(
            actor=actor, path=path, idempotency_key=idempotency_key
        )
    elif type(operation_ref) is not IntakeOperationReference:
        raise TypeError("operation_ref must be a canonical intake operation reference")
    elif not operation_ref.belongs_to(actor=actor, path=path, idempotency_key=idempotency_key):
        raise ValueError("the supplied operation reference is not canonical for this intake")
    earlier = _earlier(operation_ref.value, desired_spec_hash)
    if earlier is not None:
        return earlier
    try:
        with transaction.atomic():
            organisation = Organisation.objects.create(
                slug=request.slug,
                realm=request.slug,
                issuer=issuer,
                name=request.name,
                state=Organisation.State.PROSPECT,
            )
            SlugReservation.objects.create(
                organisation=organisation,
                slug=request.slug,
                state=SlugReservation.State.PROVISIONAL,
            )
    except IntegrityError as error:
        if _constraint(error) in SLUG_TAKEN_CONSTRAINTS:
            return SlugTaken(slug=request.slug)
        raise
    faults.reach("intake:after-desired-state")

    def apply_desired_state() -> None:
        record_intake_recorded(
            actor_id=actor.identity_id,
            organisation_id=organisation.id,
            slug=organisation.slug,
            request_id=request_id,
            instruction_ref=request.instruction_ref,
        )
        faults.reach("intake:after-audit")

    enqueued = enqueue_job(
        request=JobRequest(
            organisation_id=organisation.id,
            tenant_id=None,
            kind=REALM_CREATE,
            idempotency_key=operation_ref.value,
            desired_spec_hash=desired_spec_hash,
            actor_type="staff",
            actor_id=actor.identity_id,
            request_id=request_id,
        ),
        apply_desired_state=apply_desired_state,
    )
    faults.reach("intake:after-job")
    if not enqueued.created:
        raise RuntimeError("the intake's job key named a job no intake recorded")
    intake_id = new_uuid7()
    contact = {
        "intended_owner": {
            "email": request.intended_owner.email,
            "display_name": request.intended_owner.display_name,
        },
        "profile": request.profile,
    }
    intake = OrganisationIntake.objects.create(
        id=intake_id,
        organisation=organisation,
        recorded_by_identity_id=actor.identity_id,
        instruction_ref=request.instruction_ref,
        sealed_contact=seal(key, SEAL_CONTEXT + intake_id.bytes, _canonical(contact)),
        intended_owner_email_masked=mask_email(request.intended_owner.email),
        bootstrap_job_id=enqueued.job_id,
    )
    job = job_summary(enqueued.job_id)
    return Recorded(_view(organisation, intake, "queued" if job is None else job.status))
