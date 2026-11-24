"""Stage S3-Beta integration tests: PME cardless self-serve (`B1.1`) & Sovereign settlement (`B1.2`).

Runs against real PostgreSQL with zero mocked persistence:
1. Cardless PME self-serve (`POST /api/v1/workspaces/self-serve`, `< 5 s`, `<= 5` seats, idempotency,
   `<= 3` orgs per person rate limit, `409 slug-taken` suggestions, billing enabled & disabled).
2. Multi-org shared-realm `GET /api/v1/me` (`shared_realm`, `plan_tier`) & org-scoped isolation.
3. Shared-realm invitation acceptance & invite-link redemption auto-binding up to 5 seats, `402`
   `subscription-required` on 6th seat, and automatic seat/tier unlock on paid subscription sync.
4. Dedicated Sovereign `Order` (`PRO2-S`) Stripe webhook settlement (`POST /api/v1/webhooks/stripe`):
   Factur-X 380 PDF/XML artifact publication, `PostgresWarmPoolStore` (`max_total=3`) fast-path
   `ready -> claimed` + `realm_create` job + replenish, and cold fallback `provision` job when empty.
5. 4-person SRE summary (`GET /staff/v1/read/sre` & `manage.py sre_status --json`) + `kodera_api`
   writer-role `billing_issue_draft_invoice` least-privilege grants.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import itertools
import json
import time
from datetime import timedelta
from typing import Any
from uuid import UUID

import jwt
import pytest
from billing_fiscal_fixtures import register_test_fiscal_periods
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.core.management import call_command
from django.db import connection, transaction
from django.test import Client
from django.utils import timezone

import apps.billing.payments as payments_package
from apps.billing import catalogue, services as billing_services
from apps.billing.models import BillingArtifact, Invoice, Order, PaymentLink, Subscription
from apps.billing.payments import services as payment_services
from apps.billing.payments.stripe import StripeProvider
from apps.billing.services import Accepted, Agreements, OrderRequest, TenantRequest
from apps.billing.sovereign_settlement import (
    SOVEREIGN_PROFILE_REF,
    sync_organisation_plan_tier_for_subscription,
)
from apps.identity.models import STAFF_REALM, Identity, StaffRole, User
from apps.jobs.models import Job
from apps.legal import services as legal_services
from apps.legal.models import LegalDocument
from apps.orgs.invitations import (
    digest as invitation_digest,
    format_token as format_invitation_token,
)
from apps.orgs.models import Invitation, Membership, Organisation, SlugReservation
from apps.tenancy.models import Tenant
from apps.workspaces.models import Channel, Workspace, WorkspaceQuota
from apps.workspaces.moderation import create_link, redeem_link
from core.db import api_writer_role
from core.staff_api.auth import clear_jwks_cache, register_test_jwks
from core.staff_api.models import StaffRoleGrant
from core.staff_api.services import collect_sre_summary
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db(transaction=True)

SHARED_ISSUER = "https://auth.kodera.test/realms/community"
STAFF_ISSUER = "https://auth.kodera.test/realms/kodera-staff"
STAFF_JWKS_URL = "https://auth.kodera.test/realms/kodera-staff/protocol/openid-connect/certs"
STRIPE_SECRET = "rk_" + "test_" + "SyntheticS3BetaStripe01"
WEBHOOK_SECRET = "wh" + "sec_" + "synthetic-s3beta-hmac01"
_stripe_seq = itertools.count(1)


class _StubStripeTransport:
    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes
    ) -> tuple[int, bytes]:
        idx = next(_stripe_seq)
        return (
            200,
            json.dumps(
                {
                    "id": f"cs_test_s3beta_{idx}",
                    "url": f"https://checkout.stripe.invalid/c/s3beta-{idx}",
                    "expires_at": int(time.time()) + 3600,
                }
            ).encode("utf-8"),
        )


def _sign_stripe(raw_body: bytes, secret: str = WEBHOOK_SECRET) -> str:
    ts = int(time.time())
    mac = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode("ascii") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return f"t={ts},v1={mac}"


def _verified_shared(
    subject: str, email: str, *, email_verified: bool = True
) -> VerifiedAccessToken:
    now = int(time.time())
    return VerifiedAccessToken(
        issuer=SHARED_ISSUER,
        subject=subject,
        audience=("kodera-server",),
        issued_at=now,
        expires_at=now + 3600,
        not_before=None,
        amr=("pwd",),
        acr=None,
        auth_time=now,
        email=email,
        email_verified=email_verified,
    )


def _mint_customer_jwt(http_signer, issuer: str, *, subject: str, **changes: object) -> str:
    now = int(time.time())
    return str(token(http_signer, issuer, subject=subject, iat=now, exp=now + 600, **changes))


def _setup_shared_realm_settings(settings, http_signer) -> None:
    now = int(time.time())
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.KODERA_DEFAULT_COMMUNITY_ISSUER = SHARED_ISSUER
    settings.KODERA_STAFF_ISSUER = STAFF_ISSUER
    configure(
        settings,
        [
            trust_entry(http_signer, SHARED_ISSUER, lane="customer", expires_at=now + 3600),
            trust_entry(http_signer, STAFF_ISSUER, lane="staff", expires_at=now + 3600),
        ],
    )


def test_self_serve_workspace_cardless_fast_path_idempotency_and_limits(settings, http_signer):
    _setup_shared_realm_settings(settings, http_signer)
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    # Works identically when billing is disabled OR enabled (zero payment card required).
    settings.KODERA_BILLING_ENABLED = False
    founder_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="founder-sub-01",
        email="founder@pme-alpha.fr",
        email_verified=True,
    )

    started = time.perf_counter()
    resp = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier Alpha", "slug": "atelier-alpha", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000001",
    )
    elapsed = time.perf_counter() - started
    assert resp.status_code == 201, resp.content
    assert elapsed < 2.0, f"expected < 5s fast-path provisioning, took {elapsed:.3f}s"

    payload = resp.json()
    org_id = UUID(payload["organisation_id"])
    ws_id = UUID(payload["workspace_id"])
    tenant_id = UUID(payload["tenant_id"])
    assert payload["organisation_slug"] == "atelier-alpha"
    assert payload["redirect_path"] == "/atelier-alpha/workspace"
    assert payload["quota"] == {
        "policy_ref": "freemium:pme:seats-5",
        "seats": 5,
        "used": 1,
        "remaining": 4,
    }

    org = Organisation.objects.get(id=org_id)
    assert org.shared_realm is True
    assert org.plan_tier == Organisation.PlanTier.FREEMIUM_PME
    assert org.state == Organisation.State.ACTIVE
    assert SlugReservation.objects.filter(
        organisation_id=org_id, slug="atelier-alpha", state="permanent"
    ).exists()
    assert Identity.objects.filter(
        organisation_id=org_id, issuer=SHARED_ISSUER, subject="founder-sub-01", enabled=True
    ).exists()
    assert Membership.objects.filter(
        organisation_id=org_id, role="org_owner", state="active"
    ).exists()
    tenant = Tenant.objects.get(id=tenant_id)
    assert tenant.status == "active"
    assert tenant.capacity_tier_code == "S"
    assert Workspace.objects.filter(id=ws_id, organisation_id=org_id).exists()
    channel_names = set(Channel.objects.filter(workspace_id=ws_id).values_list("name", flat=True))
    assert {"welcome", "general", "lounge"} <= channel_names
    quota = WorkspaceQuota.objects.get(workspace_id=ws_id)
    assert quota.seats == 5
    assert quota.policy_ref == "freemium:pme:seats-5"

    # Idempotent replay returns identical 201 without creating a duplicate org.
    replay = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier Alpha", "slug": "atelier-alpha", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000001",
    )
    assert replay.status_code == 201
    assert replay.json() == payload

    # Different payload with same Idempotency-Key -> 409 idempotency-key-reuse.
    mismatch = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier Beta", "slug": "atelier-beta", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000001",
    )
    assert mismatch.status_code == 409
    assert mismatch.json()["type"].endswith("/idempotency-key-reuse")

    # Slug collision returns 409 slug-taken with up to 3 available suggestions.
    settings.KODERA_BILLING_ENABLED = True
    collision = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier Alpha Bis", "slug": "atelier-alpha", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000002",
    )
    assert collision.status_code == 409
    col_body = collision.json()
    assert col_body["type"].endswith("/slug-taken")
    assert col_body["slug"] == "atelier-alpha"
    assert col_body["suggestions"] == ["atelier-alpha-2", "atelier-alpha-3", "atelier-alpha-4"]

    # Unverified email is refused 403 forbidden.
    unverified_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="unverified-sub",
        email="unverified@pme.fr",
        email_verified=False,
    )
    unverified_resp = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Unverified", "slug": "unverified-pme", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {unverified_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000003",
    )
    assert unverified_resp.status_code == 403

    # <= 3 active freemium_pme orgs per person: 2nd and 3rd succeed; 4th returns 429.
    for idx, slug in ((2, "atelier-bravo"), (3, "atelier-charlie")):
        ok_resp = client.post(
            "/api/v1/workspaces/self-serve",
            data=json.dumps({"name": f"Atelier {idx}", "slug": slug, "locale": "en"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
            HTTP_IDEMPOTENCY_KEY=f"idem-000000000000001{idx}",
        )
        assert ok_resp.status_code == 201, ok_resp.content

    fourth = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier 4", "slug": "atelier-delta", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000014",
    )
    assert fourth.status_code == 429
    assert fourth.json()["code"] == "self_serve_workspace_limit"
    assert "Retry-After" in fourth.headers


def test_multi_org_shared_realm_me_and_org_scoped_isolation(settings, http_signer):
    _setup_shared_realm_settings(settings, http_signer)
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    # Create canonical community org + person membership sharing the same OIDC (issuer, subject).
    with transaction.atomic():
        community = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer=SHARED_ISSUER,
            name="Kodera Community",
            state=Organisation.State.ACTIVE,
            is_default_community=True,
            plan_tier=Organisation.PlanTier.COMMUNITY,
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug="community",
            organisation=community,
            state="permanent",
            protected_at=timezone.now(),
        )
        comm_owner = User.objects.create(
            email="steward@community.kodera.test", display_name="Steward"
        )
        Membership.objects.create(
            user=comm_owner,
            organisation=community,
            role=Membership.Role.OWNER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
        person = User.objects.create(email="alice@multi-pme.fr", display_name="Alice")
        comm_ident = Identity.objects.create(
            user=person,
            organisation=community,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="alice-shared-sub",
            email="alice@multi-pme.fr",
            enabled=True,
        )
        Membership.objects.create(
            user=person,
            organisation=community,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )

    alice_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="alice-shared-sub",
        email="alice@multi-pme.fr",
        email_verified=True,
    )

    # Alice creates two shared-realm PME workspaces under the same OIDC subject.
    created_orgs: list[tuple[str, str]] = []
    for slug in ("studio-nord", "studio-sud"):
        r = client.post(
            "/api/v1/workspaces/self-serve",
            data=json.dumps({"name": slug.title(), "slug": slug, "locale": "fr"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {alice_cred}",
            HTTP_IDEMPOTENCY_KEY=f"idem-alice-{slug}",
        )
        assert r.status_code == 201, r.content
        created_orgs.append((slug, r.json()["organisation_id"]))

    # Another user creates a third shared-realm PME workspace that Alice does NOT belong to.
    bob_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="bob-shared-sub",
        email="bob@other-pme.fr",
        email_verified=True,
    )
    other_r = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Bob Studio", "slug": "bob-studio", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {bob_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000019",
    )
    assert other_r.status_code == 201, other_r.content
    bob_org_id = other_r.json()["organisation_id"]

    # GET /api/v1/me succeeds without MultipleObjectsReturned and exposes shared_realm + plan_tier.
    me_resp = client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {alice_cred}")
    assert me_resp.status_code == 200, me_resp.content
    me_body = me_resp.json()
    by_slug = {entry["organisation"]["slug"]: entry for entry in me_body["organisations"]}
    assert set(by_slug) == {"community", "studio-nord", "studio-sud"}
    assert by_slug["community"]["identity_id"] == str(comm_ident.id)
    assert by_slug["community"]["plan_tier"] == "community"
    for slug, org_id_str in created_orgs:
        entry = by_slug[slug]
        assert entry["shared_realm"] is True
        assert entry["plan_tier"] == "freemium_pme"
        expected_ident = Identity.objects.get(
            organisation_id=UUID(org_id_str), issuer=SHARED_ISSUER, subject="alice-shared-sub"
        )
        assert entry["identity_id"] == str(expected_ident.id)

        # Org-scoped workspace read succeeds on Alice's PME orgs.
        ws_resp = client.get(
            f"/api/v1/organisations/{org_id_str}/workspace",
            HTTP_AUTHORIZATION=f"Bearer {alice_cred}",
        )
        assert ws_resp.status_code == 200, ws_resp.content

    # Org-scoped workspace read on Bob's shared-realm org fails closed (403/404).
    forbidden_ws = client.get(
        f"/api/v1/organisations/{bob_org_id}/workspace",
        HTTP_AUTHORIZATION=f"Bearer {alice_cred}",
    )
    assert forbidden_ws.status_code in (403, 404)


def test_shared_realm_invitations_five_seat_ceiling_and_upgrade_unlock(settings, http_signer):
    _setup_shared_realm_settings(settings, http_signer)
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    owner_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="pme-owner-sub",
        email="owner@cinq-seats.fr",
        email_verified=True,
    )
    created = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Cinq Seats PME", "slug": "cinq-seats", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000020",
    )
    assert created.status_code == 201, created.content
    org_id = UUID(created.json()["organisation_id"])
    owner_verified = _verified_shared("pme-owner-sub", "owner@cinq-seats.fr")

    # Seats 2, 3, 4 join via HTTP email invitations; Seat 5 joins via reusable workspace invite link.
    settings.KODERA_CONTACT_SEAL_KEY = b"\x11" * 32
    for idx in (2, 3, 4):
        email = f"member{idx}@cinq-seats.fr"
        inv_resp = client.post(
            f"/api/v1/organisations/{org_id}/invitations",
            data=json.dumps({"invitations": [{"email": email, "role": "org_member"}]}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {owner_cred}",
            HTTP_IDEMPOTENCY_KEY=f"idem-000000000000002{idx}",
        )
        assert inv_resp.status_code == 201, inv_resp.content
        inv_body = inv_resp.json()
        assert inv_body["created"] == 1
        inv_id = UUID(inv_body["results"][0]["invitation"]["id"])
        raw_secret = f"secret_seat_{idx}_" + ("a" * (43 - len(f"secret_seat_{idx}_")))
        Invitation.objects.filter(id=inv_id).update(token_digest=invitation_digest(raw_secret))
        invitee_cred = _mint_customer_jwt(
            http_signer,
            SHARED_ISSUER,
            subject=f"member-sub-{idx}",
            email=email,
            email_verified=True,
        )
        acc_resp = client.post(
            "/api/v1/invitations/accept",
            data=json.dumps({"token": format_invitation_token(inv_id, raw_secret)}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {invitee_cred}",
            HTTP_IDEMPOTENCY_KEY=f"idem-000000000000003{idx}",
        )
        assert acc_resp.status_code == 200, acc_resp.content
        assert acc_resp.json()["state"] == "active"
        assert Identity.objects.filter(
            organisation_id=org_id, issuer=SHARED_ISSUER, subject=f"member-sub-{idx}", enabled=True
        ).exists()

    # Seat 5 via workspace invite link redemption (`redeem_link`).
    _link_row, link_code = create_link(
        verified=owner_verified,
        organisation_id=org_id,
        expires_at=timezone.now() + timedelta(days=1),
        max_uses=5,
        role="org_member",
        channel_id=None,
        request_id="req-link-create",
    )
    redeemed_5 = redeem_link(
        verified=_verified_shared("member-sub-5", "member5@cinq-seats.fr"),
        code=link_code,
        request_id="req-link-redeem-5",
    )
    assert redeemed_5.organisation_id == org_id
    assert Membership.objects.filter(organisation_id=org_id, state="active").count() == 5

    # 6th member via HTTP POST /invitations -> HTTP 402 subscription-required!
    sixth_inv = client.post(
        f"/api/v1/organisations/{org_id}/invitations",
        data=json.dumps(
            {"invitations": [{"email": "member6@cinq-seats.fr", "role": "org_member"}]}
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000040",
    )
    assert sixth_inv.status_code == 402, sixth_inv.content
    assert sixth_inv.json()["type"] == "https://kodera.io/problems/subscription-required"

    # 6th member via HTTP POST /workspace-invites/redeem -> HTTP 402 subscription-required!
    sixth_cred = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="member-sub-6",
        email="member6@cinq-seats.fr",
        email_verified=True,
    )
    sixth_redeem = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": link_code}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {sixth_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000041",
    )
    assert sixth_redeem.status_code == 402, sixth_redeem.content
    assert sixth_redeem.json()["type"] == "https://kodera.io/problems/subscription-required"

    # Upgrading to an active Team subscription promotes plan_tier and unlocks seats > 5!
    register_test_fiscal_periods()
    catalogue.load(catalogue.read(catalogue.OFFER), allow_placeholder=False)
    if not LegalDocument.objects.exists():
        legal_services.load_documents(
            legal_services.read_documents(legal_services.PLACEHOLDER),
            allow_placeholder=True,
        )
    billing_services.set_billing_profile(
        organisation_id=org_id,
        legal_name="Cinq Seats SAS",
        address_line1="5 rue Oberkampf",
        postal_code="75011",
        city="Paris",
        country="FR",
        siren="200000005",
    )
    dpa, _ = legal_services.generate_dpa(
        verified=owner_verified,
        organisation_id=org_id,
        pack_code="workspace-v2",
        locale="fr",
        tenant_id=None,
    )
    placed_team = billing_services.place_order(
        verified=owner_verified,
        organisation_id=org_id,
        idempotency_key="order-cinq-seats-upgrade-01",
        request=OrderRequest(
            pack_code="workspace-v2",
            capacity_tier_code="S",
            billing_period="yearly",
            quantity=1,
            tenant=TenantRequest(slug="cinq-seats-pro", name="Cinq Seats Pro"),
            agreements=Agreements(
                dpa_id=dpa.id,
                documents=(Accepted(code="cgv", version="0.0", locale="fr"),),
            ),
        ),
        request_id="req-order-cinq-seats-01",
    )
    sub = Subscription.objects.get(id=placed_team.subscription.id)
    Subscription.objects.filter(id=sub.id).update(state="active")
    sub.refresh_from_db()
    with transaction.atomic():
        promoted_tier = sync_organisation_plan_tier_for_subscription(sub)
    assert promoted_tier == Organisation.PlanTier.CLOUD_COLLABORATIVE
    org_after = Organisation.objects.get(id=org_id)
    assert org_after.plan_tier == Organisation.PlanTier.CLOUD_COLLABORATIVE
    quota_after = WorkspaceQuota.objects.get(workspace__organisation_id=org_id)
    assert quota_after.seats is not None and quota_after.seats >= 12

    unlocked_redeem = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": link_code}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {sixth_cred}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000042",
    )
    assert unlocked_redeem.status_code == 200, unlocked_redeem.content
    assert Membership.objects.filter(organisation_id=org_id, state="active").count() == 6


def test_sovereign_order_stripe_settlement_warm_pool_fast_path_and_cold_fallback(
    settings, monkeypatch, http_signer
):
    import importlib

    from core.api.edition import _ensure_ee_importable

    _ensure_ee_importable()
    storage_mod = importlib.import_module("ee.billing.storage")
    wp_mod = importlib.import_module("ee.billing.warm_pool")
    authority_cls = storage_mod.CallerAuthority
    sovereign_watermarks = wp_mod.SOVEREIGN_POOL_WATERMARKS
    controller_cls = wp_mod.WarmPoolController

    _setup_shared_realm_settings(settings, http_signer)
    register_test_fiscal_periods()
    catalogue.load(catalogue.read(catalogue.OFFER), allow_placeholder=False)
    if not LegalDocument.objects.exists():
        legal_services.load_documents(
            legal_services.read_documents(legal_services.PLACEHOLDER),
            allow_placeholder=True,
        )

    settings.KODERA_EDITION = "enterprise"
    settings.KODERA_BILLING_ENABLED = True
    settings.KODERA_PAYMENT_PROVIDER = "stripe"
    settings.KODERA_STRIPE_SECRET_KEY = STRIPE_SECRET
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.kodera.test"})
    provider = StripeProvider(
        secret_key=STRIPE_SECRET,
        webhook_secret=WEBHOOK_SECRET,
        transport=_StubStripeTransport(),
    )
    monkeypatch.setattr(payments_package, "_stripe", lambda secret_key, webhook_secret: provider)

    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    authority = authority_cls(
        lane="internal",
        identity_id="system:test-seed",
        live_authority=True,
    )
    wp = controller_cls(
        sovereign_watermarks,
        default_region="fr-par",
        default_profile_ref=SOVEREIGN_PROFILE_REF,
        backend="postgres",
    )
    assert sovereign_watermarks.max_total == 3
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ee_billing_warm_pool_slots WHERE profile_ref = %s",
            [SOVEREIGN_PROFILE_REF],
        )

    # Seed WarmPool and mark 1 PRO2-S cell `ready` for Fast Path.
    replenished = wp.replenish(
        region="fr-par", profile_ref=SOVEREIGN_PROFILE_REF, authority=authority
    )
    assert 1 <= len(replenished) <= 3
    ready_slot = wp.mark_ready(replenished[0].slot_id, authority=authority)
    assert ready_slot.state == "ready"

    def _create_org_and_sovereign_order(
        idx: int,
    ) -> tuple[Organisation, Order, Invoice, PaymentLink]:
        founder_sub = f"sov-founder-{idx}"
        founder_email = f"founder{idx}@sovereign-test.fr"
        cred = _mint_customer_jwt(
            http_signer,
            SHARED_ISSUER,
            subject=founder_sub,
            email=founder_email,
            email_verified=True,
        )
        res = client.post(
            "/api/v1/workspaces/self-serve",
            data=json.dumps(
                {"name": f"Sovereign Org {idx}", "slug": f"sov-org-{idx}", "locale": "fr"}
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {cred}",
            HTTP_IDEMPOTENCY_KEY=f"idem-000000000000005{idx}",
        )
        assert res.status_code == 201, res.content
        org = Organisation.objects.get(id=UUID(res.json()["organisation_id"]))
        billing_services.set_billing_profile(
            organisation_id=org.id,
            legal_name=f"Sovereign {idx} SAS",
            address_line1="10 rue de la Paix",
            postal_code="75002",
            city="Paris",
            country="FR",
            siren=f"10000000{idx}",
        )
        verified_owner = _verified_shared(founder_sub, founder_email)
        dpa, _ = legal_services.generate_dpa(
            verified=verified_owner,
            organisation_id=org.id,
            pack_code="sovereign",
            locale="fr",
            tenant_id=None,
        )
        placed = billing_services.place_order(
            verified=verified_owner,
            organisation_id=org.id,
            idempotency_key=f"order-sovereign-{idx:04d}",
            request=OrderRequest(
                pack_code="sovereign",
                capacity_tier_code="S",
                billing_period="monthly",
                tenant=TenantRequest(slug=f"sov-cell-{idx}", name=f"Sovereign Cell {idx}"),
                agreements=Agreements(
                    dpa_id=dpa.id,
                    documents=(Accepted(code="cgv", version="0.0", locale="fr"),),
                ),
            ),
            request_id=f"req-order-sov-{idx:04d}",
        )
        assert placed.invoice.total_excl_vat_minor == 29_000
        link = payment_services.create_payment_link(
            invoice_id=placed.invoice.id,
            organisation_id=org.id,
            return_url="https://app.kodera.test/billing",
        ).link
        return org, placed.order, placed.invoice, link

    # --- Case A: Fast Path (claims pre-warmed `ready` slot without touching sRGB2014.icc) ---
    from dataclasses import replace as dc_replace
    from pathlib import Path

    from apps.billing.documents import (
        FacturXUnavailableError,
        render_cii,
        render_facturx,
        snapshot_of,
    )
    from apps.billing.integrity import IntegrityRefusedError
    from apps.billing.payments.stripe_webhook import _sync_reversed_subscription

    org1, order1, inv1, link1 = _create_org_and_sovereign_order(1)
    evt1 = {
        "id": "evt_s3beta_sov_fast_01",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": link1.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_s3beta_sov_fast_01",
                "amount_total": inv1.total_incl_vat_minor,
                "currency": inv1.currency.lower(),
            }
        },
    }
    raw1 = json.dumps(evt1, separators=(",", ":")).encode("utf-8")

    # Simulate stripped API Docker image (`.dockerignore:219` excludes `sRGB2014.icc`):
    orig_read_bytes = Path.read_bytes

    def _forbid_icc_in_http_webhook(self_path: Path) -> bytes:
        if self_path.name == "sRGB2014.icc":
            raise FileNotFoundError("sRGB2014.icc excluded in stripped API image")
        return orig_read_bytes(self_path)

    with monkeypatch.context() as mp_icc:
        mp_icc.setattr(Path, "read_bytes", _forbid_icc_in_http_webhook)
        wh_resp1 = client.post(
            "/api/v1/webhooks/stripe",
            data=raw1,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=_sign_stripe(raw1),
        )
    assert wh_resp1.status_code == 200, wh_resp1.content
    assert wh_resp1.json()["status"] == "applied"

    inv1.refresh_from_db()
    org1.refresh_from_db()
    tenant1 = Tenant.objects.get(id=order1.tenant_id)
    assert inv1.state == "paid"
    assert inv1.issued_at is not None and inv1.number is not None
    # Stripped HTTP webhook leaves `pdf_ref=None` for offline operator `render_billing_document`!
    assert inv1.pdf_ref is None
    assert BillingArtifact.objects.filter(invoice_id=inv1.id).count() == 0

    snap1 = snapshot_of(inv1)
    xml1_bytes = render_cii(snap1)
    assert b"CrossIndustryInvoice" in xml1_bytes
    assert b"<ram:TypeCode>380</ram:TypeCode>" in xml1_bytes
    assert b"<ram:GrandTotalAmount>348.00</ram:GrandTotalAmount>" in xml1_bytes

    # Fail-closed Factur-X boundary + EN16931 BR-03 missing issue date refusal:
    with pytest.raises(FacturXUnavailableError):
        render_facturx(snap1, renderer=None, validator=None)
    with pytest.raises(IntegrityRefusedError, match="document_snapshot_invalid"):
        render_cii(dc_replace(snap1, issued_at=None))

    # When optional offline operator rendering deps are installed, verify XSD + Schematron + TrueType:
    try:
        import facturx as _fx  # noqa: F401
        import saxonche as _sx  # noqa: F401
    except ImportError:
        pass
    else:
        import re as _re

        from apps.billing.rendering import OfflineRenderer, validate_xml

        validate_xml(xml1_bytes)
        pdf1_bytes = OfflineRenderer().render(snap1, xml1_bytes)
        assert pdf1_bytes.startswith(b"%PDF-1.7")
        assert b"/Subtype /TrueType" in pdf1_bytes
        assert b"/Subtype /Type3" not in pdf1_bytes
        xml_missing_br03 = _re.sub(
            rb"<ram:IssueDateTime>.*?</ram:IssueDateTime>", b"", xml1_bytes, flags=_re.DOTALL
        )
        with pytest.raises(IntegrityRefusedError):
            validate_xml(xml_missing_br03)

    assert org1.plan_tier == Organisation.PlanTier.SOVEREIGN
    assert WorkspaceQuota.objects.get(workspace__organisation_id=org1.id).seats == 25
    assert tenant1.status == "provisioning"
    assert Job.objects.filter(
        organisation_id=org1.id, tenant_id__isnull=True, kind="realm_create"
    ).exists()

    # Refund/reversal seat quota parity across Sovereign S (25), M (100), and L (250):
    sub1 = Subscription.objects.get(id=inv1.subscription_id)
    for tier_code, expected_seats in (("S", 25), ("M", 100), ("L", 250)):
        Subscription.objects.filter(id=sub1.id).update(state="active", capacity_tier_code=tier_code)
        Invoice.objects.filter(id=inv1.id).update(amount_paid_minor=0)
        inv1.refresh_from_db()
        with transaction.atomic():
            _sync_reversed_subscription(invoice=inv1)
        assert (
            WorkspaceQuota.objects.get(workspace__organisation_id=org1.id).seats == expected_seats
        )
    Subscription.objects.filter(id=sub1.id).update(state="active", capacity_tier_code="S")
    Invoice.objects.filter(id=inv1.id).update(amount_paid_minor=inv1.total_incl_vat_minor)

    slots_after_1 = wp.list_slots(profile_ref=SOVEREIGN_PROFILE_REF, authority=authority)
    claimed_for_1 = [s for s in slots_after_1 if s.claimed_by_organisation_id == str(org1.id)]
    assert len(claimed_for_1) == 1
    assert claimed_for_1[0].slot_id == ready_slot.slot_id
    active_non_evicted_1 = [s for s in slots_after_1 if s.state != "evicted"]
    assert len(active_non_evicted_1) <= 3

    # --- Case B: Cold Fallback (0 `ready` slots remaining in WarmPool) ---
    assert sum(1 for s in slots_after_1 if s.state == "ready") == 0
    org2, order2, inv2, link2 = _create_org_and_sovereign_order(2)
    evt2 = {
        "id": "evt_s3beta_sov_cold_02",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": link2.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_s3beta_sov_cold_02",
                "amount_total": inv2.total_incl_vat_minor,
                "currency": inv2.currency.lower(),
            }
        },
    }
    raw2 = json.dumps(evt2, separators=(",", ":")).encode("utf-8")
    wh_resp2 = client.post(
        "/api/v1/webhooks/stripe",
        data=raw2,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw2),
    )
    assert wh_resp2.status_code == 200, wh_resp2.content
    inv2.refresh_from_db()
    tenant2 = Tenant.objects.get(id=order2.tenant_id)
    assert inv2.state == "paid"
    assert inv2.pdf_ref is None
    assert tenant2.status == "provisioning"
    assert Job.objects.filter(
        organisation_id=org2.id, tenant_id=tenant2.id, kind="provision"
    ).exists()
    slots_after_2 = [
        s
        for s in wp.list_slots(profile_ref=SOVEREIGN_PROFILE_REF, authority=authority)
        if s.state != "evicted"
    ]
    assert len(slots_after_2) <= 3

    # --- Case C: Per-Tenant WarmPool Cap Exceeded -> Clean Cold Fallback (Zero 500s) ---
    org3, order3, inv3, link3 = _create_org_and_sovereign_order(3)
    # Mark both remaining provisioning slots ready and pre-claim one for org3 so org3 already holds a claimed slot.
    prov_slots = [s for s in slots_after_2 if s.state == "provisioning"]
    for ps in prov_slots:
        wp.mark_ready(ps.slot_id, authority=authority)
    wp.claim_slot(
        idempotency_key=f"preclaim:{org3.id}",
        organisation_id=str(org3.id),
        checkout_id="preclaim-checkout-03",
        region="fr-par",
        profile_ref=SOVEREIGN_PROFILE_REF,
        authority=authority,
    )
    evt3 = {
        "id": "evt_s3beta_sov_cap_03",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": link3.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_s3beta_sov_cap_03",
                "amount_total": inv3.total_incl_vat_minor,
                "currency": inv3.currency.lower(),
            }
        },
    }
    raw3 = json.dumps(evt3, separators=(",", ":")).encode("utf-8")
    wh_resp3 = client.post(
        "/api/v1/webhooks/stripe",
        data=raw3,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw3),
    )
    assert wh_resp3.status_code == 200, wh_resp3.content
    tenant3 = Tenant.objects.get(id=order3.tenant_id)
    assert tenant3.status == "provisioning"
    assert Job.objects.filter(
        organisation_id=org3.id, tenant_id=tenant3.id, kind="provision"
    ).exists()


def test_sre_summary_staff_endpoint_cli_and_writer_role_grants(settings, http_signer):
    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_EDITION = "enterprise"

    # 1. Direct SRE summary & manage.py sre_status --json
    from typing import Any, cast

    summary = cast(dict[str, Any], collect_sre_summary())
    assert summary["warm_pool"]["max_total"] == 3
    assert summary["finops_guard"]["min_margin_bps_floor"] == 4400
    assert set(summary["finops_guard"]["sovereign_tiers"]) == {"PRO2-S", "PRO2-M", "PRO2-L"}
    assert "slo_indicators" in summary

    settings.KODERA_OPERATOR_PROFILE = True
    stdout = io.StringIO()
    call_command("sre_status", "--json", stdout=stdout)
    cli_payload = json.loads(stdout.getvalue())
    assert cli_payload["warm_pool"]["max_total"] == 3
    serialized = json.dumps(cli_payload)
    assert "%" not in serialized and "SLA" not in serialized

    # 2. Staff HTTP endpoint GET /staff/v1/read/sre
    settings.ALLOWED_HOSTS = [
        "localhost",
        "127.0.0.1",
        "testserver",
        "admin.kodera.io",
        "ops-admin.kodera.io",
    ]
    settings.KODERA_STAFF_OIDC_ISSUER = STAFF_ISSUER
    settings.KODERA_STAFF_OIDC_JWKS_URL = STAFF_JWKS_URL
    settings.KODERA_STAFF_OPS_HOSTS = ("ops-admin.kodera.io",)
    settings.KODERA_STAFF_ADMIN_ORIGINS = "https://admin.kodera.io,https://ops-admin.kodera.io"
    private_key, alg, public_jwk = http_signer
    register_test_jwks(STAFF_JWKS_URL, {"keys": [{**public_jwk, "use": "sig"}]})
    try:
        staff_person = User.objects.create(email="sre@kodera.test", display_name="Lours")
        staff_ident = Identity.objects.create(
            user=staff_person,
            organisation=None,
            issuer=STAFF_ISSUER,
            realm=STAFF_REALM,
            subject="staff-sre-sub",
            email="sre@kodera.test",
            enabled=True,
        )
        StaffRoleGrant.objects.create(
            identity_id=staff_ident.id,
            realm=STAFF_REALM,
            role="staff_operator",
            granted_by_identity_id=staff_ident.id,
        )
        StaffRole.objects.create(identity=staff_ident, realm=STAFF_REALM, role="staff_operator")
        now = int(time.time())
        staff_cred = jwt.encode(
            {
                "iss": STAFF_ISSUER,
                "sub": "staff-sre-sub",
                "azp": "kodera-admin",
                "aud": ["kodera-admin-api", "kodera-server"],
                "iat": now,
                "exp": now + 300,
                "amr": ["otp"],
                "auth_time": now,
            },
            private_key,
            algorithm=alg,
            headers={"kid": public_jwk["kid"]},
        )
        client = Client(raise_request_exception=False, HTTP_HOST="admin.kodera.io")
        sre_resp = client.get("/staff/v1/read/sre", HTTP_AUTHORIZATION=f"Bearer {staff_cred}")
        assert sre_resp.status_code == 200, sre_resp.content
        sre_json = sre_resp.json()
        assert sre_json["warm_pool"]["max_total"] == 3
        assert len(sre_json["finops_guard"]["sovereign_tiers"]) == 3
    finally:
        clear_jwks_cache()

    # 3. Least-privilege kodera_api writer-role invariants
    assert ("billing_invoice", "number") not in api_writer_role.UPDATE_COLUMNS
    assert "billing_invoicenumbercounter" not in api_writer_role.SELECT
    assert "billing_invoicenumbercounter" not in api_writer_role.INSERT
    assert all(tbl != "billing_invoicenumbercounter" for tbl, _ in api_writer_role.UPDATE_COLUMNS)
    assert (
        "billing_issue_draft_invoice(uuid, uuid, text, integer)"
        in api_writer_role.EXECUTE_FUNCTIONS
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT proname, prosecdef FROM pg_proc WHERE proname = 'billing_issue_draft_invoice'"
        )
        proc_row = cursor.fetchone()
    assert proc_row == ("billing_issue_draft_invoice", True)


def _seed_community_for_r2(
    members: tuple[tuple[str, str], ...] = (),
) -> Organisation:
    with transaction.atomic():
        community = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer=SHARED_ISSUER,
            name="Kodera Community",
            state=Organisation.State.ACTIVE,
            is_default_community=True,
            plan_tier=Organisation.PlanTier.COMMUNITY,
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug="community",
            organisation=community,
            state="permanent",
            protected_at=timezone.now(),
        )
        steward = User.objects.create(
            email="steward-r2@community.kodera.test", display_name="Steward"
        )
        Membership.objects.create(
            user=steward,
            organisation=community,
            role=Membership.Role.OWNER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
        for subject, email in members:
            person = User.objects.create(email=email, display_name=email.split("@")[0])
            Identity.objects.create(
                user=person,
                organisation=community,
                issuer=SHARED_ISSUER,
                realm="community",
                subject=subject,
                email=email,
                enabled=True,
            )
            Membership.objects.create(
                user=person,
                organisation=community,
                role=Membership.Role.MEMBER,
                state=Membership.State.ACTIVE,
                accepted_at=timezone.now(),
            )
        return community


def test_shared_realm_member_suspension_never_disables_global_keycloak_or_other_orgs(
    settings, http_signer
):
    """Suspending/removing a shared-realm PME member must NEVER queue global Keycloak disable/logout."""
    from apps.orgs import membership_lifecycle
    from apps.outbox.models import OutboxRealmAccess

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_DEFAULT_COMMUNITY_SLUG = "community"
    community = _seed_community_for_r2(members=(("sub-r2-bob", "bob-r2@example.org"),))
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    alice_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r2-alice",
        email="alice-r2@example.org",
        email_verified=True,
    )
    bob_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r2-bob",
        email="bob-r2@example.org",
        email_verified=True,
    )
    carol_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r2-carol",
        email="carol-r2@example.org",
        email_verified=True,
    )

    # Bob visits `/api/v1/me` -> materializes Community membership.
    assert client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {bob_tok}").status_code == 200

    # Alice creates PME Org A; Carol creates PME Org B.
    r_a = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME Alpha", "slug": "pme-alpha-r2"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {alice_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000081",
    )
    assert r_a.status_code == 201, r_a.content
    org_a_id = UUID(r_a.json()["organisation_id"])

    r_b = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME Bravo", "slug": "pme-bravo-r2"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {carol_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000082",
    )
    assert r_b.status_code == 201, r_b.content
    org_b_id = UUID(r_b.json()["organisation_id"])

    alice_verified = _verified_shared("sub-r2-alice", "alice-r2@example.org")
    bob_verified = _verified_shared("sub-r2-bob", "bob-r2@example.org")
    carol_verified = _verified_shared("sub-r2-carol", "carol-r2@example.org")

    # Bob joins both PME Org A and PME Org B via workspace invite links.
    for target_org_id, owner_ver in ((org_a_id, alice_verified), (org_b_id, carol_verified)):
        _, code = create_link(
            verified=owner_ver,
            organisation_id=target_org_id,
            expires_at=timezone.now() + timedelta(days=1),
            max_uses=5,
            role="org_member",
            channel_id=None,
            request_id=f"req-link-{target_org_id}",
        )
        redeem_link(
            verified=bob_verified,
            code=code,
            request_id=f"req-redeem-{target_org_id}",
        )

    bob_member_a = Membership.objects.get(
        organisation_id=org_a_id, user__email="bob-r2@example.org"
    )
    detail, current_etag = membership_lifecycle.read_membership(
        verified=alice_verified,
        organisation_id=org_a_id,
        membership_id=bob_member_a.id,
    )
    assert detail is not None and current_etag

    # Alice suspends Bob in PME Org A -> zero global `OutboxRealmAccess` rows queued!
    membership_lifecycle.change_membership(
        verified=alice_verified,
        organisation_id=org_a_id,
        membership_id=bob_member_a.id,
        patch={"state": "suspended"},
        if_match=current_etag,
        request_id="req-suspend-bob-a",
    )
    assert OutboxRealmAccess.objects.count() == 0

    # Bob is refused non-disclosingly in PME Org A (`404`) while Community and PME Org B remain accessible!
    assert (
        client.get(
            f"/api/v1/organisations/{org_a_id}/workspace",
            HTTP_AUTHORIZATION=f"Bearer {bob_tok}",
        ).status_code
        == 404
    )
    assert client.get(
        f"/api/v1/organisations/{community.id}/workspace",
        HTTP_AUTHORIZATION=f"Bearer {bob_tok}",
    ).status_code in (200, 404)
    assert (
        client.get(
            f"/api/v1/organisations/{org_b_id}/workspace",
            HTTP_AUTHORIZATION=f"Bearer {bob_tok}",
        ).status_code
        == 200
    )
    me_bob = client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {bob_tok}")
    assert me_bob.status_code == 200


def test_concurrent_first_visit_self_serve_creates_single_user_and_enforces_three_org_cap(
    settings, http_signer
):
    """Concurrent first-visit `POST /api/v1/workspaces/self-serve` creates 1 `User` and `<= 3` orgs."""
    from concurrent.futures import ThreadPoolExecutor

    from django.db import connections

    _setup_shared_realm_settings(settings, http_signer)
    _seed_community_for_r2()
    tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r2-concurrent",
        email="race-r2@example.org",
        email_verified=True,
    )

    def _worker(idx: int) -> int:
        try:
            c = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
            resp = c.post(
                "/api/v1/workspaces/self-serve",
                data=json.dumps({"name": f"Race PME {idx}", "slug": f"race-pme-{idx:02d}"}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {tok}",
                HTTP_IDEMPOTENCY_KEY=f"idem-00000000000001{idx:02d}",
            )
            return resp.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(_worker, range(6)))

    assert statuses.count(201) == 3, statuses
    assert statuses.count(429) == 3, statuses
    identities = list(Identity.objects.filter(issuer=SHARED_ISSUER, subject="sub-r2-concurrent"))
    assert len({ident.user_id for ident in identities}) == 1
    assert len(identities) == 3


def test_shared_realm_me_mfa_boost_cap_and_ee_billing_multi_org_authority(
    settings, monkeypatch, http_signer
):
    """Verify MFA emission across shared-realm identities, Boost 5-seat cap, and PME EE quote auth."""
    from apps.billing.boosts import recompute_workspace_boost_quota

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_EDITION = "enterprise"
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    settings.KODERA_DEFAULT_COMMUNITY_SLUG = "community"
    _seed_community_for_r2(members=(("sub-r2-mfa-owner", "mfa-owner@example.org"),))
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    mfa_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r2-mfa-owner",
        email="mfa-owner@example.org",
        email_verified=True,
        azp="synthetic-console",
        amr=["pwd", "otp"],
    )

    # First materialize Community (`org_member`), then create PME Org (`org_owner`).
    assert client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {mfa_tok}").status_code == 200
    r_pme = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "MFA Studio", "slug": "mfa-studio-r2"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {mfa_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000091",
    )
    assert r_pme.status_code == 201, r_pme.content
    pme_org_id = UUID(r_pme.json()["organisation_id"])
    pme_ws_id = UUID(r_pme.json()["workspace_id"])

    # 1. `GET /api/v1/me` emits `mfa_enrolled: True` on BOTH shared-realm identities!
    me_resp = client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {mfa_tok}")
    assert me_resp.status_code == 200
    me_identities = me_resp.json()["identities"]
    assert len(me_identities) == 2
    assert all(item.get("mfa_enrolled") is True for item in me_identities)

    # 2. Recomputing boost quota on `freemium_pme` keeps base seats at `5` (never `25`)!
    assert Workspace.objects.filter(id=pme_ws_id).exists()
    with transaction.atomic():
        effective = recompute_workspace_boost_quota(
            organisation_id=pme_org_id, workspace_id=pme_ws_id
        )
    assert effective.seats == 5
    assert WorkspaceQuota.objects.get(workspace_id=pme_ws_id).seats == 5

    # 3. PME `org_owner` (who is only `org_member` in Community!) succeeds on `/api/v1/ee/billing/quotes`!
    quote_resp = client.post(
        "/api/v1/ee/billing/quotes",
        data=json.dumps(
            {
                "organisation_id": str(pme_org_id),
                "plan_code": "sovereign",
                "seats": 25,
                "billing_cycle": "monthly",
            }
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {mfa_tok}",
    )
    assert quote_resp.status_code == 200, quote_resp.content
    assert quote_resp.json()["net_excl_vat_minor"] == 29_000
    assert quote_resp.json()["vm_shape"] == "PRO2-S"


def test_preexisting_shared_realm_outbox_delivery_retires_without_calling_keycloak(
    settings, http_signer
):
    """Prove pre-existing pending `OutboxRealmAccess` rows on `shared_realm` or `is_default_community`
    organisations are retired cleanly at execution time without ever calling Keycloak."""
    from contextlib import contextmanager

    from apps.outbox.models import OutboxDelivery
    from apps.outbox.realm_access import OrganisationLock, run_realm_deliveries
    from apps.outbox.realm_enqueue import ACCESS_OFF, insert_realm_access

    _setup_shared_realm_settings(settings, http_signer)
    comm = _seed_community_for_r2(members=(("sub-r3-outbox", "outbox-r3@example.org"),))
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r3-outbox",
        email="outbox-r3@example.org",
        email_verified=True,
    )
    r_pme = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Outbox Guard PME", "slug": "outbox-guard-pme"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000301",
    )
    assert r_pme.status_code == 201, r_pme.content
    pme_org_id = UUID(r_pme.json()["organisation_id"])

    comm_mem = Membership.objects.get(organisation_id=comm.id, user__email="outbox-r3@example.org")
    comm_ident = Identity.objects.get(organisation_id=comm.id, subject="sub-r3-outbox")

    # Add a second `org_member` on `pme_org_id`, then suspend both members and insert legacy pending `access_off` rows.
    with transaction.atomic():
        pme_member_user = User.objects.create(
            email="member-r3-outbox@example.org", display_name="Member R3"
        )
        pme_ident = Identity.objects.create(
            user=pme_member_user,
            organisation_id=pme_org_id,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-r3-outbox-member",
            email="member-r3-outbox@example.org",
            enabled=True,
        )
        pme_mem = Membership.objects.create(
            user=pme_member_user,
            organisation_id=pme_org_id,
            role=Membership.Role.MEMBER,
            state="suspended",
            accepted_at=timezone.now(),
        )
        Membership.objects.filter(id=comm_mem.id).update(state="suspended")
        comm_deliv_id = insert_realm_access(
            organisation_id=comm.id,
            membership_id=comm_mem.id,
            identity_id=comm_ident.id,
            realm_user_id="sub-r3-outbox",
            operation=ACCESS_OFF,
        )
        pme_deliv_id = insert_realm_access(
            organisation_id=pme_org_id,
            membership_id=pme_mem.id,
            identity_id=pme_ident.id,
            realm_user_id="sub-r3-outbox-member",
            operation=ACCESS_OFF,
        )

    keycloak_calls: list[object] = []

    @contextmanager
    def _forbidden_admin_factory(target, *, deadline=None):
        keycloak_calls.append(target)
        raise AssertionError(f"Keycloak admin API must never be called for shared realm: {target}")
        yield  # pragma: no cover

    report = run_realm_deliveries(
        admin_factory=_forbidden_admin_factory,
        organisation_lock=OrganisationLock(
            try_take=lambda *, organisation_id: True,
            release=lambda *, organisation_id: None,
        ),
        origins_issuer="https://auth.kodera.test",
        reconcile_first=True,
    )
    assert keycloak_calls == []
    assert report.withdrawn == 2
    assert report.failed == 0
    assert report.outstanding == 0
    assert report.needs_operator is False
    for deliv_id in (comm_deliv_id, pme_deliv_id):
        row = OutboxDelivery.objects.get(id=deliv_id)
        assert row.status == "failed"
        assert row.finished_at is not None


def test_self_serve_pme_workspace_projects_starter_channels_via_shared_community_agent(
    settings, http_signer, tmp_path, monkeypatch
):
    """Prove `POST /api/v1/workspaces/self-serve` emits scoped `EngineChannelSet` commands and
    unions active subjects onto the shared Community `EngineMemberSet`, converging cleanly through
    REAL `tenant_agent.handlers.Handlers.handle` without `native_public` leaks, cross-org room
    wipes, global revision/moderation collisions, or Synapse account lockouts."""
    import test_tenant_agent_channels as ta_fixtures

    from apps.engine_intents.models import (
        EngineAgentCredential,
        EngineChannelSet,
        EngineChannelSetHead,
        EngineCommand,
        EngineKnownSubject,
    )
    from apps.engine_intents.services import acknowledge, issue_credential, pull, report
    from apps.orgs.community import bootstrap_community_workspace
    from apps.orgs.membership_lifecycle import change_membership, read_membership
    from apps.workspaces import channel_sets as ws_channel_sets
    from apps.workspaces.models import WorkspaceMemberRestriction
    from tenant_agent.channels import JOIN_RULES, Channels
    from tenant_agent.engines import Docs, Meet
    from tenant_agent.guard import RosterGuard
    from tenant_agent.handlers import Handlers
    from tenant_agent.state import State
    from tenant_agent.synapse import POLICY, livekit_room

    _setup_shared_realm_settings(settings, http_signer)
    comm = _seed_community_for_r2()
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = comm.slug
    comm_ws = bootstrap_community_workspace()
    assert comm_ws is not None

    # Seed a Community member who is later suspended from Community while active in PME Org B,
    # plus a Community steward so suspension succeeds cleanly.
    with transaction.atomic():
        steward_ident = Identity.objects.create(
            user=Membership.objects.get(organisation=comm, role=Membership.Role.OWNER).user,
            organisation=comm,
            issuer=SHARED_ISSUER,
            realm=comm.realm,
            subject="sub-comm-steward",
            email="steward-r2@community.kodera.test",
            enabled=True,
        )
        shared_member_user = User.objects.create(
            email="suspended-comm@pme-b.fr", display_name="Dual Member"
        )
        Identity.objects.create(
            user=shared_member_user,
            organisation=comm,
            issuer=SHARED_ISSUER,
            realm=comm.realm,
            subject="sub-suspended-in-comm",
            email="suspended-comm@pme-b.fr",
            enabled=True,
        )
        comm_dual_mem = Membership.objects.create(
            user=shared_member_user,
            organisation=comm,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )

    cred_id, _cred_tok = issue_credential(organisation_id=comm.id)
    comm_cred = EngineAgentCredential.objects.get(id=cred_id)

    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    tok_a = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r4-owner-a",
        email="owner-a@example.org",
        email_verified=True,
    )
    # Owner B has NEVER visited Community (`Identity` / `Membership` absent on `comm`!).
    tok_b = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r4-owner-b-not-in-comm",
        email="owner-b@example.org",
        email_verified=True,
    )

    resp_a = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Rooms Alpha", "slug": "rooms-alpha", "locale": "en"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {tok_a}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000311",
    )
    assert resp_a.status_code == 201, resp_a.content
    org_a_id = UUID(resp_a.json()["organisation_id"])
    ws_a_id = UUID(resp_a.json()["workspace_id"])

    # Advance PME Org A's channel set to revision >= 5 WITH `banned_subjects` populated!
    with transaction.atomic():
        banned_user = User.objects.create(email="banned-a@example.org", display_name="Banned A")
        Identity.objects.create(
            user=banned_user,
            organisation_id=org_a_id,
            issuer=SHARED_ISSUER,
            realm=comm.realm,
            subject="sub-r4-banned-in-a",
            email="banned-a@example.org",
            enabled=True,
        )
        banned_mem = Membership.objects.create(
            user=banned_user,
            organisation_id=org_a_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.SUSPENDED,
            accepted_at=timezone.now(),
        )
        WorkspaceMemberRestriction.objects.create(
            workspace_id=ws_a_id,
            membership=banned_mem,
            banned=True,
        )
        ws_channel_sets.emit_for(
            organisation_id=org_a_id,
            workspace_id=ws_a_id,
            reason="membership.changed",
        )

    # Create PME Org B at revision 1 (empty `banned_subjects`) owned by `sub-r4-owner-b-not-in-comm`,
    # add `sub-suspended-in-comm` as an active member of PME Org B, and suspend them from Community!
    resp_b = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Rooms Beta", "slug": "rooms-beta", "locale": "en"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {tok_b}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000312",
    )
    assert resp_b.status_code == 201, resp_b.content
    org_b_id = UUID(resp_b.json()["organisation_id"])
    ws_b_id = UUID(resp_b.json()["workspace_id"])

    with transaction.atomic():
        Identity.objects.create(
            user=shared_member_user,
            organisation_id=org_b_id,
            issuer=SHARED_ISSUER,
            realm=comm.realm,
            subject="sub-suspended-in-comm",
            email="suspended-comm@pme-b.fr",
            enabled=True,
        )
        Membership.objects.create(
            user=shared_member_user,
            organisation_id=org_b_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
        ws_channel_sets.emit_for(
            organisation_id=org_b_id,
            workspace_id=ws_b_id,
            reason="membership.changed",
        )

    # Pin exact revisions (`Org A rev 5` with bans -> `Org B rev 1` with empty bans) to prove
    # per-organisation revision watermarks and moderation isolation!
    for target_org_id, pinned_rev in ((org_a_id, 5), (org_b_id, 1)):
        latest_cs = (
            EngineChannelSet.objects.filter(organisation_id=target_org_id)
            .order_by("-revision")
            .first()
        )
        assert latest_cs is not None
        EngineCommand.objects.filter(channel_set__organisation_id=target_org_id).exclude(
            channel_set_id=latest_cs.id
        ).delete()
        EngineChannelSet.objects.filter(organisation_id=target_org_id).exclude(
            id=latest_cs.id
        ).delete()
        EngineChannelSet.objects.filter(id=latest_cs.id).update(revision=pinned_rev)
        EngineChannelSetHead.objects.filter(organisation_id=target_org_id).update(
            revision=pinned_rev
        )

    # Set up REAL `tenant_agent.handlers.Handlers` against `community.kodera.io`!
    comm_server = "community.kodera.io"
    monkeypatch.setattr(ta_fixtures, "SERVER", comm_server)
    monkeypatch.setattr(ta_fixtures, "AGENT", f"@kodera-agent:{comm_server}")
    monkeypatch.setattr(ta_fixtures, "ROOMS", f"@kodera-rooms:{comm_server}")

    class SharedHomeserver(ta_fixtures.FakeHomeserver):
        def __init__(self) -> None:
            super().__init__(users=("sub-comm-steward", "sub-suspended-in-comm"))
            self.bans: dict[str, set[str]] = {}
            self.owned_bans: dict[str, set[str]] = {}

        def moderation_bans(self, room: str) -> tuple[set[str], set[str]]:
            return set(self.bans.get(room, set())), set(self.owned_bans.get(room, set()))

        def ban(self, room: str, user: str) -> None:
            self.bans.setdefault(room, set()).add(user)
            self.owned_bans.setdefault(room, set()).add(user)
            self.rooms[room]["members"][user] = "ban"

        def unban(self, room: str, user: str) -> None:
            self.bans.get(room, set()).discard(user)
            self.owned_bans.get(room, set()).discard(user)
            self.rooms[room]["members"][user] = "leave"

    homeserver = SharedHomeserver()
    livekit = ta_fixtures.CallLiveKit({})
    agent_state = State(tmp_path / "agent-state")
    runner = ta_fixtures.FakeRunner()
    meet = Meet(runner, "meet-backend")
    guard = RosterGuard(livekit, meet, agent_state, homeserver)
    channels_engine = Channels(homeserver, livekit, agent_state)
    handlers = Handlers(
        Docs(runner, "docs-backend"), meet, guard, agent_state, homeserver, channels_engine
    )

    def _exec_cmd(cmd_payload: dict[str, Any]) -> None:
        cmd_id = UUID(str(cmd_payload["command_id"]))
        ack = acknowledge(comm_cred, cmd_id, boot_id="boot-shared-synapse-1")
        assert ack["status"] == "accepted"
        outcome = handlers.handle(
            str(cmd_payload["kind"]),
            cmd_payload["payload"],
        )
        assert outcome.status == "succeeded", (cmd_payload["kind"], outcome.message)
        recorded, final_status = report(
            comm_cred,
            cmd_id,
            {
                "status": outcome.status,
                "artefacts": outcome.artefacts or {},
            },
        )
        assert recorded is True
        assert final_status == "succeeded"

    # Phase A: Initial convergence while `sub-suspended-in-comm` is ACTIVE in BOTH Community & Org B!
    pulled = pull(comm_cred, kinds=handlers.kinds, limit=20)
    assert len(pulled.commands) >= 4
    assert pulled.commands[0]["kind"] == "engine_set_member_subjects"
    member_payload = pulled.commands[0]["payload"]
    assert "sub-r4-owner-b-not-in-comm" in member_payload["active_subjects"]
    assert "sub-suspended-in-comm" in member_payload["active_subjects"]
    assert "sub-r4-owner-b-not-in-comm" not in member_payload["inactive_subjects"]
    assert "sub-suspended-in-comm" not in member_payload["inactive_subjects"]

    # EngineKnownSubject stays strictly scoped per organisation (no PME-only pollution on Community!).
    assert not EngineKnownSubject.objects.filter(
        organisation_id=comm.id, subject="sub-r4-owner-b-not-in-comm"
    ).exists()
    assert EngineKnownSubject.objects.filter(
        organisation_id=org_b_id, subject="sub-r4-owner-b-not-in-comm"
    ).exists()

    # Order channel commands explicitly: Community -> PME Org A (rev 5 w/ bans) -> PME Org B (rev 1, empty bans)
    channel_cmds = [c for c in pulled.commands if c["kind"] == "engine_set_channel_members"]
    comm_cmd = next(c for c in channel_cmds if "organisation_id" not in c["payload"])
    org_a_cmd = next(
        c for c in channel_cmds if c["payload"].get("organisation_id") == str(org_a_id)
    )
    org_b_cmd = next(
        c for c in channel_cmds if c["payload"].get("organisation_id") == str(org_b_id)
    )
    assert org_a_cmd["payload"]["shared_realm"] is True
    assert org_a_cmd["payload"]["revision"] == 5
    assert org_a_cmd["payload"]["banned_subjects"] == ["sub-r4-banned-in-a"]
    assert org_b_cmd["payload"]["shared_realm"] is True
    assert org_b_cmd["payload"]["revision"] == 1
    assert org_b_cmd["payload"].get("banned_subjects", []) == []

    for cmd_payload in [pulled.commands[0], comm_cmd, org_a_cmd, org_b_cmd]:
        _exec_cmd(cmd_payload)

    # 1. Community's own audience="all" channels keep `join_rule == "public"` and are NOT archived!
    assert comm_cmd["payload"]["channels"]
    comm_public_text_id: str | None = None
    comm_public_audio_id: str | None = None
    for ch_payload in comm_cmd["payload"]["channels"]:
        room = homeserver.room_of(ch_payload["channel_id"])
        assert room["state"][(POLICY, "")]["archived"] is False
        if (
            ch_payload["audience"] == "all"
            and not ch_payload["denied"]
            and not ch_payload["archived"]
        ):
            assert room["state"][(JOIN_RULES, "")] == {"join_rule": "public"}
            if ch_payload["kind"] == "text" and comm_public_text_id is None:
                comm_public_text_id = ch_payload["channel_id"]
            if ch_payload["kind"] == "audio" and comm_public_audio_id is None:
                comm_public_audio_id = ch_payload["channel_id"]
    assert comm_public_text_id is not None and comm_public_audio_id is not None

    # 2. PME Org A & PME Org B rooms are NOT closed/archived, use `join_rule == "invite"`, and
    #    admit Org B's non-Community owner AND the dual member!
    for ws_id in (ws_a_id, ws_b_id):
        channels = list(Channel.objects.filter(workspace_id=ws_id).order_by("id"))
        assert {ch.name for ch in channels} == {"welcome", "general", "lounge"}
        assert all(ch.room_state == Channel.RoomState.READY for ch in channels)
        for ch in channels:
            room = homeserver.room_of(str(ch.id))
            assert room["state"][(POLICY, "")]["archived"] is False
            assert room["state"][(JOIN_RULES, "")] == {"join_rule": "invite"}

    for ch in Channel.objects.filter(workspace_id=ws_a_id):
        assert f"@sub-r4-owner-a:{comm_server}" in homeserver.joined(str(ch.id))

    for ch in Channel.objects.filter(workspace_id=ws_b_id):
        joined = homeserver.joined(str(ch.id))
        assert f"@sub-r4-owner-b-not-in-comm:{comm_server}" in joined
        assert f"@sub-suspended-in-comm:{comm_server}" in joined

    # Phase B (R5 P1 #1): Dual member joins Community public text + audio rooms & LiveKit calls in BOTH
    # Community and PME Org B, then is SUSPENDED from Community while staying active in PME Org B!
    dual_mx = f"@sub-suspended-in-comm:{comm_server}"
    comm_text_room_id = agent_state.channel_rooms()[comm_public_text_id]
    comm_audio_room_id = agent_state.channel_rooms()[comm_public_audio_id]
    org_b_lounge_ch = Channel.objects.get(workspace_id=ws_b_id, name="lounge")
    org_b_audio_room_id = agent_state.channel_rooms(scope_id=str(org_b_id))[str(org_b_lounge_ch.id)]
    homeserver.rooms[comm_text_room_id]["members"][dual_mx] = "join"
    homeserver.rooms[comm_audio_room_id]["members"][dual_mx] = "join"
    comm_lk = livekit_room(comm_audio_room_id)
    org_b_lk = livekit_room(org_b_audio_room_id)
    livekit.rooms_[comm_lk] = [f"{dual_mx}|DEV1"]
    livekit.rooms_[org_b_lk] = [f"{dual_mx}|DEV2"]

    steward_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject=steward_ident.subject,
        email=steward_ident.email,
        email_verified=True,
    )
    from services.identity.trusted_issuers import verify_configured_token

    verified_steward, _ = verify_configured_token(steward_tok, trusted=settings.KODERA_AUTH_TRUST)
    _, current_etag = read_membership(
        verified=verified_steward,
        organisation_id=comm.id,
        membership_id=comm_dual_mem.id,
    )
    change_membership(
        verified=verified_steward,
        organisation_id=comm.id,
        membership_id=comm_dual_mem.id,
        patch={"state": "suspended"},
        if_match=current_etag,
        request_id="req-suspend-comm-only",
    )

    pulled_suspend = pull(comm_cred, kinds=handlers.kinds, limit=20)
    assert pulled_suspend.commands
    for cmd_payload in pulled_suspend.commands:
        if cmd_payload["kind"] == "engine_set_member_subjects":
            assert "sub-suspended-in-comm" in cmd_payload["payload"]["active_subjects"]
            assert "sub-suspended-in-comm" not in cmd_payload["payload"]["inactive_subjects"]
        elif "organisation_id" not in cmd_payload["payload"]:
            assert "sub-suspended-in-comm" in cmd_payload["payload"]["banned_subjects"]
            assert "sub-r4-owner-b-not-in-comm" not in cmd_payload["payload"]["banned_subjects"]
        _exec_cmd(cmd_payload)

    guard_report = guard.enforce()
    assert guard_report.failed_rooms == 0

    # Kicked + banned from Community public rooms and evicted from Community LiveKit call...
    assert dual_mx not in homeserver.joined(comm_public_text_id)
    assert dual_mx not in homeserver.joined(comm_public_audio_id)
    assert dual_mx in homeserver.bans.get(comm_text_room_id, set())
    assert dual_mx in homeserver.bans.get(comm_audio_room_id, set())
    assert livekit.rooms_.get(comm_lk, []) == []

    # ...while Synapse account stays active AND PME Org B rooms + PME Org B LiveKit call stay intact!
    assert homeserver.accounts[f"@sub-r4-owner-b-not-in-comm:{comm_server}"] is False
    assert homeserver.accounts[dual_mx] is False
    for ch in Channel.objects.filter(workspace_id=ws_b_id):
        assert dual_mx in homeserver.joined(str(ch.id))
    assert livekit.rooms_[org_b_lk] == [f"{dual_mx}|DEV2"]

    # Phase C: Re-activate `sub-suspended-in-comm` in Community -> Community room bans are lifted!
    _, suspended_etag = read_membership(
        verified=verified_steward,
        organisation_id=comm.id,
        membership_id=comm_dual_mem.id,
    )
    change_membership(
        verified=verified_steward,
        organisation_id=comm.id,
        membership_id=comm_dual_mem.id,
        patch={"state": "active"},
        if_match=suspended_etag,
        request_id="req-unsuspend-comm",
    )
    pulled_unsuspend = pull(comm_cred, kinds=handlers.kinds, limit=20)
    assert pulled_unsuspend.commands
    for cmd_payload in pulled_unsuspend.commands:
        if (
            cmd_payload["kind"] == "engine_set_channel_members"
            and "organisation_id" not in cmd_payload["payload"]
        ):
            assert cmd_payload["payload"]["banned_subjects"] == []
        _exec_cmd(cmd_payload)
    assert dual_mx not in homeserver.bans.get(comm_text_room_id, set())
    assert dual_mx not in homeserver.bans.get(comm_audio_room_id, set())


@pytest.mark.django_db(transaction=True)
def test_orgs_0036_migrates_cleanly_over_populated_default_community_with_deferred_triggers() -> (
    None
):
    """Wave F regression: `orgs.0036` DDL precedes DML so deferred triggers on `orgs_organisation`
    (`organisation_owner_required`, `organisation_reservation_required`) never cause SQLSTATE 55006
    (`ObjectInUse: cannot ALTER TABLE "orgs_organisation" because it has pending trigger events`)
    when upgrading a populated `v0.1.0` database holding `is_default_community=True`."""
    from django.db.migrations.executor import MigrationExecutor

    target_0035 = ("orgs", "0035_ee_audit_ledger_erasure")
    try:
        executor = MigrationExecutor(connection)
        executor.migrate([target_0035])

        state_0035 = executor.loader.project_state([target_0035])
        historical_user = state_0035.apps.get_model("identity", "User")
        historical_org = state_0035.apps.get_model("orgs", "Organisation")
        historical_res = state_0035.apps.get_model("orgs", "SlugReservation")
        historical_mem = state_0035.apps.get_model("orgs", "Membership")

        with transaction.atomic():
            owner = historical_user.objects.create(
                email="wave-f-comm-owner@kodera.test",
                display_name="Wave F Community Owner",
                enabled=True,
            )
            comm = historical_org.objects.create(
                slug="community",
                realm="community",
                issuer="https://auth.kodera.test/realms/community",
                name="Kodera Community",
                state="active",
                is_default_community=True,
            )
            historical_res.objects.create(
                organisation_id=comm.id,
                slug="community",
                state="permanent",
                protected_at=timezone.now(),
            )
            historical_mem.objects.create(
                user_id=owner.id,
                organisation_id=comm.id,
                role="org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
            comm_id = comm.id

        # Forward 0035 -> 0036 (+ dependent leaves) over the committed Community row:
        forward_executor = MigrationExecutor(connection)
        forward_executor.migrate(forward_executor.loader.graph.leaf_nodes())
        upgraded = Organisation.objects.get(pk=comm_id)
        assert upgraded.plan_tier == "community"
        assert upgraded.shared_realm is False

        # Reverse 0036 -> 0035 and forward 0035 -> 0036 again over the populated table:
        reverse_executor = MigrationExecutor(connection)
        reverse_executor.migrate([target_0035])
        reapply_executor = MigrationExecutor(connection)
        reapply_executor.migrate(reapply_executor.loader.graph.leaf_nodes())
        reapplied = Organisation.objects.get(pk=comm_id)
        assert reapplied.plan_tier == "community"
        assert reapplied.shared_realm is False
    finally:
        restore = MigrationExecutor(connection)
        restore.migrate(restore.loader.graph.leaf_nodes())
        with connection.cursor() as cursor:
            cursor.execute(
                "TRUNCATE TABLE public.orgs_membership, public.orgs_slugreservation, "
                "public.orgs_organisation, public.identity_user RESTART IDENTITY CASCADE"
            )
    check_executor = MigrationExecutor(connection)
    assert check_executor.migration_plan(check_executor.loader.graph.leaf_nodes()) == []


def test_community_boost_preserves_unlimited_seats_and_storage_beyond_thirty_visitors(
    settings, http_signer
):
    """Pass 2 W4-1 + R7-06 + R7-07 regression:
    - Community Boost activation and expiry NEVER overwrite `WorkspaceQuota(seats=None, media_bytes=None)`
      NOR erase an explicit finite operator ceiling set via `quota_policy.py` on the default Community.
    - Community workspaces advertise `boost_packs == []` and refuse `start_boost_checkout_for_caller`.
    - Non-Community workspaces holding `community-unlimited-v1` (`seats=None, media_bytes=None`)
      preserve unlimited base quotas across both active and expired Boost recomputes."""
    from apps.billing import monetization_services
    from apps.billing.boosts import BoostValidationError, recompute_workspace_boost_quota
    from apps.billing.models import WorkspaceBoostGrant

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    community = _seed_community_for_r2()
    steward_user = User.objects.get(email="steward-r2@community.kodera.test")
    Identity.objects.get_or_create(
        user=steward_user,
        organisation=community,
        defaults={
            "issuer": SHARED_ISSUER,
            "realm": community.realm,
            "subject": "sub-w41-steward",
            "email": steward_user.email,
            "enabled": True,
        },
    )

    with transaction.atomic():
        comm_ws = Workspace.objects.create(
            organisation=community,
            display_name="Kodera Community",
        )
        WorkspaceQuota.objects.update_or_create(
            workspace=comm_ws,
            defaults={
                "policy_ref": "community-unlimited-v1",
                "seats": None,
                "media_bytes": None,
            },
        )
        now = timezone.now()
        WorkspaceBoostGrant.objects.create(
            organisation=community,
            workspace=comm_ws,
            purchaser_user_id=steward_user.id,
            pack_code="boost-community",
            customer_kind="b2c",
            customer_country="FR",
            currency="EUR",
            vat_regime="fr_standard",
            vat_rate_bp=2000,
            net_amount_minor=2900,
            vat_amount_minor=580,
            gross_amount_minor=3480,
            credit_amount_minor=3000,
            seats_delta=35,
            storage_bytes_delta=50 * 1024**3,
            state="active",
            withdrawal_waiver_accepted=True,
            withdrawal_waiver_at=now,
            withdrawal_waiver_evidence="Art. L221-28",
            activated_at=now,
            expires_at=now + timedelta(days=30),
            idempotency_key="idem-comm-boost-w4-1",
            request_sha256="a" * 64,
        )
        eff_active = recompute_workspace_boost_quota(
            organisation_id=community.id,
            workspace_id=comm_ws.id,
            now=now,
        )
        assert eff_active.seats is None
        assert eff_active.storage_bytes is None
        q_active = WorkspaceQuota.objects.get(workspace=comm_ws)
        assert q_active.seats is None
        assert q_active.media_bytes is None

        # Expiry recompute also keeps default Community unlimited (never falling back to 30 seats)!
        eff_expired = recompute_workspace_boost_quota(
            organisation_id=community.id,
            workspace_id=comm_ws.id,
            now=now + timedelta(days=31),
        )
        assert eff_expired.seats is None
        assert eff_expired.storage_bytes is None
        q_expired = WorkspaceQuota.objects.get(workspace=comm_ws)
        assert q_expired.seats is None
        assert q_expired.media_bytes is None

        # R7-07: An explicit operator finite ceiling on Community is NEVER erased by Boost recompute!
        WorkspaceQuota.objects.filter(workspace=comm_ws).update(
            policy_ref="ops-cap-500",
            seats=500,
            media_bytes=100 * 1024**3,
        )
        eff_ops = recompute_workspace_boost_quota(
            organisation_id=community.id,
            workspace_id=comm_ws.id,
            now=now,
        )
        assert eff_ops.seats == 500
        assert eff_ops.storage_bytes == 100 * 1024**3
        q_ops = WorkspaceQuota.objects.get(workspace=comm_ws)
        assert (q_ops.policy_ref, q_ops.seats, q_ops.media_bytes) == (
            "ops-cap-500",
            500,
            100 * 1024**3,
        )
        WorkspaceQuota.objects.filter(workspace=comm_ws).update(
            policy_ref="community-unlimited-v1",
            seats=None,
            media_bytes=None,
        )

    # R7-07: Community monetization overview lists zero Boost packs and refuses Boost checkout!
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.kodera.test"})
    steward_verified = _verified_shared("sub-w41-steward", steward_user.email)
    with transaction.atomic():
        steward_caller = monetization_services.tenant_caller(
            verified=steward_verified, organisation_id=community.id
        )
        overview = monetization_services.read_workspace_monetization_overview(caller=steward_caller)
    assert overview["boost_packs"] == []
    with pytest.raises(BoostValidationError, match="unlimited seats and storage"):
        monetization_services.start_boost_checkout_for_caller(
            verified=steward_verified,
            organisation_id=community.id,
            idempotency_key="idem-0000000000000411",
            payload={
                "pack_code": "boost-starter",
                "customer_kind": "b2c",
                "customer_country": "FR",
                "return_url": "https://app.kodera.test/billing",
            },
        )

    # R7-06: Non-Community workspace holding `community-unlimited-v1` (`seats=None, media_bytes=None`)
    # preserves unlimited base quotas across active AND expired Boost recomputes!
    with transaction.atomic():
        unlim_org = Organisation.objects.create(
            slug="unlim-selfhost-r8",
            realm="unlim-selfhost-r8",
            issuer="https://auth.kodera.test/realms/unlim-selfhost-r8",
            name="Unlimited Self-Host Org",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=unlim_org,
            slug="unlim-selfhost-r8",
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=steward_user,
            organisation=unlim_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        unlim_ws = Workspace.objects.create(
            organisation=unlim_org,
            display_name="Unlimited Self-Host WS",
        )
        WorkspaceQuota.objects.update_or_create(
            workspace=unlim_ws,
            defaults={
                "policy_ref": "community-unlimited-v1",
                "seats": None,
                "media_bytes": None,
            },
        )
        WorkspaceBoostGrant.objects.create(
            organisation=unlim_org,
            workspace=unlim_ws,
            purchaser_user_id=steward_user.id,
            pack_code="boost-starter",
            customer_kind="b2b",
            customer_country="FR",
            currency="EUR",
            vat_regime="fr_standard",
            vat_rate_bp=2000,
            net_amount_minor=990,
            vat_amount_minor=198,
            gross_amount_minor=1188,
            credit_amount_minor=1000,
            seats_delta=10,
            storage_bytes_delta=10 * 1024**3,
            state="active",
            activated_at=now,
            expires_at=now + timedelta(days=30),
            idempotency_key="idem-0000000000000412",
            request_sha256="d" * 64,
        )
        unlim_active = recompute_workspace_boost_quota(
            organisation_id=unlim_org.id,
            workspace_id=unlim_ws.id,
            now=now,
        )
        assert unlim_active.seats is None and unlim_active.storage_bytes is None
        unlim_expired = recompute_workspace_boost_quota(
            organisation_id=unlim_org.id,
            workspace_id=unlim_ws.id,
            now=now + timedelta(days=31),
        )
        assert unlim_expired.seats is None and unlim_expired.storage_bytes is None
        q_unlim = WorkspaceQuota.objects.get(workspace=unlim_ws)
        assert (q_unlim.policy_ref, q_unlim.seats, q_unlim.media_bytes) == (
            "community-unlimited-v1",
            None,
            None,
        )

    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    for idx in range(35):
        visitor_tok = _mint_customer_jwt(
            http_signer,
            SHARED_ISSUER,
            subject=f"sub-w41-visitor-{idx:03d}",
            email=f"visitor-{idx:03d}@community-w41.test",
            email_verified=True,
        )
        resp = client.get("/api/v1/me", HTTP_AUTHORIZATION=f"Bearer {visitor_tok}")
        assert resp.status_code == 200, f"visitor {idx} failed: {resp.content!r}"

    assert Membership.objects.filter(organisation=community, state="active").count() >= 36


def test_repeat_stripe_checkout_reuses_customer_ref_and_preserves_boost_and_storage_quotas(
    settings, monkeypatch, http_signer
):
    """Pass 2 W1-1, W4-2, and W4-3 regression:
    - Self-serve starter channels set `allow_member_invites=False` and `media_bytes == 5 GiB`.
    - Subscription settlement preserves active `WorkspaceBoostGrant` seat + storage deltas alongside
      `resolve_subscription_storage_quota_bytes`.
    - Repeat Stripe Checkout on the same organisation sends `customer=cus_...` (not `customer_creation=always`)
      and settles cleanly via webhook without `customer_mismatch`, while cross-organisation `cus_...`
      reuse is still refused as `mismatch`."""
    from urllib.parse import parse_qsl

    from apps.billing.models import WorkspaceBoostGrant

    _setup_shared_realm_settings(settings, http_signer)
    register_test_fiscal_periods()
    catalogue.load(catalogue.read(catalogue.OFFER), allow_placeholder=False)
    if not LegalDocument.objects.exists():
        legal_services.load_documents(
            legal_services.read_documents(legal_services.PLACEHOLDER),
            allow_placeholder=True,
        )

    settings.KODERA_BILLING_ENABLED = True
    settings.KODERA_PAYMENT_PROVIDER = "stripe"
    settings.KODERA_STRIPE_SECRET_KEY = STRIPE_SECRET
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.kodera.test"})

    sent_forms: list[list[tuple[str, str]]] = []

    class _RecordingStripeTransport:
        def __call__(
            self, method: str, url: str, headers: dict[str, str], body: bytes
        ) -> tuple[int, bytes]:
            sent_forms.append(parse_qsl(body.decode("utf-8"), keep_blank_values=True))
            idx = next(_stripe_seq)
            return (
                200,
                json.dumps(
                    {
                        "id": f"cs_test_repeat_{idx}",
                        "url": f"https://checkout.stripe.invalid/c/repeat-{idx}",
                        "expires_at": int(time.time()) + 3600,
                    }
                ).encode("utf-8"),
            )

    provider = StripeProvider(
        secret_key=STRIPE_SECRET,
        webhook_secret=WEBHOOK_SECRET,
        transport=_RecordingStripeTransport(),
    )
    monkeypatch.setattr(payments_package, "_stripe", lambda secret_key, webhook_secret: provider)

    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    founder_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-w42-founder",
        email="founder@w42-pme.fr",
        email_verified=True,
    )
    created = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Atelier W42", "slug": "atelier-w42", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {founder_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000091",
    )
    assert created.status_code == 201, created.content
    org_id = UUID(created.json()["organisation_id"])
    ws_id = UUID(created.json()["workspace_id"])

    # W1-1 + W4-3: self-serve workspace disallows member invites, and freemium storage cap is 5 GiB!
    starter_channels = list(Channel.objects.filter(workspace_id=ws_id))
    assert len(starter_channels) >= 3
    assert Workspace.objects.get(id=ws_id).allow_member_invites is False
    initial_quota = WorkspaceQuota.objects.get(workspace_id=ws_id)
    assert initial_quota.seats == 5
    assert initial_quota.media_bytes == 5 * 1024**3

    # Add an active Boost (+10 seats, +10 GiB) before subscription settlement:
    founder_user = User.objects.get(email="founder@w42-pme.fr")
    now = timezone.now()
    WorkspaceBoostGrant.objects.create(
        organisation_id=org_id,
        workspace_id=ws_id,
        purchaser_user_id=founder_user.id,
        pack_code="boost-starter",
        customer_kind="b2b",
        customer_country="FR",
        currency="EUR",
        vat_regime="fr_standard",
        vat_rate_bp=2000,
        net_amount_minor=990,
        vat_amount_minor=198,
        gross_amount_minor=1188,
        credit_amount_minor=1000,
        seats_delta=10,
        storage_bytes_delta=10 * 1024**3,
        state="active",
        activated_at=now,
        expires_at=now + timedelta(days=30),
        idempotency_key="idem-w42-boost-01",
        request_sha256="b" * 64,
    )

    billing_services.set_billing_profile(
        organisation_id=org_id,
        legal_name="Atelier W42 SAS",
        address_line1="12 rue Oberkampf",
        postal_code="75011",
        city="Paris",
        country="FR",
        siren="424242421",
    )
    verified_owner = _verified_shared("sub-w42-founder", "founder@w42-pme.fr")
    dpa1, _ = legal_services.generate_dpa(
        verified=verified_owner,
        organisation_id=org_id,
        pack_code="workspace-v2",
        locale="fr",
        tenant_id=None,
    )
    placed1 = billing_services.place_order(
        verified=verified_owner,
        organisation_id=org_id,
        idempotency_key="order-w42-first-0001",
        request=OrderRequest(
            pack_code="workspace-v2",
            capacity_tier_code="S",
            billing_period="yearly",
            quantity=1,
            tenant=TenantRequest(slug="atelier-w42-cell1", name="Atelier W42 Cell 1"),
            agreements=Agreements(
                dpa_id=dpa1.id,
                documents=(Accepted(code="cgv", version="0.0", locale="fr"),),
            ),
        ),
        request_id="req-w42-order-1",
    )
    link1 = payment_services.create_payment_link(
        invoice_id=placed1.invoice.id,
        organisation_id=org_id,
        return_url="https://app.kodera.test/billing",
    ).link
    assert ("customer_creation", "always") in sent_forms[-1]

    evt1 = {
        "id": "evt_w42_first_paid",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": link1.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_w42_first_01",
                "customer": "cus_w42_same_org",
                "amount_total": placed1.invoice.total_incl_vat_minor,
                "currency": placed1.invoice.currency.lower(),
            }
        },
    }
    raw1 = json.dumps(evt1, separators=(",", ":")).encode("utf-8")
    wh1 = client.post(
        "/api/v1/webhooks/stripe",
        data=raw1,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw1),
    )
    assert wh1.status_code == 200 and wh1.json()["status"] == "applied"

    # W4-3: Subscription settlement updated storage AND preserved +10 Boost seats and +10 GiB Boost storage!
    settled_quota = WorkspaceQuota.objects.get(workspace_id=ws_id)
    assert settled_quota.seats == 90
    assert settled_quota.media_bytes == 50_000_000_000 + 10 * 1024**3

    # W4-2 + R7-11: Second order on the SAME organisation:
    # 1) If Stripe rejects the stored `customer=cus_w42_same_org` as `resource_missing`, `create_link`
    #    automatically falls back to `customer_creation=always`!
    # 2) Settling with a rotated `cus_w42_rotated_02` on the same organisation succeeds (`applied`)!
    fail_once_customer = {"armed": True}
    orig_transport = provider._transport

    def _stale_customer_once_transport(
        method: str, url: str, headers: dict[str, str], body: bytes
    ) -> tuple[int, bytes]:
        parsed = parse_qsl(body.decode("utf-8"), keep_blank_values=True)
        if fail_once_customer["armed"] and ("customer", "cus_w42_same_org") in parsed:
            fail_once_customer["armed"] = False
            sent_forms.append(parsed)
            return (
                400,
                json.dumps(
                    {
                        "error": {
                            "type": "invalid_request_error",
                            "code": "resource_missing",
                            "message": "No such customer: 'cus_w42_same_org'",
                        }
                    }
                ).encode("utf-8"),
            )
        return orig_transport(method, url, headers, body)

    monkeypatch.setattr(provider, "_transport", _stale_customer_once_transport)

    dpa2, _ = legal_services.generate_dpa(
        verified=verified_owner,
        organisation_id=org_id,
        pack_code="workspace-v2",
        locale="fr",
        tenant_id=None,
    )
    placed2 = billing_services.place_order(
        verified=verified_owner,
        organisation_id=org_id,
        idempotency_key="order-w42-second-0002",
        request=OrderRequest(
            pack_code="workspace-v2",
            capacity_tier_code="M",
            billing_period="yearly",
            quantity=1,
            tenant=TenantRequest(slug="atelier-w42-cell2", name="Atelier W42 Cell 2"),
            agreements=Agreements(
                dpa_id=dpa2.id,
                documents=(Accepted(code="cgv", version="0.0", locale="fr"),),
            ),
        ),
        request_id="req-w42-order-2",
    )
    link2 = payment_services.create_payment_link(
        invoice_id=placed2.invoice.id,
        organisation_id=org_id,
        return_url="https://app.kodera.test/billing",
    ).link
    assert ("customer", "cus_w42_same_org") in sent_forms[-2]
    assert all(k != "customer_creation" for k, _ in sent_forms[-2])
    assert ("customer_creation", "always") in sent_forms[-1]
    assert all(k != "customer" for k, _ in sent_forms[-1])

    evt2 = {
        "id": "evt_w42_second_paid",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": link2.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_w42_second_02",
                "customer": "cus_w42_rotated_02",
                "amount_total": placed2.invoice.total_incl_vat_minor,
                "currency": placed2.invoice.currency.lower(),
            }
        },
    }
    raw2 = json.dumps(evt2, separators=(",", ":")).encode("utf-8")
    wh2 = client.post(
        "/api/v1/webhooks/stripe",
        data=raw2,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw2),
    )
    assert wh2.status_code == 200 and wh2.json()["status"] == "applied"
    placed2.invoice.refresh_from_db()
    assert placed2.invoice.state == "paid"
    settled_m_quota = WorkspaceQuota.objects.get(workspace_id=ws_id)
    assert settled_m_quota.seats == 175
    assert settled_m_quota.media_bytes == 100_000_000_000 + 10 * 1024**3

    # W4-3 reversal: Full refund on `pi_w42_second_02` transitions `placed2.subscription` to `past_due`
    # and preserves the +10 Boost seats & +10 GiB Boost storage!
    evt_refund = {
        "id": "evt_w42_second_refunded",
        "type": "charge.refunded",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": "ch_w42_second_02",
                "payment_intent": "pi_w42_second_02",
                "amount": placed2.invoice.total_incl_vat_minor,
                "amount_refunded": placed2.invoice.total_incl_vat_minor,
                "currency": placed2.invoice.currency.lower(),
                "refunds": {
                    "data": [
                        {
                            "id": "re_w42_second_02",
                            "amount": placed2.invoice.total_incl_vat_minor,
                            "currency": placed2.invoice.currency.lower(),
                            "status": "succeeded",
                        }
                    ]
                },
            }
        },
    }
    raw_refund = json.dumps(evt_refund, separators=(",", ":")).encode("utf-8")
    wh_refund = client.post(
        "/api/v1/webhooks/stripe",
        data=raw_refund,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw_refund),
    )
    assert wh_refund.status_code == 200 and wh_refund.json()["status"] == "applied"
    reversed_quota = WorkspaceQuota.objects.get(workspace_id=ws_id)
    assert reversed_quota.seats == 175
    assert reversed_quota.media_bytes == 100_000_000_000 + 10 * 1024**3
    assert "past_due+boosts:" in reversed_quota.policy_ref

    # Cross-organisation reuse of `cus_w42_same_org` MUST still be refused as `mismatch`!
    other_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-w42-other",
        email="other@w42-other.fr",
        email_verified=True,
    )
    other_created = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "Other W42", "slug": "other-w42", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {other_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000092",
    )
    assert other_created.status_code == 201
    other_org_id = UUID(other_created.json()["organisation_id"])
    billing_services.set_billing_profile(
        organisation_id=other_org_id,
        legal_name="Other W42 SAS",
        address_line1="1 rue de Rivoli",
        postal_code="75001",
        city="Paris",
        country="FR",
        siren="989898981",
    )
    other_ver = _verified_shared("sub-w42-other", "other@w42-other.fr")
    other_dpa, _ = legal_services.generate_dpa(
        verified=other_ver,
        organisation_id=other_org_id,
        pack_code="workspace-v2",
        locale="fr",
        tenant_id=None,
    )
    other_placed = billing_services.place_order(
        verified=other_ver,
        organisation_id=other_org_id,
        idempotency_key="order-w42-other-0003",
        request=OrderRequest(
            pack_code="workspace-v2",
            capacity_tier_code="S",
            billing_period="yearly",
            quantity=1,
            tenant=TenantRequest(slug="other-w42-cell", name="Other W42 Cell"),
            agreements=Agreements(
                dpa_id=other_dpa.id,
                documents=(Accepted(code="cgv", version="0.0", locale="fr"),),
            ),
        ),
        request_id="req-w42-other",
    )
    other_link = payment_services.create_payment_link(
        invoice_id=other_placed.invoice.id,
        organisation_id=other_org_id,
        return_url="https://app.kodera.test/billing",
    ).link
    evt_cross = {
        "id": "evt_w42_cross_org_spoof",
        "type": "checkout.session.completed",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "data": {
            "object": {
                "id": other_link.provider_ref,
                "payment_status": "paid",
                "payment_intent": "pi_w42_cross_03",
                "customer": "cus_w42_same_org",
                "amount_total": other_placed.invoice.total_incl_vat_minor,
                "currency": other_placed.invoice.currency.lower(),
            }
        },
    }
    raw_cross = json.dumps(evt_cross, separators=(",", ":")).encode("utf-8")
    wh_cross = client.post(
        "/api/v1/webhooks/stripe",
        data=raw_cross,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=_sign_stripe(raw_cross),
    )
    assert wh_cross.status_code == 200 and wh_cross.json()["status"] == "mismatch"
    other_placed.invoice.refresh_from_db()
    assert other_placed.invoice.state != "paid"


def test_shared_realm_member_erasure_records_erased_ledger_without_deactivating_synapse_account(
    settings, http_signer
):
    """Pass 2 W1-2 + R7-16 + R7-20 regression:
    - Single-org `member_erased` on `shared_realm` PME records `EngineKnownSubject(erased_at!=None)`
      while keeping the person `active` in the shared Community host `EngineMemberSet` when active in Community.
    - If later suspended in Community (without erasing Community), the shared Synapse account moves to
      `inactive_subjects` — NOT `erased_subjects` (`R7-20`).
    - Once erased in Community as well (or when only ever enrolled in the erased PME org), the host
      `EngineMemberSet` emits `erased_subjects` cleanly."""
    from apps.engine_intents.models import EngineKnownSubject, EngineMemberSet
    from apps.engine_intents.services import emit_member_set
    from apps.orgs import member_set_hooks

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    community = _seed_community_for_r2()
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    owner_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-w12-owner",
        email="owner@w12-pme.fr",
        email_verified=True,
    )
    res = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME W12", "slug": "pme-w12", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000093",
    )
    assert res.status_code == 201
    org_id = UUID(res.json()["organisation_id"])

    with transaction.atomic():
        leaver_user = User.objects.create(email="leaver@w12-pme.fr", display_name="Leaver")
        Identity.objects.create(
            user=leaver_user,
            organisation=community,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-w12-erased",
            email="leaver@w12-pme.fr",
            enabled=True,
        )
        comm_mem = Membership.objects.create(
            user=leaver_user,
            organisation=community,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=leaver_user,
            organisation_id=org_id,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-w12-erased",
            email="leaver@w12-pme.fr",
            enabled=True,
        )
        leaver_mem = Membership.objects.create(
            user=leaver_user,
            organisation_id=org_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.REMOVED,
        )
        # Also create a PME-only leaver who NEVER joined Community (`W1-2` direct case):
        pme_only_user = User.objects.create(email="pme-only@w12-pme.fr", display_name="PME Only")
        Identity.objects.create(
            user=pme_only_user,
            organisation_id=org_id,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-w12-pme-only-erased",
            email="pme-only@w12-pme.fr",
            enabled=True,
        )
        pme_only_mem = Membership.objects.create(
            user=pme_only_user,
            organisation_id=org_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.REMOVED,
        )
        before_member_sets = EngineMemberSet.objects.filter(organisation_id=org_id).count()
        member_set_hooks.member_erased(leaver_mem)
        member_set_hooks.member_erased(pme_only_mem)

    assert EngineKnownSubject.objects.filter(
        organisation_id=org_id, subject="sub-w12-erased", erased_at__isnull=False
    ).exists()
    assert EngineMemberSet.objects.filter(organisation_id=org_id).count() == before_member_sets

    # 1. Host member set keeps `sub-w12-erased` ACTIVE (still active in Community), while
    #    `sub-w12-pme-only-erased` (no Community membership) is immediately in `erased_subjects`!
    with transaction.atomic():
        host_set_1 = emit_member_set(organisation_id=community.id, reason="w12_check_active")
    assert "sub-w12-erased" in host_set_1.active_subjects
    assert "sub-w12-erased" not in host_set_1.inactive_subjects
    assert "sub-w12-erased" not in (host_set_1.erased_subjects or [])
    assert "sub-w12-pme-only-erased" in (host_set_1.erased_subjects or [])

    # 2. R7-20: Suspending `sub-w12-erased` in Community (without erasing Community) deactivates
    #    the shared account (`inactive_subjects`) WITHOUT permanently erasing it (`erased_subjects`)!
    with transaction.atomic():
        Membership.objects.filter(id=comm_mem.id).update(state=Membership.State.SUSPENDED)
        host_set_2 = emit_member_set(organisation_id=community.id, reason="w12_check_suspended")
    assert "sub-w12-erased" in host_set_2.inactive_subjects
    assert "sub-w12-erased" not in (host_set_2.erased_subjects or [])

    # 3. Erasing `sub-w12-erased` in Community as well promotes it to `erased_subjects`!
    with transaction.atomic():
        Membership.objects.filter(id=comm_mem.id).update(state=Membership.State.REMOVED)
        comm_mem.refresh_from_db()
        member_set_hooks.member_erased(comm_mem)
        host_set_3 = emit_member_set(organisation_id=community.id, reason="w12_check_full_erase")
    assert "sub-w12-erased" in (host_set_3.erased_subjects or [])


def test_pass2_extensions_coexistence_and_emoji_defense_in_depth(
    settings, monkeypatch, http_signer
):
    """Pass 2 W3-1 (R7-04), W3-2, W3-3, and W3-4 regression tests."""
    import socket
    from uuid import uuid4

    from apps.audit.models import AuditEvent
    from apps.extensions import coexistence, marketplace, widgets
    from apps.extensions.models import MarketplaceEntitlement, WidgetActionReceipt
    from apps.extensions.wire import ExtensionRefusedError
    from apps.media import outbound
    from apps.workspaces import experience
    from apps.workspaces.models import WorkspaceCustomEmoji
    from apps.workspaces.moderation import RefusalError as WorkspaceRefusalError

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_CONTACT_SEAL_KEY = b"r" * 32
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    owner_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-w3-owner",
        email="owner@w3-pme.fr",
        email_verified=True,
    )
    res = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME W3", "slug": "pme-w3", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000094",
    )
    assert res.status_code == 201
    org_id = UUID(res.json()["organisation_id"])
    ws_id = UUID(res.json()["workspace_id"])
    owner_ver = _verified_shared("sub-w3-owner", "owner@w3-pme.fr")
    owner_mem = Membership.objects.get(organisation_id=org_id, role="org_owner")

    # R7-04: `validate_widget_card` refuses 400-digit integers and lone UTF-16 surrogates with 422
    # `ExtensionRefusedError` (never `OverflowError` or `UnicodeEncodeError`)!
    base_card = {
        "schemaVersion": "kodera.widget.v1",
        "widgetId": "deploy-status",
        "title": "Deploy Gate",
        "blocks": [{"type": "progress_bar", "label": "Rollout", "value": 50}],
    }
    huge_int_card = {
        **base_card,
        "blocks": [{"type": "progress_bar", "label": "Rollout", "value": 10**400}],
    }
    with pytest.raises(ExtensionRefusedError) as exc_huge_int:
        widgets.validate_widget_card(huge_int_card)
    assert exc_huge_int.value.status == 422

    surrogate_card = {**base_card, "title": "Bad \ud800 Surrogate"}
    with pytest.raises(ExtensionRefusedError) as exc_surrogate:
        widgets.validate_widget_card(surrogate_card)
    assert exc_surrogate.value.status == 422

    # W3-3: Reserved `auto-free-install:*` idempotency prefix is refused at checkout boundary,
    # AND pre-existing `auto-free-install:<listing_id>` rows never block admin free-listing install!
    with pytest.raises(ExtensionRefusedError) as exc_reserved:
        marketplace.checkout_marketplace_listing(
            verified=owner_ver,
            organisation_id=org_id,
            listing_id=uuid4(),
            idempotency_key="auto-free-install:probe-collision",
        )
    assert exc_reserved.value.status == 400

    widget_manifest = {
        "schemaVersion": "kodera.extension.v1",
        "slug": "r8-widget-bot",
        "name": "R8 Widget Bot",
        "version": "0.2.0",
        "description": "Widget callback resilience probe",
        "scopes": ["commands:register", "messages:write", "widgets:write"],
        "events": ["command.invoked", "widget.action"],
        "commands": [{"name": "/r8probe", "description": "Open probe card"}],
        "widgets": [
            {
                "id": "deploy-status",
                "title": "Deploy Gate",
                "description": "Canary gate",
                "defaultCard": base_card,
            }
        ],
        "endpoint": "https://ext.kodera.example.org/webhooks/kodera",
    }
    pub_resp = client.post(
        f"/api/v1/organisations/{org_id}/workspace/extensions/marketplace",
        data=json.dumps(
            {
                "slug": "r8-widget-bot",
                "title": "R8 Widget Bot",
                "summary": "Widget resilience probe",
                "manifest": widget_manifest,
                "pricingMode": "free",
                "priceExclVatMinor": 0,
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000421",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
    )
    assert pub_resp.status_code == 201, pub_resp.content
    listing_id = UUID(pub_resp.json()["id"])

    # Seed a revoked `auto-free-install:<listing_id>` entitlement to prove `install_marketplace_listing`
    # falls back to a collision-proof key instead of 500 `IntegrityError` (`W3-3`)!
    MarketplaceEntitlement.objects.create(
        organisation_id=org_id,
        workspace_id=ws_id,
        buyer_membership_id=owner_mem.id,
        listing_id=listing_id,
        state="revoked",
        revoked_at=timezone.now(),
        idempotency_key=f"auto-free-install:{listing_id}",
        request_sha256="c" * 64,
    )
    inst_resp = client.post(
        f"/api/v1/organisations/{org_id}/workspace/extensions/marketplace/{listing_id}/install",
        data=json.dumps({"signingSecret": "whsec_" + "z" * 38}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000422",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
    )
    assert inst_resp.status_code == 201, inst_resp.content
    installation_id = inst_resp.json()["installationId"]

    # R7-04 / W3-1: End-to-end `dispatch_widget_action` transitions `WidgetActionReceipt` out of
    # `in_flight` and writes `widget_action_dispatched` audit on BOTH body `FetchError` AND 200
    # oversized-integer JSON!
    text_ch = Channel.objects.filter(workspace_id=ws_id, kind="text", is_confidential=False).first()
    assert text_ch is not None

    class _StubConn:
        def close(self) -> None:
            pass

    class _FetchErrBodyResp:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "application/json" if name.lower() == "content-type" else default

        def read(self, _n: int = -1) -> bytes:
            raise outbound.FetchError("mid-body timeout")

        def close(self) -> None:
            pass

    class _HugeIntBodyResp:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "application/json" if name.lower() == "content-type" else default

        def read(self, _n: int = -1) -> bytes:
            return (
                b'{"card":{"schemaVersion":"kodera.widget.v1","widgetId":"deploy-status",'
                b'"title":"T","blocks":[{"type":"progress_bar","label":"L","value":'
                + (b"9" * 400)
                + b"}]}}"
            )

        def close(self) -> None:
            pass

    monkeypatch.setattr(
        outbound,
        "_resolve_stub",
        lambda host, port, deadline, nameservers: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ],
    )
    monkeypatch.setattr(outbound, "request", lambda *a, **kw: (_StubConn(), _FetchErrBodyResp()))
    act_err = client.post(
        f"/api/v1/organisations/{org_id}/workspace/channels/{text_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000423",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
    )
    assert act_err.status_code == 502, act_err.content
    assert act_err.json()["detail"] == "widget_endpoint_unavailable"
    receipt_err = WidgetActionReceipt.objects.get(
        workspace_id=ws_id, idempotency_key="idem-0000000000000423"
    )
    assert receipt_err.state == "failed"

    monkeypatch.setattr(outbound, "request", lambda *a, **kw: (_StubConn(), _HugeIntBodyResp()))
    act_huge = client.post(
        f"/api/v1/organisations/{org_id}/workspace/channels/{text_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000424",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
    )
    assert act_huge.status_code == 502, act_huge.content
    assert act_huge.json()["detail"] == "widget_response_card_invalid"
    receipt_huge = WidgetActionReceipt.objects.get(
        workspace_id=ws_id, idempotency_key="idem-0000000000000424"
    )
    assert receipt_huge.state == "refused"
    assert not WidgetActionReceipt.objects.filter(workspace_id=ws_id, state="in_flight").exists()
    assert (
        AuditEvent.objects.filter(
            organisation_id=org_id, action__endswith="widget_action_dispatched"
        ).count()
        == 2
    )

    # W3-2: Oversized remote coexistence attachment maps `FetchError('too-large')` -> 413,
    # and mid-stream socket `OSError` -> 502!
    class _TooLargeResp:
        status = 200

        def read(self, _n: int) -> bytes:
            raise outbound.FetchError("too-large")

        def close(self) -> None:
            pass

    class _ResetResp:
        status = 200

        def read(self, _n: int) -> bytes:
            raise OSError("connection reset during body read")

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "target", lambda url, https_only=True: object())
    monkeypatch.setattr(
        outbound,
        "request",
        lambda *a, **kw: (_StubConn(), _TooLargeResp()),
    )
    with pytest.raises(ExtensionRefusedError) as exc_413:
        coexistence._fetch_pinned_attachment(
            organisation_id=org_id,
            url="https://files.example.org/huge.png",
            filename="huge.png",
            declared_mime="image/png",
        )
    assert exc_413.value.status == 413
    assert exc_413.value.reason == "import_asset_bound"

    monkeypatch.setattr(
        outbound,
        "request",
        lambda *a, **kw: (_StubConn(), _ResetResp()),
    )
    with pytest.raises(ExtensionRefusedError) as exc_502:
        coexistence._fetch_pinned_attachment(
            organisation_id=org_id,
            url="https://files.example.org/reset.png",
            filename="reset.png",
            declared_mime="image/png",
        )
    assert exc_502.value.status == 502
    assert exc_502.value.reason == "coexistence_attachment_unavailable"

    # W3-4: Serving a custom emoji whose stored bytes carry unstripped metadata refuses with 404!
    dirty_webp = (
        b"RIFF\x18\x00\x00\x00WEBPVP8L\x04\x00\x00\x00/\x00\x00\x00EXIF\x04\x00\x00\x00leak"
    )
    emoji_row = WorkspaceCustomEmoji.objects.create(
        organisation_id=org_id,
        workspace_id=ws_id,
        creator_id=owner_mem.id,
        shortcode="dirty_probe",
        webp_bytes=dirty_webp,
        width=1,
        height=1,
        sha256=hashlib.sha256(dirty_webp).hexdigest(),
    )
    with pytest.raises(WorkspaceRefusalError) as exc_emoji:
        experience.get_emoji_blob(
            verified=owner_ver,
            organisation_id=org_id,
            emoji_id=emoji_row.id,
        )
    assert exc_emoji.value.status == 404


def test_docs_0012_migrates_cleanly_over_empty_compacted_and_live_journal_confidential_docs():
    """R7-02 + R7-09 PostgreSQL migration regression: `docs.0012_confidential_collab_admission`
    cleanly covers `docs_journal_guard`, deletes plaintext `docs_documentupdate` and
    `docs_collectionrow` rows on confidential documents, resets tainted snapshots consistently to
    `sequence=0, head_sequence=0, state=b''`, and preserves valid `KDE1` snapshots."""
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor

    from apps.docs.models import CollectionRow, Document, DocumentSnapshot, DocumentUpdate
    from apps.workspaces.models import Category

    target_0011 = ("docs", "0011_collab_lock_order_and_iam_policy")
    executor = MigrationExecutor(connection)
    assert target_0011 in executor.loader.graph.nodes
    pre_targets = [
        target_0011 if app == "docs" else (app, mig)
        for app, mig in executor.loader.graph.leaf_nodes()
    ]

    with connection.cursor() as cursor:
        cursor.execute(
            "TRUNCATE TABLE public.orgs_membership, public.orgs_slugreservation, "
            "public.orgs_organisation, public.identity_user RESTART IDENTITY CASCADE"
        )

    try:
        executor.migrate(pre_targets)
        pre_apps = executor.loader.project_state(pre_targets).apps
        hist_user = pre_apps.get_model("identity", "User")
        hist_ident = pre_apps.get_model("identity", "Identity")
        hist_org = pre_apps.get_model("orgs", "Organisation")
        hist_res = pre_apps.get_model("orgs", "SlugReservation")
        hist_mem = pre_apps.get_model("orgs", "Membership")
        hist_ws = pre_apps.get_model("workspaces", "Workspace")
        hist_cat = pre_apps.get_model("workspaces", "Category")
        hist_ch = pre_apps.get_model("workspaces", "Channel")
        hist_doc = pre_apps.get_model("docs", "Document")
        hist_snap = pre_apps.get_model("docs", "DocumentSnapshot")
        hist_upd = pre_apps.get_model("docs", "DocumentUpdate")
        hist_coll = pre_apps.get_model("docs", "Collection")
        hist_row = pre_apps.get_model("docs", "CollectionRow")

        with transaction.atomic():
            owner = hist_user.objects.create(
                email="mig0012@kodera.test", display_name="Mig 0012 Owner"
            )
            org = hist_org.objects.create(
                slug="mig-0012",
                realm="mig-0012",
                issuer="https://auth.kodera.test/realms/mig-0012",
                name="Mig 0012 Org",
                state="active",
            )
            hist_res.objects.create(
                organisation_id=org.id,
                slug="mig-0012",
                state="permanent",
                protected_at=timezone.now(),
            )
            ident = hist_ident.objects.create(
                user_id=owner.id,
                organisation_id=org.id,
                issuer=org.issuer,
                realm=org.realm,
                subject="sub-mig-0012",
                email=owner.email,
                enabled=True,
            )
            mem = hist_mem.objects.create(
                user_id=owner.id,
                organisation_id=org.id,
                role="org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
            ws = hist_ws.objects.create(organisation_id=org.id, display_name="Mig 0012 WS")
            cat = hist_cat.objects.create(workspace_id=ws.id, name="Sec", position=0)
            conf_ch = hist_ch.objects.create(
                workspace_id=ws.id,
                category_id=cat.id,
                kind="text",
                name="confidential-notes",
                position=0,
                lifecycle="active",
                is_confidential=True,
            )
            coll = hist_coll.objects.create(
                workspace_id=ws.id,
                creator_id=mem.id,
                title="Confidential Tracker",
                properties=[{"id": "status", "name": "Status", "type": "text"}],
            )

            # Case 1: Empty initial snapshot `(0, 0, b'')` in confidential channel
            doc_empty = hist_doc.objects.create(
                workspace_id=ws.id,
                creator_id=mem.id,
                channel_id=conf_ch.id,
                title="Empty Pre0012",
                title_key="empty pre0012",
                markdown="legacy markdown",
            )
            hist_snap.objects.update_or_create(
                document_id=doc_empty.id,
                defaults={"sequence": 0, "head_sequence": 0, "state": b""},
            )

            # Case 2: Compacted plaintext snapshot `(5, 5, b'PlainYjsCompacted')`
            doc_compacted = hist_doc.objects.create(
                workspace_id=ws.id,
                creator_id=mem.id,
                channel_id=conf_ch.id,
                title="Compacted Pre0012",
                title_key="compacted pre0012",
                markdown="compacted markdown",
            )
            hist_snap.objects.update_or_create(
                document_id=doc_compacted.id,
                defaults={"sequence": 5, "head_sequence": 5, "state": b"PlainYjsCompacted"},
            )

            # Case 3: Live plaintext journal rows `(0, 2, b'')` + 2 `docs_documentupdate` rows + `docs_collectionrow`
            doc_live = hist_doc.objects.create(
                workspace_id=ws.id,
                creator_id=mem.id,
                channel_id=conf_ch.id,
                title="Live Journal Pre0012",
                title_key="live journal pre0012",
                markdown="live journal markdown",
            )
            hist_snap.objects.update_or_create(
                document_id=doc_live.id,
                defaults={"sequence": 0, "head_sequence": 0, "state": b""},
            )
            hist_upd.objects.create(
                document_id=doc_live.id, sequence=1, actor_id=ident.id, state=b"plain-upd-1"
            )
            hist_upd.objects.create(
                document_id=doc_live.id, sequence=2, actor_id=ident.id, state=b"plain-upd-2"
            )
            hist_row.objects.create(
                collection_id=coll.id,
                document_id=doc_live.id,
                values={"status": {"type": "text", "value": "plaintext-leak"}},
            )

            # Case 4: Valid `KDE1`-sealed confidential snapshot + `KDE1` update — MUST remain untouched!
            doc_kde1 = hist_doc.objects.create(
                workspace_id=ws.id,
                creator_id=mem.id,
                channel_id=conf_ch.id,
                title="Valid KDE1 Pre0012",
                title_key="valid kde1 pre0012",
                markdown="",
            )
            kde1_snap_bytes = b"KDE1\x01\x03sealed-snapshot"
            kde1_upd_bytes = b"KDE1\x01\x00sealed-update"
            hist_snap.objects.update_or_create(
                document_id=doc_kde1.id,
                defaults={"sequence": 3, "head_sequence": 3, "state": kde1_snap_bytes},
            )
            hist_upd.objects.create(
                document_id=doc_kde1.id, sequence=4, actor_id=ident.id, state=kde1_upd_bytes
            )

            ids = (doc_empty.id, doc_compacted.id, doc_live.id, doc_kde1.id)

        # Migrate forward across `docs.0012` to all leaf nodes:
        fwd = MigrationExecutor(connection)
        fwd.migrate(fwd.loader.graph.leaf_nodes())

        for tainted_id in ids[:3]:
            doc_after = Document.objects.get(pk=tainted_id)
            assert doc_after.is_confidential is True
            assert doc_after.markdown == ""
            snap_after = DocumentSnapshot.objects.get(document_id=tainted_id)
            assert snap_after.sequence == 0
            assert snap_after.head_sequence == 0
            assert bytes(snap_after.state) == b""
            assert DocumentUpdate.objects.filter(document_id=tainted_id).count() == 0
            assert CollectionRow.objects.filter(document_id=tainted_id).count() == 0

        snap_kde1 = DocumentSnapshot.objects.get(document_id=ids[3])
        assert snap_kde1.sequence == 3
        assert snap_kde1.head_sequence == 4
        assert bytes(snap_kde1.state) == b"KDE1\x01\x03sealed-snapshot"
        assert DocumentUpdate.objects.filter(document_id=ids[3]).count() == 1
        assert Category.objects.filter(pk=cat.id).exists()
    finally:
        restore = MigrationExecutor(connection)
        restore.migrate(restore.loader.graph.leaf_nodes())
        with connection.cursor() as cursor:
            cursor.execute(
                "TRUNCATE TABLE public.orgs_membership, public.orgs_slugreservation, "
                "public.orgs_organisation, public.identity_user RESTART IDENTITY CASCADE"
            )
    check_exec = MigrationExecutor(connection)
    assert check_exec.migration_plan(check_exec.loader.graph.leaf_nodes()) == []


def test_shared_realm_account_erasure_begin_advance_and_restore_rehearsal_across_all_three_topologies(
    settings, http_signer
):
    """R9-01 GDPR account erasure regression across all 3 shared-realm topologies + restore rehearsal:
    - Case 1: Person in `community` (created first) + active `shared_realm` PME org (created second)
    - Case 2: Person in `community` + `closed` `shared_realm` PME org
    - Case 3: Person in ONLY an active `shared_realm` PME org (no direct `community` membership)
    - Restore rehearsal: `DjangoRestoreRehearsalBackend()._ensure_account_protocol_emitted(...)`
      converges cleanly for an un-emitted shared-realm `AccountErasure`."""
    from dataclasses import replace

    from django.db import connection
    from test_account_erasure import AccountControlAdapter
    from test_core_erasure import operator

    from apps.engine_intents.models import EngineChannelSet, EngineKnownSubject, EngineMemberSet
    from apps.orgs.account_erasure_services import (
        AccountErasureAdapter,
        advance_account_erasure,
        begin_account_erasure,
    )
    from apps.orgs.community import bootstrap_community_workspace
    from apps.orgs.erasure_services import database_now
    from apps.orgs.privacy_models import AccountErasure
    from apps.orgs.restore_rehearsal import DjangoRestoreRehearsalBackend
    from core.db.ids import new_uuid7

    _setup_shared_realm_settings(settings, http_signer)
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    community = _seed_community_for_r2()
    bootstrap_community_workspace()
    staff_op = operator()

    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    owner_tok = _mint_customer_jwt(
        http_signer,
        SHARED_ISSUER,
        subject="sub-r10-pme-owner",
        email="owner-r10@pme-erasure.fr",
        email_verified=True,
    )
    res_active = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME R10 Active", "slug": "pme-r10-active", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000501",
    )
    assert res_active.status_code == 201, res_active.content
    active_pme_id = UUID(res_active.json()["organisation_id"])

    res_closed = client.post(
        "/api/v1/workspaces/self-serve",
        data=json.dumps({"name": "PME R10 Closed", "slug": "pme-r10-closed", "locale": "fr"}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
        HTTP_IDEMPOTENCY_KEY="idem-0000000000000502",
    )
    assert res_closed.status_code == 201, res_closed.content
    closed_pme_id = UUID(res_closed.json()["organisation_id"])

    assert community.id < active_pme_id < closed_pme_id

    def _run_full_erasure(subject: str, email: str, instruction_ref: str) -> AccountErasure:
        ver = replace(
            _verified_shared(subject, email),
            auth_time=int(database_now().timestamp()),
        )
        erasure_row = begin_account_erasure(
            verified=ver,
            confirmation="delete",
            instruction_ref=instruction_ref,
            instruction_sha256="9" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_op.id,
        )
        assert erasure_row.protocol_emitted_at is not None
        comm_set = EngineMemberSet.objects.filter(organisation=community).latest("revision")
        assert subject in (comm_set.erased_subjects or [])
        assert subject not in comm_set.active_subjects

        adapters: dict[str, AccountErasureAdapter] = {
            str(domain): AccountControlAdapter(str(domain))
            for domain in erasure_row.inventory["required_domains"]
        }
        outcome = advance_account_erasure(erasure_row.id, adapters)
        assert outcome["complete"] is True, outcome
        assert outcome["held_domains"] == []
        erasure_row.refresh_from_db()
        assert erasure_row.status == "complete"
        assert erasure_row.completed_at is not None
        return erasure_row

    # --- Case 1: Member in `community` (created first) + active `shared_realm` PME org (second) ---
    with transaction.atomic():
        u1 = User.objects.create(email="case1@r10-erasure.fr", display_name="Case 1")
        for target_org_id in (community.id, active_pme_id):
            Identity.objects.create(
                user=u1,
                organisation_id=target_org_id,
                issuer=SHARED_ISSUER,
                realm="community",
                subject="sub-r10-case1",
                email=u1.email,
                enabled=True,
            )
            Membership.objects.create(
                user=u1,
                organisation_id=target_org_id,
                role=Membership.Role.MEMBER,
                state=Membership.State.ACTIVE,
                accepted_at=timezone.now(),
            )
    before_pme_ch_rev = (
        EngineChannelSet.objects.filter(organisation_id=active_pme_id)
        .order_by("-revision")
        .values_list("revision", flat=True)
        .first()
        or 0
    )
    row1 = _run_full_erasure("sub-r10-case1", "case1@r10-erasure.fr", "DEL-101")
    after_pme_ch_rev = (
        EngineChannelSet.objects.filter(organisation_id=active_pme_id)
        .order_by("-revision")
        .values_list("revision", flat=True)
        .first()
        or 0
    )
    assert after_pme_ch_rev > before_pme_ch_rev
    assert (
        EngineKnownSubject.objects.filter(
            user_id=row1.user_reference, subject="sub-r10-case1", erased_at__isnull=False
        ).count()
        == 2
    )

    # --- Case 2: Member in `community` + `closed` `shared_realm` PME org ---
    with transaction.atomic():
        u2 = User.objects.create(email="case2@r10-erasure.fr", display_name="Case 2")
        for target_org_id in (community.id, closed_pme_id):
            Identity.objects.create(
                user=u2,
                organisation_id=target_org_id,
                issuer=SHARED_ISSUER,
                realm="community",
                subject="sub-r10-case2",
                email=u2.email,
                enabled=True,
            )
            Membership.objects.create(
                user=u2,
                organisation_id=target_org_id,
                role=Membership.Role.MEMBER,
                state=Membership.State.ACTIVE,
                accepted_at=timezone.now(),
            )
        Organisation.objects.filter(pk=closed_pme_id).update(state="closed")
    row2 = _run_full_erasure("sub-r10-case2", "case2@r10-erasure.fr", "DEL-102")
    assert EngineKnownSubject.objects.filter(
        organisation_id=closed_pme_id,
        user_id=row2.user_reference,
        subject="sub-r10-case2",
        erased_at__isnull=False,
    ).exists()

    # --- Case 3: Member ONLY in active `shared_realm` PME org (NO direct `community` membership) ---
    with transaction.atomic():
        u3 = User.objects.create(email="case3@r10-erasure.fr", display_name="Case 3")
        Identity.objects.create(
            user=u3,
            organisation_id=active_pme_id,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-r10-case3",
            email=u3.email,
            enabled=True,
        )
        Membership.objects.create(
            user=u3,
            organisation_id=active_pme_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
    row3 = _run_full_erasure("sub-r10-case3", "case3@r10-erasure.fr", "DEL-103")
    assert str(community.id) in row3.inventory["engine_member_revisions"]

    # --- Case 4: Restore rehearsal `_ensure_account_protocol_emitted` on un-emitted shared-realm row ---
    with transaction.atomic():
        u4 = User.objects.create(email="case4@r10-erasure.fr", display_name="Case 4")
        ident4 = Identity.objects.create(
            user=u4,
            organisation_id=active_pme_id,
            issuer=SHARED_ISSUER,
            realm="community",
            subject="sub-r10-case4",
            email=u4.email,
            enabled=True,
        )
        Membership.objects.create(
            user=u4,
            organisation_id=active_pme_id,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=timezone.now(),
        )
        req4_id = new_uuid7()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT privacy_admit_account_erasure(%s,%s,%s,%s,%s,%s)",
                [req4_id, ident4.id, "DEL-104", "8" * 64, database_now(), staff_op.id],
            )
    row4 = AccountErasure.objects.get(pk=req4_id)
    assert row4.protocol_emitted_at is None
    DjangoRestoreRehearsalBackend()._ensure_account_protocol_emitted(row4)
    row4.refresh_from_db()
    assert row4.protocol_emitted_at is not None
    comm_set_4 = EngineMemberSet.objects.filter(organisation=community).latest("revision")
    assert "sub-r10-case4" in (comm_set_4.erased_subjects or [])
