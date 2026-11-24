"""DAC7 (`Directive (EU) 2021/514` / CGI art. 1649 ter A) annual creator reporting aggregator.

Evaluates seller consideration and relevant-activity counts across Volet B `CreatorSplitLedgerEntry`
records per calendar year:
- Reportable threshold: `transaction_count >= 30` OR `net_consideration_minor > 200_000` (`> 2,000.00 EUR`).
- Consideration is strictly integer minor units net of VAT, platform fees, refunds, and chargebacks,
  with cross-quarter deficit carry within the same reporting year so `sum(quarters) == annual_total`.
- Refunds and chargebacks of prior-year sales (`sale_year < reporting_year`) are isolated as `DPI2`
  prior-year corrections rather than reducing current-year activity counts.
- Supports GDPR Art. 17(3)(b) statutory retention via `Dac7SellerStatutorySnapshot` when a creator
  erases their user/organisation account within the statutory tax window.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import datetime
from uuid import UUID
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

from django.conf import settings

from .configuration import Issuer
from .models import (
    CreatorConnectAccount,
    CreatorSplitLedgerEntry,
    Dac7SellerStatutorySnapshot,
)
from .vip_connect import unseal_tax_tin

PARIS = ZoneInfo("Europe/Paris")
DAC7_MIN_TRANSACTIONS = 30
DAC7_MIN_CONSIDERATION_MINOR = 200_000  # 2,000.00 EUR (strict `>` per Directive 2021/514)
DPI_NS = "urn:oecd:ties:dpi:v1"
ET.register_namespace("dpi", DPI_NS)

# XML 1.0 illegal characters: C0 controls except TAB/LF/CR, DEL, surrogates, and FFFE/FFFF.
_XML10_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff\ufffe\uffff]+")


def _sanitize_xml10_text(value: str) -> str:
    return _XML10_ILLEGAL_RE.sub("", value).strip()


@dataclass(frozen=True, slots=True)
class Dac7SellerInput:
    connect_account_id: UUID
    organisation_id: UUID
    workspace_id: UUID
    stripe_connect_account_id: str | None
    seller_legal_name: str
    tax_residence_country: str
    tax_tin: str | None
    tin_present: bool | None = None


@dataclass(frozen=True, slots=True)
class Dac7LedgerEventInput:
    connect_account_id: UUID
    entitlement_id: UUID
    entry_kind: str
    currency: str
    gross_excl_vat_minor: int
    vat_amount_minor: int
    application_fee_amount_minor: int
    dispute_fee_minor: int
    creator_net_minor: int
    occurred_at: datetime
    fully_reversed_entitlement: bool = False
    sale_occurred_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Dac7PriorYearCorrection:
    original_reporting_year: int
    message_type_indic: str
    entitlement_id: str
    entry_kind: str
    net_consideration_delta_minor: int
    platform_fees_delta_minor: int
    taxes_delta_minor: int
    revokes_activity: bool


@dataclass(frozen=True, slots=True)
class Dac7QuarterSummary:
    quarter: str
    transaction_count: int
    net_consideration_minor: int
    platform_fees_minor: int
    taxes_withheld_minor: int


@dataclass(frozen=True, slots=True)
class Dac7SellerSummary:
    connect_account_id: str
    workspace_id: str
    stripe_connect_account_id: str | None
    seller_legal_name: str
    tax_residence_country: str
    tax_tin: str | None
    tin_present: bool
    currency: str
    transaction_count: int
    raw_signed_consideration_minor: int
    net_consideration_minor: int
    platform_fees_minor: int
    taxes_withheld_minor: int
    reportable: bool
    reportable_reasons: tuple[str, ...]
    quarters: tuple[Dac7QuarterSummary, ...]
    prior_year_corrections: tuple[Dac7PriorYearCorrection, ...] = ()


@dataclass(frozen=True, slots=True)
class Dac7AnnualReport:
    directive: str
    reporting_year: int
    platform_operator_name: str
    platform_operator_country: str
    platform_operator_siren: str
    total_sellers_evaluated: int
    reportable_seller_count: int
    sellers: tuple[Dac7SellerSummary, ...]
    has_prior_year_corrections: bool = False


def _quarter_index(moment: datetime) -> int:
    month = moment.astimezone(PARIS).month
    return (month - 1) // 3


def _carry_quarterly_non_negative(values: list[int]) -> tuple[int, int, int, int]:
    """Carry negative quarterly adjustments across quarters of the same year so every quarter is
    `>= 0` and `sum(quarters) == max(0, sum(values))`."""
    work = [int(v) for v in values]
    for idx in range(3, 0, -1):
        if work[idx] < 0:
            work[idx - 1] += work[idx]
            work[idx] = 0
    for idx in range(0, 3):
        if work[idx] < 0:
            work[idx + 1] += work[idx]
            work[idx] = 0
    if work[3] < 0:
        work[3] = 0
    return (work[0], work[1], work[2], work[3])


def is_dac7_reportable(
    *, transaction_count: int, net_consideration_minor: int
) -> tuple[bool, tuple[str, ...]]:
    """Evaluate `Directive (EU) 2021/514` seller reporting thresholds (`>= 30` tx or `> 2,000 EUR`)."""
    reasons: list[str] = []
    if transaction_count >= DAC7_MIN_TRANSACTIONS:
        reasons.append("transactions_gte_30")
    if net_consideration_minor > DAC7_MIN_CONSIDERATION_MINOR:
        reasons.append("consideration_gt_2000_eur")
    return bool(reasons), tuple(reasons)


def aggregate_dac7_annual_report(
    *,
    reporting_year: int,
    sellers: Sequence[Dac7SellerInput],
    entries: Sequence[Dac7LedgerEventInput],
    platform_operator_name: str = "Samouraï Coop",
    platform_operator_country: str = "FR",
    platform_operator_siren: str = "000000000",
    reportable_only: bool = False,
) -> Dac7AnnualReport:
    """Deterministically aggregate annual & quarterly DAC7 figures across all creators."""
    if reporting_year < 2023 or reporting_year > 9999:
        raise ValueError("invalid DAC7 reporting_year")

    sale_moment_by_entitlement: dict[UUID, datetime] = {}
    for entry in entries:
        if entry.occurred_at.tzinfo is None:
            raise ValueError("DAC7 ledger entry occurred_at must carry timezone offset")
        if entry.sale_occurred_at is not None and entry.sale_occurred_at.tzinfo is None:
            raise ValueError("DAC7 ledger entry sale_occurred_at must carry timezone offset")
        if entry.entry_kind == "sale":
            prev = sale_moment_by_entitlement.get(entry.entitlement_id)
            if prev is None or entry.occurred_at < prev:
                sale_moment_by_entitlement[entry.entitlement_id] = entry.occurred_at

    entries_by_account: dict[UUID, list[Dac7LedgerEventInput]] = {
        s.connect_account_id: [] for s in sellers
    }
    for entry in entries:
        if entry.occurred_at.astimezone(PARIS).year != reporting_year:
            continue
        if entry.currency != "EUR":
            raise ValueError(f"unsupported DAC7 currency {entry.currency!r}")
        if entry.connect_account_id in entries_by_account:
            entries_by_account[entry.connect_account_id].append(entry)

    summaries: list[Dac7SellerSummary] = []
    any_prior_corrections = False

    for seller in sorted(sellers, key=lambda item: str(item.connect_account_id)):
        clean_tin: str | None = None
        if seller.tax_tin is not None:
            stripped_tin = _sanitize_xml10_text(seller.tax_tin)
            if stripped_tin == "SEALED":
                raise ValueError("DAC7 tax_tin must never contain literal 'SEALED' placeholder")
            clean_tin = stripped_tin or None

        tin_present = seller.tin_present if seller.tin_present is not None else bool(clean_tin)
        acct_entries = sorted(
            entries_by_account.get(seller.connect_account_id, ()),
            key=lambda e: (e.occurred_at, str(e.entitlement_id), e.entry_kind),
        )
        q_tx = [0, 0, 0, 0]
        q_net = [0, 0, 0, 0]
        q_fees = [0, 0, 0, 0]
        q_taxes = [0, 0, 0, 0]
        reversed_entitlements: set[UUID] = set()
        prior_corrections: list[Dac7PriorYearCorrection] = []

        for entry in acct_entries:
            origin_moment = (
                entry.sale_occurred_at
                or sale_moment_by_entitlement.get(entry.entitlement_id)
                or entry.occurred_at
            )
            origin_year = origin_moment.astimezone(PARIS).year
            if entry.entry_kind in {"refund", "chargeback"} and origin_year < reporting_year:
                revokes = (
                    entry.fully_reversed_entitlement
                    and entry.entitlement_id not in reversed_entitlements
                )
                if revokes:
                    reversed_entitlements.add(entry.entitlement_id)
                prior_corrections.append(
                    Dac7PriorYearCorrection(
                        original_reporting_year=origin_year,
                        message_type_indic="DPI2",
                        entitlement_id=str(entry.entitlement_id),
                        entry_kind=entry.entry_kind,
                        net_consideration_delta_minor=entry.creator_net_minor,
                        platform_fees_delta_minor=(
                            entry.application_fee_amount_minor + entry.dispute_fee_minor
                        ),
                        taxes_delta_minor=entry.vat_amount_minor,
                        revokes_activity=revokes,
                    )
                )
                continue

            qi = _quarter_index(entry.occurred_at)
            q_net[qi] += entry.creator_net_minor
            q_fees[qi] += entry.application_fee_amount_minor + entry.dispute_fee_minor
            q_taxes[qi] += entry.vat_amount_minor
            if entry.entry_kind == "sale":
                q_tx[qi] += 1
            elif (
                entry.entry_kind in {"refund", "chargeback"}
                and entry.fully_reversed_entitlement
                and entry.entitlement_id not in reversed_entitlements
            ):
                reversed_entitlements.add(entry.entitlement_id)
                q_tx[qi] -= 1

        raw_total_net = sum(q_net)
        carried_tx = _carry_quarterly_non_negative(q_tx)
        carried_net = _carry_quarterly_non_negative(q_net)
        carried_fees = _carry_quarterly_non_negative(q_fees)
        carried_taxes = _carry_quarterly_non_negative(q_taxes)

        quarters = tuple(
            Dac7QuarterSummary(
                quarter=f"Q{idx + 1}",
                transaction_count=carried_tx[idx],
                net_consideration_minor=carried_net[idx],
                platform_fees_minor=carried_fees[idx],
                taxes_withheld_minor=carried_taxes[idx],
            )
            for idx in range(4)
        )
        total_net = sum(carried_net)
        total_tx = sum(carried_tx)
        total_fees = sum(carried_fees)
        total_taxes = sum(carried_taxes)
        reportable, reasons = is_dac7_reportable(
            transaction_count=total_tx,
            net_consideration_minor=total_net,
        )
        if prior_corrections:
            any_prior_corrections = True
        summary = Dac7SellerSummary(
            connect_account_id=str(seller.connect_account_id),
            workspace_id=str(seller.workspace_id),
            stripe_connect_account_id=seller.stripe_connect_account_id,
            seller_legal_name=_sanitize_xml10_text(seller.seller_legal_name),
            tax_residence_country=_sanitize_xml10_text(seller.tax_residence_country).upper(),
            tax_tin=clean_tin,
            tin_present=tin_present,
            currency="EUR",
            transaction_count=total_tx,
            raw_signed_consideration_minor=raw_total_net,
            net_consideration_minor=total_net,
            platform_fees_minor=total_fees,
            taxes_withheld_minor=total_taxes,
            reportable=reportable,
            reportable_reasons=reasons,
            quarters=quarters,
            prior_year_corrections=tuple(prior_corrections),
        )
        if not reportable_only or summary.reportable or bool(summary.prior_year_corrections):
            summaries.append(summary)

    reportable_count = sum(1 for s in summaries if s.reportable)
    return Dac7AnnualReport(
        directive="2021/514/EU",
        reporting_year=reporting_year,
        platform_operator_name=_sanitize_xml10_text(platform_operator_name),
        platform_operator_country=_sanitize_xml10_text(platform_operator_country).upper(),
        platform_operator_siren=_sanitize_xml10_text(platform_operator_siren),
        total_sellers_evaluated=len(sellers),
        reportable_seller_count=reportable_count,
        sellers=tuple(summaries),
        has_prior_year_corrections=any_prior_corrections,
    )


def _minor_to_decimal_str(minor: int) -> str:
    sign = "-" if minor < 0 else ""
    abs_val = abs(minor)
    return f"{sign}{abs_val // 100}.{abs_val % 100:02d}"


def render_dac7_json(report: Dac7AnnualReport) -> bytes:
    """Serialize `Dac7AnnualReport` deterministically to canonical UTF-8 JSON."""
    return json.dumps(
        asdict(report),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def render_dac7_xml(report: Dac7AnnualReport) -> bytes:
    """Serialize `Dac7AnnualReport` to OECD DPI / EU DAC7 XML (`urn:oecd:ties:dpi:v1`)."""

    def tag(name: str) -> str:
        return f"{{{DPI_NS}}}{name}"

    root = ET.Element(tag("DPI_OECD"), {"version": "1.0"})
    spec = ET.SubElement(root, tag("MessageSpec"))
    ET.SubElement(spec, tag("SendingCountry")).text = _sanitize_xml10_text(
        report.platform_operator_country
    )
    ET.SubElement(spec, tag("MessageType")).text = "DPI"
    ET.SubElement(spec, tag("MessageTypeIndic")).text = (
        "DPI2" if report.has_prior_year_corrections else "DPI1"
    )
    ET.SubElement(spec, tag("ReportingPeriod")).text = f"{report.reporting_year}-12-31"

    body = ET.SubElement(root, tag("DPIBody"))
    operator = ET.SubElement(body, tag("PlatformOperator"))
    ET.SubElement(operator, tag("ResCountryCode")).text = _sanitize_xml10_text(
        report.platform_operator_country
    )
    ET.SubElement(operator, tag("IN"), {"INType": "SIREN"}).text = _sanitize_xml10_text(
        report.platform_operator_siren
    )
    ET.SubElement(operator, tag("Name")).text = _sanitize_xml10_text(report.platform_operator_name)

    for seller in report.sellers:
        if seller.reportable:
            node = ET.SubElement(body, tag("ReportableSeller"))
            identity = ET.SubElement(node, tag("Identity"))
            country_code = _sanitize_xml10_text(seller.tax_residence_country)
            ET.SubElement(identity, tag("ResCountryCode")).text = country_code
            clean_tin = _sanitize_xml10_text(seller.tax_tin) if seller.tax_tin else ""
            if clean_tin and clean_tin != "SEALED":
                ET.SubElement(
                    identity,
                    tag("TIN"),
                    {"issuedBy": country_code},
                ).text = clean_tin
            else:
                ET.SubElement(identity, tag("TIN"), {"unknown": "true"})
            ET.SubElement(identity, tag("LegalName")).text = _sanitize_xml10_text(
                seller.seller_legal_name
            )

            activities = ET.SubElement(node, tag("RelevantActivities"))
            personal_services = ET.SubElement(activities, tag("PersonalServices"))
            consideration = ET.SubElement(personal_services, tag("Consideration"))
            counts = ET.SubElement(personal_services, tag("NumberOfActivities"))
            fees = ET.SubElement(personal_services, tag("Fees"))
            taxes = ET.SubElement(personal_services, tag("Taxes"))

            for q in seller.quarters:
                ET.SubElement(
                    consideration,
                    tag(f"Cons{q.quarter}"),
                    {"currCode": seller.currency},
                ).text = _minor_to_decimal_str(q.net_consideration_minor)
                ET.SubElement(counts, tag(f"Numb{q.quarter}")).text = str(q.transaction_count)
                ET.SubElement(
                    fees,
                    tag(f"Fees{q.quarter}"),
                    {"currCode": seller.currency},
                ).text = _minor_to_decimal_str(q.platform_fees_minor)
                ET.SubElement(
                    taxes,
                    tag(f"Tax{q.quarter}"),
                    {"currCode": seller.currency},
                ).text = _minor_to_decimal_str(q.taxes_withheld_minor)

        for corr in seller.prior_year_corrections:
            cnode = ET.SubElement(
                body,
                tag("PriorYearCorrection"),
                {
                    "originalReportingPeriod": f"{corr.original_reporting_year}-12-31",
                    "messageTypeIndic": corr.message_type_indic,
                },
            )
            ET.SubElement(cnode, tag("SellerRef")).text = seller.connect_account_id
            ET.SubElement(cnode, tag("EntitlementRef")).text = corr.entitlement_id
            ET.SubElement(
                cnode, tag("ConsiderationDelta"), {"currCode": seller.currency}
            ).text = _minor_to_decimal_str(corr.net_consideration_delta_minor)

    return bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def build_dac7_annual_report_from_db(
    *,
    reporting_year: int,
    include_unsealed_tin: bool = True,
    reportable_only: bool = False,
    seal_key: bytes | None = None,
    organisation_id: UUID | None = None,
    include_statutory_erased: bool = True,
) -> Dac7AnnualReport:
    """Load `CreatorConnectAccount` (falling back to `Dac7SellerStatutorySnapshot` when erased) &
    `CreatorSplitLedgerEntry` rows and compute the statutory DAC7 annual report."""
    issuer: Issuer | None = getattr(settings, "KODERA_BILLING_ISSUER", None)
    operator_name = issuer.legal_name if issuer is not None else "Samouraï Coop"
    operator_country = issuer.country if issuer is not None else "FR"
    if operator_country is None:
        raise ValueError("DAC7 platform operator country is not configured")
    operator_siren = issuer.siren if issuer is not None else "000000000"

    acct_qs = CreatorConnectAccount.objects.all()
    if organisation_id is not None:
        acct_qs = acct_qs.filter(organisation_id=organisation_id)
    accounts = list(acct_qs.order_by("id"))
    scrubbed_ids = (
        [a.id for a in accounts if a.pii_scrubbed_at is not None]
        if include_statutory_erased
        else []
    )
    snapshots_by_account: dict[UUID, Dac7SellerStatutorySnapshot] = (
        {
            snap.connect_account_id: snap
            for snap in Dac7SellerStatutorySnapshot.objects.filter(
                connect_account_id__in=scrubbed_ids
            )
        }
        if scrubbed_ids
        else {}
    )

    sellers: list[Dac7SellerInput] = []
    for acct in accounts:
        snap = snapshots_by_account.get(acct.id)
        if snap is not None:
            legal_name = snap.seller_legal_name
            residence_country = snap.tax_residence_country
            raw_sealed = bytes(snap.sealed_tax_tin) if snap.sealed_tax_tin else None
            aad_org = snap.organisation_reference
            aad_ws = snap.workspace_reference
            stripe_acct = snap.stripe_connect_account_id or acct.stripe_connect_account_id
        else:
            legal_name = acct.seller_legal_name
            residence_country = acct.tax_residence_country
            raw_sealed = bytes(acct.sealed_tax_tin) if acct.sealed_tax_tin else None
            aad_org = acct.organisation_id
            aad_ws = acct.workspace_id
            stripe_acct = acct.stripe_connect_account_id

        tin: str | None = None
        has_tin = raw_sealed is not None and len(raw_sealed) > 0
        if include_unsealed_tin and has_tin and raw_sealed is not None:
            tin = unseal_tax_tin(
                sealed_tin=raw_sealed,
                organisation_id=aad_org,
                workspace_id=aad_ws,
                country=residence_country,
                seal_key=seal_key,
            )

        sellers.append(
            Dac7SellerInput(
                connect_account_id=acct.id,
                organisation_id=acct.organisation_id,
                workspace_id=acct.workspace_id,
                stripe_connect_account_id=stripe_acct,
                seller_legal_name=legal_name,
                tax_residence_country=residence_country,
                tax_tin=tin,
                tin_present=has_tin,
            )
        )

    ledger_rows = list(
        CreatorSplitLedgerEntry.objects.select_related("entitlement")
        .filter(connect_account_id__in=[a.id for a in accounts])
        .order_by("occurred_at", "id")
    )
    sale_time_by_ent: dict[UUID, datetime] = {}
    for row in ledger_rows:
        if row.entry_kind == "sale":
            sale_time_by_ent[row.entitlement_id] = row.occurred_at
        elif (
            row.entitlement.activated_at is not None and row.entitlement_id not in sale_time_by_ent
        ):
            sale_time_by_ent[row.entitlement_id] = row.entitlement.activated_at

    entries = [
        Dac7LedgerEventInput(
            connect_account_id=row.connect_account_id,
            entitlement_id=row.entitlement_id,
            entry_kind=row.entry_kind,
            currency=row.currency,
            gross_excl_vat_minor=row.gross_excl_vat_minor,
            vat_amount_minor=row.vat_amount_minor,
            application_fee_amount_minor=row.application_fee_amount_minor,
            dispute_fee_minor=row.dispute_fee_minor,
            creator_net_minor=row.creator_net_minor,
            occurred_at=row.occurred_at,
            fully_reversed_entitlement=(
                row.entry_kind == "chargeback"
                or (
                    row.entry_kind == "refund"
                    and row.entitlement.refunded_incl_vat_minor
                    >= row.entitlement.total_incl_vat_minor
                )
            ),
            sale_occurred_at=sale_time_by_ent.get(row.entitlement_id),
        )
        for row in ledger_rows
    ]
    return aggregate_dac7_annual_report(
        reporting_year=reporting_year,
        sellers=sellers,
        entries=entries,
        platform_operator_name=operator_name,
        platform_operator_country=operator_country,
        platform_operator_siren=operator_siren,
        reportable_only=reportable_only,
    )
