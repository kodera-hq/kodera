"""The channel set (ADR-0018, agent-api 0.5.0 `engine_set_channel_members`) and its command loop."""

import uuid
from datetime import timedelta

import pytest
import time_machine
from django.apps import apps
from django.db import transaction
from django.utils import timezone
from test_engine_intents import credential, emit, org as org, person

from apps.engine_intents import channel_hooks, services
from apps.engine_intents.channel_sets import ChannelSetError, emit_channel_set
from apps.engine_intents.models import EngineChannelSet, EngineCommand

pytestmark = pytest.mark.django_db(transaction=True)


def channel(**overrides):
    entry = {
        "channel_id": str(uuid.uuid4()),
        "kind": "text",
        "name": "general",
        "topic": "",
        "access_etag": '"a1"',
        "archived": False,
        "audience": "listed",
        "members": ["sub-a", "sub-b"],
        "denied": [],
        "read_only": False,
        "listen_only": False,
        "exempt": [],
        "notices": [],
    }
    entry.update(overrides)
    return entry


EVERYONE = ["sub-a", "sub-b", "sub-c"]


def emit_channels(org, channels, reason="test", all_members=EVERYONE):
    with transaction.atomic():
        return emit_channel_set(
            organisation_id=org.organisation.pk,
            reason=reason,
            all_members=all_members,
            channels=channels,
        )


@pytest.fixture
def reported(monkeypatch):
    calls = []
    monkeypatch.setattr(
        channel_hooks, "channel_set_reported", lambda **kwargs: calls.append(kwargs)
    )
    return calls


def test_a_channel_set_is_only_recorded_inside_its_change_transaction(org):
    with pytest.raises(ChannelSetError, match="transaction"):
        emit_channel_set(
            organisation_id=org.organisation.pk, reason="test", all_members=[], channels=[]
        )


@pytest.mark.parametrize(
    "broken",
    [
        {"kind": "voice"},
        {"name": ""},
        {"name": " "},
        {"name": "n" * 101},
        {"topic": "t" * 1025},
        {"read_only": True, "kind": "audio"},
        {"listen_only": True, "kind": "text"},
        {"members": ["has a space"]},
        {"members": ["sub-a", "sub-a"]},
        {"exempt": ["sub-z"]},
        {"audience": "everyone"},
        {"audience": "all", "members": ["sub-a"]},
        {"denied": ["sub-a"]},  # listed with a denial
        {"members": ["sub-z"]},  # not among all_members
        {"audience": "all", "members": [], "denied": ["sub-a"], "exempt": ["sub-a"]},
        {"notices": [{"notice_id": "not-a-uuid", "body": "x"}]},
        {"notices": [{"notice_id": str(uuid.uuid4()), "body": ""}]},
        {"extra": True},
    ],
)
def test_a_set_the_contract_refuses_is_never_recorded(org, broken):
    with pytest.raises(ChannelSetError):
        emit_channels(org, [channel(**broken)])
    assert EngineChannelSet.objects.count() == 0


def test_the_member_bound_refuses_rather_than_truncates(org, monkeypatch):
    monkeypatch.setattr("apps.engine_intents.channel_sets.MAX_MEMBERS", 6)
    with pytest.raises(ChannelSetError, match="at most 6 members"):
        emit_channels(org, [channel(), channel()])  # 3 + 2 + 2
    assert EngineChannelSet.objects.count() == 0


def test_a_channel_open_to_everyone_counts_its_members_once(org, monkeypatch):
    monkeypatch.setattr("apps.engine_intents.channel_sets.MAX_MEMBERS", 4)
    open_to_all = [channel(audience="all", members=[], denied=[]) for _ in range(5)]
    open_to_all[0]["denied"] = ["sub-c"]
    channel_set = emit_channels(org, open_to_all)
    assert channel_set.all_members == EVERYONE and len(channel_set.channels) == 5


def test_each_agent_gets_the_set_and_a_newer_one_supersedes_only_its_own_kind(org):
    agent, _ = credential(org)
    person(org)
    emit(org)  # a member set, pending for the agent
    first = emit_channels(org, [channel()])
    second = emit_channels(org, [channel()])

    assert second.revision > first.revision
    states = {
        (c.channel_set_id, c.member_set_id is not None): c.state
        for c in EngineCommand.objects.filter(credential=agent)
    }
    assert states[(first.id, False)] == "superseded"
    assert states[(second.id, False)] == "pending"
    assert [s for (cs, member), s in states.items() if member] == ["pending"]
    issued = apps.get_model("audit", "AuditEvent").objects.filter(
        action="engine_channel_set.issued"
    )
    assert issued.count() == 2 and "general" not in str([e.metadata for e in issued])


def test_pull_delivers_both_kinds_and_honours_the_kinds_filter(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    entry = channel(kind="audio", listen_only=True, exempt=["sub-a"])
    channel_set = emit_channels(org, [entry])

    only_channels = services.pull(agent, kinds=("engine_set_channel_members",), limit=5)
    [command] = only_channels.commands
    assert command["kind"] == "engine_set_channel_members"
    assert command["payload"] == {
        "revision": channel_set.revision,
        "all_members": EVERYONE,
        "channels": [entry],
    }
    assert only_channels.poll_after_s == 3
    both = services.pull(agent, kinds=None, limit=5).commands
    assert [c["kind"] for c in both] == ["engine_set_member_subjects"]


def test_a_success_marks_every_channel_ready_and_its_notices_posted(org, reported):
    agent, _ = credential(org)
    notice = {"notice_id": str(uuid.uuid4()), "body": "Ada joined as an administrator"}
    a, b = channel(notices=[notice]), channel(access_etag='"b7"')
    channel_set = emit_channels(org, [a, b])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands

    services.report(
        agent,
        command["command_id"],
        {
            "status": "succeeded",
            "artefacts": {
                "revision_applied": channel_set.revision,
                "channels_applied": 2,
                "notices_posted": 1,
            },
        },
    )

    assert reported == [
        {
            "organisation_id": org.organisation.pk,
            "revision": channel_set.revision,
            "ready": {a["channel_id"]: '"a1"', b["channel_id"]: '"b7"'},
            "failed": [],
            "notices_posted": [notice["notice_id"]],
        }
    ]
    applied = apps.get_model("audit", "AuditEvent").objects.get(action="engine_channel_set.applied")
    assert applied.actor_id == agent.id and applied.metadata["channels_applied"] == 2


def test_a_partial_failure_marks_the_named_channels_failed_and_retries(org, reported):
    agent, _ = credential(org)
    notice = {"notice_id": str(uuid.uuid4()), "body": "x"}
    a, b = channel(), channel(notices=[notice])
    emit_channels(org, [a, b])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands

    services.report(
        agent,
        command["command_id"],
        {
            "status": "failed",
            "error_code": "service_unhealthy",
            "artefacts": {"failed_channel_ids": [b["channel_id"]], "channels_applied": 1},
        },
    )

    [call] = reported
    assert call["ready"] == {a["channel_id"]: '"a1"'}
    assert call["failed"] == [b["channel_id"]] and call["notices_posted"] == []
    retry = EngineCommand.objects.get(credential=agent, state="pending")
    assert retry.attempt == 2 and retry.channel_set_id is not None
    assert retry.not_before > timezone.now()


def test_a_failure_naming_no_channel_leaves_every_channel_ready_and_retries(org, reported):
    """An empty `failed_channel_ids`: every channel of the set converged and the agent failed
    elsewhere (a deleted channel's room not emptied). The channels are ready; the set is retried."""
    agent, _ = credential(org)
    a = channel()
    emit_channels(org, [a])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands

    services.report(
        agent,
        command["command_id"],
        {
            "status": "failed",
            "error_code": "service_unhealthy",
            "artefacts": {"failed_channel_ids": [], "channels_applied": 1},
        },
    )

    assert reported[0]["ready"] == {a["channel_id"]: '"a1"'} and reported[0]["failed"] == []
    assert EngineCommand.objects.filter(credential=agent, state="pending").exists()


def test_a_failure_without_channel_ids_failed_every_channel(org, reported):
    agent, _ = credential(org)
    a = channel()
    emit_channels(org, [a])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    services.report(
        agent, command["command_id"], {"status": "failed", "error_code": "invalid_payload"}
    )
    assert reported[0]["failed"] == [a["channel_id"]] and reported[0]["ready"] == {}
    assert not EngineCommand.objects.filter(state="pending").exists()  # not retryable


@pytest.mark.parametrize(
    "artefacts",
    [
        {"users_deactivated": 1},  # the member set's, not this kind's
        {"failed_channel_ids": ["not-a-uuid"]},
        {"failed_channel_ids": "x"},
        {"channels_applied": -1},
        {"channels_applied": True},
    ],
)
def test_a_channel_result_that_contradicts_the_contract_is_refused(org, artefacts):
    agent, _ = credential(org)
    emit_channels(org, [channel()])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    with pytest.raises(services.InvalidResultError):
        services.report(
            agent,
            command["command_id"],
            {"status": "failed", "error_code": "service_unhealthy", "artefacts": artefacts},
        )


def test_failed_channel_ids_only_come_with_a_failure(org):
    agent, _ = credential(org)
    entry = channel()
    emit_channels(org, [entry])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    with pytest.raises(services.InvalidResultError):
        services.report(
            agent,
            command["command_id"],
            {"status": "succeeded", "artefacts": {"failed_channel_ids": [entry["channel_id"]]}},
        )


def test_the_member_set_still_refuses_channel_artefacts(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    [command] = services.pull(agent, kinds=("engine_set_member_subjects",), limit=5).commands
    with pytest.raises(services.InvalidResultError):
        services.report(
            agent,
            command["command_id"],
            {"status": "succeeded", "artefacts": {"channels_applied": 1}},
        )


def test_a_new_agent_receives_the_latest_channel_set(org):
    emit_channels(org, [channel()])
    latest = emit_channels(org, [channel()])
    agent, _ = credential(org)
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    assert command["payload"]["revision"] == latest.revision


def test_an_agent_behind_the_latest_channel_set_for_an_hour_is_reported(org):
    agent, _ = credential(org)
    emit_channels(org, [channel()])
    with time_machine.travel(timezone.now() + timedelta(hours=2)):
        lags = services.lagging()
    assert [(lag.credential_id, lag.kind) for lag in lags] == [
        (agent.id, "engine_set_channel_members")
    ]


def test_a_failure_naming_a_channel_outside_the_set_is_refused(org, reported):
    agent, _ = credential(org)
    emit_channels(org, [channel()])
    [command] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    with pytest.raises(services.InvalidResultError):
        services.report(
            agent,
            command["command_id"],
            {
                "status": "failed",
                "error_code": "service_unhealthy",
                "artefacts": {"failed_channel_ids": [str(uuid.uuid4())]},
            },
        )
    assert reported == []


def test_the_workspace_s_dotted_reasons_are_accepted_and_others_refused(org):
    assert emit_channels(org, [channel()], reason="channel.access_changed").reason == (
        "channel.access_changed"
    )
    with pytest.raises(ChannelSetError, match="reason"):
        emit_channels(org, [channel()], reason="Not A Reason")


def test_a_notice_id_appears_once_in_a_set(org):
    notice = {"notice_id": str(uuid.uuid4()), "body": "x"}
    with pytest.raises(ChannelSetError, match="once"):
        emit_channels(org, [channel(notices=[notice]), channel(notices=[notice])])


def test_both_emitters_take_the_member_head_then_the_channel_head(org):
    from test_engine_intents import locked

    emit_channels(org, [channel()])  # both heads now exist, visible to another session
    with transaction.atomic():
        emit_channels(org, [channel()])
        assert locked("engine_intents_head", "organisation_id", org.organisation.pk)
        assert locked("engine_intents_channel_head", "organisation_id", org.organisation.pk)
    with transaction.atomic():
        services.emit_member_set(organisation_id=org.organisation.pk, reason="test")
        assert locked("engine_intents_channel_head", "organisation_id", org.organisation.pk)


def test_migration_0004_alters_the_live_command_table_without_a_scan():
    import io

    from django.core.management import call_command

    out = io.StringIO()
    call_command("sqlmigrate", "engine_intents", "0004", stdout=out)
    command_sql = [
        line
        for line in out.getvalue().splitlines()
        if '"engine_intents_command"' in line or " engine_intents_command " in line
    ]
    assert command_sql, out.getvalue()
    assert not any("FOREIGN KEY" in line or "DROP CONSTRAINT" in line for line in command_sql), (
        command_sql
    )
    assert all("NOT VALID" in line for line in command_sql if "ADD CONSTRAINT" in line), command_sql


def test_a_membership_change_and_a_workspace_change_emitting_both_kinds_do_not_deadlock(org):
    """A membership change emits the member set, then the channel set (§13.2); a workspace change
    emits the channel set, and, through a membership hook, the member set. From two connections,
    the second starting while the first holds its member head: both commit."""
    import threading
    import time

    from django.db import connection

    credential(org)
    emit_channels(org, [channel()])  # both heads exist, so the second connection waits on them
    first_holds = threading.Event()
    errors: list[BaseException] = []

    def membership_change():
        try:
            with transaction.atomic():
                services.emit_member_set(organisation_id=org.organisation.pk, reason="test")
                first_holds.set()
                time.sleep(0.5)  # the other change starts meanwhile
                emit_channel_set(
                    organisation_id=org.organisation.pk,
                    reason="membership.changed",
                    all_members=EVERYONE,
                    channels=[channel()],
                )
        except BaseException as error:  # noqa: BLE001 - reported below
            errors.append(error)
        finally:
            connection.close()

    def workspace_change():
        try:
            first_holds.wait(5)
            with transaction.atomic():
                emit_channel_set(
                    organisation_id=org.organisation.pk,
                    reason="channel.access_changed",
                    all_members=EVERYONE,
                    channels=[channel()],
                )
                services.emit_member_set(organisation_id=org.organisation.pk, reason="test")
        except BaseException as error:  # noqa: BLE001
            errors.append(error)
        finally:
            connection.close()

    threads = [
        threading.Thread(target=membership_change),
        threading.Thread(target=workspace_change),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert errors == []
    assert EngineChannelSet.objects.count() == 3
    assert apps.get_model("engine_intents", "EngineMemberSet").objects.count() == 2


def test_migration_0007_adds_the_channel_set_foreign_key_without_a_scan():
    import io

    from django.core.management import call_command

    out = io.StringIO()
    call_command("sqlmigrate", "engine_intents", "0007", stdout=out)
    [add] = [line for line in out.getvalue().splitlines() if "FOREIGN KEY" in line]
    assert "engine_command_channel_set_fk" in add and add.rstrip().endswith("NOT VALID;"), add
    out = io.StringIO()
    call_command("sqlmigrate", "engine_intents", "0008", stdout=out)
    assert "VALIDATE CONSTRAINT engine_command_channel_set_fk" in out.getvalue()


def test_a_command_naming_a_missing_channel_set_is_refused(org):
    """A command whose set is missing would make `_as_command` fail every pull of its credential:
    the database refuses it."""
    from django.db import IntegrityError, connection

    agent, _ = credential(org)
    emit_channels(org, [channel()])
    [delivered] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    with pytest.raises(IntegrityError, match="engine_command_channel_set_fk"):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS engine_command_channel_set_fk IMMEDIATE")
            EngineCommand.objects.filter(id=delivered["command_id"]).update(
                channel_set_id=uuid.uuid4()
            )


def test_an_ack_and_a_revocation_of_its_credential_do_not_deadlock(org):
    """A revocation locks the credential, then its commands. An ack carrying a boot id takes them
    in the same order: from two connections, the ack starting while the revocation holds the
    credential, both end, and the ack finds its command superseded."""
    import threading
    import time

    from django.db import connection

    agent, _ = credential(org)
    emit_channels(org, [channel()])
    [delivered] = services.pull(agent, kinds=("engine_set_channel_members",), limit=5).commands
    revoker_holds = threading.Event()
    errors: list[BaseException] = []

    def revoke():
        try:
            with transaction.atomic():
                services.EngineAgentCredential.objects.filter(id=agent.id).update(
                    last_seen_at=timezone.now()
                )
                revoker_holds.set()
                time.sleep(0.5)  # the ack starts meanwhile
                services.revoke_credential(credential_id=agent.id)
        except BaseException as error:  # noqa: BLE001 - reported below
            errors.append(error)
        finally:
            connection.close()

    def ack():
        try:
            revoker_holds.wait(5)
            services.acknowledge(agent, uuid.UUID(delivered["command_id"]), boot_id="boot-2")
        except BaseException as error:  # noqa: BLE001
            errors.append(error)
        finally:
            connection.close()

    threads = [threading.Thread(target=revoke), threading.Thread(target=ack)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert [type(error) for error in errors] == [services.CommandConflictError], errors
    assert EngineCommand.objects.get(id=delivered["command_id"]).state == "superseded"
