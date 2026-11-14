"""Explicit fiscal authority and bounded statutory worker operations; no provider access."""

from datetime import datetime
from uuid import UUID

from django.db import connection

from .models import FiscalPeriod


def register_fiscal_period(
    *,
    issuer_siren: str,
    starts_at: datetime,
    closed_at: datetime,
    timezone: str,
    authority_ref: str,
) -> FiscalPeriod:
    if any(value.tzinfo is None or value.utcoffset() is None for value in (starts_at, closed_at)):
        raise ValueError("aware fiscal timestamps required")
    return FiscalPeriod.objects.create(
        issuer_siren=issuer_siren,
        starts_at=starts_at,
        closed_at=closed_at,
        timezone=timezone,
        authority_ref=authority_ref,
    )


def close_contract(
    *, order_id: UUID, ended_at: datetime, reason: str, evidence_ref: str, actor_identity_id: UUID
) -> None:
    if ended_at.tzinfo is None or ended_at.utcoffset() is None:
        raise ValueError("aware contract end required")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT billing_close_contract(%s,%s,%s,%s,%s)",
            [order_id, ended_at, reason, evidence_ref, actor_identity_id],
        )


def qualify_legacy(
    *, source_table: str, source_id: UUID, event_at: datetime, evidence_ref: str
) -> None:
    if event_at.tzinfo is None or event_at.utcoffset() is None:
        raise ValueError("aware accounting event required")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT billing_qualify_legacy_accounting(%s,%s,%s,%s)",
            [source_table, source_id, event_at, evidence_ref],
        )


def purge_due(*, source_table: str, source_id: UUID) -> bool:
    """False means missing row or a later-lived FK dependency; never rewrite the deadline."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT billing_purge_due_record(%s,%s)", [source_table, source_id])
        return bool(cursor.fetchone()[0])
