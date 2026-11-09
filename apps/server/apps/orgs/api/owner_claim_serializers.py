"""Strict consume representation; omission and explicit null stay distinct."""

import json

from core.api.idempotency import StoredResponse

from ..claim_consumption import ConsumedResult, ConsumeInput as ConsumeRequest
from .owner_claim_permissions import PROBLEMS, ConsumeGuardError


class ConsumeRequestError(ValueError):
    """No schema coercion or raw parser details are exposed."""


def _unique_members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConsumeRequestError("consume request refused")
        result[key] = value
    return result


def _valid_display_name(value: object) -> bool:
    return value is None or (type(value) is str and len(value) <= 200)


def parse_consume_request(body: bytes) -> ConsumeRequest:
    try:
        value = json.loads(body, object_pairs_hook=_unique_members)
    except (ValueError, UnicodeError, RecursionError):
        raise ConsumeRequestError("consume request refused") from None
    if (
        type(value) is not dict
        or set(value) - {"token", "display_name"}
        or type(value.get("token")) is not str
        or not 43 <= len(value["token"]) <= 256
        or not _valid_display_name(value.get("display_name"))
    ):
        raise ConsumeRequestError("consume request refused")
    return ConsumeRequest(value["token"], value.get("display_name"), "display_name" in value)


def serialize_consume_result(result: ConsumedResult) -> StoredResponse:
    """Query-free safe self profile; materialized inside the current held replay transaction."""
    org = result.organisation
    body = {
        "organisation": {
            "id": str(org[0]),
            "slug": org[2],
            "realm": org[3],
            "name": org[4],
            "state": "active",
            "created_at": org[5].isoformat(),
        },
        "membership": {
            "id": str(result.membership_id),
            "organisation_id": str(org[0]),
            "person_id": str(result.user_id),
            "identity_id": str(result.identity_id),
            "email": result.email,
            "display_name": result.display_name,
            "role": "org_owner",
            "state": "active",
            "source": "owner_claim",
            "created_at": result.membership_created_at.isoformat(),
        },
    }
    return StoredResponse(
        200,
        json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(),
        "application/json",
    )


def serialize_consume_refusal(refusal: ConsumeGuardError, request_id: str) -> StoredResponse:
    status, title = PROBLEMS[refusal.kind]
    body: dict[str, object] = {
        "type": "https://kodera.io/problems/" + refusal.kind,
        "title": title,
        "status": status,
        "request_id": request_id,
    }
    if refusal.kind == "mfa-required":
        body["required_amr"] = ["otp"]
    if refusal.kind == "invalid-state-transition":
        body["allowed_states"] = ["prospect"]
    if status == 503:
        body["retry_after_s"] = 1
    return StoredResponse(
        status, json.dumps(body, separators=(",", ":")).encode(), "application/problem+json"
    )
