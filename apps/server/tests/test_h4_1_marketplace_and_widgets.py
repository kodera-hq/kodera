"""H4.1 acceptance suite: `kodera.widget.v1` sandboxed validation, pinned-IP SSRF widget action
callbacks outside `transaction.atomic()`, confidential/E2EE channel `403` refusal, web-only Stripe
Connect marketplace settlement (`KODERA_BILLING_ENABLED` gate), `kodera_api` writer-role bounds, and
GDPR Art. 17 erasure."""

from __future__ import annotations

import hmac
import json
import socket
import time
import urllib.parse
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import IntegrityError, connection
from django.test import Client
from django.utils import timezone
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from workspace_safety.test_moderation import world as moderation_world  # noqa: F401

from apps.billing.models import CreatorConnectAccount
from apps.billing.payments.fake import FakeProvider
from apps.billing.payments.stripe import StripeProvider
from apps.e2ee.models import Room
from apps.extensions import marketplace, retention, services as extension_services, widgets
from apps.extensions.models import (
    ExtensionMarketplaceListing,
    Installation,
    MarketplaceEntitlement,
    WidgetActionReceipt,
    WorkspaceCutoff,
)
from apps.extensions.wire import ExtensionRefusedError
from apps.media import outbound
from apps.workspaces.models import Category, Channel, ResourcePolicy, ResourcePolicyRule
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)

CANONICAL_FR_WAIVER = (
    "Je demande l'exécution immédiate du service numérique et renonce expressément "
    "à mon droit de rétractation de 14 jours conformément à l'article L221-28 du Code de la consommation."
)


@pytest.fixture
def world(moderation_world):  # noqa: F811
    org, workspace, members, tokens = moderation_world
    workspace.default_policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility="organisation"
    )
    workspace.save(update_fields=["default_policy"])
    return org, workspace, members, tokens


def _create_channel(workspace: Any, *, name: str, is_confidential: bool = False) -> Channel:
    category = Category.objects.filter(workspace=workspace).first()
    if category is None:
        category = Category.objects.create(workspace=workspace, name="General", position=0)
    pos = Channel.objects.filter(workspace=workspace).count()
    return Channel.objects.create(
        workspace=workspace,
        category=category,
        kind="text",
        name=name,
        position=pos,
        lifecycle="active",
        is_confidential=is_confidential,
    )


def _sample_card(widget_id: str = "deploy-status") -> dict[str, Any]:
    return {
        "schemaVersion": "kodera.widget.v1",
        "widgetId": widget_id,
        "title": "Deployment Gate",
        "blocks": [
            {"type": "header", "title": "Release v1.8.0", "subtitle": "Scaleway PAR-2"},
            {"type": "status_pill", "label": "Awaiting approval", "state": "warning"},
            {"type": "progress_bar", "label": "Canary rollout", "value": 65},
            {
                "type": "kv_list",
                "items": [
                    {"label": "Commit", "value": "8f29c1a", "mono": True},
                    {"label": "Target", "value": "eu-west-par"},
                ],
            },
            {
                "type": "button_row",
                "actions": [
                    {"actionId": "approve", "label": "Approve", "variant": "primary"},
                    {"actionId": "abort", "label": "Abort", "variant": "destructive"},
                ],
            },
            {
                "type": "link_button",
                "label": "Runbook",
                "href": "https://docs.kodera.example.org/runbooks/deploy",
                "variant": "secondary",
            },
        ],
    }


def _sample_manifest(slug: str = "release-bot", widget_id: str = "deploy-status") -> dict[str, Any]:
    return {
        "schemaVersion": "kodera.extension.v1",
        "slug": slug,
        "name": "Release Bot",
        "version": "0.2.0",
        "description": "Interactive release approval cards and slash commands.",
        "scopes": ["commands:register", "messages:write", "widgets:write"],
        "events": ["command.invoked", "widget.action"],
        "commands": [{"name": "/release", "description": "Open release status card"}],
        "widgets": [
            {
                "id": widget_id,
                "title": "Deployment Gate",
                "description": "Interactive canary control card",
                "defaultCard": _sample_card(widget_id),
            }
        ],
        "endpoint": "https://ext.kodera.example.org/webhooks/kodera",
    }


# ---------------------------------------------------------------------------
# 1. `kodera.widget.v1` Closed AST, Depth, Size, Link & Prototype Guards
# ---------------------------------------------------------------------------


def test_widget_card_validation_enforces_closed_ast_depth_size_and_https_links() -> None:
    valid = widgets.validate_widget_card(_sample_card())
    assert valid["schemaVersion"] == "kodera.widget.v1"
    assert len(valid["blocks"]) == 6

    # Rejects prototype-pollution keys anywhere in the tree.
    polluted = _sample_card()
    polluted["__proto__"] = {"polluted": True}
    with pytest.raises(ExtensionRefusedError, match="widget_forbidden_key"):
        widgets.validate_widget_card(polluted)

    # Rejects AST depth > 4.
    deep_payload = _sample_card()
    deep_payload["blocks"] = [
        {"type": "kv_list", "items": [{"label": "k", "value": {"nested": {"too": "deep"}}}]}
    ]
    with pytest.raises(ExtensionRefusedError, match="widget_ast_depth_exceeded"):
        widgets.validate_widget_card(deep_payload)

    # Rejects unknown block types (closed AST).
    unknown_block = _sample_card()
    unknown_block["blocks"] = [{"type": "raw_html", "html": "<script>alert(1)</script>"}]
    with pytest.raises(ExtensionRefusedError, match="widget_block_type_invalid"):
        widgets.validate_widget_card(unknown_block)

    # Rejects progress_bar outside 0..100 or boolean.
    bad_progress = _sample_card()
    bad_progress["blocks"] = [{"type": "progress_bar", "label": "Rollout", "value": 105}]
    with pytest.raises(ExtensionRefusedError, match="widget_progress_bar_invalid"):
        widgets.validate_widget_card(bad_progress)

    # Rejects button_row > 5 actions or duplicate actionId.
    too_many_buttons = _sample_card()
    too_many_buttons["blocks"] = [
        {
            "type": "button_row",
            "actions": [
                {"actionId": f"act_{idx}", "label": f"Act {idx}", "variant": "secondary"}
                for idx in range(6)
            ],
        }
    ]
    with pytest.raises(ExtensionRefusedError, match="widget_button_row_invalid"):
        widgets.validate_widget_card(too_many_buttons)

    # Rejects non-HTTPS, javascript:, localhost, and private-IP link_button hrefs.
    for unsafe_href in (
        "http://docs.kodera.example.org/plain",
        "javascript:alert(1)",
        "https://localhost/internal",
        "https://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data",
    ):
        bad_link = _sample_card()
        bad_link["blocks"] = [{"type": "link_button", "label": "Open", "href": unsafe_href}]
        with pytest.raises(ExtensionRefusedError):
            widgets.validate_widget_card(bad_link)

    # Rejects oversized serialized card (> 16 KiB) with 413.
    oversized_blocks = [
        {
            "type": "kv_list",
            "items": [{"label": f"k{i}_{j}", "value": "V" * 180} for j in range(12)],
        }
        for i in range(10)
    ]
    with pytest.raises(ExtensionRefusedError, match="widget_card_too_large") as size_err:
        widgets.validate_widget_card(
            {
                "schemaVersion": "kodera.widget.v1",
                "widgetId": "deploy-status",
                "blocks": oversized_blocks,
            }
        )
    assert size_err.value.status == 413


# ---------------------------------------------------------------------------
# 2. Marketplace Free vs Paid Stripe Connect + `KODERA_BILLING_ENABLED` Gate
# ---------------------------------------------------------------------------


def test_marketplace_free_and_billing_disabled_gate_over_kodera_api_writer_role(
    world, http_signer, settings
) -> None:
    org, workspace, members, tokens = world
    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_CONTACT_SEAL_KEY = b"k" * 32

    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    member_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[2].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )

    role = f"ext_mkt_writer_{uuid.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)
        assert_writer_grants(cursor, role)

    client = Client()
    try:
        with acting_as(role):
            # Paid listing publication is refused 409 `billing-disabled` when KODERA_BILLING_ENABLED=False.
            paid_pub = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "paid-release-bot",
                        "title": "Paid Release Bot",
                        "summary": "Paid release automation",
                        "manifest": _sample_manifest("paid-release-bot"),
                        "pricingMode": "one_time",
                        "priceExclVatMinor": 1500,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-paid-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert paid_pub.status_code == 409
            assert paid_pub.json()["detail"] == "billing-disabled"

            # Free listing publishes cleanly even when KODERA_BILLING_ENABLED=False.
            free_pub = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "release-bot",
                        "title": "Release Bot",
                        "summary": "Free release approval cards",
                        "manifest": _sample_manifest("release-bot"),
                        "pricingMode": "free",
                        "priceExclVatMinor": 0,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-free-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert free_pub.status_code == 201, free_pub.content
            listing_id = free_pub.json()["id"]

            # Ordinary workspace member can list marketplace extensions (`billingEnabled: false`).
            listed = client.get(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
            )
            assert listed.status_code == 200
            assert listed.json()["billingEnabled"] is False
            assert len(listed.json()["listings"]) == 1
            assert listed.json()["listings"][0]["slug"] == "release-bot"

            # Ordinary member cannot publish or install (`403`).
            member_install = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
                data=json.dumps({"signingSecret": "s" * 40}),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"mem-inst-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
            )
            assert member_install.status_code == 403

            # Admin installs free listing directly in one click; replay returns 200.
            inst_key = f"adm-inst-{uuid.uuid4().hex}"
            installed = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
                data=json.dumps({"signingSecret": "s" * 40}),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=inst_key,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert installed.status_code == 201, installed.content
            assert "widget.action" in installed.json()["events"]

            # Direct SQL DELETE under `kodera_api` is refused with INSUFFICIENT_PRIVILEGE.
            assert (
                refused("DELETE FROM extensions_extensionmarketplacelisting")
                == INSUFFICIENT_PRIVILEGE
            )
            assert (
                refused("DELETE FROM extensions_marketplaceentitlement") == INSUFFICIENT_PRIVILEGE
            )
            assert refused("DELETE FROM extensions_widgetactionreceipt") == INSUFFICIENT_PRIVILEGE
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_paid_stripe_connect_checkout_settlement_and_install_outside_atomic(
    world, http_signer, settings, monkeypatch
) -> None:
    org, workspace, members, tokens = world
    now_dt = timezone.now()
    now = int(now_dt.timestamp())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = True
    settings.KODERA_CONTACT_SEAL_KEY = b"m" * 32
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://console.kodera.test"})

    CreatorConnectAccount.objects.create(
        organisation=org,
        workspace=workspace,
        owner_user_id=members[0].user_id,
        stripe_connect_account_id="acct_1SellerExtMkt01",
        onboarding_state="active",
        operation_idempotency_key="onboard-seller-1",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        platform_fee_bps=1200,
        seller_legal_name="Studio Seller SAS",
        tax_residence_country="FR",
        onboarding_completed_at=now_dt,
    )

    fake_provider = FakeProvider(secret=b"fake-stripe-secret-32-bytes-long!")
    saw_outside_atomic: list[bool] = []
    orig_create_link = fake_provider.create_link

    def checked_create_link(req: Any) -> Any:
        saw_outside_atomic.append(not connection.in_atomic_block)
        return orig_create_link(req)

    monkeypatch.setattr(fake_provider, "create_link", checked_create_link)
    monkeypatch.setattr(
        "apps.billing.payments.configured_provider",
        lambda: fake_provider,
    )

    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    client = Client()

    pub = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
        data=json.dumps(
            {
                "slug": "incident-pager",
                "title": "Incident Pager Pro",
                "summary": "Paid incident escalation cards via Stripe Connect",
                "manifest": _sample_manifest("incident-pager"),
                "pricingMode": "one_time",
                "priceExclVatMinor": 2500,
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"pub-pro-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert pub.status_code == 201, pub.content
    listing_id = uuid.UUID(pub.json()["id"])

    # Install before paid checkout/settlement is refused 403 `marketplace_entitlement_required`.
    premature_install = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
        data=json.dumps({"signingSecret": "p" * 40}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"premature-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert premature_install.status_code == 403
    assert premature_install.json()["detail"] == "marketplace_entitlement_required"

    # Paid B2C checkout without Art. L221-28 withdrawal waiver is refused 422 and leaves no active grant.
    no_waiver = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
        data=json.dumps(
            {
                "customerKind": "b2c",
                "buyerCountry": "FR",
                "returnUrl": "https://console.kodera.test/extensions/marketplace",
                "locale": "fr",
                "withdrawalWaiverAccepted": False,
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"chk-nowaiver-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert no_waiver.status_code == 422

    # Valid B2C checkout with waiver executes outside `transaction.atomic()` and routes Connect split.
    chk_key = f"chk-ok-{uuid.uuid4().hex}"
    chk_body = {
        "customerKind": "b2c",
        "buyerCountry": "FR",
        "returnUrl": "https://console.kodera.test/extensions/marketplace",
        "locale": "fr",
        "withdrawalWaiverAccepted": True,
        "withdrawalWaiverAt": timezone.now().isoformat(),
        "withdrawalWaiverStatement": CANONICAL_FR_WAIVER,
    }
    chk = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
        data=json.dumps(chk_body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=chk_key,
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert chk.status_code == 201, chk.content
    chk_json = chk.json()
    assert saw_outside_atomic == [True]
    assert chk_json["checkoutRequired"] is True
    assert chk_json["state"] == "pending"
    assert chk_json["grossExclVatMinor"] == 2500
    assert chk_json["vatAmountMinor"] == 500  # 20% FR VAT
    assert chk_json["totalInclVatMinor"] == 3000
    assert chk_json["applicationFeeAmountMinor"] == 300  # 12% of 2500 HT
    assert chk_json["checkoutUrl"].startswith("https://pay.fake.invalid/")

    assert len(fake_provider.links) == 1
    issued_req = fake_provider.links[0]
    assert issued_req.connect_destination_account == "acct_1SellerExtMkt01"
    assert issued_req.payment_methods == ("card",)
    assert issued_req.reference_kind == "extension_marketplace"

    # Replay with same Idempotency-Key returns 200 without creating a second Stripe session.
    chk_replay = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
        data=json.dumps(chk_body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=chk_key,
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert chk_replay.status_code == 200
    assert chk_replay.json()["replayed"] is True
    assert len(fake_provider.links) == 1

    # If KODERA_BILLING_ENABLED is flipped off, paid checkout fails closed with 409 `billing-disabled`.
    settings.KODERA_BILLING_ENABLED = False
    chk_disabled = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
        data=json.dumps(chk_body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"chk-disabled-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert chk_disabled.status_code == 409
    assert chk_disabled.json()["detail"] == "billing-disabled"
    settings.KODERA_BILLING_ENABLED = True

    # Settle Connect checkout and install extension.
    marketplace.settle_marketplace_checkout(
        organisation_id=org.id,
        workspace_id=workspace.id,
        entitlement_id=uuid.UUID(chk_json["entitlementId"]),
        checkout_ref=chk_json["checkoutSessionId"],
    )
    installed = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
        data=json.dumps({"signingSecret": "z" * 44}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"inst-pro-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert installed.status_code == 201, installed.content
    assert installed.json()["slug"] == "incident-pager"


# ---------------------------------------------------------------------------
# 3. Pinned-IP SSRF Widget Action Callbacks, Confidential/E2EE 403 & Erasure
# ---------------------------------------------------------------------------


def test_widget_action_dispatch_ssrf_confidential_e2ee_refusal_and_erasure(
    world, http_signer, settings, monkeypatch
) -> None:
    org, workspace, members, tokens = world
    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_CONTACT_SEAL_KEY = b"w" * 32

    plain_ch = _create_channel(workspace, name="deployments", is_confidential=False)
    conf_ch = _create_channel(workspace, name="secops-confidential", is_confidential=True)
    e2ee_ch = _create_channel(workspace, name="mls-room-channel", is_confidential=False)
    readonly_ch = _create_channel(workspace, name="announcements-ro", is_confidential=False)

    # Attach an E2EE Room record to `e2ee_ch` (even though Channel.is_confidential is False).
    Room.objects.create(
        organisation=org,
        channel=e2ee_ch,
        algorithm="io.kodera.mls.v1",
        epoch=0,
    )

    # Make `readonly_ch` deny `message.post` for ordinary members.
    ro_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    readonly_ch.policy_mode = "explicit"
    readonly_ch.explicit_policy = ro_policy
    readonly_ch.save(update_fields=["policy_mode", "explicit_policy"])
    ResourcePolicyRule.objects.create(
        policy=ro_policy, kind="deny_capability", capability="message.post"
    )

    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    member_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[2].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    client = Client()

    # Publish & install free widget-enabled connector.
    secret = "whsec_" + "q" * 38
    pub = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
        data=json.dumps(
            {
                "slug": "release-bot",
                "title": "Release Bot",
                "summary": "Interactive release gate",
                "manifest": _sample_manifest("release-bot", "deploy-status"),
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"pub-widget-bot-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert pub.status_code == 201
    listing_id = pub.json()["id"]

    inst = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
        data=json.dumps({"signingSecret": secret}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"inst-widget-bot-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert inst.status_code == 201
    installation_id = inst.json()["installationId"]

    # 1. Confidential channel AND E2EE room channel MUST fail closed 403 BEFORE any DNS/network I/O.
    network_touched = False

    def forbid_network(*_a: Any, **_kw: Any) -> Any:
        nonlocal network_touched
        network_touched = True
        raise AssertionError("network must never be touched on confidential/E2EE channels")

    monkeypatch.setattr(outbound, "request", forbid_network)

    for protected_ch in (conf_ch, e2ee_ch):
        refused_resp = client.post(
            f"/api/v1/organisations/{org.id}/workspace/channels/{protected_ch.id}/widgets/deploy-status/actions",
            data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"conf-guard-{protected_ch.id}",
            HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
        )
        assert refused_resp.status_code == 403
        assert refused_resp.json()["detail"] == "widget_confidential_channel_refused"
    assert network_touched is False

    # 2. Read-only channel refuses widget action with 403 `extension_channel_access_refused`.
    ro_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{readonly_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"ro-attempt-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert ro_resp.status_code == 403
    assert ro_resp.json()["detail"] == "extension_channel_access_refused"

    # 3. Private / loopback / metadata DNS resolution is blocked by `outbound.addresses` (SSRF guard).
    monkeypatch.setattr(
        outbound, "request", coexistence_real_request := outbound.request
    )  # restore
    del coexistence_real_request
    # Restore real `outbound.request` from module reload / original function via PinnedConnection path:
    monkeypatch.undo()
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_CONTACT_SEAL_KEY = b"w" * 32

    monkeypatch.setattr(
        outbound,
        "_resolve_stub",
        lambda host, port, deadline, nameservers: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("169.254.169.254", 443))
        ],
    )
    ssrf_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"ssrf-metadata-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert ssrf_resp.status_code == 422
    assert ssrf_resp.json()["detail"] == "widget_endpoint_blocked"

    # 4. HTTP 302 redirect from webhook endpoint is refused (`502 widget_redirect_refused`, zero redirects).
    monkeypatch.setattr(
        outbound,
        "_resolve_stub",
        lambda host, port, deadline, nameservers: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ],
    )

    class RedirectHttpResp:
        status = 302

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "http://127.0.0.1/internal" if name.lower() == "location" else default

        def read(self, _n: int = 0) -> bytes:
            return b""

    class RedirectPinnedConn:
        transmitted = True

        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def request(self, *_a: Any, **_kw: Any) -> None:
            pass

        def getresponse(self) -> RedirectHttpResp:
            return RedirectHttpResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", RedirectPinnedConn)
    redir_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"ssrf-redirect-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert redir_resp.status_code == 502
    assert redir_resp.json()["detail"] == "widget_redirect_refused"

    # 5. Valid pinned-IP HTTPS webhook dispatch executes strictly outside `transaction.atomic()`,
    # carries valid `kodera.extension.delivery.v2` HMAC signature, and returns validated `card`.
    captured: list[dict[str, Any]] = []
    updated_card = _sample_card("deploy-status")
    updated_card["blocks"][1] = {"type": "status_pill", "label": "Approved", "state": "success"}
    updated_card["blocks"][2] = {"type": "progress_bar", "label": "Canary rollout", "value": 100}

    class OkHttpResp:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "application/json" if name.lower() == "content-type" else default

        def read(self, _n: int = 0) -> bytes:
            return json.dumps({"card": updated_card}).encode("utf-8")

    class CapturingPinnedConn:
        transmitted = True

        def __init__(self, destination: Any, resolved: Any, deadline: float, **_kw: Any) -> None:
            self.destination = destination
            self.resolved = resolved
            self.in_atomic_at_init = connection.in_atomic_block

        def request(
            self,
            method: str,
            path: str,
            body: bytes | None = None,
            headers: dict[str, str] | None = None,
        ) -> None:
            captured.append(
                {
                    "in_atomic": connection.in_atomic_block,
                    "resolved": self.resolved,
                    "method": method,
                    "path": path,
                    "body": body or b"",
                    "headers": dict(headers or {}),
                }
            )

        def getresponse(self) -> OkHttpResp:
            return OkHttpResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", CapturingPinnedConn)

    act_key = f"widget-act-ok-{uuid.uuid4().hex}"
    act_body = {
        "installationId": installation_id,
        "actionId": "approve",
        "payload": {"environment": "production"},
    }
    ok_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps(act_body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=act_key,
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert ok_resp.status_code == 200, ok_resp.content
    ok_json = ok_resp.json()
    assert ok_json["state"] == "delivered"
    assert ok_json["replayed"] is False
    assert ok_json["card"]["blocks"][1]["label"] == "Approved"
    assert ok_json["card"]["blocks"][2]["value"] == 100

    assert len(captured) == 1
    sent = captured[0]
    assert sent["in_atomic"] is False
    assert sent["resolved"] == [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
    ]
    assert sent["headers"]["X-Kodera-Event"] == "widget.action"
    ts_str = sent["headers"]["X-Kodera-Timestamp"]
    expected_sig = (
        "v1="
        + hmac.digest(
            secret.encode("ascii"),
            ts_str.encode("ascii") + b"." + sent["body"],
            "sha256",
        ).hex()
    )
    assert sent["headers"]["X-Kodera-Signature-256"] == expected_sig
    envelope = json.loads(sent["body"].decode("utf-8"))
    assert envelope["schema"] == "kodera.extension.delivery.v2"
    assert envelope["type"] == "widget.action"
    assert envelope["data"]["widget_id"] == "deploy-status"
    assert envelope["data"]["action_id"] == "approve"

    # Idempotent replay returns cached result (`replayed: true`) without re-invoking webhook;
    # reusing same Idempotency-Key with different actionId returns 409.
    replay_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps(act_body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=act_key,
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert replay_resp.status_code == 200
    assert replay_resp.json()["replayed"] is True
    assert len(captured) == 1

    mismatch_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "abort"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=act_key,
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert mismatch_resp.status_code == 409

    # 6. Pre-expiry WidgetActionReceipt deletion is blocked by `extension_scope_guard`;
    # GDPR Art. 17 `extension_erasure_step` purges secrets, response cards, and all rows.
    receipt_row = WidgetActionReceipt.objects.get(id=ok_json["receiptId"])
    with pytest.raises(IntegrityError, match="Extension evidence is retained"):
        receipt_row.delete()

    from test_core_erasure import begin
    from test_extension_retention_worker import now as db_now

    cutoff = db_now()
    erasure = begin(org, not_before=cutoff)
    for domain in erasure.inventory["required_domains"]:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.privacy_record_absence(%s,%s,%s,%s,%s,%s)",
                [
                    erasure.id,
                    domain,
                    erasure.cutoff_at,
                    "c" * 64,
                    "ABS-" + domain[:12],
                    db_now(),
                ],
            )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.extension_erasure_step(%s,%s,%s,%s,100)",
            [erasure.id, org.id, erasure.cutoff_at, erasure.inventory_sha256],
        )
        raw_step = cursor.fetchone()[0]
        step_out = json.loads(raw_step) if isinstance(raw_step, str) else raw_step

    assert step_out["payloads_complete"] is True
    assert step_out["metadata_complete"] is True
    assert retention.local_payloads_absent(organisation_id=org.id) is True
    assert retention.metadata_absent(organisation_id=org.id) is True
    assert (
        extension_services.count_residual_extension_rows_for_organisation(organisation_id=org.id)
        == 0
    )
    assert not ExtensionMarketplaceListing.objects.filter(organisation=org).exists()
    assert not MarketplaceEntitlement.objects.filter(organisation=org).exists()
    assert not WidgetActionReceipt.objects.filter(organisation=org).exists()
    assert not Installation.objects.filter(workspace=workspace).exists()
    assert WorkspaceCutoff.objects.filter(organisation_id=org.id).exists()


def _signed_stripe_webhook_post(
    client: Client,
    *,
    webhook_secret: str,
    event_id: str,
    event_type: str,
    data_object: dict[str, Any],
    created: int | None = None,
) -> Any:
    ts = int(time.time()) if created is None else created
    envelope = {
        "id": event_id,
        "object": "event",
        "api_version": "2024-06-20",
        "created": ts,
        "livemode": False,
        "type": event_type,
        "data": {"object": data_object},
    }
    raw_body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(
        webhook_secret.encode("utf-8"),
        f"{ts}.".encode("ascii") + raw_body,
        "sha256",
    ).hexdigest()
    return client.post(
        "/api/v1/billing/webhooks/stripe",
        data=raw_body,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=f"t={ts},v1={sig}",
    )


def test_p1_2_p1_4_and_p2_2_signed_stripe_webhook_settlement_refund_revocation_and_retry(
    world, http_signer, settings, monkeypatch
) -> None:
    from apps.billing.payments.port import ProviderUnavailableError

    org, workspace, members, tokens = world
    now_dt = timezone.now()
    now = int(now_dt.timestamp())
    webhook_secret = "whsec_test_marketplace_webhook_secret_012345"
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = True
    settings.KODERA_CONTACT_SEAL_KEY = b"m" * 32
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://console.kodera.test"})
    settings.KODERA_STRIPE_WEBHOOK_SECRET = webhook_secret

    CreatorConnectAccount.objects.create(
        organisation=org,
        workspace=workspace,
        owner_user_id=members[0].user_id,
        stripe_connect_account_id="acct_1SellerWebhook01",
        onboarding_state="active",
        operation_idempotency_key="onboard-seller-wh-1",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        platform_fee_bps=1200,
        seller_legal_name="Studio Webhook SAS",
        tax_residence_country="FR",
        onboarding_completed_at=now_dt,
    )

    fake_provider = FakeProvider(secret=b"fake-stripe-secret-32-bytes-long!")
    fail_next = True
    orig_create_link = fake_provider.create_link

    def flaky_create_link(req: Any) -> Any:
        nonlocal fail_next
        if fail_next:
            fail_next = False
            raise ProviderUnavailableError("stripe-503-transient")
        return orig_create_link(req)

    monkeypatch.setattr(fake_provider, "create_link", flaky_create_link)
    monkeypatch.setattr("apps.billing.payments.configured_provider", lambda: fake_provider)

    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    member_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[2].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    plain_ch = _create_channel(workspace, name="ops-room", is_confidential=False)

    role = f"ext_wh_writer_{uuid.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)
        assert_writer_grants(cursor, role)

    client = Client()
    try:
        with acting_as(role):
            # --- P1-4: "recurring" pricingMode is refused with 422 ---
            bad_recurring = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "recurring-bot",
                        "title": "Recurring Bot",
                        "summary": "Unsupported recurring mode",
                        "manifest": _sample_manifest("recurring-bot"),
                        "pricingMode": "recurring",
                        "priceExclVatMinor": 1900,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-rec-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert bad_recurring.status_code == 422
            assert bad_recurring.json()["detail"] == "marketplace_pricing_mode_invalid"

            # Publish valid one_time listing
            pub = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "pager-one-time",
                        "title": "Pager One-Time",
                        "summary": "One-time paid connector",
                        "manifest": _sample_manifest("pager-one-time", "deploy-status"),
                        "pricingMode": "one_time",
                        "priceExclVatMinor": 2500,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-ot-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert pub.status_code == 201, pub.content
            listing_id = pub.json()["id"]

            # --- P2-2: Transient ProviderUnavailableError (503) does not poison Idempotency-Key ---
            chk_key = f"chk-retry-{uuid.uuid4().hex}"
            chk_body = {
                "customerKind": "b2c",
                "buyerCountry": "FR",
                "returnUrl": "https://console.kodera.test/extensions/marketplace",
                "locale": "fr",
                "withdrawalWaiverAccepted": True,
                "withdrawalWaiverAt": timezone.now().isoformat(),
                "withdrawalWaiverStatement": CANONICAL_FR_WAIVER,
            }
            transient_503 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=chk_key,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert transient_503.status_code == 503
            assert transient_503.json()["detail"] == "marketplace_payment_provider_unavailable"

            # Retry with the EXACT SAME Idempotency-Key recovers cleanly once provider is healthy!
            chk_recovered = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=chk_key,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert chk_recovered.status_code == 201, chk_recovered.content
            chk_data = chk_recovered.json()
            session_id = chk_data["checkoutSessionId"]
            entitlement_id = chk_data["entitlementId"]
            total_minor = chk_data["totalInclVatMinor"]

            # --- P1-2: Signed Stripe webhooks settle only when paid, and revoke on refund ---
            # 1) Async `processing` checkout.session.completed MUST NOT activate entitlement!
            wh_processing = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_proc_{uuid.uuid4().hex[:12]}",
                event_type="checkout.session.completed",
                data_object={
                    "id": session_id,
                    "payment_status": "processing",
                    "payment_intent": "pi_mkt_test_001",
                    "amount_total": total_minor,
                    "currency": "eur",
                },
            )
            assert wh_processing.status_code == 200
            assert wh_processing.json()["status"] == "ignored"
            assert MarketplaceEntitlement.objects.get(id=entitlement_id).state == "pending"

            # 2) Paid `checkout.session.completed` settles entitlement -> allows installation!
            wh_paid = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_paid_{uuid.uuid4().hex[:12]}",
                event_type="checkout.session.completed",
                data_object={
                    "id": session_id,
                    "payment_status": "paid",
                    "payment_intent": "pi_mkt_test_001",
                    "amount_total": total_minor,
                    "currency": "eur",
                },
            )
            assert wh_paid.status_code == 200
            assert wh_paid.json()["status"] == "applied"
            settled_ent = MarketplaceEntitlement.objects.get(id=entitlement_id)
            assert settled_ent.state == "active"
            assert settled_ent.payment_intent_id == "pi_mkt_test_001"

            inst = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
                data=json.dumps({"signingSecret": "whsec_" + "r" * 38}),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"inst-wh-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert inst.status_code == 201, inst.content
            installation_id = inst.json()["installationId"]

            # 3) Signed `charge.refunded` revokes BOTH entitlement AND bound Installation!
            wh_refund = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_ref_{uuid.uuid4().hex[:12]}",
                event_type="charge.refunded",
                data_object={
                    "id": "ch_mkt_test_001",
                    "payment_intent": "pi_mkt_test_001",
                    "amount_refunded": total_minor,
                    "currency": "eur",
                },
            )
            assert wh_refund.status_code == 200, wh_refund.content
            assert wh_refund.json()["status"] == "applied"
            refunded_ent = MarketplaceEntitlement.objects.get(id=entitlement_id)
            assert refunded_ent.state == "refunded"
            assert refunded_ent.revoked_at is not None
            assert bytes(refunded_ent.sealed_signing_secret) == b""
            revoked_inst = Installation.objects.get(id=installation_id)
            assert revoked_inst.revoked_at is not None

            # Subsequent widget action against the refunded installation fails closed!
            post_refund_act = client.post(
                f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
                data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"act-after-refund-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
            )
            assert post_refund_act.status_code == 404
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_p1_3_widget_action_fences_mid_flight_erasure_and_revocation_races(
    world, http_signer, settings, monkeypatch
) -> None:
    org, workspace, members, tokens = world
    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_CONTACT_SEAL_KEY = b"w" * 32

    plain_ch = _create_channel(workspace, name="race-channel", is_confidential=False)
    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    member_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[2].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )
    client = Client()

    pub = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
        data=json.dumps(
            {
                "slug": "race-bot",
                "title": "Race Bot",
                "summary": "Tests mid-flight erasure fence",
                "manifest": _sample_manifest("race-bot", "deploy-status"),
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"pub-race-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert pub.status_code == 201
    listing_id = pub.json()["id"]

    inst = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_id}/install",
        data=json.dumps({"signingSecret": "whsec_" + "x" * 38}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"inst-race-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert inst.status_code == 201
    installation_id = inst.json()["installationId"]

    monkeypatch.setattr(
        outbound,
        "_resolve_stub",
        lambda host, port, deadline, nameservers: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ],
    )

    returned_card = _sample_card("deploy-status")

    class OkResp:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "application/json" if name.lower() == "content-type" else default

        def read(self, _n: int = 0) -> bytes:
            return json.dumps({"card": returned_card}).encode("utf-8")

    # Race 0: Mid-flight Installation revocation (without GDPR erasure) locks Installation in Stage 3,
    # commits `state = "failed"` outside transaction rollback, and DB trigger blocks `delivered`!
    pub_rev = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
        data=json.dumps(
            {
                "slug": "revoke-race-bot",
                "title": "Revoke Race Bot",
                "summary": "Tests mid-flight installation revocation fence",
                "manifest": _sample_manifest("revoke-race-bot", "deploy-status"),
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"pub-revrace-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert pub_rev.status_code == 201
    rev_listing_id = pub_rev.json()["id"]

    inst_rev = client.post(
        f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{rev_listing_id}/install",
        data=json.dumps({"signingSecret": "whsec_" + "y" * 38}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"inst-revrace-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
    )
    assert inst_rev.status_code == 201
    rev_installation_id = inst_rev.json()["installationId"]

    pre_revoke_row = WidgetActionReceipt.objects.create(
        organisation=org,
        workspace=workspace,
        channel=plain_ch,
        installation_id=rev_installation_id,
        actor_membership=members[2],
        widget_id="deploy-status",
        action_id="approve",
        idempotency_key=f"trig-rev-{uuid.uuid4().hex}",
        request_sha256="e" * 64,
        state="in_flight",
    )

    class RevokeInstallationMidFlightConn:
        transmitted = True

        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def request(self, *_a: Any, **_kw: Any) -> None:
            Installation.objects.filter(id=rev_installation_id, revoked_at__isnull=True).update(
                revoked_at=timezone.now(),
                version=uuid.uuid4(),
            )

        def getresponse(self) -> OkResp:
            return OkResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", RevokeInstallationMidFlightConn)
    rev_race_key = f"race-inst-revoke-{uuid.uuid4().hex}"
    rev_aborted_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": rev_installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=rev_race_key,
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert rev_aborted_resp.status_code == 409
    assert rev_aborted_resp.json()["detail"] == "widget_action_aborted"

    rev_receipt = WidgetActionReceipt.objects.get(
        installation_id=rev_installation_id, idempotency_key=rev_race_key
    )
    rev_receipt.refresh_from_db()
    assert rev_receipt.state == "failed"
    assert rev_receipt.response_card is None

    # DB BEFORE UPDATE trigger also blocks transitioning to `delivered` when installation is revoked!
    with pytest.raises(
        IntegrityError,
        match="Extension widget action receipt binding invalid",
    ):
        WidgetActionReceipt.objects.filter(id=pre_revoke_row.id).update(
            state="delivered",
            response_status=200,
        )

    # Race 1: Mid-flight GDPR erasure cutoff admitted during network I/O -> Stage 3 discards card (409)
    from test_core_erasure import begin
    from test_extension_retention_worker import now as db_now

    # Pre-seed a second receipt row BEFORE cutoff so we can also test the DB BEFORE UPDATE trigger directly
    pre_cutoff_row = WidgetActionReceipt.objects.create(
        organisation=org,
        workspace=workspace,
        channel=plain_ch,
        installation_id=installation_id,
        actor_membership=members[2],
        widget_id="deploy-status",
        action_id="abort",
        idempotency_key=f"trig-check-{uuid.uuid4().hex}",
        request_sha256="f" * 64,
        state="in_flight",
    )

    class CutoffMidFlightConn:
        transmitted = True

        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def request(self, *_a: Any, **_kw: Any) -> None:
            begin(org, not_before=db_now())

        def getresponse(self) -> OkResp:
            return OkResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", CutoffMidFlightConn)
    race_key = f"race-cutoff-{uuid.uuid4().hex}"
    aborted_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/channels/{plain_ch.id}/widgets/deploy-status/actions",
        data=json.dumps({"installationId": installation_id, "actionId": "approve"}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=race_key,
        HTTP_AUTHORIZATION=f"Bearer {member_bearer}",
    )
    assert aborted_resp.status_code == 409
    assert aborted_resp.json()["detail"] == "widget_action_aborted"

    receipt = WidgetActionReceipt.objects.get(
        installation_id=installation_id, idempotency_key=race_key
    )
    assert receipt.state == "failed"
    assert receipt.response_card is None

    # DB BEFORE UPDATE trigger also directly blocks restoring non-null response_card under cutoff
    with pytest.raises(
        IntegrityError,
        match="durable erasure cutoff refuses write|Extension widget action receipt immutable",
    ):
        WidgetActionReceipt.objects.filter(id=pre_cutoff_row.id).update(
            response_card=returned_card,
        )


def test_r2_live_stripe_adapter_metadata_fresh_key_retry_and_early_dispute_reconciliation(
    world, http_signer, settings, monkeypatch
) -> None:
    """R2 E2E: drives real `StripeProvider.create_link` HTTP form builder into `stripe_webhook.py`
    without fake metadata, verifies fresh client `Idempotency-Key` recovery + deterministic provider
    `Idempotency-Key`, `409 checkout_already_pending`, and early `charge.dispute.created` -> `revoked`."""
    org, workspace, members, tokens = world
    now = int(time.time())
    now_dt = timezone.now()
    webhook_secret = "whsec_r2_live_adapter_secret_32_bytes_ok"
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    settings.KODERA_BILLING_ENABLED = True
    settings.KODERA_CONTACT_SEAL_KEY = b"r" * 32
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://console.kodera.test"})
    settings.KODERA_STRIPE_WEBHOOK_SECRET = webhook_secret

    CreatorConnectAccount.objects.create(
        organisation=org,
        workspace=workspace,
        owner_user_id=members[0].user_id,
        stripe_connect_account_id="acct_1SellerR2Live01",
        onboarding_state="active",
        operation_idempotency_key="onboard-seller-r2-1",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        platform_fee_bps=1200,
        seller_legal_name="Studio R2 Live SAS",
        tax_residence_country="FR",
        onboarding_completed_at=now_dt,
    )

    captured_calls: list[dict[str, Any]] = []
    next_statuses: list[tuple[int, dict[str, Any]]] = []

    def capturing_stripe_transport(
        method: str, url: str, headers: Mapping[str, str], body: bytes
    ) -> tuple[int, bytes]:
        parsed_form = dict(urllib.parse.parse_qsl(body.decode("utf-8"), keep_blank_values=True))
        captured_calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "form": parsed_form,
            }
        )
        status, payload = next_statuses.pop(0)
        return status, json.dumps(payload).encode("utf-8")

    live_stripe = StripeProvider(
        secret_key="rk_test_r2_marketplace_restricted_key",
        webhook_secret=webhook_secret,
        transport=capturing_stripe_transport,
    )
    monkeypatch.setattr("apps.billing.payments.configured_provider", lambda: live_stripe)

    admin_bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )

    role = f"ext_r2_writer_{uuid.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)
        assert_writer_grants(cursor, role)

    client = Client()
    chk_body = {
        "customerKind": "b2c",
        "buyerCountry": "FR",
        "returnUrl": "https://console.kodera.test/extensions/marketplace",
        "locale": "fr",
        "withdrawalWaiverAccepted": True,
        "withdrawalWaiverAt": timezone.now().isoformat(),
        "withdrawalWaiverStatement": CANONICAL_FR_WAIVER,
    }

    try:
        with acting_as(role):
            # --- Listing 1: Live StripeProvider metadata + fresh-key 503 retry + deterministic Stripe key ---
            pub1 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "r2-live-stripe",
                        "title": "R2 Live Stripe",
                        "summary": "Drives real StripeProvider form builder",
                        "manifest": _sample_manifest("r2-live-stripe", "deploy-status"),
                        "pricingMode": "one_time",
                        "priceExclVatMinor": 3000,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-r2-1-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert pub1.status_code == 201, pub1.content
            listing_1_id = pub1.json()["id"]

            # 1) First attempt returns 503 from Stripe API
            next_statuses.append((503, {"error": {"type": "api_error"}}))
            fresh_key_1 = f"chk-r2-k1-{uuid.uuid4().hex}"
            r_503 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_1_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=fresh_key_1,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert r_503.status_code == 503
            assert len(captured_calls) == 1

            # 2) Retry with a BRAND-NEW client Idempotency-Key (`fresh_key_2`) reuses the pending
            # `checkout_ref is None` entitlement (NO 500 IntegrityError!) AND sends the EXACT SAME
            # deterministic provider `Idempotency-Key` to Stripe!
            next_statuses.append(
                (
                    200,
                    {
                        "id": "cs_test_r2_live_001",
                        "url": "https://checkout.stripe.com/c/pay/cs_test_r2_live_001",
                        "expires_at": now + 3600,
                    },
                )
            )
            fresh_key_2 = f"chk-r2-k2-{uuid.uuid4().hex}"
            r_ok = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_1_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=fresh_key_2,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert r_ok.status_code == 201, r_ok.content
            entitlement_1_id = r_ok.json()["entitlementId"]
            total_1_minor = r_ok.json()["totalInclVatMinor"]

            assert len(captured_calls) == 2
            expected_provider_idem = f"mkt-checkout-{entitlement_1_id}-0"
            assert captured_calls[0]["headers"]["Idempotency-Key"] == expected_provider_idem
            assert captured_calls[1]["headers"]["Idempotency-Key"] == expected_provider_idem

            # Inspect real form parameters emitted by `StripeProvider.create_link`!
            form1 = captured_calls[1]["form"]
            assert form1["metadata[kodera_checkout_kind]"] == "extension_marketplace"
            assert form1["metadata[kodera_marketplace_entitlement_id]"] == entitlement_1_id
            assert (
                form1["payment_intent_data[metadata][kodera_marketplace_entitlement_id]"]
                == entitlement_1_id
            )
            assert form1["client_reference_id"] == entitlement_1_id
            assert (
                form1["payment_intent_data[transfer_data][destination]"] == "acct_1SellerR2Live01"
            )

            # 3) While `state == "pending"` and `checkout_ref is not None`, a 3rd fresh key returns 409!
            fresh_key_3 = f"chk-r2-k3-{uuid.uuid4().hex}"
            r_dup_pending = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_1_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=fresh_key_3,
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert r_dup_pending.status_code == 409
            assert r_dup_pending.json()["detail"] == "checkout_already_pending"
            assert len(captured_calls) == 2

            # 4) Settle via `payment_intent.succeeded` constructed STRICTLY from the real captured
            # `payment_intent_data[metadata][...]` (without `checkout.session.completed` first, proving
            # live metadata stamping settles an entitlement whose `payment_intent_id` is still NULL)!
            pi_metadata_from_stripe = {
                k.removeprefix("payment_intent_data[metadata][").removesuffix("]"): v
                for k, v in form1.items()
                if k.startswith("payment_intent_data[metadata][") and k.endswith("]")
            }
            wh_pi_paid = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_r2_pi_{uuid.uuid4().hex[:12]}",
                event_type="payment_intent.succeeded",
                data_object={
                    "id": "pi_r2_live_settled_001",
                    "amount_received": total_1_minor,
                    "currency": form1["line_items[0][price_data][currency]"],
                    "metadata": pi_metadata_from_stripe,
                },
            )
            assert wh_pi_paid.status_code == 200, wh_pi_paid.content
            assert wh_pi_paid.json()["status"] == "applied"
            ent_1 = MarketplaceEntitlement.objects.get(id=entitlement_1_id)
            assert ent_1.state == "active"
            assert ent_1.payment_intent_id == "pi_r2_live_settled_001"

            # --- Listing 2: Out-of-order early `charge.dispute.created` -> `checkout.session.completed` -> `revoked` ---
            pub2 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace",
                data=json.dumps(
                    {
                        "slug": "r2-early-dispute",
                        "title": "R2 Early Dispute",
                        "summary": "Tests deferred early dispute reconciliation",
                        "manifest": _sample_manifest("r2-early-dispute", "deploy-status"),
                        "pricingMode": "one_time",
                        "priceExclVatMinor": 4000,
                    }
                ),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"pub-r2-2-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert pub2.status_code == 201, pub2.content
            listing_2_id = pub2.json()["id"]

            next_statuses.append(
                (
                    200,
                    {
                        "id": "cs_test_r2_dispute_002",
                        "url": "https://checkout.stripe.com/c/pay/cs_test_r2_dispute_002",
                        "expires_at": now + 3600,
                    },
                )
            )
            chk2 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/extensions/marketplace/{listing_2_id}/checkout",
                data=json.dumps(chk_body),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"chk-r2-disp-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {admin_bearer}",
            )
            assert chk2.status_code == 201, chk2.content
            entitlement_2_id = chk2.json()["entitlementId"]
            total_2_minor = chk2.json()["totalInclVatMinor"]
            form2 = captured_calls[-1]["form"]
            session_metadata_from_stripe = {
                k.removeprefix("metadata[").removesuffix("]"): v
                for k, v in form2.items()
                if k.startswith("metadata[") and k.endswith("]")
            }

            # Deliver `charge.dispute.created` BEFORE `checkout.session.completed` (when `payment_intent_id`
            # on `MarketplaceEntitlement` is still NULL and dispute payload carries NO metadata)!
            wh_early_dispute = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_r2_disp_{uuid.uuid4().hex[:12]}",
                event_type="charge.dispute.created",
                data_object={
                    "id": "dp_r2_early_002",
                    "payment_intent": "pi_r2_early_dispute_002",
                    "amount": total_2_minor,
                    "currency": "eur",
                    "status": "needs_response",
                },
            )
            assert wh_early_dispute.status_code == 200, wh_early_dispute.content
            assert wh_early_dispute.json()["status"] == "deferred"
            assert MarketplaceEntitlement.objects.get(id=entitlement_2_id).state == "pending"

            # Now deliver `checkout.session.completed` (`paid`) for `pi_r2_early_dispute_002` ->
            # deferred dispute MUST drain immediately so final state is `"revoked"`, NEVER `"active"`!
            wh_late_settled = _signed_stripe_webhook_post(
                client,
                webhook_secret=webhook_secret,
                event_id=f"evt_r2_late_cs_{uuid.uuid4().hex[:12]}",
                event_type="checkout.session.completed",
                data_object={
                    "id": "cs_test_r2_dispute_002",
                    "client_reference_id": form2["client_reference_id"],
                    "payment_status": "paid",
                    "payment_intent": "pi_r2_early_dispute_002",
                    "amount_total": total_2_minor,
                    "currency": form2["line_items[0][price_data][currency]"],
                    "metadata": session_metadata_from_stripe,
                },
            )
            assert wh_late_settled.status_code == 200, wh_late_settled.content
            ent_2 = MarketplaceEntitlement.objects.get(id=entitlement_2_id)
            assert ent_2.state == "revoked"
            assert ent_2.revoked_at is not None
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')
