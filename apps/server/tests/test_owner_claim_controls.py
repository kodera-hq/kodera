"""Delivery decisions and independent confirmation use existing recorded authority."""

from pathlib import Path

import pytest
from django.db import transaction
from owner_claim_fixtures import (
    activate_owner_history_fixture,
    bind,
    owner_world as owner_world,
    written,
)
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.audit.models import AuditEvent
from apps.identity.command_principal import staff_principal_for_command
from apps.jobs.services import Evidence, ReconciliationDecision
from apps.orgs.models import OwnerClaim


def test_control_services_and_five_command_parsers_exist_before_effects():
    from django.core.management import get_commands, load_command_class

    root = Path(__file__).resolve().parents[1]
    for name in ("claim_delivery", "claim_confirmation"):
        assert (root / "apps/orgs" / (name + ".py")).is_file(), (
            "specified claim control service missing"
        )
    for name in (
        "bind_intended_owner",
        "revoke_owner_claim",
        "reissue_owner_claim",
        "decide_claim_delivery",
        "confirm_owner_contact",
    ):
        assert name in get_commands(), "specified operator command missing"
        load_command_class(get_commands()[name], name).create_parser("manage.py", name)


def held_delivery(world):
    from test_outbox_mail_sender import nowhere

    from apps.outbox import sender
    from apps.outbox.mail.transport import SendResult

    first = bind(world)
    report = sender.RunReport()
    claimed = sender.claim_next(nowhere(), world.settings.KODERA_OUTBOX_SEAL_KEY, report)
    assert claimed is not None and claimed.delivery_id == first.delivery_id
    from email import message_from_bytes, policy

    from apps.orgs.claim_tokens import claim_id_for_token
    from apps.outbox.mail.seal import unseal
    from apps.outbox.models import OutboxMessage

    stored = OutboxMessage.objects.get(delivery_id=first.delivery_id)
    payload = unseal(world.settings.KODERA_OUTBOX_SEAL_KEY, first.delivery_id, bytes(stored.sealed))
    body = message_from_bytes(claimed.message, policy=policy.default).get_content()
    assert stored.link + "#" + payload.secret in body
    assert claim_id_for_token(payload.secret) == first.claim_id
    sender.record_outcome(
        claimed,
        SendResult(outcome="ambiguous", smtp_code=None, error_class="ConnectionResetError"),
        report,
    )
    return first, claimed


def decision(claimed, exit_="resume", outcome="completed", resource=None):
    from django.utils import timezone

    now = timezone.now()
    return ReconciliationDecision(
        subject_id=claimed.delivery_id,
        exit=exit_,
        operation_outcome=outcome,
        compute_terminated=Evidence(
            provider="synthetic-mail",
            resource_id="attempt-ended",
            request_id="req-ended",
            observed_at=now,
        ),
        target_read=Evidence(
            provider="synthetic-mail",
            resource_id=resource or claimed.message_id,
            request_id="req-mail-read",
            observed_at=now,
        ),
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(("exit_", "outcome"), [("resume", "completed"), ("fail", "no_effect")])
def test_actual_closed_delivery_decision_never_requeues_old_token(owner_world, exit_, outcome):
    from apps.orgs.claim_delivery import decide_claim_delivery
    from apps.orgs.owner_claims import ClaimRefusedError
    from apps.outbox.models import OutboxDelivery, OutboxMessage

    first, claimed = held_delivery(owner_world)
    principal = staff_principal_for_command(owner_world.operator.id)
    before_claim = list(OwnerClaim.objects.values())
    sealed = bytes(OutboxMessage.objects.get(delivery_id=first.delivery_id).sealed)
    decide_claim_delivery(principal=principal, decision=decision(claimed, exit_, outcome))
    assert OutboxDelivery.objects.get(id=first.delivery_id).status == (
        "succeeded" if exit_ == "resume" else "failed"
    )
    assert bytes(OutboxMessage.objects.get(delivery_id=first.delivery_id).sealed) == sealed
    assert list(OwnerClaim.objects.values()) == before_claim
    from apps.outbox import sender

    sender.sweep(sender.RunReport())
    assert OutboxMessage.objects.get(delivery_id=first.delivery_id).sealed is None
    from test_outbox_mail_sender import nowhere

    assert (
        sender.claim_next(
            nowhere(), owner_world.settings.KODERA_OUTBOX_SEAL_KEY, sender.RunReport()
        )
        is None
    )
    assert list(OwnerClaim.objects.values()) == before_claim
    before = written()
    with pytest.raises(ClaimRefusedError, match="not_in_reconciliation"):
        decide_claim_delivery(principal=principal, decision=decision(claimed, exit_, outcome))
    assert written() == before


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("exit_", "outcome", "resource"),
    [
        ("resume", "no_effect", None),
        ("fail", "partial", None),
        ("resume", "completed", "wrong-message-id"),
    ],
)
def test_delivery_pair_and_exact_message_id_refusals_write_nothing(
    owner_world, exit_, outcome, resource
):
    from apps.orgs.claim_delivery import decide_claim_delivery
    from apps.orgs.owner_claims import ClaimRefusedError

    _, claimed = held_delivery(owner_world)
    before = written()
    with pytest.raises(ClaimRefusedError):
        decide_claim_delivery(
            principal=staff_principal_for_command(owner_world.operator.id),
            decision=decision(claimed, exit_, outcome, resource),
        )
    assert written() == before


@pytest.mark.django_db(transaction=True)
def test_confirmation_is_recorder_only_consumed_and_idempotent_independent_audit(
    owner_world, settings
):
    from django.utils import timezone

    from apps.audit.selectors import owner_confirmation_recorded
    from apps.identity.models import Identity
    from apps.orgs.claim_confirmation import confirm_owner_contact
    from apps.orgs.models import Membership
    from apps.orgs.owner_claims import ClaimRefusedError

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    first = bind(owner_world)
    principal = staff_principal_for_command(owner_world.recorder.id)
    before = written()
    with pytest.raises(ClaimRefusedError):
        confirm_owner_contact(
            principal=principal,
            organisation_id=owner_world.organisation.id,
            claim_id=first.claim_id,
            evidence_ref="independent-channel-1",
            request_id="req-confirm-owner",
        )
    assert written() == before
    claim = OwnerClaim.objects.get(id=first.claim_id)
    intended = Identity.objects.get(id=claim.intended_identity_id)
    with transaction.atomic():
        member = Membership.objects.create(
            user_id=intended.user_id,
            organisation_id=claim.organisation_id,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        activate_owner_history_fixture(claim.organisation_id)
        OwnerClaim.objects.filter(id=claim.id).update(
            state="consumed",
            consumed_at=timezone.now(),
            consumed_by_identity_id=intended.id,
            membership_id=member.id,
        )
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    claim.refresh_from_db()
    assert claim.state == "consumed" and claim.expires_at < timezone.now()
    before = written()
    with pytest.raises(ClaimRefusedError):
        confirm_owner_contact(
            principal=staff_principal_for_command(owner_world.operator.id),
            organisation_id=claim.organisation_id,
            claim_id=claim.id,
            evidence_ref="independent-channel-1",
            request_id="req-confirm-owner",
        )
    assert written() == before
    assert (
        confirm_owner_contact(
            principal=principal,
            organisation_id=claim.organisation_id,
            claim_id=claim.id,
            evidence_ref="independent-channel-1",
            request_id="req-confirm-owner",
        )
        is True
    )
    assert owner_confirmation_recorded(organisation_id=claim.organisation_id)
    from uuid import uuid4

    from apps.audit.selectors import claim_confirmation_recorded

    assert claim_confirmation_recorded(organisation_id=claim.organisation_id, claim_id=claim.id)
    assert not claim_confirmation_recorded(organisation_id=claim.organisation_id, claim_id=uuid4())
    assert not claim_confirmation_recorded(organisation_id=uuid4(), claim_id=claim.id)
    row = AuditEvent.objects.get(action="owner_claim.confirmed")
    assert (
        row.actor_id == owner_world.recorder.id
        and row.metadata["evidence_ref"] == "independent-channel-1"
    )
    assert (
        confirm_owner_contact(
            principal=principal,
            organisation_id=claim.organisation_id,
            claim_id=claim.id,
            evidence_ref="independent-channel-1",
            request_id="req-confirm-owner",
        )
        is False
    )
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == 1


def test_owned_cross_application_helpers_exist_before_boundary_repair():
    import importlib

    from apps.audit import selectors as audit_selectors
    from apps.outbox import selectors as outbox_selectors

    root = Path(__file__).resolve().parents[1]
    assert (root / "apps/identity/owner_binding.py").is_file(), "excluded identity creator missing"
    identity = importlib.import_module("apps.identity.owner_binding")
    assert callable(identity.account_subject_exists)
    assert callable(identity.create_owner_identity)
    assert callable(outbox_selectors.held_owner_claim_operation)
    assert callable(audit_selectors.claim_confirmation_recorded)


@pytest.mark.parametrize(
    "change", ("too_large", "unknown_field", "string_boolean", "missing_account", "invalid_json")
)
def test_binding_stdin_is_closed_bounded_and_never_echoes_input(change):
    import io
    import json

    from apps.orgs.owner_claims import ClaimRefusedError, read_binding_input

    data = {
        "contact": "public-marker-contact@customer.test",
        "account_record": {
            "issuer": "https://identity.customer.test/realms/customer",
            "subject": "public-subject",
            "credential_created": False,
            "evidence_ref": "public-account-fact",
        },
    }
    if change == "unknown_field":
        data["public-secret-marker"] = "unexpected"
    elif change == "string_boolean":
        data["account_record"]["credential_created"] = "false"
    elif change == "missing_account":
        del data["account_record"]
    raw = (
        "{"
        if change == "invalid_json"
        else " " * 16385
        if change == "too_large"
        else json.dumps(data)
    )
    with pytest.raises(ClaimRefusedError) as caught:
        read_binding_input(io.StringIO(raw))
    assert str(caught.value) == "binding_input_refused"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ("wrong_category", "wrong_template"))
def test_actual_non_claim_delivery_refused_before_queue_effects(owner_world, kind):
    from types import SimpleNamespace

    from django.utils import timezone
    from test_outbox_mail_sender import nowhere

    from apps.orgs.claim_delivery import decide_claim_delivery
    from apps.orgs.owner_claims import ClaimRefusedError
    from apps.outbox import sender
    from apps.outbox.mail.transport import SendResult
    from apps.outbox.models import OutboxDelivery

    now = timezone.now()
    if kind == "wrong_category":
        delivery = OutboxDelivery.objects.create(
            organisation_id=owner_world.organisation.id,
            category="commercial",
            changes_realm=False,
            status="pending",
            created_at=now,
            updated_at=now,
        )
        claimed = SimpleNamespace(delivery_id=delivery.id, message_id="public-nonmessage-operation")
    else:
        from datetime import timedelta

        with transaction.atomic():
            delivery_id = sender.enqueue_message(
                organisation_id=owner_world.organisation.id,
                template_id="invitation",
                locale="en",
                recipient="public-member@customer.test",
                link="https://app.localhost/invitation",
                link_secret="public-invitation-secret-vector-123456",
                params={
                    "organisation_name": "Synthetic",
                    "role": "org_member",
                    "expires_at": "synthetic-expiry",
                },
                expires_at=now + timedelta(hours=1),
            )
        report = sender.RunReport()
        claimed = sender.claim_next(nowhere(), owner_world.settings.KODERA_OUTBOX_SEAL_KEY, report)
        assert claimed is not None and claimed.delivery_id == delivery_id
        sender.record_outcome(
            claimed,
            SendResult(outcome="ambiguous", smtp_code=None, error_class="ConnectionResetError"),
            report,
        )
    before = written()
    with pytest.raises(ClaimRefusedError, match="not_claim_delivery"):
        decide_claim_delivery(
            principal=staff_principal_for_command(owner_world.operator.id),
            decision=decision(claimed),
        )
    assert written() == before


def test_held_delivery_sql_uses_actual_owned_message_table(monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from apps.outbox import selectors
    from apps.outbox.models import OutboxMessage

    statements = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def execute(self, sql, parameters):
            statements.append(sql)

        def fetchone(self):
            return None

    monkeypatch.setattr(
        selectors, "connection", SimpleNamespace(in_atomic_block=True, cursor=Cursor)
    )
    assert selectors.held_owner_claim_operation(uuid4()) is None
    assert "JOIN " + OutboxMessage._meta.db_table + " m " in statements[0]
    assert "FOR UPDATE OF d" in statements[0]


def test_database_worker_teardown_joins_all_calls_and_refuses_a_live_worker():
    import owner_claim_fixtures as helpers

    joined = []

    class Thread:
        def __init__(self, live=False):
            self.live = live

        def join(self, timeout):
            joined.append(timeout)

        def is_alive(self):
            return self.live

    settle = getattr(helpers, "settle_db_calls", None)
    assert callable(settle), "unconditional database-worker teardown missing"
    settle((Thread(), {}, 1), None, (Thread(), {}, 2))
    assert joined == [15, 15]
    with pytest.raises(AssertionError, match="database worker did not settle"):
        settle((Thread(live=True), {}, 3))
