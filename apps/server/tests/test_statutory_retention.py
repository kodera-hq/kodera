"""Real PostgreSQL statutory clocks and narrow worker mutation proofs."""

import json
from datetime import UTC, datetime

import pytest
from django.db import IntegrityError, connection, transaction

from apps.billing.models import FiscalPeriod

pytestmark = pytest.mark.django_db(transaction=True)


def period():
    return FiscalPeriod.objects.create(
        issuer_siren="000000000",
        starts_at=datetime(2025, 7, 1, tzinfo=UTC),
        closed_at=datetime(2026, 7, 1, tzinfo=UTC),
        timezone="UTC",
        authority_ref="FIN-100",
    )


def test_explicit_noncalendar_fiscal_clock_and_missing_authority_refusal():
    row = period()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT billing_accounting_clock(%s,%s)",
            [row.issuer_siren, datetime(2026, 2, 1, tzinfo=UTC)],
        )
        clock = json.loads(cursor.fetchone()[0])
        assert clock["financial_year_closed_at"].startswith("2026-07-01")
        assert clock["purge_after"].startswith("2036-07-01")
        assert clock["retention_authority_ref"] == "FIN-100"
    with (
        pytest.raises(IntegrityError, match="explicit fiscal authority absent"),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "SELECT billing_accounting_clock('000000000',%s)", [datetime(2026, 7, 1, tzinfo=UTC)]
        )


def test_fiscal_authority_is_immutable_and_overlap_is_never_selected_arbitrarily():
    row = period()
    with pytest.raises(IntegrityError, match="fiscal authority immutable"), transaction.atomic():
        FiscalPeriod.objects.filter(pk=row.id).update(timezone="Europe/Paris")
    with pytest.raises(IntegrityError, match="overlapping"), transaction.atomic():
        FiscalPeriod.objects.create(
            issuer_siren=row.issuer_siren,
            starts_at=row.starts_at,
            closed_at=row.closed_at,
            timezone="UTC",
            authority_ref="FIN-101",
        )


def current_period():
    from django.utils import timezone

    now = timezone.now()
    year = now.year if now.month >= 7 else now.year - 1
    return FiscalPeriod.objects.create(
        issuer_siren="000000000",
        starts_at=datetime(year, 7, 1, tzinfo=UTC),
        closed_at=datetime(year + 1, 7, 1, tzinfo=UTC),
        timezone="UTC",
        authority_ref="FIN-200",
    )


def test_real_invoice_and_line_freeze_common_exact_clock_and_detached_snapshot():
    from test_billing_orders import offer, place, world

    from apps.billing.models import Invoice, InvoiceLine, StatutoryRecord
    from apps.billing.statutory import purge_due

    fiscal = current_period()
    placed = place(world(), offer())
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    line = InvoiceLine.objects.get(invoice=invoice)
    assert invoice.accounting_event_at == invoice.issued_at == line.accounting_event_at
    assert invoice.financial_year_closed_at == line.financial_year_closed_at == fiscal.closed_at
    assert (
        invoice.purge_after
        == line.purge_after
        == fiscal.closed_at.replace(year=fiscal.closed_at.year + 10)
    )
    assert invoice.retention_authority_ref == "FIN-200"
    assert invoice.document_number_snapshot == line.document_number_snapshot == invoice.number
    records = StatutoryRecord.objects.order_by("source_table")
    assert records.count() == 2
    assert all(r.id.version == 7 for r in records)
    assert {r.source_table for r in records} == {"billing_invoice", "billing_invoiceline"}
    assert all(r.purge_after == invoice.purge_after for r in records)
    for model, row in [(Invoice, invoice), (InvoiceLine, line)]:
        for field in [
            "accounting_event_at",
            "financial_year_closed_at",
            "purge_after",
            "retention_authority_ref",
            "document_number_snapshot",
        ]:
            with pytest.raises(IntegrityError) as refused, transaction.atomic():
                model.objects.filter(pk=row.id).update(**{field: None})
            assert refused.value.__cause__.diag.constraint_name == (
                "billing_invoice_immutable" if model is Invoice else "billing_invoiceline_immutable"
            )
    with pytest.raises(IntegrityError, match="not due"), transaction.atomic():
        purge_due(source_table="billing_invoice", source_id=invoice.id)
    with pytest.raises(IntegrityError, match="statutory record immutable"), transaction.atomic():
        StatutoryRecord.objects.filter(pk=records.first().id).update(payload={})


def test_missing_fiscal_authority_rolls_back_real_order_invoice_and_number():
    from test_billing_orders import offer, place, world

    from apps.billing.models import Invoice, InvoiceNumberCounter, Order

    with (
        pytest.raises(IntegrityError, match="explicit fiscal authority absent"),
        transaction.atomic(),
    ):
        place(world(fiscal_authority=False), offer())
    assert not Invoice.objects.exists()
    assert not Order.objects.exists()
    assert not InvoiceNumberCounter.objects.exists()


def test_real_credit_note_and_lines_get_their_own_issued_event_clock():
    from test_billing_orders import offer, place, world

    from apps.billing import services
    from apps.billing.models import CreditNote, CreditNoteLine, StatutoryRecord

    current_period()
    placed = place(world(), offer())
    with transaction.atomic():
        note = services.issue_credit_note(placed.invoice, reason="customer_cancellation")
    note = CreditNote.objects.get(pk=note.id)
    line = CreditNoteLine.objects.get(credit_note=note)
    assert note.accounting_event_at == note.issued_at == line.accounting_event_at
    assert note.accounting_event_at > placed.invoice.issued_at
    assert (
        StatutoryRecord.objects.filter(
            source_table__in=["billing_creditnote", "billing_creditnoteline"]
        ).count()
        == 2
    )
    with pytest.raises(IntegrityError, match="immutable"), transaction.atomic():
        CreditNoteLine.objects.filter(pk=line.id).update(purge_after=None)


def test_real_payment_event_freezes_its_clock_and_money_binding():
    from django.utils import timezone
    from test_billing_orders import offer, place, world

    from apps.billing.models import Payment, StatutoryRecord

    current_period()
    placed = place(world(), offer())
    payment = Payment.objects.create(
        organisation_id=placed.order.organisation_id,
        invoice=placed.invoice,
        provider="fake",
        provider_ref="synthetic-retention-payment",
        amount_minor=100,
        currency="EUR",
    )
    assert payment.accounting_event_at is None
    event = timezone.now()
    Payment.objects.filter(pk=payment.id).update(state="succeeded", last_event_at=event)
    payment.refresh_from_db()
    assert payment.accounting_event_at == event
    assert (
        StatutoryRecord.objects.filter(source_table="billing_payment", source_id=payment.id).count()
        == 1
    )
    with pytest.raises(IntegrityError, match="binding immutable"), transaction.atomic():
        Payment.objects.filter(pk=payment.id).update(amount_minor=101)
    with pytest.raises(IntegrityError, match="clock immutable"), transaction.atomic():
        Payment.objects.filter(pk=payment.id).update(purge_after=None)


def test_atomic_contract_close_freezes_all_linked_legal_rows_and_exact_deadline():
    from test_billing_orders import offer, place, world
    from test_core_erasure import operator

    from apps.audit.models import AuditEvent
    from apps.billing.models import Order, StatutoryRecord, Subscription
    from apps.billing.statutory import close_contract
    from apps.legal.models import Acceptance, Dpa

    current_period()
    billing = world()
    placed = place(billing, offer())
    from apps.billing import services

    services.cancel_order(verified=billing.token, order_id=placed.order.id)
    actor = operator()
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        ended = cursor.fetchone()[0]
    close_contract(
        order_id=placed.order.id,
        ended_at=ended,
        reason="controller_instruction",
        evidence_ref="END-100",
        actor_identity_id=actor.id,
    )
    rows = [
        Order.objects.get(pk=placed.order.id),
        Subscription.objects.get(pk=placed.subscription.id),
        Dpa.objects.get(pk=placed.order.dpa_id),
        *Acceptance.objects.filter(order_id=placed.order.id),
    ]
    assert all(
        r.contract_ended_at == ended and r.purge_after == ended.replace(year=ended.year + 10)
        for r in rows
    )
    assert StatutoryRecord.objects.filter(basis="contract").count() == len(rows)
    event = AuditEvent.objects.get(action="dpa.contract_closed")
    assert event.actor_id == actor.id and event.metadata["close_evidence_ref"] == "END-100"
    for row in rows:
        with (
            pytest.raises(IntegrityError, match="closed contract record immutable"),
            transaction.atomic(),
        ):
            type(row).objects.filter(pk=row.id).update(purge_after=None)
    with pytest.raises(IntegrityError, match="duplicate close"), transaction.atomic():
        close_contract(
            order_id=placed.order.id,
            ended_at=ended,
            reason="contract_ended",
            evidence_ref="END-101",
            actor_identity_id=actor.id,
        )


def test_leap_day_fiscal_close_uses_calendar_year_anniversary_not_fixed_days():
    FiscalPeriod.objects.create(
        issuer_siren="000000000",
        starts_at=datetime(2023, 3, 1, tzinfo=UTC),
        closed_at=datetime(2024, 2, 29, 12, tzinfo=UTC),
        timezone="UTC",
        authority_ref="FIN-300",
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT billing_accounting_clock('000000000',%s)", [datetime(2024, 2, 20, tzinfo=UTC)]
        )
        clock = json.loads(cursor.fetchone()[0])
    assert clock["purge_after"].startswith("2034-02-28T12:00:00")


def test_due_only_hard_purge_reports_parent_dependency_without_rewriting_deadline(monkeypatch):
    """A public synthetic historical issue date qualifies the actual due SQL path."""
    from test_billing_evidence_persistence import SyntheticRenderer, SyntheticValidator
    from test_billing_orders import offer, place, world

    from apps.billing import services
    from apps.billing.artifacts import publish
    from apps.billing.models import BillingArtifact, Invoice, InvoiceLine, StatutoryRecord
    from apps.billing.statutory import purge_due

    event = datetime(2013, 2, 1, tzinfo=UTC)
    FiscalPeriod.objects.create(
        issuer_siren="000000000",
        starts_at=datetime(2013, 1, 1, tzinfo=UTC),
        closed_at=datetime(2014, 1, 1, tzinfo=UTC),
        timezone="UTC",
        authority_ref="FIN-400",
    )
    monkeypatch.setattr(services, "_allocate", lambda series: ("OLD-2013-00001", event))
    placed = place(world(), offer())
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    artifact = publish(
        document_id=invoice.id,
        credit_note=False,
        renderer=SyntheticRenderer(),
        validator=SyntheticValidator(),
        validator_ref="synthetic-storage-fixture-not-conformance",
    )
    line = InvoiceLine.objects.get(invoice=invoice)
    deadline = datetime(2024, 1, 1, tzinfo=UTC)
    assert invoice.purge_after == line.purge_after == deadline
    with pytest.raises(IntegrityError, match="append-only"), transaction.atomic():
        BillingArtifact.objects.filter(pk=artifact.id).delete()
    assert not purge_due(source_table="billing_invoice", source_id=invoice.id)
    invoice.refresh_from_db()
    assert BillingArtifact.objects.filter(pk=artifact.id).exists()
    assert invoice.purge_after == deadline and StatutoryRecord.objects.count() == 2
    assert purge_due(source_table="billing_invoiceline", source_id=line.id)
    assert purge_due(source_table="billing_invoice", source_id=invoice.id)
    assert not BillingArtifact.objects.filter(pk=artifact.id).exists()
    assert not Invoice.objects.filter(pk=invoice.id).exists()
    assert not StatutoryRecord.objects.exists()


def test_legacy_fixture_requires_explicit_matching_qualification_and_retains_evidence_reference():
    """Owner-only fixture recreates pre-migration rows; application workers never disable guards."""
    from test_billing_orders import offer, place, world

    from apps.billing.models import Invoice, StatutoryRecord
    from apps.billing.statutory import qualify_legacy

    with transaction.atomic(), connection.cursor() as cursor:
        for table in ["billing_invoice", "billing_invoiceline"]:
            for trigger in ["a_accounting_retention", "z_statutory_capture"]:
                name = (
                    "zz_accounting_retention"
                    if table == "billing_invoice" and trigger == "a_accounting_retention"
                    else trigger
                )
                cursor.execute(f"ALTER TABLE {table} DISABLE TRIGGER {name}")
        placed = place(world(fiscal_authority=False), offer())
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        for table in ["billing_invoice", "billing_invoiceline"]:
            for trigger in ["a_accounting_retention", "z_statutory_capture"]:
                name = (
                    "zz_accounting_retention"
                    if table == "billing_invoice" and trigger == "a_accounting_retention"
                    else trigger
                )
                cursor.execute(f"ALTER TABLE {table} ENABLE TRIGGER {name}")
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    assert invoice.accounting_event_at is None and not StatutoryRecord.objects.exists()
    current_period()
    with pytest.raises(IntegrityError, match="event proof mismatch"), transaction.atomic():
        qualify_legacy(
            source_table="billing_invoice",
            source_id=invoice.id,
            event_at=invoice.issued_at.replace(year=invoice.issued_at.year - 1),
            evidence_ref="FIN-401",
        )
    qualify_legacy(
        source_table="billing_invoice",
        source_id=invoice.id,
        event_at=invoice.issued_at,
        evidence_ref="FIN-401",
    )
    invoice.refresh_from_db()
    assert invoice.accounting_event_at == invoice.issued_at
    assert {r.qualification_evidence_ref for r in StatutoryRecord.objects.all()} == {"FIN-401"}
    with pytest.raises(IntegrityError, match="event proof mismatch"), transaction.atomic():
        qualify_legacy(
            source_table="billing_invoice",
            source_id=invoice.id,
            event_at=invoice.issued_at,
            evidence_ref="FIN-402",
        )


def test_workspace_data_erasure_keeps_exact_financial_rows_and_detached_statutory_payloads():
    from test_billing_orders import offer, place, world
    from test_core_erasure import begin

    from apps.billing.models import BillingProfile, Invoice, InvoiceLine, StatutoryRecord
    from apps.orgs.erasure_services import advance_erasure

    current_period()
    billing = world()
    placed = place(billing, offer())
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    deadline = invoice.purge_after
    snapshots = list(StatutoryRecord.objects.order_by("id").values())
    row = begin(billing.organisation)
    result = advance_erasure(row.id, {})
    assert result["core_purged"] and not result["complete"]
    invoice.refresh_from_db()
    assert (
        invoice.customer_legal_name == "Synthetic Customer SAS" and invoice.purge_after == deadline
    )
    assert InvoiceLine.objects.filter(invoice=invoice).count() == 1
    assert list(StatutoryRecord.objects.order_by("id").values()) == snapshots
    assert not BillingProfile.objects.filter(organisation=billing.organisation).exists()
