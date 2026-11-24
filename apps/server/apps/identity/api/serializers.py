"""Exact customer Me projection; no inferred MFA, staff, locale or provider attributes."""

import json
from datetime import UTC
from typing import Any

from apps.identity.services import CustomerRead


def serialize_customer(value: CustomerRead) -> bytes:
    identity_ids = {identity.organisation_id: str(identity.id) for identity in value.identities}
    current_identity = next(
        (identity for identity in value.identities if identity.id == value.current_identity_id),
        None,
    )
    current_pair = (
        (current_identity.issuer, current_identity.subject)
        if current_identity is not None
        else None
    )
    current_realm = current_identity.realm if current_identity is not None else None
    memberships: list[dict[str, Any]] = []
    for member in value.memberships:
        organisation = member.organisation
        entry: dict[str, Any] = {
            "organisation": {
                "id": str(organisation.id),
                "slug": organisation.slug,
                "name": organisation.name,
                "realm": organisation.realm,
            },
            "membership_id": str(member.id),
            "role": member.role,
            "state": member.state,
            "shared_realm": organisation.shared_realm,
            "plan_tier": organisation.plan_tier,
            "joined_at": member.accepted_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
            if member.accepted_at is not None
            else None,
        }
        if organisation.slug == "community" and current_realm != organisation.realm:
            entry["identity_id"] = str(value.current_identity_id)
        elif organisation.id in identity_ids:
            entry["identity_id"] = identity_ids[organisation.id]
        elif organisation.slug == "community":
            entry["identity_id"] = str(value.current_identity_id)
        memberships.append(entry)
    projection = {
        "id": str(value.person.id),
        "email": value.person.email,
        "display_name": value.person.display_name,
        "staff": False,
        "identities": [
            {
                "id": str(identity.id),
                "issuer": identity.issuer,
                "realm": identity.realm,
                "subject": identity.subject,
                "email": identity.email,
                **(
                    {"mfa_enrolled": value.mfa_enrolled}
                    if value.mfa_enrolled is not None
                    and (
                        identity.id == value.current_identity_id
                        or (identity.issuer, identity.subject) == current_pair
                    )
                    else {}
                ),
            }
            for identity in value.identities
        ],
        "organisations": memberships,
    }
    return json.dumps(projection, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
