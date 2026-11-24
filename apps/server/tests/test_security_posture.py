"""Unit tests for workspace cybersecurity posture scoring (0–100) and 1-click safe remediations."""

from __future__ import annotations

import json
import uuid
from contextlib import nullcontext
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from django.test import RequestFactory
from django.urls import resolve

from apps.audit import services as audit_services
from apps.workspaces import security_posture
from apps.workspaces.ai_policy import WorkspaceAiPolicySnapshot
from apps.workspaces.api import security_posture as posture_views
from apps.workspaces.moderation import RefusalError
from core.api.idempotency import StoredResponse
from core.db import api_writer_role
from services.identity.access_tokens import VerifiedAccessToken

ORG_ID = uuid.UUID("0192f3a4-5b6c-7d8e-9f01-23456789ab01")
WS_ID = uuid.UUID("0192f3a4-5b6c-7d8e-9f01-23456789ab02")
ACTOR_ID = uuid.UUID("0192f3a4-5b6c-7d8e-9f01-23456789ab03")
MEMBER_ID = uuid.UUID("0192f3a4-5b6c-7d8e-9f01-23456789ab04")
USER_ID = uuid.UUID("0192f3a4-5b6c-7d8e-9f01-23456789ab05")


def _healthy_facts(**overrides: Any) -> security_posture.SecurityPostureFacts:
    base: dict[str, Any] = {
        "organisation_id": ORG_ID,
        "workspace_id": WS_ID,
        "unbounded_invite_count": 0,
        "ai_enabled": False,
        "ai_eu_sovereign_only": True,
        "ai_provider_region": "eu",
        "ai_monthly_budget_micros": 50_000_000,
        "security_contact_configured": True,
        "privacy_contact_configured": True,
        "security_alerts_channel_configured": True,
        "stale_installation_secret_count": 0,
        "stale_bridge_secret_count": 0,
        "overprivileged_role_count": 0,
        "confidential_channel_count": 1,
        "empty_stale_rekey_room_count": 0,
        "active_stale_rekey_room_count": 0,
        "ai_endpoint_eu_compatible": True,
    }
    base.update(overrides)
    return security_posture.SecurityPostureFacts(**base)


def _token(
    *, email: str | None = "admin@acme.eu", email_verified: bool = True
) -> VerifiedAccessToken:
    return VerifiedAccessToken(
        issuer="https://auth.kodera.io/realms/acme",
        subject="sub-admin-1",
        audience=("kodera-server",),
        issued_at=1_700_000_000,
        expires_at=1_700_003_600,
        not_before=None,
        amr=None,
        acr=None,
        auth_time=1_700_000_000,
        email=email,
        email_verified=email_verified,
    )


def test_healthy_workspace_earns_100_points_and_grade_a() -> None:
    report = security_posture.evaluate_security_posture(_healthy_facts())
    assert report.score == 100
    assert report.max_score == 100
    assert report.grade == "A"
    assert report.passing_checks == 6
    assert report.total_checks == 6
    assert report.fixable_checks == 0
    weights = [check.max_points for check in report.checks]
    assert weights == [20, 20, 15, 15, 15, 15]
    assert sum(weights) == 100
    assert all(check.status == "pass" and not check.fix_available for check in report.checks)


@pytest.mark.parametrize(
    ("overrides", "expected_check_id", "lost_points", "expected_action", "expected_affected"),
    [
        (
            {"unbounded_invite_count": 3},
            "invite_hygiene",
            20,
            "cap_unbounded_invites",
            3,
        ),
        (
            {
                "ai_enabled": True,
                "ai_eu_sovereign_only": False,
                "ai_provider_region": "non_eu",
                "ai_monthly_budget_micros": 50_000_000,
            },
            "sovereign_ai_boundary",
            20,
            "enforce_eu_sovereign_ai",
            1,
        ),
        (
            {
                "ai_enabled": True,
                "ai_eu_sovereign_only": True,
                "ai_provider_region": "eu",
                "ai_monthly_budget_micros": 900_000_000_000,
            },
            "sovereign_ai_boundary",
            20,
            "enforce_eu_sovereign_ai",
            1,
        ),
        (
            {
                "security_contact_configured": False,
                "security_alerts_channel_configured": False,
            },
            "security_alert_routing",
            15,
            "provision_security_alerts_channel",
            2,
        ),
        (
            {"stale_installation_secret_count": 2},
            "extension_secret_rotation",
            15,
            "rotate_stale_extension_keys",
            2,
        ),
        (
            {"overprivileged_role_count": 1},
            "least_privilege_roles",
            15,
            "strip_excess_role_permissions",
            1,
        ),
        (
            {"confidential_channel_count": 0},
            "confidential_room_readiness",
            15,
            "provision_confidential_channel",
            1,
        ),
    ],
)
def test_each_weighted_check_deducts_exact_points_and_advertises_safe_1_click_fix(
    overrides: dict[str, Any],
    expected_check_id: str,
    lost_points: int,
    expected_action: str,
    expected_affected: int,
) -> None:
    report = security_posture.evaluate_security_posture(_healthy_facts(**overrides))
    assert report.score == 100 - lost_points
    assert report.passing_checks == 5
    assert report.fixable_checks == 1
    by_id = {c.id: c for c in report.checks}
    flagged = by_id[expected_check_id]
    assert flagged.status == "warn"
    assert flagged.earned_points == 0
    assert flagged.max_points == lost_points
    assert flagged.remediation_action == expected_action
    assert flagged.fix_available is True
    assert flagged.affected_count == expected_affected


@pytest.mark.parametrize(
    ("score", "expected_grade"),
    [
        (100, "A"),
        (90, "A"),
        (89, "B"),
        (80, "B"),
        (79, "C"),
        (65, "C"),
        (64, "D"),
        (50, "D"),
        (49, "E"),
        (35, "E"),
        (34, "F"),
        (0, "F"),
    ],
)
def test_grade_boundaries_cover_a_through_f_deterministically(
    score: int, expected_grade: str
) -> None:
    assert security_posture.grade_for_score(score) == expected_grade


def test_role_governance_detector_exempts_designated_admin_roles_only() -> None:
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="admins", kind="role", permissions=["manage_roles", "view_audit_log"]
        )
        is False
    )
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="security-admin", kind="role", permissions=["media.moderate"]
        )
        is False
    )
    # Non-role kinds (subteam/tag) even named "admin" cannot hold governance permissions silently.
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="admins", kind="subteam", permissions=["manage_roles"]
        )
        is True
    )
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="contractors", kind="role", permissions=["message.post", "message.delete_any"]
        )
        is True
    )
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="interns", kind="tag", permissions=["*"]
        )
        is True
    )
    assert (
        security_posture.role_has_excess_governance_permissions(
            slug="members", kind="role", permissions=["channel.view", "message.post", "file.read"]
        )
        is False
    )


def test_api_writer_role_grants_narrow_posture_remediation_columns_without_max_uses() -> None:
    assert "extensions_installation" in api_writer_role.SELECT
    assert ("workspaces_workspaceinvitelink", "expires_at") in api_writer_role.UPDATE_COLUMNS
    assert ("workspaces_workspaceinvitelink", "max_uses") not in api_writer_role.UPDATE_COLUMNS
    for col in ("generation", "previous_generation", "grace_expires_at", "updated_at"):
        assert ("extensions_installation", col) in api_writer_role.UPDATE_COLUMNS


def test_url_routing_and_operation_scope_declarations() -> None:
    read_match = resolve(f"/api/v1/organisations/{ORG_ID}/workspace/security-posture")
    assert read_match.func is posture_views.posture
    act_match = resolve(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture/actions/remediate"
    )
    assert act_match.func is posture_views.remediate


def test_http_endpoints_enforce_authentication_staff_lane_admin_role_and_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = RequestFactory()
    token = _token()

    # 1. Missing bearer token -> 401 with WWW-Authenticate: Bearer and Cache-Control: no-store
    unauth_req = factory.get(f"/api/v1/organisations/{ORG_ID}/workspace/security-posture")
    unauth_resp = posture_views.posture(unauth_req, ORG_ID)
    assert unauth_resp.status_code == 401
    assert unauth_resp["WWW-Authenticate"] == "Bearer"
    assert unauth_resp["Cache-Control"] == "no-store"

    # 2. Unsupported HTTP verb -> 405
    delete_req = factory.delete(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture",
        HTTP_AUTHORIZATION="Bearer tok-valid",
    )
    delete_resp = posture_views.posture(delete_req, ORG_ID)
    assert delete_resp.status_code == 405
    assert delete_resp["Allow"] == "GET"

    # 3. Staff lane -> 403 Forbidden
    monkeypatch.setattr(
        "apps.workspaces.api.moderation.verify_configured_token",
        lambda raw, *, trusted: (token, "staff"),
    )
    monkeypatch.setattr(
        "apps.workspaces.api.moderation.lanes.admit",
        lambda verified, lane: (verified, lane),
    )
    staff_req = factory.get(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture",
        HTTP_AUTHORIZATION="Bearer tok-staff",
    )
    assert posture_views.posture(staff_req, ORG_ID).status_code == 403

    # 4. Non-admin member (org_member / org_billing) -> 403 Forbidden on both GET and POST
    monkeypatch.setattr("apps.workspaces.security_posture.transaction.atomic", lambda: nullcontext())
    monkeypatch.setattr(
        "apps.workspaces.api.moderation.verify_configured_token",
        lambda raw, *, trusted: (token, "customer"),
    )
    monkeypatch.setattr(
        security_posture,
        "authorize_posture_admin",
        lambda verified, organisation_id: (_ for _ in ()).throw(RefusalError(403)),
    )
    member_get = factory.get(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture",
        HTTP_AUTHORIZATION="Bearer tok-member",
    )
    assert posture_views.posture(member_get, ORG_ID).status_code == 403

    member_post = factory.post(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture/actions/remediate",
        data=json.dumps({"action": "fix_all_safe"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer tok-member",
        HTTP_IDEMPOTENCY_KEY="idem-member-1",
    )
    assert posture_views.remediate(member_post, ORG_ID).status_code == 403

    # 5. Admin caller admitted; verify GET 200 wire payload and POST 400/422 validation guards
    ws_stub = SimpleNamespace(id=WS_ID, organisation_id=ORG_ID)
    caller_stub = SimpleNamespace(
        identity_id=ACTOR_ID, membership_id=MEMBER_ID, user_id=USER_ID, role="org_admin"
    )
    monkeypatch.setattr(
        security_posture,
        "authorize_posture_admin",
        lambda verified, organisation_id: (ws_stub, caller_stub),
    )
    monkeypatch.setattr("apps.workspaces.security_posture.transaction.atomic", lambda: nullcontext())
    monkeypatch.setattr(
        security_posture,
        "_collect_facts",
        lambda workspace, *, caller=None, now=None: _healthy_facts(unbounded_invite_count=2),
    )

    ok_get = factory.get(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture",
        HTTP_AUTHORIZATION="Bearer tok-admin",
        HTTP_X_REQUEST_ID="req_posture_read_01",
    )
    ok_resp = posture_views.posture(ok_get, ORG_ID)
    assert ok_resp.status_code == 200
    assert ok_resp["Cache-Control"] == "no-store"
    assert ok_resp["X-Request-Id"] == "req_posture_read_01"
    payload = json.loads(ok_resp.content)
    assert payload["score"] == 80
    assert payload["grade"] == "B"
    assert payload["fixable_checks"] == 1

    # Bypass DB idempotency table with an in-memory replay stub while keeping key checks
    def fake_respond_once(
        request: Any,
        *,
        issuer: str,
        subject: str,
        request_id: str,
        handler: Any,
        authority: Any,
    ) -> Any:
        if not request.headers.get("Idempotency-Key"):
            raise RefusalError(400, kind="idempotency-key-missing")
        authority(None)
        stored: StoredResponse = handler()
        from django.http import HttpResponse

        return HttpResponse(stored.body, status=stored.status, content_type=stored.content_type)

    monkeypatch.setattr("apps.workspaces.api.moderation.respond_once", fake_respond_once)

    # Missing Idempotency-Key -> 400
    no_key_post = factory.post(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture/actions/remediate",
        data=json.dumps({"action": "fix_all_safe"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer tok-admin",
    )
    assert posture_views.remediate(no_key_post, ORG_ID).status_code == 400

    # Duplicate JSON keys -> 400
    dup_post = factory.post(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture/actions/remediate",
        data='{"action":"fix_all_safe","action":"cap_unbounded_invites"}',
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer tok-admin",
        HTTP_IDEMPOTENCY_KEY="idem-dup-1",
    )
    assert posture_views.remediate(dup_post, ORG_ID).status_code == 400

    # Unknown action -> 422
    monkeypatch.setattr(security_posture, "lock_organisation_fence", lambda **kw: None)
    monkeypatch.setattr(security_posture, "lock_workspace", lambda **kw: None)
    bad_action_post = factory.post(
        f"/api/v1/organisations/{ORG_ID}/workspace/security-posture/actions/remediate",
        data=json.dumps({"action": "drop_production_database"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer tok-admin",
        HTTP_IDEMPOTENCY_KEY="idem-bad-1",
    )
    assert posture_views.remediate(bad_action_post, ORG_ID).status_code == 422


def test_remediate_fix_all_safe_lifts_zero_score_to_100_and_records_audit_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise remediate_security_posture + all 6 single-check remediations from 0 -> 100."""
    state: dict[str, Any] = {
        "unbounded_invites": 4,
        "ai_snapshot": WorkspaceAiPolicySnapshot(
            id=uuid.uuid4(),
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            enabled=True,
            provider="byom",
            provider_region="non_eu",
            eu_sovereign_only=False,
            self_hosted_endpoint="",
            model="custom-llm",
            sealed_byom_config=b"sealed",
            monthly_budget_micros=999_000_000_000,
            monthly_spent_micros=0,
            budget_period="current",
        ),
        "sec_contact": None,
        "priv_contact": None,
        "alert_channel_id": None,
        "stale_extensions": 2,
        "roles": [
            SimpleNamespace(
                id=uuid.uuid4(),
                slug="admins",
                kind="role",
                permissions=["manage_roles", "view_audit_log", "message.post"],
                saved_fields=None,
                save=lambda **kw: None,
            ),
            SimpleNamespace(
                id=uuid.uuid4(),
                slug="contributors",
                kind="role",
                permissions=["message.post", "manage_roles", "message.delete_any", "*"],
                saved_fields=None,
            ),
        ],
        "confidential_channels": 0,
        "stale_rekey_rooms": 0,
        "audit_events": [],
        "channel_sets": [],
    }

    def save_contributor_role(*, update_fields: list[str] | None = None) -> None:
        state["roles"][1].saved_fields = update_fields

    state["roles"][1].save = save_contributor_role

    class WorkspaceStub:
        pk = WS_ID
        id = WS_ID
        organisation_id = ORG_ID
        security_alerts_channel_id: uuid.UUID | None = None

        def save(self, *, update_fields: list[str] | None = None) -> None:
            state["alert_channel_id"] = self.security_alerts_channel_id

        def refresh_from_db(self, fields: list[str] | None = None) -> None:
            return None

    ws = WorkspaceStub()
    caller = SimpleNamespace(
        identity_id=ACTOR_ID, membership_id=MEMBER_ID, user_id=USER_ID, role="org_owner"
    )

    monkeypatch.setattr("apps.workspaces.security_posture.transaction.atomic", lambda: nullcontext())
    monkeypatch.setattr(
        security_posture,
        "authorize_posture_admin",
        lambda verified, organisation_id: (ws, caller),
    )
    monkeypatch.setattr(security_posture, "lock_organisation_fence", lambda **kw: None)
    monkeypatch.setattr(security_posture, "lock_workspace", lambda **kw: None)
    monkeypatch.setattr(
        "apps.workspaces.security_posture.Workspace.objects",
        SimpleNamespace(
            select_for_update=lambda: SimpleNamespace(get=lambda pk: ws),
            filter=lambda **kw: SimpleNamespace(update=lambda **u: 1),
        ),
    )

    def collect_from_state(
        workspace: Any, *, caller: Any = None, now: datetime | None = None
    ) -> security_posture.SecurityPostureFacts:
        snap = state["ai_snapshot"]
        overpriv = sum(
            1
            for r in state["roles"]
            if security_posture.role_has_excess_governance_permissions(
                slug=r.slug, kind=r.kind, permissions=r.permissions
            )
        )
        return security_posture.SecurityPostureFacts(
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            unbounded_invite_count=state["unbounded_invites"],
            ai_enabled=snap.enabled,
            ai_eu_sovereign_only=snap.eu_sovereign_only,
            ai_provider_region=snap.provider_region,
            ai_monthly_budget_micros=snap.monthly_budget_micros,
            security_contact_configured=bool(state["sec_contact"]),
            privacy_contact_configured=bool(state["priv_contact"]),
            security_alerts_channel_configured=state["alert_channel_id"] is not None,
            stale_installation_secret_count=state["stale_extensions"],
            overprivileged_role_count=overpriv,
            confidential_channel_count=state["confidential_channels"],
            empty_stale_rekey_room_count=state["stale_rekey_rooms"],
            ai_endpoint_eu_compatible=security_posture.ai_endpoint_is_eu_sovereign_compatible(
                snap, organisation_id=ORG_ID, workspace_id=WS_ID
            ),
        )

    monkeypatch.setattr(security_posture, "_collect_facts", collect_from_state)

    # Wire each of the 6 check remediations against `state`:
    class InviteFilterStub:
        def update(self, *, expires_at: datetime, updated_at: datetime) -> int:
            assert expires_at == updated_at + timedelta(days=7)
            count = int(state["unbounded_invites"])
            state["unbounded_invites"] = 0
            return count

    monkeypatch.setattr(
        "apps.workspaces.security_posture.WorkspaceInviteLink.objects",
        SimpleNamespace(filter=lambda **kw: InviteFilterStub()),
    )
    monkeypatch.setattr(
        security_posture,
        "get_workspace_ai_policy_snapshot",
        lambda **kw: state["ai_snapshot"],
    )

    def fake_upsert_ai(**kwargs: Any) -> WorkspaceAiPolicySnapshot:
        updated = WorkspaceAiPolicySnapshot(
            id=state["ai_snapshot"].id,
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            enabled=kwargs["enabled"],
            provider=kwargs["provider"],
            provider_region=kwargs["provider_region"],
            eu_sovereign_only=kwargs["eu_sovereign_only"],
            self_hosted_endpoint=kwargs["self_hosted_endpoint"],
            model=kwargs["model"],
            sealed_byom_config=kwargs["sealed_byom_config"],
            monthly_budget_micros=kwargs["monthly_budget_micros"],
            monthly_spent_micros=0,
            budget_period="current",
        )
        state["ai_snapshot"] = updated
        return updated

    monkeypatch.setattr(security_posture, "upsert_workspace_ai_policy", fake_upsert_ai)

    def fake_ensure_contacts(*, organisation_id: uuid.UUID, fallback_email: str | None) -> bool:
        if state["sec_contact"] and state["priv_contact"]:
            return False
        state["sec_contact"] = fallback_email
        state["priv_contact"] = fallback_email
        return True

    monkeypatch.setattr(
        security_posture, "ensure_security_and_privacy_contacts", fake_ensure_contacts
    )

    def fake_provision_channel(
        *,
        workspace: Any,
        template_key: str,
        default_name: str,
        is_confidential: bool,
        reason: str,
    ) -> Any:
        ch_id = uuid.uuid4()
        if is_confidential:
            state["confidential_channels"] += 1
        state["channel_sets"].append(reason)
        return SimpleNamespace(id=ch_id, is_confidential=is_confidential, name=default_name)

    monkeypatch.setattr(
        security_posture, "_provision_text_channel_if_absent", fake_provision_channel
    )
    monkeypatch.setattr(
        "apps.workspaces.security_posture.Channel.objects",
        SimpleNamespace(
            filter=lambda **kw: SimpleNamespace(
                exists=lambda: (
                    state["confidential_channels"] > 0
                    if kw.get("is_confidential")
                    else state["alert_channel_id"] is not None
                )
            )
        ),
    )

    def fake_rotate_extensions(**kwargs: Any) -> int:
        n = int(state["stale_extensions"])
        state["stale_extensions"] = 0
        return n

    monkeypatch.setattr(
        security_posture, "rotate_stale_workspace_extension_keys", fake_rotate_extensions
    )
    monkeypatch.setattr(
        "apps.workspaces.security_posture.WorkspaceRole.objects",
        SimpleNamespace(
            select_for_update=lambda: SimpleNamespace(
                filter=lambda **kw: SimpleNamespace(order_by=lambda *a: state["roles"])
            )
        ),
    )
    monkeypatch.setattr(
        security_posture,
        "emit_iam_channel_set",
        lambda workspace, reason: state["channel_sets"].append(reason),
    )

    def fake_record_audit(**kwargs: Any) -> None:
        # Validate against the real production audit metadata guard!
        audit_services._check_workspace_resource_metadata(kwargs["metadata"])
        state["audit_events"].append(kwargs)

    monkeypatch.setattr(security_posture, "record_workspace_resource_event", fake_record_audit)

    result = security_posture.remediate_security_posture(
        verified=_token(email="security-lead@acme.eu"),
        organisation_id=ORG_ID,
        action="fix_all_safe",
        request_id="req_fix_all_01",
    )

    assert result["requested_action"] == "fix_all_safe"
    assert result["score_before"] == 0
    assert result["applied_actions"] == list(security_posture.ORDERED_ACTIONS)
    assert result["posture"]["score"] == 100
    assert result["posture"]["grade"] == "A"
    assert result["posture"]["passing_checks"] == 6
    assert result["posture"]["fixable_checks"] == 0

    # Admin role kept its governance permissions; contributor role was stripped to safe capabilities
    assert "manage_roles" in state["roles"][0].permissions
    assert state["roles"][1].permissions == ["message.post"]

    # Non-EU BYOM config is never relabeled as EU: AI is paused and reset to sovereign EU adapter
    assert state["ai_snapshot"].enabled is False
    assert state["ai_snapshot"].provider == "mistral"
    assert state["ai_snapshot"].eu_sovereign_only is True
    assert state["ai_snapshot"].provider_region == "eu"
    assert state["ai_snapshot"].self_hosted_endpoint == ""
    assert state["ai_snapshot"].sealed_byom_config == b""
    assert (
        0
        < state["ai_snapshot"].monthly_budget_micros
        <= security_posture.MAX_SAFE_MONTHLY_AI_BUDGET_MICROS
    )

    # Exactly one AuditEvent emitted with non-PII summary metadata
    assert len(state["audit_events"]) == 1
    audit_evt = state["audit_events"][0]
    assert audit_evt["action"] == "workspace.security_posture.configured"
    assert audit_evt["organisation_id"] == ORG_ID
    assert audit_evt["target_id"] == WS_ID
    assert audit_evt["actor_id"] == ACTOR_ID
    assert audit_evt["metadata"] == {
        "requested_action": "fix_all_safe",
        "applied_actions": list(security_posture.ORDERED_ACTIONS),
        "score_before": 0,
        "score_after": 100,
    }

    # Re-running fix_all_safe when already at 100/100 is an idempotent no-op on applied_actions
    second = security_posture.remediate_security_posture(
        verified=_token(email="security-lead@acme.eu"),
        organisation_id=ORG_ID,
        action="fix_all_safe",
        request_id="req_fix_all_02",
    )
    assert second["score_before"] == 100
    assert second["applied_actions"] == []
    assert second["posture"]["score"] == 100


def test_manual_only_flags_for_bridges_active_rekey_rooms_non_eu_endpoints_and_role_ceilings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify P1-4, P1-5, P1-6, P1-7, and P2-8 invariants."""
    from apps.e2ee import selectors as e2ee_selectors

    # 1. P1-7: Stale CoexistenceBridge only -> status='warn', fix_available=False
    bridge_only = security_posture.evaluate_security_posture(
        _healthy_facts(stale_installation_secret_count=0, stale_bridge_secret_count=2)
    )
    ext_check = {c.id: c for c in bridge_only.checks}["extension_secret_rotation"]
    assert ext_check.status == "warn"
    assert ext_check.fix_available is False
    assert ext_check.affected_count == 2
    assert bridge_only.fixable_checks == 0

    # 2. P1-2 / P2-8: BOTH empty and active `rekey_required=True` rooms set `fix_available=False`
    #    once a confidential channel exists, because advancing MLS epochs requires a client-signed
    #    commit `Envelope` (server holds zero MLS signing keys).
    assert not hasattr(e2ee_selectors, "clear_empty_rekey_required_rooms")
    for rekey_overrides in (
        {"empty_stale_rekey_room_count": 1, "active_stale_rekey_room_count": 0},
        {"empty_stale_rekey_room_count": 0, "active_stale_rekey_room_count": 1},
    ):
        rekey_report = security_posture.evaluate_security_posture(
            _healthy_facts(confidential_channel_count=1, **rekey_overrides)
        )
        conf_check = {c.id: c for c in rekey_report.checks}["confidential_room_readiness"]
        assert conf_check.status == "warn"
        assert conf_check.fix_available is False
        assert conf_check.affected_count == 1
        assert rekey_report.fixable_checks == 0

    # 3. `confidential_room_grant_ready` requires `epoch >= 1` AND `rekey_required == False`:
    def _stub_room_objects(row: tuple[int, bool] | None) -> Any:
        result = SimpleNamespace(first=lambda: row)
        qs = SimpleNamespace(
            filter=lambda **kw: SimpleNamespace(values_list=lambda *cols: result),
            values_list=lambda *cols: result,
        )
        return SimpleNamespace(filter=lambda **kw: qs)

    for db_row, expected_ready in (
        (None, False),
        ((0, False), False),
        ((3, True), False),
        ((3, False), True),
    ):
        monkeypatch.setattr("apps.e2ee.selectors.Room.objects", _stub_room_objects(db_row))
        assert (
            e2ee_selectors.confidential_room_grant_ready(
                channel_id=uuid.uuid4(), organisation_id=ORG_ID
            )
            is expected_ready
        )

    # 4. P1-6: Non-EU OpenAI endpoint disguised as provider_region="eu" is flagged as incompatible
    disguised_non_eu = WorkspaceAiPolicySnapshot(
        id=uuid.uuid4(),
        organisation_id=ORG_ID,
        workspace_id=WS_ID,
        enabled=True,
        provider="self_hosted",
        provider_region="eu",
        eu_sovereign_only=True,
        self_hosted_endpoint="https://api.openai.com/v1",
        model="gpt-custom",
        sealed_byom_config=b"",
        monthly_budget_micros=10_000_000,
        monthly_spent_micros=0,
        budget_period="current",
    )
    assert (
        security_posture.ai_endpoint_is_eu_sovereign_compatible(
            disguised_non_eu, organisation_id=ORG_ID, workspace_id=WS_ID
        )
        is False
    )

    # 5. P1-5: org_admin cannot strip permissions from a role at/above their hierarchy ceiling
    high_role = SimpleNamespace(
        id=uuid.uuid4(),
        slug="directors",
        kind="role",
        position=10,
        permissions=["manage_roles", "message.post"],
        save=lambda **kw: (_ for _ in ()).throw(AssertionError("must not mutate above ceiling")),
    )
    ws_stub = SimpleNamespace(id=WS_ID, pk=WS_ID, organisation_id=ORG_ID)
    admin_caller = SimpleNamespace(
        identity_id=ACTOR_ID, membership_id=MEMBER_ID, user_id=USER_ID, role="org_admin"
    )
    monkeypatch.setattr(
        "apps.workspaces.security_posture.WorkspaceRole.objects",
        SimpleNamespace(
            select_for_update=lambda: SimpleNamespace(
                filter=lambda **kw: SimpleNamespace(order_by=lambda *a: [high_role])
            )
        ),
    )
    monkeypatch.setattr(security_posture, "_caller_role_ceiling", lambda ws, caller: 5)
    monkeypatch.setattr(
        security_posture,
        "check_manage",
        lambda ws, caller, roles, **kw: (_ for _ in ()).throw(RefusalError(403)),
    )

    # Direct strip_excess_role_permissions raises 403 via check_manage:
    with pytest.raises(RefusalError) as ceiling_refused:
        security_posture._apply_single_remediation(
            action="strip_excess_role_permissions",
            workspace=ws_stub,  # type: ignore[arg-type]
            caller=admin_caller,  # type: ignore[arg-type]
            verified=_token(),
            now=datetime(2026, 1, 1, tzinfo=None),
            strict_single=True,
        )
    assert ceiling_refused.value.status == 403

    # fix_all_safe (strict_single=False) skips roles above ceiling without mutating them:
    assert (
        security_posture._apply_single_remediation(
            action="strip_excess_role_permissions",
            workspace=ws_stub,  # type: ignore[arg-type]
            caller=admin_caller,  # type: ignore[arg-type]
            verified=_token(),
            now=datetime(2026, 1, 1, tzinfo=None),
            strict_single=False,
        )
        is False
    )
