"""Explicit existing bootstrap contract members; secret material never enters the view."""

import json
from datetime import UTC, datetime

from ..bootstrap_selectors import BootstrapView


def _instant(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def serialize_bootstrap(view: BootstrapView) -> bytes:
    body = {
        "organisation_id": str(view.organisation_id),
        "slug": view.slug,
        "organisation_state": view.organisation_state,
        "intake": {
            "instruction_ref": view.instruction_ref,
            "recorded_at": _instant(view.recorded_at),
            "intended_owner_email_masked": view.intended_owner_email_masked,
        },
        "realm": {"state": view.realm_state, "name": view.realm_name, "job_id": str(view.job_id)},
        "identity_mapping": {
            "state": view.identity_state,
            "identity_id": str(view.identity_id) if view.identity_id else None,
            "bound_at": _instant(view.bound_at),
        },
        "claim": {
            "state": view.claim_state,
            "issued_at": _instant(view.issued_at),
            "expires_at": _instant(view.expires_at),
            "consumed_at": _instant(view.consumed_at),
            "revoked_at": _instant(view.revoked_at),
            "membership_id": str(view.membership_id) if view.membership_id else None,
        },
        "updated_at": _instant(view.updated_at),
    }
    return json.dumps(body, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode()
