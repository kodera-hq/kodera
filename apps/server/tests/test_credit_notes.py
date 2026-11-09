"""Credit notes, the only correction of an issued invoice: docs/domain/BILLING_MODEL.md §§4, 4.1.

Against real PostgreSQL: a credit note is numbered from its own gapless series, copies the
invoice's lines, VAT treatment and parties, credits the invoice in full and is audited; the
database refuses a second one for the invoice, any change or deletion, a note without its lines,
and a line added afterwards.
"""

import pytest
from django.db import IntegrityError, connection, transaction
from test_billing_orders import offer, paris_year, place, refused, world

from apps.billing import services
from apps.billing.models import CreditNote, CreditNoteLine, Invoice, InvoiceLine
from apps.billing.states import TransitionRefusedError

pytestmark = pytest.mark.django_db(transaction=True)


def _database_now():
    # The guard compares with the database's clock: a note's date comes from it.
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def _credit(invoice_id):
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(id=invoice_id)
        return services.issue_credit_note(
            invoice, reason="customer_cancellation", request_id="r-0001"
        )


def test_a_credit_note_credits_its_invoice_in_full_from_a_series_of_its_own():
    w, other = world(), world()
    first = place(w, offer())
    note = _credit(first.invoice.id)
    invoice = Invoice.objects.get(id=first.invoice.id)
    year = paris_year(note.issued_at)
    assert note.number == f"AV-TST-{year}-00001" and invoice.state == "credited"
    assert note.issued_at >= invoice.issued_at
    for field in (
        "customer_address_line1",
        "customer_postal_code",
        "customer_city",
        "issuer_address",
        "issuer_vat_number",
        "currency",
        "vat_regime",
        "vat_mention",
        "issuer_legal_name",
        "issuer_siren",
        "customer_legal_name",
        "customer_country",
        "total_excl_vat_minor",
        "vat_amount_minor",
        "total_incl_vat_minor",
    ):
        assert getattr(note, field) == getattr(invoice, field), field
    lines = list(note.lines.order_by("position"))
    originals = list(InvoiceLine.objects.filter(invoice=invoice).order_by("position"))
    assert [line.invoice_line_id for line in lines] == [line.id for line in originals]
    assert [(line.period_start, line.period_end) for line in lines] == [
        (line.period_start, line.period_end) for line in originals
    ]
    assert [
        (line.description, line.total_excl_vat_minor, line.vat_amount_minor) for line in lines
    ] == [
        (line.description, line.total_excl_vat_minor, line.vat_amount_minor) for line in originals
    ]
    # Its own series: the invoices' goes on unbroken, the credit notes' too.
    second = place(other, offer())
    assert second.invoice.number == f"TST-{paris_year(second.invoice.issued_at)}-00002"
    assert _credit(second.invoice.id).number == f"AV-TST-{year}-00002"
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, metadata->>'number', metadata->>'invoice_number' FROM audit_auditevent"
            " WHERE action = 'credit_note.issued' AND organisation_id = %s",
            [w.organisation.id],
        )
        assert cursor.fetchall() == [("system", note.number, invoice.number)]


def test_an_invoice_takes_one_credit_note_and_never_a_paid_or_settled_one():
    w = world()
    placed = place(w, offer())
    _credit(placed.invoice.id)
    # Credited: no transition to `credited` again.
    with pytest.raises(TransitionRefusedError):
        _credit(placed.invoice.id)
    paid = place(world(), offer())
    Invoice.objects.filter(id=paid.invoice.id).update(amount_paid_minor=100)
    with pytest.raises(services.BillingValidationError):
        _credit(paid.invoice.id)
    assert not CreditNote.objects.filter(invoice_id=paid.invoice.id).exists()


def test_the_database_holds_a_credit_note_whole_and_unchanged():
    w = world()
    placed = place(w, offer())
    note = _credit(placed.invoice.id)
    line = note.lines.get()
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNote.objects.filter(id=note.id).update(reason="unpaid_lapse")
    with refused("billing_creditnote_immutable"), transaction.atomic(), connection.cursor() as c:
        c.execute("DELETE FROM billing_creditnote WHERE id = %s", [note.id])
    with refused("billing_creditnote_immutable"), transaction.atomic(), connection.cursor() as c:
        c.execute("DELETE FROM billing_creditnoteline WHERE id = %s", [line.id])
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNoteLine.objects.filter(id=line.id).update(description="changed")
    # A second note for the invoice, written past the service.
    copy = CreditNote.objects.get(id=note.id)
    copy.pk, copy.number = None, copy.number[:-5] + "99999"
    with refused("billing_creditnote_one_per_invoice"), transaction.atomic():
        copy.issued_at = _database_now()
        copy.save(force_insert=True)
    # A line added to the note afterwards: refused, it is written with its note or never.
    extra = CreditNoteLine.objects.get(id=line.id)
    extra.pk, extra.position = None, 2
    with refused("billing_creditnote_immutable"), transaction.atomic():
        extra.save(force_insert=True)


def test_a_credit_note_without_its_lines_is_refused_at_commit():
    w = world()
    placed = place(w, offer())
    invoice = Invoice.objects.get(id=placed.invoice.id)
    with pytest.raises(IntegrityError) as bare:
        with transaction.atomic():
            CreditNote.objects.create(
                organisation_id=invoice.organisation_id,
                invoice=invoice,
                number="AV-TST-2026-00042",
                issued_at=_database_now(),
                reason="customer_cancellation",
                currency=invoice.currency,
                vat_regime=invoice.vat_regime,
                issuer_legal_name="x",
                issuer_address="x",
                issuer_siren="x",
                issuer_vat_number="x",
                customer_legal_name="x",
                customer_address_line1="x",
                customer_postal_code="x",
                customer_city="x",
                customer_country="FR",
                total_excl_vat_minor=invoice.total_excl_vat_minor,
                vat_amount_minor=invoice.vat_amount_minor,
                total_incl_vat_minor=invoice.total_incl_vat_minor,
            )
    assert bare.value.__cause__.diag.constraint_name == "billing_creditnote_complete"


def _bare_note(invoice, **changes):
    values = {
        "organisation_id": invoice.organisation_id,
        "invoice": invoice,
        "number": "AV-TST-2026-00042",
        "issued_at": _database_now(),
        "reason": "customer_cancellation",
        "currency": invoice.currency,
        "vat_regime": invoice.vat_regime,
        "issuer_legal_name": "x",
        "issuer_address": "x",
        "issuer_siren": "x",
        "issuer_vat_number": "x",
        "customer_legal_name": "x",
        "customer_address_line1": "x",
        "customer_postal_code": "x",
        "customer_city": "x",
        "customer_country": "FR",
        "total_excl_vat_minor": invoice.total_excl_vat_minor,
        "vat_amount_minor": invoice.vat_amount_minor,
        "total_incl_vat_minor": invoice.total_incl_vat_minor,
    }
    values.update(changes)
    return CreditNote.objects.create(**values)


def _copy_lines(note, invoice):
    for line in InvoiceLine.objects.filter(invoice=invoice):
        CreditNoteLine.objects.create(
            credit_note=note,
            invoice_line=line,
            position=line.position,
            description=line.description,
            quantity=line.quantity,
            unit_amount_minor=line.unit_amount_minor,
            total_excl_vat_minor=line.total_excl_vat_minor,
            vat_rate_bp=line.vat_rate_bp,
            vat_amount_minor=line.vat_amount_minor,
        )


def _refused_at_commit(write, constraint):
    with pytest.raises(IntegrityError) as caught:
        with transaction.atomic():
            write()
    assert caught.value.__cause__.diag.constraint_name == constraint


def _lines_of(note, invoice, *, net=None, vat=None, line=None):
    """One credited line per invoice line, or one line of the given amounts."""
    originals = list(InvoiceLine.objects.filter(invoice=invoice))
    if net is None:
        _copy_lines(note, invoice)
        return
    CreditNoteLine.objects.create(
        credit_note=note,
        invoice_line=line or originals[0],
        position=1,
        description="x",
        quantity=1,
        unit_amount_minor=net,
        total_excl_vat_minor=net,
        vat_rate_bp=2000,
        vat_amount_minor=vat,
    )


@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "other_organisation",
        "other_net",
        "other_vat",
        "no_line",
        "lines_off_by_net",
        "lines_off_by_vat",
        "invoice_left_issued",
    ],
)
def test_a_credit_note_must_match_and_credit_its_invoice(case):
    """Each case is a valid full credit, its invoice credited, with exactly one thing changed."""
    w, other = world(), world()
    invoice = Invoice.objects.get(id=place(w, offer()).invoice.id)
    net, vat = invoice.total_excl_vat_minor, invoice.vat_amount_minor

    def write():
        changes = {}
        if case == "other_organisation":
            changes["organisation_id"] = other.organisation.id
        if case == "other_net":
            changes.update(total_excl_vat_minor=net - 100, total_incl_vat_minor=net - 100 + vat)
        if case == "other_vat":
            changes.update(vat_amount_minor=vat - 100, total_incl_vat_minor=net + vat - 100)
        note = _bare_note(invoice, **changes)
        if case == "other_net":
            _lines_of(note, invoice, net=net - 100, vat=vat)
        elif case == "other_vat":
            _lines_of(note, invoice, net=net, vat=vat - 100)
        elif case == "lines_off_by_net":
            _lines_of(note, invoice, net=net - 1, vat=vat)
        elif case == "lines_off_by_vat":
            _lines_of(note, invoice, net=net, vat=vat - 1)
        elif case != "no_line":
            _lines_of(note, invoice)
        if case != "invoice_left_issued":
            Invoice.objects.filter(id=invoice.id).update(state="credited")

    if case == "valid":
        with transaction.atomic():
            write()
        assert Invoice.objects.get(id=invoice.id).state == "credited"
        return
    _refused_at_commit(write, "billing_creditnote_complete")
    assert Invoice.objects.get(id=invoice.id).state == "issued"


def test_a_credit_note_of_a_free_invoice_still_needs_its_lines():
    """At zero the sums agree with no line at all: the line count alone refuses it."""
    w = world()
    invoice = Invoice.objects.get(id=place(w, offer(amount=0)).invoice.id)
    assert invoice.total_incl_vat_minor == 0

    def write():
        _bare_note(invoice)
        Invoice.objects.filter(id=invoice.id).update(state="credited")

    _refused_at_commit(write, "billing_creditnote_complete")


def test_a_credited_invoice_holds_no_money():
    w = world()
    invoice = Invoice.objects.get(id=place(w, offer()).invoice.id)
    with pytest.raises(IntegrityError) as caught:
        with transaction.atomic():
            note = _bare_note(invoice)
            _copy_lines(note, invoice)
            Invoice.objects.filter(id=invoice.id).update(state="credited", amount_paid_minor=500)
    assert caught.value.__cause__.diag.constraint_name == "billing_invoice_credited_unpaid"


def test_a_line_credits_a_line_of_the_notes_invoice_and_is_never_added_later():
    w = world()
    invoice = Invoice.objects.get(id=place(w, offer()).invoice.id)
    foreign = InvoiceLine.objects.get(invoice_id=place(world(), offer()).invoice.id)

    def foreign_line():
        # Valid in every other way, the invoice credited: only the line's origin is wrong.
        note = _bare_note(invoice)
        _lines_of(
            note,
            invoice,
            net=invoice.total_excl_vat_minor,
            vat=invoice.vat_amount_minor,
            line=foreign,
        )
        Invoice.objects.filter(id=invoice.id).update(state="credited")

    _refused_at_commit(foreign_line, "billing_creditnote_complete")
    note = _credit(invoice.id)
    line = note.lines.get()
    # Even a zero line, which leaves the totals right, is refused in a later transaction.
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNoteLine.objects.create(
            credit_note=note,
            invoice_line=line.invoice_line,
            position=2,
            description="added later",
            quantity=1,
            unit_amount_minor=0,
            total_excl_vat_minor=0,
            vat_rate_bp=0,
            vat_amount_minor=0,
        )
    # A note dated before the transaction that writes it is refused too.
    with refused("billing_creditnote_immutable"), transaction.atomic():
        _bare_note(invoice, number="AV-TST-2026-00043", issued_at=note.issued_at)


def test_a_credit_notes_document_and_platform_references_are_set_once():
    w = world()
    note = _credit(place(w, offer()).invoice.id)
    CreditNote.objects.filter(id=note.id).update(pdf_ref="s3://notes/1.pdf", external_ref="pdp-1")
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNote.objects.filter(id=note.id).update(pdf_ref="s3://notes/2.pdf")
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNote.objects.filter(id=note.id).update(external_ref="pdp-2")
    with refused("billing_creditnote_immutable"), transaction.atomic():
        CreditNote.objects.filter(id=note.id).update(number="AV-TST-2026-00099")


def test_a_number_outside_the_credit_note_series_is_refused():
    w = world()
    invoice = Invoice.objects.get(id=place(w, offer()).invoice.id)
    with refused("billing_creditnote_number_valid"), transaction.atomic():
        _bare_note(invoice, number="TST-2026-00001")


def test_no_invoice_series_takes_the_credit_note_prefix():
    from apps.billing.configuration import series_from_environment

    with pytest.raises(ValueError, match="AV"):
        series_from_environment({"KODERA_INVOICE_SERIES": "AVK"})
    assert series_from_environment({"KODERA_INVOICE_SERIES": "KOD"}) == "KOD"


def test_the_credit_note_migration_reverses_while_empty_and_refuses_with_a_note(django_db_blocker):
    """Migrating back to 0007 drops nothing while a credit note exists: they are legal records."""
    from django.db.migrations.executor import MigrationExecutor
    from test_customer_persistence_migrations import empty_database

    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate(executor.loader.graph.leaf_nodes())
        before = [("billing", "0007_order_confirmation")]
        after = [("billing", "0009_validate_invoice_credited_unpaid")]
        MigrationExecutor(target).migrate(before)
        with target.cursor() as cursor:
            cursor.execute("SELECT to_regclass('billing_creditnote')")
            assert cursor.fetchone() == (None,)
            cursor.execute("SELECT prosrc FROM pg_proc WHERE proname = 'billing_invoice_guard'")
            restored = cursor.fetchone()[0]
        assert "'issued>void'" in restored and "credited" not in restored
        MigrationExecutor(target).migrate(after)
        with target.cursor() as cursor:
            cursor.execute("SET session_replication_role = replica")
            cursor.execute(
                "INSERT INTO billing_creditnote (id, created_at, updated_at, organisation_id,"
                " invoice_id, number, issued_at, reason, currency, vat_regime, issuer_legal_name,"
                " issuer_address, issuer_siren, issuer_vat_number, customer_legal_name,"
                " customer_address_line1, customer_postal_code, customer_city, customer_country,"
                " total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor)"
                " VALUES (gen_random_uuid(), now(), now(), gen_random_uuid(), gen_random_uuid(),"
                " 'AV-TST-2026-00001', now(), 'customer_cancellation', 'EUR', 'fr_standard',"
                " 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'FR', 0, 0, 0)"
            )
            cursor.execute("SET session_replication_role = origin")
        with pytest.raises(RuntimeError, match="legal records"):
            MigrationExecutor(target).migrate(before)
