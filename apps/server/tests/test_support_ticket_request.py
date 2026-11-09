"""A support ticket's request and its mail parameters agree on their bounds (SUPPORT_TICKETS.md
§§2, 6), with no database.

Every ticket the API accepts can be mailed: an address the request names is held to a mail
parameter's bound, and every value the mail run passes stays within it, so the outbox never refuses
a ticket's message for its length. A body nested deeper than the parser goes is malformed, not a
crash, and a pointer to a member the caller named is escaped as RFC 6901 says.
"""

import json
import uuid

import pytest

from apps.outbox.mail import catalogue
from apps.support import ticket_mail, tickets
from apps.support.models import SupportTicket

BODY = {
    "subject": "Les participants tombent de l'appel",
    "body": "Depuis ce matin, plusieurs personnes sont déconnectées.",
    "category": "calls",
}


def address(length):
    """A valid conservative address of exactly `length` characters."""
    local = "a" * 64
    labels, room = [], length - len(local) - 1 - len(".test")
    while room > 0:
        size = min(63, room) if room - min(63, room) != 1 else 62
        labels.append("b" * size)
        room -= size + 1
    host = ".".join(labels) + ".test"
    value = f"{local}@{host}"
    assert len(value) == length and tickets.is_address(value), (len(value), value)
    return value


def parse(body):
    return tickets.parse_request(json.dumps(body).encode(), "application/json")


def errors(body):
    with pytest.raises(tickets.TicketInputError) as refused:
        parse(body)
    return refused.value.errors


def test_the_contact_email_bound_is_the_mail_parameter_bound():
    assert tickets.MAX_CONTACT_EMAIL == catalogue.MAX_PARAM_LENGTH


def test_a_contact_email_a_mail_parameter_can_carry_is_accepted():
    assert parse({**BODY, "contact_email": address(200)}).contact_email == address(200)


@pytest.mark.parametrize("length", [201, 254])
def test_a_longer_contact_email_is_refused_even_when_it_is_an_address(length):
    assert errors({**BODY, "contact_email": address(length)}) == [("/contact_email", "invalid")]


def test_a_body_nested_deeper_than_the_parser_goes_is_malformed_not_a_crash():
    raw = b"[" * 100_000
    assert len(raw) <= tickets.MAX_REQUEST_BYTES
    with pytest.raises(tickets.TicketInputError) as refused:
        tickets.parse_request(raw, "application/json")
    assert refused.value.errors == []


def test_a_pointer_to_an_unexpected_member_is_escaped():
    assert errors({**BODY, "a/b~c": 1}) == [("/a~1b~0c", "unexpected")]


def ticket(**fields):
    values = {
        "id": uuid.uuid4(),
        "subject": BODY["subject"],
        "body": BODY["body"],
        "category": "calls",
        "severity": "degraded",
        "locale": "fr",
        "reply_to_email": "requester@customer.test",
    }
    return SupportTicket(**(values | fields))


def test_every_value_the_mail_run_passes_is_one_the_outbox_accepts():
    template = catalogue.get("support_ticket")
    long_name = "Organisation " + "x" * 300
    for reply_to in (address(200), address(254), None):
        params = ticket_mail.params(
            ticket(reply_to_email=reply_to, contact_email=None, tenant_slug="t" * 250),
            (long_name, "alpha"),
        )
        catalogue.check_params(template, params)
        assert len(params["organisation_name"]) == catalogue.MAX_PARAM_LENGTH


def test_an_address_too_long_for_a_parameter_is_shown_missing_never_cut():
    params = ticket_mail.params(ticket(reply_to_email=address(254)), ("Alpha", "alpha"))
    assert params["requester_email"] == ticket_mail.NONE
    whole = ticket_mail.params(ticket(reply_to_email=address(200)), ("Alpha", "alpha"))
    assert whole["requester_email"] == address(200)


SAMPLES = [
    "plain text",
    "line\nand\ttab",
    "la famille \U0001f468\U0000200d\U0001f469\U0000200d\U0001f467",
    "t\xe9l\xe9\xadphone",
    "\U000005e9\U000005dc\U000005d5\U000005dd\U0000200f",
    "a bell \x07",
    "a null \x00",
    "an escape \x1b[31m",
    "a C1 control \x85",
    "a line\U00002028separator",
    "a paragraph\U00002029separator",
    "a lone \U0000d800 surrogate",
]


def test_the_api_and_the_catalogue_read_a_message_by_the_same_rule():
    assert tickets.REFUSED_IN_MESSAGE == catalogue.TEXT_REFUSED_CATEGORIES
    for sample in SAMPLES:
        assert (tickets._message(sample) is not None) == catalogue.check_text(sample), repr(sample)


def test_a_subject_the_api_accepts_is_a_value_the_catalogue_accepts():
    for sample in SAMPLES:
        if tickets._one_line(sample):
            assert catalogue.check_value(sample), repr(sample)


@pytest.mark.parametrize(
    "name",
    [
        "Acme\U0000200b",
        "Acme\U0000200e",
        "Acme\tSAS",
        "\U0000feffAcme",
        "Acme\U00002028SAS",
        "Acme\x07" + "x" * 300,
    ],
)
def test_an_organisation_name_core_holds_never_makes_a_ticket_unmailable(name):
    params = ticket_mail.params(ticket(), (name, "alpha"))
    catalogue.check_params(catalogue.get("support_ticket"), params)
    assert params["organisation_name"].startswith("Acme")


def test_a_value_made_only_of_refused_characters_is_shown_missing():
    params = ticket_mail.params(ticket(tenant_slug="\x07\U0000200b"), ("\t", "alpha"))
    assert params["organisation_name"] == ticket_mail.NONE
    assert params["tenant_slug"] == ticket_mail.NONE
