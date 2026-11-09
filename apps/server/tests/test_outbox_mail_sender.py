"""Acceptance for the outbox mail sender: docs/specs/OUTBOX_MAIL_SENDER.md §9.

Every check is a function that raises an AssertionError with a fixed first line. Each runs once
unmutated, and each mutant of MUTANTS patches one part of the sender — a function or constant of
apps.outbox.sender, apps.outbox.mail or the run_deliveries command — or rewrites one guard of the
attempt table inside a rolled-back transaction, and requires its owning check to fail with exactly
that line. A check without a mutant fails the inventory test, so no check here has passed without
having been seen to fail.

The sender owns its transactions, so the database checks run under `transactional_db`. Mail goes to
an in-process SMTP server (tests/smtp_stub.py); nothing leaves the host.
"""

from __future__ import annotations

import dataclasses
import io
import json
import logging
import re
import ssl
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email import message_from_bytes, policy
from typing import Any

import pytest
from django.apps import apps
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, connection, transaction
from django.test.utils import override_settings
from smtp_stub import Script, Stub, smtp_stub, stub_pki, unused_port

from apps.outbox import sender
from apps.outbox.mail import catalogue, seal, transport as smtp
from apps.outbox.mail.transport import MailTransport, TransportConfigError
from apps.outbox.management.commands import run_deliveries as command

KEY = bytes(range(32))
SECRET = "SeCrEtLiNkToKeN_0123456789-abcdef"
OTHER_SECRET = "AnOtHeRsEcReT_9876543210-zyxwvu"
RECIPIENT = "owner.k10@example.test"
OTHER_RECIPIENT = "member.k10@example.test"
LINK = "https://app.localhost/claim/0190a000-0000-7000-8000-000000000001"
PARAMS = {"organisation_name": "Acme Coop", "expires_at": "2026-10-09T12:00Z"}
LOCAL_FROM = "Kodera <no-reply@notify.localhost>"
REMOTE_FROM = "Kodera <no-reply@notify.kodera.io>"
# What the spec says, written here rather than read from the sender, so a mutant of the sender's
# own constant cannot move the expectation with it.
REPLY_TO = "support@kodera.io"
# The approved subjects (product owner, 2026-10-06), owner_claim then invitation, French then English.
APPROVED_SUBJECTS = [
    "Votre espace ${organisation_name} est prêt sur Kodera",
    "Your ${organisation_name} workspace is ready on Kodera",
    "Invitation à rejoindre ${organisation_name} sur Kodera",
    "Invitation to join ${organisation_name} on Kodera",
]
# The set-up paragraph, approved by the product owner on 2026-11-04, word for word, just before
# the link of both onboarding mails: the realm's set-up mail comes first.
APPROVED_SET_UP_PARAGRAPH = (
    "Vous recevez aussi un e-mail « Configurer votre compte Kodera » : ouvrez-le d'abord pour "
    "choisir votre mot de passe et activer le code à usage unique. Munissez-vous de votre "
    "téléphone, avec une application d'authentification (par exemple FreeOTP ou Google "
    "Authenticator). Revenez ensuite à ce lien :"
)
# What to do once the set-up link has lapsed (72 h), approved on 2026-11-04, just after the link.
APPROVED_SET_UP_VALIDITY = {
    "invitation": (
        "Le lien de l'e-mail « Configurer votre compte Kodera » est valable 3 jours : s'il a "
        "expiré, demandez à votre administrateur de vous renvoyer l'invitation."
    ),
    "owner_claim": (
        "Le lien de l'e-mail « Configurer votre compte Kodera » est valable 3 jours : s'il a "
        "expiré, écrivez-nous à support@kodera.io pour en recevoir un nouveau."
    ),
}
DEFERRAL_BUDGET = 5
FIRST_BACKOFF_S = 30
BODY_MARKER = "Pour en devenir le propriétaire"
ACCEPT_REJECT = "550 5.1.1 <{address}> recipient rejected"
TRY_LATER = "451 4.3.0 <{address}> try again later"

_LOAD = catalogue.load


# --------------------------------------------------------------------------------- helpers ----


@contextmanager
def patched(target: Any, name: str, value: Any) -> Iterator[None]:
    """Set an attribute for the block, restoring whatever it held, a mutant's value included."""
    saved = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, saved)


def organisation() -> uuid.UUID:
    """An organisation in `prospect` with the held name its deferred guard requires."""
    slug = f"mail-{uuid.uuid4().hex[:10]}"
    # One transaction: the held name is checked at commit.
    with transaction.atomic():
        org = apps.get_model("orgs", "Organisation").objects.create(
            slug=slug, realm=slug, issuer=f"https://id.mail.test/realms/{slug}", name="Mail"
        )
        apps.get_model("orgs", "SlugReservation").objects.create(
            namespace="organisation", slug=slug, organisation=org, state="provisional"
        )
    return uuid.UUID(str(org.id))


def enqueue(
    org: uuid.UUID,
    *,
    template: str = "owner_claim",
    locale: str = "fr",
    recipient: str = RECIPIENT,
    secret: str | None = SECRET,
    params: dict[str, Any] | None = None,
    link: str | None = LINK,
    expires_in: timedelta = timedelta(hours=72),
    atomic: bool = True,
    key: bytes | None = KEY,
) -> uuid.UUID:
    def call() -> uuid.UUID:
        return sender.enqueue_message(
            organisation_id=org,
            template_id=template,
            locale=locale,
            recipient=recipient,
            link=link,
            link_secret=secret,
            params=dict(PARAMS if params is None else params),
            expires_at=datetime.now(UTC) + expires_in,
        )

    with override_settings(KODERA_OUTBOX_SEAL_KEY=key):
        if not atomic:
            return call()
        with transaction.atomic():
            return call()


def local(stub: Stub) -> MailTransport:
    return MailTransport(
        host=stub.host,
        port=stub.port,
        starttls=False,
        username=None,
        password=None,
        sender=LOCAL_FROM,
        reply_to=REPLY_TO,
    )


def remote(stub: Stub) -> MailTransport:
    return dataclasses.replace(local(stub), starttls=True, sender=REMOTE_FROM)


def nowhere() -> MailTransport:
    return MailTransport(
        host="127.0.0.1",
        port=unused_port(),
        starttls=False,
        username=None,
        password=None,
        sender=LOCAL_FROM,
        reply_to=REPLY_TO,
    )


def run(transport: MailTransport, limit: int = 50) -> sender.RunReport:
    return sender.run_deliveries(transport, limit=limit, key=KEY)


def _one(statement: str, parameters: list[Any]) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        names = [column.name for column in cursor.description]
        row = cursor.fetchone()
    assert row is not None, "the row read back does not exist"
    return dict(zip(names, row, strict=True))


def _all(statement: str, parameters: list[Any] | None = None) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        names = [column.name for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def delivery(delivery_id: uuid.UUID) -> dict[str, Any]:
    return _one(
        "SELECT status, category, changes_realm, operation_ref, started_at, finished_at "
        "FROM outbox_outboxdelivery WHERE id = %s",
        [delivery_id],
    )


def message(delivery_id: uuid.UUID) -> dict[str, Any]:
    return _one(
        "SELECT sealed, not_before, expires_at FROM outbox_message WHERE delivery_id = %s",
        [delivery_id],
    )


def attempts(delivery_id: uuid.UUID) -> list[dict[str, Any]]:
    return _all(
        "SELECT id, seq, message_id, started_at, finished_at, outcome, smtp_code, "
        "provider_message_id FROM outbox_deliveryattempt WHERE delivery_id = %s ORDER BY seq",
        [delivery_id],
    )


def outcomes(delivery_id: uuid.UUID) -> list[str | None]:
    return [row["outcome"] for row in attempts(delivery_id)]


def audits(delivery_id: uuid.UUID) -> list[tuple[str, dict[str, Any]]]:
    rows = _all(
        "SELECT action, metadata FROM audit_auditevent WHERE target_urn = %s "
        "ORDER BY occurred_at, id",
        [f"urn:kodera:outbox_delivery:{delivery_id}"],
    )
    return [
        (
            row["action"],
            row["metadata"] if isinstance(row["metadata"], dict) else json.loads(row["metadata"]),
        )
        for row in rows
    ]


def table_text(table: str) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT coalesce(string_agg(row_to_json(t)::text, ''), '') FROM {table} t"  # noqa: S608 - fixed table names
        )
        return str(cursor.fetchone()[0])


def database_now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def make_due(delivery_id: uuid.UUID) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_message SET not_before = clock_timestamp() - interval '1 second' "
            "WHERE delivery_id = %s",
            [delivery_id],
        )


@contextmanager
def captured_logs() -> Iterator[list[str]]:
    """Every log record of the process, formatted with its arguments and any traceback."""
    lines: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(record.getMessage())
            if record.exc_info:
                lines.append(logging.Formatter().formatException(record.exc_info))
            if record.exc_text:
                lines.append(record.exc_text)

    root = logging.getLogger()
    handler = Collect(level=logging.DEBUG)
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield lines
    finally:
        root.removeHandler(handler)
        root.setLevel(level)


# Schema probes run inside a transaction that is always rolled back; a database mutant rewrites a
# guard inside that same transaction and nowhere else.
SCHEMA_MUTATIONS: list[str] = []

GUARD_WITHOUT_OUTCOME_ONCE = """
CREATE OR REPLACE FUNCTION outbox_deliveryattempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_deliveryattempt_retained', MESSAGE='retained';
  END IF;
  RETURN NEW;
END $$
"""

GUARD_WITHOUT_RETAINED = """
CREATE OR REPLACE FUNCTION outbox_deliveryattempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_deliveryattempt_outcome_once', MESSAGE='once';
  END IF;
  RETURN NEW;
END $$
"""


def refused_by(statements: list[tuple[str, list[Any]]]) -> str | None:
    """The constraint that refused the last of `statements`, in a rolled-back transaction, or
    None when all of them were accepted."""
    refused = None
    with transaction.atomic():
        with connection.cursor() as cursor:
            for mutation in SCHEMA_MUTATIONS:
                cursor.execute(mutation)
            for statement, parameters in statements[:-1]:
                cursor.execute(statement, parameters)
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(*statements[-1])
        except IntegrityError as error:
            refused = getattr(getattr(error.__cause__, "diag", None), "constraint_name", None)
        transaction.set_rollback(True)
    return refused


# ---------------------------------------------------------------------------------- checks ----


def check_accepted_is_succeeded() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    with smtp_stub() as stub:
        report = run(local(stub))
        received = list(stub.record.messages)
    row, tries = delivery(delivery_id), attempts(delivery_id)
    assert (
        row["status"] == "succeeded"
        and [t["outcome"] for t in tries] == ["accepted"]
        and report.sent == 1
        and len(received) == 1
    ), "an accepted message did not succeed"
    assert tries[0]["provider_message_id"] == "STUB1", "the provider message id was not recorded"
    assert row["operation_ref"] == tries[0]["message_id"] and tries[0]["smtp_code"] == 250, (
        "the Message-ID is not the delivery's operation reference"
    )
    assert message(delivery_id)["sealed"] is None, "the sealed secret outlived the delivery"
    assert [action for action, _ in audits(delivery_id)] == ["outbox_delivery.sent"], (
        "an accepted message was not audited once as sent"
    )
    parsed = message_from_bytes(received[0], policy=policy.default)
    payload = parsed.get_payload(decode=True)
    body = payload.decode("utf-8") if isinstance(payload, bytes) else ""
    assert (
        f"{LINK}#{SECRET}" in body
        and parsed["Reply-To"] == REPLY_TO
        and parsed["Auto-Submitted"] == "auto-generated"
        and parsed["Message-ID"] == tries[0]["message_id"]
        and parsed["Content-Language"] == "fr"
        and parsed["To"] == RECIPIENT
    ), "the message lacks its link, Reply-To, Auto-Submitted, Message-ID or Content-Language"


def check_temporary_is_deferred_with_backoff() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    # The top of the full-jitter window, so the delay is the window itself.
    with patched(sender, "jitter", lambda upper: upper), smtp_stub(Script(rcpt=TRY_LATER)) as stub:
        run(local(stub))
        received = len(stub.record.messages)
    tries = attempts(delivery_id)
    assert (
        delivery(delivery_id)["status"] == "pending"
        and [t["outcome"] for t in tries] == ["temporary"]
        and received == 0
    ), "a temporary refusal ended the delivery"
    assert message(delivery_id)["not_before"] >= tries[0]["finished_at"] + timedelta(
        seconds=FIRST_BACKOFF_S - 1
    ), "a deferred delivery was not backed off"
    assert [(a, m["reason"]) for a, m in audits(delivery_id)] == [
        ("outbox_delivery.deferred", "temporary")
    ], "a deferral was not audited as one"


def check_deferrals_are_bounded() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    with patched(sender, "jitter", lambda upper: 0.0), smtp_stub(Script(rcpt=TRY_LATER)) as stub:
        for _ in range(DEFERRAL_BUDGET - 1):
            run(local(stub))
            make_due(delivery_id)
        early = delivery(delivery_id)["status"]
        run(local(stub))
    tries = outcomes(delivery_id)
    assert delivery(delivery_id)["status"] == "failed", "a delivery was deferred past its budget"
    assert early == "pending" and tries == ["temporary"] * DEFERRAL_BUDGET, (
        "a delivery failed before its budget"
    )
    action, metadata = audits(delivery_id)[-1]
    assert (action, metadata["reason"]) == ("outbox_delivery.failed", "attempts_exhausted"), (
        "an exhausted delivery was not audited as such"
    )


def check_permanent_is_failed() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    with smtp_stub(Script(rcpt=ACCEPT_REJECT)) as stub:
        run(local(stub))
        make_due(delivery_id)
        run(local(stub))
        rcpts = stub.record.verbs().count("RCPT")
    assert (
        delivery(delivery_id)["status"] == "failed"
        and outcomes(delivery_id) == ["permanent"]
        and rcpts == 1
    ), "a permanent refusal was retried"
    assert message(delivery_id)["sealed"] is None, "a rejected message kept its sealed secret"
    assert [(a, m["reason"], m["smtp_code"]) for a, m in audits(delivery_id)] == [
        ("outbox_delivery.failed", "rejected", 550)
    ], "a rejection was not audited as one"


def check_ambiguous_is_never_resent() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    with smtp_stub(Script(final=None)) as stub:
        run(local(stub))
        make_due(delivery_id)
        run(local(stub))
        received = len(stub.record.messages)
    assert (
        delivery(delivery_id)["status"] == "needs_reconciliation"
        and outcomes(delivery_id) == ["ambiguous"]
        and received == 1
    ), "an ambiguous send was not held for reconciliation"
    assert [(a, m["reason"]) for a, m in audits(delivery_id)] == [
        ("outbox_delivery.reconciliation_required", "outcome_unknown")
    ], "an ambiguous send was not audited as needing reconciliation"
    assert message(delivery_id)["sealed"] is not None, (
        "an unresolved message lost what an operator's resume would send"
    )
    odd = enqueue(org)
    with smtp_stub(Script(final="354 2.0.0 <{address}> go on")) as stub:
        run(local(stub))
    assert delivery(odd)["status"] == "needs_reconciliation" and outcomes(odd) == ["ambiguous"], (
        "a reply that decides nothing was read as an outcome"
    )


def check_abandoned_attempt_is_reconciled() -> None:
    org = organisation()
    stale = enqueue(org)
    claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    assert claimed is not None and claimed.delivery_id == stale, (
        "the stale delivery was not claimed"
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_deliveryattempt SET started_at = clock_timestamp() - "
            "interval '16 minutes' WHERE delivery_id = %s",
            [stale],
        )
    fresh = enqueue(org)
    claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    assert claimed is not None and claimed.delivery_id == fresh, (
        "the fresh delivery was not claimed"
    )
    with smtp_stub() as stub:
        run(local(stub))
        received = len(stub.record.messages)
    assert (
        delivery(stale)["status"] == "needs_reconciliation"
        and outcomes(stale) == ["abandoned"]
        and received == 0
    ), "an abandoned attempt was left in flight"
    assert delivery(fresh)["status"] == "in_flight" and outcomes(fresh) == [None], (
        "an attempt still running was abandoned"
    )
    assert [(a, m["reason"]) for a, m in audits(stale)] == [
        ("outbox_delivery.reconciliation_required", "attempt_abandoned")
    ], "an abandoned attempt was not audited as needing reconciliation"


def check_attempt_guards_refuse() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    insert = (
        "INSERT INTO outbox_deliveryattempt (id, delivery_id, seq, message_id) "
        "VALUES (%s, %s, %s, '<probe@notify.localhost>')"
    )
    first = (insert, [uuid.uuid4(), delivery_id, 1])
    close = (
        "UPDATE outbox_deliveryattempt SET outcome = 'temporary', finished_at = clock_timestamp() "
        "WHERE delivery_id = %s AND seq = 1",
        [delivery_id],
    )
    assert refused_by([first, (insert, [uuid.uuid4(), delivery_id, 2])]) == (
        "outbox_deliveryattempt_one_open"
    ), "a delivery held two open attempts"
    rewrite = (
        "UPDATE outbox_deliveryattempt SET outcome = 'accepted' WHERE delivery_id = %s",
        [delivery_id],
    )
    assert refused_by([first, close, rewrite]) == "outbox_deliveryattempt_outcome_once", (
        "a closed attempt was rewritten"
    )
    delete = ("DELETE FROM outbox_deliveryattempt WHERE delivery_id = %s", [delivery_id])
    assert refused_by([first, close, delete]) == "outbox_deliveryattempt_retained", (
        "an attempt was deleted"
    )


def check_nothing_secret_is_logged() -> None:
    org = organisation()
    accepted = enqueue(org)
    rejected = enqueue(org, recipient=OTHER_RECIPIENT, secret=OTHER_SECRET)
    out, err = io.StringIO(), io.StringIO()
    with captured_logs() as logs, redirect_stdout(out), redirect_stderr(err):
        with smtp_stub() as stub:
            run(local(stub), limit=1)
        with smtp_stub(Script(rcpt=ACCEPT_REJECT)) as stub:
            run(local(stub))
    assert (
        delivery(accepted)["status"] == "succeeded" and delivery(rejected)["status"] == "failed"
    ), "the run did not send one message and refuse the other"
    stored = "".join(table_text(table) for table in ("audit_auditevent", "outbox_deliveryattempt"))
    haystack = "\n".join([*logs, out.getvalue(), err.getvalue(), stored])
    needles = (SECRET, OTHER_SECRET, RECIPIENT, OTHER_RECIPIENT, LINK, BODY_MARKER, "Bonjour")
    assert not [needle for needle in needles if needle in haystack], (
        "a secret or an address reached a log, an output or an audit row"
    )
    logged = "\n".join(logs)
    assert str(accepted) in logged and str(rejected) in logged, "the run logged no delivery id"


def check_secret_is_sealed_and_bound() -> None:
    org = organisation()
    first = enqueue(org)
    second = enqueue(org, recipient=OTHER_RECIPIENT, secret=OTHER_SECRET)
    stored = "".join(
        table_text(table)
        for table in (
            "outbox_message",
            "outbox_outboxdelivery",
            "outbox_deliveryattempt",
            "audit_auditevent",
        )
    )
    sealed = [bytes(row["sealed"]) for row in _all("SELECT sealed FROM outbox_message")]
    needles = (SECRET, OTHER_SECRET, RECIPIENT, OTHER_RECIPIENT)
    assert not [n for n in needles if n in stored or any(n.encode() in s for s in sealed)], (
        "the link secret or the recipient is stored in clear"
    )
    assert len({value[1 : 1 + seal.NONCE_BYTES] for value in sealed}) == len(sealed), (
        "two seals shared a nonce"
    )
    moved = bytes(message(second)["sealed"])
    try:
        seal.unseal(KEY, first, moved)
    except seal.SealError:
        pass
    else:
        raise AssertionError("a sealed value opened under another delivery")
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_message SET sealed = %s WHERE delivery_id = %s", [moved, first]
        )
    try:
        run(nowhere())
    except seal.SealError:
        pass
    else:
        raise AssertionError("a run sent a message whose sealed value does not open")
    assert delivery(first)["status"] == "pending" and attempts(first) == [], (
        "an unsealable message changed state"
    )


def check_expired_is_not_sent() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_message SET expires_at = clock_timestamp() - interval '1 second' "
            "WHERE delivery_id = %s",
            [delivery_id],
        )
    claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    assert claimed is None and delivery(delivery_id)["status"] == "pending", (
        "an expired message was claimed"
    )
    with smtp_stub() as stub:
        run(local(stub))
        connections = stub.record.connections
    assert (
        delivery(delivery_id)["status"] == "failed"
        and [(a, m["reason"]) for a, m in audits(delivery_id)]
        == [("outbox_delivery.failed", "expired")]
        and connections == 0
    ), "an expired message was not failed"
    assert message(delivery_id)["sealed"] is None, "an expired message kept its sealed secret"


def check_unapproved_copy_is_held_remotely() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    # The shipped copy is approved: the check withdraws that approval for its own run.
    with patched(catalogue, "unapproved", lambda: frozenset({"owner_claim"})), smtp_stub() as stub:
        report = run(remote(stub))
        connections = stub.record.connections
    assert (
        delivery(delivery_id)["status"] == "pending"
        and attempts(delivery_id) == []
        and connections == 0
        and report.held_for_approval == 1
    ), "unapproved copy was claimed on a remote transport"
    with patched(catalogue, "unapproved", lambda: frozenset({"owner_claim"})), smtp_stub() as stub:
        run(local(stub))
    assert delivery(delivery_id)["status"] == "succeeded", (
        "unapproved copy was not sent on a local transport"
    )


def check_starttls_is_required() -> None:
    org = organisation()
    first = enqueue(org)
    second = enqueue(org)
    with smtp_stub(Script(starttls=False)) as stub:
        report = run(remote(stub))
        verbs = stub.record.verbs()
    assert "MAIL" not in verbs and "RCPT" not in verbs and "DATA" not in verbs, (
        "a message was sent without STARTTLS"
    )
    assert (
        delivery(first)["status"] == "pending"
        and outcomes(first) == ["transport"]
        and attempts(second) == []
        and report.stopped_on_transport_failure
        and [(a, m["reason"]) for a, m in audits(first)]
        == [("outbox_delivery.deferred", "transport")]
    ), "a STARTTLS failure did not defer the delivery and stop the run"


def check_spent_budget_stops_run() -> None:
    org = organisation()
    first = enqueue(org)
    second = enqueue(org)
    ticks = iter([0.0, 0.0, 30.0])
    with smtp_stub() as stub:
        report = sender.run_deliveries(
            local(stub), key=KEY, budget_s=20, clock=lambda: next(ticks, 30.0)
        )
    assert (
        delivery(first)["status"] == "succeeded"
        and attempts(second) == []
        and report.stopped_on_budget
        and report.line().endswith(" stopped=budget")
    ), "a run claimed a message after its time budget was spent"


def check_transport_failure_stops_run() -> None:
    org = organisation()
    first = enqueue(org)
    second = enqueue(org)
    report = run(nowhere())
    assert attempts(second) == [] and report.stopped_on_transport_failure, (
        "a run went on after its transport failed"
    )
    for _ in range(DEFERRAL_BUDGET):
        make_due(first)
        run(nowhere())
    assert delivery(first)["status"] == "pending", "a transport outage spent the delivery's budget"
    assert outcomes(first) == ["transport"] * (DEFERRAL_BUDGET + 1) and [
        (a, m["reason"]) for a, m in audits(first)
    ] == [("outbox_delivery.deferred", "transport")] * (DEFERRAL_BUDGET + 1), (
        "a transport failure was not recorded as one"
    )


def check_starttls_verifies_the_server() -> None:
    org = organisation()
    pki = stub_pki()
    trusted = dataclasses.replace(nowhere(), host="localhost", starttls=True, sender=REMOTE_FROM)

    def attempt(transport: MailTransport) -> tuple[uuid.UUID, list[str]]:
        delivery_id = enqueue(org)
        with smtp_stub(Script(tls=pki.server_context())) as stub:
            run(dataclasses.replace(transport, port=stub.port))
            verbs = stub.record.verbs()
        # Out of the way of the next scenario's claim: a refused delivery stays pending.
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE outbox_message SET not_before = clock_timestamp() + interval '1 day' "
                "WHERE delivery_id = %s",
                [delivery_id],
            )
        return delivery_id, verbs

    delivered, verbs = attempt(dataclasses.replace(trusted, ca_pem=pki.ca_pem))
    assert delivery(delivered)["status"] == "succeeded" and "TLS-ESTABLISHED" in verbs, (
        "a STARTTLS handshake with a trusted server did not deliver"
    )
    untrusted, verbs = attempt(trusted)
    assert "MAIL" not in verbs and outcomes(untrusted) == ["transport"], (
        "a server with an untrusted certificate was sent a message"
    )
    mismatched, verbs = attempt(dataclasses.replace(trusted, host="127.0.0.1", ca_pem=pki.ca_pem))
    assert "MAIL" not in verbs and outcomes(mismatched) == ["transport"], (
        "a server whose name does not match its certificate was sent a message"
    )


def _refused(url: str, *, password: str | None = None, sender_address: str = REMOTE_FROM) -> bool:
    try:
        smtp.parse_transport(url, password=password, sender=sender_address)
    except TransportConfigError:
        return True
    return False


def check_transport_settings_are_validated() -> None:
    assert _refused("smtp+insecure://smtp.tem.example.test:587"), (
        "plaintext SMTP to a remote host was accepted"
    )
    assert _refused("smtp://smtp.tem.example.test", sender_address="Kodera <no-reply@kodera.io>"), (
        "a remote transport accepted a From outside the notify domains"
    )
    assert _refused("smtp://project:pw@smtp.tem.example.test", password="pw"), (
        "a password in the URL was accepted"
    )
    assert _refused("smtp://project@smtp.tem.example.test"), (
        "a user without a password was accepted"
    )
    assert _refused("smtps://smtp.tem.example.test"), "an unknown scheme was accepted"
    try:
        seal.key_from_environment({"KODERA_OUTBOX_SEAL_KEY": "c2hvcnQ="})
    except seal.SealKeyError:
        pass
    else:
        raise AssertionError("a malformed seal key was accepted")
    assert _refused("smtp+insecure://mailpit:1025"), "plaintext SMTP to a remote host was accepted"
    compose = smtp.parse_transport(
        "smtp+insecure://mailpit:1025",
        password=None,
        sender=LOCAL_FROM,
        insecure_hosts=settings.KODERA_MAIL_INSECURE_HOSTS,
    )
    mailpit = smtp.parse_transport(
        "smtp+insecure://localhost:1025", password=None, sender=LOCAL_FROM
    )
    tem = smtp.parse_transport(
        "smtp://project@smtp.tem.example.test", password="pw", sender=REMOTE_FROM
    )
    assert (
        mailpit.local
        and compose.local
        and (mailpit.host, mailpit.port) == ("localhost", 1025)
        and not tem.local
        and (tem.port, tem.username, tem.reply_to) == (587, "project", REPLY_TO)
        and smtp.transport_from_environment({}) is None
        and seal.key_from_environment({}) is None
    ), "a valid transport setting was refused or misread"


def check_enqueue_is_checked() -> None:
    org = organisation()
    try:
        with override_settings(KODERA_OUTBOX_SEAL_KEY=KEY):
            enqueue(org, atomic=False)
    except sender.SenderUnavailableError:
        pass
    else:
        raise AssertionError("a message was enqueued outside its caller's transaction")
    try:
        enqueue(org, key=None)
    except sender.SenderUnavailableError:
        pass
    else:
        raise AssertionError("a message was enqueued without a seal key")

    def refused(**changes: Any) -> bool:
        try:
            enqueue(org, **changes)
        except sender.MessageRefusedError:
            return True
        return False

    assert refused(params={"organisation_name": "Acme Coop"}) and refused(
        params={**PARAMS, "recipient_name": "Someone"}
    ), "a message with undeclared parameters was enqueued"
    assert refused(link="https://console.example.test/claim/1"), (
        "a link outside the allowed origins was enqueued"
    )
    assert refused(expires_in=timedelta(days=8)), (
        "a message that would wait over seven days was enqueued"
    )
    assert refused(recipient="o'brien@example.test") and refused(
        recipient='"quoted"@example.test'
    ), "an address outside the conservative set was enqueued"
    assert all(
        (
            refused(template="no_such_template"),
            refused(locale="de"),
            refused(link=f"{LINK}#fragment"),
            refused(link="http://app.example.test/claim/1"),
            refused(link="https://user@app.example.test/claim/1"),
            refused(secret="short"),
            refused(recipient="owner@example.test\r\nBcc: x@example.test"),
            refused(recipient="Owner <owner@example.test>"),
            refused(expires_in=timedelta(seconds=-1)),
            refused(params={**PARAMS, "organisation_name": "line\nbreak"}),
        )
    ), "an invalid message was enqueued"
    assert _all("SELECT id FROM outbox_outboxdelivery") == [], "a refused message wrote a row"
    delivery_id = enqueue(org)
    row = delivery(delivery_id)
    assert (row["status"], row["category"], row["changes_realm"]) == (
        "pending",
        "message",
        False,
    ), "a valid message was not enqueued as a pending message delivery"


def check_catalogue_carries_the_approved_copy() -> None:
    loaded = catalogue.load()
    onboarding = ("owner_claim", "invitation", "invitation_account_ready")
    assert set(onboarding) <= set(loaded), "a template the slice needs is missing"
    assert all(loaded[t].approved for t in onboarding), "approved copy is not marked approved"
    text = catalogue.PATH.read_text(encoding="utf-8")
    # Every template not approved is a draft, and says so.
    approved = sum(1 for t in loaded.values() if t.approved)
    assert "COPY TO APPROVE" not in text and text.count('copy = "approved"') == approved, (
        "the catalogue still carries placeholder copy"
    )
    assert text.count('copy = "draft"') == len(loaded) - approved, (
        "an unapproved template does not say it is a draft"
    )
    assert [
        loaded[t].copies[locale].subject
        for t in ("owner_claim", "invitation")
        for locale in ("fr", "en")
    ] == APPROVED_SUBJECTS, "a subject differs from the approved copy"
    for template_id in ("owner_claim", "invitation"):
        body = loaded[template_id].copies["fr"].body
        assert APPROVED_SET_UP_PARAGRAPH + "\n\n${link}\n" in body, (
            "the approved set-up paragraph is not just before the link"
        )
        assert "${link}\n\n" + APPROVED_SET_UP_VALIDITY[template_id] + "\n\n" in body, (
            "the approved set-up validity is not just after the link"
        )
    # Sent when the realm mails no set-up link: the invitation as approved before that mail existed.
    ready = loaded["invitation_account_ready"]
    invitation = loaded["invitation"]
    assert [ready.copies[locale].subject for locale in ("fr", "en")] == APPROVED_SUBJECTS[2:], (
        "the account-ready invitation's subject differs from the approved copy"
    )
    for locale in ("fr", "en"):
        assert "Configurer votre compte Kodera" not in ready.copies[locale].body, (
            "the account-ready invitation announces a set-up mail"
        )
        assert set(ready.copies[locale].body.splitlines()) < set(
            invitation.copies[locale].body.splitlines()
        ), "the account-ready invitation says something the approved invitation does not"
    values = {"organisation_name": "Acme Coop", "role": "org_member", "expires_at": "2026-10-09"}
    for template_id in onboarding:
        template = loaded[template_id]
        assert set(template.copies) == {"fr", "en"}, "a template lacks its French or English copy"
        for locale in template.copies:
            rendered = catalogue.render(
                template_id,
                locale,
                {name: values[name] for name in template.params},
                link="https://app.localhost/x#s3cr3t",
            )
            assert "https://app.localhost/x#s3cr3t" in rendered.body, "a template drops its link"


def check_unbuildable_message_is_failed() -> None:
    org = organisation()
    broken = enqueue(org)
    sound = enqueue(org)

    def build(*args: Any, **kwargs: Any) -> bytes:
        if build.calls == 0:  # type: ignore[attr-defined]
            build.calls += 1  # type: ignore[attr-defined]
            raise ValueError("a header that cannot be encoded")
        return real(*args, **kwargs)

    real = sender.build_message
    build.calls = 0  # type: ignore[attr-defined]
    try:
        with patched(sender, "build_message", build), smtp_stub() as stub:
            run(local(stub))
    except ValueError:
        raise AssertionError("an unbuildable message wedged the queue") from None
    assert (
        delivery(broken)["status"] == "failed"
        and attempts(broken) == []
        and [(a, m["reason"]) for a, m in audits(broken)]
        == [("outbox_delivery.failed", "unrenderable")]
        and delivery(sound)["status"] == "succeeded"
    ), "an unbuildable message was not failed as unrenderable"


def check_late_outcome_is_dropped() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    assert claimed is not None, "the delivery was not claimed"
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_deliveryattempt SET started_at = clock_timestamp() - "
            "interval '16 minutes' WHERE delivery_id = %s",
            [delivery_id],
        )
    sender.sweep(sender.RunReport())
    report = sender.RunReport()
    try:
        sender.record_outcome(claimed, smtp.SendResult(outcome="accepted", smtp_code=250), report)
    except IntegrityError:
        raise AssertionError("a late outcome was written over its abandoned attempt") from None
    assert (
        delivery(delivery_id)["status"] == "needs_reconciliation"
        and outcomes(delivery_id) == ["abandoned"]
        and report.late == 1
    ), "a late outcome was written over its abandoned attempt"


def check_command_runs_once() -> None:
    org = organisation()
    delivery_id = enqueue(org)
    out = io.StringIO()
    with smtp_stub() as stub:
        with override_settings(KODERA_MAIL_TRANSPORT=local(stub), KODERA_OUTBOX_SEAL_KEY=KEY):
            try:
                call_command("run_deliveries", stdout=out)
            except CommandError:
                pass
            else:
                raise AssertionError("run_deliveries ran without --once")
            call_command("run_deliveries", "--once", stdout=out)
    assert delivery(delivery_id)["status"] == "succeeded" and "sent=1" in out.getvalue(), (
        "run_deliveries --once did not send the due message"
    )
    for transport, key in ((None, KEY), (nowhere(), None)):
        with override_settings(KODERA_MAIL_TRANSPORT=transport, KODERA_OUTBOX_SEAL_KEY=key):
            try:
                call_command("run_deliveries", "--once", stdout=out)
            except CommandError:
                continue
        raise AssertionError("run_deliveries ran without a transport or a seal key")


CONFIRMATION = {
    "organisation_name": "Mail",
    "order_reference": "order-ref-0001",
    "documents": [
        "CGV, version 1 — https://api.localhost/api/v1/legal-documents/cgv/1/fr",
        "DPA, version 1 — https://api.localhost/api/v1/legal-documents/dpa/1/fr",
    ],
}


def check_link_less_message_is_checked_and_sent() -> None:
    org = organisation()

    def refused(link: str | None = None, secret: str | None = None, **params: Any) -> bool:
        try:
            enqueue(
                org,
                template="order_confirmation",
                link=link,
                secret=secret,
                params={**CONFIRMATION, **params},
            )
        except sender.MessageRefusedError:
            return True
        return False

    assert refused(link=LINK, secret=SECRET) and refused(secret=SECRET), (
        "a link-less template took a link"
    )
    assert refused(documents=[]) and refused(documents=["one line"] * 11), (
        "a lines parameter out of bounds was accepted"
    )
    enqueue(org, template="order_confirmation", link=None, secret=None, params=CONFIRMATION)
    with smtp_stub() as stub:
        report = run(local(stub))
        received = list(stub.record.messages)
    parts = [
        message_from_bytes(raw, policy=policy.default).get_body(("plain",)) for raw in received
    ]
    assert all(part is not None for part in parts), "a message without its plain-text part"
    bodies = [part.get_content() for part in parts if part is not None]
    assert (
        report.sent == 1
        and len(bodies) == 1
        and all(line in bodies[0] for line in CONFIRMATION["documents"])
    ), "a link-less message was not sent with its lines"


CHECKS: dict[str, Callable[[], None]] = {
    name.removeprefix("check_"): function
    for name, function in list(globals().items())
    if name.startswith("check_") and callable(function)
}
WITHOUT_DATABASE = frozenset(
    {"transport_settings_are_validated", "catalogue_carries_the_approved_copy"}
)


# --------------------------------------------------------------------------------- mutants ----


@dataclass(frozen=True)
class Mutant:
    name: str
    target: Any
    attribute: str
    value: Any
    check: str
    message: str


def _replies(two: str, four: str, five: str) -> Callable[[int], str]:
    def outcome(code: int) -> str:
        if 200 <= code < 300:
            return two
        return four if 400 <= code < 500 else five

    return outcome


def _seal_in_clear(
    key: bytes,
    delivery_id: uuid.UUID,
    recipient: str,
    secret: str,
    *,
    reply_to: str | None = None,
) -> bytes:
    content = {"recipient": recipient, "secret": secret}
    if reply_to is not None:
        content["reply_to"] = reply_to
    plaintext = json.dumps(content).encode()
    return seal.VERSION + bytes(seal.NONCE_BYTES) + plaintext


def _unapproved() -> dict[str, catalogue.MessageTemplate]:
    return {k: dataclasses.replace(v, approved=False) for k, v in _LOAD().items()}


def _unverified(transport: MailTransport) -> ssl.SSLContext:
    context = ssl.create_default_context(cadata=transport.ca_pem)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _any_hostname(transport: MailTransport) -> ssl.SSLContext:
    context = ssl.create_default_context(cadata=transport.ca_pem)
    context.check_hostname = False
    return context


MUTANTS: tuple[Mutant, ...] = (
    Mutant(
        "link-less-takes-a-link",
        sender,
        "link_refusal",
        lambda template, link, link_secret: None,
        "link_less_message_is_checked_and_sent",
        "a link-less template took a link",
    ),
    Mutant(
        "lines-unbounded",
        catalogue,
        "check_lines",
        lambda value: isinstance(value, list),
        "link_less_message_is_checked_and_sent",
        "a lines parameter out of bounds was accepted",
    ),
    Mutant(
        "accepted-classified-temporary",
        smtp,
        "reply_outcome",
        _replies("temporary", "temporary", "permanent"),
        "accepted_is_succeeded",
        "an accepted message did not succeed",
    ),
    Mutant(
        "provider-id-dropped",
        smtp,
        "provider_id",
        lambda reply: None,
        "accepted_is_succeeded",
        "the provider message id was not recorded",
    ),
    Mutant(
        "erasure-skipped",
        sender,
        "erase_sealed",
        lambda delivery_id: None,
        "accepted_is_succeeded",
        "the sealed secret outlived the delivery",
    ),
    Mutant(
        "reply-to-dropped",
        sender,
        "REPLY_TO_HEADER",
        "X-Reply-To",
        "accepted_is_succeeded",
        "the message lacks its link, Reply-To, Auto-Submitted, Message-ID or Content-Language",
    ),
    Mutant(
        "backoff-zero",
        sender,
        "BACKOFF_BASE_S",
        0.0,
        "temporary_is_deferred_with_backoff",
        "a deferred delivery was not backed off",
    ),
    Mutant(
        "temporary-classified-permanent",
        smtp,
        "reply_outcome",
        _replies("accepted", "permanent", "permanent"),
        "temporary_is_deferred_with_backoff",
        "a temporary refusal ended the delivery",
    ),
    Mutant(
        "budget-unbounded",
        sender,
        "MAX_DEFERRALS",
        10**6,
        "deferrals_are_bounded",
        "a delivery was deferred past its budget",
    ),
    Mutant(
        "budget-one-short",
        sender,
        "MAX_DEFERRALS",
        DEFERRAL_BUDGET - 1,
        "deferrals_are_bounded",
        "a delivery failed before its budget",
    ),
    Mutant(
        "permanent-classified-temporary",
        smtp,
        "reply_outcome",
        _replies("accepted", "temporary", "temporary"),
        "permanent_is_failed",
        "a permanent refusal was retried",
    ),
    Mutant(
        "content-failure-temporary",
        smtp,
        "CONTENT_FAILURE",
        "temporary",
        "ambiguous_is_never_resent",
        "an ambiguous send was not held for reconciliation",
    ),
    Mutant(
        "stale-threshold-widened",
        sender,
        "STALE_AFTER",
        timedelta(days=1),
        "abandoned_attempt_is_reconciled",
        "an abandoned attempt was left in flight",
    ),
    Mutant(
        "stale-threshold-zero",
        sender,
        "STALE_AFTER",
        timedelta(0),
        "abandoned_attempt_is_reconciled",
        "an attempt still running was abandoned",
    ),
    Mutant(
        "one-open-index-dropped",
        SCHEMA_MUTATIONS,
        "",
        "DROP INDEX outbox_deliveryattempt_one_open",
        "attempt_guards_refuse",
        "a delivery held two open attempts",
    ),
    Mutant(
        "outcome-once-dropped",
        SCHEMA_MUTATIONS,
        "",
        GUARD_WITHOUT_OUTCOME_ONCE,
        "attempt_guards_refuse",
        "a closed attempt was rewritten",
    ),
    Mutant(
        "retained-dropped",
        SCHEMA_MUTATIONS,
        "",
        GUARD_WITHOUT_RETAINED,
        "attempt_guards_refuse",
        "an attempt was deleted",
    ),
    Mutant(
        "smtp-debug-output-on",
        smtp,
        "SMTP_DEBUGLEVEL",
        1,
        "nothing_secret_is_logged",
        "a secret or an address reached a log, an output or an audit row",
    ),
    Mutant(
        "whole-reply-stored-as-id",
        smtp,
        "provider_id",
        lambda reply: reply.decode("ascii", "replace"),
        "nothing_secret_is_logged",
        "a secret or an address reached a log, an output or an audit row",
    ),
    Mutant(
        "sealed-in-clear",
        seal,
        "seal",
        _seal_in_clear,
        "secret_is_sealed_and_bound",
        "the link secret or the recipient is stored in clear",
    ),
    Mutant(
        "associated-data-dropped",
        seal,
        "associated_data",
        lambda delivery_id: seal.CONTEXT,
        "secret_is_sealed_and_bound",
        "a sealed value opened under another delivery",
    ),
    Mutant(
        "claim-ignores-expiry",
        sender,
        "CLAIM_UNEXPIRED",
        "",
        "expired_is_not_sent",
        "an expired message was claimed",
    ),
    Mutant(
        "sweep-skips-expiry",
        sender,
        "fail_expired",
        lambda report: None,
        "expired_is_not_sent",
        "an expired message was not failed",
    ),
    Mutant(
        "copy-hold-removed",
        sender,
        "held_templates",
        lambda transport: frozenset(),
        "unapproved_copy_is_held_remotely",
        "unapproved copy was claimed on a remote transport",
    ),
    Mutant(
        "starttls-skipped",
        smtp,
        "negotiate_tls",
        lambda client, transport: None,
        "starttls_is_required",
        "a message was sent without STARTTLS",
    ),
    Mutant(
        "run-ignores-its-budget",
        sender,
        "STOP_ON_BUDGET",
        False,
        "spent_budget_stops_run",
        "a run claimed a message after its time budget was spent",
    ),
    Mutant(
        "run-continues-after-transport-failure",
        sender,
        "STOP_ON_TRANSPORT_FAILURE",
        False,
        "transport_failure_stops_run",
        "a run went on after its transport failed",
    ),
    Mutant(
        "loopback-test-widened",
        smtp,
        "is_local_host",
        lambda host, insecure_hosts=frozenset(): True,
        "transport_settings_are_validated",
        "plaintext SMTP to a remote host was accepted",
    ),
    Mutant(
        "sender-domain-rule-removed",
        smtp,
        "sender_domain_allowed",
        lambda domain: True,
        "transport_settings_are_validated",
        "a remote transport accepted a From outside the notify domains",
    ),
    Mutant(
        "caller-transaction-not-required",
        sender,
        "require_caller_transaction",
        lambda: None,
        "enqueue_is_checked",
        "a message was enqueued outside its caller's transaction",
    ),
    Mutant(
        "seal-key-not-required",
        sender,
        "seal_key",
        lambda: KEY,
        "enqueue_is_checked",
        "a message was enqueued without a seal key",
    ),
    Mutant(
        "parameter-check-removed",
        catalogue,
        "check_params",
        lambda template, params: None,
        "enqueue_is_checked",
        "a message with undeclared parameters was enqueued",
    ),
    Mutant(
        "copy-read-as-unapproved",
        catalogue,
        "load",
        _unapproved,
        "catalogue_carries_the_approved_copy",
        "approved copy is not marked approved",
    ),
    Mutant(
        "certificate-not-verified",
        smtp,
        "tls_context",
        _unverified,
        "starttls_verifies_the_server",
        "a server with an untrusted certificate was sent a message",
    ),
    Mutant(
        "hostname-not-checked",
        smtp,
        "tls_context",
        _any_hostname,
        "starttls_verifies_the_server",
        "a server whose name does not match its certificate was sent a message",
    ),
    Mutant(
        "transport-failures-counted",
        sender,
        "COUNT_TRANSPORT_FAILURES",
        True,
        "transport_failure_stops_run",
        "a transport outage spent the delivery's budget",
    ),
    Mutant(
        "nonce-reused",
        seal,
        "nonce",
        lambda: bytes(seal.NONCE_BYTES),
        "secret_is_sealed_and_bound",
        "two seals shared a nonce",
    ),
    Mutant(
        "late-outcome-guard-removed",
        sender,
        "attempt_is_open",
        lambda claimed: True,
        "late_outcome_is_dropped",
        "a late outcome was written over its abandoned attempt",
    ),
    Mutant(
        "run-reclaims-its-deliveries",
        sender,
        "already_attempted",
        lambda attempted: [],
        "deferrals_are_bounded",
        "a delivery failed before its budget",
    ),
    Mutant(
        "every-reply-class-decides",
        smtp,
        "DECIDING_CLASSES",
        frozenset({1, 2, 3, 4, 5}),
        "ambiguous_is_never_resent",
        "a reply that decides nothing was read as an outcome",
    ),
    Mutant(
        "link-origin-unchecked",
        sender,
        "link_origin_allowed",
        lambda origin: True,
        "enqueue_is_checked",
        "a link outside the allowed origins was enqueued",
    ),
    Mutant(
        "lifetime-uncapped",
        sender,
        "MAX_LIFETIME",
        timedelta(days=3650),
        "enqueue_is_checked",
        "a message that would wait over seven days was enqueued",
    ),
    Mutant(
        "recipient-any-atext",
        sender,
        "RECIPIENT",
        re.compile(r"[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]+"),
        "enqueue_is_checked",
        "an address outside the conservative set was enqueued",
    ),
    Mutant(
        "unbuildable-not-caught",
        sender,
        "UNBUILDABLE",
        (),
        "unbuildable_message_is_failed",
        "an unbuildable message wedged the queue",
    ),
    Mutant(
        "once-not-required",
        command,
        "require_once",
        lambda options: None,
        "command_runs_once",
        "run_deliveries ran without --once",
    ),
)


# The marker, not a fixture requested from the test body: pytest-django decides whether a test is
# transactional from its marker, and the sender refuses to run inside a test transaction.
TRANSACTIONAL = pytest.mark.django_db(transaction=True)


def _database(name: str) -> tuple[pytest.MarkDecorator, ...]:
    return () if name in WITHOUT_DATABASE else (TRANSACTIONAL,)


@pytest.mark.parametrize(
    "name", [pytest.param(name, marks=_database(name), id=name) for name in sorted(CHECKS)]
)
def test_check_holds(name: str) -> None:
    if name not in WITHOUT_DATABASE:
        assert connection.vendor == "postgresql", "the mail sender needs PostgreSQL"
        assert not connection.in_atomic_block, "the check runs outside any test transaction"
    CHECKS[name]()


@pytest.mark.parametrize(
    "mutant",
    [pytest.param(mutant, marks=_database(mutant.check), id=mutant.name) for mutant in MUTANTS],
)
def test_each_mutant_is_caught_by_its_owning_check(
    mutant: Mutant, monkeypatch: pytest.MonkeyPatch
) -> None:
    try:
        if isinstance(mutant.target, list):
            mutant.target.append(mutant.value)
        else:
            monkeypatch.setattr(mutant.target, mutant.attribute, mutant.value)
        with pytest.raises(AssertionError) as caught:
            CHECKS[mutant.check]()
    finally:
        SCHEMA_MUTATIONS.clear()
        monkeypatch.undo()
    first_line = str(caught.value).split("\n")[0]
    assert first_line == mutant.message, (
        f"{mutant.name} was caught by another failure than its own: {first_line}"
    )


def test_every_check_has_a_mutant_and_every_mutant_a_check() -> None:
    owned = {mutant.check for mutant in MUTANTS}
    assert owned == set(CHECKS), (
        f"checks never seen to fail: {sorted(set(CHECKS) - owned)}; "
        f"mutants of no check: {sorted(owned - set(CHECKS))}"
    )
    assert len({mutant.name for mutant in MUTANTS}) == len(MUTANTS), "two mutants share a name"
