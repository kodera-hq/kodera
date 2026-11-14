"""The `kodera_api` writer role's `/staff/v1/*` grants are sufficient and strictly bounded.

Under a disposable PostgreSQL role holding ONLY `core/db/api_writer_role.py` grants:
- `assert_writer_grants(cursor, role)` passes (zero sequence grants, zero excess table/column/function grants).
- All 8 `staff_api_*` tables create zero PostgreSQL sequences (`UUIDField` PKs only).
- Real HTTP `/staff/v1/read/*`, `/staff/v1/triage/*`, and `/staff/v1/ops/*` endpoints succeed and
  append SHA-256 hash-chained `StaffAuditEntry` rows that verify cleanly.
- PostgreSQL privileges (`42501 INSUFFICIENT_PRIVILEGE`) refuse every `UPDATE`, `DELETE`, or
  `TRUNCATE` on `staff_api_audit_entry` as well as every unpermitted write across the remaining
  `staff_api_*` tables and unauthorized calls to the narrow `staff_*` database ports.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from django.db import DatabaseError, connection
from django.test import Client, RequestFactory, override_settings
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused
from test_staff_admin_api import (
    _RSA_PUBLIC_JWK,
    OPS_HOST,
    STAFF_PLANE_SETTINGS,
    _auth_headers,
    _jwks_fixture as _jwks_fixture,
    _mint_staff_jwt,
    _seed_customer_org_and_tenant,
    _seed_staff_member,
)

from apps.jobs import services as job_services
from apps.jobs.models import Job
from apps.outbox.models import OutboxDelivery
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements
from core.staff_api import services as staff_services
from core.staff_api.auth import ROLE_ADMIN_ROLES, authenticate_staff_request
from core.staff_api.errors import StaffApiError
from core.staff_api.models import StaffAuditEntry, StaffFeedbackItem, StaffRoleGrant

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer():
    role = f"staff_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_staff_api_models_have_zero_sequences_and_pass_assert_writer_grants(writer: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'S'
              AND c.relname LIKE 'staff_api_%'
            """
        )
        assert cursor.fetchall() == []
        assert_writer_grants(cursor, writer)

        # Granting UPDATE or DELETE on staff_api_audit_entry must immediately fail assert_writer_grants.
        for forbidden_grant in (
            f'GRANT UPDATE (action) ON TABLE "staff_api_audit_entry" TO "{writer}"',
            f'GRANT DELETE ON TABLE "staff_api_audit_entry" TO "{writer}"',
        ):
            cursor.execute(forbidden_grant)
            try:
                with pytest.raises(DatabaseError, match="API database role refused"):
                    assert_writer_grants(cursor, writer)
            finally:
                revoke_stmt = forbidden_grant.replace("GRANT ", "REVOKE ").replace(
                    f' TO "{writer}"', f' FROM "{writer}"'
                )
                cursor.execute(revoke_stmt)
        assert_writer_grants(cursor, writer)


def test_writer_role_serves_staff_v1_read_triage_ops_and_hash_chained_audit(writer: str) -> None:
    org, tenant = _seed_customer_org_and_tenant()
    owner = _seed_staff_member(roles=("staff_owner", "staff_operator"))
    operator_1 = _seed_staff_member(roles=("staff_operator",))
    operator_2 = _seed_staff_member(roles=("staff_operator",))
    candidate = _seed_staff_member(roles=())
    assert operator_2.id != operator_1.id

    feedback = StaffFeedbackItem.objects.create(
        organisation_id=org.id,
        organisation_slug=org.slug,
        kind="bug",
        source="console_drawer",
        severity="p2",
        status="new",
        surface="visio",
        summary="Visio reconnect loop reported by user@customer.example",
        details="Token Bearer secret-token-abcdef123456 failed refresh",
        reporter_pseudonym="rep_sha256_a1b2c3d4",
    )

    enqueued = job_services.enqueue_job(
        request=job_services.JobRequest(
            organisation_id=org.id,
            tenant_id=tenant.id,
            kind="rotate_secret",
            idempotency_key=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            desired_spec_hash=hashlib.sha256(b"writer-spec-1").hexdigest(),
            actor_type="staff",
            actor_id=operator_1.id,
        ),
        apply_desired_state=lambda: None,
    )
    claim = job_services.claim_job(runner_id="runner-staff-writer", job_id=enqueued.job_id)
    assert isinstance(claim, job_services.Claim)
    assert job_services.record_step(claim=claim, seq=1, status="running") is True
    dispatch_id = job_services.record_dispatch(
        claim=claim, seq=1, operation_ref="scw-writer-reconcile-1"
    )
    assert dispatch_id is not None
    assert job_services.hold_for_reconciliation(claim=claim, dispatch_id=dispatch_id) is True
    job_services.release_live_locks(claim=claim)

    now_dt = datetime.now(UTC)
    delivery = OutboxDelivery.objects.create(
        organisation=org,
        category="message",
        changes_realm=False,
        status="needs_reconciliation",
        operation_ref="smtp-writer-ambiguous-1",
        started_at=now_dt - timedelta(seconds=30),
        created_at=now_dt,
        updated_at=now_dt,
    )

    now_epoch = int(time.time())
    t_owner = _mint_staff_jwt(owner.subject, amr=["hwk"], auth_time=now_epoch)
    t_op1 = _mint_staff_jwt(operator_1.subject, amr=["hwk"], auth_time=now_epoch)
    evidence_block = {
        "provider": "scaleway",
        "resource_id": "fr-par-1/instance-writer-1",
        "request_id": "req-scw-writer-1",
        "observed_at": datetime.now(UTC).isoformat(),
    }

    try:
        with override_settings(**STAFF_PLANE_SETTINGS), acting_as(writer):
            assert current_user() == writer
            client = Client()

            # 1. Triage writes (deal insert + update, waitlist create + replay, feedback triage + draft, SAR create + complete)
            r_deal_insert = client.post(
                "/staff/v1/triage/deals",
                data=json.dumps(
                    {
                        "prospect_slug": "ville-nantes",
                        "stage": "lead",
                        "pack_code": "suite-territoriale",
                        "capacity_tier_code": "M",
                        "estimated_mrr_cents": 120_000,
                        "owner_seat": "Product seat",
                        "next_step_code": "qualification-call",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_deal_insert.status_code == 200

            r_deal_update = client.post(
                "/staff/v1/triage/deals",
                data=json.dumps(
                    {
                        "prospect_slug": "ville-nantes",
                        "stage": "qualified",
                        "pack_code": "suite-territoriale",
                        "capacity_tier_code": "L",
                        "estimated_mrr_cents": 240_000,
                        "owner_seat": "Product seat",
                        "next_step_code": "pilot-proposal",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_deal_update.status_code == 200
            assert r_deal_update.json()["stage"] == "qualified"

            r_cohort_create = client.post(
                "/staff/v1/triage/waitlist/open-cohort",
                data=json.dumps({"cohort_code": "writer-cohort-1", "limit_count": 20}),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_cohort_create.status_code == 200
            assert r_cohort_create.json()["idempotent_replay"] is False

            r_cohort_replay = client.post(
                "/staff/v1/triage/waitlist/open-cohort",
                data=json.dumps({"cohort_code": "writer-cohort-1", "limit_count": 20}),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_cohort_replay.status_code == 200
            assert r_cohort_replay.json()["idempotent_replay"] is True

            r_fb_triage = client.post(
                f"/staff/v1/triage/feedback/{feedback.id}",
                data=json.dumps(
                    {
                        "status": "triaged",
                        "severity": "p1",
                        "assigned_seat": "API seat",
                        "vote_delta": 2,
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_fb_triage.status_code == 200

            r_fb_draft = client.post(
                f"/staff/v1/triage/feedback/{feedback.id}/github-draft",
                data=json.dumps(
                    {
                        "target_repository": "kodera-core",
                        "roadmap_milestone": "v1.2-writer",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_fb_draft.status_code == 200

            r_sar_create = client.post(
                "/staff/v1/triage/sar",
                data=json.dumps(
                    {
                        "request_kind": "access",
                        "subject_pseudonym": f"sha256:{hashlib.sha256(b'sar-writer-0001').hexdigest()}",
                        "organisation_slug": org.slug,
                        "ticket_ref": "SAR-WRITER-0001",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_sar_create.status_code == 201
            sar_id = r_sar_create.json()["id"]

            r_sar_complete = client.post(
                f"/staff/v1/triage/sar/{sar_id}/complete",
                data=json.dumps({"status": "completed", "evidence_ref": "SAR-EVIDENCE-0001"}),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_sar_complete.status_code == 200

            # 2. Ops writes (FinOps snapshot, bridge + non-bridge role grant/revoke, issuer snapshot insert + update, job + delivery reconcile)
            r_finops_snap = client.post(
                "/staff/v1/ops/finops/snapshots",
                data=json.dumps(
                    {
                        "period_month": "2026-11",
                        "environment_code": "platform-prod",
                        "mrr_cents": 200_000,
                        "total_cost_cents": 90_000,
                        "active_organisations": 3,
                        "active_tenants": 4,
                        "source_ref": "SCW-WRITER-2026-11",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_op1, host=OPS_HOST),
            )
            assert r_finops_snap.status_code == 201

            for role_name in ("staff_owner", "staff_security", "staff_growth"):
                r_grant = client.post(
                    "/staff/v1/ops/staff-roles/grant",
                    data=json.dumps({"identity_id": str(candidate.id), "role": role_name}),
                    content_type="application/json",
                    **_auth_headers(t_owner, host=OPS_HOST),
                )
                assert r_grant.status_code == 200
                assert r_grant.json()["created"] is True

                r_revoke = client.post(
                    "/staff/v1/ops/staff-roles/revoke",
                    data=json.dumps({"identity_id": str(candidate.id), "role": role_name}),
                    content_type="application/json",
                    **_auth_headers(t_owner, host=OPS_HOST),
                )
                assert r_revoke.status_code == 200

            for exp_offset in (86400, 172800):
                r_issuer = client.post(
                    "/staff/v1/ops/issuer-snapshots",
                    data=json.dumps(
                        {
                            "organisation_slug": org.slug,
                            "generation": "gen-writer-1",
                            "expires_at_epoch": now_epoch + exp_offset,
                            "public_jwks": {"keys": [_RSA_PUBLIC_JWK]},
                        }
                    ),
                    content_type="application/json",
                    **_auth_headers(t_op1, host=OPS_HOST),
                )
                assert r_issuer.status_code == 201

            r_reconcile_job = client.post(
                f"/staff/v1/ops/reconcile/jobs/{enqueued.job_id}",
                data=json.dumps(
                    {
                        "exit": "resume",
                        "operation_outcome": "completed",
                        "compute_terminated": evidence_block,
                        "target_read": evidence_block,
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_op1, host=OPS_HOST),
            )
            assert r_reconcile_job.status_code == 200
            assert r_reconcile_job.json()["status"] == "queued"

            r_reconcile_delivery = client.post(
                f"/staff/v1/ops/reconcile/deliveries/{delivery.id}",
                data=json.dumps(
                    {
                        "exit": "fail",
                        "operation_outcome": "no_effect",
                        "compute_terminated": evidence_block,
                        "target_read": evidence_block,
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_op1, host=OPS_HOST),
            )
            assert r_reconcile_delivery.status_code == 200
            assert r_reconcile_delivery.json()["status"] == "failed"

            # 3. All 8 `/staff/v1/read/*` endpoints + `/staff/v1/ops/audit-chain/verify` under `writer`
            for read_path in (
                "/staff/v1/read/overview",
                "/staff/v1/read/organisations",
                "/staff/v1/read/pipeline",
                "/staff/v1/read/feedback",
                "/staff/v1/read/engineering",
                "/staff/v1/read/finops",
                "/staff/v1/read/sre",
                "/staff/v1/read/security",
            ):
                r_read = client.get(read_path, **_auth_headers(t_owner))
                assert r_read.status_code == 200, (read_path, r_read.content)

            r_verify_fleet = client.post(
                "/staff/v1/ops/audit-chain/verify",
                data="{}",
                content_type="application/json",
                **_auth_headers(t_op1, host=OPS_HOST),
            )
            assert r_verify_fleet.status_code == 200
            assert r_verify_fleet.json()["verified"] is True
            assert r_verify_fleet.json()["checked_count"] >= 10

            r_verify_org = client.post(
                "/staff/v1/ops/audit-chain/verify",
                data=json.dumps({"organisation_slug": org.slug}),
                content_type="application/json",
                **_auth_headers(t_op1, host=OPS_HOST),
            )
            assert r_verify_org.status_code == 200
            assert r_verify_org.json()["verified"] is True

        assert Job.objects.get(pk=enqueued.job_id).status == "queued"
        assert OutboxDelivery.objects.get(pk=delivery.id).status == "failed"
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                TRUNCATE
                  staff_api_audit_entry,
                  staff_api_role_grant,
                  staff_api_deal_card,
                  staff_api_waitlist_cohort,
                  staff_api_feedback_item,
                  staff_api_sar_record,
                  staff_api_finops_snapshot,
                  staff_api_issuer_snapshot
                CASCADE
                """
            )


@pytest.mark.parametrize(
    "statement",
    [
        # Append-only immutable SHA-256 hash-chained StaffAuditEntry: zero UPDATE, DELETE, or TRUNCATE!
        "UPDATE staff_api_audit_entry SET action = 'staff.tampered'",
        "UPDATE staff_api_audit_entry SET entry_hash = repeat('0', 64)",
        "UPDATE staff_api_audit_entry SET previous_hash = NULL",
        "UPDATE staff_api_audit_entry SET metadata = '{}'::jsonb",
        "DELETE FROM staff_api_audit_entry",
        "TRUNCATE staff_api_audit_entry",
        # Append-only FinOps & waitlist cohort tables and zero DELETE across all 8 staff_api_* tables:
        "UPDATE staff_api_finops_snapshot SET mrr_cents = 0",
        "DELETE FROM staff_api_finops_snapshot",
        "UPDATE staff_api_waitlist_cohort SET opened_count = 0",
        "DELETE FROM staff_api_waitlist_cohort",
        "DELETE FROM staff_api_role_grant",
        "DELETE FROM staff_api_deal_card",
        "DELETE FROM staff_api_feedback_item",
        "DELETE FROM staff_api_sar_record",
        "DELETE FROM staff_api_issuer_snapshot",
        # Immutable identity/key columns on mutable operational tables:
        "UPDATE staff_api_role_grant SET role = 'staff_owner'",
        "UPDATE staff_api_deal_card SET prospect_slug = 'rewritten'",
        "UPDATE staff_api_sar_record SET subject_pseudonym = 'rewritten'",
        "UPDATE staff_api_feedback_item SET summary = 'rewritten'",
        "UPDATE staff_api_issuer_snapshot SET generation = 'rewritten'",
        # Feedback items are triaged via UPDATE only, never inserted by `/staff/v1/*`:
        (
            "INSERT INTO staff_api_feedback_item ("
            "id, created_at, updated_at, kind, source, severity, status, surface, "
            "summary, details, reporter_pseudonym, vote_count"
            ") VALUES ("
            "gen_random_uuid(), now(), now(), 'bug', 'console_drawer', 'p2', 'new', 'visio', "
            "'s', 'd', 'rep_1234', 0"
            ")"
        ),
        # Narrow SECURITY DEFINER ports refuse unauthenticated/non-staff actor UUIDs with 42501:
        "SELECT staff_read_outbox_sre_summary(gen_random_uuid())",
        (
            "SELECT staff_sync_identity_bridge_role("
            "gen_random_uuid(), gen_random_uuid(), 'staff_security', 'grant', gen_random_uuid()"
            ")"
        ),
    ],
)
def test_writer_role_cannot_update_or_delete_audit_entries_or_exceed_staff_grants(
    writer: str, statement: str
) -> None:
    owner = _seed_staff_member(roles=("staff_owner",))
    now_epoch = int(time.time())
    t_owner = _mint_staff_jwt(owner.subject, amr=["hwk"], auth_time=now_epoch)

    try:
        with override_settings(**STAFF_PLANE_SETTINGS), acting_as(writer):
            client = Client()
            r_deal = client.post(
                "/staff/v1/triage/deals",
                data=json.dumps(
                    {
                        "prospect_slug": "audit-guard-org",
                        "stage": "lead",
                        "pack_code": "suite-territoriale",
                        "capacity_tier_code": "S",
                        "estimated_mrr_cents": 50_000,
                        "owner_seat": "Product seat",
                        "next_step_code": "initial-triage",
                    }
                ),
                content_type="application/json",
                **_auth_headers(t_owner),
            )
            assert r_deal.status_code == 200
            assert refused(statement) == INSUFFICIENT_PRIVILEGE, statement
        assert StaffAuditEntry.objects.filter(scope_key="fleet").count() == 1
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "TRUNCATE staff_api_audit_entry, staff_api_role_grant, staff_api_deal_card CASCADE"
            )


def test_writer_role_enforces_for_share_caller_fence_against_stale_caller(writer: str) -> None:
    owner_a = _seed_staff_member(roles=("staff_owner",))
    owner_b = _seed_staff_member(roles=("staff_owner",))
    candidate = _seed_staff_member(roles=())
    now_epoch = int(time.time())
    factory = RequestFactory()

    try:
        with override_settings(**STAFF_PLANE_SETTINGS), acting_as(writer):
            assert current_user() == writer
            req_a = factory.post(
                "/staff/v1/ops/staff-roles/grant",
                **_auth_headers(
                    _mint_staff_jwt(owner_a.subject, amr=["hwk"], auth_time=now_epoch),
                    host=OPS_HOST,
                ),
            )
            caller_a = authenticate_staff_request(
                req_a, plane="ops", allowed_roles=ROLE_ADMIN_ROLES
            )

            req_b = factory.post(
                "/staff/v1/ops/staff-roles/revoke",
                **_auth_headers(
                    _mint_staff_jwt(owner_b.subject, amr=["hwk"], auth_time=now_epoch),
                    host=OPS_HOST,
                ),
            )
            caller_b = authenticate_staff_request(
                req_b, plane="ops", allowed_roles=ROLE_ADMIN_ROLES
            )

            revoked = staff_services.revoke_staff_role_mutation(
                caller=caller_b,
                body={"identity_id": str(owner_a.id), "role": "staff_owner"},
                request_id="req-writer-revoke-a",
            )
            assert revoked["status"] == "revoked"

            with pytest.raises(StaffApiError) as exc_info:
                staff_services.grant_staff_role_mutation(
                    caller=caller_a,
                    body={"identity_id": str(candidate.id), "role": "staff_owner"},
                    request_id="req-writer-stale-a",
                )
            assert exc_info.value.status == 403
            assert exc_info.value.code == "insufficient_staff_role"

        assert (
            StaffRoleGrant.objects.filter(identity_id=candidate.id, revoked_at__isnull=True).count()
            == 0
        )
    finally:
        with connection.cursor() as cursor:
            cursor.execute("TRUNCATE staff_api_audit_entry, staff_api_role_grant CASCADE")

