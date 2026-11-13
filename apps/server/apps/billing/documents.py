"""Deterministic CII from frozen ledger rows and a fail-closed Factur-X packaging boundary.

XML output alone is not a conforming Factur-X document. Publication requires an independently
configured PDF/A-3 renderer and validator, including XSD/Schematron and embedded-XML validation.
No default implementation makes an unproven conformance claim.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Protocol
from xml.etree import ElementTree as ET

from .integrity import PARIS, IntegrityRefusedError

NS = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
    "udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
}
for _prefix, _uri in NS.items():
    ET.register_namespace(_prefix, _uri)


@dataclass(frozen=True)
class Party:
    name: str
    address: str
    country: str
    vat_number: str | None
    postal_code: str | None = None
    city: str | None = None


@dataclass(frozen=True)
class Line:
    position: int
    description: str
    quantity: int
    unit_minor: int
    net_minor: int
    vat_rate_bp: int
    vat_minor: int


@dataclass(frozen=True)
class Snapshot:
    number: str
    type_code: str
    issued_at: datetime
    due_at: datetime | None
    currency: str
    vat_regime: str
    vat_mention: str | None
    seller: Party
    buyer: Party
    lines: tuple[Line, ...]
    net_minor: int
    vat_minor: int
    gross_minor: int
    original_invoice_number: str | None = None

    def canonical(self) -> bytes:
        return json.dumps(
            asdict(self), sort_keys=True, separators=(",", ":"), default=lambda v: v.isoformat()
        ).encode()

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.canonical()).hexdigest()


def snapshot_of(row: object) -> Snapshot:
    """Read only invoice/credit-note frozen columns and lines, never catalogue or profile rows."""
    from .models import CreditNote, Invoice

    if not isinstance(row, (Invoice, CreditNote)):
        raise IntegrityRefusedError("document_kind")
    if row.issued_at is None or (isinstance(row, Invoice) and row.state == "draft"):
        raise IntegrityRefusedError("document_not_issued")
    credit = isinstance(row, CreditNote)
    # Country is an existing frozen tax-registration prefix, not a current issuer setting.
    country = row.issuer_vat_number[:2]
    return Snapshot(
        number=row.number or "",
        type_code="381" if credit else "380",
        issued_at=row.issued_at,
        due_at=row.due_at if isinstance(row, Invoice) else None,
        currency=row.currency,
        vat_regime=row.vat_regime,
        vat_mention=row.vat_mention,
        seller=Party(row.issuer_legal_name, row.issuer_address, country, row.issuer_vat_number),
        buyer=Party(
            row.customer_legal_name,
            row.customer_address_line1,
            row.customer_country,
            row.customer_vat_number,
            row.customer_postal_code,
            row.customer_city,
        ),
        lines=tuple(
            Line(
                line.position,
                line.description,
                line.quantity,
                line.unit_amount_minor,
                line.total_excl_vat_minor,
                line.vat_rate_bp,
                line.vat_amount_minor,
            )
            for line in row.lines.order_by("position")
        ),
        net_minor=row.total_excl_vat_minor,
        vat_minor=row.vat_amount_minor,
        gross_minor=row.total_incl_vat_minor,
        original_invoice_number=row.invoice.number if isinstance(row, CreditNote) else None,
    )


def _money(value: int) -> str:
    return f"{value // 100}.{value % 100:02d}"


def _add(parent: ET.Element, name: str, value: object | None = None, **attrs: str) -> ET.Element:
    prefix, local = name.split(":")
    child = ET.SubElement(parent, f"{{{NS[prefix]}}}{local}", attrs)
    if value is not None:
        child.text = str(value)
    return child


def _party(parent: ET.Element, name: str, party: Party) -> None:
    node = _add(parent, name)
    _add(node, "ram:Name", party.name)
    address = _add(node, "ram:PostalTradeAddress")
    if party.postal_code:
        _add(address, "ram:PostcodeCode", party.postal_code)
    _add(address, "ram:LineOne", party.address)
    if party.city:
        _add(address, "ram:CityName", party.city)
    _add(address, "ram:CountryID", party.country)
    if party.vat_number:
        _add(_add(node, "ram:SpecifiedTaxRegistration"), "ram:ID", party.vat_number, schemeID="VA")


def _date(parent: ET.Element, name: str, moment: datetime) -> None:
    _add(
        _add(parent, name),
        "udt:DateTimeString",
        moment.astimezone(PARIS).strftime("%Y%m%d"),
        format="102",
    )


def _validate(s: Snapshot) -> None:
    if (
        s.type_code not in {"380", "381"}
        or not s.number
        or s.issued_at.tzinfo is None
        or s.currency != "EUR"
        or not s.lines
        or (s.type_code == "381") != s.number.startswith("AV-")
        or (s.type_code == "381" and not s.original_invoice_number)
    ):
        raise IntegrityRefusedError("document_snapshot_invalid")
    if s.vat_regime not in {"fr_standard", "eu_reverse_charge", "exempt", "outside_eu"}:
        raise IntegrityRefusedError("document_vat_regime")
    if s.vat_regime == "eu_reverse_charge" and not s.buyer.vat_number:
        raise IntegrityRefusedError("document_vat_evidence_missing")
    if any(not p.name or not p.address or len(p.country) != 2 for p in (s.seller, s.buyer)):
        raise IntegrityRefusedError("document_party_invalid")
    if len({line.position for line in s.lines}) != len(s.lines):
        raise IntegrityRefusedError("document_line_positions")
    for line in s.lines:
        values = (line.quantity, line.unit_minor, line.net_minor, line.vat_rate_bp, line.vat_minor)
        if (
            any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in values)
            or line.quantity < 1
            or line.quantity * line.unit_minor != line.net_minor
            or line.vat_rate_bp > 10_000
        ):
            raise IntegrityRefusedError("document_line_amounts")
    if (
        sum(line.net_minor for line in s.lines) != s.net_minor
        or sum(line.vat_minor for line in s.lines) != s.vat_minor
        or s.net_minor + s.vat_minor != s.gross_minor
    ):
        raise IntegrityRefusedError("document_totals_mismatch")


def render_xml(s: Snapshot) -> bytes:
    """CII EN16931 candidate; external XSD/Schematron validation is required before publication."""
    _validate(s)
    root = ET.Element(f"{{{NS['rsm']}}}CrossIndustryInvoice")
    context = _add(root, "rsm:ExchangedDocumentContext")
    _add(
        _add(context, "ram:GuidelineSpecifiedDocumentContextParameter"),
        "ram:ID",
        "urn:cen.eu:en16931:2017",
    )
    document = _add(root, "rsm:ExchangedDocument")
    _add(document, "ram:ID", s.number)
    _add(document, "ram:TypeCode", s.type_code)
    _date(document, "ram:IssueDateTime", s.issued_at)
    if s.vat_mention:
        _add(_add(document, "ram:IncludedNote"), "ram:Content", s.vat_mention)
    transaction = _add(root, "rsm:SupplyChainTradeTransaction")
    category = {"fr_standard": "S", "eu_reverse_charge": "AE", "exempt": "E", "outside_eu": "O"}[
        s.vat_regime
    ]
    totals: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for line in sorted(s.lines, key=lambda item: item.position):
        node = _add(transaction, "ram:IncludedSupplyChainTradeLineItem")
        _add(_add(node, "ram:AssociatedDocumentLineDocument"), "ram:LineID", line.position)
        _add(_add(node, "ram:SpecifiedTradeProduct"), "ram:Name", line.description)
        agreement = _add(node, "ram:SpecifiedLineTradeAgreement")
        _add(
            _add(agreement, "ram:NetPriceProductTradePrice"),
            "ram:ChargeAmount",
            _money(line.unit_minor),
        )
        _add(
            _add(node, "ram:SpecifiedLineTradeDelivery"),
            "ram:BilledQuantity",
            line.quantity,
            unitCode="C62",
        )
        settlement = _add(node, "ram:SpecifiedLineTradeSettlement")
        tax = _add(settlement, "ram:ApplicableTradeTax")
        _add(tax, "ram:TypeCode", "VAT")
        _add(tax, "ram:CategoryCode", category)
        _add(tax, "ram:RateApplicablePercent", _money(line.vat_rate_bp))
        _add(
            _add(settlement, "ram:SpecifiedTradeSettlementLineMonetarySummation"),
            "ram:LineTotalAmount",
            _money(line.net_minor),
        )
        totals[line.vat_rate_bp][0] += line.net_minor
        totals[line.vat_rate_bp][1] += line.vat_minor
    agreement = _add(transaction, "ram:ApplicableHeaderTradeAgreement")
    _party(agreement, "ram:SellerTradeParty", s.seller)
    _party(agreement, "ram:BuyerTradeParty", s.buyer)
    _add(transaction, "ram:ApplicableHeaderTradeDelivery")
    settlement = _add(transaction, "ram:ApplicableHeaderTradeSettlement")
    _add(settlement, "ram:InvoiceCurrencyCode", s.currency)
    for rate, (net, vat) in sorted(totals.items()):
        tax = _add(settlement, "ram:ApplicableTradeTax")
        _add(tax, "ram:CalculatedAmount", _money(vat))
        _add(tax, "ram:TypeCode", "VAT")
        if s.vat_mention:
            _add(tax, "ram:ExemptionReason", s.vat_mention)
        _add(tax, "ram:BasisAmount", _money(net))
        _add(tax, "ram:CategoryCode", category)
        _add(tax, "ram:RateApplicablePercent", _money(rate))
    if s.due_at is not None:
        _date(_add(settlement, "ram:SpecifiedTradePaymentTerms"), "ram:DueDateDateTime", s.due_at)
    sums = _add(settlement, "ram:SpecifiedTradeSettlementHeaderMonetarySummation")
    for name, value in (
        ("LineTotalAmount", s.net_minor),
        ("TaxBasisTotalAmount", s.net_minor),
        ("TaxTotalAmount", s.vat_minor),
        ("GrandTotalAmount", s.gross_minor),
        ("DuePayableAmount", s.gross_minor),
    ):
        _add(
            sums,
            "ram:" + name,
            _money(value),
            **({"currencyID": s.currency} if name == "TaxTotalAmount" else {}),
        )
    if s.original_invoice_number:
        _add(
            _add(settlement, "ram:InvoiceReferencedDocument"),
            "ram:IssuerAssignedID",
            s.original_invoice_number,
        )
    return bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


class FacturXUnavailableError(RuntimeError):
    """Production document conformance is not configured or has not been demonstrated."""


class Renderer(Protocol):
    def render(self, snapshot: Snapshot, xml: bytes) -> bytes: ...


class Validator(Protocol):
    def validate(self, *, pdf: bytes, xml: bytes, snapshot_sha256: str) -> None:
        """Raise unless PDF/A-3, XSD, EN16931 Schematron and embedded XML all validate."""
        ...


def render_facturx(
    snapshot: Snapshot, *, renderer: Renderer | None, validator: Validator | None
) -> tuple[bytes, bytes]:
    if renderer is None or validator is None:
        raise FacturXUnavailableError(
            "Factur-X renderer and independent conformance validator required"
        )
    xml = render_xml(snapshot)
    pdf = renderer.render(snapshot, xml)
    if not isinstance(pdf, bytes) or not pdf.startswith(b"%PDF-") or len(pdf) > 10_000_000:
        raise IntegrityRefusedError("document_pdf_invalid")
    validator.validate(pdf=pdf, xml=xml, snapshot_sha256=snapshot.sha256)
    return pdf, xml
