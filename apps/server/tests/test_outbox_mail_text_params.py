"""The catalogue's `text` parameter and the sender's per-message Reply-To (OUTBOX_MAIL_SENDER.md
§§4, 5.1), with no database.

A `text` parameter carries a customer's message verbatim: up to 20,000 characters, line feeds and
tabs kept, every other control character refused, and only ever in a body, never in a subject. A
message may name its own Reply-To, sealed with its recipient; without one, the transport's applies.
The `support_ticket` template is the first to use both (SUPPORT_TICKETS.md §6).
"""

import hashlib
import json
import uuid
from email import message_from_bytes, policy

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from apps.outbox import sender
from apps.outbox.mail import catalogue, seal
from apps.outbox.mail.transport import MailTransport

KEY = bytes(range(32))
TRANSPORT = MailTransport(
    host="127.0.0.1",
    port=2525,
    starttls=False,
    username=None,
    password=None,
    sender="Kodera <no-reply@kodera.test>",
    reply_to="support@kodera.io",
)


def template(**overrides):
    entry = {
        "approved": False,
        "link": False,
        "params": ["reference", "message"],
        "text": ["message"],
        "fr": {"subject": "Ticket ${reference}", "body": "Message :\n${message}\n"},
    }
    entry.update(overrides)
    return catalogue._parse({"ticket": entry})["ticket"]


# --- the text parameter ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "x",
        "line one\nline two\n\n\tindented",
        "é" * 20_000,
        "a line\nthen ${reference} and $$ kept as typed",
        # Format characters are text: an emoji's joiner, a soft hyphen, a right-to-left mark.
        "la famille \U0001f468\u200d\U0001f469\u200d\U0001f467 est là",
        "copié de Word : télé\u00adphone",
        "\u05e9\u05dc\u05d5\u05dd\u200f done",
    ],
)
def test_a_text_value_is_accepted_verbatim(value):
    rendered = catalogue._render(
        template(), "fr", {"reference": "T-1", "message": value}, link=None
    )
    assert rendered.body == f"Message :\n{value}\n"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "x" * 20_001,
        "a carriage\rreturn",
        "a bell \x07",
        "a null \x00",
        "a line\U00002028separator",
        "a lone surrogate \ud800",
        42,
    ],
)
def test_a_text_value_with_a_control_character_or_out_of_bounds_is_refused(value):
    with pytest.raises(catalogue.TemplateError):
        catalogue.check_params(template(), {"reference": "T-1", "message": value})


def test_a_plain_parameter_still_refuses_a_line_break():
    with pytest.raises(catalogue.TemplateError):
        catalogue.check_params(template(), {"reference": "T\n1", "message": "fine"})


def test_a_text_parameter_is_never_in_a_subject():
    with pytest.raises(catalogue.TemplateError, match="text in its subject"):
        template(fr={"subject": "Ticket ${message}", "body": "${reference} ${message}"})


def test_text_names_only_declared_parameters_once():
    with pytest.raises(catalogue.TemplateError, match="text"):
        template(text=["unknown"])
    with pytest.raises(catalogue.TemplateError, match="text"):
        template(text=["message", "message"])


def test_a_parameter_is_not_both_lines_and_text():
    with pytest.raises(catalogue.TemplateError, match="both"):
        template(lines=["message"])


# --- the per-message Reply-To ---------------------------------------------------------------------


def test_a_sealed_reply_to_opens_with_its_recipient():
    delivery = uuid.uuid4()
    sealed = seal.seal(KEY, delivery, "support@kodera.io", "", reply_to="requester@customer.test")
    opened = seal.unseal(KEY, delivery, sealed)
    assert (opened.recipient, opened.reply_to) == (
        "support@kodera.io",
        "requester@customer.test",
    )


def test_a_seal_without_a_reply_to_is_the_format_it_always_was():
    delivery = uuid.uuid4()
    sealed = seal.seal(KEY, delivery, "someone@customer.test", "fixture_fixture_fixture")
    opened = seal.unseal(KEY, delivery, sealed)
    assert opened.reply_to is None
    # Opened by hand: the stored plaintext has no reply_to member at all.
    nonce, ciphertext = sealed[1 : 1 + seal.NONCE_BYTES], sealed[1 + seal.NONCE_BYTES :]
    plaintext = AESGCM(KEY).decrypt(nonce, ciphertext, seal.associated_data(delivery))
    assert json.loads(plaintext) == {
        "recipient": "someone@customer.test",
        "secret": "fixture_fixture_fixture",
    }


def built(reply_to):
    rendered = catalogue.Rendered(subject="Ticket T-1", body="Line one\nLine two\n")
    raw = sender.build_message(
        TRANSPORT,
        recipient="support@kodera.io",
        rendered=rendered,
        locale="fr",
        message_id="<t-1@kodera.test>",
        reply_to=reply_to,
    )
    return message_from_bytes(raw, policy=policy.SMTP)


def test_a_message_s_own_reply_to_replaces_the_transport_s():
    message = built("requester@customer.test")
    assert message.get_all("Reply-To") == ["requester@customer.test"]


def test_without_its_own_reply_to_a_message_takes_the_transport_s():
    assert built(None).get_all("Reply-To") == ["support@kodera.io"]


def test_a_built_message_is_one_plain_text_part():
    message = built("requester@customer.test")
    assert not message.is_multipart()
    assert message.get_content_type() == "text/plain"
    # SMTP carries CRLF on the wire; the text is the same.
    assert message.get_content().replace("\r\n", "\n") == "Line one\nLine two\n"


@pytest.mark.parametrize(
    "reply_to",
    ["a@b.test\r\nBcc: x@y.test", "a@b.test\nBcc: x@y.test", "two@a.test, three@b.test", "nobody"],
)
def test_a_reply_to_that_is_not_one_address_is_refused_at_enqueue(reply_to):
    assert sender.check_reply_to(reply_to) is False


# --- the support ticket template ------------------------------------------------------------------


def test_the_support_ticket_template_keeps_customer_text_out_of_its_subject():
    support = catalogue.get("support_ticket")
    assert support.approved is True and support.link is False
    assert support.text == ("customer_body",)
    customer = {"customer_subject", "customer_body", "contact_email"}
    for locale in ("fr", "en"):
        subject = support.copies[locale].subject
        assert not catalogue._placeholders(subject) & customer, locale
        assert {"customer_subject", "customer_body"} <= catalogue._placeholders(
            support.copies[locale].body
        )


def test_the_ticket_service_reads_an_address_as_the_sender_does():
    from apps.support import tickets

    # The Reply-To a ticket stores is the one the sender later accepts at enqueue.
    assert tickets.ADDRESS.pattern == sender.RECIPIENT.pattern
    assert tickets.ADDRESS.flags == sender.RECIPIENT.flags


# The copy the lead approved (catalogue.toml's header). An edit to it changes these pins in the
# same pull request, so approved wording never changes unreviewed while `approved = true` stays.
APPROVED_SUPPORT_COPY = {
    "fr": (
        "[Support Kodera] ${severity} · ${category} · ${organisation_slug} · ticket ${ticket_ref}",
        "8fefc4f83a539ca90d66133f422fd3ff8068e2a4bfd3bb041495935b2c14c0b7",
    ),
    "en": (
        "[Kodera support] ${severity} · ${category} · ${organisation_slug} · ticket ${ticket_ref}",
        "bca0dc3fdae58ec9bdc6069e72609b8adc71bf3ae54c7e44e30d3f49a36a6595",
    ),
}


@pytest.mark.parametrize("locale", sorted(APPROVED_SUPPORT_COPY))
def test_the_support_ticket_copy_is_the_approved_wording(locale):
    copy = catalogue.get("support_ticket").copies[locale]
    subject, body_sha256 = APPROVED_SUPPORT_COPY[locale]
    assert copy.subject == subject
    assert hashlib.sha256(copy.body.encode()).hexdigest() == body_sha256
