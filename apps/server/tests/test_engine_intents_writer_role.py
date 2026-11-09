"""The API writer role's Agent API grants are enough, and no more: ADR-0016, `dev/api_writer_role.py`.

A role holding exactly `dev/api_writer_role.py`'s grants serves the member-set command loop through
the real views: it authenticates the agent, issues and delivers the latest set, records an ack and
a boot id, records a retryable failure and issues the next attempt, records a success with its
audit row, and sends the set again a day later. It is then refused, by privilege, any change to a
recorded member set or subject, or to the head's organisation, and their deletion; any change to a
credential beyond what a request tells of the agent; any change to a command's set, credential or
attempt; and every change to the audit row a result wrote. The membership operations record sets as
the same role in tests/test_membership_writer_role.py.
"""

import json
import uuid
from datetime import timedelta

import pytest
import time_machine
from django.db import connection
from django.test import Client
from django.utils import timezone
from test_engine_intents import credential, emit, org as org, person
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused

from apps.audit.models import AuditEvent
from apps.engine_intents.models import EngineAgentCredential, EngineCommand
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer(org):
    role = f"agent_writer_{uuid.uuid4().hex[:12]}"
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


class Agent:
    def __init__(self, token):
        self.client = Client()
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def pull(self, kind="engine_set_member_subjects"):
        answer = self.client.get(f"/agent/v1/commands?kinds={kind}", **self.auth)
        assert answer.status_code == 200, answer.content
        return [command["command_id"] for command in answer.json()["commands"]]

    def post(self, command_id, action, body):
        answer = self.client.post(
            f"/agent/v1/commands/{command_id}/{action}",
            json.dumps(body),
            content_type="application/json",
            **self.auth,
        )
        assert answer.status_code == 200, answer.content
        return answer.json()

    def ack(self, command_id):
        accepted_at = "2026-01-01T00:00:00Z"
        return self.post(command_id, "ack", {"accepted_at": accepted_at, "boot_id": "boot-1"})

    def result(self, command_id, status, **fields):
        body = {"command_id": command_id, "status": status, "reported_at": "2026-01-01T00:00:01Z"}
        return self.post(command_id, "result", body | fields)


def test_the_writer_role_serves_the_agent_command_loop(org, writer):
    person(org)
    emit(org)
    credential_row, token = credential(org)  # issued after the set: the pull issues it a command
    agent = Agent(token)

    with acting_as(writer):
        assert current_user() == writer
        [first] = agent.pull()
        assert agent.ack(first)["status"] == "accepted"
        failed = agent.result(first, "failed", error_code="service_unhealthy")
        assert failed["recorded"] is True
        retry = EngineCommand.objects.get(credential_id=credential_row.id, state="pending")
        with time_machine.travel(retry.not_before + timedelta(seconds=1)):
            [second] = agent.pull()
            agent.ack(second)
            done = agent.result(second, "succeeded", artefacts={"revision_applied": 1})
        assert done == {"command_id": second, "recorded": True, "status": "succeeded"}
        with time_machine.travel(timezone.now() + timedelta(days=1, minutes=5)):
            [third] = agent.pull()
    assert len({first, second, third}) == 3
    seen = EngineAgentCredential.objects.get(pk=credential_row.pk)
    assert seen.last_boot_id == "boot-1" and seen.last_seen_at is not None
    actions = AuditEvent.objects.filter(action__startswith="engine_member_set.")
    assert sorted(actions.values_list("action", flat=True)) == [
        "engine_member_set.applied",
        "engine_member_set.failed",
        "engine_member_set.issued",
    ]


def test_the_writer_role_records_and_serves_a_channel_set(org, writer):
    from test_engine_channel_sets import channel, emit_channels

    _, token = credential(org)
    agent = Agent(token)
    with acting_as(writer):
        channel_set = emit_channels(org, [channel(), channel(kind="audio", listen_only=True)])
        [command_id] = agent.pull("engine_set_channel_members")
        agent.ack(command_id)
        done = agent.result(
            command_id, "succeeded", artefacts={"revision_applied": channel_set.revision}
        )
    assert done["recorded"] is True
    assert sorted(
        AuditEvent.objects.filter(action__startswith="engine_channel_set.").values_list(
            "action", flat=True
        )
    ) == ["engine_channel_set.applied", "engine_channel_set.issued"]


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE engine_intents_member_set SET inactive_subjects = '[]'",
        "DELETE FROM engine_intents_member_set",
        "DELETE FROM engine_intents_known_subject",
        "UPDATE engine_intents_known_subject SET subject = 'other'",
        "UPDATE engine_intents_head SET organisation_id = gen_random_uuid()",
        "UPDATE engine_intents_channel_set SET channels = '[]'",
        "DELETE FROM engine_intents_channel_set",
        "DELETE FROM engine_intents_channel_head",
        "UPDATE engine_intents_channel_head SET organisation_id = gen_random_uuid()",
        "UPDATE engine_intents_command SET channel_set_id = NULL",
        "DELETE FROM engine_intents_head",
        "UPDATE engine_intents_known_subject SET organisation_id = gen_random_uuid()",
        "UPDATE engine_intents_member_set SET unnamed_leavers = 0, malformed_subjects = 0",
        "TRUNCATE engine_intents_member_set CASCADE",
        "INSERT INTO engine_intents_credential (id) VALUES (gen_random_uuid())",
        "UPDATE engine_intents_credential SET state = 'active', revoked_at = NULL",
        "UPDATE engine_intents_credential SET secret_hash = 'x'",
        "UPDATE engine_intents_credential SET organisation_id = gen_random_uuid()",
        "DELETE FROM engine_intents_credential",
        "UPDATE engine_intents_command SET attempt = attempt + 1",
        "UPDATE engine_intents_command SET member_set_id = member_set_id",
        "UPDATE engine_intents_command SET credential_id = credential_id",
        "UPDATE engine_intents_command SET not_before = now()",
        "DELETE FROM engine_intents_command",
        "TRUNCATE engine_intents_command CASCADE",
        "UPDATE audit_auditevent SET action = 'x' WHERE action LIKE 'engine_member_set.%'",
        "DELETE FROM audit_auditevent WHERE action LIKE 'engine_member_set.%'",
    ],
)
def test_the_writer_role_cannot_rewrite_what_emission_or_a_result_wrote(org, writer, statement):
    person(org)
    emit(org)
    _, token = credential(org)
    agent = Agent(token)
    with acting_as(writer):
        [command_id] = agent.pull()
        agent.ack(command_id)
        agent.result(command_id, "succeeded", artefacts={"revision_applied": 1})
        assert refused(statement) == INSUFFICIENT_PRIVILEGE, statement
    # Control: the schema owner is not refused by privilege, so the refusal above is the role's.
    assert refused(statement) != INSUFFICIENT_PRIVILEGE, statement


def test_the_writer_role_records_an_explicit_erasure(org, writer):
    from django.db import transaction
    from test_engine_intents import leave

    from apps.engine_intents import services

    membership, subject = person(org)
    leave(org, membership)
    with acting_as(writer):
        with transaction.atomic():
            marked = services.mark_erased(
                organisation_id=org.organisation.pk, user_id=membership.user_id
            )
        assert marked == 1
        erased = emit(org)
    assert erased.erased_subjects == [subject]
