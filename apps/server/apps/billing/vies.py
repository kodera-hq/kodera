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

from django.db import transaction
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
    *, organisation_id: UUID, country_code: str, vat_number: str, answer: Answer
) -> ViesConsultation:
    normalise(country_code, vat_number)
    now = timezone.now()
    with transaction.atomic():
        profile = BillingProfile.objects.select_for_update().get(organisation_id=organisation_id)
        if profile.country != country_code or profile.vat_number != vat_number:
            raise ViesRefusedError("billing_profile_changed")
        row = ViesConsultation.objects.create(
            organisation_id=organisation_id,
            country_code=country_code,
            vat_number=vat_number,
            status=answer.status,
            checked_at=now,
            next_check_at=now + (RETRY_AFTER if answer.status == "unavailable" else VALID_FOR),
            consultation_ref=answer.consultation_ref,
            response_sha256=answer.response_sha256,
            evidence=answer.evidence,
        )
        profile.vat_number_validated_at = now if answer.status == "valid" else None
        profile.save(update_fields=["vat_number_validated_at", "updated_at"])
        from . import events
        from .actors import Actor
        events.record("vat.vies_checked", actor=Actor("system", None), organisation_id=organisation_id, target=("organisation", organisation_id), metadata={"evidence_id": str(row.id), "status": row.status})
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
