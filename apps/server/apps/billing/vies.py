"""Recorded VIES checks against the fixed Commission endpoint, with explicit outage holds.

Transport uses Core's one-resolution public-egress pinning. No URL, requester registration or
validation status is selected by customer input. Tests replace the transport, never call VIES.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from .models import BillingProfile, ViesConsultation
from .vat import EU_MEMBER_STATES

ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number"
MAX_RESPONSE = 32_768
VALID_FOR = timedelta(days=30)
RETRY_AFTER = timedelta(minutes=15)
VAT_BODY = re.compile(r"[A-Z0-9]{2,13}\Z")
Transport = Callable[[bytes], tuple[int, bytes]]


class ViesRefusedError(ValueError):
    """Malformed request or stale profile; no unverified validation claim is written."""


def normalise(country_code: str, vat_number: str) -> tuple[str, str]:
    if not isinstance(country_code, str) or country_code not in EU_MEMBER_STATES:
        raise ViesRefusedError("vat_country_invalid")
    prefix = "EL" if country_code == "GR" else country_code
    if not isinstance(vat_number, str) or not vat_number.startswith(prefix):
        raise ViesRefusedError("vat_country_mismatch")
    if not VAT_BODY.fullmatch(vat_number[2:]):
        raise ViesRefusedError("vat_number_invalid")
    return prefix, vat_number[2:]


def _transport(body: bytes) -> tuple[int, bytes]:
    from apps.media import outbound

    destination = outbound.target(ENDPOINT, https_only=True)
    connection, response = outbound.request(
        destination,
        deadline=time.monotonic() + 10,
        method="POST",
        body=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        if response.getheader("Content-Encoding", "identity") != "identity":
            raise ViesRefusedError("vies_encoded_response")
        payload = response.read(MAX_RESPONSE + 1)
        if len(payload) > MAX_RESPONSE:
            raise ViesRefusedError("vies_response_too_large")
        return int(response.status), payload
    finally:
        response.close()
        connection.close()


@dataclass(frozen=True)
class Answer:
    status: str
    consultation_ref: str | None
    evidence: dict[str, Any]
    response_sha256: str


def consult(
    *,
    country_code: str,
    vat_number: str,
    requester: str,
    transport: Transport = _transport,
    clock: Callable[[], datetime] = timezone.now,
) -> Answer:
    prefix, number = normalise(country_code, vat_number)
    if len(requester) < 4 or not VAT_BODY.fullmatch(requester[2:]):
        raise ViesRefusedError("vies_requester_not_configured")
    requester_prefix = "EL" if requester.startswith("GR") else requester[:2]
    if requester_prefix not in ({"EL"} | (EU_MEMBER_STATES - {"GR"})):
        raise ViesRefusedError("vies_requester_not_configured")
    body = json.dumps(
        {
            "countryCode": prefix,
            "vatNumber": number,
            "requesterMemberStateCode": requester_prefix,
            "requesterNumber": requester[2:],
        },
        sort_keys=True,
    ).encode()
    try:
        status, payload = transport(body)
        if not isinstance(payload, bytes) or len(payload) > MAX_RESPONSE:
            raise ViesRefusedError("vies_response_too_large")
        digest = hashlib.sha256(payload).hexdigest()
        decoded = json.loads(payload)
        if (
            status != 200
            or not isinstance(decoded, dict)
            or decoded.get("countryCode") != prefix
            or decoded.get("vatNumber") != number
            or not isinstance(decoded.get("valid"), bool)
            or not isinstance(decoded.get("requestDate"), str)
        ):
            raise ViesRefusedError("vies_response_unavailable")
        request_date = datetime.fromisoformat(decoded["requestDate"].replace("Z", "+00:00"))
        if request_date.tzinfo is None:
            raise ViesRefusedError("vies_response_date")
        now = clock()
        if request_date > now + timedelta(minutes=5) or request_date < now - timedelta(days=2):
            raise ViesRefusedError("vies_response_date")
        reference = decoded.get("requestIdentifier")
        if (
            not isinstance(reference, str)
            or not 1 <= len(reference) <= 200
            or not reference.isprintable()
        ):
            raise ViesRefusedError("vies_consultation_reference_missing")
        evidence = {
            key: decoded[key]
            for key in ("countryCode", "vatNumber", "valid", "requestDate", "requestIdentifier")
        }
        return Answer("valid" if decoded["valid"] else "invalid", reference, evidence, digest)
    except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError):
        # Persist the outage without response text, legal names, socket errors or credentials.
        evidence = {"outcome": "unavailable"}
        return Answer(
            "unavailable", None, evidence, hashlib.sha256(b"vies:unavailable").hexdigest()
        )


def record_consultation(
    *,
    organisation_id: UUID,
    country_code: str,
    vat_number: str,
    answer: Answer,
    clock: Callable[[], datetime] = timezone.now,
) -> ViesConsultation:
    normalise(country_code, vat_number)
    now = clock()
    with transaction.atomic():
        profile = BillingProfile.objects.select_for_update().get(organisation_id=organisation_id)
        if profile.country != country_code or profile.vat_number != vat_number:
            raise ViesRefusedError("billing_profile_changed")
        current = current_consultation(profile)
        if current is not None:
            now = max(now, current.checked_at + timedelta(microseconds=1))
        row = ViesConsultation.objects.create(
            organisation_id=organisation_id,
            country_code=country_code,
            vat_number=vat_number,
            status=answer.status,
            checked_at=now,
            next_check_at=now
            + (
                RETRY_AFTER
                * (2 ** min(4, max(0, int(answer.evidence.get("retry_attempt", 1)) - 1)))
                if answer.status == "unavailable"
                else VALID_FOR
            ),
            consultation_ref=answer.consultation_ref,
            response_sha256=answer.response_sha256,
            evidence=answer.evidence,
        )
        profile.vat_number_validated_at = now if answer.status == "valid" else None
        profile.save(update_fields=["vat_number_validated_at", "updated_at"])
        from . import events
        from .actors import Actor

        events.record(
            "vat.vies_checked",
            actor=Actor("system", None),
            organisation_id=organisation_id,
            target=("organisation", organisation_id),
            metadata={"evidence_id": str(row.id), "status": row.status},
        )
        return row


def current_consultation(profile: BillingProfile) -> ViesConsultation | None:
    return (
        ViesConsultation.objects.filter(
            organisation_id=profile.organisation_id,
            country_code=profile.country,
            vat_number=profile.vat_number,
        )
        .order_by("-checked_at", "-id")
        .first()
    )


def vat_status(organisation_id: UUID) -> dict[str, object]:
    profile = BillingProfile.objects.filter(organisation_id=organisation_id).first()
    row = None if profile is None else current_consultation(profile)
    return {
        "vat_number": None if profile is None else profile.vat_number,
        "country_code": None if profile is None else profile.country,
        "status": "not_checked" if row is None else row.status,
        "checked_at": None if row is None else row.checked_at.isoformat(),
        "next_check_at": None if row is None else row.next_check_at.isoformat(),
        "evidence_id": None if row is None else str(row.id),
    }


def profile_matches(*, organisation_id: UUID, country_code: str, vat_number: str) -> bool:
    """Whether the requested check still names the stored billing profile."""
    return BillingProfile.objects.filter(
        organisation_id=organisation_id, country=country_code, vat_number=vat_number
    ).exists()


def _unexpired_proof(current: ViesConsultation | None, now: datetime) -> bool:
    return (
        current is not None
        and current.status == "valid"
        and now < current.next_check_at
        and current.checked_at <= now + timedelta(minutes=5)
    )


def consult_with_proof_cache(
    *,
    organisation_id: UUID,
    country_code: str,
    vat_number: str,
    opener: Transport | None = None,
    clock: Callable[[], datetime] = timezone.now,
) -> ViesConsultation:
    """Consult without row locks, then serialize persistence against profile changes."""
    normalise(country_code, vat_number)
    profile = BillingProfile.objects.get(organisation_id=organisation_id)
    if profile.country != country_code or profile.vat_number != vat_number:
        raise ViesRefusedError("billing_profile_changed")
    current = current_consultation(profile)
    if current is not None and _unexpired_proof(current, clock()):
        return current
    issuer = getattr(settings, "KODERA_BILLING_ISSUER", None)
    requester = getattr(issuer, "vat_number", None)
    if not requester:
        from .issuer_validation import validate_issuer

        requester = validate_issuer().get("VAT_NUMBER")
    if not requester:
        raise ViesRefusedError("vies_requester_not_configured")
    answer = consult(
        country_code=country_code,
        vat_number=vat_number,
        requester=requester,
        transport=opener if opener is not None else _transport,
        clock=clock,
    )
    with transaction.atomic():
        profile = BillingProfile.objects.select_for_update().get(organisation_id=organisation_id)
        if profile.country != country_code or profile.vat_number != vat_number:
            raise ViesRefusedError("billing_profile_changed")
        current = current_consultation(profile)
        if current is not None and _unexpired_proof(current, clock()):
            return current
        if answer.status == "unavailable":
            previous = (
                0
                if current is None or current.status != "unavailable"
                else current.evidence.get("retry_attempt", 0)
            )
            attempt = min(5, previous + 1) if type(previous) is int and previous >= 0 else 1
            answer = Answer(
                answer.status,
                answer.consultation_ref,
                {**answer.evidence, "retry_attempt": attempt},
                answer.response_sha256,
            )
        return record_consultation(
            organisation_id=organisation_id,
            country_code=country_code,
            vat_number=vat_number,
            answer=answer,
            clock=clock,
        )


def retry_due_consultations(
    *,
    limit: int = 50,
    opener: Transport | None = None,
    clock: Callable[[], datetime] = timezone.now,
) -> list[ViesConsultation]:
    """Retry only each profile's latest due proof with bounded work and no HTTP row lock."""
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ViesRefusedError("vies_retry_limit_invalid")
    latest = (
        ViesConsultation.objects.filter(
            organisation_id=OuterRef("organisation_id"),
            country_code=OuterRef("country_code"),
            vat_number=OuterRef("vat_number"),
        )
        .order_by("-checked_at", "-id")
        .values("id")[:1]
    )
    due = list(
        ViesConsultation.objects.filter(id=Subquery(latest), next_check_at__lte=clock())
        .exclude(country_code="FR")
        .order_by("next_check_at", "id")
        .values_list("organisation_id", "country_code", "vat_number")[:limit]
    )
    rows = []
    for organisation_id, country_code, vat_number in due:
        profile = BillingProfile.objects.filter(
            organisation_id=organisation_id, country=country_code, vat_number=vat_number
        ).first()
        if profile is None:
            continue
        current = current_consultation(profile)
        if current is None or current.next_check_at > clock():
            continue
        try:
            rows.append(
                consult_with_proof_cache(
                    organisation_id=organisation_id,
                    country_code=country_code,
                    vat_number=vat_number,
                    opener=opener,
                    clock=clock,
                )
            )
        except ViesRefusedError:
            # A profile changed after selection; obsolete identities must not be persisted.
            continue
    return rows
