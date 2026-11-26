# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Offline PA configuration, TLS transport, immutable upload and failure classification."""

import io
import ssl
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from unittest.mock import Mock

import pytest
from apps.billing.documents import Line, Party, Snapshot, render_xml
from apps.billing.rendering import OfflineRenderer

from ee.billing import qonto_pa as qonto


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    for name in (
        "QONTO_EINVOICING_ENABLED",
        "QONTO_EINVOICING_BASE_URL",
        "KODERA_QONTO_PA_TOKEN",
        "QONTO_EINVOICING_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


def config(**values):
    return qonto.QontoPaConfig(
        **{"enabled": True, "base_url": qonto.PRODUCTION, "token": "synthetic-pa-token", **values}
    )


def test_environment_and_explicit_configuration_are_equivalent(monkeypatch):
    monkeypatch.setenv("QONTO_EINVOICING_ENABLED", "true")
    monkeypatch.setenv("QONTO_EINVOICING_BASE_URL", qonto.PRODUCTION)
    monkeypatch.setenv("KODERA_QONTO_PA_TOKEN", "synthetic-pa-token")
    monkeypatch.setenv("QONTO_EINVOICING_TIMEOUT_SECONDS", "3.5")
    assert qonto.QontoPaConfig() == config(timeout_seconds=3.5)
    assert "synthetic-pa-token" not in repr(qonto.QontoPaConfig())


@pytest.mark.parametrize(
    "values",
    [
        {"token": ""},
        {"token": "token\r\nheader"},
        {"base_url": ""},
        {"base_url": "http://thirdparty.qonto.com"},
        {"base_url": "https://127.0.0.1"},
        {"base_url": "https://[::1]"},
        {"base_url": "https://thirdparty.qonto.com.evil.invalid"},
        {"base_url": "https://user:password@thirdparty.qonto.com"},
        {"base_url": "https://thirdparty.qonto.com:444"},
        {"base_url": "https://thirdparty.qonto.com?query=1"},
        {"base_url": "https://thirdparty.qonto.com#fragment"},
        {"base_url": "https://thirdparty.qonto.com/path"},
        {"base_url": qonto.SANDBOX},
        {"timeout_seconds": 11},
        {"timeout_seconds": 0},
        {"timeout_seconds": float("nan")},
        {"timeout_seconds": float("inf")},
        {"invoice_prefix": "QONTO-"},
        {"invoice_prefix": "INV-"},
        {"enabled": False},
        {"enabled": "yes"},
    ],
)
def test_unsafe_or_partial_configuration_fails_closed(values):
    with pytest.raises(qonto.QontoConfigError, match="qonto_configuration_invalid"):
        config(**values)


def test_disabled_config_refuses_stray_secret_and_never_uses_transport(monkeypatch):
    assert not qonto.QontoPaConfig().enabled
    transport = Mock()
    with pytest.raises(qonto.QontoConfigError, match="qonto_disabled"):
        qonto.QontoPaClient(transport=transport).get_einvoicing_settings()
    transport.assert_not_called()
    monkeypatch.setenv("KODERA_QONTO_PA_TOKEN", "synthetic-stray-token")
    with pytest.raises(qonto.QontoConfigError):
        qonto.QontoPaConfig()


def test_sandbox_requires_explicit_opt_in():
    assert config(base_url=qonto.SANDBOX, allow_sandbox=True).base_url == qonto.SANDBOX


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_transient_statuses_do_not_leak_secret_or_response(status):
    client = qonto.QontoPaClient(
        config(),
        transport=lambda **kwargs: (
            status,
            {"Retry-After": "37"},
            b"synthetic-pa-token private customer",
        ),
    )
    with pytest.raises(qonto.QontoTransientError) as refused:
        client.get_einvoicing_settings()
    assert str(refused.value) == "qonto_temporarily_unavailable"
    assert refused.value.status == status
    assert refused.value.retry_after == (37 if status == 429 else None)


@pytest.mark.parametrize(
    "status", [300, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 409, 422, 418]
)
def test_redirects_and_permanent_errors_are_scrubbed_and_never_retried(status):
    transport = Mock(
        return_value=(
            status,
            {"Location": "https://evil.invalid"},
            b"private customer synthetic-pa-token",
        )
    )
    client = qonto.QontoPaClient(config(), transport=transport)
    with pytest.raises(qonto.QontoPermanentError) as refused:
        client.get_einvoicing_settings()
    assert str(refused.value) == "qonto_request_refused"
    assert transport.call_count == 1


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError("private customer"),
        OSError("synthetic-pa-token"),
        ValueError("private transport details"),
    ],
)
def test_transport_exceptions_are_scrubbed(error):
    client = qonto.QontoPaClient(config(), transport=Mock(side_effect=error))
    expected = (
        qonto.QontoTransientError if isinstance(error, OSError) else qonto.QontoPermanentError
    )
    with pytest.raises(expected) as refused:
        client.get_einvoicing_settings()
    assert "private" not in str(refused.value)
    assert "synthetic-pa-token" not in str(refused.value)
    assert refused.value.__suppress_context__


@pytest.mark.parametrize("payload", [b"not json", b"[]", b"x" * (qonto.MAX_RESPONSE + 1)])
def test_invalid_or_oversized_responses_fail_closed(payload):
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(
            config(), transport=lambda **kwargs: (200, {}, payload)
        ).get_einvoicing_settings()


def test_settings_and_send_use_fixed_paths_and_idempotency_headers():
    transport = Mock(side_effect=[(200, {}, b'{"sending_status":"enabled"}'), (204, {}, b"")])
    client = qonto.QontoPaClient(config(), transport=transport)
    assert client.get_einvoicing_settings() == {"sending_status": "enabled"}
    assert client.send_by_einvoice("safe_Invoice-123", idempotency_key="idem-1") == {}
    assert transport.call_args_list[0].kwargs["url"] == qonto.PRODUCTION + "/v2/einvoicing/settings"
    assert (
        transport.call_args.kwargs["url"]
        == qonto.PRODUCTION + "/v2/client_invoices/safe_Invoice-123/send_by_einvoice"
    )
    assert transport.call_args.kwargs["headers"]["X-Qonto-Idempotency-Key"] == "idem-1"


@pytest.mark.parametrize("identifier", ["", "../invoice", "a/b", "a?b", "a\r\nb", "a" * 129])
def test_send_rejects_unsafe_ids_before_network(identifier):
    transport = Mock()
    client = qonto.QontoPaClient(config(), transport=transport)
    with pytest.raises(qonto.QontoPermanentError):
        client.send_by_einvoice(identifier, idempotency_key="idem-1")
    transport.assert_not_called()


@pytest.mark.parametrize("key", ["", "bad key", "x\nHeader", "a" * 129, None])
def test_post_requires_safe_idempotency_key(key):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).send_by_einvoice(
            "invoice", idempotency_key=key
        )
    transport.assert_not_called()


@pytest.fixture(scope="module")
def pdfs():
    now = datetime(2026, 11, 26, 12, tzinfo=UTC)
    row = Snapshot(
        number="KOD-2026-00001",
        type_code="380",
        issued_at=now,
        due_at=now + timedelta(days=30),
        currency="EUR",
        vat_regime="fr_standard",
        vat_mention=None,
        seller=Party("Synthetic Seller", "1 sample street", "FR", "FR00000000000"),
        buyer=Party("Synthetic Buyer", "2 sample street", "FR", None, "75000", "Paris"),
        lines=(Line(1, "Service", 1, 100, 100, 2000, 20),),
        net_minor=100,
        vat_minor=20,
        gross_minor=120,
    )
    xml = render_xml(row)
    invoice = OfflineRenderer().render(row, xml)
    credit_row = replace(
        row,
        number="AV-KOD-2026-00001",
        type_code="381",
        original_invoice_number=row.number,
        due_at=None,
    )
    credit_xml = render_xml(credit_row).replace(b"AV-KOD-2026-00001", b"KOD-AV-2026-00001")
    credit = OfflineRenderer().render(replace(credit_row, number="KOD-AV-2026-00001"), credit_xml)
    return invoice, credit


def test_bulk_validates_both_legal_types_and_preserves_original_files(pdfs):
    transport = Mock(return_value=(200, {}, b'{"client_invoices":[]}'))
    client = qonto.QontoPaClient(config(), transport=transport)
    assert client.submit_client_invoices_bulk(
        pdfs, idempotency_key="idem-1", require_ledger_match=False
    ) == {"client_invoices": []}
    request = transport.call_args.kwargs
    assert request["url"] == qonto.PRODUCTION + "/v2/client_invoices/bulk"
    assert request["headers"]["X-Qonto-Idempotency-Key"] == "idem-1"
    assert request["body"].count(b'name="client_invoices"') == 2
    assert all(pdf in request["body"] for pdf in pdfs)


@pytest.mark.parametrize(
    "invoices", [[], [b"%PDF-invalid"], [b"x"] * 6, [b"x" * (5 * 1024 * 1024 + 1)]]
)
def test_bulk_invalid_documents_never_reach_network(invoices):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).submit_client_invoices_bulk(
            invoices, idempotency_key="idem-1", require_ledger_match=False
        )
    transport.assert_not_called()


def test_bulk_rejects_mixed_valid_and_invalid_batch_without_partial_send(pdfs):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).submit_client_invoices_bulk(
            [pdfs[0], b"bad"], idempotency_key="idem-1", require_ledger_match=False
        )
    transport.assert_not_called()


def test_bulk_rejects_numbers_outside_its_configured_series(pdfs):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(
            config(invoice_prefix="CUSTOM-"), transport=transport
        ).submit_client_invoices_bulk(
            [pdfs[0]], idempotency_key="idem-1", require_ledger_match=False
        )
    transport.assert_not_called()


def test_stdlib_transport_verifies_tls_and_bounds_response(monkeypatch):
    response = Mock(status=200)
    response.getheaders.return_value = []
    response.getheader.return_value = "identity"
    response.read.return_value = b"{}"
    connection = Mock()
    connection.getresponse.return_value = response
    factory = Mock(return_value=connection)
    monkeypatch.setattr(qonto.http.client, "HTTPSConnection", factory)
    assert qonto.QontoPaClient(config(timeout_seconds=2.5)).get_einvoicing_settings() == {}
    context = factory.call_args.kwargs["context"]
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert factory.call_args.kwargs["timeout"] == 2.5
    response.read.assert_called_once_with(qonto.MAX_RESPONSE + 1)
    connection.close.assert_called_once()
    response.close.assert_called_once()


@pytest.mark.parametrize("value", ["42", "malformed", "-1"])
def test_retry_after_parsing(value):
    assert qonto._retry_after({"retry-after": value}) == (42 if value == "42" else None)


def test_retry_after_http_date():
    value = format_datetime(datetime.now(UTC) + timedelta(seconds=60), usegmt=True)
    assert 58 <= qonto._retry_after({"Retry-After": value}) <= 60


def test_explicit_standard_port_and_root_path_are_canonicalised():
    assert config(base_url=qonto.PRODUCTION + ":443/").base_url == qonto.PRODUCTION


def test_custom_nonmanual_series_can_be_uploaded(pdfs):
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(pdfs[0]))
    xml = reader.attachments["factur-x.xml"][0].replace(b"KOD-2026-00001", b"CUSTOM-2026-00001")
    writer = PdfWriter(clone_from=reader)
    writer.pdf_header = "%PDF-1.7"
    stream = writer._root_object["/AF"][0].get_object()["/EF"]["/F"]
    stream.set_data(xml)
    target = io.BytesIO()
    writer.write(target)
    transport = Mock(return_value=(200, {}, b"{}"))
    client = qonto.QontoPaClient(config(invoice_prefix="CUSTOM-"), transport=transport)
    assert (
        client.submit_client_invoices_bulk(
            [target.getvalue()], idempotency_key="idem-1", require_ledger_match=False
        )
        == {}
    )
    assert b'filename="CUSTOM-2026-00001.pdf"' in transport.call_args.kwargs["body"]


@pytest.mark.parametrize("operation", ["settings", "bulk", "send"])
def test_community_refuses_before_transport_or_document_processing(monkeypatch, operation):
    from ee.billing import EnterpriseEditionRequiredError

    monkeypatch.setenv("KODERA_EDITION", "community")
    transport = Mock()
    client = qonto.QontoPaClient(config(), transport=transport)
    with pytest.raises(EnterpriseEditionRequiredError):
        if operation == "settings":
            client.get_einvoicing_settings()
        elif operation == "bulk":
            client.submit_client_invoices_bulk([b"bad"], idempotency_key="idem-1")
        else:
            client.send_by_einvoice("invoice", idempotency_key="idem-1")
    transport.assert_not_called()


@pytest.mark.parametrize(
    "error",
    [
        ssl.SSLCertVerificationError("certificate refused"),
        ssl.SSLError(1, "CERTIFICATE_VERIFY_FAILED"),
    ],
)
def test_certificate_failures_are_permanent(error):
    # SSLError.reason is populated by OpenSSL; injected exceptions may only carry args.
    transport = Mock(side_effect=error)
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).get_einvoicing_settings()
    assert transport.call_count == 1


def test_bulk_refuses_duplicate_numbers(pdfs):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).submit_client_invoices_bulk(
            [pdfs[0], pdfs[0]], idempotency_key="idem-1", require_ledger_match=False
        )
    transport.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_bulk_requires_recorded_artifact_and_refuses_tampered_pdf():
    from apps.billing.artifacts import publish
    from apps.billing.facturx_pdfa_validator import FacturXPdfaValidator
    from apps.billing.services import issue_invoice
    from django.db import transaction
    from test_billing_orders import _draft, world

    invoice = _draft(world())
    invoice.issuer_country = "FR"
    invoice.customer_postal_code = "75000"
    invoice.customer_city = "Paris"
    invoice.save(update_fields=["issuer_country", "customer_postal_code", "customer_city"])
    with transaction.atomic():
        issue_invoice(invoice)
    artifact = publish(
        document_id=invoice.id,
        credit_note=False,
        renderer=OfflineRenderer(),
        validator=FacturXPdfaValidator(),
        validator_ref="structural-test",
    )
    pdf = bytes(artifact.pdf)
    transport = Mock(return_value=(200, {}, b"{}"))
    client = qonto.QontoPaClient(config(invoice_prefix="TST-"), transport=transport)
    assert client.submit_client_invoices_bulk([pdf], idempotency_key="idem-1") == {}
    transport.reset_mock()
    # Whitespace after EOF remains a valid PDF but no longer matches the immutable digest.
    with pytest.raises(qonto.QontoPermanentError):
        client.submit_client_invoices_bulk([pdf + b"\n"], idempotency_key="idem-1")
    transport.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_bulk_refuses_unrecorded_pdf(pdfs):
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).submit_client_invoices_bulk(
            [pdfs[0]], idempotency_key="idem-1"
        )
    transport.assert_not_called()


@pytest.mark.parametrize(
    "url",
    [
        "http://thirdparty.qonto.com/x",
        "https://evil.invalid/x",
        "https://thirdparty.qonto.com:444/x",
        "https://user@thirdparty.qonto.com/x",
        "https://thirdparty.qonto.com/x?q=1",
        "https://thirdparty.qonto.com/x#f",
    ],
)
def test_transport_revalidates_target_before_connection(monkeypatch, url):
    factory = Mock()
    monkeypatch.setattr(qonto.http.client, "HTTPSConnection", factory)
    with pytest.raises(qonto.QontoPermanentError):
        qonto._transport(method="GET", url=url, headers={}, body=None, timeout=1)
    factory.assert_not_called()


def test_operator_cannot_disable_ledger_verification(pdfs, settings):
    settings.KODERA_INVOICE_SERIES = "KOD"
    transport = Mock()
    with pytest.raises(qonto.QontoPermanentError):
        qonto.QontoPaClient(config(), transport=transport).submit_client_invoices_bulk(
            [pdfs[0]], idempotency_key="idem-1", require_ledger_match=False
        )
    transport.assert_not_called()
