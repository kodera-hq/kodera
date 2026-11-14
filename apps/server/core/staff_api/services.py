"""C1-only read selectors and mutation services for `/staff/v1/{read,triage,ops}/*`."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

from django.db import connection, transaction

from core.db.ids import new_uuid7

from .audit import append_staff_audit_entry, verify_staff_audit_chain
from .auth import VerifiedStaffRequest
from .errors import StaffApiError
from .models import (
    CANONICAL_SEATS,
    CAPACITY_TIERS,
    DEAL_STAGES,
    FEEDBACK_KINDS,
    FEEDBACK_SEVERITIES,
    FEEDBACK_STATUSES,
    FINOPS_ENVIRONMENTS,
    GROSS_MARGIN_FLOOR_BPS,
    IDENTITY_BRIDGE_STAFF_ROLES,
    SAR_KINDS,
    STAFF_REALM,
    STAFF_ROLES,
    TARGET_REPOSITORIES,
    StaffAuditEntry,
    StaffDealCard,
    StaffFeedbackItem,
    StaffFinopsSnapshot,
    StaffIssuerSnapshot,
    StaffRoleGrant,
    StaffSarRecord,
    StaffWaitlistCohort,
)
from .scrubber import (
    COHORT_CODE_RE,
    PERIOD_MONTH_RE,
    SLUG_RE,
    scrub_c1_text,
    validate_public_jwks,
    validate_sar_evidence_ref,
    validate_sar_pseudonym,
)

GITHUB_ORG = "kodera-hq"
MIN_ACTIVE_OWNERS = 1
MIN_ACTIVE_OPERATORS = 2


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat()


def _parse_uuid(value: object, field_name: str) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise StaffApiError(400, "invalid_uuid", "Invalid identifier", f"{field_name} must be a UUID")
    try:
        return UUID(value.strip())
    except ValueError as exc:
        raise StaffApiError(
            400, "invalid_uuid", "Invalid identifier", f"{field_name} is not a valid UUID"
        ) from exc


def _active_mrr_summary() -> tuple[int, int]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              COALESCE(
                SUM(
                  CASE
                    WHEN billing_period = 'yearly' THEN total_excl_vat_minor / 12
                    ELSE total_excl_vat_minor
                  END
                ),
                0
              ),
              COUNT(*)
            FROM billing_subscription
            WHERE state = 'active'
            """
        )
        row = cursor.fetchone()
    if row is None:
        return 0, 0
    return int(row[0] or 0), int(row[1] or 0)


def _latest_finops_headline() -> tuple[str | None, int | None]:
    latest_period = (
        StaffFinopsSnapshot.objects.order_by("-period_month")
        .values_list("period_month", flat=True)
        .first()
    )
    if latest_period is None:
        return None, None
    rows = list(StaffFinopsSnapshot.objects.filter(period_month=latest_period))
    total_mrr = sum(int(r.mrr_cents) for r in rows)
    total_cost = sum(int(r.total_cost_cents) for r in rows)
    margin_bps = ((total_mrr - total_cost) * 10000) // total_mrr if total_mrr > 0 else None
    return str(latest_period), margin_bps


# ----------------------------------------------------------------- M1-M8 Reads ----


def read_overview(caller: VerifiedStaffRequest) -> dict[str, object]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              COUNT(*),
              COUNT(*) FILTER (WHERE state = 'active')
            FROM orgs_organisation
            WHERE deleted_at IS NULL
            """
        )
        org_row = cursor.fetchone() or (0, 0)
        orgs_total, orgs_active = int(org_row[0] or 0), int(org_row[1] or 0)

        cursor.execute(
            """
            SELECT t.status, COUNT(*)
            FROM tenancy_tenant t
            JOIN orgs_organisation o ON o.id = t.organisation_id
            WHERE o.deleted_at IS NULL
            GROUP BY t.status
            """
        )
        tenant_counts = {str(status): int(count) for status, count in cursor.fetchall()}

        cursor.execute("SELECT status, COUNT(*) FROM jobs_job GROUP BY status")
        job_counts = {str(status): int(count) for status, count in cursor.fetchall()}

    feedback_counts: dict[str, int] = {}
    for row in StaffFeedbackItem.objects.values_list("status", flat=True):
        feedback_counts[row] = feedback_counts.get(row, 0) + 1

    active_mrr_minor, _ = _active_mrr_summary()
    finops_month, finops_bps = _latest_finops_headline()

    return {
        "caller": {
            "identity_id": str(caller.identity_id),
            "roles": list(caller.roles),
        },
        "organisations_total": orgs_total,
        "organisations_active": orgs_active,
        "tenant_status_counts": tenant_counts,
        "job_status_counts": job_counts,
        "reconciling_jobs_count": int(job_counts.get("needs_reconciliation", 0)),
        "feedback_status_counts": feedback_counts,
        "financial_headline": {
            "currency": "EUR",
            "active_mrr_excl_vat_minor": active_mrr_minor,
            "finops_period_month": finops_month,
            "finops_gross_margin_bps": finops_bps,
        },
    }


def read_organisations(caller: VerifiedStaffRequest) -> dict[str, object]:
    full_metadata_roles = {"staff_owner", "staff_operator", "staff_security", "staff_support"}
    slugs_only = not bool(set(caller.roles).intersection(full_metadata_roles))
    redaction_mode = "c1_slugs_only" if slugs_only else "c1_metadata"

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              o.id,
              o.slug,
              o.name,
              o.realm,
              o.state,
              o.created_at,
              COUNT(m.id) FILTER (WHERE m.state = 'active' AND m.deleted_at IS NULL)
            FROM orgs_organisation o
            LEFT JOIN orgs_membership m ON m.organisation_id = o.id
            WHERE o.deleted_at IS NULL
            GROUP BY o.id, o.slug, o.name, o.realm, o.state, o.created_at
            ORDER BY o.created_at DESC, o.id DESC
            """
        )
        org_rows = cursor.fetchall()

        cursor.execute(
            """
            SELECT
              t.id,
              t.organisation_id,
              t.slug,
              t.name,
              t.status,
              t.pack_code,
              t.capacity_tier_code,
              t.apps,
              t.region,
              t.status_changed_at
            FROM tenancy_tenant t
            JOIN orgs_organisation o ON o.id = t.organisation_id
            WHERE o.deleted_at IS NULL
            ORDER BY t.created_at DESC, t.id DESC
            """
        )
        tenant_rows = cursor.fetchall()

    organisations = [
        {
            "id": str(row[0]),
            "slug": str(row[1]),
            "name": str(row[1]) if slugs_only else str(row[2]),
            "realm": str(row[3]),
            "state": str(row[4]),
            "created_at": _iso(row[5]) or "",
            "active_member_count": int(row[6] or 0),
        }
        for row in org_rows
    ]
    tenants = [
        {
            "id": str(row[0]),
            "organisation_id": str(row[1]),
            "slug": str(row[2]),
            "name": str(row[2]) if slugs_only else str(row[3]),
            "status": str(row[4]),
            "pack_code": str(row[5]),
            "capacity_tier_code": str(row[6]),
            "apps": list(row[7]) if isinstance(row[7], list) else [],
            "region": str(row[8]),
            "status_changed_at": _iso(row[9]) or "",
        }
        for row in tenant_rows
    ]
    return {
        "redaction_mode": redaction_mode,
        "organisations_count": len(organisations),
        "tenants_count": len(tenants),
        "organisations": organisations,
        "tenants": tenants,
    }


def read_pipeline() -> dict[str, object]:
    deals = [
        {
            "id": str(d.id),
            "prospect_slug": d.prospect_slug,
            "stage": d.stage,
            "pack_code": d.pack_code,
            "capacity_tier_code": d.capacity_tier_code,
            "estimated_mrr_cents": int(d.estimated_mrr_cents),
            "owner_seat": d.owner_seat,
            "next_step_code": d.next_step_code,
            "updated_at": _iso(d.updated_at) or "",
        }
        for d in StaffDealCard.objects.order_by("-updated_at", "-id")
    ]
    cohort_rows = list(StaffWaitlistCohort.objects.order_by("-created_at", "-id"))
    cohorts = [
        {
            "id": str(c.id),
            "cohort_code": c.cohort_code,
            "opened_count": int(c.opened_count),
            "landing_receipt_ref": c.landing_receipt_ref,
            "opened_by_identity_id": str(c.opened_by_identity_id),
            "created_at": _iso(c.created_at) or "",
        }
        for c in cohort_rows
    ]
    total_opened = sum(int(c.opened_count) for c in cohort_rows)
    return {
        "deals": deals,
        "waitlist_cohorts": cohorts,
        "waitlist_summary": {
            "total_confirmed": total_opened,
            "unopened_confirmed": 0,
            "individual_or_singleton_confirmed": 0,
            "individual_or_singleton_unopened": 0,
            "domain_clusters": [],
        },
    }


def _serialize_feedback_item(
    item: StaffFeedbackItem, *, redact_engineering: bool
) -> dict[str, object]:
    summary = scrub_c1_text(item.summary) if redact_engineering else item.summary
    details = scrub_c1_text(item.details) if redact_engineering else item.details
    return {
        "id": str(item.id),
        "organisation_id": str(item.organisation_id) if item.organisation_id else None,
        "organisation_slug": item.organisation_slug,
        "kind": item.kind,
        "source": item.source,
        "severity": item.severity,
        "status": item.status,
        "surface": item.surface,
        "summary": summary,
        "details": details,
        "reporter_pseudonym": item.reporter_pseudonym,
        "assigned_seat": item.assigned_seat,
        "vote_count": int(item.vote_count),
        "roadmap_milestone": item.roadmap_milestone,
        "external_issue_ref": item.external_issue_ref,
        "created_at": _iso(item.created_at) or "",
        "updated_at": _iso(item.updated_at) or "",
    }


def read_feedback(
    caller: VerifiedStaffRequest,
    *,
    status_filter: str | None = None,
    kind_filter: str | None = None,
    engineering_only: bool = False,
) -> dict[str, object]:
    if status_filter is not None and status_filter not in FEEDBACK_STATUSES:
        raise StaffApiError(
            400, "invalid_status", "Invalid feedback status", "Unsupported status filter"
        )
    if kind_filter is not None and kind_filter not in FEEDBACK_KINDS:
        raise StaffApiError(
            400, "invalid_kind", "Invalid feedback kind", "Unsupported kind filter"
        )

    full_triage_roles = {"staff_owner", "staff_operator", "staff_support"}
    redact_engineering = engineering_only or not bool(
        set(caller.roles).intersection(full_triage_roles)
    )

    counts_by_status: dict[str, int] = {}
    for st in StaffFeedbackItem.objects.values_list("status", flat=True):
        counts_by_status[st] = counts_by_status.get(st, 0) + 1

    qs = StaffFeedbackItem.objects.order_by("-vote_count", "-updated_at", "-id")
    if engineering_only:
        from django.db.models import Q

        qs = qs.filter(Q(status__in=("planned", "in_progress")) | Q(kind="bug"))
    if status_filter is not None:
        qs = qs.filter(status=status_filter)
    if kind_filter is not None:
        qs = qs.filter(kind=kind_filter)

    items = [_serialize_feedback_item(item, redact_engineering=redact_engineering) for item in qs]
    return {
        "redacted_for_engineering": redact_engineering,
        "counts_by_status": counts_by_status,
        "items": items,
    }


def read_finops(*, period_month: str | None = None) -> dict[str, object]:
    if period_month is not None:
        period_month = period_month.strip()
        if not period_month:
            period_month = None
        elif PERIOD_MONTH_RE.fullmatch(period_month) is None:
            raise StaffApiError(
                400,
                "invalid_period_month",
                "Invalid period_month",
                "period_month must match YYYY-MM",
            )

    active_mrr_minor, active_subs_count = _active_mrr_summary()
    effective_period = period_month
    if effective_period is None:
        effective_period = (
            StaffFinopsSnapshot.objects.order_by("-period_month")
            .values_list("period_month", flat=True)
            .first()
        )

    snapshots = (
        list(
            StaffFinopsSnapshot.objects.filter(period_month=effective_period).order_by(
                "environment_code", "-created_at", "-id"
            )
        )
        if effective_period is not None
        else []
    )
    total_mrr = sum(int(s.mrr_cents) for s in snapshots)
    total_cost = sum(int(s.total_cost_cents) for s in snapshots)
    gross_margin_cents = total_mrr - total_cost
    gross_margin_bps = (gross_margin_cents * 10000) // total_mrr if total_mrr > 0 else None
    gross_margin_alert = (
        gross_margin_bps is not None and gross_margin_bps < GROSS_MARGIN_FLOOR_BPS
    )

    rows = [
        {
            "id": str(s.id),
            "period_month": s.period_month,
            "environment_code": s.environment_code,
            "organisation_slug": s.organisation_slug,
            "mrr_cents": int(s.mrr_cents),
            "total_cost_cents": int(s.total_cost_cents),
            "gross_margin_cents": int(s.gross_margin_cents),
            "gross_margin_bps": s.gross_margin_bps,
            "active_organisations": int(s.active_organisations),
            "active_tenants": int(s.active_tenants),
            "free_visio_sessions": int(s.free_visio_sessions),
            "source_ref": s.source_ref,
            "created_at": _iso(s.created_at) or "",
        }
        for s in snapshots
    ]
    return {
        "billing": {
            "currency": "EUR",
            "active_mrr_excl_vat_minor": active_mrr_minor,
            "active_subscriptions_count": active_subs_count,
        },
        "finops": {
            "period_month": effective_period,
            "total_mrr_cents": total_mrr,
            "total_cost_cents": total_cost,
            "gross_margin_cents": gross_margin_cents,
            "gross_margin_bps": gross_margin_bps,
            "gross_margin_alert": gross_margin_alert,
            "rows": rows,
        },
    }


def read_sre() -> dict[str, object]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT status, COUNT(*) FROM jobs_job GROUP BY status")
        job_status_counts = {str(status): int(count) for status, count in cursor.fetchall()}

        cursor.execute(
            """
            SELECT
              id, organisation_id, tenant_id, kind, status,
              unresolved_operation_ref, created_at, updated_at
            FROM jobs_job
            WHERE status = 'needs_reconciliation'
            ORDER BY updated_at DESC, id DESC
            LIMIT 200
            """
        )
        reconciling_jobs = [
            {
                "id": str(r[0]),
                "organisation_id": str(r[1]),
                "tenant_id": str(r[2]) if r[2] is not None else None,
                "kind": str(r[3]),
                "status": str(r[4]),
                "unresolved_operation_ref": str(r[5]) if r[5] is not None else None,
                "created_at": _iso(r[6]) or "",
                "updated_at": _iso(r[7]) or "",
            }
            for r in cursor.fetchall()
        ]

        cursor.execute("SELECT to_regclass('public.outbox_outboxdelivery')")
        outbox_reg = cursor.fetchone()
        outbox_status_counts: dict[str, int] = {}
        reconciling_deliveries: list[dict[str, object]] = []
        if outbox_reg is not None and outbox_reg[0] is not None:
            cursor.execute("SELECT status, COUNT(*) FROM outbox_outboxdelivery GROUP BY status")
            outbox_status_counts = {
                str(status): int(count) for status, count in cursor.fetchall()
            }
            cursor.execute(
                """
                SELECT
                  id, organisation_id, category, changes_realm, status,
                  operation_ref, started_at, created_at
                FROM outbox_outboxdelivery
                WHERE status = 'needs_reconciliation'
                ORDER BY created_at DESC, id DESC
                LIMIT 200
                """
            )
            reconciling_deliveries = [
                {
                    "id": str(r[0]),
                    "organisation_id": str(r[1]),
                    "category": str(r[2]),
                    "changes_realm": bool(r[3]),
                    "status": str(r[4]),
                    "operation_ref": str(r[5]) if r[5] is not None else None,
                    "started_at": _iso(r[6]),
                    "created_at": _iso(r[7]) or "",
                }
                for r in cursor.fetchall()
            ]

    return {
        "jobs": {
            "status_counts": job_status_counts,
            "reconciling": reconciling_jobs,
        },
        "outbox": {
            "status_counts": outbox_status_counts,
            "reconciling_deliveries": reconciling_deliveries,
        },
    }


def _safe_staff_display_label(display_name: str | None, subject: str) -> str:
    if isinstance(display_name, str) and display_name.strip() and "@" not in display_name:
        return display_name.strip()[:64]
    return f"staff:{subject[:12]}"


def read_security() -> dict[str, object]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT i.id, i.user_id, i.subject, u.display_name, (i.enabled AND u.enabled)
            FROM identity_identity i
            JOIN identity_user u ON u.id = i.user_id
            WHERE i.realm = %s AND i.deleted_at IS NULL AND u.deleted_at IS NULL
            ORDER BY i.created_at, i.id
            """,
            [STAFF_REALM],
        )
        identity_rows = cursor.fetchall()

        cursor.execute(
            """
            SELECT identity_id, role FROM staff_api_role_grant
            WHERE realm = %s AND revoked_at IS NULL
            UNION
            SELECT identity_id, role FROM identity_staffrole
            WHERE realm = %s AND revoked_at IS NULL
            """,
            [STAFF_REALM, STAFF_REALM],
        )
        roles_by_identity: dict[str, set[str]] = {}
        for ident_id, role in cursor.fetchall():
            roles_by_identity.setdefault(str(ident_id), set()).add(str(role))

    staff_roster = []
    for row in identity_rows:
        ident_str = str(row[0])
        held = roles_by_identity.get(ident_str, set())
        ordered = [r for r in STAFF_ROLES if r in held]
        staff_roster.append(
            {
                "identity_id": ident_str,
                "user_id": str(row[1]),
                "subject": str(row[2]),
                "display_label": _safe_staff_display_label(row[3], str(row[2])),
                "enabled": bool(row[4]),
                "roles": ordered,
            }
        )

    fleet_chain = verify_staff_audit_chain("fleet")
    recent_audit_events = [
        {
            "id": str(e.id),
            "occurred_at": _iso(e.recorded_at) or "",
            "actor_type": "staff",
            "actor_label": f"urn:kodera:identity:{e.actor_identity_id}",
            "organisation_id": None,
            "action": e.action,
            "target_urn": f"urn:kodera:{e.target_type}:{e.target_id}",
            "request_id": e.request_id,
            "sequence_no": int(e.sequence_no),
            "self_hash": e.entry_hash,
        }
        for e in StaffAuditEntry.objects.filter(scope_key="fleet").order_by("-sequence_no")[:50]
    ]
    sar_records = [
        {
            "id": str(s.id),
            "request_kind": s.request_kind,
            "status": s.status,
            "subject_pseudonym": s.subject_pseudonym,
            "organisation_slug": s.organisation_slug,
            "ticket_ref": s.ticket_ref,
            "due_at": _iso(s.due_at) or "",
            "completed_at": _iso(s.completed_at),
            "evidence_ref": s.evidence_ref,
            "recorded_by_identity_id": str(s.recorded_by_identity_id),
            "created_at": _iso(s.created_at) or "",
        }
        for s in StaffSarRecord.objects.order_by("-created_at", "-id")[:100]
    ]

    return {
        "staff_roster": staff_roster,
        "fleet_audit_chain": fleet_chain,
        "recent_audit_events": recent_audit_events,
        "sar_records": sar_records,
    }


# ------------------------------------------------------------ Triage Mutations ----


def triage_feedback_item(
    *,
    caller: VerifiedStaffRequest,
    feedback_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    new_status = body.get("status")
    if new_status not in FEEDBACK_STATUSES:
        raise StaffApiError(
            400, "invalid_status", "Invalid status", "status must be one of FEEDBACK_STATUSES"
        )
    severity = body.get("severity")
    if severity is not None and severity not in FEEDBACK_SEVERITIES:
        raise StaffApiError(
            400, "invalid_severity", "Invalid severity", "severity must be p0, p1, p2, or p3"
        )
    assigned_seat_supplied = "assigned_seat" in body
    assigned_seat = body.get("assigned_seat")
    if assigned_seat is not None and assigned_seat != "" and assigned_seat not in CANONICAL_SEATS:
        raise StaffApiError(
            400,
            "invalid_assigned_seat",
            "Invalid assigned seat",
            "assigned_seat must be a canonical seat or null",
        )
    vote_delta = body.get("vote_delta", 0)
    if isinstance(vote_delta, bool) or not isinstance(vote_delta, int) or not (-100 <= vote_delta <= 100):
        raise StaffApiError(
            400, "invalid_vote_delta", "Invalid vote delta", "vote_delta must be an integer in -100..100"
        )

    with transaction.atomic():
        item = StaffFeedbackItem.objects.select_for_update().filter(id=feedback_id).first()
        if item is None:
            raise StaffApiError(404, "feedback_not_found", "Feedback item not found")
        item.status = str(new_status)
        if severity is not None:
            item.severity = str(severity)
        if assigned_seat_supplied:
            item.assigned_seat = None if not assigned_seat else str(assigned_seat)
        item.vote_count = max(0, int(item.vote_count) + vote_delta)
        item.save(update_fields=["status", "severity", "assigned_seat", "vote_count", "updated_at"])

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.feedback.triaged",
            target_type="feedback",
            target_id=str(item.id),
            request_id=request_id,
            organisation_slug=item.organisation_slug,
            metadata={
                "status": item.status,
                "severity": item.severity,
                "assigned_seat": item.assigned_seat,
                "vote_count": item.vote_count,
            },
        )

    return _serialize_feedback_item(item, redact_engineering=False)


def create_feedback_github_draft(
    *,
    caller: VerifiedStaffRequest,
    feedback_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    target_repo = body.get("target_repository")
    if target_repo not in TARGET_REPOSITORIES:
        raise StaffApiError(
            400,
            "invalid_target_repository",
            "Invalid target repository",
            "target_repository must be an admitted Kodera repository",
        )
    milestone_raw = body.get("roadmap_milestone")
    if not isinstance(milestone_raw, str) or not (1 <= len(milestone_raw.strip()) <= 64):
        raise StaffApiError(
            400,
            "invalid_roadmap_milestone",
            "Invalid roadmap milestone",
            "roadmap_milestone must be 1..64 characters",
        )
    milestone = scrub_c1_text(milestone_raw.strip())

    with transaction.atomic():
        item = StaffFeedbackItem.objects.select_for_update().filter(id=feedback_id).first()
        if item is None:
            raise StaffApiError(404, "feedback_not_found", "Feedback item not found")
        scrubbed_summary = scrub_c1_text(item.summary).strip()
        scrubbed_details = scrub_c1_text(item.details).strip()
        if item.status in {"new", "triaged"}:
            item.status = "planned"
        item.roadmap_milestone = milestone
        item.external_issue_ref = f"github-draft:{target_repo}:{milestone}"
        item.save(update_fields=["status", "roadmap_milestone", "external_issue_ref", "updated_at"])

        title = f"[{item.severity.upper()}][{item.kind}] {scrubbed_summary}"[:160]
        body_markdown = (
            f"### C1 Feedback Reference\n"
            f"- Feedback ID: `{item.id}`\n"
            f"- Kind: `{item.kind}`\n"
            f"- Severity: `{item.severity}`\n"
            f"- Milestone: `{milestone}`\n\n"
            f"### Scrubbed Summary\n{scrubbed_summary}\n\n"
            f"### Scrubbed Details\n{scrubbed_details or '_No additional C1 details._'}\n"
        )
        query = urlencode({"title": title, "body": body_markdown})
        prefilled_url = f"https://github.com/{GITHUB_ORG}/{target_repo}/issues/new?{query}"

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.feedback.github_draft_created",
            target_type="feedback",
            target_id=str(item.id),
            request_id=request_id,
            organisation_slug=item.organisation_slug,
            metadata={
                "target_repository": str(target_repo),
                "roadmap_milestone": milestone,
                "status": item.status,
            },
        )

    return {
        "feedback_id": str(item.id),
        "status": item.status,
        "target_repository": str(target_repo),
        "roadmap_milestone": milestone,
        "title": title,
        "body_markdown": body_markdown,
        "prefilled_github_url": prefilled_url,
    }


def upsert_deal_card(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    slug_raw = body.get("prospect_slug")
    if not isinstance(slug_raw, str) or SLUG_RE.fullmatch(slug_raw.strip()) is None:
        raise StaffApiError(
            400,
            "invalid_prospect_slug",
            "Invalid prospect slug",
            "prospect_slug must be a lowercase DNS-safe slug (no personal names or emails)",
        )
    prospect_slug = slug_raw.strip()
    stage = body.get("stage")
    if stage not in DEAL_STAGES:
        raise StaffApiError(400, "invalid_stage", "Invalid deal stage")
    capacity_tier = body.get("capacity_tier_code")
    if capacity_tier not in CAPACITY_TIERS:
        raise StaffApiError(400, "invalid_capacity_tier", "Invalid capacity tier")
    owner_seat = body.get("owner_seat")
    if owner_seat not in CANONICAL_SEATS:
        raise StaffApiError(400, "invalid_owner_seat", "Invalid canonical seat")
    pack_code = body.get("pack_code")
    if not isinstance(pack_code, str) or SLUG_RE.fullmatch(pack_code.strip()) is None:
        raise StaffApiError(400, "invalid_pack_code", "Invalid pack_code")
    next_step_code = body.get("next_step_code")
    if not isinstance(next_step_code, str) or not (1 <= len(next_step_code.strip()) <= 64) or "@" in next_step_code:
        raise StaffApiError(400, "invalid_next_step_code", "Invalid next_step_code")
    mrr_cents = body.get("estimated_mrr_cents")
    if isinstance(mrr_cents, bool) or not isinstance(mrr_cents, int) or not (0 <= mrr_cents <= 1_000_000_000):
        raise StaffApiError(
            400, "invalid_estimated_mrr", "Invalid estimated_mrr_cents", "estimated_mrr_cents must be >= 0"
        )

    with transaction.atomic():
        deal, _ = StaffDealCard.objects.update_or_create(
            prospect_slug=prospect_slug,
            defaults={
                "stage": str(stage),
                "pack_code": pack_code.strip(),
                "capacity_tier_code": str(capacity_tier),
                "estimated_mrr_cents": mrr_cents,
                "owner_seat": str(owner_seat),
                "next_step_code": scrub_c1_text(next_step_code.strip()),
                "updated_by_identity_id": caller.identity_id,
            },
        )
        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.deal.upserted",
            target_type="deal_card",
            target_id=str(deal.id),
            request_id=request_id,
            metadata={
                "prospect_slug": deal.prospect_slug,
                "stage": deal.stage,
                "capacity_tier_code": deal.capacity_tier_code,
                "estimated_mrr_cents": int(deal.estimated_mrr_cents),
                "owner_seat": deal.owner_seat,
            },
        )

    return {
        "id": str(deal.id),
        "prospect_slug": deal.prospect_slug,
        "stage": deal.stage,
        "pack_code": deal.pack_code,
        "capacity_tier_code": deal.capacity_tier_code,
        "estimated_mrr_cents": int(deal.estimated_mrr_cents),
        "owner_seat": deal.owner_seat,
        "next_step_code": deal.next_step_code,
        "updated_at": _iso(deal.updated_at) or "",
    }


def open_waitlist_cohort(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    cohort_raw = body.get("cohort_code")
    if not isinstance(cohort_raw, str) or COHORT_CODE_RE.fullmatch(cohort_raw.strip()) is None:
        raise StaffApiError(
            400, "invalid_cohort_code", "Invalid cohort_code", "cohort_code must match [a-z0-9][a-z0-9_-]{1,62}"
        )
    cohort_code = cohort_raw.strip()
    limit_count = body.get("limit_count")
    if isinstance(limit_count, bool) or not isinstance(limit_count, int) or not (1 <= limit_count <= 500):
        raise StaffApiError(
            400, "invalid_limit_count", "Invalid limit_count", "limit_count must be an integer between 1 and 500"
        )

    with transaction.atomic():
        existing = StaffWaitlistCohort.objects.select_for_update().filter(cohort_code=cohort_code).first()
        if existing is not None:
            if int(existing.limit_count) != limit_count:
                raise StaffApiError(
                    409,
                    "cohort_already_opened_conflict",
                    "Cohort already opened with different limit",
                    "Waitlist cohort already exists with a different limit_count",
                )
            return {
                "id": str(existing.id),
                "cohort_code": existing.cohort_code,
                "opened_count": int(existing.opened_count),
                "landing_receipt_ref": existing.landing_receipt_ref,
                "idempotent_replay": True,
            }

        digest = hashlib.sha256(f"{cohort_code}:{limit_count}".encode()).hexdigest()[:12]
        receipt_ref = f"landing:{cohort_code}:{digest}"
        created = StaffWaitlistCohort.objects.create(
            cohort_code=cohort_code,
            limit_count=limit_count,
            opened_count=limit_count,
            landing_receipt_ref=receipt_ref,
            opened_by_identity_id=caller.identity_id,
        )
        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.waitlist.cohort_opened",
            target_type="waitlist_cohort",
            target_id=str(created.id),
            request_id=request_id,
            metadata={
                "cohort_code": created.cohort_code,
                "opened_count": int(created.opened_count),
                "landing_receipt_ref": created.landing_receipt_ref,
            },
        )

    return {
        "id": str(created.id),
        "cohort_code": created.cohort_code,
        "opened_count": int(created.opened_count),
        "landing_receipt_ref": created.landing_receipt_ref,
        "idempotent_replay": False,
    }


def create_sar_record(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    request_kind = body.get("request_kind")
    if request_kind not in SAR_KINDS:
        raise StaffApiError(
            400, "invalid_sar_kind", "Invalid SAR kind", "request_kind must be access, erasure, or portability"
        )
    subject_pseudonym = validate_sar_pseudonym(body.get("subject_pseudonym"))
    ticket_ref = validate_sar_evidence_ref(body.get("ticket_ref"))

    org_slug_raw = body.get("organisation_slug")
    org_slug: str | None = None
    if org_slug_raw is not None and org_slug_raw != "":
        if not isinstance(org_slug_raw, str) or SLUG_RE.fullmatch(org_slug_raw.strip()) is None:
            raise StaffApiError(400, "invalid_organisation_slug", "Invalid organisation_slug")
        org_slug = org_slug_raw.strip()

    now = datetime.now(UTC)
    due_at = now + timedelta(days=30)
    with transaction.atomic():
        sar = StaffSarRecord.objects.create(
            request_kind=str(request_kind),
            status="open",
            subject_pseudonym=subject_pseudonym,
            organisation_slug=org_slug,
            ticket_ref=ticket_ref,
            due_at=due_at,
            recorded_by_identity_id=caller.identity_id,
        )
        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.sar.created",
            target_type="sar_record",
            target_id=str(sar.id),
            request_id=request_id,
            organisation_slug=org_slug,
            metadata={
                "request_kind": sar.request_kind,
                "subject_pseudonym": sar.subject_pseudonym,
                "ticket_ref": sar.ticket_ref,
            },
        )

    return {
        "id": str(sar.id),
        "request_kind": sar.request_kind,
        "status": sar.status,
        "subject_pseudonym": sar.subject_pseudonym,
        "organisation_slug": sar.organisation_slug,
        "ticket_ref": sar.ticket_ref,
        "due_at": _iso(sar.due_at) or "",
        "completed_at": None,
        "evidence_ref": None,
        "recorded_by_identity_id": str(sar.recorded_by_identity_id),
        "created_at": _iso(sar.created_at) or "",
    }


def complete_sar_record(
    *,
    caller: VerifiedStaffRequest,
    sar_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    if body.get("status") != "completed":
        raise StaffApiError(
            400, "invalid_sar_status", "Invalid SAR status", "status must be 'completed'"
        )
    evidence_ref = validate_sar_evidence_ref(body.get("evidence_ref"))

    with transaction.atomic():
        sar = StaffSarRecord.objects.select_for_update().filter(id=sar_id).first()
        if sar is None:
            raise StaffApiError(404, "sar_not_found", "SAR record not found")
        if sar.status == "completed":
            raise StaffApiError(409, "sar_already_completed", "SAR record is already completed")
        sar.status = "completed"
        sar.completed_at = datetime.now(UTC)
        sar.evidence_ref = evidence_ref
        sar.completed_by_identity_id = caller.identity_id
        sar.save(
            update_fields=[
                "status",
                "completed_at",
                "evidence_ref",
                "completed_by_identity_id",
                "updated_at",
            ]
        )
        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.sar.completed",
            target_type="sar_record",
            target_id=str(sar.id),
            request_id=request_id,
            organisation_slug=sar.organisation_slug,
            metadata={"evidence_ref": sar.evidence_ref},
        )

    return {
        "id": str(sar.id),
        "request_kind": sar.request_kind,
        "status": sar.status,
        "subject_pseudonym": sar.subject_pseudonym,
        "organisation_slug": sar.organisation_slug,
        "ticket_ref": sar.ticket_ref,
        "due_at": _iso(sar.due_at) or "",
        "completed_at": _iso(sar.completed_at),
        "evidence_ref": sar.evidence_ref,
        "recorded_by_identity_id": str(sar.recorded_by_identity_id),
        "created_at": _iso(sar.created_at) or "",
    }


# -------------------------------------------------------------- Ops Mutations ----


def _count_active_enabled_holders_excluding(cursor: Any, role: str, excluded_identity_id: UUID) -> int:
    cursor.execute(
        """
        SELECT COUNT(DISTINCT g.identity_id)
        FROM (
          SELECT identity_id FROM staff_api_role_grant
          WHERE realm = %s AND role = %s AND revoked_at IS NULL
          UNION
          SELECT identity_id FROM identity_staffrole
          WHERE realm = %s AND role = %s AND revoked_at IS NULL
        ) g
        JOIN identity_identity i ON i.id = g.identity_id
        JOIN identity_user u ON u.id = i.user_id
        WHERE g.identity_id <> %s
          AND i.realm = %s
          AND i.enabled = TRUE
          AND i.deleted_at IS NULL
          AND u.enabled = TRUE
          AND u.deleted_at IS NULL
        """,
        [STAFF_REALM, role, STAFF_REALM, role, excluded_identity_id, STAFF_REALM],
    )
    row = cursor.fetchone()
    return int(row[0] or 0) if row else 0


def grant_staff_role_mutation(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    target_identity_id = _parse_uuid(body.get("identity_id"), "identity_id")
    role = body.get("role")
    if role not in STAFF_ROLES:
        raise StaffApiError(400, "invalid_staff_role", "Invalid staff role")
    if target_identity_id == caller.identity_id:
        raise StaffApiError(
            403,
            "self_role_mutation_forbidden",
            "Two-person rule violation",
            "Staff members cannot grant roles to their own identity",
        )

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('staff_roles_mutation'))")
            cursor.execute(
                """
                SELECT i.enabled AND u.enabled
                FROM identity_identity i
                JOIN identity_user u ON u.id = i.user_id
                WHERE i.id = %s AND i.realm = %s AND i.deleted_at IS NULL AND u.deleted_at IS NULL
                FOR UPDATE OF i, u
                """,
                [target_identity_id, STAFF_REALM],
            )
            found = cursor.fetchone()
            if found is None:
                raise StaffApiError(
                    404, "staff_identity_not_found", "Target staff identity not found"
                )
            if not bool(found[0]):
                raise StaffApiError(
                    409,
                    "staff_identity_disabled",
                    "Target staff identity is disabled",
                )

            existing = (
                StaffRoleGrant.objects.select_for_update()
                .filter(identity_id=target_identity_id, role=str(role), revoked_at__isnull=True)
                .first()
            )
            created_flag = False
            if existing is None:
                existing = StaffRoleGrant.objects.create(
                    identity_id=target_identity_id,
                    realm=STAFF_REALM,
                    role=str(role),
                    granted_by_identity_id=caller.identity_id,
                )
                created_flag = True

            if str(role) in IDENTITY_BRIDGE_STAFF_ROLES:
                cursor.execute(
                    """
                    SELECT id FROM identity_staffrole
                    WHERE identity_id = %s AND realm = %s AND role = %s AND revoked_at IS NULL
                    FOR UPDATE
                    """,
                    [target_identity_id, STAFF_REALM, str(role)],
                )
                if cursor.fetchone() is None:
                    cursor.execute(
                        """
                        INSERT INTO identity_staffrole (id, created_at, updated_at, identity_id, realm, role, revoked_at)
                        VALUES (%s, clock_timestamp(), clock_timestamp(), %s, %s, %s, NULL)
                        """,
                        [new_uuid7(), target_identity_id, STAFF_REALM, str(role)],
                    )
                    created_flag = True

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.role.granted",
            target_type="staff_identity",
            target_id=str(target_identity_id),
            request_id=request_id,
            metadata={"role": str(role), "created": created_flag},
        )

    return {
        "identity_id": str(target_identity_id),
        "role": str(role),
        "status": "granted",
        "created": created_flag,
    }


def revoke_staff_role_mutation(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    target_identity_id = _parse_uuid(body.get("identity_id"), "identity_id")
    role = body.get("role")
    if role not in STAFF_ROLES:
        raise StaffApiError(400, "invalid_staff_role", "Invalid staff role")
    if target_identity_id == caller.identity_id:
        raise StaffApiError(
            403,
            "self_role_mutation_forbidden",
            "Two-person rule violation",
            "Staff members cannot revoke roles from their own identity",
        )

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('staff_roles_mutation'))")
            cursor.execute(
                "SELECT id FROM identity_identity WHERE id = %s AND realm = %s AND deleted_at IS NULL",
                [target_identity_id, STAFF_REALM],
            )
            if cursor.fetchone() is None:
                raise StaffApiError(
                    404, "staff_identity_not_found", "Target staff identity not found"
                )

            if str(role) == "staff_owner":
                remaining_owners = _count_active_enabled_holders_excluding(
                    cursor, "staff_owner", target_identity_id
                )
                if remaining_owners < MIN_ACTIVE_OWNERS:
                    raise StaffApiError(
                        409,
                        "role_floor_violation",
                        "Owner floor violation",
                        "Cannot revoke the last active enabled staff_owner",
                    )
            elif str(role) == "staff_operator":
                remaining_operators = _count_active_enabled_holders_excluding(
                    cursor, "staff_operator", target_identity_id
                )
                if remaining_operators < MIN_ACTIVE_OPERATORS:
                    raise StaffApiError(
                        409,
                        "role_floor_violation",
                        "Operator floor violation",
                        "At least 2 active enabled staff_operator identities must remain",
                    )

            now = datetime.now(UTC)
            updated_grants = StaffRoleGrant.objects.filter(
                identity_id=target_identity_id,
                realm=STAFF_REALM,
                role=str(role),
                revoked_at__isnull=True,
            ).update(
                revoked_at=now,
                revoked_by_identity_id=caller.identity_id,
                updated_at=now,
            )

            updated_bridge = 0
            if str(role) in IDENTITY_BRIDGE_STAFF_ROLES:
                cursor.execute(
                    """
                    UPDATE identity_staffrole
                    SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
                    WHERE identity_id = %s AND realm = %s AND role = %s AND revoked_at IS NULL
                    """,
                    [target_identity_id, STAFF_REALM, str(role)],
                )
                updated_bridge = cursor.rowcount

            if updated_grants == 0 and updated_bridge == 0:
                raise StaffApiError(
                    404,
                    "staff_role_grant_not_found",
                    "Active grant not found",
                    "Target identity holds no active grant for the specified role",
                )

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.role.revoked",
            target_type="staff_identity",
            target_id=str(target_identity_id),
            request_id=request_id,
            metadata={"role": str(role)},
        )

    return {
        "identity_id": str(target_identity_id),
        "role": str(role),
        "status": "revoked",
    }


def register_issuer_snapshot_mutation(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    slug_raw = body.get("organisation_slug")
    if not isinstance(slug_raw, str) or SLUG_RE.fullmatch(slug_raw.strip()) is None:
        raise StaffApiError(400, "invalid_organisation_slug", "Invalid organisation_slug")
    org_slug = slug_raw.strip()

    gen_raw = body.get("generation")
    if not isinstance(gen_raw, str) or not (1 <= len(gen_raw.strip()) <= 128):
        raise StaffApiError(400, "invalid_generation", "Invalid generation identifier")
    generation = gen_raw.strip()

    expires_at = body.get("expires_at_epoch")
    now_epoch = int(datetime.now(UTC).timestamp())
    if isinstance(expires_at, bool) or not isinstance(expires_at, int) or expires_at <= now_epoch:
        raise StaffApiError(
            400,
            "invalid_expires_at",
            "Invalid expires_at_epoch",
            "expires_at_epoch must be a future Unix epoch timestamp",
        )

    public_jwks = validate_public_jwks(body.get("public_jwks"))

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT issuer
                FROM orgs_organisation
                WHERE slug = %s AND deleted_at IS NULL
                LIMIT 1
                """,
                [org_slug],
            )
            org_row = cursor.fetchone()
            if org_row is None:
                raise StaffApiError(
                    404,
                    "organisation_not_found",
                    "Organisation not found",
                    "Unknown organisation_slug",
                )
            bound_issuer = str(org_row[0])

        snapshot, created = StaffIssuerSnapshot.objects.update_or_create(
            organisation_slug=org_slug,
            generation=generation,
            defaults={
                "issuer": bound_issuer,
                "expires_at_epoch": expires_at,
                "public_jwks": public_jwks,
                "registered_by_identity_id": caller.identity_id,
            },
        )

        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.issuer_snapshot.registered",
            target_type="issuer_snapshot",
            target_id=str(snapshot.id),
            request_id=request_id,
            organisation_slug=org_slug,
            metadata={
                "organisation_slug": org_slug,
                "issuer": bound_issuer,
                "generation": generation,
                "expires_at_epoch": expires_at,
                "keys_count": len(public_jwks["keys"]),
                "created": created,
            },
        )

    return {
        "id": str(snapshot.id),
        "organisation_slug": snapshot.organisation_slug,
        "issuer": snapshot.issuer,
        "generation": snapshot.generation,
        "expires_at_epoch": int(snapshot.expires_at_epoch),
        "keys_count": len(public_jwks["keys"]),
        "created_at": _iso(snapshot.created_at) or "",
    }


def _non_negative_int(body: dict[str, Any], field: str, *, default: int | None = None) -> int:
    raw = body.get(field, default)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0 or raw > 10_000_000_000:
        raise StaffApiError(
            400, f"invalid_{field}", "Invalid numeric field", f"{field} must be a non-negative integer"
        )
    return raw


def record_finops_snapshot_mutation(
    *,
    caller: VerifiedStaffRequest,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, object]:
    period_raw = body.get("period_month")
    if not isinstance(period_raw, str) or PERIOD_MONTH_RE.fullmatch(period_raw.strip()) is None:
        raise StaffApiError(
            400, "invalid_period_month", "Invalid period_month", "period_month must match YYYY-MM"
        )
    period_month = period_raw.strip()

    env_code = body.get("environment_code")
    if env_code not in FINOPS_ENVIRONMENTS:
        raise StaffApiError(400, "invalid_environment_code", "Invalid environment_code")

    org_slug_raw = body.get("organisation_slug")
    org_slug: str | None = None
    if org_slug_raw is not None and org_slug_raw != "":
        if not isinstance(org_slug_raw, str) or SLUG_RE.fullmatch(org_slug_raw.strip()) is None:
            raise StaffApiError(400, "invalid_organisation_slug", "Invalid organisation_slug")
        org_slug = org_slug_raw.strip()

    mrr_cents = _non_negative_int(body, "mrr_cents")
    has_breakdown = any(
        k in body for k in ("infra_cost_cents", "backup_cost_cents", "mail_cost_cents")
    )
    if has_breakdown:
        infra_cost = _non_negative_int(body, "infra_cost_cents", default=0)
        backup_cost = _non_negative_int(body, "backup_cost_cents", default=0)
        mail_cost = _non_negative_int(body, "mail_cost_cents", default=0)
        total_cost = infra_cost + backup_cost + mail_cost
    else:
        total_cost = _non_negative_int(body, "total_cost_cents")
        infra_cost = total_cost
        backup_cost = 0
        mail_cost = 0

    active_orgs = _non_negative_int(body, "active_organisations", default=0)
    active_tenants = _non_negative_int(body, "active_tenants", default=0)
    free_visio = _non_negative_int(body, "free_visio_sessions", default=0)
    source_ref = validate_sar_evidence_ref(body.get("source_ref"))

    gross_margin_cents = mrr_cents - total_cost
    gross_margin_bps = (gross_margin_cents * 10000) // mrr_cents if mrr_cents > 0 else None
    gross_margin_alert = (
        gross_margin_bps is not None and gross_margin_bps < GROSS_MARGIN_FLOOR_BPS
    )

    with transaction.atomic():
        snap = StaffFinopsSnapshot.objects.create(
            period_month=period_month,
            environment_code=str(env_code),
            organisation_slug=org_slug,
            mrr_cents=mrr_cents,
            infra_cost_cents=infra_cost,
            backup_cost_cents=backup_cost,
            mail_cost_cents=mail_cost,
            total_cost_cents=total_cost,
            gross_margin_cents=gross_margin_cents,
            gross_margin_bps=gross_margin_bps,
            gross_margin_alert=gross_margin_alert,
            active_organisations=active_orgs,
            active_tenants=active_tenants,
            free_visio_sessions=free_visio,
            source_ref=source_ref,
            recorded_by_identity_id=caller.identity_id,
        )
        append_staff_audit_entry(
            actor_identity_id=caller.identity_id,
            actor_roles=caller.roles,
            action="staff.finops.snapshot_recorded",
            target_type="finops_snapshot",
            target_id=str(snap.id),
            request_id=request_id,
            organisation_slug=org_slug,
            metadata={
                "period_month": snap.period_month,
                "environment_code": snap.environment_code,
                "mrr_cents": int(snap.mrr_cents),
                "total_cost_cents": int(snap.total_cost_cents),
                "gross_margin_bps": snap.gross_margin_bps,
                "gross_margin_alert": snap.gross_margin_alert,
            },
        )

    return {
        "id": str(snap.id),
        "period_month": snap.period_month,
        "environment_code": snap.environment_code,
        "organisation_slug": snap.organisation_slug,
        "mrr_cents": int(snap.mrr_cents),
        "total_cost_cents": int(snap.total_cost_cents),
        "gross_margin_cents": int(snap.gross_margin_cents),
        "gross_margin_bps": snap.gross_margin_bps,
        "gross_margin_alert": snap.gross_margin_alert,
        "active_organisations": int(snap.active_organisations),
        "active_tenants": int(snap.active_tenants),
        "free_visio_sessions": int(snap.free_visio_sessions),
        "source_ref": snap.source_ref,
        "created_at": _iso(snap.created_at) or "",
    }


def verify_audit_chain_endpoint(body: dict[str, Any]) -> dict[str, object]:
    org_slug_raw = body.get("organisation_slug")
    scope_key = "fleet"
    if org_slug_raw is not None and org_slug_raw != "":
        if not isinstance(org_slug_raw, str) or SLUG_RE.fullmatch(org_slug_raw.strip()) is None:
            raise StaffApiError(400, "invalid_organisation_slug", "Invalid organisation_slug")
        scope_key = f"org:{org_slug_raw.strip()}"
    return verify_staff_audit_chain(scope_key)
