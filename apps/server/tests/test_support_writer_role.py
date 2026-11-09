"""The API writer role's support grants are enough, and no more: SUPPORT_TICKETS.md, `dev/api_writer_role.py`.

A role holding exactly `dev/api_writer_role.py`'s grants opens a ticket through the real view, with
its tenant context and its audit row, replays it, and answers the creation limits from the rows it
counts. It is then refused, by privilege, every change to a ticket and its deletion: the mail mark
is the operator's to set, and a ticket's text, requester and organisation are never rewritten.
"""

import uuid

import pytest
from django.db import connection
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused
from test_support_tickets_http import (
    mailbox as mailbox,
    opened,
    opened_events,
    post,
    problem,
    tenant,
)
from test_workspace_onboarding import http_signer as http_signer, w as w

from apps.support import tickets
from apps.support.models import SupportTicket
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer(w):
    role = f"support_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_the_writer_role_opens_replays_and_limits_tickets(w, writer, monkeypatch):
    tenant(w.alpha, "alpha-visio")
    monkeypatch.setattr(tickets, "PER_IDENTITY", 1)
    with acting_as(writer):
        assert current_user() == writer
        ticket = opened(w, w.member, key="support-writer-0001")
        replayed = post(w, w.member, key="support-writer-0001")
        assert replayed.headers.get("Idempotency-Replayed") == "true"
        problem(post(w, w.member), 429, "rate-limited")
        problem(post(w, w.staff), 403, "forbidden")
    assert ticket["tenant_id"] is not None
    assert SupportTicket.objects.count() == 1
    assert len(opened_events()) == 1


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE support_supportticket SET mail_enqueued_at = now()",
        "UPDATE support_supportticket SET body = 'rewritten'",
        "UPDATE support_supportticket SET reply_to_email = 'other@elsewhere.test'",
        "UPDATE support_supportticket SET state = 'closed'",
        "DELETE FROM support_supportticket",
        "TRUNCATE support_supportticket",
    ],
)
def test_the_writer_role_cannot_change_or_delete_a_ticket(w, writer, statement):
    opened(w, w.owner)
    with acting_as(writer):
        assert refused(statement) == INSUFFICIENT_PRIVILEGE
    assert SupportTicket.objects.count() == 1
