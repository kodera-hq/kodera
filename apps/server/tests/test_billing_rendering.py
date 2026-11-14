"""Real optional PDF/A/XML conformance and adversarial vectors, always offline."""

import io
import os
from dataclasses import replace
from pathlib import Path

import pytest
from test_billing_documents import snapshot

pytest.importorskip("facturx", reason="install the billing-documents optional extra")
pytest.importorskip("saxonche", reason="install the billing-documents optional extra")

from pypdf import PdfReader  # noqa: E402

from apps.billing.documents import Party, render_xml  # noqa: E402
from apps.billing.integrity import IntegrityRefusedError  # noqa: E402
from apps.billing.rendering import (  # noqa: E402
    OfflineRenderer,
    OfflineValidator,
    validate_xml,
    verify_pdfa_report,
)

VERAPDF = os.environ.get("KODERA_TEST_VERAPDF")


@pytest.mark.parametrize("credit", [False, True])
def test_real_xsd_schematron_accept_invoice_and_credit_and_refuse_changed_total(credit):
    row = snapshot()
    if credit:
        row = replace(
            row,
            type_code="381",
            number="AV-TST-2026-00001",
            original_invoice_number=row.number,
            due_at=None,
        )
    xml = render_xml(row)
    validate_xml(xml)
    # Keep the XML well-formed and schema-valid while violating the monetary business rule.
    changed = xml.replace(b">24.02</ram:GrandTotalAmount>", b">24.03</ram:GrandTotalAmount>")
    assert changed != xml
    with pytest.raises(IntegrityRefusedError, match="document_xml_schematron_failed"):
        validate_xml(changed)


def test_xml_external_entity_declaration_is_refused_before_local_transform():
    xml = b'<!DOCTYPE CrossIndustryInvoice [<!ENTITY x SYSTEM "file:///unavailable">]><x>&x;</x>'
    with pytest.raises(IntegrityRefusedError, match="document_xml_doctype_refused"):
        validate_xml(xml)


def test_pdf_bytes_do_not_depend_on_library_wall_clock_or_random_identifier(monkeypatch):
    from facturx import facturx

    row = snapshot()
    xml = render_xml(row)
    renderer = OfflineRenderer()
    monkeypatch.setattr(facturx, "_get_metadata_timestamp", lambda: "2026-01-01T00:00:00+00:00")
    first = renderer.render(row, xml)
    monkeypatch.setattr(facturx, "_get_metadata_timestamp", lambda: "2029-12-31T23:59:59+00:00")
    second = renderer.render(row, xml)
    assert first == second
    reader = PdfReader(io.BytesIO(first))
    assert reader.attachments["factur-x.xml"] == [xml]
    assert "2029-12-31" not in first.decode("latin1")
    assert "Immutable accounting snapshot " + row.sha256 == reader.metadata["/Subject"]


def test_unsupported_font_character_is_refused_instead_of_omitting_legal_name():
    row = snapshot(buyer=Party("Synthetic 顧客", "2 sample street", "FR", None))
    with pytest.raises(IntegrityRefusedError, match="document_font_unsupported_character"):
        OfflineRenderer().render(row, render_xml(row))


@pytest.mark.skipif(
    VERAPDF is None, reason="set KODERA_TEST_VERAPDF to the pinned verified local validator"
)
@pytest.mark.parametrize("credit", [False, True])
def test_independent_verapdf_accepts_real_pdfa3_and_rejects_removed_embedded_xml(credit):
    from pypdf import PdfWriter
    from pypdf.generic import NameObject

    row = snapshot()
    if credit:
        row = replace(
            row,
            type_code="381",
            number="AV-TST-2026-00001",
            original_invoice_number=row.number,
            due_at=None,
        )
    xml = render_xml(row)
    pdf = OfflineRenderer().render(row, xml)
    verifier = OfflineValidator(verapdf=Path(VERAPDF))
    verifier.validate(pdf=pdf, xml=xml, snapshot_sha256=row.sha256)
    altered = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
    del altered._root_object["/Names"]["/EmbeddedFiles"]
    altered._root_object.pop(NameObject("/AF"))
    target = io.BytesIO()
    altered.write(target)
    with pytest.raises(IntegrityRefusedError, match="document_embedded_xml_mismatch"):
        verifier.validate(pdf=target.getvalue(), xml=xml, snapshot_sha256=row.sha256)


@pytest.mark.parametrize(
    "mutation",
    [
        b"",
        b"not XML",
        b'<report><jobs/><batchSummary totalJobs="0"/></report>',
        b'<report><validationReport isCompliant="false"/></report>',
    ],
)
def test_empty_failed_and_misleading_pdfa_reports_never_count_as_conformance(mutation):
    with pytest.raises(IntegrityRefusedError, match="document_pdfa3_conformance_failed"):
        verify_pdfa_report(mutation)


def test_xsd_invalid_tag_is_refused():
    xml = render_xml(snapshot()).replace(b"ram:InvoiceCurrencyCode", b"ram:UnknownCurrencyCode")
    with pytest.raises(IntegrityRefusedError, match="document_xml_xsd_failed"):
        validate_xml(xml)


def test_immutable_service_period_is_present_and_schema_valid():
    from datetime import timedelta

    row = snapshot()
    item = replace(
        row.lines[0], period_start=row.issued_at, period_end=row.issued_at + timedelta(days=30)
    )
    row = replace(row, lines=(item, *row.lines[1:]))
    xml = render_xml(row)
    assert b"BillingSpecifiedPeriod" in xml
    validate_xml(xml)
