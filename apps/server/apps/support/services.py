"""Cross-application support service port for isolated restore rehearsal guards.

Provides outbound neutralization for pending GitHub triage `BugReport` rows and un-enqueued
`SupportTicket` mail runs, plus GDPR Art. 17 local-domain scrubbing and zero-residual verification
queries without exposing `apps.support.models` across application boundaries.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from django.db import connection
from django.db.models import Q

from .models import BugReport, BugReportCircuitState, SupportTicket


def disarm_rehearsal_outbound(
    *,
    now: datetime,
    excluded_organisation_ids: tuple[UUID, ...] = (),
) -> dict[str, int]:
    """Scrub and disarm pending GitHub bug-report triage rows and owed support-ticket mail runs."""
    if not connection.in_atomic_block:
        raise RuntimeError("disarm_rehearsal_outbound requires an enclosing atomic transaction")

    bug_reports_disarmed = BugReport.objects.filter(dispatched_at__isnull=True).update(
        dispatched_at=now,
        sanitized_note="",
        screenshot_content_type=None,
        screenshot_bytes=None,
        screenshot_sha256=None,
        claimed_at=None,
        claim_token="",
        last_dispatch_error="rehearsal_disarmed",
        updated_at=now,
    )
    BugReportCircuitState.objects.update_or_create(
        singleton=True,
        defaults={
            "opened_until": now + timedelta(days=3650),
            "last_failure_at": now,
            "last_error_code": "rehearsal_disarmed",
        },
    )

    excluded = [str(org_id) for org_id in excluded_organisation_ids]
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE support_supportticket t "
            "SET mail_refused_at = %s, updated_at = %s "
            "WHERE t.content_erased_at IS NULL "
            "  AND t.mail_enqueued_at IS NULL "
            "  AND t.mail_refused_at IS NULL "
            "  AND NOT (t.organisation_id::text = ANY(%s)) "
            "  AND NOT EXISTS ("
            "    SELECT 1 FROM orgs_privacyerasure pe "
            "    WHERE pe.organisation_reference = t.organisation_id"
            "  )",
            [now, now, excluded],
        )
        support_tickets_disarmed = int(cursor.rowcount or 0)

    return {
        "bug_reports_disarmed": int(bug_reports_disarmed),
        "support_tickets_disarmed": support_tickets_disarmed,
    }


def scrub_tickets_for_user(*, user_id: UUID, now: datetime) -> int:
    """Scrub personal fields on support tickets opened by any identity of `user_id`."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE support_supportticket "
            "SET subject = '', "
            "    body = '', "
            "    reply_to_email = NULL, "
            "    contact_email = NULL, "
            "    content_erased_at = COALESCE(content_erased_at, %s), "
            "    updated_at = %s "
            "WHERE created_by_id IN (SELECT id FROM identity_identity WHERE user_id = %s) "
            "  AND (content_erased_at IS NULL OR subject <> '' OR body <> '' "
            "       OR reply_to_email IS NOT NULL OR contact_email IS NOT NULL)",
            [now, now, user_id],
        )
        return int(cursor.rowcount or 0)


def count_unscrubbed_tickets_for_organisation(*, organisation_id: UUID) -> int:
    """Count support tickets in `organisation_id` still retaining subject, body, or email PII."""
    return int(
        SupportTicket.objects.filter(organisation_id=organisation_id)
        .filter(
            Q(content_erased_at__isnull=True)
            | ~Q(subject="")
            | ~Q(body="")
            | Q(reply_to_email__isnull=False)
            | Q(contact_email__isnull=False)
        )
        .count()
    )


def count_unscrubbed_tickets_for_user(*, user_id: UUID) -> int:
    """Count support tickets opened by `user_id` still retaining subject, body, or email PII."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM support_supportticket t "
            "JOIN identity_identity i ON i.id = t.created_by_id "
            "WHERE i.user_id = %s "
            "  AND (t.content_erased_at IS NULL OR t.subject <> '' OR t.body <> '' "
            "       OR t.reply_to_email IS NOT NULL OR t.contact_email IS NOT NULL)",
            [user_id],
        )
        row = cursor.fetchone()
    return int(row[0]) if row is not None else 0
