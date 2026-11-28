"""Offline unit and architecture tests for H3.1 Community Monetization (Volet A & Volet B + DAC7)."""

from __future__ import annotations

import json
import urllib.parse
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID
from xml.etree import ElementTree as ET

import pytest
from customer_http_fixtures import http_signer as http_signer  # noqa: F401
from django.test import override_settings
from django.utils import timezone

from apps.billing import boosts, dac7, vat, vip_connect
from apps.billing.api import monetization, permissions as monetization_op
from apps.billing.documents import NS, Party, Snapshot, render_xml
from apps.billing.integrity import IntegrityRefusedError
from apps.billing.payments.fake import FakePaymentsAdapter
from apps.billing.payments.port import LinkRequest, ProviderRefusedError, ReturnUrlRequiredError
from apps.billing.payments.services import ReturnUrlRefusedError
from apps.billing.payments.stripe import StripeProvider
from apps.billing.payments.stripe_webhook import (
    OfflineWebhookDeduplicator,
    StripeWebhookSignatureError,
)
from apps.workspaces.vip_entitlements import (
    VipConvergencePorts,
    project_vip_room_policy,
)
from core.db import api_writer_role
from core.sealing import SealError
from room_access.rooms import POLICY, livekit_room
from room_access.service import RefusedError, Service as RoomAccessService

NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=UTC)
ORG_ID = UUID("01900000-0000-7000-8000-000000000101")
WS_ID = UUID("01900000-0000-7000-8000-000000000102")
USER_ID = UUID("01900000-0000-7000-8000-000000000103")
MEMBER_ID = UUID("01900000-0000-7000-8000-000000000104")
VIP_ROLE_ID = UUID("01900000-0000-7000-8000-000000000105")
ENT_1_ID = UUID("01900000-0000-7000-8000-000000000201")
ENT_2_ID = UUID("01900000-0000-7000-8000-000000000202")
SELLER_1_ID = UUID("01900000-0000-7000-8000-000000000301")
SELLER_2_ID = UUID("01900000-0000-7000-8000-000000000302")
SELLER_3_ID = UUID("01900000-0000-7000-8000-000000000303")
WAIVER_STATEMENT = (
    "Je demande l'exécution immédiate du service numérique et renonce expressément "
    "à mon droit de rétractation de 14 jours conformément à l'article L221-28 du Code de la consommation."
)

SELLER_PARTY = Party(
    name="Samourai Coop",
    address="10 rue de Penthièvre",
    country="FR",
    vat_number="FR12345678901",
    postal_code="75008",
    city="Paris",
    registration_id="123456789",
)


def _parse_xml(raw: bytes) -> ET.Element:
    return ET.fromstring(raw)  # noqa: S314 - our own deterministic XML, no external input


# --- 1. 27-State EU OSS VAT & Factur-X 380 / 381 Rendering --------------------------------------


def test_eu_oss_covers_all_27_member_states_and_preserves_b2b_regimes() -> None:
    assert len(vat.EU_OSS_RATES_BP) == 27
    assert set(vat.REGIMES) == {"fr_standard", "eu_reverse_charge", "exempt", "outside_eu"}
    assert vat.EU_OSS_RATES_BP["FR"] == 2000
    assert vat.EU_OSS_RATES_BP["DE"] == 1900
    assert vat.EU_OSS_RATES_BP["FI"] == 2550
    assert vat.EU_OSS_RATES_BP["HU"] == 2700
    assert vat.EU_OSS_RATES_BP["LU"] == 1700
    assert vat.EU_OSS_RATES_BP["EE"] == 2400
    assert vat.EU_OSS_RATES_BP["RO"] == 2100
    assert vat.EU_OSS_RATES_BP["SK"] == 2300

    # B2C in France uses domestic fr_standard (20 %)
    fr_b2c = vat.regime_for(country="FR", b2c=True)
    assert fr_b2c == vat.REGIMES["fr_standard"]

    # Cross-border EU B2C uses eu_oss with consumption member-state rate & statutory French mention
    for country, expected_bp in vat.EU_OSS_RATES_BP.items():
        if country == "FR":
            continue
        reg = vat.regime_for(country=country, b2c=True)
        assert reg.code == "eu_oss"
        assert reg.rate_bp == expected_bp
        assert reg.mention == vat.EU_OSS_MENTION

    # Outside-EU B2C uses outside_eu (0 %)
    ch_b2c = vat.regime_for(country="CH", b2c=True)
    assert ch_b2c == vat.REGIMES["outside_eu"]

    # Existing B2B rules remain untouched
    assert (
        vat.regime_for(country="DE", vat_number_validated=True, b2c=False).code
        == "eu_reverse_charge"
    )
    assert vat.regime_for(country="DE", vat_number_validated=False, b2c=False).code == "fr_standard"


def test_facturx_380_and_381_xml_for_eu_oss_satisfies_en16931_category_s() -> None:
    quote = boosts.quote_boost_pack(
        pack_code="boost-community",
        customer_country="FI",
        customer_kind="b2c",
    )
    assert quote.vat_regime.code == "eu_oss"
    assert quote.vat_regime.rate_bp == 2550
    assert quote.net_amount_minor == 2900
    assert quote.vat_amount_minor == 740
    assert quote.gross_amount_minor == 3640

    buyer_fi = Party(
        name="Aino Virtanen",
        address="Mannerheimintie 1",
        country="FI",
        vat_number=None,
        postal_code="00100",
        city="Helsinki",
    )
    inv_snap = boosts.build_boost_invoice_snapshot(
        number="KODERA-2026-00042",
        issued_at=NOW,
        due_at=NOW + timedelta(days=30),
        quote=quote,
        seller=SELLER_PARTY,
        buyer=buyer_fi,
        period_start=NOW,
        period_end=NOW + timedelta(days=30),
    )
    xml_380 = render_xml(inv_snap)
    parsed = _parse_xml(xml_380)
    assert parsed.findtext(".//ram:TypeCode", namespaces=NS) == "380"
    assert (
        parsed.findtext(".//rsm:ExchangedDocument/ram:IncludedNote/ram:Content", namespaces=NS)
        == vat.EU_OSS_MENTION
    )
    header_tax = parsed.find(
        ".//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax", namespaces=NS
    )
    assert header_tax is not None
    assert header_tax.findtext("ram:CategoryCode", namespaces=NS) == "S"
    assert header_tax.findtext("ram:RateApplicablePercent", namespaces=NS) == "25.50"
    # EN 16931 BR-S-10: Category S must not carry ram:ExemptionReason
    assert header_tax.find("ram:ExemptionReason", namespaces=NS) is None

    # Partial refund 381 credit note + remaining refund 381 credit note
    net_1, vat_1 = boosts.split_gross_refund(
        original_net_minor=2900,
        original_vat_minor=740,
        original_gross_minor=3640,
        previously_refunded_gross_minor=0,
        previously_refunded_net_minor=0,
        refund_gross_minor=1820,
    )
    cn_snap_1 = boosts.build_boost_refund_credit_note_snapshot(
        credit_note_number="AV-KODERA-2026-00001",
        issued_at=NOW + timedelta(days=2),
        invoice_snapshot=inv_snap,
        delta_net_minor=net_1,
        delta_vat_minor=vat_1,
    )
    xml_381 = render_xml(cn_snap_1)
    parsed_cn = _parse_xml(xml_381)
    assert parsed_cn.findtext(".//ram:TypeCode", namespaces=NS) == "381"
    assert (
        parsed_cn.findtext(".//ram:InvoiceReferencedDocument/ram:IssuerAssignedID", namespaces=NS)
        == "KODERA-2026-00042"
    )

    net_2, vat_2 = boosts.split_gross_refund(
        original_net_minor=2900,
        original_vat_minor=740,
        original_gross_minor=3640,
        previously_refunded_gross_minor=1820,
        previously_refunded_net_minor=net_1,
        refund_gross_minor=1820,
        vat_rate_bp=2550,
    )
    assert net_1 + net_2 == 2900
    assert vat_1 + vat_2 == 740

    # Incoherent cent slice that violates EN 16931 BR-S-09 is refused closed
    with pytest.raises(boosts.BoostValidationError):
        boosts.split_gross_refund(
            original_net_minor=2900,
            original_vat_minor=740,
            original_gross_minor=3640,
            previously_refunded_gross_minor=0,
            previously_refunded_net_minor=0,
            refund_gross_minor=1819,
            vat_rate_bp=2550,
        )

    # Invalid eu_oss rate or domestic country is refused closed
    bad_snap = Snapshot(
        **{
            **inv_snap.__dict__,
            "buyer": Party(name="Jean", address="1 rue", country="FR", vat_number=None),
        }
    )
    with pytest.raises(IntegrityRefusedError, match="document_vat_oss_invalid"):
        render_xml(bad_snap)


# --- 2. Volet A — B2C Art. L221-28 Waiver, Credits & Overlapping Boost Quotas -------------------


def test_volet_a_b2c_waiver_enforcement_and_overlapping_quota_recomputation() -> None:
    with pytest.raises(boosts.WithdrawalWaiverRequiredError):
        boosts.verify_b2c_withdrawal_waiver(
            customer_kind="b2c",
            scope=f"volet-a:{WS_ID}",
            offer_code="boost-starter",
            buyer_ref=str(USER_ID),
            withdrawal_waiver_accepted=False,
            withdrawal_waiver_at=NOW,
            withdrawal_waiver_statement=WAIVER_STATEMENT,
            now=NOW,
        )

    with pytest.raises(boosts.WithdrawalWaiverRequiredError):
        boosts.verify_b2c_withdrawal_waiver(
            customer_kind="b2c",
            scope=f"volet-a:{WS_ID}",
            offer_code="boost-starter",
            buyer_ref=str(USER_ID),
            withdrawal_waiver_accepted=True,
            withdrawal_waiver_at=None,
            withdrawal_waiver_statement=WAIVER_STATEMENT,
            now=NOW,
        )

    accepted, recorded_at, evidence = boosts.verify_b2c_withdrawal_waiver(
        customer_kind="b2c",
        scope=f"volet-a:{WS_ID}",
        offer_code="boost-starter",
        buyer_ref=str(USER_ID),
        withdrawal_waiver_accepted=True,
        withdrawal_waiver_at=NOW - timedelta(seconds=3),
        withdrawal_waiver_statement=WAIVER_STATEMENT,
        now=NOW,
    )
    assert accepted is True
    assert recorded_at == NOW - timedelta(seconds=3)
    assert evidence is not None and evidence.startswith("l221-28:v2:")
    _, _, evidence_second = boosts.verify_b2c_withdrawal_waiver(
        customer_kind="b2c",
        scope=f"volet-a:{WS_ID}",
        offer_code="boost-starter",
        buyer_ref=str(USER_ID),
        withdrawal_waiver_accepted=True,
        withdrawal_waiver_at=NOW - timedelta(seconds=3),
        withdrawal_waiver_statement=WAIVER_STATEMENT,
        now=NOW,
    )
    assert evidence_second != evidence  # Random per-row 128-bit salt preventsrainbow/correlation

    # Stale timestamp (> 1h old) and non-canonical free-form waiver text are refused
    with pytest.raises(boosts.WithdrawalWaiverRequiredError):
        boosts.verify_b2c_withdrawal_waiver(
            customer_kind="b2c",
            scope=f"volet-a:{WS_ID}",
            offer_code="boost-starter",
            buyer_ref=str(USER_ID),
            withdrawal_waiver_accepted=True,
            withdrawal_waiver_at=NOW - timedelta(hours=2),
            withdrawal_waiver_statement=WAIVER_STATEMENT,
            now=NOW,
        )
    with pytest.raises(boosts.WithdrawalWaiverRequiredError):
        boosts.verify_b2c_withdrawal_waiver(
            customer_kind="b2c",
            scope=f"volet-a:{WS_ID}",
            offer_code="boost-starter",
            buyer_ref=str(USER_ID),
            withdrawal_waiver_accepted=True,
            withdrawal_waiver_at=NOW - timedelta(seconds=3),
            withdrawal_waiver_statement="I accept everything arbitrarily",
            now=NOW,
        )

    # Hosting credit partial then full refund adjustment
    ref_1, rem_1, state_1 = boosts.apply_credit_refund_delta(
        granted_minor=3000,
        consumed_minor=400,
        previously_refunded_minor=0,
        original_gross_minor=3480,
        previously_refunded_gross_minor=0,
        refund_gross_minor=1740,
    )
    assert (ref_1, rem_1, state_1) == (1500, 1100, "active")

    ref_2, rem_2, state_2 = boosts.apply_credit_refund_delta(
        granted_minor=3000,
        consumed_minor=400,
        previously_refunded_minor=ref_1,
        original_gross_minor=3480,
        previously_refunded_gross_minor=1740,
        refund_gross_minor=1740,
    )
    assert (ref_2, rem_2, state_2) == (2600, 0, "revoked")

    # Overlapping grants: two active boosts + one expired -> refunding one keeps the other active
    g1 = boosts.BoostGrantSummary(
        "active",
        seats_delta=10,
        storage_bytes_delta=10 * boosts.GIB,
        expires_at=NOW + timedelta(days=20),
    )
    g2 = boosts.BoostGrantSummary(
        "active",
        seats_delta=35,
        storage_bytes_delta=50 * boosts.GIB,
        expires_at=NOW + timedelta(days=25),
    )
    g_exp = boosts.BoostGrantSummary(
        "active",
        seats_delta=100,
        storage_bytes_delta=200 * boosts.GIB,
        expires_at=NOW - timedelta(minutes=1),
    )

    both_active = boosts.compute_effective_workspace_quota(
        base_policy_ref="community:free",
        base_seats=25,
        base_storage_bytes=5 * boosts.GIB,
        grants=[g1, g2, g_exp],
        now=NOW,
    )
    assert both_active.seats == 70
    assert both_active.storage_bytes == 65 * boosts.GIB
    assert both_active.active_boost_count == 2

    after_g1_refund = boosts.compute_effective_workspace_quota(
        base_policy_ref="community:free",
        base_seats=25,
        base_storage_bytes=5 * boosts.GIB,
        grants=[
            boosts.BoostGrantSummary(
                "refunded",
                seats_delta=10,
                storage_bytes_delta=10 * boosts.GIB,
                expires_at=g1.expires_at,
            ),
            g2,
            g_exp,
        ],
        now=NOW,
    )
    assert after_g1_refund.seats == 60
    assert after_g1_refund.storage_bytes == 55 * boosts.GIB
    assert after_g1_refund.active_boost_count == 1


# --- 3. Volet B — Durable Connect Onboarding, Split Bounds, Webhooks & Matrix/LiveKit -----------


def test_configured_fake_provider_supports_connect(monkeypatch: pytest.MonkeyPatch) -> None:
    from django.conf import settings

    from apps.billing.payments import configured_provider

    monkeypatch.setattr(settings, "KODERA_PAYMENT_PROVIDER", "fake")
    monkeypatch.setattr(settings, "KODERA_FAKE_PROVIDER_SECRET", b"h31-configured-connect-test")
    adapter = configured_provider()
    assert isinstance(adapter, FakePaymentsAdapter)
    account = adapter.create_connect_account(
        idempotency_key="h31-configured-connect",
        country="FR",
        seller_legal_name="Synthetic Seller",
        workspace_id=str(WS_ID),
    )
    link = adapter.create_connect_onboarding_link(
        account_id=account.account_id,
        refresh_url="https://app.localhost/connect/refresh",
        return_url="https://app.localhost/connect/return",
    )
    assert account.account_id in link.url
    assert configured_provider() is adapter


def test_tax_reporting_refuses_missing_seal_key_and_operator_country(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from django.conf import settings

    from apps.billing.configuration import Issuer

    monkeypatch.setattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    with pytest.raises(SealError, match="not configured"):
        vip_connect.seal_tax_tin(
            raw_tin="FR000000000", organisation_id=ORG_ID, workspace_id=WS_ID, country="FR"
        )
    with pytest.raises(SealError, match="not configured"):
        vip_connect.unseal_tax_tin(
            sealed_tin=b"", organisation_id=ORG_ID, workspace_id=WS_ID, country="FR"
        )
    monkeypatch.setattr(
        settings,
        "KODERA_BILLING_ISSUER",
        Issuer(
            legal_name="Synthetic Issuer",
            address="Synthetic address",
            siren="000000000",
            vat_number="FR00000000000",
        ),
    )
    with pytest.raises(ValueError, match="operator country is not configured"):
        dac7.build_dac7_annual_report_from_db(reporting_year=2026)


@pytest.mark.parametrize(
    ("failure", "status", "kind"),
    [
        (boosts.WithdrawalWaiverRequiredError("Explicit waiver required"), 422, "validation-error"),
        (vip_connect.ConnectOutcomeUnknownError("Reconciliation required"), 409, "conflict"),
        (vip_connect.ConnectAccountNotReadyError("Onboarding required"), 409, "conflict"),
        (ReturnUrlRefusedError(), 400, "malformed-request"),
        (ReturnUrlRequiredError(), 400, "malformed-request"),
    ],
)
def test_monetization_problem_types_are_registered(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, status: int, kind: str
) -> None:
    from django.test import RequestFactory

    monkeypatch.setattr(monetization, "_authenticate_tenant_request", lambda *args, **kwargs: None)

    def produce(
        _verified: object, _key: str, _payload: dict[str, Any]
    ) -> tuple[int, dict[str, Any]]:
        raise failure

    request = RequestFactory().post(
        "/api/v1/organisations/workspace/monetization/boosts/checkout",
        data={},
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="h31-problem-types",
    )
    response = monetization._run_post(
        request,
        organisation_id=ORG_ID,
        operation=monetization_op.CREATE_WORKSPACE_BOOST_CHECKOUT,
        require_idempotency_key=True,
        produce=produce,
    )
    body = json.loads(response.content)
    assert response.status_code == status
    assert body["status"] == status
    assert body["type"] == f"https://kodera.io/problems/{kind}"
    assert body["request_id"] == response["X-Request-Id"]
    if str(failure):
        assert body["detail"] == str(failure)


@pytest.mark.parametrize(
    ("key", "kind"), [("", "idempotency-key-missing"), ("bad key", "malformed-request")]
)
def test_monetization_distinguishes_missing_and_malformed_idempotency_keys(
    monkeypatch: pytest.MonkeyPatch, key: str, kind: str
) -> None:
    from django.test import RequestFactory

    monkeypatch.setattr(monetization, "_authenticate_tenant_request", lambda *args, **kwargs: None)

    def produce(
        _verified: object, _key: str, _payload: dict[str, Any]
    ) -> tuple[int, dict[str, Any]]:
        pytest.fail("invalid idempotency key reached the mutation")

    request = RequestFactory().post(
        "/api/v1/organisations/workspace/monetization/boosts/checkout",
        data={},
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    response = monetization._run_post(
        request,
        organisation_id=ORG_ID,
        operation=monetization_op.CREATE_WORKSPACE_BOOST_CHECKOUT,
        require_idempotency_key=True,
        produce=produce,
    )
    assert response.status_code == 400
    assert json.loads(response.content)["type"] == f"https://kodera.io/problems/{kind}"


def test_connect_onboarding_persists_account_before_link_and_refuses_blind_retry_on_timeout() -> (
    None
):
    adapter = FakePaymentsAdapter()

    # 1. Timeout during creation transitions to outcome_unknown and refuses blind retry
    timeout_record = vip_connect.DurableConnectOnboardingRecord(
        organisation_id=ORG_ID,
        workspace_id=WS_ID,
        operation_idempotency_key="op-connect-timeout-1",
        seller_legal_name="Studio K",
        tax_residence_country="FR",
    )
    adapter.fail_next_connect_create_timeout = True
    with pytest.raises(vip_connect.ConnectOutcomeUnknownError):
        vip_connect.step_connect_onboarding(
            timeout_record,
            provider=adapter,
            refresh_url="https://app.kodera.invalid/connect/refresh",
            return_url="https://app.kodera.invalid/connect/return",
        )
    assert timeout_record.onboarding_state == "outcome_unknown"
    assert adapter.onboarding_links == []
    with pytest.raises(vip_connect.ConnectOutcomeUnknownError):
        vip_connect.step_connect_onboarding(
            timeout_record,
            provider=adapter,
            refresh_url="https://app.kodera.invalid/connect/refresh",
            return_url="https://app.kodera.invalid/connect/return",
        )

    # 2. Normal creation checkpoints acct_... BEFORE calling create_connect_onboarding_link
    record = vip_connect.DurableConnectOnboardingRecord(
        organisation_id=ORG_ID,
        workspace_id=WS_ID,
        operation_idempotency_key="op-connect-clean-2",
        seller_legal_name="Guild Creator",
        tax_residence_country="DE",
    )
    link = vip_connect.step_connect_onboarding(
        record,
        provider=adapter,
        refresh_url="https://app.kodera.invalid/connect/refresh",
        return_url="https://app.kodera.invalid/connect/return",
    )
    assert record.stripe_connect_account_id == "acct_fake000001"
    assert record.persisted_checkpoints == [
        ("intent_recorded", None),
        ("account_created", "acct_fake000001"),
        ("onboarding_link_issued", "acct_fake000001"),
    ]
    assert link.url == "https://connect.fake.invalid/setup/acct_fake000001"

    # Restricted account cannot accept destination charges until reconciled active
    with pytest.raises(ProviderRefusedError, match="cannot accept charges"):
        adapter.create_link(
            LinkRequest(
                invoice_id=ENT_1_ID,
                invoice_number="VIP-GOLD",
                amount_minor=1190,
                currency="EUR",
                expires_at=NOW + timedelta(hours=2),
                return_url="https://app.kodera.invalid/vip",
                locale="fr",
                connect_destination_account="acct_fake000001",
                application_fee_amount_minor=290,
            )
        )


def test_tin_sealing_and_stripe_connect_link_fee_bounds_and_no_invoice_creation() -> None:
    seal_key = bytes(range(32))
    sealed = vip_connect.seal_tax_tin(
        raw_tin="DE998877665",
        organisation_id=ORG_ID,
        workspace_id=WS_ID,
        country="DE",
        seal_key=seal_key,
    )
    assert b"DE998877665" not in sealed
    assert (
        vip_connect.unseal_tax_tin(
            sealed_tin=sealed,
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            country="DE",
            seal_key=seal_key,
        )
        == "DE998877665"
    )
    with pytest.raises(SealError):
        vip_connect.unseal_tax_tin(
            sealed_tin=sealed,
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            country="FR",
            seal_key=seal_key,
        )

    # Fee bounds: 0 <= fee < amount_minor
    for invalid_fee in (-1, 1200, 1500):
        with pytest.raises(ProviderRefusedError):
            LinkRequest(
                invoice_id=ENT_1_ID,
                invoice_number="VIP-1",
                amount_minor=1200,
                currency="EUR",
                expires_at=NOW + timedelta(hours=1),
                return_url="https://app.kodera.invalid/return",
                locale="fr",
                connect_destination_account="acct_test123",
                application_fee_amount_minor=invalid_fee,
            )
    with pytest.raises(ProviderRefusedError):
        LinkRequest(
            invoice_id=ENT_1_ID,
            invoice_number="VIP-1",
            amount_minor=1200,
            currency="EUR",
            expires_at=NOW + timedelta(hours=1),
            return_url="https://app.kodera.invalid/return",
            locale="fr",
            connect_destination_account=None,
            application_fee_amount_minor=100,
        )

    captured_forms: list[dict[str, list[str]]] = []

    def stub_transport(method: str, url: str, headers: object, body: bytes) -> tuple[int, bytes]:
        del method, url, headers
        captured_forms.append(urllib.parse.parse_qs(body.decode("utf-8")))
        return 200, json.dumps(
            {
                "id": "cs_test_connect_01",
                "url": "https://checkout.stripe.invalid/c/01",
                "expires_at": int((NOW + timedelta(hours=2)).timestamp()),
            }
        ).encode("utf-8")

    provider = StripeProvider(
        secret_key="rk_test_" + "SyntheticConnectKey01",
        webhook_secret="whsec_" + "synthetic-connect-secret",
        transport=stub_transport,
        clock=lambda: NOW.timestamp(),
    )
    provider.create_link(
        LinkRequest(
            invoice_id=ENT_1_ID,
            invoice_number="VIP-1",
            amount_minor=1200,
            currency="EUR",
            expires_at=NOW + timedelta(hours=2),
            return_url="https://app.kodera.invalid/return",
            locale="fr",
            connect_destination_account="acct_creator01",
            application_fee_amount_minor=300,
            payment_methods=("card",),
            reference_kind="vip_pass",
            checkout_label="Pass VIP — Salon Or",
            metadata={"volet": "b_vip"},
        )
    )
    form = captured_forms[0]
    assert form["payment_method_types[0]"] == ["card"]
    assert "payment_method_types[1]" not in form
    assert form["line_items[0][price_data][product_data][name]"] == ["Pass VIP — Salon Or"]
    assert "metadata[core_invoice_id]" not in form
    assert "payment_intent_data[metadata][core_invoice_id]" not in form
    assert form["payment_intent_data[transfer_data][destination]"] == ["acct_creator01"]
    assert form["payment_intent_data[application_fee_amount]"] == ["300"]
    assert not any("invoice_creation" in key for key in form)
    assert not any("tax" in key for key in form)

    # Disputing an already fully refunded VIP pass charges only the dispute fee (0 phantom cents)
    zero_rem_cb = vip_connect.compute_chargeback_ledger_entry(
        remaining_excl_vat_minor=0,
        remaining_vat_minor=0,
        remaining_application_fee_minor=0,
        dispute_fee_minor=1500,
        available_creator_balance_minor=0,
        current_negative_balance_minor=200,
    )
    assert zero_rem_cb.gross_excl_vat_minor == 0
    assert zero_rem_cb.creator_net_minor == -1500
    assert zero_rem_cb.new_negative_balance_minor == 1700


def test_webhook_idempotency_negative_balance_chargeback_and_livekit_matrix_convergence() -> None:
    adapter = FakePaymentsAdapter()
    dedup = OfflineWebhookDeduplicator(webhook_secret=adapter.stripe_webhook_secret)
    ts = int(NOW.timestamp())

    # Simulated workspace IAM, Matrix policy, and LiveKit room state
    held_roles: set[tuple[UUID, UUID, UUID]] = set()
    authority_rev = 1
    member_sets: list[str] = []
    channel_sets: list[str] = []
    buyer_mxid = "@alice:guild.kodera.invalid"
    agent_mxid = "@_kodera_agent:guild.kodera.invalid"
    room_id = "!vip-voice:guild.kodera.invalid"

    class FakeMatrix:
        def __init__(self) -> None:
            self.policy: dict[str, object] = project_vip_room_policy(
                kind="audio", admitted_matrix_users=[]
            )
            self.joined: set[str] = {agent_mxid}

        def whoami(self, access_token: str) -> tuple[str, str | None]:
            if access_token == "tok-alice":
                return buyer_mxid, "DEV1"
            raise AssertionError("unknown token")

        def membership(self, target_room: str, user_id: str) -> str:
            assert target_room == room_id
            return "join" if user_id in self.joined else "leave"

        def joined_members(self, target_room: str) -> set[str]:
            assert target_room == room_id
            return set(self.joined)

        def state_event(
            self, target_room: str, event_type: str, state_key: str = ""
        ) -> dict[str, object] | None:
            del state_key
            assert target_room == room_id
            if event_type == POLICY:
                return {"sender": agent_mxid, "content": self.policy}
            return None

        def state(
            self, target_room: str, event_type: str, state_key: str = ""
        ) -> dict[str, object] | None:
            del target_room, event_type, state_key
            return None

        def put_state(
            self, target_room: str, event_type: str, content: dict[str, object], state_key: str = ""
        ) -> None:
            del target_room, event_type, content, state_key

    class FakeLiveKit:
        def __init__(self) -> None:
            self.participants_map: dict[str, dict[str, object]] = {}
            self.removed: list[str] = []

        def create_room(self, name: str, metadata: str) -> None:
            del name, metadata

        def token(
            self,
            room: str,
            participant_identity: str,
            *,
            can_publish: bool,
            ttl_s: int,
        ) -> str:
            del room, ttl_s
            self.participants_map[participant_identity] = {
                "identity": participant_identity,
                "permission": {"can_publish": can_publish},
                "tracks": [],
            }
            return f"lk-jwt-{participant_identity}"

        def participants(self, room: str) -> list[dict[str, object]]:
            return list(self.participants_map.values()) if room else []

        def remove(self, room: str, participant_identity: str) -> None:
            del room
            self.removed.append(participant_identity)
            self.participants_map.pop(participant_identity, None)

        def set_publish(self, room: str, participant_identity: str, can_publish: bool) -> None:
            del room, participant_identity, can_publish

    matrix = FakeMatrix()
    livekit = FakeLiveKit()
    room_service = RoomAccessService(
        matrix=matrix,  # type: ignore[arg-type]
        livekit=livekit,  # type: ignore[arg-type]
        ws_url="wss://livekit.kodera.invalid",
        agent=agent_mxid,
    )

    def sync_matrix_projection() -> None:
        admitted = [buyer_mxid] if (WS_ID, MEMBER_ID, VIP_ROLE_ID) in held_roles else []
        matrix.policy = project_vip_room_policy(kind="audio", admitted_matrix_users=admitted)
        if admitted:
            matrix.joined.add(buyer_mxid)
        else:
            matrix.joined.discard(buyer_mxid)

    def bump_rev(_org: UUID) -> int:
        nonlocal authority_rev
        authority_rev += 1
        return authority_rev

    def record_chan(_org: UUID, _ws: UUID, reason: str) -> None:
        channel_sets.append(reason)
        sync_matrix_projection()

    ports = VipConvergencePorts(
        has_role=lambda ws, mem, role: (ws, mem, role) in held_roles,
        grant_role=lambda ws, mem, role: held_roles.add((ws, mem, role)),
        revoke_role=lambda ws, mem, role: held_roles.discard((ws, mem, role)),
        bump_authority_revision=bump_rev,
        record_member_set=lambda _org, reason: member_sets.append(reason),
        record_channel_set=record_chan,
    )

    # Before purchase: Alice is denied LiveKit admission (403)
    with pytest.raises(RefusedError) as denied_before:
        room_service.grant("tok-alice", room_id)
    assert denied_before.value.status == 403

    quote = vip_connect.quote_vip_pass(
        tier_code="vip-gold",
        billing_period="monthly",
        price_excl_vat_minor=1000,
        platform_fee_bps=1000,
        buyer_country="DE",
        customer_kind="b2c",
    )
    assert quote.vat_regime.code == "eu_oss"
    assert (
        quote.gross_excl_vat_minor,
        quote.vat_amount_minor,
        quote.total_incl_vat_minor,
        quote.application_fee_amount_minor,
        quote.stripe_application_fee_minor,
        quote.creator_net_minor,
    ) == (1000, 190, 1190, 100, 290, 900)

    ledger: list[vip_connect.SplitComputation] = []
    negative_balance = 0
    windows: dict[UUID, vip_connect.VipEntitlementGrantWindow] = {
        ENT_1_ID: vip_connect.VipEntitlementGrantWindow(
            ENT_1_ID, MEMBER_ID, VIP_ROLE_ID, "pending_payment", NOW + timedelta(days=30)
        ),
        ENT_2_ID: vip_connect.VipEntitlementGrantWindow(
            ENT_2_ID, MEMBER_ID, VIP_ROLE_ID, "active", NOW + timedelta(days=20)
        ),
    }

    def webhook_router(
        event_id: str,
        event_type: str,
        _occurred_at: datetime,
        data_obj: object,
    ) -> str:
        nonlocal negative_balance
        del event_id
        assert isinstance(data_obj, dict)
        if event_type == "checkout.session.completed":
            windows[ENT_1_ID] = vip_connect.VipEntitlementGrantWindow(
                ENT_1_ID, MEMBER_ID, VIP_ROLE_ID, "active", NOW + timedelta(days=30)
            )
            sale = vip_connect.compute_sale_ledger_entry(
                quote=quote,
                current_negative_balance_minor=negative_balance,
            )
            negative_balance = sale.new_negative_balance_minor
            ledger.append(sale)
            vip_connect.converge_vip_entitlement_windows(
                list(windows.values()),
                organisation_id=ORG_ID,
                workspace_id=WS_ID,
                membership_id=MEMBER_ID,
                role_id=VIP_ROLE_ID,
                reason="vip.activated",
                now=NOW,
                ports=ports,
            )
            return "applied"
        if event_type == "charge.refunded":
            # Refund ENT_2_ID while ENT_1_ID remains active -> overlapping grant retains role!
            windows[ENT_2_ID] = vip_connect.VipEntitlementGrantWindow(
                ENT_2_ID, MEMBER_ID, VIP_ROLE_ID, "refunded", NOW + timedelta(days=20)
            )
            ref = vip_connect.compute_refund_ledger_entry(
                original_excl_vat_minor=1000,
                original_vat_minor=190,
                original_total_incl_vat_minor=1190,
                original_application_fee_minor=100,
                previously_refunded_incl_vat_minor=0,
                previously_refunded_excl_vat_minor=0,
                previously_refunded_fee_minor=0,
                refund_incl_vat_minor=1190,
                available_creator_balance_minor=max(0, sum(x.creator_net_minor for x in ledger)),
                current_negative_balance_minor=negative_balance,
            )
            negative_balance = ref.new_negative_balance_minor
            ledger.append(ref)
            vip_connect.converge_vip_entitlement_windows(
                list(windows.values()),
                organisation_id=ORG_ID,
                workspace_id=WS_ID,
                membership_id=MEMBER_ID,
                role_id=VIP_ROLE_ID,
                reason="vip.refunded",
                now=NOW,
                ports=ports,
            )
            return "applied"
        if event_type == "charge.dispute.created":
            if str(data_obj.get("status", "")).startswith("warning_"):
                return "ignored"
            windows[ENT_1_ID] = vip_connect.VipEntitlementGrantWindow(
                ENT_1_ID, MEMBER_ID, VIP_ROLE_ID, "disputed", NOW + timedelta(days=30)
            )
            cb = vip_connect.compute_chargeback_ledger_entry(
                remaining_excl_vat_minor=1000,
                remaining_vat_minor=190,
                remaining_application_fee_minor=100,
                dispute_fee_minor=1500,
                available_creator_balance_minor=max(0, sum(x.creator_net_minor for x in ledger)),
                current_negative_balance_minor=negative_balance,
            )
            negative_balance = cb.new_negative_balance_minor
            ledger.append(cb)
            vip_connect.converge_vip_entitlement_windows(
                list(windows.values()),
                organisation_id=ORG_ID,
                workspace_id=WS_ID,
                membership_id=MEMBER_ID,
                role_id=VIP_ROLE_ID,
                reason="vip.disputed",
                now=NOW,
                ports=ports,
            )
            return "applied"
        return "ignored_event_type"

    # Tampered signature rejected
    raw_cs, hdr_cs = adapter.build_signed_stripe_webhook(
        event_id="evt_vip_cs_1",
        event_type="checkout.session.completed",
        data_object={"id": "cs_fake_001", "payment_intent": "pi_vip_1", "payment_status": "paid"},
        created_ts=ts,
    )
    with pytest.raises(StripeWebhookSignatureError):
        dedup.receive(
            raw_body=raw_cs,
            headers={"Stripe-Signature": f"t={ts},v1={'0' * 64}"},
            handler=webhook_router,
            clock=lambda: float(ts),
        )

    # 1. Activate ENT_1 -> role granted & LiveKit admits Alice
    r1 = dedup.receive(
        raw_body=raw_cs, headers=hdr_cs, handler=webhook_router, clock=lambda: float(ts)
    )
    assert r1.status == "applied"
    r1_dup = dedup.receive(
        raw_body=raw_cs, headers=hdr_cs, handler=webhook_router, clock=lambda: float(ts)
    )
    assert r1_dup.status == "duplicate"
    assert len(ledger) == 1

    grant_token = room_service.grant("tok-alice", room_id)
    assert grant_token.token.startswith("lk-jwt-")
    assert len(livekit.participants_map) == 1

    # 2. Refund ENT_2 while ENT_1 still active -> role retained & Alice stays in LiveKit call!
    raw_ref, hdr_ref = adapter.build_signed_stripe_webhook(
        event_id="evt_vip_ref_2",
        event_type="charge.refunded",
        data_object={
            "id": "ch_2",
            "payment_intent": "pi_vip_2",
            "amount_refunded": 1190,
            "currency": "eur",
        },
        created_ts=ts + 10,
    )
    assert (
        dedup.receive(
            raw_body=raw_ref, headers=hdr_ref, handler=webhook_router, clock=lambda: float(ts + 10)
        ).status
        == "applied"
    )
    assert (WS_ID, MEMBER_ID, VIP_ROLE_ID) in held_roles
    room_service.refresh(livekit_room(room_id), room_id)
    assert livekit.removed == []

    # 3. Inquiry warning_needs_response ignored
    raw_inq, hdr_inq = adapter.build_signed_stripe_webhook(
        event_id="evt_vip_inq_3",
        event_type="charge.dispute.created",
        data_object={
            "id": "dp_inq",
            "payment_intent": "pi_vip_1",
            "amount": 1190,
            "currency": "eur",
            "status": "warning_needs_response",
        },
        created_ts=ts + 15,
    )
    assert (
        dedup.receive(
            raw_body=raw_inq, headers=hdr_inq, handler=webhook_router, clock=lambda: float(ts + 15)
        ).status
        == "ignored"
    )
    assert (WS_ID, MEMBER_ID, VIP_ROLE_ID) in held_roles

    # 4. Real chargeback on ENT_1 -> revokes role, creates negative balance (2400 cents), and evicts Alice from LiveKit & Matrix!
    raw_dp, hdr_dp = adapter.build_signed_stripe_webhook(
        event_id="evt_vip_dp_4",
        event_type="charge.dispute.created",
        data_object={
            "id": "dp_real",
            "payment_intent": "pi_vip_1",
            "amount": 1190,
            "currency": "eur",
            "status": "needs_response",
        },
        created_ts=ts + 20,
    )
    assert (
        dedup.receive(
            raw_body=raw_dp, headers=hdr_dp, handler=webhook_router, clock=lambda: float(ts + 20)
        ).status
        == "applied"
    )
    assert (WS_ID, MEMBER_ID, VIP_ROLE_ID) not in held_roles
    assert negative_balance == 2400

    # LiveKit guard immediately evicts active call participant and refuses new tokens
    room_service.refresh(livekit_room(room_id), room_id)
    assert len(livekit.removed) == 1
    assert livekit.participants_map == {}
    with pytest.raises(RefusedError) as denied_after:
        room_service.grant("tok-alice", room_id)
    assert denied_after.value.status == 403

    # Subsequent sale recovers 899 cents of negative balance (bounded so 290 + 899 = 1189 < 1190 TTC) -> 1501 remaining
    recovery = vip_connect.compute_sale_ledger_entry(
        quote=quote,
        current_negative_balance_minor=negative_balance,
    )
    assert recovery.negative_balance_delta_minor == -899
    assert recovery.new_negative_balance_minor == 1501


# --- 4. DAC7 (Directive (EU) 2021/514) Annual Reporting Thresholds & Export ---------------------


def test_dac7_annual_aggregator_threshold_boundaries_and_json_xml_exports() -> None:
    sellers = [
        dac7.Dac7SellerInput(
            connect_account_id=SELLER_1_ID,
            organisation_id=ORG_ID,
            workspace_id=WS_ID,
            stripe_connect_account_id="acct_seller1",
            seller_legal_name="Below Threshold Seller",
            tax_residence_country="FR",
            tax_tin="FR9911223344",
        ),
        dac7.Dac7SellerInput(
            connect_account_id=SELLER_2_ID,
            organisation_id=ORG_ID,
            workspace_id=UUID("01900000-0000-7000-8000-000000000392"),
            stripe_connect_account_id="acct_seller2",
            seller_legal_name="Thirty Sales Seller",
            tax_residence_country="ES",
            tax_tin="ESB12345678",
        ),
        dac7.Dac7SellerInput(
            connect_account_id=SELLER_3_ID,
            organisation_id=ORG_ID,
            workspace_id=UUID("01900000-0000-7000-8000-000000000393"),
            stripe_connect_account_id="acct_seller3",
            seller_legal_name="High Consideration Seller",
            tax_residence_country="DE",
            tax_tin="DE111222333",
        ),
    ]

    entries: list[dac7.Dac7LedgerEventInput] = []
    # Seller 1: 30 sales totaling 205,000 cents, minus 1 full refund of 5,000 cents -> 29 tx & 200,000 cents exact => NOT reportable!
    for i in range(29):
        net = 6800 if i < 28 else 9600  # 28 * 6800 + 9600 = 200,000 exact!
        entries.append(
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=UUID(f"01900000-0000-7000-8000-{i + 1:012d}"),
                entry_kind="sale",
                currency="EUR",
                gross_excl_vat_minor=net + 100,
                vat_amount_minor=200,
                application_fee_amount_minor=100,
                dispute_fee_minor=0,
                creator_net_minor=net,
                occurred_at=datetime(2026, 3, 10, 10, 0, tzinfo=UTC),
            )
        )
    refunded_ent = UUID("01900000-0000-7000-8000-000000009999")
    entries.extend(
        [
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=refunded_ent,
                entry_kind="sale",
                currency="EUR",
                gross_excl_vat_minor=5500,
                vat_amount_minor=1100,
                application_fee_amount_minor=500,
                dispute_fee_minor=0,
                creator_net_minor=5000,
                occurred_at=datetime(2026, 5, 1, 10, 0, tzinfo=UTC),
            ),
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=refunded_ent,
                entry_kind="refund",
                currency="EUR",
                gross_excl_vat_minor=-5500,
                vat_amount_minor=-1100,
                application_fee_amount_minor=-500,
                dispute_fee_minor=0,
                creator_net_minor=-5000,
                occurred_at=datetime(2026, 5, 3, 10, 0, tzinfo=UTC),
                fully_reversed_entitlement=True,
            ),
        ]
    )

    # Seller 2: 30 transactions of 500 cents (150.00 EUR) -> reportable via `transactions_gte_30`
    for i in range(30):
        entries.append(
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_2_ID,
                entitlement_id=UUID(f"01900000-0000-7000-8000-{1000 + i:012d}"),
                entry_kind="sale",
                currency="EUR",
                gross_excl_vat_minor=550,
                vat_amount_minor=115,
                application_fee_amount_minor=50,
                dispute_fee_minor=0,
                creator_net_minor=500,
                occurred_at=datetime(2026, (i % 4) * 3 + 1, 15, 12, 0, tzinfo=UTC),
            )
        )

    # Seller 3: 1 transaction of 200,001 cents (2,000.01 EUR) -> reportable via `consideration_gt_2000_eur`
    entries.append(
        dac7.Dac7LedgerEventInput(
            connect_account_id=SELLER_3_ID,
            entitlement_id=UUID("01900000-0000-7000-8000-000000002001"),
            entry_kind="sale",
            currency="EUR",
            gross_excl_vat_minor=220_001,
            vat_amount_minor=41_800,
            application_fee_amount_minor=20_000,
            dispute_fee_minor=0,
            creator_net_minor=200_001,
            occurred_at=datetime(2026, 11, 20, 14, 0, tzinfo=UTC),
        )
    )

    report = dac7.aggregate_dac7_annual_report(
        reporting_year=2026,
        sellers=sellers,
        entries=entries,
        platform_operator_siren="123456789",
    )
    assert report.total_sellers_evaluated == 3
    assert report.reportable_seller_count == 2
    by_id = {s.connect_account_id: s for s in report.sellers}

    s1 = by_id[str(SELLER_1_ID)]
    assert s1.transaction_count == 29
    assert s1.net_consideration_minor == 200_000
    assert s1.reportable is False

    s2 = by_id[str(SELLER_2_ID)]
    assert s2.transaction_count == 30
    assert s2.net_consideration_minor == 15_000
    assert s2.reportable is True
    assert s2.reportable_reasons == ("transactions_gte_30",)

    s3 = by_id[str(SELLER_3_ID)]
    assert s3.transaction_count == 1
    assert s3.net_consideration_minor == 200_001
    assert s3.reportable is True
    assert s3.reportable_reasons == ("consideration_gt_2000_eur",)
    assert s3.quarters[3].net_consideration_minor == 200_001

    raw_json = dac7.render_dac7_json(report)
    decoded = json.loads(raw_json.decode("utf-8"))
    assert decoded["directive"] == "2021/514/EU"
    assert decoded["reportable_seller_count"] == 2

    raw_xml = dac7.render_dac7_xml(report)
    xml_root = _parse_xml(raw_xml)
    ns = {"dpi": dac7.DPI_NS}
    reported_nodes = xml_root.findall(".//dpi:ReportableSeller", namespaces=ns)
    assert len(reported_nodes) == 2
    tins = [n.findtext("dpi:Identity/dpi:TIN", namespaces=ns) for n in reported_nodes]
    assert tins == ["ESB12345678", "DE111222333"]

    # Cross-quarter carry & prior-year DPI2 correction + XML 1.0 control char sanitization
    q1_sale_id = UUID("01900000-0000-7000-8000-000000008001")
    prior_year_sale_id = UUID("01900000-0000-7000-8000-000000008002")
    carry_report = dac7.aggregate_dac7_annual_report(
        reporting_year=2026,
        sellers=[
            dac7.Dac7SellerInput(
                connect_account_id=SELLER_1_ID,
                organisation_id=ORG_ID,
                workspace_id=WS_ID,
                stripe_connect_account_id="acct_seller1",
                seller_legal_name="Creator\x00With\x07Ctrl",
                tax_residence_country="FR",
                tax_tin=None,
                tin_present=False,
            )
        ],
        entries=[
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=q1_sale_id,
                entry_kind="sale",
                currency="EUR",
                gross_excl_vat_minor=250_000,
                vat_amount_minor=50_000,
                application_fee_amount_minor=20_000,
                dispute_fee_minor=0,
                creator_net_minor=230_000,
                occurred_at=datetime(2026, 2, 10, 12, 0, tzinfo=UTC),
            ),
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=UUID("01900000-0000-7000-8000-000000008003"),
                entry_kind="refund",
                currency="EUR",
                gross_excl_vat_minor=-20_000,
                vat_amount_minor=-4_000,
                application_fee_amount_minor=-2_000,
                dispute_fee_minor=0,
                creator_net_minor=-18_000,
                occurred_at=datetime(2026, 5, 10, 12, 0, tzinfo=UTC),
                fully_reversed_entitlement=False,
                sale_occurred_at=datetime(2026, 2, 10, 12, 0, tzinfo=UTC),
            ),
            # Refund of a 2025 sale occurring in 2026 -> DPI2 prior-year correction, does NOT reduce 2026!
            dac7.Dac7LedgerEventInput(
                connect_account_id=SELLER_1_ID,
                entitlement_id=prior_year_sale_id,
                entry_kind="refund",
                currency="EUR",
                gross_excl_vat_minor=-10_000,
                vat_amount_minor=-2_000,
                application_fee_amount_minor=-1_000,
                dispute_fee_minor=0,
                creator_net_minor=-9_000,
                occurred_at=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
                fully_reversed_entitlement=True,
                sale_occurred_at=datetime(2025, 12, 15, 12, 0, tzinfo=UTC),
            ),
        ],
        platform_operator_siren="987654321",
    )
    cs = carry_report.sellers[0]
    assert cs.seller_legal_name == "CreatorWithCtrl"
    assert cs.transaction_count == 1
    assert cs.net_consideration_minor == 212_000
    assert sum(q.net_consideration_minor for q in cs.quarters) == cs.net_consideration_minor
    assert sum(q.transaction_count for q in cs.quarters) == cs.transaction_count
    assert len(cs.prior_year_corrections) == 1
    assert cs.prior_year_corrections[0].original_reporting_year == 2025
    assert cs.prior_year_corrections[0].message_type_indic == "DPI2"
    carry_xml = _parse_xml(dac7.render_dac7_xml(carry_report))
    assert carry_xml.findtext(".//dpi:MessageTypeIndic", namespaces=ns) == "DPI2"
    tin_elem = carry_xml.find(".//dpi:ReportableSeller/dpi:Identity/dpi:TIN", namespaces=ns)
    assert tin_elem is not None and tin_elem.attrib.get("unknown") == "true"

    with pytest.raises(ValueError, match="SEALED"):
        dac7.aggregate_dac7_annual_report(
            reporting_year=2026,
            sellers=[
                dac7.Dac7SellerInput(
                    connect_account_id=SELLER_1_ID,
                    organisation_id=ORG_ID,
                    workspace_id=WS_ID,
                    stripe_connect_account_id="acct_seller1",
                    seller_legal_name="Bad TIN Seller",
                    tax_residence_country="FR",
                    tax_tin="SEALED",
                )
            ],
            entries=[],
        )


# --- 5. API Writer Role & Migration 0025 Guard Verification -------------------------------------


def test_h31_api_writer_role_and_migration_0025_least_privilege_invariants() -> None:
    h31_tables = (
        "billing_workspaceboostgrant",
        "billing_workspacehostingcredit",
        "billing_creatorconnectaccount",
        "billing_viptieroffer",
        "billing_vipmembershipentitlement",
        "billing_creatorsplitledgerentry",
    )
    for table in h31_tables:
        assert table in api_writer_role.SELECT
        assert table in api_writer_role.INSERT
        assert table not in api_writer_role.DELETE

    # Statutory DAC7 erasure snapshot table is isolated from general API reads/writes
    assert "billing_dac7sellerstatutorysnapshot" not in api_writer_role.SELECT
    assert "billing_dac7sellerstatutorysnapshot" not in api_writer_role.INSERT
    assert "billing_dac7sellerstatutorysnapshot" not in api_writer_role.DELETE

    # CreatorSplitLedgerEntry is strictly append-only; pii_scrubbed_at & immutable columns excluded
    assert not any(
        t == "billing_creatorsplitledgerentry" for t, _ in api_writer_role.UPDATE_COLUMNS
    )
    assert not any(col == "pii_scrubbed_at" for _, col in api_writer_role.UPDATE_COLUMNS)
    assert ("billing_invoice", "number") not in api_writer_role.UPDATE_COLUMNS
    assert ("billing_invoice", "total_incl_vat_minor") not in api_writer_role.UPDATE_COLUMNS
    assert ("billing_workspaceboostgrant", "invoice_id") not in api_writer_role.UPDATE_COLUMNS
    assert (
        "billing_workspaceboostgrant",
        "withdrawal_waiver_accepted",
    ) not in api_writer_role.UPDATE_COLUMNS
    assert (
        "billing_creatorconnectaccount",
        "platform_fee_bps",
    ) not in api_writer_role.UPDATE_COLUMNS
    assert (
        "billing_creatorconnectaccount",
        "stripe_platform_account_id",
    ) not in api_writer_role.UPDATE_COLUMNS
    assert (
        "billing_creatorconnectaccount",
        "stripe_livemode",
    ) not in api_writer_role.UPDATE_COLUMNS
    assert (
        "billing_issue_boost_invoice(uuid, text, integer, jsonb, jsonb, text, integer, bigint, timestamp with time zone, timestamp with time zone)"
        in api_writer_role.EXECUTE_FUNCTIONS
    )
    assert (
        "billing_issue_boost_refund_credit_note(uuid, text, bigint, bigint)"
        in api_writer_role.EXECUTE_FUNCTIONS
    )

    migration_src = (
        Path(__file__).resolve().parents[1]
        / "apps"
        / "billing"
        / "migrations"
        / "0025_volet_a_boosts_and_volet_b_vip_connect.py"
    ).read_text(encoding="utf-8")
    for table in (*h31_tables, "billing_dac7sellerstatutorysnapshot"):
        assert f"REVOKE ALL ON TABLE public.{table} FROM PUBLIC;" in migration_src
    assert (
        "REVOKE ALL ON FUNCTION public.billing_h31_resource_binding_guard() FROM PUBLIC;"
        in migration_src
    )
    assert (
        "REVOKE ALL ON FUNCTION public.billing_h31_privacy_cutoff_guard() FROM PUBLIC;"
        in migration_src
    )
    assert (
        "REVOKE ALL ON FUNCTION public.billing_h31_erasure_journal_hook() FROM PUBLIC;"
        in migration_src
    )
    assert "aa_03_h31_billing_erasure" in migration_src


# --- 6. Real PostgreSQL 16 Integration, HTTP Endpoints, Writer Role & Erasure Retention ----------


@pytest.mark.django_db(transaction=True)
def test_pg_http_endpoints_writer_role_volet_a_deferred_refunds_and_dispute_revocation(
    settings: object,
    monkeypatch: pytest.MonkeyPatch,
    http_signer: Any,  # noqa: F811
) -> None:
    import time
    import uuid as uuid_mod

    from customer_http_fixtures import configure, token as sign_token, trust_entry
    from django.db import connection
    from django.test import Client
    from test_customer_persistence_models import anchor, anchor_models, identity
    from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused

    import apps.billing.payments as payments_package
    from apps.billing.configuration import Issuer
    from apps.billing.documents import render_xml, snapshot_of
    from apps.billing.models import (
        BillingProfile,
        CreditNote,
        FiscalPeriod,
        Invoice,
        Payment,
        StripeWebhookDelivery,
        ViesConsultation,
        WorkspaceBoostGrant,
        WorkspaceHostingCredit,
    )
    from apps.workspaces.models import ResourcePolicy, Workspace, WorkspaceQuota
    from core.db.api_database_boundary import assert_writer_grants
    from core.db.api_writer_role import grant_statements

    adapter = FakePaymentsAdapter()
    monkeypatch.setattr(payments_package, "configured_provider", lambda: adapter)

    s: Any = settings
    s.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    s.KODERA_STRIPE_WEBHOOK_SECRET = adapter.stripe_webhook_secret
    s.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.localhost"})
    s.KODERA_CONTACT_SEAL_KEY = bytes(range(32))
    s.KODERA_BILLING_ISSUER = Issuer(
        legal_name="Samouraï Coop",
        address="10 rue de Penthièvre, 75008 Paris",
        country="FR",
        siren="888777666",
        vat_number="FR12888777666",
    )
    if not FiscalPeriod.objects.filter(
        issuer_siren="888777666",
        starts_at__lte=timezone.now(),
        closed_at__gt=timezone.now(),
    ).exists():
        FiscalPeriod.objects.create(
            issuer_siren="888777666",
            starts_at=timezone.now() - timedelta(days=180),
            closed_at=timezone.now() + timedelta(days=185),
            timezone="Europe/Paris",
            authority_ref="FY-202601",
        )

    models = anchor_models()
    org, _, owner_memberships = anchor(models, slug="h31-va-" + uuid_mod.uuid4().hex[:6])
    owner_user = owner_memberships[0].user
    owner_ident = identity(models, org, owner_user, subject="owner-va-" + uuid_mod.uuid4().hex[:8])
    member_user = models.User.objects.create(email="alice@example.test", enabled=True)
    member_ident = identity(
        models, org, member_user, subject="member-va-" + uuid_mod.uuid4().hex[:8]
    )
    models.Membership.objects.create(
        organisation=org,
        user=member_user,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    ts_wall = int(time.time())
    configure(s, [trust_entry(http_signer, issuer=org.issuer, expires_at=ts_wall + 600)])

    ws = Workspace.objects.create(organisation=org)
    default_pol = ResourcePolicy.objects.create(
        workspace=ws,
        visibility=ResourcePolicy.Visibility.ORGANISATION,
    )
    ws.default_policy = default_pol
    ws.save(update_fields=["default_policy", "updated_at"])
    WorkspaceQuota.objects.update_or_create(
        workspace=ws,
        defaults={
            "policy_ref": "community:free",
            "seats": 25,
            "media_bytes": 5 * boosts.GIB,
        },
    )

    # Provision least-privilege PostgreSQL role matching `kodera_api`
    role = f"h31_api_writer_{uuid_mod.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)
        assert_writer_grants(cursor, role)

    client = Client()
    member_tok = sign_token(
        http_signer, org.issuer, member_ident.subject, iat=ts_wall, exp=ts_wall + 300
    )
    owner_tok = sign_token(
        http_signer, org.issuer, owner_ident.subject, iat=ts_wall, exp=ts_wall + 300
    )
    now_iso = timezone.now().isoformat()

    try:
        with acting_as(role):
            # 1. Direct table privilege boundaries enforced by PostgreSQL (`42501`)
            assert (
                refused("UPDATE billing_invoice SET number = 'KODERA-2026-99999'")
                == INSUFFICIENT_PRIVILEGE
            )
            assert refused("DELETE FROM billing_creatorsplitledgerentry") == INSUFFICIENT_PRIVILEGE
            assert (
                refused("SELECT * FROM billing_dac7sellerstatutorysnapshot")
                == INSUFFICIENT_PRIVILEGE
            )
            assert (
                refused("UPDATE billing_workspaceboostgrant SET withdrawal_waiver_accepted = false")
                == INSUFFICIENT_PRIVILEGE
            )

            # 2. Untrusted return_url refused (`400`)
            bad_url_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/boosts/checkout",
                data=json.dumps(
                    {
                        "pack_code": "boost-community",
                        "customer_kind": "b2c",
                        "customer_country": "DE",
                        "return_url": "https://evil.attacker.invalid/steal",
                        "withdrawal_waiver_accepted": True,
                        "withdrawal_waiver_at": now_iso,
                        "withdrawal_waiver_statement": WAIVER_STATEMENT,
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {member_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-boost-bad-url-001",
            )
            assert bad_url_res.status_code == 400

            # 3. Member purchases EU OSS B2C boost under `kodera_api` role -> 201 + Factur-X 380 issued!
            checkout_body = {
                "pack_code": "boost-community",
                "customer_kind": "b2c",
                "customer_country": "FI",
                "customer_legal_name": "Matti Virtanen",
                "customer_address_line1": "Mannerheimintie 1",
                "customer_postal_code": "00100",
                "customer_city": "Helsinki",
                "return_url": "https://app.localhost/billing",
                "locale": "fr",
                "withdrawal_waiver_accepted": True,
                "withdrawal_waiver_at": now_iso,
                "withdrawal_waiver_statement": WAIVER_STATEMENT,
            }
            res_create = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/boosts/checkout",
                data=json.dumps(checkout_body),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {member_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-boost-fi-b2c-0001",
            )
            assert res_create.status_code == 201, res_create.content
            created_json = res_create.json()
            assert created_json["vat_regime"] == "eu_oss"
            assert created_json["vat_rate_bp"] == 2550
            assert created_json["gross_amount_minor"] == 3640
            assert len(adapter.links) == 1
            assert adapter.links[0].payment_methods == ("card",)

            # Idempotent replay returns identical session URL without calling Stripe again!
            res_replay = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/boosts/checkout",
                data=json.dumps(checkout_body),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {member_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-boost-fi-b2c-0001",
            )
            assert res_replay.status_code == 201
            assert res_replay.json()["checkout_session_id"] == created_json["checkout_session_id"]
            assert len(adapter.links) == 1

            # Reusing same Idempotency-Key with altered pack_code returns 409!
            res_conflict = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/boosts/checkout",
                data=json.dumps({**checkout_body, "pack_code": "boost-starter"}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {member_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-boost-fi-b2c-0001",
            )
            assert res_conflict.status_code == 409

            # 4. Out-of-order early `charge.refunded` (50% = 1820 cents) BEFORE `checkout.session.completed`!
            ts_now = int(time.time())
            raw_early_ref, hdr_early_ref = adapter.build_signed_stripe_webhook(
                event_id="evt_h31_early_ref_01",
                event_type="charge.refunded",
                data_object={
                    "id": "ch_h31_boost_01",
                    "payment_intent": "pi_h31_boost_01",
                    "amount_refunded": 1820,
                    "currency": "eur",
                },
                created_ts=ts_now,
            )
            early_res = client.post(
                "/api/v1/webhooks/stripe",
                data=raw_early_ref,
                content_type="application/json",
                HTTP_STRIPE_SIGNATURE=hdr_early_ref["Stripe-Signature"],
            )
            assert early_res.status_code == 200
            assert early_res.json()["status"] == "deferred"

            # Now `checkout.session.completed` arrives -> activates boost AND replays deferred refund!
            raw_comp, hdr_comp = adapter.build_signed_stripe_webhook(
                event_id="evt_h31_comp_01",
                event_type="checkout.session.completed",
                data_object={
                    "id": created_json["checkout_session_id"],
                    "payment_intent": "pi_h31_boost_01",
                    "payment_status": "paid",
                    "amount_total": 3640,
                    "currency": "eur",
                },
                created_ts=ts_now + 2,
            )
            comp_res = client.post(
                "/api/v1/webhooks/stripe",
                data=raw_comp,
                content_type="application/json",
                HTTP_STRIPE_SIGNATURE=hdr_comp["Stripe-Signature"],
            )
            assert comp_res.status_code == 200
            assert comp_res.json()["status"] == "applied"

            # `payment_intent.succeeded` arriving afterwards reconciles cleanly with zero alarm!
            raw_pi_ok, hdr_pi_ok = adapter.build_signed_stripe_webhook(
                event_id="evt_h31_pi_ok_01",
                event_type="payment_intent.succeeded",
                data_object={
                    "id": "pi_h31_boost_01",
                    "amount_received": 3640,
                    "currency": "eur",
                    "metadata": {
                        "volet": "a_boost",
                        "boost_grant_id": created_json["boost_grant_id"],
                    },
                },
                created_ts=ts_now + 3,
            )
            pi_res = client.post(
                "/api/v1/webhooks/stripe",
                data=raw_pi_ok,
                content_type="application/json",
                HTTP_STRIPE_SIGNATURE=hdr_pi_ok["Stripe-Signature"],
            )
            assert pi_res.status_code == 200
            assert pi_res.json()["status"] == "ignored"

        # Verify DB state after out-of-order replay:
        assert (
            StripeWebhookDelivery.objects.get(stripe_event_id="evt_h31_early_ref_01").outcome
            == "applied"
        )
        inv = Invoice.objects.get(id=created_json["invoice_id"])
        assert inv.state == "paid"
        assert inv.amount_paid_minor == 1820
        notes = list(CreditNote.objects.filter(invoice=inv, reason="refund"))
        assert len(notes) == 1
        assert notes[0].total_excl_vat_minor == 1450
        assert notes[0].vat_amount_minor == 370
        assert b"<ram:TypeCode>381</ram:TypeCode>" in render_xml(snapshot_of(notes[0]))

        credit = WorkspaceHostingCredit.objects.get(boost_grant_id=created_json["boost_grant_id"])
        assert credit.remaining_minor == 1500
        quota = WorkspaceQuota.objects.get(workspace=ws)
        assert quota.seats == 60  # 25 base + 35 boost (partial refund keeps boost active)

        # 5. B2B VIES server-derived boost + `charge.dispute.created` revoking boost & quota!
        b2b_profile = BillingProfile.objects.create(
            organisation=org,
            legal_name="Nordic Guild Oy",
            address_line1="Aleksanterinkatu 1",
            postal_code="00100",
            city="Helsinki",
            country="FI",
            vat_number="FI12345678",
            vat_number_validated_at=timezone.now(),
        )
        ViesConsultation.objects.create(
            organisation=org,
            country_code="FI",
            vat_number="FI12345678",
            status="valid",
            checked_at=timezone.now(),
            next_check_at=timezone.now() + timedelta(days=20),
            consultation_ref="VIES-REF-001",
            response_sha256="a" * 64,
            evidence={"valid": True},
        )
        del b2b_profile

        with acting_as(role):
            b2b_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/boosts/checkout",
                data=json.dumps(
                    {
                        "pack_code": "boost-starter",
                        "customer_kind": "b2b",
                        "customer_country": "FR",  # Ignored in favor of stored FI BillingProfile!
                        "return_url": "https://app.localhost/billing",
                        "locale": "en",
                        "withdrawal_waiver_accepted": False,
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-boost-fi-b2b-0002",
            )
            assert b2b_res.status_code == 201, b2b_res.content
            b2b_json = b2b_res.json()
            assert b2b_json["vat_regime"] == "eu_reverse_charge"
            assert b2b_json["vat_rate_bp"] == 0
            assert b2b_json["gross_amount_minor"] == 990

            raw_b2b_comp, hdr_b2b_comp = adapter.build_signed_stripe_webhook(
                event_id="evt_h31_b2b_comp_02",
                event_type="checkout.session.completed",
                data_object={
                    "id": b2b_json["checkout_session_id"],
                    "payment_intent": "pi_h31_b2b_02",
                    "payment_status": "paid",
                    "amount_total": 990,
                    "currency": "eur",
                },
                created_ts=ts_now + 5,
            )
            assert (
                client.post(
                    "/api/v1/webhooks/stripe",
                    data=raw_b2b_comp,
                    content_type="application/json",
                    HTTP_STRIPE_SIGNATURE=hdr_b2b_comp["Stripe-Signature"],
                ).json()["status"]
                == "applied"
            )
            assert WorkspaceQuota.objects.get(workspace=ws).seats == 70  # 25 + 35 + 10

            # Dispute on B2B boost -> revokes grant (`disputed`), marks Payment reversed, drops 10 seats!
            raw_b2b_dp, hdr_b2b_dp = adapter.build_signed_stripe_webhook(
                event_id="evt_h31_b2b_dp_02",
                event_type="charge.dispute.created",
                data_object={
                    "id": "dp_h31_b2b_02",
                    "payment_intent": "pi_h31_b2b_02",
                    "amount": 990,
                    "currency": "eur",
                    "status": "needs_response",
                },
                created_ts=ts_now + 6,
            )
            assert (
                client.post(
                    "/api/v1/webhooks/stripe",
                    data=raw_b2b_dp,
                    content_type="application/json",
                    HTTP_STRIPE_SIGNATURE=hdr_b2b_dp["Stripe-Signature"],
                ).json()["status"]
                == "applied"
            )

        assert WorkspaceBoostGrant.objects.get(id=b2b_json["boost_grant_id"]).state == "disputed"
        assert (
            Payment.objects.get(provider="stripe", provider_ref="pi_h31_b2b_02").state == "reversed"
        )
        assert WorkspaceQuota.objects.get(workspace=ws).seats == 60
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


@pytest.mark.django_db(transaction=True)
def test_pg_volet_b_connect_negative_balance_channel_gate_and_dac7_erasure_retention(
    settings: object,
    monkeypatch: pytest.MonkeyPatch,
    http_signer: Any,  # noqa: F811
) -> None:
    import time
    import uuid as uuid_mod

    from customer_http_fixtures import configure, token as sign_token, trust_entry
    from django.db import connection
    from django.test import Client
    from test_core_erasure import begin
    from test_customer_persistence_models import anchor, anchor_models, identity
    from test_intake_writer_role import acting_as

    import apps.billing.payments as payments_package
    from apps.billing.configuration import Issuer
    from apps.billing.models import (
        CreatorConnectAccount,
        Dac7SellerStatutorySnapshot,
        VipMembershipEntitlement,
        VipTierOffer,
    )
    from apps.orgs.erasure_services import purge_core
    from apps.workspaces.channel_access import may_view, resolve
    from apps.workspaces.models import (
        Channel,
        ResourcePolicy,
        ResourcePolicyRule,
        Workspace,
        WorkspaceMemberRole,
        WorkspaceQuota,
        WorkspaceRole,
    )
    from core.db.api_writer_role import grant_statements

    adapter = FakePaymentsAdapter()
    monkeypatch.setattr(payments_package, "configured_provider", lambda: adapter)

    s: Any = settings
    s.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    s.KODERA_STRIPE_WEBHOOK_SECRET = adapter.stripe_webhook_secret
    s.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.localhost"})
    s.KODERA_CONTACT_SEAL_KEY = bytes(range(32))
    s.KODERA_BILLING_ISSUER = Issuer(
        legal_name="Samouraï Coop",
        address="10 rue de Penthièvre, 75008 Paris",
        country="FR",
        siren="888777666",
        vat_number="FR12888777666",
    )

    models = anchor_models()
    org, _, owner_memberships = anchor(models, slug="h31-vb-" + uuid_mod.uuid4().hex[:6])
    owner_membership = owner_memberships[0]
    owner_ident = identity(
        models, org, owner_membership.user, subject="owner-vb-" + uuid_mod.uuid4().hex[:8]
    )
    buyer_user = models.User.objects.create(email="buyer@example.test", enabled=True)
    buyer_ident = identity(models, org, buyer_user, subject="buyer-vb-" + uuid_mod.uuid4().hex[:8])
    buyer_membership = models.Membership.objects.create(
        organisation=org,
        user=buyer_user,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    banned_user = models.User.objects.create(email="banned@example.test", enabled=True)
    identity(models, org, banned_user, subject="banned-vb-" + uuid_mod.uuid4().hex[:8])
    banned_membership = models.Membership.objects.create(
        organisation=org,
        user=banned_user,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    ts_wall = int(time.time())
    configure(s, [trust_entry(http_signer, issuer=org.issuer, expires_at=ts_wall + 600)])

    ws = Workspace.objects.create(organisation=org)
    default_pol = ResourcePolicy.objects.create(
        workspace=ws,
        visibility=ResourcePolicy.Visibility.ORGANISATION,
    )
    ResourcePolicyRule.objects.create(
        policy=default_pol,
        kind=ResourcePolicyRule.Kind.DENY_MEMBER,
        membership_id=banned_membership.id,
    )
    ws.default_policy = default_pol
    ws.save(update_fields=["default_policy", "updated_at"])
    WorkspaceQuota.objects.update_or_create(
        workspace=ws,
        defaults={"policy_ref": "community:free", "seats": 25},
    )

    vip_channel = Channel.objects.create(
        workspace=ws,
        name="vip-stage",
        kind="audio",
        position=1,
        lifecycle="active",
    )
    explicit_policy = ResourcePolicy.objects.create(
        workspace=ws,
        visibility=ResourcePolicy.Visibility.ORGANISATION,
    )
    explicit_policy_updated_at = explicit_policy.updated_at
    explicit_channel = Channel.objects.create(
        workspace=ws,
        name="vip-explicit",
        kind="text",
        position=2,
        lifecycle="active",
        policy_mode=Channel.PolicyMode.EXPLICIT,
        explicit_policy=explicit_policy,
    )
    vip_role = WorkspaceRole.objects.create(
        workspace=ws,
        organisation_id=org.id,
        name="VIP Patron",
        slug="vip-patron",
        position=1,
        permissions=["channel.view", "media.connect", "media.speak"],
    )

    role = f"h31_vb_writer_{uuid_mod.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)

    client = Client()
    owner_tok = sign_token(
        http_signer, org.issuer, owner_ident.subject, iat=ts_wall, exp=ts_wall + 300
    )
    buyer_tok = sign_token(
        http_signer, org.issuer, buyer_ident.subject, iat=ts_wall, exp=ts_wall + 300
    )
    now_iso = timezone.now().isoformat()

    try:
        from django.core.management import call_command

        with acting_as(role):
            # 0. Pre-seeded legacy `intent_recorded` row (`stripe_connect_account_id=None`) refuses
            #    onboarding resume (409) until operator `reconcile_connect_platform_cutover --apply` rebinds it!
            CreatorConnectAccount.objects.create(
                organisation=org,
                workspace=ws,
                owner_user_id=owner_membership.user_id,
                stripe_platform_account_id="acct_1QhZ8fRwfVmWKPLR",
                stripe_livemode=True,
                stripe_connect_account_id=None,
                onboarding_state="intent_recorded",
                operation_idempotency_key="0000000000000001",
                seller_legal_name="Atelier Souverain SAS",
                tax_residence_country="FR",
                last_operation_error="prior_diagnostic;platform_account_cutover_reconciliation_required",
            )
            mismatch_uncreated = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/connect/onboarding",
                data=json.dumps(
                    {
                        "seller_legal_name": "Atelier Souverain SAS",
                        "tax_residence_country": "FR",
                        "refresh_url": "https://app.localhost/connect/refresh",
                        "return_url": "https://app.localhost/connect/return",
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                HTTP_IDEMPOTENCY_KEY="0000000000000002",
            )
            assert mismatch_uncreated.status_code == 409, mismatch_uncreated.content
            assert (
                CreatorConnectAccount.objects.get(workspace_id=ws.id).stripe_connect_account_id
                is None
            )

        # Operator reconciliation runs under the privileged operator role, never `kodera_api`.
        call_command(
            "reconcile_connect_platform_cutover",
            "--target-platform-account-id",
            "acct_1UgN9jRu1W0izUsy",
            "--target-livemode",
            "false",
            "--apply",
        )
        rebound_row = CreatorConnectAccount.objects.get(workspace_id=ws.id)
        assert rebound_row.stripe_platform_account_id == "acct_1UgN9jRu1W0izUsy"
        assert rebound_row.stripe_livemode is False
        assert rebound_row.last_operation_error == "prior_diagnostic"

        with acting_as(role):
            # 1. Start Connect onboarding via HTTP -> checkpoints `acct_...` & seals TIN
            onb_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/connect/onboarding",
                data=json.dumps(
                    {
                        "seller_legal_name": "Atelier Souverain SAS",
                        "tax_residence_country": "FR",
                        "tax_tin": "FR9944556677",
                        "refresh_url": "https://app.localhost/connect/refresh",
                        "return_url": "https://app.localhost/connect/return",
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-connect-onb-0001",
            )
            assert onb_res.status_code == 200, onb_res.content
            acct_id = onb_res.json()["stripe_connect_account_id"]
            acct_row = CreatorConnectAccount.objects.get(workspace_id=ws.id)
            assert acct_row.stripe_platform_account_id == "acct_1UgN9jRu1W0izUsy"
            assert acct_row.stripe_livemode is False

            # Legacy or cross-platform connected rows refuse onboarding resume and reconciliation (409 / ConnectPlatformMismatchError).
            with override_settings(
                KODERA_STRIPE_PLATFORM_ACCOUNT_ID="acct_1UgN9ORytJJnrEun",
                KODERA_STRIPE_EXPECTED_LIVEMODE=True,
            ):
                mismatch_res = client.post(
                    f"/api/v1/organisations/{org.id}/workspace/monetization/connect/onboarding",
                    data=json.dumps(
                        {
                            "seller_legal_name": "Atelier Souverain SAS",
                            "tax_residence_country": "FR",
                            "refresh_url": "https://app.localhost/connect/refresh",
                            "return_url": "https://app.localhost/connect/return",
                        }
                    ),
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                    HTTP_IDEMPOTENCY_KEY="0000000000000003",
                )
                assert mismatch_res.status_code == 409, mismatch_res.content
                with pytest.raises(vip_connect.ConnectPlatformMismatchError):
                    vip_connect.reconcile_connect_account_status(
                        workspace_id=ws.id, provider=adapter
                    )

            # Metadata mismatch during reconciliation is refused closed!
            adapter.set_connect_account_state(
                acct_id,
                charges_enabled=True,
                payouts_enabled=True,
                details_submitted=True,
                metadata={"kodera_workspace_id": str(uuid_mod.uuid4())},
            )
            with pytest.raises(vip_connect.VipConnectValidationError, match="kodera_workspace_id"):
                vip_connect.reconcile_connect_account_status(workspace_id=ws.id, provider=adapter)

            # Valid metadata reconciles Connect account to `active`
            adapter.set_connect_account_state(
                acct_id,
                charges_enabled=True,
                payouts_enabled=True,
                details_submitted=True,
                metadata={"kodera_workspace_id": str(ws.id)},
            )
            reconciled = vip_connect.reconcile_connect_account_status(
                workspace_id=ws.id, provider=adapter
            )
            assert reconciled.onboarding_state == "active"

            # Platform/mode mismatch on `active` account refuses VIP tier publication (HTTP 409, 0 tiers written)!
            with override_settings(
                KODERA_STRIPE_PLATFORM_ACCOUNT_ID="acct_1UgN9ORytJJnrEun",
                KODERA_STRIPE_EXPECTED_LIVEMODE=True,
            ):
                tier_mismatch_res = client.post(
                    f"/api/v1/organisations/{org.id}/workspace/monetization/vip-tiers",
                    data=json.dumps(
                        {
                            "code": "vip-patron-annual",
                            "name": "Mécène Annuel",
                            "billing_period": "yearly",
                            "price_excl_vat_minor": 250_000,
                            "granted_workspace_role_id": str(vip_role.id),
                            "granted_channel_ids": [str(vip_channel.id), str(explicit_channel.id)],
                        }
                    ),
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                    HTTP_IDEMPOTENCY_KEY="0000000000000004",
                )
                assert tier_mismatch_res.status_code == 409, tier_mismatch_res.content
                assert VipTierOffer.objects.filter(workspace_id=ws.id).count() == 0

            # 2. Create VIP tier offer (> 2,000 EUR so 1 settled sale makes seller DAC7-reportable!)
            tier_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/vip-tiers",
                data=json.dumps(
                    {
                        "code": "vip-patron-annual",
                        "name": "Mécène Annuel",
                        "billing_period": "yearly",
                        "price_excl_vat_minor": 250_000,
                        "granted_workspace_role_id": str(vip_role.id),
                        "granted_channel_ids": [str(vip_channel.id), str(explicit_channel.id)],
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-vip-tier-create-01",
            )
            assert tier_res.status_code == 201, tier_res.content
            tier_id = tier_res.json()["id"]

            # Platform OR livemode mismatch on published tier refuses VIP pass checkout (HTTP 409, 0 entitlements)!
            for bad_settings, idem_suffix in (
                ({"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UgN9ORytJJnrEun"}, "1"),
                ({"KODERA_STRIPE_EXPECTED_LIVEMODE": True}, "2"),
            ):
                with override_settings(**bad_settings):
                    chk_mismatch = client.post(
                        f"/api/v1/organisations/{org.id}/workspace/monetization/vip-passes/checkout",
                        data=json.dumps(
                            {
                                "tier_id": tier_id,
                                "customer_kind": "b2c",
                                "buyer_country": "DE",
                                "return_url": "https://app.localhost/vip/return",
                                "withdrawal_waiver_accepted": True,
                                "withdrawal_waiver_at": now_iso,
                                "withdrawal_waiver_statement": WAIVER_STATEMENT,
                            }
                        ),
                        content_type="application/json",
                        HTTP_AUTHORIZATION=f"Bearer {buyer_tok}",
                        HTTP_IDEMPOTENCY_KEY=f"000000000000005{idem_suffix}",
                    )
                    assert chk_mismatch.status_code == 409, chk_mismatch.content
                    assert VipMembershipEntitlement.objects.filter(workspace_id=ws.id).count() == 0
            explicit_policy.refresh_from_db()
            explicit_channel.refresh_from_db()
            assert explicit_channel.explicit_policy_id == explicit_policy.id
            assert explicit_policy.visibility == ResourcePolicy.Visibility.RESTRICTED
            assert explicit_policy.updated_at == explicit_policy_updated_at
            assert resolve(explicit_channel.id).visibility == ResourcePolicy.Visibility.RESTRICTED

            # Verify channel gate preserved `org_owner` access AND inherited `DENY_MEMBER` while gating ordinary buyer!
            org.refresh_from_db()
            ch_access = resolve(vip_channel.id)
            assert ch_access.visibility == ResourcePolicy.Visibility.RESTRICTED
            assert may_view(
                ch_access,
                organisation_id=org.id,
                membership_id=owner_membership.id,
                authority_revision=org.authority_revision,
            )
            assert not may_view(
                ch_access,
                organisation_id=org.id,
                membership_id=buyer_membership.id,
                authority_revision=org.authority_revision,
            )
            assert banned_membership.id in ch_access.deny_members

            # 3. Seed negative balance (1,200 cents) -> checkout reserves 1,200 into `application_fee_amount`!
            CreatorConnectAccount.objects.filter(id=reconciled.id).update(
                negative_balance_minor=1200
            )
            pass_exp_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/vip-passes/checkout",
                data=json.dumps(
                    {
                        "tier_id": tier_id,
                        "customer_kind": "b2c",
                        "buyer_country": "FR",
                        "return_url": "https://app.localhost/vip",
                        "locale": "fr",
                        "withdrawal_waiver_accepted": True,
                        "withdrawal_waiver_at": now_iso,
                        "withdrawal_waiver_statement": WAIVER_STATEMENT,
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {buyer_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-vip-pass-expiring-01",
            )
            assert pass_exp_res.status_code == 201, pass_exp_res.content
            assert pass_exp_res.json()["reserved_recovery_minor"] == 1200
            # Base Stripe fee: 10% of 250,000 (= 25,000) + 20% VAT (= 50,000) = 75,000 + 1,200 recovery = 76,200!
            assert adapter.links[-1].application_fee_amount_minor == 76_200
            assert adapter.links[-1].reference_kind == "vip_pass"

            # Expire that checkout session -> releases `reserved_recovery_minor` back to 0!
            ts_now = int(time.time())
            raw_exp, hdr_exp = adapter.build_signed_stripe_webhook(
                event_id="evt_vip_sess_exp_01",
                event_type="checkout.session.expired",
                data_object={"id": pass_exp_res.json()["checkout_session_id"]},
                created_ts=ts_now,
            )
            assert (
                client.post(
                    "/api/v1/webhooks/stripe",
                    data=raw_exp,
                    content_type="application/json",
                    HTTP_STRIPE_SIGNATURE=hdr_exp["Stripe-Signature"],
                ).json()["status"]
                == "applied"
            )
            reconciled.refresh_from_db()
            assert reconciled.reserved_recovery_minor == 0
            assert reconciled.negative_balance_minor == 1200

            # 4. New VIP pass checkout succeeds -> recovers 1,200 negative balance AND grants `WorkspaceMemberRole`!
            pass_ok_res = client.post(
                f"/api/v1/organisations/{org.id}/workspace/monetization/vip-passes/checkout",
                data=json.dumps(
                    {
                        "tier_id": tier_id,
                        "customer_kind": "b2c",
                        "buyer_country": "FR",
                        "return_url": "https://app.localhost/vip",
                        "locale": "fr",
                        "withdrawal_waiver_accepted": True,
                        "withdrawal_waiver_at": now_iso,
                        "withdrawal_waiver_statement": WAIVER_STATEMENT,
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {buyer_tok}",
                HTTP_IDEMPOTENCY_KEY="idem-vip-pass-settled-02",
            )
            assert pass_ok_res.status_code == 201
            raw_vip_comp, hdr_vip_comp = adapter.build_signed_stripe_webhook(
                event_id="evt_vip_settled_02",
                event_type="checkout.session.completed",
                data_object={
                    "id": pass_ok_res.json()["checkout_session_id"],
                    "payment_intent": "pi_vip_settled_02",
                    "payment_status": "paid",
                    "amount_total": 300_000,
                    "currency": "eur",
                },
                created_ts=ts_now + 2,
            )
            assert (
                client.post(
                    "/api/v1/webhooks/stripe",
                    data=raw_vip_comp,
                    content_type="application/json",
                    HTTP_STRIPE_SIGNATURE=hdr_vip_comp["Stripe-Signature"],
                ).json()["status"]
                == "applied"
            )
            reconciled.refresh_from_db()
            assert reconciled.negative_balance_minor == 0
            assert reconciled.reserved_recovery_minor == 0
            assert WorkspaceMemberRole.objects.filter(
                workspace=ws, membership_id=buyer_membership.id, role=vip_role
            ).exists()
            assert (
                VipMembershipEntitlement.objects.get(
                    id=pass_ok_res.json()["vip_entitlement_id"]
                ).state
                == "active"
            )

            # 5. Overview & DAC7 JSON + XML export via HTTP under `kodera_api` role!
            overview_res = client.get(
                f"/api/v1/organisations/{org.id}/workspace/monetization",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
            )
            assert overview_res.status_code == 200
            assert overview_res.json()["dac7_summary"]["reportable"] is True

            dac7_json_res = client.get(
                f"/api/v1/organisations/{org.id}/workspace/monetization/dac7-report?format=json&year={timezone.now().year}",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
            )
            assert dac7_json_res.status_code == 200
            dac7_doc = json.loads(dac7_json_res.content.decode("utf-8"))
            assert dac7_doc["platform_operator_siren"] == "888777666"
            assert dac7_doc["sellers"][0]["reportable"] is True
            assert dac7_doc["sellers"][0]["tax_tin"] == "FR9944556677"

            dac7_xml_res = client.get(
                f"/api/v1/organisations/{org.id}/workspace/monetization/dac7-report?format=xml&year={timezone.now().year}",
                HTTP_AUTHORIZATION=f"Bearer {owner_tok}",
            )
            assert dac7_xml_res.status_code == 200
            assert b"FR9944556677" in dac7_xml_res.content
            assert b"SEALED" not in dac7_xml_res.content
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')

    # 6. Real GDPR organisation erasure (`privacy_begin_erasure` -> `privacy_purge_core`) snapshots
    #    reportable DAC7 seller fiscal identity into `Dac7SellerStatutorySnapshot` while scrubbing
    #    `CreatorConnectAccount`!
    erasure = begin(org)
    purge_core(erasure.id)

    reconciled.refresh_from_db()
    assert reconciled.pii_scrubbed_at is not None
    assert reconciled.seller_legal_name.startswith("Erased creator (")
    assert reconciled.sealed_tax_tin is None

    stat_snap = Dac7SellerStatutorySnapshot.objects.get(connect_account_id=reconciled.id)
    assert stat_snap.seller_legal_name == "Atelier Souverain SAS"
    post_erasure_report = dac7.build_dac7_annual_report_from_db(
        reporting_year=timezone.now().year,
        include_unsealed_tin=True,
    )
    retained_seller = next(
        s for s in post_erasure_report.sellers if s.connect_account_id == str(reconciled.id)
    )
    assert retained_seller.reportable is True
    assert retained_seller.seller_legal_name == "Atelier Souverain SAS"
    assert retained_seller.tax_tin == "FR9944556677"


@pytest.mark.django_db(transaction=True)
def test_migration_0030_skips_privacy_protected_rows_fences_disabled_and_reset_unsettled_cutover() -> (
    None
):
    import importlib
    import uuid as uuid_mod

    from django.apps import apps as django_apps
    from django.core.management import call_command
    from django.db import connections
    from test_core_erasure import begin
    from test_customer_persistence_models import anchor, anchor_models

    from apps.billing.models import CreatorConnectAccount, VipTierOffer
    from apps.orgs.erasure_services import purge_core
    from apps.workspaces.models import Workspace

    mig_0030 = importlib.import_module(
        "apps.billing.migrations.0030_dedicated_kodera_stripe_platform_account"
    )
    models = anchor_models()

    # 1. Erased organisation retaining an `intent_recorded` legacy row MUST NOT abort migration 0030!
    erased_org, _, _ = anchor(models, slug="erased-" + uuid_mod.uuid4().hex[:6])
    erased_ws = Workspace.objects.create(organisation=erased_org)
    erased_acct = CreatorConnectAccount.objects.create(
        organisation=erased_org,
        workspace=erased_ws,
        stripe_platform_account_id="acct_1QhZ8fRwfVmWKPLR",
        stripe_livemode=True,
        stripe_connect_account_id=None,
        onboarding_state="intent_recorded",
        operation_idempotency_key="0000000000000007",
        seller_legal_name="Erased Seller",
        tax_residence_country="FR",
    )
    erasure = begin(erased_org)
    purge_core(erasure.id)

    # 2. Disabled legacy connected row preserves `onboarding_state="disabled"` + prior diagnostic while clearing capabilities.
    dis_org, _, _ = anchor(models, slug="disabl-" + uuid_mod.uuid4().hex[:6])
    dis_ws = Workspace.objects.create(organisation=dis_org)
    dis_acct = CreatorConnectAccount.objects.create(
        organisation=dis_org,
        workspace=dis_ws,
        stripe_platform_account_id="acct_1QhZ8fRwfVmWKPLR",
        stripe_livemode=True,
        stripe_connect_account_id="acct_1LegacyDisabled01",
        onboarding_state="disabled",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        operation_idempotency_key="0000000000000008",
        seller_legal_name="Disabled Legacy Seller",
        tax_residence_country="FR",
        last_operation_error="rejected.fraud",
    )

    # 3. Unsettled active legacy connected row is fenced `restricted`, tier unpublished, then cleanly reset via `--reset-unsettled-connected`.
    act_org, _, _ = anchor(models, slug="active-" + uuid_mod.uuid4().hex[:6])
    act_ws = Workspace.objects.create(organisation=act_org)
    act_acct = CreatorConnectAccount.objects.create(
        organisation=act_org,
        workspace=act_ws,
        stripe_platform_account_id="acct_1QhZ8fRwfVmWKPLR",
        stripe_livemode=True,
        stripe_connect_account_id="acct_1LegacyActive01",
        onboarding_state="active",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        operation_idempotency_key="0000000000000009",
        seller_legal_name="Active Legacy Seller",
        tax_residence_country="FR",
    )
    tier = VipTierOffer.objects.create(
        organisation=act_org,
        workspace=act_ws,
        connect_account=act_acct,
        code="legacy-tier-01",
        name="Legacy Tier",
        billing_period="monthly",
        currency="EUR",
        price_excl_vat_minor=1500,
        granted_workspace_role_id=uuid_mod.uuid4(),
        granted_channel_ids=[],
        active=True,
    )

    with connections["default"].schema_editor() as schema_editor:
        mig_0030._fence_retired_platform_connect_accounts(django_apps, schema_editor)

    erased_acct.refresh_from_db()
    assert erased_acct.stripe_platform_account_id == "acct_1QhZ8fRwfVmWKPLR"
    with pytest.raises(vip_connect.ConnectPlatformMismatchError):
        vip_connect._require_matching_platform(erased_acct)

    dis_acct.refresh_from_db()
    assert dis_acct.onboarding_state == "disabled"
    assert dis_acct.charges_enabled is False and dis_acct.payouts_enabled is False
    assert (
        dis_acct.last_operation_error
        == "rejected.fraud;platform_account_cutover_reconciliation_required"
    )

    act_acct.refresh_from_db()
    tier.refresh_from_db()
    assert act_acct.onboarding_state == "restricted"
    assert act_acct.charges_enabled is False and act_acct.payouts_enabled is False
    assert tier.active is False

    call_command(
        "reconcile_connect_platform_cutover",
        "--target-platform-account-id",
        "acct_1UgN9jRu1W0izUsy",
        "--target-livemode",
        "false",
        "--apply",
        "--reset-unsettled-connected",
    )
    act_acct.refresh_from_db()
    assert act_acct.stripe_platform_account_id == "acct_1UgN9jRu1W0izUsy"
    assert act_acct.stripe_livemode is False
    assert act_acct.stripe_connect_account_id is None
    assert act_acct.onboarding_state == "intent_recorded"
    # Disabled (rejected.fraud) row MUST NOT be reset by --reset-unsettled-connected!
    dis_acct.refresh_from_db()
    assert dis_acct.onboarding_state == "disabled"
    assert dis_acct.stripe_connect_account_id == "acct_1LegacyDisabled01"
    assert dis_acct.stripe_platform_account_id == "acct_1QhZ8fRwfVmWKPLR"
    assert (
        dis_acct.last_operation_error
        == "rejected.fraud;platform_account_cutover_reconciliation_required"
    )

    # 4. `--backfill-unbound-checkouts` refuses unless runtime settings match target AND zero
    #    retired/mismatched CreatorConnectAccount rows remain (`dis_acct` is still on WKPLR).
    from django.core.management.base import CommandError

    with pytest.raises(CommandError, match="KODERA_STRIPE_PLATFORM_ACCOUNT_ID"):
        call_command(
            "reconcile_connect_platform_cutover",
            "--target-platform-account-id",
            "acct_1UgN9jRu1W0izUsy",
            "--target-livemode",
            "false",
            "--backfill-unbound-checkouts",
        )
    with override_settings(
        KODERA_STRIPE_PLATFORM_ACCOUNT_ID="acct_1UgN9jRu1W0izUsy",
        KODERA_STRIPE_EXPECTED_LIVEMODE=False,
    ):
        with pytest.raises(CommandError, match="retired company account"):
            call_command(
                "reconcile_connect_platform_cutover",
                "--target-platform-account-id",
                "acct_1UgN9jRu1W0izUsy",
                "--target-livemode",
                "false",
                "--backfill-unbound-checkouts",
            )


@pytest.mark.django_db(transaction=True)
def test_vip_checkout_in_flight_blocks_cutover_reset_and_revalidates_seller_binding() -> None:
    import uuid as uuid_mod

    from django.core.management import call_command
    from test_customer_persistence_models import anchor, anchor_models

    from apps.billing.models import CreatorConnectAccount, VipMembershipEntitlement, VipTierOffer
    from apps.billing.payments.port import ProviderLink
    from apps.workspaces.models import Workspace

    models = anchor_models()
    org, _, owner_memberships = anchor(models, slug="inflight-" + uuid_mod.uuid4().hex[:6])
    owner_membership = owner_memberships[0]
    ws = Workspace.objects.create(organisation=org)
    acct = CreatorConnectAccount.objects.create(
        organisation=org,
        workspace=ws,
        stripe_platform_account_id="acct_1UgN9jRu1W0izUsy",
        stripe_livemode=False,
        stripe_connect_account_id="acct_1SellerInFlight01",
        onboarding_state="active",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        negative_balance_minor=500,
        operation_idempotency_key="0000000000000011",
        seller_legal_name="In-Flight Seller",
        tax_residence_country="FR",
    )
    tier = VipTierOffer.objects.create(
        organisation=org,
        workspace=ws,
        connect_account=acct,
        code="inflight-tier",
        name="Inflight Tier",
        billing_period="monthly",
        currency="EUR",
        price_excl_vat_minor=2000,
        granted_workspace_role_id=uuid_mod.uuid4(),
        granted_channel_ids=[],
        active=True,
    )

    cancelled_refs: list[str] = []

    class _PausingProvider:
        name = "stripe"

        def create_link(self, req):
            # While the provider request is in flight, a pending_payment row with NULL session/PI
            # exists in PostgreSQL: `--reset-unsettled-connected` MUST NOT reset the seller account!
            call_command(
                "reconcile_connect_platform_cutover",
                "--target-platform-account-id",
                "acct_1UgN9ORytJJnrEun",
                "--target-livemode",
                "true",
                "--apply",
                "--reset-unsettled-connected",
            )
            mid = CreatorConnectAccount.objects.get(id=acct.id)
            assert mid.stripe_connect_account_id == "acct_1SellerInFlight01"
            assert mid.onboarding_state == "restricted"
            return ProviderLink(
                provider_ref="cs_test_inflight_stale_01",
                url="https://checkout.stripe.test/c/pay/cs_test_inflight_stale_01",
            )

        def cancel_link(self, provider_ref: str) -> None:
            cancelled_refs.append(provider_ref)

    now_iso = timezone.now().isoformat().replace("+00:00", "Z")
    with override_settings(
        KODERA_STRIPE_PLATFORM_ACCOUNT_ID="acct_1UgN9jRu1W0izUsy",
        KODERA_STRIPE_EXPECTED_LIVEMODE=False,
    ):
        with pytest.raises(vip_connect.ConnectPlatformMismatchError):
            vip_connect.create_vip_pass_checkout(
                organisation_id=org.id,
                workspace_id=ws.id,
                tier_id=tier.id,
                membership_id=owner_membership.id,
                buyer_user_id=owner_membership.user_id,
                customer_kind="b2c",
                buyer_country="FR",
                return_url="https://app.localhost/vip/return",
                locale="fr",
                withdrawal_waiver_accepted=True,
                withdrawal_waiver_at=timezone.datetime.fromisoformat(now_iso),
                withdrawal_waiver_statement=WAIVER_STATEMENT,
                idempotency_key="0000000000000012",
                provider=_PausingProvider(),
            )

    acct.refresh_from_db()
    assert acct.reserved_recovery_minor == 0
    ent = VipMembershipEntitlement.objects.get(workspace_id=ws.id)
    assert ent.state == "cancelled"
    assert ent.stripe_checkout_url is None
    assert cancelled_refs == ["cs_test_inflight_stale_01"]


@pytest.mark.django_db(transaction=True)
def test_revoke_unbound_pending_checkouts_retires_all_four_models_and_preserves_controls() -> None:
    import io
    import uuid as uuid_mod
    from datetime import timedelta

    from django.core.management import call_command
    from test_customer_persistence_models import anchor, anchor_models

    from apps.billing.models import (
        CreatorConnectAccount,
        Invoice,
        PaymentLink,
        VipMembershipEntitlement,
        VipTierOffer,
        WorkspaceBoostGrant,
    )
    from apps.extensions.models import ExtensionMarketplaceListing, MarketplaceEntitlement
    from apps.workspaces.models import Workspace

    models = anchor_models()
    org, _, owner_memberships = anchor(models, slug="revunb-" + uuid_mod.uuid4().hex[:6])
    owner_membership = owner_memberships[0]
    ws = Workspace.objects.create(organisation=org)
    now = timezone.now()

    def _draft_invoice() -> Invoice:
        return Invoice.objects.create(
            organisation=org,
            vat_regime="fr_standard",
            issuer_legal_name="Samourai Coop",
            issuer_address="10 rue de Penthievre",
            issuer_siren="000000000",
            issuer_vat_number="FR00000000000",
            customer_legal_name="Synthetic Customer",
            customer_address_line1="1 rue Synthetique",
            customer_postal_code="75000",
            customer_city="Paris",
            customer_country="FR",
            total_excl_vat_minor=1000,
            vat_amount_minor=200,
            total_incl_vat_minor=1200,
        )

    inv_unb = _draft_invoice()
    inv_bound = _draft_invoice()

    unb_link = PaymentLink.objects.create(
        organisation=org,
        invoice=inv_unb,
        provider="stripe",
        provider_ref="cs_unb_01",
        url="https://checkout.stripe.test/unb-01",
        amount_minor=inv_unb.total_incl_vat_minor,
        currency="EUR",
        state="active",
        expires_at=now + timedelta(hours=5),
        stripe_account_id=None,
        stripe_livemode=None,
    )
    bound_link = PaymentLink.objects.create(
        organisation=org,
        invoice=inv_bound,
        provider="stripe",
        provider_ref="cs_bound_01",
        url="https://checkout.stripe.test/bound-01",
        amount_minor=inv_bound.total_incl_vat_minor,
        currency="EUR",
        state="active",
        expires_at=now + timedelta(hours=5),
        stripe_account_id="acct_1UgN9jRu1W0izUsy",
        stripe_livemode=False,
    )

    unb_boost = WorkspaceBoostGrant.objects.create(
        organisation=org,
        workspace=ws,
        purchaser_user_id=owner_membership.user_id,
        pack_code="boost_starter",
        customer_kind="b2c",
        customer_country="FR",
        currency="EUR",
        vat_regime="fr_standard",
        vat_rate_bp=2000,
        net_amount_minor=1000,
        vat_amount_minor=200,
        gross_amount_minor=1200,
        credit_amount_minor=1000,
        seats_delta=5,
        storage_bytes_delta=1024,
        state="pending_payment",
        stripe_checkout_session_id="cs_boost_unb_01",
        stripe_checkout_url="https://checkout.stripe.test/boost-unb-01",
        stripe_payment_intent_id=None,
        stripe_account_id=None,
        stripe_livemode=None,
        idempotency_key="0000000000000013",
        request_sha256="a" * 64,
    )
    paid_boost = WorkspaceBoostGrant.objects.create(
        organisation=org,
        workspace=ws,
        purchaser_user_id=owner_membership.user_id,
        pack_code="boost_starter",
        customer_kind="b2c",
        customer_country="FR",
        currency="EUR",
        vat_regime="fr_standard",
        vat_rate_bp=2000,
        net_amount_minor=1000,
        vat_amount_minor=200,
        gross_amount_minor=1200,
        credit_amount_minor=1000,
        seats_delta=5,
        storage_bytes_delta=1024,
        state="active",
        withdrawal_waiver_accepted=True,
        withdrawal_waiver_at=now,
        withdrawal_waiver_evidence=WAIVER_STATEMENT,
        activated_at=now,
        expires_at=now + timedelta(days=30),
        stripe_checkout_session_id="cs_boost_paid_01",
        stripe_payment_intent_id="pi_boost_paid_01",
        stripe_account_id=None,
        stripe_livemode=None,
        idempotency_key="0000000000000014",
        request_sha256="b" * 64,
    )

    acct = CreatorConnectAccount.objects.create(
        organisation=org,
        workspace=ws,
        stripe_platform_account_id="acct_1UgN9jRu1W0izUsy",
        stripe_livemode=False,
        stripe_connect_account_id="acct_1SellerRevUnb01",
        onboarding_state="active",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        negative_balance_minor=400,
        reserved_recovery_minor=400,
        operation_idempotency_key="0000000000000015",
        seller_legal_name="Revoke Unbound Seller",
        tax_residence_country="FR",
    )
    tier = VipTierOffer.objects.create(
        organisation=org,
        workspace=ws,
        connect_account=acct,
        code="rev-unb-tier",
        name="Rev Unb Tier",
        billing_period="monthly",
        currency="EUR",
        price_excl_vat_minor=2000,
        granted_workspace_role_id=uuid_mod.uuid4(),
        granted_channel_ids=[],
        active=True,
    )
    unb_vip = VipMembershipEntitlement.objects.create(
        organisation=org,
        workspace=ws,
        tier=tier,
        membership_id=owner_membership.id,
        buyer_user_id=owner_membership.user_id,
        customer_kind="b2c",
        buyer_country="FR",
        currency="EUR",
        vat_regime="fr_standard",
        vat_rate_bp=2000,
        gross_excl_vat_minor=2000,
        vat_amount_minor=400,
        total_incl_vat_minor=2400,
        application_fee_amount_minor=600,
        reserved_recovery_minor=400,
        stripe_checkout_session_id="cs_vip_unb_01",
        stripe_checkout_url="https://checkout.stripe.test/vip-unb-01",
        stripe_payment_intent_id=None,
        stripe_account_id=None,
        stripe_livemode=None,
        state="pending_payment",
        idempotency_key="0000000000000016",
        request_sha256="c" * 64,
    )

    listing = ExtensionMarketplaceListing.objects.create(
        organisation=org,
        workspace=ws,
        creator=owner_membership,
        slug="rev-unb-ext",
        title="Rev Unb Ext",
        summary="Test",
        manifest={"id": "rev-unb-ext"},
        pricing_mode="one_time",
        price_excl_vat_minor=1500,
        currency="EUR",
        seller_connect_account_id="acct_1SellerRevUnb01",
        published_at=now,
    )
    unb_mkt = MarketplaceEntitlement.objects.create(
        organisation=org,
        workspace=ws,
        buyer_membership=owner_membership,
        listing=listing,
        state="pending",
        checkout_ref="cs_mkt_unb_01",
        checkout_url="https://checkout.stripe.test/mkt-unb-01",
        payment_intent_id=None,
        stripe_account_id=None,
        stripe_livemode=None,
        idempotency_key="0000000000000017",
        request_sha256="d" * 64,
    )

    dry_out = io.StringIO()
    call_command(
        "reconcile_connect_platform_cutover",
        "--target-platform-account-id",
        "acct_1UgN9jRu1W0izUsy",
        "--target-livemode",
        "false",
        "--revoke-unbound-pending-checkouts",
        stdout=dry_out,
    )
    dry_payload = json.loads(dry_out.getvalue())
    assert dry_payload["applied"] is False
    assert dry_payload["revoked_unbound_pending"] == 4
    unb_boost.refresh_from_db()
    assert unb_boost.state == "pending_payment"

    apply_out = io.StringIO()
    call_command(
        "reconcile_connect_platform_cutover",
        "--target-platform-account-id",
        "acct_1UgN9jRu1W0izUsy",
        "--target-livemode",
        "false",
        "--revoke-unbound-pending-checkouts",
        "--apply",
        stdout=apply_out,
    )
    apply_payload = json.loads(apply_out.getvalue())
    assert apply_payload["applied"] is True
    assert apply_payload["revoked_unbound_pending"] == 4

    unb_link.refresh_from_db()
    bound_link.refresh_from_db()
    unb_boost.refresh_from_db()
    paid_boost.refresh_from_db()
    unb_vip.refresh_from_db()
    acct.refresh_from_db()
    unb_mkt.refresh_from_db()
    assert unb_link.state == "cancelled"
    assert bound_link.state == "active"
    assert unb_boost.state == "cancelled"
    assert unb_boost.stripe_checkout_url is None
    assert paid_boost.state == "active"
    assert unb_vip.state == "cancelled"
    assert unb_vip.stripe_checkout_url is None
    assert acct.reserved_recovery_minor == 0
    assert unb_mkt.state == "revoked"
    assert unb_mkt.checkout_url is None
