"""Zero-trust `/staff/v1/{read,triage,ops}/*` C1 backend, RBAC, step-up, audit chain & boundary tests."""

from __future__ import annotations

import ast
import hashlib
import json
import re
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import jwt
import pytest
import yaml
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.exceptions import ImproperlyConfigured
from django.db import connection, transaction
from django.test import Client, RequestFactory, override_settings
from django.urls import URLPattern, URLResolver, get_resolver
from django.utils import timezone

from apps.identity.models import STAFF_REALM, Identity, StaffRole, User
from apps.jobs import services as job_services
from apps.jobs.models import Job
from apps.orgs.models import Membership, Organisation, SlugReservation
from apps.outbox.models import OutboxDelivery
from apps.tenancy.models import Tenant
from config.environment import staff_oidc_issuer, staff_oidc_jwks_url, staff_ops_hosts
from core.api.scopes import ATTRIBUTE as DECLARED_OPS_ATTR
from core.staff_api import views as staff_views
from core.staff_api.auth import clear_jwks_cache, register_test_jwks
from core.staff_api.errors import (
    REQUEST_ID_RE,
    request_correlation_id,
    staff_json_response,
    staff_problem_response,
)
from core.staff_api.models import (
    GROSS_MARGIN_FLOOR_BPS,
    OPS_STEP_UP_MAX_AGE_SEC,
    StaffAuditEntry,
    StaffFeedbackItem,
    StaffRoleGrant,
)

SERVER_ROOT = Path(__file__).resolve().parents[1]
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
STAFF_JWKS_URL = "https://identity.staff.test/realms/kodera-staff/protocol/openid-connect/certs"
ADMIN_HOST = "admin.kodera.io"
OPS_HOST = "ops-admin.kodera.io"
ALLOWED_TEST_HOSTS = ["localhost", "127.0.0.1", "testserver", ADMIN_HOST, OPS_HOST]
STAFF_ORIGINS = "https://admin.kodera.io,https://ops-admin.kodera.io"

_RSA_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_RSA_PUBLIC_JWK: dict[str, Any] = {
    **json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(_RSA_PRIVATE_KEY.public_key())),
    "kid": "staff-sig-1",
    "use": "sig",
    "alg": "RS256",
}
_WRONG_RSA_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)

STAFF_PLANE_SETTINGS: dict[str, Any] = {
    "ALLOWED_HOSTS": ALLOWED_TEST_HOSTS,
    "KODERA_STAFF_OIDC_ISSUER": STAFF_ISSUER,
    "KODERA_STAFF_OIDC_JWKS_URL": STAFF_JWKS_URL,
    "KODERA_STAFF_OPS_HOSTS": (OPS_HOST,),
    "KODERA_STAFF_ADMIN_ORIGINS": STAFF_ORIGINS,
}


@pytest.fixture(autouse=True)
def _jwks_fixture() -> Any:
    register_test_jwks(STAFF_JWKS_URL, {"keys": [_RSA_PUBLIC_JWK]})
    yield
    clear_jwks_cache()


def _mint_staff_jwt(
    subject: str,
    *,
    issuer: str = STAFF_ISSUER,
    azp: str = "kodera-admin",
    aud: list[str] | str = ("kodera-admin-api", "kodera-server"),  # type: ignore[assignment]
    amr: list[str] | None = None,
    auth_time: int | None = None,
    exp_offset: int = 300,
    nbf_offset: int | None = None,
    kid: str = "staff-sig-1",
    private_key: rsa.RSAPrivateKey = _RSA_PRIVATE_KEY,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": issuer,
        "sub": subject,
        "azp": azp,
        "aud": list(aud) if isinstance(aud, tuple) else aud,
        "iat": now,
        "exp": now + exp_offset,
    }
    if amr is not None:
        payload["amr"] = amr
    if auth_time is not None:
        payload["auth_time"] = auth_time
    if nbf_offset is not None:
        payload["nbf"] = now + nbf_offset
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": kid})


def _seed_staff_member(
    *,
    roles: tuple[str, ...] = (),
    display_name: str | None = "Staff Operator",
    enabled: bool = True,
) -> Identity:
    suffix = uuid.uuid4().hex[:10]
    subject = f"staff-sub-{suffix}"
    email = f"staff-{suffix}@staff.example"
    user = User.objects.create(email=email, display_name=display_name, enabled=enabled)
    identity = Identity.objects.create(
        user=user,
        organisation=None,
        issuer=STAFF_ISSUER,
        realm=STAFF_REALM,
        subject=subject,
        email=email,
        enabled=enabled,
    )
    for role in roles:
        StaffRoleGrant.objects.create(
            identity_id=identity.id,
            realm=STAFF_REALM,
            role=role,
            granted_by_identity_id=identity.id,
        )
        if role in {"staff_operator", "staff_security", "staff_support"}:
            StaffRole.objects.create(identity=identity, realm=STAFF_REALM, role=role)
    return identity


def _seed_customer_org_and_tenant(
    *,
    slug: str | None = None,
    org_name: str = "Acme Defense Industries SAS",
    tenant_name: str = "Acme Secret Production Workspace",
) -> tuple[Organisation, Tenant]:
    org_slug = slug or ("org-" + uuid.uuid4().hex[:10])
    tenant_slug = "ten-" + uuid.uuid4().hex[:10]
    now = timezone.now()
    with transaction.atomic():
        org = Organisation.objects.create(
            slug=org_slug,
            realm=org_slug,
            issuer=f"https://identity.customer.test/realms/{org_slug}",
            name=org_name,
            state="active",
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug=org_slug,
            organisation=org,
            state="active",
        )
        member_user = User.objects.create(
            email=f"owner@{org_slug}.example",
            display_name="Org Owner",
            enabled=True,
        )
        Membership.objects.create(
            user=member_user,
            organisation=org,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        tenant = Tenant.objects.create(
            organisation=org,
            slug=tenant_slug,
            name=tenant_name,
            status="active",
            status_changed_at=now,
            pack_code="suite-enterprise",
            capacity_tier_code="M",
            apps=["visio", "messaging"],
            region="fr-par",
            realm=org_slug,
            locale="fr",
        )
    return org, tenant


def _auth_headers(
    token: str,
    *,
    host: str = ADMIN_HOST,
    request_id: str | None = None,
) -> dict[str, Any]:
    headers: dict[str, Any] = {
        "HTTP_AUTHORIZATION": f"Bearer {token}",
        "HTTP_HOST": host,
    }
    if request_id is not None:
        headers["HTTP_X_REQUEST_ID"] = request_id
    return headers


# ------------------------------------------------ Startup Environment Validators ----


def test_staff_environment_validators_enforce_realm_https_and_split_ops_hosts() -> None:
    assert staff_oidc_issuer({}) is None
    assert staff_oidc_jwks_url({}) is None
    assert staff_ops_hosts({}) == ()

    assert (
        staff_oidc_issuer({"KODERA_STAFF_OIDC_ISSUER": STAFF_ISSUER}, loopback_issuers=False)
        == STAFF_ISSUER
    )
    assert (
        staff_oidc_jwks_url(
            {"KODERA_STAFF_OIDC_JWKS_URL": STAFF_JWKS_URL}, loopback_issuers=False
        )
        == STAFF_JWKS_URL
    )
    assert staff_ops_hosts(
        {"KODERA_STAFF_OPS_HOSTS": "Ops-Admin.Kodera.io, ops-admin-2.kodera.io"},
        loopback_issuers=False,
    ) == ("ops-admin.kodera.io", "ops-admin-2.kodera.io")

    # Wrong realm rejected
    with pytest.raises(ImproperlyConfigured):
        staff_oidc_issuer(
            {"KODERA_STAFF_OIDC_ISSUER": "https://auth.kodera.io/realms/acme-corp"},
            loopback_issuers=False,
        )
    # Loopback / HTTP rejected when loopback_issuers=False
    with pytest.raises(ImproperlyConfigured):
        staff_oidc_issuer(
            {"KODERA_STAFF_OIDC_ISSUER": "http://localhost:8080/realms/kodera-staff"},
            loopback_issuers=False,
        )
    with pytest.raises(ImproperlyConfigured):
        staff_oidc_jwks_url(
            {
                "KODERA_STAFF_OIDC_JWKS_URL": (
                    "http://localhost:8080/realms/kodera-staff/protocol/openid-connect/certs"
                )
            },
            loopback_issuers=False,
        )
    # Public admin.* host MUST be refused on KODERA_STAFF_OPS_HOSTS
    with pytest.raises(ImproperlyConfigured):
        staff_ops_hosts({"KODERA_STAFF_OPS_HOSTS": "admin.kodera.io"}, loopback_issuers=False)
    with pytest.raises(ImproperlyConfigured):
        staff_ops_hosts({"KODERA_STAFF_OPS_HOSTS": "admin:8443"}, loopback_issuers=False)


# ---------------------------------------- Fail-Closed 503, 404 Wall & CORS Plane ----


@pytest.mark.parametrize(
    "missing_key",
    [
        "KODERA_STAFF_OIDC_ISSUER",
        "KODERA_STAFF_OIDC_JWKS_URL",
        "KODERA_STAFF_OPS_HOSTS",
    ],
)
def test_staff_plane_fails_closed_503_json_when_any_setting_is_unconfigured(
    missing_key: str,
) -> None:
    partial = dict(STAFF_PLANE_SETTINGS)
    partial[missing_key] = () if missing_key == "KODERA_STAFF_OPS_HOSTS" else None
    with override_settings(**partial):
        client = Client()
        resp = client.get("/staff/v1/read/overview", HTTP_HOST=ADMIN_HOST)
    assert resp.status_code == 503
    assert resp["Content-Type"] == "application/json"
    body = resp.json()
    assert body["code"] == "staff_plane_unconfigured"
    assert body["type"] == "https://kodera.io/problems/c1-backend-unconfigured"


@pytest.mark.parametrize(
    ("path", "expected_code"),
    [
        ("/staff/unknown", "not_found"),
        ("/staff/v1/unknown", "not_found"),
        ("/staff/v1/read/does-not-exist", "not_found"),
        ("/staff/v1/ops/does-not-exist", "not_found"),
        ("/staff/v1/read/messages", "c2_c3_surface_absent"),
        ("/staff/v1/read/documents", "c2_c3_surface_absent"),
        ("/staff/v1/ops/workspaces/export", "c2_c3_surface_absent"),
        ("/staff/v1/triage/e2ee/blobs", "c2_c3_surface_absent"),
    ],
)
def test_unlisted_and_c2_c3_staff_paths_always_return_404_json_never_html(
    path: str,
    expected_code: str,
) -> None:
    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()
        resp = client.get(
            path,
            HTTP_HOST=ADMIN_HOST,
            HTTP_ORIGIN="https://admin.kodera.io",
        )
    assert resp.status_code == 404
    assert resp["Content-Type"] == "application/json"
    assert resp["Access-Control-Allow-Origin"] == "https://admin.kodera.io"
    payload = resp.json()
    assert payload["code"] == expected_code
    assert payload["status"] == 404


def test_staff_cors_preflight_admits_listed_origin_and_refuses_unlisted_origin() -> None:
    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()
        ok = client.options(
            "/staff/v1/read/overview",
            HTTP_HOST=ADMIN_HOST,
            HTTP_ORIGIN="https://ops-admin.kodera.io",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        )
        assert ok.status_code == 204
        assert ok["Access-Control-Allow-Origin"] == "https://ops-admin.kodera.io"

        denied = client.options(
            "/staff/v1/read/overview",
            HTTP_HOST=ADMIN_HOST,
            HTTP_ORIGIN="https://evil.example",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        )
        assert denied.status_code == 403
        assert denied["Content-Type"] == "application/json"
        assert denied.json()["code"] == "cors_origin_forbidden"


# ------------------------------------ JWT Verification, Step-Up & Split-Plane ----


@pytest.mark.django_db
def test_jwt_claim_rejections_return_401_json() -> None:
    staff_ident = _seed_staff_member(roles=("staff_owner",))
    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()

        # Missing Authorization header
        r_missing = client.get("/staff/v1/read/overview", HTTP_HOST=ADMIN_HOST)
        assert r_missing.status_code == 401
        assert r_missing.json()["code"] == "missing_bearer_token"
        assert "Bearer" in r_missing["WWW-Authenticate"]

        # Wrong issuer
        t_iss = _mint_staff_jwt(
            staff_ident.subject,
            issuer="https://identity.customer.test/realms/acme",
            amr=["otp"],
        )
        r_iss = client.get("/staff/v1/read/overview", **_auth_headers(t_iss))
        assert r_iss.status_code == 401
        assert r_iss.json()["code"] == "invalid_token"

        # Wrong azp (console token instead of kodera-admin)
        t_azp = _mint_staff_jwt(staff_ident.subject, azp="kodera-console", amr=["otp"])
        r_azp = client.get("/staff/v1/read/overview", **_auth_headers(t_azp))
        assert r_azp.status_code == 401
        assert r_azp.json()["code"] == "invalid_azp"

        # Missing one of the two required audiences
        for bad_aud in (["kodera-admin-api"], ["kodera-server"], "kodera-admin-api"):
            t_aud = _mint_staff_jwt(staff_ident.subject, aud=bad_aud, amr=["otp"])
            r_aud = client.get("/staff/v1/read/overview", **_auth_headers(t_aud))
            assert r_aud.status_code == 401
            assert r_aud.json()["code"] == "invalid_audience"

        # Unknown kid
        t_kid = _mint_staff_jwt(staff_ident.subject, kid="unknown-kid", amr=["otp"])
        r_kid = client.get("/staff/v1/read/overview", **_auth_headers(t_kid))
        assert r_kid.status_code == 401
        assert r_kid.json()["code"] == "invalid_token"

        # Invalid RSA signature
        t_sig = _mint_staff_jwt(
            staff_ident.subject, private_key=_WRONG_RSA_PRIVATE_KEY, amr=["otp"]
        )
        r_sig = client.get("/staff/v1/read/overview", **_auth_headers(t_sig))
        assert r_sig.status_code == 401
        assert r_sig.json()["code"] == "invalid_token"

        # Expired token
        t_exp = _mint_staff_jwt(staff_ident.subject, exp_offset=-5, amr=["otp"])
        r_exp = client.get("/staff/v1/read/overview", **_auth_headers(t_exp))
        assert r_exp.status_code == 401
        assert r_exp.json()["code"] == "token_expired"

        # Future nbf
        t_nbf = _mint_staff_jwt(staff_ident.subject, nbf_offset=120, amr=["otp"])
        r_nbf = client.get("/staff/v1/read/overview", **_auth_headers(t_nbf))
        assert r_nbf.status_code == 401
        assert r_nbf.json()["code"] == "invalid_token"


@pytest.mark.django_db
def test_mfa_hwk_320s_step_up_and_ops_host_split_plane_enforcement() -> None:
    assert OPS_STEP_UP_MAX_AGE_SEC == 320
    operator = _seed_staff_member(roles=("staff_operator",))
    now = int(time.time())

    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()

        # 1. /read/* refuses password-only token without otp or hwk
        t_pwd = _mint_staff_jwt(operator.subject, amr=["pwd"], auth_time=now)
        r_pwd = client.get("/staff/v1/read/overview", **_auth_headers(t_pwd))
        assert r_pwd.status_code == 403
        assert r_pwd.json()["code"] == "mfa_required"

        # 2. /read/* admits otp token
        t_otp = _mint_staff_jwt(operator.subject, amr=["pwd", "otp"], auth_time=now)
        r_otp_read = client.get("/staff/v1/read/overview", **_auth_headers(t_otp))
        assert r_otp_read.status_code == 200

        # 3. /ops/* on public admin.kodera.io Host is refused with 403 ops_ingress_required
        t_hwk_fresh = _mint_staff_jwt(operator.subject, amr=["hwk"], auth_time=now)
        r_bad_host = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_hwk_fresh, host=ADMIN_HOST),
        )
        assert r_bad_host.status_code == 403
        assert r_bad_host.json()["code"] == "ops_ingress_required"

        # 4. /ops/* on ops-admin.kodera.io refuses OTP-only token with 403 hwk_required
        r_otp_ops = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_otp, host=OPS_HOST),
        )
        assert r_otp_ops.status_code == 403
        assert r_otp_ops.json()["code"] == "hwk_required"

        # 5. /ops/* refuses missing auth_time, future auth_time, and stale auth_time (321s > 320s)
        for bad_auth_time in (None, now + 60, now - 321):
            t_stale = _mint_staff_jwt(
                operator.subject, amr=["hwk"], auth_time=bad_auth_time
            )
            r_stale = client.post(
                "/staff/v1/ops/audit-chain/verify",
                data="{}",
                content_type="application/json",
                **_auth_headers(t_stale, host=OPS_HOST),
            )
            assert r_stale.status_code == 403
            assert r_stale.json()["code"] == "step_up_expired"

        # 6. /ops/* admits hwk token at exact boundary (now - 315s <= 320s) on ops-admin.kodera.io
        t_boundary = _mint_staff_jwt(operator.subject, amr=["hwk"], auth_time=now - 315)
        r_ok = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_boundary, host=OPS_HOST),
        )
        assert r_ok.status_code == 200
        assert r_ok.json()["verified"] is True


# ------------------------------------ PostgreSQL RBAC & Engineering Redaction ----


@pytest.mark.django_db
def test_db_backed_rbac_ignores_jwt_role_claims_and_enforces_c1_redaction() -> None:
    org, tenant = _seed_customer_org_and_tenant(
        org_name="Ministry Confidential Org Name",
        tenant_name="Ministry Confidential Tenant Name",
    )
    StaffFeedbackItem.objects.create(
        organisation_id=org.id,
        organisation_slug=org.slug,
        kind="bug",
        source="console",
        severity="p1",
        status="new",
        surface="visio",
        summary="Contact alice.martin@ministry.fr on reconnect drop",
        details="Header leaked Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.secret.sig in console",
        reporter_pseudonym="rep-01",
    )

    no_role_ident = _seed_staff_member(roles=())
    growth_ident = _seed_staff_member(roles=("staff_growth",))
    backend_ident = _seed_staff_member(roles=("staff_backend",))
    support_ident = _seed_staff_member(roles=("staff_support",))

    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()

        # Forged JWT claiming staff_owner while PostgreSQL holds zero roles -> 403
        forged_jwt = _mint_staff_jwt(
            no_role_ident.subject,
            amr=["hwk"],
            auth_time=int(time.time()),
            extra_claims={"realm_access": {"roles": ["staff_owner", "staff_operator"]}},
        )
        r_forged = client.get("/staff/v1/read/overview", **_auth_headers(forged_jwt))
        assert r_forged.status_code == 403
        assert r_forged.json()["code"] == "insufficient_staff_role"

        # staff_growth can read overview & pipeline, but is refused /read/organisations & /read/security
        t_growth = _mint_staff_jwt(growth_ident.subject, amr=["otp"])
        r_ov = client.get("/staff/v1/read/overview", **_auth_headers(t_growth))
        assert r_ov.status_code == 200
        assert r_ov.json()["caller"]["roles"] == ["staff_growth"]

        r_growth_orgs = client.get("/staff/v1/read/organisations", **_auth_headers(t_growth))
        assert r_growth_orgs.status_code == 403
        assert r_growth_orgs.json()["code"] == "insufficient_staff_role"

        # staff_backend gets c1_slugs_only on /read/organisations (names replaced by slugs)
        t_backend = _mint_staff_jwt(backend_ident.subject, amr=["otp"])
        r_be_orgs = client.get("/staff/v1/read/organisations", **_auth_headers(t_backend))
        assert r_be_orgs.status_code == 200
        be_orgs_body = r_be_orgs.json()
        assert be_orgs_body["redaction_mode"] == "c1_slugs_only"
        matched_org = next(o for o in be_orgs_body["organisations"] if o["slug"] == org.slug)
        matched_ten = next(t for t in be_orgs_body["tenants"] if t["slug"] == tenant.slug)
        assert matched_org["name"] == org.slug
        assert matched_ten["name"] == tenant.slug

        # staff_support gets c1_metadata on /read/organisations
        t_support = _mint_staff_jwt(support_ident.subject, amr=["otp"])
        r_sup_orgs = client.get("/staff/v1/read/organisations", **_auth_headers(t_support))
        assert r_sup_orgs.status_code == 200
        assert r_sup_orgs.json()["redaction_mode"] == "c1_metadata"

        # staff_backend gets scrubbed PII/Bearer tokens on /read/feedback & /read/engineering
        r_be_fb = client.get("/staff/v1/read/feedback", **_auth_headers(t_backend))
        assert r_be_fb.status_code == 200
        be_fb_body = r_be_fb.json()
        assert be_fb_body["redacted_for_engineering"] is True
        assert "alice.martin@ministry.fr" not in json.dumps(be_fb_body)
        assert "eyJhbGciOiJSUzI1NiJ9" not in json.dumps(be_fb_body)

        r_eng = client.get("/staff/v1/read/engineering", **_auth_headers(t_support))
        assert r_eng.status_code == 200
        assert r_eng.json()["redacted_for_engineering"] is True
        assert "alice.martin@ministry.fr" not in json.dumps(r_eng.json())


# ----------------------- All 21 M1-M8 Endpoints & SHA-256 Audit Chain Tamper ----


@pytest.mark.django_db
def test_triage_finops_roles_issuer_snapshots_and_hash_chain_tamper_detection() -> None:
    assert GROSS_MARGIN_FLOOR_BPS == 4400

    org, _ = _seed_customer_org_and_tenant()
    owner = _seed_staff_member(roles=("staff_owner",), display_name="Owner Seat")
    operator_1 = _seed_staff_member(roles=("staff_operator",), display_name="Operator One")
    operator_2 = _seed_staff_member(roles=("staff_operator",), display_name="Operator Two")
    candidate = _seed_staff_member(roles=(), display_name="email-looking@staff.example")

    fb = StaffFeedbackItem.objects.create(
        organisation_id=org.id,
        organisation_slug=org.slug,
        kind="bug",
        source="console",
        severity="p2",
        status="new",
        surface="console",
        summary="OIDC callback failure reported by bob@customer.fr",
        details="Token Bearer secret-token-value-123456 failed validation",
        reporter_pseudonym="usr-77",
    )

    now = int(time.time())
    t_owner_hwk = _mint_staff_jwt(owner.subject, amr=["hwk"], auth_time=now)
    t_op1_hwk = _mint_staff_jwt(operator_1.subject, amr=["hwk"], auth_time=now)

    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()

        # 1. M3 Pipeline: upsert deal + waitlist cohort idempotency & conflict + read pipeline
        r_deal = client.post(
            "/staff/v1/triage/deals",
            data=json.dumps(
                {
                    "prospect_slug": " mairie-lyon ",
                    "stage": "qualified",
                    "pack_code": "suite- territoriale" if False else "suite-territoriale",
                    "capacity_tier_code": "L",
                    "estimated_mrr_cents": 240_000,
                    "owner_seat": "zxxma",
                    "next_step_code": "demo-scheduled",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_deal.status_code == 200
        assert r_deal.json()["prospect_slug"] == "mairie-lyon"

        r_cohort_1 = client.post(
            "/staff/v1/triage/waitlist/open-cohort",
            data=json.dumps({"cohort_code": "wave-2026-q4", "limit_count": 25}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_cohort_1.status_code == 200
        assert r_cohort_1.json()["idempotent_replay"] is False

        r_cohort_replay = client.post(
            "/staff/v1/triage/waitlist/open-cohort",
            data=json.dumps({"cohort_code": "wave-2026-q4", "limit_count": 25}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_cohort_replay.status_code == 200
        assert r_cohort_replay.json()["idempotent_replay"] is True

        r_cohort_conflict = client.post(
            "/staff/v1/triage/waitlist/open-cohort",
            data=json.dumps({"cohort_code": "wave-2026-q4", "limit_count": 50}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_cohort_conflict.status_code == 409

        r_pipe = client.get("/staff/v1/read/pipeline", **_auth_headers(t_owner_hwk))
        assert r_pipe.status_code == 200
        assert len(r_pipe.json()["deals"]) == 1
        assert r_pipe.json()["waitlist_summary"]["total_confirmed"] == 25

        # 2. M4/M5 Feedback triage + scrubbed GitHub draft
        r_triage = client.post(
            f"/staff/v1/triage/feedback/{fb.id}",
            data=json.dumps(
                {
                    "status": "triaged",
                    "severity": "p1",
                    "assigned_seat": "miguel",
                    "vote_delta": 3,
                }
            ),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_triage.status_code == 200
        assert r_triage.json()["vote_count"] == 3
        assert r_triage.json()["assigned_seat"] == "miguel"

        r_draft = client.post(
            f"/staff/v1/triage/feedback/{fb.id}/github-draft",
            data=json.dumps(
                {
                    "target_repository": "kodera-core",
                    "roadmap_milestone": "v1.2-hardening",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_draft.status_code == 200
        draft_body = r_draft.json()
        assert draft_body["status"] == "planned"
        assert "bob@customer.fr" not in draft_body["body_markdown"]
        assert "secret-token-value-123456" not in draft_body["body_markdown"]
        assert draft_body["prefilled_github_url"].startswith(
            "https://github.com/kodera-hq/kodera-core/issues/new?"
        )

        # 3. M8 SAR create (rejects raw email, accepts pseudonym) & complete
        r_sar_bad = client.post(
            "/staff/v1/triage/sar",
            data=json.dumps(
                {
                    "request_kind": "access",
                    "subject_pseudonym": "citizen@personal.fr",
                    "ticket_ref": "SAR-2026-001",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_sar_bad.status_code == 400

        r_sar = client.post(
            "/staff/v1/triage/sar",
            data=json.dumps(
                {
                    "request_kind": "erasure",
                    "subject_pseudonym": "subj_sha256_99ab12cd",
                    "organisation_slug": org.slug,
                    "ticket_ref": "SAR-2026-0042",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_sar.status_code == 201
        sar_id = r_sar.json()["id"]

        r_sar_done = client.post(
            f"/staff/v1/triage/sar/{sar_id}/complete",
            data=json.dumps({"status": "completed", "evidence_ref": "SAR-BUNDLE-0042"}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_sar_done.status_code == 200
        assert r_sar_done.json()["status"] == "completed"

        r_sar_repeat = client.post(
            f"/staff/v1/triage/sar/{sar_id}/complete",
            data=json.dumps({"status": "completed", "evidence_ref": "SAR-BUNDLE-0042"}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk),
        )
        assert r_sar_repeat.status_code == 409

        # 4. M6 FinOps snapshot recording & 44.00% (4400 bps) gross margin floor alert
        r_fin_healthy = client.post(
            "/staff/v1/ops/finops/snapshots",
            data=json.dumps(
                {
                    "period_month": "2026-10",
                    "environment_code": "prod-fr-par",
                    "mrr_cents": 100_000,
                    "total_cost_cents": 56_000,  # 44.00% == 4400 bps exact floor -> no alert
                    "active_organisations": 4,
                    "active_tenants": 6,
                    "source_ref": "SCW-INV-2026-10",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_fin_healthy.status_code == 201
        assert r_fin_healthy.json()["gross_margin_bps"] == 4400
        assert r_fin_healthy.json()["gross_margin_alert"] is False

        r_fin_alert = client.post(
            "/staff/v1/ops/finops/snapshots",
            data=json.dumps(
                {
                    "period_month": "2026-11",
                    "environment_code": "prod-fr-par",
                    "mrr_cents": 100_000,
                    "infra_cost_cents": 50_000,
                    "backup_cost_cents": 4_000,
                    "mail_cost_cents": 2_100,  # 43.90% == 4390 bps < 4400 bps -> alert!
                    "source_ref": "SCW-INV-2026-11",
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_fin_alert.status_code == 201
        assert r_fin_alert.json()["gross_margin_bps"] == 4390
        assert r_fin_alert.json()["gross_margin_alert"] is True

        r_read_finops = client.get(
            "/staff/v1/read/finops?period_month=2026-11",
            **_auth_headers(t_owner_hwk),
        )
        assert r_read_finops.status_code == 200
        assert r_read_finops.json()["finops"]["gross_margin_alert"] is True

        # 5. M8 Staff role grant & revoke (two-person rule + owner>=1 & operator>=2 floors)
        r_self_grant = client.post(
            "/staff/v1/ops/staff-roles/grant",
            data=json.dumps({"identity_id": str(owner.id), "role": "staff_security"}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk, host=OPS_HOST),
        )
        assert r_self_grant.status_code == 403
        assert r_self_grant.json()["code"] == "self_role_mutation_forbidden"

        # Operator floor: revoking operator_2 while only 2 operators exist -> 409
        r_op_floor = client.post(
            "/staff/v1/ops/staff-roles/revoke",
            data=json.dumps({"identity_id": str(operator_2.id), "role": "staff_operator"}),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_op_floor.status_code == 409
        assert r_op_floor.json()["code"] == "role_floor_violation"

        # Owner floor: revoking sole owner -> 409
        r_owner_floor = client.post(
            "/staff/v1/ops/staff-roles/revoke",
            data=json.dumps({"identity_id": str(owner.id), "role": "staff_owner"}),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_owner_floor.status_code == 409
        assert r_owner_floor.json()["code"] == "role_floor_violation"

        # Grant staff_security to candidate, then revoke it
        r_grant = client.post(
            "/staff/v1/ops/staff-roles/grant",
            data=json.dumps({"identity_id": str(candidate.id), "role": "staff_security"}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk, host=OPS_HOST),
        )
        assert r_grant.status_code == 200
        assert r_grant.json()["created"] is True

        r_revoke = client.post(
            "/staff/v1/ops/staff-roles/revoke",
            data=json.dumps({"identity_id": str(candidate.id), "role": "staff_security"}),
            content_type="application/json",
            **_auth_headers(t_owner_hwk, host=OPS_HOST),
        )
        assert r_revoke.status_code == 200
        assert r_revoke.json()["status"] == "revoked"

        # 6. M8 Issuer snapshot registration (rejects private key `d` & `oct`, admits public RSA JWK)
        bad_private_jwk = dict(_RSA_PUBLIC_JWK, d="secret-private-exponent")
        r_jwk_priv = client.post(
            "/staff/v1/ops/issuer-snapshots",
            data=json.dumps(
                {
                    "organisation_slug": org.slug,
                    "generation": "gen-2026-11",
                    "expires_at_epoch": now + 86400,
                    "public_jwks": {"keys": [bad_private_jwk]},
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_jwk_priv.status_code == 400
        assert r_jwk_priv.json()["code"] == "private_jwk_rejected"

        r_jwk_ok = client.post(
            "/staff/v1/ops/issuer-snapshots",
            data=json.dumps(
                {
                    "organisation_slug": org.slug,
                    "generation": "gen-2026-11",
                    "expires_at_epoch": now + 86400,
                    "public_jwks": {"keys": [_RSA_PUBLIC_JWK]},
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_jwk_ok.status_code == 201
        assert r_jwk_ok.json()["issuer"] == org.issuer
        assert r_jwk_ok.json()["keys_count"] == 1

        # 7. M8 Security read + Audit Chain Verification & Tamper Detection
        r_sec = client.get("/staff/v1/read/security", **_auth_headers(t_owner_hwk))
        assert r_sec.status_code == 200
        sec_body = r_sec.json()
        assert sec_body["fleet_audit_chain"]["verified"] is True
        assert sec_body["fleet_audit_chain"]["checked_count"] >= 7
        # Candidate display_name contained '@', so display_label must fall back to pseudonymous staff:<sub[:12]>
        cand_row = next(
            r for r in sec_body["staff_roster"] if r["identity_id"] == str(candidate.id)
        )
        assert "@" not in cand_row["display_label"]

        r_verify_fleet = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_verify_fleet.status_code == 200
        assert r_verify_fleet.json()["verified"] is True

        r_verify_org = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data=json.dumps({"organisation_slug": org.slug}),
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_verify_org.status_code == 200
        assert r_verify_org.json()["verified"] is True
        assert r_verify_org.json()["checked_count"] >= 3

        # Tamper directly with sequence_no=2 in fleet scope and prove verification catches it!
        tampered = StaffAuditEntry.objects.get(scope_key="fleet", sequence_no=2)
        StaffAuditEntry.objects.filter(pk=tampered.pk).update(action="staff.tampered.action")

        r_tampered = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_op1_hwk, host=OPS_HOST),
        )
        assert r_tampered.status_code == 200
        tamper_report = r_tampered.json()
        assert tamper_report["verified"] is False
        assert tamper_report["broken_at_sequence_no"] == 2
        assert tamper_report["reason"] == "entry_hash_mismatch"


@pytest.mark.django_db(transaction=True)
def test_sre_read_and_reconcile_job_and_outbox_delivery_against_real_postgres_triggers() -> None:
    org, tenant = _seed_customer_org_and_tenant()
    operator = _seed_staff_member(roles=("staff_operator",))

    # Create a real job via apps.jobs.services and hold it in needs_reconciliation
    enqueued = job_services.enqueue_job(
        request=job_services.JobRequest(
            organisation_id=org.id,
            tenant_id=tenant.id,
            kind="rotate_secret",
            idempotency_key=f"staff-reconcile-{uuid.uuid4().hex}",
            desired_spec_hash=hashlib.sha256(b"spec-1").hexdigest(),
            actor_type="staff",
            actor_id=operator.id,
        ),
        apply_desired_state=lambda: None,
    )
    claim = job_services.claim_job(runner_id="runner-staff-test", job_id=enqueued.job_id)
    assert isinstance(claim, job_services.Claim)
    assert job_services.record_step(claim=claim, seq=1, status="running") is True
    dispatch_id = job_services.record_dispatch(
        claim=claim, seq=1, operation_ref="scw-op-reconcile-1"
    )
    assert dispatch_id is not None
    assert job_services.hold_for_reconciliation(claim=claim, dispatch_id=dispatch_id) is True
    job_services.release_live_locks(claim=claim)
    assert Job.objects.get(pk=enqueued.job_id).status == "needs_reconciliation"

    # Create an OutboxDelivery in needs_reconciliation
    now_dt = datetime.now(UTC)
    delivery = OutboxDelivery.objects.create(
        organisation=org,
        category="message",
        changes_realm=False,
        status="needs_reconciliation",
        operation_ref="smtp-ambiguous-1",
        started_at=now_dt - timedelta(seconds=30),
        created_at=now_dt,
        updated_at=now_dt,
    )

    now_epoch = int(time.time())
    t_op = _mint_staff_jwt(operator.subject, amr=["hwk"], auth_time=now_epoch)
    evidence_iso = datetime.now(UTC).isoformat()
    evidence_block = {
        "provider": "scaleway",
        "resource_id": "fr-par-1/instance-42",
        "request_id": "req-scw-999",
        "observed_at": evidence_iso,
    }

    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()

        # M7 GET /staff/v1/read/sre lists both the reconciling job and reconciling outbox delivery
        r_sre = client.get("/staff/v1/read/sre", **_auth_headers(t_op))
        assert r_sre.status_code == 200
        sre_body = r_sre.json()
        assert any(j["id"] == str(enqueued.job_id) for j in sre_body["jobs"]["reconciling"])
        assert any(
            d["id"] == str(delivery.id) for d in sre_body["outbox"]["reconciling_deliveries"]
        )

        # Partial outcome + resume MUST be rejected with 409 partial_resume
        r_partial_resume = client.post(
            f"/staff/v1/ops/reconcile/jobs/{enqueued.job_id}",
            data=json.dumps(
                {
                    "exit": "resume",
                    "operation_outcome": "partial",
                    "compute_terminated": evidence_block,
                    "target_read": evidence_block,
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op, host=OPS_HOST),
        )
        assert r_partial_resume.status_code == 409
        assert r_partial_resume.json()["code"] == "partial_resume"

        # Valid job reconciliation (resume + completed -> queued)
        r_job_ok = client.post(
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
            **_auth_headers(t_op, host=OPS_HOST),
        )
        assert r_job_ok.status_code == 200
        assert r_job_ok.json()["status"] == "queued"
        assert Job.objects.get(pk=enqueued.job_id).status == "queued"

        # Re-reconciling a job no longer in needs_reconciliation -> 409 not_in_reconciliation
        r_job_again = client.post(
            f"/staff/v1/ops/reconcile/jobs/{enqueued.job_id}",
            data=json.dumps(
                {
                    "exit": "fail",
                    "operation_outcome": "no_effect",
                    "compute_terminated": evidence_block,
                    "target_read": evidence_block,
                }
            ),
            content_type="application/json",
            **_auth_headers(t_op, host=OPS_HOST),
        )
        assert r_job_again.status_code == 409
        assert r_job_again.json()["code"] == "not_in_reconciliation"

        # Valid outbox delivery reconciliation (fail + no_effect -> failed)
        r_deliv_ok = client.post(
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
            **_auth_headers(t_op, host=OPS_HOST),
        )
        assert r_deliv_ok.status_code == 200
        assert r_deliv_ok.json()["status"] == "failed"
        assert OutboxDelivery.objects.get(pk=delivery.id).status == "failed"

        # Verify hash chain after DB-trigger reconciliations
        r_chain = client.post(
            "/staff/v1/ops/audit-chain/verify",
            data="{}",
            content_type="application/json",
            **_auth_headers(t_op, host=OPS_HOST),
        )
        assert r_chain.status_code == 200
        assert r_chain.json()["verified"] is True

    # Clean up transactional test rows so transaction=True leaves zero cross-test state
    with connection.cursor() as cursor:
        cursor.execute("TRUNCATE staff_api_audit_entry, staff_api_role_grant CASCADE")


# --------------------------- Strict C1 AST / SQL Boundary & OpenAPI Parity ----


FORBIDDEN_C2_C3_MODULE_PREFIXES = (
    "apps.workspaces",
    "apps.docs",
    "apps.media",
    "apps.notifications",
    "apps.extensions",
    "apps.support",
)

FORBIDDEN_C2_C3_SQL_TABLES_RE = re.compile(
    r"\b(?:workspaces_|docs_|media_|notifications_|extensions_)[a-z0-9_]+\b"
)


def test_staff_api_enforces_strict_c1_zero_trust_ast_and_sql_boundary() -> None:
    staff_api_dir = SERVER_ROOT / "core" / "staff_api"
    py_files = sorted(p for p in staff_api_dir.rglob("*.py"))
    assert len(py_files) >= 12

    for py_file in py_files:
        source = py_file.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith(FORBIDDEN_C2_C3_MODULE_PREFIXES), (
                        f"{py_file.name} imports forbidden C2/C3 module {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom) and node.module:
                assert not node.module.startswith(FORBIDDEN_C2_C3_MODULE_PREFIXES), (
                    f"{py_file.name} imports from forbidden C2/C3 module {node.module}"
                )
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                match = FORBIDDEN_C2_C3_SQL_TABLES_RE.search(node.value)
                assert match is None, (
                    f"{py_file.name} references forbidden C2/C3 table {match.group(0)!r}"
                )


def test_staff_openapi_contract_roles_match_views_allowed_roles_verbatim() -> None:
    contract_path = SERVER_ROOT / "contracts" / "staff-api.openapi.yaml"
    spec = yaml.safe_load(contract_path.read_text(encoding="utf-8"))

    contract_roles_by_op: dict[str, tuple[str, ...]] = {}
    for _path, path_item in spec["paths"].items():
        for method, operation in path_item.items():
            if method in {"get", "post", "put", "patch", "delete"}:
                op_id = operation["operationId"]
                roles = tuple(operation["x-kodera-authz"]["roles"])
                contract_roles_by_op[op_id] = roles

    assert len(contract_roles_by_op) == 21

    # Extract allowed_roles passed to authenticate_staff_request inside each view in core/staff_api/views.py
    views_source = (SERVER_ROOT / "core" / "staff_api" / "views.py").read_text(encoding="utf-8")
    views_tree = ast.parse(views_source)
    view_roles_by_op: dict[str, tuple[str, ...]] = {}

    for node in views_tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        view_fn = getattr(staff_views, node.name, None)
        declared = getattr(view_fn, DECLARED_OPS_ATTR, ())
        if not declared:
            continue
        op_id = declared[0].operation_id
        found_roles: tuple[str, ...] | None = None
        for child in ast.walk(node):
            if (
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Name)
                and child.func.id == "authenticate_staff_request"
            ):
                for kw in child.keywords:
                    if kw.arg == "allowed_roles" and isinstance(kw.value, ast.Name):
                        resolved = getattr(staff_views, kw.value.id)
                        found_roles = tuple(resolved)
        assert found_roles is not None, f"{node.name} missing allowed_roles keyword"
        view_roles_by_op[op_id] = found_roles

    assert view_roles_by_op == contract_roles_by_op

    # Also verify all 21 staff routes resolve under config.customer_urls
    resolver = get_resolver("config.customer_urls")
    staff_patterns: list[str] = []

    def _walk(patterns: list[Any], prefix: str = "") -> None:
        for entry in patterns:
            if isinstance(entry, URLResolver):
                _walk(entry.url_patterns, prefix + str(entry.pattern))
            elif isinstance(entry, URLPattern):
                full = prefix + str(entry.pattern)
                if full.startswith("staff/v1/"):
                    staff_patterns.append(full)

    _walk(resolver.url_patterns)
    assert len(staff_patterns) == 21


# ------------------------------------ P2 Security Hardening Regression Suite ----


@pytest.mark.parametrize(
    "bad_request_id",
    [
        "",
        "tiny123",
        "z" * 65,
        "z" * 256,
        "bad\r\ncrlf-1234",
        "bad\x00null-1234",
        "bad/slash/id",
    ],
)
def test_staff_api_replaces_oversized_or_control_char_request_id_with_uuid7(
    bad_request_id: str,
) -> None:
    factory = RequestFactory()

    req_corr = factory.get("/staff/v1/read/overview", HTTP_X_REQUEST_ID=bad_request_id)
    corr = request_correlation_id(req_corr)
    assert corr != bad_request_id
    assert REQUEST_ID_RE.fullmatch(corr) is not None
    assert uuid.UUID(corr).version == 7

    req_prob = factory.get("/staff/v1/read/overview", HTTP_X_REQUEST_ID=bad_request_id)
    prob = staff_problem_response(req_prob, status=403, code="forbidden", title="Forbidden")
    prob_rid = prob["X-Request-Id"]
    assert uuid.UUID(prob_rid).version == 7
    assert json.loads(prob.content)["request_id"] == prob_rid

    req_ok = factory.get("/staff/v1/read/overview", HTTP_X_REQUEST_ID=bad_request_id)
    ok_resp = staff_json_response(req_ok, {"ok": True})
    assert uuid.UUID(ok_resp["X-Request-Id"]).version == 7

    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()
        r_unauth = client.get(
            "/staff/v1/read/overview",
            HTTP_HOST=ADMIN_HOST,
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        assert r_unauth.status_code == 401
        rid_unauth = r_unauth["X-Request-Id"]
        assert uuid.UUID(rid_unauth).version == 7
        assert r_unauth.json()["request_id"] == rid_unauth

        r_not_found = client.get(
            "/staff/v1/unknown",
            HTTP_HOST=ADMIN_HOST,
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        assert r_not_found.status_code == 404
        rid_nf = r_not_found["X-Request-Id"]
        assert uuid.UUID(rid_nf).version == 7
        assert r_not_found.json()["request_id"] == rid_nf


@pytest.mark.django_db
def test_staff_mutation_audit_entry_replaces_oversized_request_id_with_uuid7() -> None:
    owner_ident = _seed_staff_member(roles=("staff_owner",))
    token = _mint_staff_jwt(
        owner_ident.subject,
        amr=["hwk"],
        auth_time=int(time.time()),
    )
    with override_settings(**STAFF_PLANE_SETTINGS):
        client = Client()
        resp = client.post(
            "/staff/v1/triage/waitlist/open-cohort",
            data=json.dumps({"cohort_code": "wave-reqid-guard", "limit_count": 10}),
            content_type="application/json",
            **_auth_headers(token, request_id="r" * 200),
        )
    assert resp.status_code == 200
    header_rid = resp["X-Request-Id"]
    assert uuid.UUID(header_rid).version == 7
    audit_row = StaffAuditEntry.objects.order_by("-sequence_no").first()
    assert audit_row is not None
    assert audit_row.request_id == header_rid
    assert uuid.UUID(audit_row.request_id).version == 7


@pytest.mark.parametrize("redirect_status", [301, 302, 307, 308])
def test_staff_jwks_fetch_refuses_http_redirects_with_503(redirect_status: int) -> None:
    clear_jwks_cache()
    redirect_target_hits: list[str] = []
    bound_port: list[int] = []

    class _RedirectJwksHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/jwks-redirect":
                self.send_response(redirect_status)
                self.send_header(
                    "Location", f"http://127.0.0.1:{bound_port[0]}/redirect-destination"
                )
                self.end_headers()
                return
            redirect_target_hits.append(self.path)
            payload = json.dumps({"keys": [_RSA_PUBLIC_JWK]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    server = HTTPServer(("127.0.0.1", 0), _RedirectJwksHandler)
    port = server.server_port
    bound_port.append(port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        redirect_jwks_url = f"http://127.0.0.1:{port}/jwks-redirect"
        redirect_settings = {
            **STAFF_PLANE_SETTINGS,
            "KODERA_LOOPBACK_ISSUERS": True,
            "KODERA_STAFF_OIDC_JWKS_URL": redirect_jwks_url,
        }
        token = _mint_staff_jwt("staff-sub-redirect", amr=["otp"])
        with override_settings(**redirect_settings):
            client = Client()
            resp = client.get(
                "/staff/v1/read/overview",
                **_auth_headers(token, host=ADMIN_HOST),
            )
        assert resp.status_code == 503
        assert resp["Content-Type"] == "application/json"
        body = resp.json()
        assert body["code"] == "staff_jwks_unavailable"
        assert body["type"] == "https://kodera.io/problems/c1-backend-jwks-unavailable"
        assert redirect_target_hits == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
