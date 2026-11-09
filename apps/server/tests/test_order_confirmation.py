"""The order confirmation (CGV 5.3): enqueued once per order, naming each accepted text's URL.

The order comes from `placeOrder` over HTTP (tests/test_place_order_http.py's world); the
confirmation is the operator profile's `send_order_confirmations`, which enqueues an outbox message
the outbox sends like any other, and enqueues it again if that delivery failed.
"""

import dataclasses
import os
import threading
import time
from email import message_from_bytes, policy

import psycopg
import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.management import CommandError, call_command
from django.db import connection, transaction
from smtp_stub import smtp_stub
from test_access_tokens import frozen_clock as frozen_clock
from test_outbox_mail_sender import local
from test_place_order_http import body, generate, order_body, place, ready as ready
from test_workspace_onboarding import w as w

from apps.audit.models import AuditEvent
from apps.billing import confirmations
from apps.billing.confirmations import ConfirmationsUnavailableError, enqueue_order_confirmations
from apps.billing.models import Order
from apps.outbox import sender
from apps.outbox.mail import catalogue, seal
from apps.outbox.mail.transport import MailTransport
from apps.outbox.models import OutboxMessage

pytestmark = pytest.mark.django_db(transaction=True)

TEXTS = "https://api.localhost/api/v1/legal-documents"
LOCAL = MailTransport(
    host="mailpit",
    port=1025,
    starttls=False,
    username=None,
    password=None,
    sender="Kodera <no-reply@notify.localhost>",
    reply_to="support@kodera.io",
)


@pytest.fixture
def sealing(settings):
    settings.KODERA_OUTBOX_SEAL_KEY = os.urandom(32)
    settings.KODERA_MAIL_TRANSPORT = LOCAL
    return settings.KODERA_OUTBOX_SEAL_KEY


@pytest.fixture
def ordered(ready, sealing):
    dpa = body(generate(ready))
    body(place(ready, order_body(dpa["id"])))
    return Order.objects.get(organisation_id=ready.alpha.id)


def _fail(delivery_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_outboxdelivery SET status = 'failed', finished_at = clock_timestamp()"
            " WHERE id = %s",
            [delivery_id],
        )


def test_a_placed_order_is_confirmed_once_with_each_accepted_text(ordered, sealing):
    report = enqueue_order_confirmations()
    assert report.enqueued == [ordered.id] and not report.skipped
    order = Order.objects.get(id=ordered.id)
    message = OutboxMessage.objects.get(delivery_id=order.confirmation_delivery_id)
    assert (message.template_id, message.locale, message.link) == ("order_confirmation", "fr", None)
    documents = message.params["documents"]
    # The CGV accepted with the order, then its DPA, each with its version and permanent URL.
    assert documents == [
        f"Conditions générales de vente (placeholder), version 0.0 — {TEXTS}/cgv/0.0/fr",
        f"Accord de traitement des données (placeholder), version 0.0 — {TEXTS}/dpa/0.0/fr",
    ]
    assert message.params["order_reference"] == str(order.id)
    # The recipient is the signatory, sealed; no secret.
    opened = seal.unseal(sealing, message.delivery_id, bytes(message.sealed))
    assert (opened.recipient, opened.secret) == (order.dpa.accepted_by_email, "")
    rendered = catalogue.render("order_confirmation", "fr", message.params, link=None)
    assert all(line in rendered.body for line in documents)
    audit = AuditEvent.objects.get(action="order.confirmation_enqueued")
    assert (audit.actor_type, audit.target_urn) == ("system", f"urn:kodera:order:{order.id}")
    assert audit.metadata["documents"] == [["cgv", "0.0", "fr"], ["dpa", "0.0", "fr"]]
    # Once: the order keeps its delivery while it is on its way.
    assert enqueue_order_confirmations().enqueued == []
    assert OutboxMessage.objects.filter(template_id="order_confirmation").count() == 1


def test_a_confirmation_that_failed_is_enqueued_again(ordered):
    enqueue_order_confirmations()
    first = Order.objects.get(id=ordered.id).confirmation_delivery_id
    # Expired, rejected or out of attempts: the contract is not formed, so it goes again.
    _fail(first)
    assert enqueue_order_confirmations().enqueued == [ordered.id]
    second = Order.objects.get(id=ordered.id).confirmation_delivery_id
    assert second not in (None, first)
    audits = AuditEvent.objects.filter(action="order.confirmation_enqueued").order_by("id")
    assert audits.last().metadata["replaces_failed_delivery_id"] == str(first)


@pytest.mark.parametrize("missing", ["origin", "transport", "approval"])
def test_nothing_is_enqueued_where_it_could_not_be_sent(ordered, settings, missing):
    if missing == "origin":
        settings.KODERA_LEGAL_TEXT_ORIGIN = None
    elif missing == "transport":
        settings.KODERA_MAIL_TRANSPORT = None
    else:
        # A remote transport holds the draft copy until it would expire.
        settings.KODERA_MAIL_TRANSPORT = dataclasses.replace(LOCAL, starttls=True)
    with pytest.raises(ConfirmationsUnavailableError):
        enqueue_order_confirmations()
    with pytest.raises(CommandError, match="refused"):
        call_command("send_order_confirmations")
    assert Order.objects.get(id=ordered.id).confirmation_delivery_id is None
    assert not OutboxMessage.objects.exists()


def test_an_order_that_cannot_name_a_text_is_reported(ordered, monkeypatch):
    monkeypatch.setattr(confirmations, "text_url", lambda document: None)
    report = enqueue_order_confirmations()
    assert report.skipped == [ordered.id] and not report.enqueued
    with pytest.raises(CommandError, match="could not be enqueued"):
        call_command("send_order_confirmations")
    assert Order.objects.get(id=ordered.id).confirmation_delivery_id is None


def test_a_cancelled_order_is_not_confirmed(ordered):
    Order.objects.filter(id=ordered.id).update(state="cancelled")
    assert enqueue_order_confirmations().enqueued == []


def test_an_order_cancelled_after_it_was_listed_is_not_confirmed(ordered, monkeypatch):
    real = confirmations._locked

    def cancelled_meanwhile(order_id):
        # The owner cancels between the listing and the lock.
        Order.objects.filter(id=order_id).update(state="cancelled")
        return real(order_id)

    monkeypatch.setattr(confirmations, "_locked", cancelled_meanwhile)
    assert enqueue_order_confirmations().enqueued == []
    assert Order.objects.get(id=ordered.id).confirmation_delivery_id is None


def test_without_a_seal_key_nothing_is_enqueued(ordered, settings):
    settings.KODERA_OUTBOX_SEAL_KEY = None
    with pytest.raises(CommandError, match="refused"):
        call_command("send_order_confirmations")
    assert Order.objects.get(id=ordered.id).confirmation_delivery_id is None


def test_the_confirmation_copy_is_a_draft_held_on_a_remote_transport():
    template = catalogue.get("order_confirmation")
    assert not template.approved and not template.link and template.lines == ("documents",)
    assert "order_confirmation" in catalogue.unapproved()
    assert set(template.copies) == {"fr", "en"}


def test_a_template_without_a_link_takes_none_and_lines_are_bounded():
    params = {"organisation_name": "Acme", "order_reference": "r", "documents": ["a"]}
    with pytest.raises(catalogue.TemplateError, match="if and only if"):
        catalogue.render("order_confirmation", "fr", params, link="https://app.localhost/x")
    for documents in ([], ["a"] * 11, ["a\nb"], ["x" * 201], "a"):
        with pytest.raises(catalogue.TemplateError, match="malformed parameter"):
            catalogue.render(
                "order_confirmation", "fr", {**params, "documents": documents}, link=None
            )


# --- a cancelled order's confirmation -----------------------------------------------------------


def _deliver(key):
    with smtp_stub() as stub:
        report = sender.run_deliveries(local(stub), limit=50, key=key)
        return report, list(stub.record.messages)


def _status(delivery_id):
    with connection.cursor() as cursor:
        cursor.execute("SELECT status FROM outbox_outboxdelivery WHERE id = %s", [delivery_id])
        return cursor.fetchone()[0]


def test_a_confirmation_not_yet_sent_is_withdrawn_when_its_order_is_cancelled(ordered, sealing):
    enqueue_order_confirmations()
    delivery = Order.objects.get(id=ordered.id).confirmation_delivery_id
    # The owner cancels before the outbox sends it: no contract is formed, nothing leaves.
    Order.objects.filter(id=ordered.id).update(state="cancelled")
    report, messages = _deliver(sealing)
    assert messages == [] and (report.sent, report.failed) == (0, 1)
    assert _status(delivery) == "failed"
    withdrawn = AuditEvent.objects.get(action="outbox_delivery.failed")
    assert withdrawn.metadata["reason"] == "withdrawn"
    # Never formed, so nothing to terminate and no notice.
    assert enqueue_order_confirmations().notified == []
    assert Order.objects.get(id=ordered.id).cancellation_notice_delivery_id is None


def test_a_cancelled_order_whose_confirmation_was_sent_is_terminated_with_a_notice(
    ordered, sealing
):
    enqueue_order_confirmations()
    confirmation = Order.objects.get(id=ordered.id).confirmation_delivery_id
    report, messages = _deliver(sealing)
    assert report.sent == 1 and _status(confirmation) == "succeeded"
    # A confirmed order still live is never terminated.
    assert enqueue_order_confirmations().notified == []
    # Cancelled after the confirmation formed the contract: a termination, with its notice.
    Order.objects.filter(id=ordered.id).update(state="cancelled")
    assert enqueue_order_confirmations().notified == [ordered.id]
    order = Order.objects.get(id=ordered.id)
    notice = OutboxMessage.objects.get(delivery_id=order.cancellation_notice_delivery_id)
    assert (notice.template_id, notice.params["order_reference"]) == (
        "order_cancellation",
        str(order.id),
    )
    terminated = AuditEvent.objects.get(action="order.terminated")
    assert terminated.metadata == {
        "confirmation_delivery_id": str(confirmation),
        "notice_delivery_id": str(order.cancellation_notice_delivery_id),
        "replaces_failed_notice_id": None,
    }
    # Once.
    assert enqueue_order_confirmations().notified == []
    report, messages = _deliver(sealing)
    assert report.sent == 1 and len(messages) == 1
    subject = message_from_bytes(messages[0], policy=policy.default)["Subject"]
    assert subject.startswith("Annulation de votre commande Kodera")


def test_a_confirmation_of_unknown_fate_waits_for_a_person(ordered, sealing):
    enqueue_order_confirmations()
    confirmation = Order.objects.get(id=ordered.id).confirmation_delivery_id
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_outboxdelivery SET status = 'needs_reconciliation',"
            " started_at = clock_timestamp() WHERE id = %s",
            [confirmation],
        )
    Order.objects.filter(id=ordered.id).update(state="cancelled")
    assert enqueue_order_confirmations().notified == []


def test_a_notice_that_failed_is_enqueued_again(ordered, sealing):
    enqueue_order_confirmations()
    _deliver(sealing)
    Order.objects.filter(id=ordered.id).update(state="cancelled")
    enqueue_order_confirmations()
    first = Order.objects.get(id=ordered.id).cancellation_notice_delivery_id
    _fail(first)
    assert enqueue_order_confirmations().notified == [ordered.id]
    second = Order.objects.get(id=ordered.id).cancellation_notice_delivery_id
    assert second not in (None, first)
    last = AuditEvent.objects.filter(action="order.terminated").order_by("id").last()
    assert last.metadata["replaces_failed_notice_id"] == str(first)


def _dsn():
    settings = connection.settings_dict
    return (
        f"host={settings['HOST']} port={settings['PORT']} dbname={settings['NAME']}"
        f" user={settings['USER']} password={settings['PASSWORD']}"
    )


def test_a_cancellation_still_open_at_the_claim_is_waited_for_and_withdraws(ordered, sealing):
    """`_cancel`'s shape on another connection: the order locked and set `cancelled`, committed a
    second later. The claim waits on the order's row, then sees it cancelled and withdraws."""
    enqueue_order_confirmations()
    delivery = Order.objects.get(id=ordered.id).confirmation_delivery_id
    other = psycopg.connect(_dsn())
    try:
        other.execute("SELECT id FROM billing_order WHERE id = %s FOR UPDATE", [ordered.id])
        other.execute("UPDATE billing_order SET state = 'cancelled' WHERE id = %s", [ordered.id])
        timer = threading.Timer(1.0, other.commit)
        timer.start()
        started = time.monotonic()
        claimed = sender.claim_next(LOCAL, sealing, sender.RunReport())
        waited = time.monotonic() - started
        timer.join()
    finally:
        other.close()
    assert claimed is None and waited >= 0.9
    assert _status(delivery) == "failed"


# --- the credit-note notice ---------------------------------------------------------------------


def _credit_ordered(order):
    from apps.billing import services
    from apps.billing.models import Invoice

    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(order_id=order.id)
        return services.issue_credit_note(invoice, reason="customer_cancellation")


def test_each_credit_note_is_delivered_once_with_its_permanent_url(ordered, sealing):
    note = _credit_ordered(ordered)
    report = enqueue_order_confirmations()
    assert report.credit_notes == [note.id]
    note.refresh_from_db()
    message = OutboxMessage.objects.get(delivery_id=note.notice_delivery_id)
    assert message.template_id == "credit_note_issued"
    assert message.params["credit_note_number"] == note.number
    assert message.params["invoice_number"] == note.invoice.number
    assert message.params["credit_note_url"] == (
        f"https://api.localhost/api/v1/credit-notes/{note.id}"
    )
    # To the order's billing contact, which placeOrder recorded.
    opened = seal.unseal(sealing, message.delivery_id, bytes(message.sealed))
    assert opened.recipient == ordered.billing_contact_email == "billing@customer.test"
    audit = AuditEvent.objects.get(action="credit_note.notice_enqueued")
    assert audit.metadata["number"] == note.number
    assert enqueue_order_confirmations().credit_notes == []
    # A notice that failed goes again.
    _fail(note.notice_delivery_id)
    assert enqueue_order_confirmations().credit_notes == [note.id]
    rendered = catalogue.render("credit_note_issued", "fr", message.params, link=None)
    assert message.params["credit_note_url"] in rendered.body


def test_a_billing_contact_the_outbox_refuses_falls_back_to_the_signatory(ordered, sealing):
    # placeOrder's check admits it; the outbox's stricter one does not.
    Order.objects.filter(id=ordered.id).update(billing_contact_email="o'brien@customer.test")
    note = _credit_ordered(ordered)
    report = enqueue_order_confirmations()
    assert report.credit_notes == [note.id] and note.id not in report.skipped
    note.refresh_from_db()
    message = OutboxMessage.objects.get(delivery_id=note.notice_delivery_id)
    opened = seal.unseal(sealing, message.delivery_id, bytes(message.sealed))
    assert opened.recipient == Order.objects.get(id=ordered.id).dpa.accepted_by_email
    assert message.params["total_incl_vat"].endswith(" EUR")
