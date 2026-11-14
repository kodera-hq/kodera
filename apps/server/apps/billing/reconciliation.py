"""Read-only ledger findings; provider observations never create or repair money."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection, transaction

from .integrity import IntegrityRefusedError, NumberedRecord, verify_series


@dataclass(frozen=True)
class Finding:
    code: str
    resource_id: str | None = None


def _observations(value: object) -> tuple[dict[str, tuple[int, str]], set[tuple[str, str]]]:
    if (
        not isinstance(value, dict)
        or set(value) != {"schema_version", "invoices", "payments"}
        or value["schema_version"] != 1
    ):
        raise IntegrityRefusedError("reconciliation_observations_schema")
    invoices: dict[str, tuple[int, str]] = {}
    payments: set[tuple[str, str]] = set()
    for section in ("invoices", "payments"):
        rows = value[section]
        if not isinstance(rows, list) or len(rows) > 10_000:
            raise IntegrityRefusedError("reconciliation_observations_bound")
        for row in rows:
            if not isinstance(row, dict):
                raise IntegrityRefusedError("reconciliation_observations_schema")
            if section == "invoices":
                if set(row) != {"core_invoice_id", "amount_minor", "currency"}:
                    raise IntegrityRefusedError("reconciliation_observations_schema")
                try:
                    key = str(UUID(row["core_invoice_id"]))
                except (ValueError, TypeError, AttributeError):
                    raise IntegrityRefusedError("reconciliation_observations_schema") from None
                if (
                    isinstance(row["amount_minor"], bool)
                    or not isinstance(row["amount_minor"], int)
                    or row["amount_minor"] < 0
                    or row["currency"] != "EUR"
                    or key in invoices
                ):
                    raise IntegrityRefusedError("reconciliation_observations_schema")
                invoices[key] = row["amount_minor"], row["currency"]
            else:
                if set(row) != {"provider", "provider_ref"} or any(
                    not isinstance(row.get(k), str) or not 1 <= len(row[k]) <= 255
                    for k in ("provider", "provider_ref")
                ):
                    raise IntegrityRefusedError("reconciliation_observations_schema")
                key_pair = row["provider"], row["provider_ref"]
                if key_pair in payments:
                    raise IntegrityRefusedError("reconciliation_observations_duplicate")
                payments.add(key_pair)
    return invoices, payments


def findings(*, observations: dict[str, Any] | None = None) -> tuple[Finding, ...]:
    """Provider document observations refer to an e-invoice platform, never Stripe Billing.

    Omitted evidence remains an explicit finding. A succeeded unallocated payment is reproduced
    on every run until its ledger classification changes, independent of provider observations.
    """
    from .models import (
        CreditNote,
        Invoice,
        InvoiceNumberCounter,
        Payment,
        ProviderEvent,
        ViesConsultation,
    )

    observed_invoices, observed_payments = (
        ({}, set()) if observations is None else _observations(observations)
    )
    report: list[Finding] = []
    if observations is None:
        report.append(Finding("provider_observations_not_checked"))
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        invoices = list(Invoice.objects.exclude(state="draft"))
        notes = list(CreditNote.objects.all())
        counters = {
            (s, y): n
            for s, y, n in InvoiceNumberCounter.objects.values_list("series", "year", "last_number")
        }
        try:
            numbered: list[NumberedRecord] = []
            documents: list[Invoice | CreditNote] = [*invoices, *notes]
            for document in documents:
                if document.number is None or document.issued_at is None:
                    raise IntegrityRefusedError("numbering_format_or_year")
                numbered.append(NumberedRecord(document.number, document.issued_at))
            verify_series(numbered, counters)
        except IntegrityRefusedError as refused:
            report.append(Finding(str(refused)))
        for row in invoices:
            identifier = str(row.id)
            if row.issued_at is None:
                report.append(Finding("numbering_format_or_year", identifier))
                continue
            if observations is not None:
                observed = observed_invoices.get(identifier)
                if observed is None:
                    report.append(Finding("invoice_missing_at_provider", identifier))
                elif observed != (row.total_incl_vat_minor, row.currency):
                    report.append(Finding("invoice_total_mismatch", identifier))
            if row.vat_regime == "eu_reverse_charge":
                proof = (
                    ViesConsultation.objects.filter(
                        organisation_id=row.organisation_id,
                        country_code=row.customer_country,
                        vat_number=row.customer_vat_number,
                        checked_at__lte=row.issued_at,
                    )
                    .order_by("-checked_at", "-id")
                    .first()
                )
                if proof is None or proof.status != "valid" or proof.next_check_at <= row.issued_at:
                    report.append(Finding("vies_evidence_missing", identifier))
        payments = list(Payment.objects.all())
        known = {(row.provider, row.provider_ref) for row in payments}
        report.extend(
            Finding("payment_unmatched", provider + ":" + reference)
            for provider, reference in sorted(observed_payments - known)
        )
        report.extend(
            Finding("payment_unallocated", str(row.id))
            for row in payments
            if row.state == "succeeded" and not row.allocated
        )
        report.extend(
            Finding("payment_unmatched", str(identifier))
            for identifier in ProviderEvent.objects.filter(outcome="unmatched").values_list(
                "id", flat=True
            )
        )
    return tuple(report)
