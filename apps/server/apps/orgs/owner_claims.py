"""Excluded operator owner-claim issuance; never imported by served readers."""

import json
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, connection, transaction

from apps.audit.services import record_owner_event
from apps.identity.owner_binding import account_subject_exists, create_owner_identity
from apps.identity.selectors import is_storable_subject
from apps.identity.staff import StaffPrincipal, is_staff_principal
from apps.identity.staff_roles import configured_staff_issuer
from apps.jobs.kinds import Lock
from apps.jobs.locks import try_lock, unlock
from apps.jobs.services import sweep_expired_leases
from apps.outbox.mail.dates import mail_instant
from apps.outbox.sender import MessageRefusedError, SenderUnavailableError, enqueue_message
from core.db.ids import new_uuid7
from core.sealing import SealError, unseal

from .claim_configuration import ClaimConfigurationError, claim_lifetime, organisation_claim_link
from .claim_contact import ContactRefusedError, normalise_contact
from .claim_readiness import database_now, expire_claims
from .claim_tokens import format_claim_token, hash_claim_secret
from .models import Organisation, OrganisationIntake, OwnerBinding, OwnerClaim
from .realm_bootstrap import Refused, operator_authorization
from .realm_readiness import realm_ready


def new_claim_secret() -> str:
    """Create exactly32 random bytes; plaintext is destined only for sealed delivery."""
    return secrets.token_urlsafe(32)


class ClaimRefusedError(ValueError):
    """Closed refusal codes never carry account data or token material."""


@dataclass(frozen=True, slots=True, repr=False)
class AccountCreationRecord:
    issuer: str
    subject: str
    credential_created: bool
    evidence_ref: str


@dataclass(frozen=True, slots=True)
class ClaimOutcome:
    binding_id: UUID
    claim_id: UUID
    delivery_id: UUID
    state: str = "issued"


def _reference(value: str) -> None:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 512
        or any(
            character.isspace() or character == "@" or ord(character) < 32 for character in value
        )
    ):
        raise ClaimRefusedError("reference_refused")


@contextmanager
def authorized_operator(principal: StaffPrincipal) -> Iterator[None]:
    if getattr(settings, "KODERA_INTAKE_ADMITTED", False) is not True:
        raise ClaimRefusedError("intake_not_admitted")
    if not is_staff_principal(principal) or principal.issuer != configured_staff_issuer():
        raise ClaimRefusedError("operator_refused")
    try:
        with operator_authorization(principal):
            sweep_expired_leases()
            yield
    except Refused:
        raise ClaimRefusedError("operator_refused") from None


@contextmanager
def locked_organisation(organisation_id: UUID) -> Iterator[None]:
    if connection.in_atomic_block:
        raise RuntimeError("owner command requires its own transaction")
    lock = Lock("organisation", organisation_id, "exclusive")
    if not try_lock(lock):
        raise ClaimRefusedError("organisation_locked")
    try:
        with transaction.atomic():
            yield
    except IntegrityError:
        raise ClaimRefusedError("concurrent_change") from None
    finally:
        unlock([lock])


def _organisation(
    organisation_id: UUID, principal: StaffPrincipal
) -> tuple[Organisation, OrganisationIntake]:
    organisation = Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True).first()
    intake = OrganisationIntake.objects.filter(organisation_id=organisation_id).first()
    if organisation is None or intake is None:
        raise ClaimRefusedError("organisation_missing")
    if intake.recorded_by_identity_id == principal.identity_id:
        raise ClaimRefusedError("two_person_rule")
    return organisation, intake


def _ready(organisation: Organisation) -> None:
    if organisation.state != "prospect" or not realm_ready(organisation_id=organisation.id):
        raise ClaimRefusedError("bootstrap_not_ready")


def _contact(intake: OrganisationIntake) -> tuple[str, str, str | None]:
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes) or len(key) != 32:
        raise ClaimRefusedError("contact_key_missing")
    try:
        data = json.loads(
            unseal(
                key, b"kodera-organisation-intake:" + intake.id.bytes, bytes(intake.sealed_contact)
            )
        )
        owner = data["intended_owner"]
        contact = normalise_contact(owner["email"])
        locale = data.get("profile", {}).get("locale", "fr")
        display = owner.get("display_name")
        if locale not in {"fr", "en"} or (
            display is not None and (not isinstance(display, str) or len(display) > 200)
        ):
            raise ClaimRefusedError("contact_refused")
        return contact, locale, display
    except (SealError, ContactRefusedError, ValueError, TypeError, KeyError, AttributeError):
        raise ClaimRefusedError("contact_refused") from None


def _issuance_configuration(*, organisation: Organisation):
    inputs = {}
    for name in ("KODERA_OWNER_CLAIM_LIFETIME_SECONDS", "KODERA_OWNER_CLAIM_LINK"):
        value = getattr(settings, name, None)
        if value is not None:
            inputs[name] = value
    try:
        return claim_lifetime(inputs), organisation_claim_link(
            inputs,
            getattr(settings, "KODERA_MAIL_LINK_ORIGINS", frozenset()),
            organisation_id=organisation.id,
            slug=organisation.slug,
        )
    except ClaimConfigurationError:
        raise ClaimRefusedError("claim_configuration_refused") from None


def _issue(
    *,
    binding: OwnerBinding,
    organisation: Organisation,
    intake: OrganisationIntake,
    principal: StaffPrincipal,
    request_id: str,
) -> ClaimOutcome:
    lifetime, link = _issuance_configuration(organisation=organisation)
    recipient, locale, _ = _contact(intake)
    claim_id = new_uuid7()
    token = format_claim_token(claim_id, new_claim_secret())
    verifier = hash_claim_secret(token)
    now = database_now()
    expires = now + lifetime
    try:
        delivery_id = enqueue_message(
            organisation_id=organisation.id,
            template_id="owner_claim",
            locale=locale,
            recipient=recipient,
            link=link,
            link_secret=token,
            params={
                "organisation_name": organisation.name,
                "expires_at": mail_instant(expires, locale),
            },
            expires_at=expires,
        )
    except (MessageRefusedError, SenderUnavailableError):
        raise ClaimRefusedError("delivery_refused") from None
    claim = OwnerClaim.objects.create(
        id=claim_id,
        organisation_id=organisation.id,
        intended_identity_id=binding.identity_id,
        token_hash=verifier,
        issued_at=now,
        expires_at=expires,
        delivery_id=delivery_id,
    )
    record_owner_event(
        action="owner_claim.issued",
        organisation_id=organisation.id,
        target_id=claim.id,
        actor_id=principal.identity_id,
        request_id=request_id,
        metadata={"binding_id": str(binding.id), "delivery_id": str(delivery_id)},
    )
    return ClaimOutcome(binding.id, claim.id, delivery_id)


def bind_intended_owner(
    *,
    principal: StaffPrincipal,
    organisation_id: UUID,
    subject: str,
    account_record: AccountCreationRecord,
    contact: str,
    request_id: str,
) -> ClaimOutcome:
    _reference(request_id)
    if (
        type(account_record) is not AccountCreationRecord
        or account_record.credential_created is not False
        or not is_storable_subject(subject)
        or account_record.subject != subject
    ):
        raise ClaimRefusedError("account_record_refused")
    _reference(account_record.evidence_ref)
    with authorized_operator(principal), locked_organisation(organisation_id):
        organisation, intake = _organisation(organisation_id, principal)
        _ready(organisation)
        if account_record.issuer != organisation.issuer:
            raise ClaimRefusedError("account_record_refused")
        if OwnerBinding.objects.filter(
            organisation_id=organisation.id
        ).exists() or account_subject_exists(issuer=organisation.issuer, subject=subject):
            raise ClaimRefusedError("already_bound")
        recipient, _, display = _contact(intake)
        try:
            supplied = normalise_contact(contact)
        except ContactRefusedError:
            raise ClaimRefusedError("contact_refused") from None
        if recipient != supplied:
            raise ClaimRefusedError("contact_mismatch")
        _issuance_configuration(organisation=organisation)
        created = create_owner_identity(
            organisation_id=organisation.id,
            issuer=organisation.issuer,
            realm=organisation.realm,
            subject=subject,
            contact=recipient,
            display_name=display,
        )
        binding = OwnerBinding.objects.create(
            intake=intake,
            organisation=organisation,
            identity_id=created.identity_id,
            issuer=organisation.issuer,
            realm=organisation.realm,
            recorded_by_identity_id=principal.identity_id,
        )
        record_owner_event(
            action="identity.bound",
            organisation_id=organisation.id,
            target_id=created.identity_id,
            actor_id=principal.identity_id,
            request_id=request_id,
            metadata={"binding_id": str(binding.id), "evidence_ref": account_record.evidence_ref},
        )
        return _issue(
            binding=binding,
            organisation=organisation,
            intake=intake,
            principal=principal,
            request_id=request_id,
        )


def revoke_owner_claim(
    *, principal: StaffPrincipal, organisation_id: UUID, claim_id: UUID, request_id: str
) -> UUID:
    _reference(request_id)
    refused = False
    with authorized_operator(principal), locked_organisation(organisation_id):
        organisation, _ = _organisation(organisation_id, principal)
        claim = OwnerClaim.objects.filter(id=claim_id, organisation_id=organisation.id).first()
        if claim is None:
            raise ClaimRefusedError("claim_missing")
        expire_claims(organisation_id=organisation.id, request_id=request_id)
        claim.refresh_from_db()
        if claim.state != "issued":
            refused = True
        else:
            now = database_now()
            if (
                OwnerClaim.objects.filter(id=claim.id, state="issued").update(
                    state="revoked", revoked_at=now, revoked_by_identity_id=principal.identity_id
                )
                != 1
            ):
                raise ClaimRefusedError("concurrent_change")
            record_owner_event(
                action="owner_claim.revoked",
                organisation_id=organisation.id,
                target_id=claim.id,
                actor_id=principal.identity_id,
                request_id=request_id,
                metadata={},
            )
    if refused:
        # Observed expiry is durable even though this requested revocation did not occur.
        raise ClaimRefusedError("claim_not_issued")
    return claim_id


def reissue_owner_claim(
    *, principal: StaffPrincipal, organisation_id: UUID, request_id: str
) -> ClaimOutcome:
    _reference(request_id)
    with authorized_operator(principal), locked_organisation(organisation_id):
        organisation, intake = _organisation(organisation_id, principal)
        _ready(organisation)
        binding = OwnerBinding.objects.filter(
            organisation_id=organisation.id,
            identity__enabled=True,
            identity__deleted_at__isnull=True,
            identity__user__enabled=True,
            identity__user__deleted_at__isnull=True,
        ).first()
        if (
            binding is None
            or OwnerClaim.objects.filter(organisation_id=organisation.id, state="consumed").exists()
        ):
            raise ClaimRefusedError("binding_not_ready")
        _issuance_configuration(organisation=organisation)
        _contact(intake)
        expire_claims(organisation_id=organisation.id, request_id=request_id)
        current = OwnerClaim.objects.filter(organisation_id=organisation.id, state="issued").first()
        if current is not None:
            OwnerClaim.objects.filter(id=current.id, state="issued").update(
                state="revoked",
                revoked_at=database_now(),
                revoked_by_identity_id=principal.identity_id,
            )
            record_owner_event(
                action="owner_claim.revoked",
                organisation_id=organisation.id,
                target_id=current.id,
                actor_id=principal.identity_id,
                request_id=request_id,
                metadata={},
            )
        return _issue(
            binding=binding,
            organisation=organisation,
            intake=intake,
            principal=principal,
            request_id=request_id,
        )


def read_binding_input(stream) -> tuple[str, AccountCreationRecord]:
    """Bounded stdin only; errors never echo contact or account-record input."""
    try:
        raw = stream.read(16385)
        if len(raw) > 16384:
            raise ClaimRefusedError("binding_input_refused")
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or set(data) != {"contact", "account_record"}
            or not isinstance(data["contact"], str)
        ):
            raise ClaimRefusedError("binding_input_refused")
        record = data["account_record"]
        if not isinstance(record, dict) or set(record) != {
            "issuer",
            "subject",
            "credential_created",
            "evidence_ref",
        }:
            raise ClaimRefusedError("binding_input_refused")
        if (
            not all(isinstance(record[name], str) for name in ("issuer", "subject", "evidence_ref"))
            or type(record["credential_created"]) is not bool
        ):
            raise ClaimRefusedError("binding_input_refused")
        return data["contact"], AccountCreationRecord(**record)
    except (ValueError, TypeError):
        raise ClaimRefusedError("binding_input_refused") from None


def run_claim_command(command, options, write, body) -> None:
    """One fixed record containing IDs and outcome only, including on a refusal."""
    from django.core.management.base import CommandError

    from .realm_bootstrap import organisation_of, principal_for

    organisation_id = None
    try:
        principal = principal_for(options["staff_identity"])
        organisation = organisation_of(options["organisation"])
        organisation_id = organisation.id
        result, outcome = body(principal, organisation.id, str(new_uuid7()))
    except (Refused, ClaimRefusedError) as refusal:
        reason = str(refusal) if isinstance(refusal, ClaimRefusedError) else "operator_refused"
        write(
            f"{command} organisation={organisation_id or '-'} staff_identity={options['staff_identity']} outcome=refused:{reason}"
        )
        raise CommandError(reason) from None
    identifiers = ""
    if isinstance(result, ClaimOutcome):
        identifiers = f" claim={result.claim_id} delivery={result.delivery_id}"
    elif isinstance(result, UUID):
        identifiers = f" reference={result}"
    write(
        f"{command} organisation={organisation_id} staff_identity={options['staff_identity']}{identifiers} outcome={outcome}"
    )
