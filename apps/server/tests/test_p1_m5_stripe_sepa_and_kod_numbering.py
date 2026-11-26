"""Collection-only Stripe events preserve Core's fiscal and subscription authority."""

import time
from datetime import UTC, datetime

import pytest
from django.db import connection, transaction
from test_billing_orders import offer, place, world
from test_credit_notes import _credit
from test_intake_writer_role import acting_as
from test_passport_webhook_writer_role import writer as writer
from test_stripe_webhook_http import (
    _audit_count,
    _post_webhook,
    stripe_webhook_world as stripe_webhook_world,
)

from apps.billing.configuration import (
    credit_note_series_from_environment,
    series_from_environment,
)
from apps.billing.documents import render_xml, snapshot_of
from apps.billing.integrity import (
    NumberedRecord,
    is_credit_note_number,
    verify_database_series,
    verify_series,
)
from apps.billing.models import CreditNote, Invoice, Payment, PaymentLink, Subscription
from apps.billing.payments import stripe_webhook
from apps.billing.payments.services import effective_owed_minor
from apps.billing.payments.stripe import StripeProvider, _translate

pytestmark = pytest.mark.django_db(transaction=True)


def _checkout(placed, link, *, kind="checkout.session.completed", status="paid", **changes):
    return {
        "id": f"evt_m5_{time.time_ns()}",
        "type": kind,
        "created": int(time.time()),
        "data": {
            "object": {
                "id": link.provider_ref,
                "payment_intent": "pi_m5_invoice",
                "payment_status": status,
                "amount_total": placed.invoice.total_incl_vat_minor,
                "currency": "eur",
                "metadata": {"core_invoice_id": str(placed.invoice.id)},
                **changes,
            }
        },
    }


def _refund(amount):
    return {
        "id": f"evt_m5_refund_{time.time_ns()}",
        "type": "charge.refunded",
        "created": int(time.time()),
        "data": {
            "object": {
                "id": "ch_m5_invoice",
                "payment_intent": "pi_m5_invoice",
                "amount_refunded": amount,
                "currency": "eur",
            }
        },
    }


@pytest.mark.parametrize("status", ["unpaid", "processing", "no_payment_required", None])
def test_async_success_requires_paid_before_any_settlement(stripe_webhook_world, status):
    client, w, placed, link = stripe_webhook_world
    response = _post_webhook(
        client,
        _checkout(
            placed,
            link,
            kind="checkout.session.async_payment_succeeded",
            status=status,
        ),
    )
    assert response.json()["status"] == "mismatch"
    assert Payment.objects.count() == 0
    link.refresh_from_db()
    placed.invoice.refresh_from_db()
    placed.subscription.refresh_from_db()
    assert (link.state, placed.invoice.state, placed.subscription.state) == (
        "active",
        "issued",
        "pending",
    )
    assert _audit_count(w.organisation.id, "payment.reconciliation_mismatch") == 1


def test_sepa_submission_waits_for_paid_async_success(stripe_webhook_world):
    client, _, placed, link = stripe_webhook_world
    assert (
        _post_webhook(client, _checkout(placed, link, status="unpaid")).json()["status"]
        == "ignored"
    )
    assert not Payment.objects.exists()
    link.refresh_from_db()
    placed.invoice.refresh_from_db()
    placed.subscription.refresh_from_db()
    assert (link.state, placed.invoice.state, placed.subscription.state) == (
        "active",
        "issued",
        "pending",
    )
    assert (
        _post_webhook(
            client,
            _checkout(
                placed,
                link,
                kind="checkout.session.async_payment_succeeded",
            ),
        ).json()["status"]
        == "applied"
    )
    placed.subscription.refresh_from_db()
    assert placed.subscription.state == "active"


@pytest.mark.parametrize(
    "changes",
    [
        {"metadata": {"core_invoice_id": "00000000-0000-0000-0000-000000000001"}},
        {"metadata": {"core_organisation_id": "00000000-0000-0000-0000-000000000001"}},
        {"metadata": {"core_subscription_id": "00000000-0000-0000-0000-000000000001"}},
        {"amount_total": 1},
        {"currency": "usd"},
    ],
)
def test_async_failure_binding_mismatch_never_reverses_subscription(stripe_webhook_world, changes):
    client, _, placed, link = stripe_webhook_world
    Subscription.objects.filter(pk=placed.subscription.id).update(state="active")
    response = _post_webhook(
        client,
        _checkout(
            placed,
            link,
            kind="checkout.session.async_payment_failed",
            status="unpaid",
            **changes,
        ),
    )
    assert response.json()["status"] == "mismatch"
    placed.subscription.refresh_from_db()
    assert placed.subscription.state == "active"
    assert not Payment.objects.exists()


@pytest.mark.parametrize("outcome", ["mismatch", "stale", "ignored", "duplicate"])
def test_async_failure_rejected_reconciliation_never_syncs(
    stripe_webhook_world, monkeypatch, outcome
):
    client, _, placed, link = stripe_webhook_world
    monkeypatch.setattr(stripe_webhook, "reconcile", lambda **kwargs: outcome)

    def forbidden(**kwargs):
        raise AssertionError("rejected reconciliation reached subscription sync")

    monkeypatch.setattr(stripe_webhook, "_sync_reversed_subscription", forbidden)
    assert _post_webhook(
        client,
        _checkout(
            placed,
            link,
            kind="checkout.session.async_payment_failed",
            status="unpaid",
        ),
    ).json()["status"] == ("applied" if outcome == "duplicate" else outcome)


@pytest.mark.parametrize(
    "kind", ["invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded"]
)
def test_provider_invoice_events_leave_every_business_row_unchanged(stripe_webhook_world, kind):
    client, w, placed, link = stripe_webhook_world
    from django.apps import apps

    models = [
        m
        for m in apps.get_models()
        if m._meta.app_label in {"billing", "workspaces", "audit"}
        and m._meta.model_name != "stripewebhookdelivery"
    ]
    before = {m: list(m.objects.order_by("pk").values()) for m in models}
    response = _post_webhook(client, _checkout(placed, link, kind=kind))
    assert response.json()["status"] == "ignored_event_type"
    assert before == {m: list(m.objects.order_by("pk").values()) for m in models}
    assert _audit_count(w.organisation.id, "payment.reconciliation_mismatch") == 0


@pytest.mark.parametrize(
    "params",
    [
        [("mode", "subscription")],
        [("mode", "setup")],
        [],
        [("mode", "payment"), ("mode", "subscription")],
        *[
            [("mode", "payment"), (key, "false")]
            for key in (
                "invoice_creation[enabled]",
                "automatic_tax[enabled]",
                "subscription_data[metadata][x]",
            )
        ],
    ],
)
def test_outbound_checkout_guard_refuses_competing_authority(params):
    def forbidden(*args):
        raise AssertionError("invalid parameters reached Stripe transport")

    provider = StripeProvider(
        secret_key="rk_test_" + "SyntheticM5Key",
        webhook_secret="wh" + "sec_SyntheticM5",
        transport=forbidden,
    )
    with pytest.raises(ValueError, match="Core invoice"):
        provider._call("POST", "/checkout/sessions", params)


def test_adapter_does_not_translate_unpaid_async_success_to_settlement():
    event = _translate(
        "checkout.session.async_payment_succeeded",
        "evt_m5",
        datetime.now(UTC),
        {
            "id": "cs_m5",
            "payment_intent": "pi_m5",
            "payment_status": "unpaid",
            "amount_total": 120,
            "currency": "eur",
        },
    )
    assert event is None


@pytest.mark.parametrize(
    "invoice_series, expected", [("KOD", "KOD-AV"), ("TST", "AV-TST"), ("AA-BB", "AV-AA-BB")]
)
def test_series_defaults_and_legacy_prefix(invoice_series, expected):
    assert series_from_environment({}) == "INV"
    assert (
        series_from_environment({"KODERA_INVOICE_PREFIX": invoice_series + "-"}) == invoice_series
    )
    assert credit_note_series_from_environment({}, invoice_series=invoice_series) == expected
    assert (
        credit_note_series_from_environment(
            {"KODERA_CREDIT_NOTE_SERIES": expected}, invoice_series=invoice_series
        )
        == expected
    )


@pytest.mark.parametrize("series", ["AV", "AV-KOD", "AVOID", "KOD-AV"])
def test_invoice_series_cannot_overlap_credit_notes(series):
    with pytest.raises(ValueError):
        series_from_environment({"KODERA_INVOICE_SERIES": series})


@pytest.mark.parametrize("series", ["KOD", "AV-TST", "TST-AV", "KOD-AV-", "av-kod"])
def test_credit_note_configuration_requires_matching_base(series):
    with pytest.raises(ValueError):
        credit_note_series_from_environment(
            {"KODERA_CREDIT_NOTE_SERIES": series}, invoice_series="KOD"
        )


def test_both_credit_note_number_formats_verify():
    moment = datetime(2026, 6, 1, tzinfo=UTC)
    for series in ("KOD-AV", "AV-TST"):
        number = f"{series}-2026-00001"
        assert is_credit_note_number(number)
        verify_series([NumberedRecord(number, moment)], {(series, 2026): 1})
    assert not is_credit_note_number("KOD-2026-00001")


def test_kod_invoice_and_cancellation_credit_note_render_as_separate_series(settings):
    settings.KODERA_INVOICE_SERIES = "KOD"
    settings.KODERA_CREDIT_NOTE_SERIES = "KOD-AV"
    placed = place(world(), offer())
    note = _credit(placed.invoice.id)
    assert placed.invoice.number.startswith("KOD-")
    assert note.number.startswith("KOD-AV-")
    assert b"381" in render_xml(snapshot_of(note))
    verify_database_series()


def test_sequential_refunds_issue_idempotent_tax_coherent_credit_notes_under_writer_role(
    stripe_webhook_world,
    writer,
    settings,
):
    settings.KODERA_CREDIT_NOTE_SERIES = "KOD-AV"
    client, _, placed, link = stripe_webhook_world
    with acting_as(writer):
        assert _post_webhook(client, _checkout(placed, link)).json()["status"] == "applied"
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    gross = invoice.total_incl_vat_minor
    # Odd cents exercise cumulative inclusive-tax rounding as well as the final remainder.
    amounts = (1, gross // 3, gross // 2, gross)
    previous = 0
    for cumulative in amounts:
        event = _refund(cumulative)
        with acting_as(writer):
            assert _post_webhook(client, event).json()["status"] == "applied"
            assert _post_webhook(client, event).json()["status"] == "duplicate"
            assert _post_webhook(client, _refund(cumulative)).json()["status"] == "ignored"
        note = CreditNote.objects.get(external_ref=f"stripe:refund:pi_m5_invoice:{cumulative}")
        assert note.total_incl_vat_minor == cumulative - previous
        assert note.total_excl_vat_minor + note.vat_amount_minor == cumulative - previous
        assert (
            sum(line.total_excl_vat_minor + line.vat_amount_minor for line in note.lines.all())
            == cumulative - previous
        )
        assert b"381" in render_xml(snapshot_of(note))
        invoice.refresh_from_db()
        assert invoice.state == "issued" and invoice.amount_paid_minor == gross - cumulative
        assert effective_owed_minor(invoice) == cumulative
        with acting_as(writer), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.billing_issue_invoice_refund_credit_note(%s, %s, %s)",
                [Payment.objects.get().id, "KOD-AV", cumulative],
            )
            assert cursor.fetchone()[0] == note.id
        previous = cumulative
    notes = CreditNote.objects.filter(invoice=invoice)
    assert notes.count() == len(amounts)
    assert sum(n.total_excl_vat_minor for n in notes) == invoice.total_excl_vat_minor
    assert sum(n.vat_amount_minor for n in notes) == invoice.vat_amount_minor
    assert PaymentLink.objects.get(pk=link.id).state == "used"
    from apps.billing.services import issue_credit_note

    with transaction.atomic():
        locked = Invoice.objects.select_for_update().get(pk=invoice.id)
        assert issue_credit_note(locked, reason="unpaid_lapse").id in notes.values_list(
            "id", flat=True
        )
    assert Invoice.objects.get(pk=invoice.id).state == "credited"
    assert notes.count() == len(amounts)
    verify_database_series()


def test_refund_rounding_restores_multiple_frozen_tax_lines(stripe_webhook_world):
    import dataclasses

    from apps.billing.models import InvoiceLine
    from apps.billing.payments import services as payments
    from apps.billing.services import issue_invoice
    from core.db.ids import new_uuid7

    client, w, placed, _ = stripe_webhook_world
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    invoice.pk = new_uuid7()
    invoice.number = invoice.issued_at = invoice.due_at = invoice.paid_at = None
    invoice.state = "draft"
    for field in (
        "accounting_event_at",
        "financial_year_closed_at",
        "purge_after",
        "retention_authority_ref",
        "document_number_snapshot",
    ):
        setattr(invoice, field, None)
    invoice.total_excl_vat_minor, invoice.vat_amount_minor, invoice.total_incl_vat_minor = (
        200,
        25,
        225,
    )
    with transaction.atomic():
        invoice.save(force_insert=True)
        source = placed.invoice.lines.get()
        for position, net, vat, rate in ((1, 101, 20, 2000), (2, 99, 5, 500)):
            InvoiceLine.objects.create(
                invoice=invoice,
                position=position,
                description=f"Synthetic refund line {position}",
                plan_code=source.plan_code,
                plan_version=source.plan_version,
                pack_code=source.pack_code,
                capacity_tier_code=source.capacity_tier_code,
                quantity=1,
                unit_amount_minor=net,
                total_excl_vat_minor=net,
                vat_rate_bp=rate,
                vat_amount_minor=vat,
                period_start=source.period_start,
                period_end=source.period_end,
            )
        issue_invoice(invoice)
    link = payments.create_payment_link(
        invoice_id=invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/billing",
    ).link
    placed = dataclasses.replace(placed, invoice=invoice)
    assert _post_webhook(client, _checkout(placed, link)).json()["status"] == "applied"
    previous = 0
    for cumulative in (1, 2, 7, 111, 225):
        assert _post_webhook(client, _refund(cumulative)).json()["status"] == "applied"
        note = CreditNote.objects.get(external_ref=f"stripe:refund:pi_m5_invoice:{cumulative}")
        assert note.total_incl_vat_minor == cumulative - previous
        assert note.total_excl_vat_minor + note.vat_amount_minor == cumulative - previous
        previous = cumulative
    for line in invoice.lines.all():
        notes = CreditNote.objects.filter(invoice=invoice)
        credited = [item for note in notes for item in note.lines.filter(invoice_line=line)]
        assert sum(item.total_excl_vat_minor for item in credited) == line.total_excl_vat_minor
        assert sum(item.vat_amount_minor for item in credited) == line.vat_amount_minor
    verify_database_series()


def test_refund_failure_rolls_back_credit_note_and_number(stripe_webhook_world):
    client, _, placed, link = stripe_webhook_world
    assert _post_webhook(client, _checkout(placed, link)).json()["status"] == "applied"
    event = _refund(placed.invoice.total_incl_vat_minor)

    class RollbackProbeError(Exception):
        pass

    with pytest.raises(RollbackProbeError), transaction.atomic():
        assert _post_webhook(client, event).json()["status"] == "applied"
        assert CreditNote.objects.count() == 1
        raise RollbackProbeError
    assert CreditNote.objects.count() == 0
    assert _post_webhook(client, event).json()["status"] == "applied"
    assert CreditNote.objects.get().number.endswith("-00001")
    verify_database_series()


def test_new_migrations_bound_forward_reverse_ddl_and_reapply(django_db_blocker):
    import sqlparse
    from django.db.migrations.executor import MigrationExecutor
    from test_customer_persistence_migrations import empty_database, schema_objects

    before = [
        ("billing", "0028_sovereign_settlement_grants"),
        ("orgs", "0036_self_serve_shared_realm"),
    ]
    after = [
        ("billing", "0029_kod_series_and_refund_credit_notes"),
        ("orgs", "0037_organisation_oidc_audience"),
    ]
    observed = []

    def bounded(execute, statement, params, many, context):
        parts = sqlparse.split(str(statement))
        assert not many and (len(parts) <= 1 or params is None)
        result = None
        for part in parts:
            if part.lstrip().upper().startswith(("CREATE ", "ALTER ", "DROP ")):
                execute(
                    "SELECT current_setting('lock_timeout'), current_setting('statement_timeout')",
                    None,
                    False,
                    context,
                )
                assert context["cursor"].fetchone() == ("5s", "30s")
                observed.append(part.split()[0])
            result = execute(part, params, many, context)
        return result

    with django_db_blocker.unblock(), empty_database() as target:
        MigrationExecutor(target).migrate(before)
        with target.cursor() as cursor:
            cursor.execute("SET lock_timeout='0'; SET statement_timeout='0'")
        with target.execute_wrapper(bounded):
            MigrationExecutor(target).migrate(after)
            first = schema_objects(target)
            MigrationExecutor(target).migrate(before)
            MigrationExecutor(target).migrate(after)
            assert schema_objects(target) == first
    assert {"CREATE", "ALTER", "DROP"} <= set(observed)


@pytest.mark.parametrize("first_fraction", [(1, 4), (1, 2), (3, 5), (1, 1)])
def test_refunded_repayment_always_reverses_access_at_the_fiscal_ceiling(
    stripe_webhook_world, writer, first_fraction
):
    from apps.billing.models import ProviderEvent
    from apps.billing.payments import services as payments

    client, w, placed, first_link = stripe_webhook_world
    gross = placed.invoice.total_incl_vat_minor
    first_refund = gross * first_fraction[0] // first_fraction[1]
    with acting_as(writer):
        assert _post_webhook(client, _checkout(placed, first_link)).json()["status"] == "applied"
        assert _post_webhook(client, _refund(first_refund)).json()["status"] == "applied"
    second_link = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=w.organisation.id,
        return_url="https://app.localhost/billing",
    ).link
    with acting_as(writer):
        response = _post_webhook(
            client,
            _checkout(
                placed, second_link, payment_intent="pi_m5_second", amount_total=first_refund
            ),
        )
        assert response.json()["status"] == "applied"
    assert Subscription.objects.get(pk=placed.subscription.id).state == "active"
    refund = _refund(first_refund)
    refund["data"]["object"].update(payment_intent="pi_m5_second", id="ch_m5_second")
    with acting_as(writer):
        response = _post_webhook(client, refund)
        assert response.status_code == 200 and response.json()["status"] == "applied"
        assert _post_webhook(client, refund).json()["status"] == "duplicate"
        assert (
            _post_webhook(client, {**refund, "id": refund["id"] + "_again"}).json()["status"]
            == "ignored"
        )
    payment = Payment.objects.get(provider_ref="pi_m5_second")
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    assert (payment.state, payment.allocated) == ("reversed", False)
    assert invoice.state == "issued" and invoice.amount_paid_minor == gross - first_refund
    assert Subscription.objects.get(pk=placed.subscription.id).state == "past_due"
    assert ProviderEvent.objects.filter(
        event_id=refund["id"], kind="payment.reversed", outcome="applied", amount_minor=first_refund
    ).exists()
    notes = CreditNote.objects.filter(invoice=invoice)
    ceiling_reached = first_refund > gross - first_refund
    assert notes.count() == (1 if ceiling_reached else 2)
    assert sum(n.total_incl_vat_minor for n in notes) <= gross
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM audit_auditevent WHERE organisation_id = %s "
            "AND metadata->>'reason' = 'credit_note_ceiling_reached'",
            [w.organisation.id],
        )
        assert cursor.fetchone()[0] == int(ceiling_reached)
    verify_database_series()


def test_partial_payment_refund_then_unpaid_lapse_credits_only_the_remainder(
    stripe_webhook_world, settings
):
    from datetime import timedelta

    import time_machine

    from apps.billing.services import cancel_unpaid_orders

    client, w, placed, original = stripe_webhook_world
    original.state = "expired"
    original.save(update_fields=["state", "updated_at"])
    paid = placed.invoice.total_incl_vat_minor * 3 // 5
    link = PaymentLink.objects.create(
        organisation=w.organisation,
        invoice=placed.invoice,
        provider="stripe",
        provider_ref="cs_m5_partial",
        url="https://checkout.stripe.invalid/partial",
        state="active",
        amount_minor=paid,
        currency=original.currency,
        expires_at=original.expires_at,
    )
    assert (
        _post_webhook(client, _checkout(placed, link, amount_total=paid)).json()["status"]
        == "applied"
    )
    assert _post_webhook(client, _refund(paid)).json()["status"] == "applied"
    refund_note = CreditNote.objects.get(invoice=placed.invoice)
    # A direct writer cannot evade the cumulative ceiling with a full cancellation note.
    import copy

    from django.db import IntegrityError

    from apps.billing.actors import Actor
    from apps.billing.models import CreditNoteLine
    from apps.billing.services import _allocate, set_invoice_state
    from core.db.ids import new_uuid7

    with pytest.raises(IntegrityError, match="Cumulative credit notes"), transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(pk=placed.invoice.id)
        malicious = copy.copy(refund_note)
        malicious.pk = new_uuid7()
        malicious.number, malicious.issued_at = _allocate(settings.KODERA_CREDIT_NOTE_SERIES)
        malicious.reason, malicious.external_ref = "unpaid_lapse", None
        for field in (
            "accounting_event_at",
            "financial_year_closed_at",
            "purge_after",
            "retention_authority_ref",
            "document_number_snapshot",
        ):
            setattr(malicious, field, None)
        for field in ("total_excl_vat_minor", "vat_amount_minor", "total_incl_vat_minor"):
            setattr(malicious, field, getattr(invoice, field))
        malicious.save(force_insert=True)
        for line in invoice.lines.all():
            CreditNoteLine.objects.create(
                credit_note=malicious,
                invoice_line=line,
                position=line.position,
                description=line.description,
                quantity=line.quantity,
                unit_amount_minor=line.unit_amount_minor,
                total_excl_vat_minor=line.total_excl_vat_minor,
                vat_rate_bp=line.vat_rate_bp,
                vat_amount_minor=line.vat_amount_minor,
                period_start=line.period_start,
                period_end=line.period_end,
            )
        set_invoice_state(invoice, "credited", actor=Actor("system", None))
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    settings.KODERA_UNPAID_LAPSE_ENABLED = True
    with time_machine.travel(placed.invoice.due_at + timedelta(days=1), tick=False):
        assert cancel_unpaid_orders() == (1, 0)
        assert cancel_unpaid_orders() == (0, 0)
    invoice = Invoice.objects.get(pk=placed.invoice.id)
    assert invoice.state == "credited" and invoice.amount_paid_minor == 0
    cancellation = CreditNote.objects.get(invoice=invoice, reason="unpaid_lapse")
    for field in ("total_excl_vat_minor", "vat_amount_minor", "total_incl_vat_minor"):
        assert getattr(cancellation, field) + getattr(refund_note, field) == getattr(invoice, field)
    assert CreditNote.objects.filter(invoice=invoice).count() == 2
    verify_database_series()


def test_full_refund_then_unpaid_lapse_closes_without_another_credit_note(stripe_webhook_world):
    from apps.billing.services import issue_credit_note

    client, _, placed, link = stripe_webhook_world
    assert _post_webhook(client, _checkout(placed, link)).json()["status"] == "applied"
    assert (
        _post_webhook(client, _refund(placed.invoice.total_incl_vat_minor)).json()["status"]
        == "applied"
    )
    existing = CreditNote.objects.get(invoice=placed.invoice)
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(pk=placed.invoice.id)
        assert issue_credit_note(invoice, reason="unpaid_lapse").id == existing.id
    invoice.refresh_from_db()
    assert invoice.state == "credited"
    assert CreditNote.objects.filter(invoice=invoice).count() == 1
    verify_database_series()


def test_explicit_series_trailing_hyphen_and_hybrid_credit_numbers_are_rejected():
    from apps.billing.integrity import IntegrityRefusedError

    with pytest.raises(ValueError):
        series_from_environment({"KODERA_INVOICE_SERIES": "INV-"})
    moment = datetime(2026, 6, 1, tzinfo=UTC)
    for series in ("AV-KOD-AV", "AV-AV", "AV-AVOID", "AVOID-AV"):
        number = f"{series}-2026-00001"
        assert not is_credit_note_number(number)
        with pytest.raises(IntegrityRefusedError):
            verify_series([NumberedRecord(number, moment)], {(series, 2026): 1})
