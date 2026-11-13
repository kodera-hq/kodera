"""Snapshot/CII determinism, publication refusals and accounting-series mutation proofs."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from xml.etree import ElementTree as ET

import pytest

from apps.billing.documents import (
    NS,
    FacturXUnavailableError,
    Line,
    Party,
    Snapshot,
    render_facturx,
    render_xml,
)
from apps.billing.integrity import IntegrityRefusedError, NumberedRecord, verify_series

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)


def snapshot(**values):
    row = Snapshot(
        number="TST-2026-00001",
        type_code="380",
        issued_at=NOW,
        due_at=NOW + timedelta(days=30),
        currency="EUR",
        vat_regime="fr_standard",
        vat_mention=None,
        seller=Party("Synthetic Issuer", "1 example street", "FR", "FR00000000000"),
        buyer=Party("Synthetic <Customer>", "2 example street", "FR", None, "75000", "Paris"),
        lines=(Line(1, "Messaging & documents", 2, 1001, 2002, 2000, 400),),
        net_minor=2002,
        vat_minor=400,
        gross_minor=2402,
    )
    return replace(row, **values)


def test_xml_is_deterministic_and_escapes_customer_and_line_text():
    row = snapshot()
    assert render_xml(row) == render_xml(row)
    assert row.sha256 == snapshot().sha256
    root = ET.fromstring(render_xml(row))  # noqa: S314 - our own deterministic XML, no external input
    assert root.findtext("rsm:ExchangedDocument/ram:TypeCode", namespaces=NS) == "380"
    assert root.findtext(".//ram:BuyerTradeParty/ram:Name", namespaces=NS) == "Synthetic <Customer>"
    assert root.findtext(".//ram:GrandTotalAmount", namespaces=NS) == "24.02"
    assert b"Messaging &amp; documents" in render_xml(row)


def test_credit_note_has_381_positive_amounts_and_original_immutable_reference():
    row = snapshot(
        number="AV-TST-2026-00001",
        type_code="381",
        original_invoice_number="TST-2026-00001",
        due_at=None,
    )
    root = ET.fromstring(render_xml(row))  # noqa: S314 - our own deterministic XML, no external input
    assert root.findtext("rsm:ExchangedDocument/ram:TypeCode", namespaces=NS) == "381"
    assert (
        root.findtext(".//ram:InvoiceReferencedDocument/ram:IssuerAssignedID", namespaces=NS)
        == "TST-2026-00001"
    )
    assert root.findtext(".//ram:DuePayableAmount", namespaces=NS) == "24.02"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"gross_minor": 2403}, "document_totals_mismatch"),
        ({"type_code": "381"}, "document_snapshot_invalid"),
        ({"currency": "USD"}, "document_snapshot_invalid"),
        ({"lines": ()}, "document_snapshot_invalid"),
        ({"lines": (Line(1, "x", 2, 1000, 2001, 2000, 400),)}, "document_line_amounts"),
        ({"vat_regime": "eu_reverse_charge"}, "document_vat_evidence_missing"),
    ],
)
def test_snapshot_mutations_refuse_with_named_reason(change, message):
    with pytest.raises(IntegrityRefusedError, match=message):
        render_xml(snapshot(**change))


def test_missing_real_renderer_or_validator_never_publishes_xml_as_facturx():
    with pytest.raises(FacturXUnavailableError, match="independent conformance validator required"):
        render_facturx(snapshot(), renderer=None, validator=None)


def test_independent_validator_failure_propagates_without_publication():
    class Renderer:
        def render(self, snapshot, xml):
            return b"%PDF-invalid"

    class Validator:
        def validate(self, **kwargs):
            raise IntegrityRefusedError("pdfa3_conformance_failed")

    with pytest.raises(IntegrityRefusedError, match="pdfa3_conformance_failed"):
        render_facturx(snapshot(), renderer=Renderer(), validator=Validator())


def test_gapless_invoice_and_credit_series_accept_rolled_back_number_reuse():
    verify_series(
        [
            NumberedRecord("TST-2026-00002", NOW + timedelta(seconds=1)),
            NumberedRecord("TST-2026-00001", NOW),
            NumberedRecord("AV-TST-2026-00001", NOW),
        ],
        {("TST", 2026): 2, ("AV-TST", 2026): 1},
    )


@pytest.mark.parametrize(
    ("records", "counters", "message"),
    [
        ([NumberedRecord("TST-2026-00002", NOW)], {("TST", 2026): 2}, "numbering_gap"),
        ([NumberedRecord("TST-2026-00001", NOW)] * 2, {("TST", 2026): 2}, "numbering_gap"),
        ([NumberedRecord("TST-2026-00001", NOW)], {("TST", 2026): 2}, "numbering_gap"),
        ([], {("TST", 2026): 1}, "numbering_gap"),
        ([NumberedRecord("TST-2026-00001", NOW)], {}, "numbering_counter_invalid"),
        ([NumberedRecord("TST-2025-00001", NOW)], {("TST", 2025): 1}, "numbering_format_or_year"),
        (
            [
                NumberedRecord("TST-2026-00001", NOW),
                NumberedRecord("TST-2026-00002", NOW - timedelta(seconds=1)),
            ],
            {("TST", 2026): 2},
            "numbering_date_order",
        ),
    ],
)
def test_series_refusal_mutations_name_exact_failure(records, counters, message):
    with pytest.raises(IntegrityRefusedError, match=message):
        verify_series(records, counters)


def test_year_boundary_uses_paris_accounting_date():
    verify_series(
        [NumberedRecord("TST-2027-00001", datetime(2026, 12, 31, 23, 30, tzinfo=UTC))],
        {("TST", 2027): 1},
    )
