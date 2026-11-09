"""The support ticket mail (SUPPORT_TICKETS.md §6): the operator profile's `send_support_tickets`.

Tickets are opened over HTTP (tests/test_support_tickets_http.py's world). The run enqueues one
`support_ticket` message per ticket not yet mailed, to the support mailbox, with the requester's
address as Core stores it as Reply-To and the customer's message verbatim in the body, and marks
the ticket mailed. Nothing is enqueued where it could not be sent: without the mailbox, the seal
key or a transport, the run refuses; with the copy unapproved on a remote transport, it holds
every ticket and says how many. A built message is one plain-text part whose subject carries none
of the customer's text.
"""

import dataclasses
import json
import os
from datetime import timedelta
from email import message_from_bytes, policy

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.management import CommandError, call_command
from django.db import IntegrityError, connection, transaction
from django.db.models import F
from django.db.models.functions import Now
from smtp_stub import Script, smtp_stub
from test_access_tokens import frozen_clock as frozen_clock
from test_outbox_mail_sender import ACCEPT_REJECT, local
from test_support_tickets_http import BODY, MAILBOX, mailbox as mailbox, opened, rows, tenant
from test_workspace_onboarding import w as w

from apps.outbox import sender
from apps.outbox.mail import catalogue, seal
from apps.outbox.mail.transport import MailTransport
from apps.outbox.models import OutboxMessage
from apps.support import ticket_mail
from apps.support.models import SupportTicket

pytestmark = pytest.mark.django_db(transaction=True)

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


def run():
    return ticket_mail.run_support_ticket_mails()


def test_each_ticket_is_mailed_once_to_the_mailbox_with_the_requester_as_reply_to(w, sealing):
    tenant(w.alpha, "alpha-visio")
    ticket = opened(w, w.member, {**BODY, "contact_email": "other@elsewhere.test"})
    report = run()
    assert [str(i) for i in report.enqueued] == [ticket["id"]] and not report.skipped
    message = OutboxMessage.objects.get()
    assert (message.template_id, message.locale, message.link) == ("support_ticket", "fr", None)
    opened_seal = seal.unseal(sealing, message.delivery_id, bytes(message.sealed))
    assert (opened_seal.recipient, opened_seal.reply_to) == (MAILBOX, w.member.user.email)
    assert message.params["customer_body"] == (
        "Depuis ce matin,\nplusieurs personnes sont déconnectées.\n\tSalle Direction."
    )
    assert message.params["customer_subject"] == BODY["subject"]
    assert message.params["contact_email"] == "other@elsewhere.test"
    assert message.params["organisation_slug"] == "alpha"
    assert message.params["tenant_slug"] == "alpha-visio"
    # Stored codes, not labels: product copy lives in the catalogue only.
    assert (message.params["category"], message.params["severity"]) == (
        BODY["category"],
        BODY["severity"],
    )
    assert message.params["customer_locale"] == "fr"
    assert SupportTicket.objects.get(id=ticket["id"]).mail_enqueued_at is not None
    # Never twice.
    assert run().enqueued == []
    assert OutboxMessage.objects.count() == 1


def test_missing_values_are_shown_as_a_dash(w, sealing):
    opened(w, w.owner)
    run()
    params = OutboxMessage.objects.get().params
    assert (params["tenant_slug"], params["contact_email"]) == ("—", "—")


def test_the_built_mail_is_plain_text_and_its_subject_carries_no_customer_text(w, sealing):
    body = {
        **BODY,
        "subject": "Bcc: attacker@evil.test sujet visible",
        "body": "Bonjour,\nReply-To: attacker@evil.test\n\nMerci.",
    }
    opened(w, w.member, body)
    run()
    with smtp_stub() as stub:
        report = sender.run_deliveries(local(stub), limit=50, key=sealing)
        (raw,) = list(stub.record.messages)
    assert report.sent == 1
    message = message_from_bytes(raw, policy=policy.SMTP)
    assert not message.is_multipart() and message.get_content_type() == "text/plain"
    assert message.get_all("Reply-To") == [w.member.user.email]
    assert message.get_all("To") == [MAILBOX]
    assert message.get_all("Bcc") is None
    assert "attacker" not in message["Subject"] and "sujet visible" not in message["Subject"]
    content = message.get_content().replace("\r\n", "\n")
    assert "Bcc: attacker@evil.test sujet visible" in content
    assert "Bonjour,\nReply-To: attacker@evil.test\n\nMerci." in content


@pytest.mark.parametrize("missing", ["mailbox", "malformed_mailbox", "seal_key", "transport"])
def test_nothing_is_enqueued_where_it_could_not_be_sent(w, sealing, settings, missing):
    opened(w, w.owner)
    if missing == "mailbox":
        settings.KODERA_SUPPORT_MAILBOX = None
    elif missing == "malformed_mailbox":
        settings.KODERA_SUPPORT_MAILBOX = "support@kodera.io, other@kodera.test"
    elif missing == "seal_key":
        settings.KODERA_OUTBOX_SEAL_KEY = None
    else:
        settings.KODERA_MAIL_TRANSPORT = None
    with pytest.raises(CommandError, match="refused"):
        call_command("send_support_tickets", "--once")
    assert not OutboxMessage.objects.exists()
    assert rows()[0][13] is None


def test_unapproved_copy_on_a_remote_transport_holds_every_ticket_and_says_so(
    w, sealing, settings, capsys, caplog, monkeypatch
):
    # The copy is approved; withdraw that approval to prove the hold still guards a later edit.
    monkeypatch.setattr(catalogue, "unapproved", lambda: frozenset({"support_ticket"}))
    settings.KODERA_MAIL_TRANSPORT = dataclasses.replace(LOCAL, starttls=True)
    opened(w, w.owner)
    opened(w, w.member)
    call_command("send_support_tickets", "--once")
    assert capsys.readouterr().out.strip() == (
        "enqueued=0 skipped=0 held_for_approval=2 delivered=0 retried=0 erased_undelivered=0"
    )
    assert "held for approval: 2 tickets" in caplog.text
    # The count is every held ticket, not one batch.
    assert ticket_mail.enqueue_support_ticket_mails(limit=1).held_for_approval == 2
    assert not OutboxMessage.objects.exists()
    assert all(row[13] is None for row in rows())


def test_the_command_prints_counts_only(w, sealing, capsys):
    opened(w, w.owner)
    call_command("send_support_tickets", "--once")
    out = capsys.readouterr().out
    assert out.strip() == (
        "enqueued=1 skipped=0 held_for_approval=0 delivered=0 retried=0 erased_undelivered=0"
    )
    assert MAILBOX not in out and w.owner.user.email not in out


def test_the_command_runs_only_once_at_a_time(w, sealing):
    with pytest.raises(CommandError, match="--once"):
        call_command("send_support_tickets")


def test_the_support_ticket_copy_is_approved_and_leaves_on_a_remote_transport():
    assert catalogue.templates()["support_ticket"].approved
    assert "support_ticket" not in catalogue.unapproved()
    remote = dataclasses.replace(LOCAL, starttls=True)
    assert "support_ticket" not in sender.held_templates(remote)


def test_a_ticket_the_outbox_refuses_is_marked_once_and_holds_back_no_newer_ticket(
    w, sealing, monkeypatch
):
    poisoned = opened(w, w.owner)
    later = opened(w, w.member)
    real = ticket_mail.params

    def refused_for_the_first(ticket, organisation):
        values = real(ticket, organisation)
        if str(ticket.id) == poisoned["id"]:
            values["organisation_name"] = "a bell \x07"  # refused by the outbox
        return values

    monkeypatch.setattr(ticket_mail, "params", refused_for_the_first)
    report = run()
    assert [str(i) for i in report.skipped] == [poisoned["id"]]
    assert [str(i) for i in report.enqueued] == [later["id"]]
    marked = SupportTicket.objects.get(id=poisoned["id"])
    assert marked.mail_refused_at is not None and marked.mail_enqueued_at is None
    # The next run neither retries it nor reports it again.
    again = run()
    assert again.skipped == [] and again.enqueued == []
    assert OutboxMessage.objects.count() == 1


# ------------------------------------------------- how long Core keeps a ticket's text (§6) ----

MARKER = "Salle Direction"


def deliver(key, script=None):
    with smtp_stub(script) as stub:
        return sender.run_deliveries(local(stub), limit=50, key=key)


def stored(ticket_id):
    return SupportTicket.objects.get(id=ticket_id)


def message_params(delivery_id):
    return OutboxMessage.objects.get(delivery_id=delivery_id).params


def backdate(ticket_id, days=0, *, by=None):
    SupportTicket.objects.filter(id=ticket_id).update(
        created_at=F("created_at") - (timedelta(days=days) if by is None else by)
    )


def message_expiry(delivery_id):
    return OutboxMessage.objects.get(delivery_id=delivery_id).expires_at


def erased(row):
    return (row.subject, row.body, row.reply_to_email, row.contact_email) == ("", "", None, None)


def test_a_delivered_ticket_keeps_only_its_metadata_and_its_message_loses_the_text(w, sealing):
    ticket = opened(w, w.member, {**BODY, "contact_email": "autre@client.test"})
    run()
    delivery_id = stored(ticket["id"]).mail_delivery_id
    assert delivery_id is not None and MARKER in message_params(delivery_id)["customer_body"]
    assert deliver(sealing).sent == 1
    report = run()
    assert report.delivered == 1 and report.enqueued == [] and report.erased_undelivered == 0
    row = stored(ticket["id"])
    assert erased(row) and row.content_erased_at is not None
    assert row.mail_delivered_at is not None and row.mail_delivery_id is None
    assert (row.category, row.severity, row.state) == ("calls", "degraded", "open")
    params = message_params(delivery_id)
    assert all(params[name] == sender.REDACTED for name in ticket_mail.CONTENT_PARAMS)
    assert params["ticket_ref"] == ticket["id"] and params["category"] == "calls"
    text = json.dumps(params, ensure_ascii=False)
    assert MARKER not in text and "autre@client.test" not in text
    assert w.member.user.email not in text
    # Settled once: the next run neither counts it again nor mails it again.
    again = run()
    assert again.delivered == 0 and again.enqueued == []


def test_a_failed_delivery_is_retried_with_the_text_kept_and_the_failed_copy_redacted(w, sealing):
    ticket = opened(w, w.member)
    run()
    first = stored(ticket["id"]).mail_delivery_id
    deliver(sealing, Script(rcpt=ACCEPT_REJECT))
    report = run()
    assert report.retried == 1 and [str(i) for i in report.enqueued] == [ticket["id"]]
    row = stored(ticket["id"])
    assert MARKER in row.body and row.content_erased_at is None
    assert row.mail_delivery_id not in (None, first)
    assert message_params(first)["customer_body"] == sender.REDACTED
    assert MARKER in message_params(row.mail_delivery_id)["customer_body"]
    # The retry is delivered: then the text goes, from the ticket and from the second message.
    assert deliver(sealing).sent == 1
    assert run().delivered == 1
    assert erased(stored(ticket["id"]))
    assert message_params(row.mail_delivery_id)["customer_body"] == sender.REDACTED


def test_a_failed_delivery_too_late_for_a_retry_erases_the_text(w, sealing):
    ticket = opened(w, w.member)
    run()
    deliver(sealing, Script(rcpt=ACCEPT_REJECT))
    # Less than an hour of its fourteen days left: too little for a new message.
    backdate(ticket["id"], by=ticket_mail.RETENTION - timedelta(minutes=30))
    report = run()
    assert report.retried == 0 and report.erased_undelivered == 1 and report.enqueued == []
    row = stored(ticket["id"])
    assert erased(row) and row.mail_delivered_at is None and row.mail_delivery_id is None
    assert OutboxMessage.objects.count() == 1


def test_text_past_retention_is_erased_while_its_message_still_waits(w, sealing, caplog):
    ticket = opened(w, w.member)
    run()
    delivery_id = stored(ticket["id"]).mail_delivery_id
    backdate(ticket["id"], ticket_mail.RETENTION.days + 1)
    report = run()
    assert report.erased_undelivered == 1
    assert "erased before their mail was delivered: 1" in caplog.text
    assert erased(stored(ticket["id"]))
    # The waiting message keeps its own copy until its delivery ends, then loses it.
    assert MARKER in message_params(delivery_id)["customer_body"]
    assert deliver(sealing).sent == 1
    assert run().delivered == 1
    assert message_params(delivery_id)["customer_body"] == sender.REDACTED


def test_text_past_retention_is_erased_where_the_mail_is_refused(w, sealing, settings):
    held = opened(w, w.member)
    backdate(held["id"], ticket_mail.RETENTION.days + 1)
    fresh = opened(w, w.owner)
    settings.KODERA_SUPPORT_MAILBOX = None
    with pytest.raises(CommandError):
        call_command("send_support_tickets", "--once")
    assert erased(stored(held["id"]))
    assert MARKER in stored(fresh["id"]).body
    assert not OutboxMessage.objects.exists()


def test_a_message_still_to_be_sent_is_never_redacted(w, sealing):
    ticket = opened(w, w.member)
    run()
    delivery_id = stored(ticket["id"]).mail_delivery_id
    assert sender.redact_ended_params(delivery_id, ticket_mail.CONTENT_PARAMS) is False
    assert MARKER in message_params(delivery_id)["customer_body"]


def test_the_database_refuses_an_erased_mark_on_a_ticket_that_keeps_its_text(w, sealing):
    ticket = opened(w, w.member)
    with pytest.raises(IntegrityError), transaction.atomic():
        SupportTicket.objects.filter(id=ticket["id"]).update(content_erased_at=Now())
    with pytest.raises(IntegrityError), transaction.atomic():
        SupportTicket.objects.filter(id=ticket["id"]).update(subject="", body="")


def test_an_expired_message_is_redacted_and_its_ticket_retried_whatever_its_status(w, sealing):
    ticket = opened(w, w.member)
    run()
    first = stored(ticket["id"]).mail_delivery_id
    # Past its expiry a message is never built again, even before the sweep fails it or while it
    # awaits reconciliation: the settling treats it as ended.
    OutboxMessage.objects.filter(delivery_id=first).update(expires_at=Now() - timedelta(minutes=1))
    report = run()
    assert report.retried == 1 and [str(i) for i in report.enqueued] == [ticket["id"]]
    assert message_params(first)["customer_body"] == sender.REDACTED
    assert MARKER in stored(ticket["id"]).body


def database_now():
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def test_no_message_outlives_its_ticket_s_retention(w, sealing):
    late = opened(w, w.member)
    backdate(late["id"], 13)
    run()
    row = stored(late["id"])
    # One day of its fourteen is left, so its message gets one day, not six.
    expires_at = message_expiry(row.mail_delivery_id)
    assert expires_at <= database_now() + timedelta(days=1)
    assert expires_at > database_now() + timedelta(hours=23)
    too_late = opened(w, w.owner)
    backdate(too_late["id"], by=ticket_mail.RETENTION - timedelta(minutes=30))
    report = run()
    assert too_late["id"] not in [str(i) for i in report.enqueued]
    assert stored(too_late["id"]).mail_delivery_id is None
    assert MARKER in stored(too_late["id"]).body


def test_a_ticket_is_mailed_again_once_never_more(w, sealing, caplog):
    ticket = opened(w, w.member)
    run()
    deliver(sealing, Script(rcpt=ACCEPT_REJECT))
    assert run().retried == 1
    retry = stored(ticket["id"]).mail_delivery_id
    deliver(sealing, Script(rcpt=ACCEPT_REJECT))
    report = run()
    assert report.retried == 0 and report.erased_undelivered == 1 and report.enqueued == []
    row = stored(ticket["id"])
    assert erased(row) and row.mail_retried_at is not None and row.mail_delivery_id is None
    assert message_params(retry)["customer_body"] == sender.REDACTED
    assert OutboxMessage.objects.count() == 2
    assert f"support ticket {ticket['id']} erased" in caplog.text
