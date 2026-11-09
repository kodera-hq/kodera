"""Claim status primitives shared by the served bootstrap selector."""

from datetime import datetime


def expiry_transition_for(state: str, *, expires_at: datetime, now: datetime) -> str:
    """Retain terminal history; only an issued claim can become expired."""
    return "expired" if state == "issued" and expires_at <= now else state


def database_now() -> datetime:
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def expire_claims(*, organisation_id, request_id: str | None = None) -> int:
    """Conditionally expire only issued rows and audit in the same transaction."""
    from django.db import connection, transaction

    from apps.audit.services import record_owner_event

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS now) UPDATE orgs_ownerclaim AS claim SET state='expired', revoked_at=observed.now FROM observed WHERE claim.organisation_id=%s AND claim.state='issued' AND claim.expires_at<=observed.now RETURNING claim.id",
                [organisation_id],
            )
            expired = cursor.fetchall()
        for (claim_id,) in expired:
            record_owner_event(
                action="owner_claim.expired",
                organisation_id=organisation_id,
                target_id=claim_id,
                actor_id=None,
                request_id=request_id,
                metadata={},
            )
    return len(expired)
