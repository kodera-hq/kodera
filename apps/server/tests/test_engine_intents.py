"""The organisation's member set and its Agent API command loop (ADR-0016), on the real database."""

import io
import json
from datetime import timedelta
from types import SimpleNamespace

import psycopg
import pytest
import time_machine
from django.apps import apps
from django.core.management import CommandError, call_command
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.utils import timezone
from psycopg import sql
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor, anchor_models

from apps.engine_intents import services
from apps.engine_intents.models import EngineCommand, EngineMemberSet

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def org():
    assert connection.vendor == "postgresql"
    models = anchor_models()
    organisation, _, _ = anchor(models, slug="alpha")
    other, _, _ = anchor(models, slug="bravo")
    return SimpleNamespace(models=models, organisation=organisation, other=other, n=0)


NO_IDENTITY = object()


def person(org, *, state="active", organisation=None, subject=None):
    """A member with an identity in the organisation's realm; returns (membership, subject).
    `subject=NO_IDENTITY` gives the member no identity row at all."""
    organisation = organisation or org.organisation
    org.n += 1
    user = org.models.User.objects.create(email=f"member-{org.n}@customer.test")
    if subject is NO_IDENTITY:
        subject = None
    else:
        subject = subject or f"sub-{organisation.slug}-{org.n}"
        apps.get_model("identity", "Identity").objects.create(
            user=user,
            organisation=organisation,
            issuer=organisation.issuer,
            realm=organisation.realm,
            subject=subject,
            email=user.email,
        )
    membership = org.models.Membership.objects.create(
        user=user,
        organisation=organisation,
        role="org_member",
        state=state,
        accepted_at=None if state == "invited" else timezone.now(),
    )
    return membership, subject


LEGACY_SUBJECT = "has a space"  # outside the contract's shape


def legacy_person(org, monkeypatch, *, state="active"):
    """A member whose identity row predates Core's printable-ASCII subject rule. No row can hold
    such a subject any more, so the realm selector is made to return one."""
    membership, _ = person(org, state=state, subject=NO_IDENTITY)
    read = services.realm_subjects

    def with_legacy(*, organisation_id):
        rows = read(organisation_id=organisation_id)
        if organisation_id == org.organisation.pk:
            rows += ((membership.user_id, LEGACY_SUBJECT, True),)
        return rows

    monkeypatch.setattr(services, "realm_subjects", with_legacy)
    return membership


def locked(table, column, value):
    """Whether another session is refused a row lock that conflicts with `FOR UPDATE` only (not
    with the key-share lock a foreign key takes)."""
    with session() as other:
        try:
            other.execute(
                sql.SQL("SELECT 1 FROM {} WHERE {} = %s FOR NO KEY UPDATE NOWAIT").format(
                    sql.Identifier(table), sql.Identifier(column)
                ),
                [value],
            )
        except psycopg.errors.LockNotAvailable:
            return True
    return False


def emit(org, **kwargs):
    with transaction.atomic():
        return services.emit_member_set(
            organisation_id=org.organisation.pk, reason="test", **kwargs
        )


def leave(org, membership, state="removed"):
    with transaction.atomic():
        org.models.Membership.objects.filter(pk=membership.pk).update(state=state)
        membership.state = state
        return services.emit_member_left(membership)


def credential(org, organisation=None):
    credential_id, token = services.issue_credential(
        organisation_id=(organisation or org.organisation).pk
    )
    return services.authenticate(token), token


# --- emission -------------------------------------------------------------------------------


def test_a_member_set_is_only_recorded_inside_the_change_transaction(org):
    with pytest.raises(services.MemberSetError, match="transaction of its change"):
        services.emit_member_set(organisation_id=org.organisation.pk, reason="test")


def test_the_set_lists_this_realm_s_active_subjects_only(org):
    _, alice = person(org)
    _, invited = person(org, state="invited")
    _, elsewhere = person(org, organisation=org.other)

    member_set = emit(org)

    assert alice in member_set.active_subjects
    assert invited not in member_set.active_subjects
    assert elsewhere not in member_set.active_subjects + member_set.inactive_subjects
    assert member_set.revision > 0


def test_a_leaver_is_listed_inactive_and_stays_listed_after_erasure(org):
    membership, bob = person(org)
    emit(org)

    left = leave(org, membership)
    assert bob in left.inactive_subjects and bob not in left.active_subjects

    # The person's identity is erased; the pseudonymous subject stays listed.
    apps.get_model("identity", "Identity").objects.filter(subject=bob).update(
        deleted_at=timezone.now(), purge_after=timezone.now() + timedelta(days=1)
    )
    later = emit(org)
    assert bob in later.inactive_subjects
    assert later.revision > left.revision


def test_a_suspended_member_who_returns_is_released_not_inactive(org):
    membership, carol = person(org)
    suspended = leave(org, membership, state="suspended")
    assert carol in suspended.inactive_subjects

    with transaction.atomic():
        org.models.Membership.objects.filter(pk=membership.pk).update(state="active")
        resumed = services.emit_member_set(
            organisation_id=org.organisation.pk, reason="member_resumed"
        )

    assert carol in resumed.active_subjects and carol in resumed.released_subjects
    assert carol not in resumed.inactive_subjects


# --- fan-out and the command loop -----------------------------------------------------------


def test_each_active_credential_gets_one_command_and_a_newer_set_supersedes_the_older(org):
    first, _ = credential(org)
    second, _ = credential(org)
    revoked, _ = credential(org)
    services.revoke_credential(credential_id=revoked.id)
    person(org)

    one = emit(org)
    two = emit(org)

    for agent in (first, second):
        commands = EngineCommand.objects.filter(credential_id=agent.id).order_by("issued_at")
        assert [(c.member_set_id, c.state) for c in commands] == [
            (one.id, "superseded"),
            (two.id, "pending"),
        ]
    assert not EngineCommand.objects.filter(credential_id=revoked.id).exists()


def test_pull_delivers_the_set_once_until_the_visibility_timeout(org):
    agent, _ = credential(org)
    _, alice = person(org)
    member_set = emit(org)

    pulled = services.pull(agent, kinds=None, limit=5).commands
    assert len(pulled) == 1
    assert pulled[0]["kind"] == "engine_set_member_subjects"
    assert pulled[0]["payload"] == {
        "revision": member_set.revision,
        "active_subjects": member_set.active_subjects,
        "inactive_subjects": [],
        "released_subjects": [],
        "erased_subjects": [],
    }
    assert alice in pulled[0]["payload"]["active_subjects"]
    assert services.pull(agent, kinds=None, limit=5).commands == []

    with time_machine.travel(timezone.now() + timedelta(seconds=services.VISIBILITY_TIMEOUT_S + 1)):
        again = services.pull(agent, kinds=None, limit=5).commands
    assert [c["command_id"] for c in again] == [pulled[0]["command_id"]]


def test_an_agent_that_does_not_implement_the_kind_is_given_nothing(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    assert services.pull(agent, kinds=("upgrade",), limit=5).commands == []


def test_a_credential_issued_after_the_set_still_receives_it(org):
    person(org)
    member_set = emit(org)
    late, _ = credential(org)

    pulled = services.pull(late, kinds=None, limit=5).commands

    assert [c["payload"]["revision"] for c in pulled] == [member_set.revision]


def test_ack_and_result_are_held_to_the_credential_s_own_commands(org):
    agent, _ = credential(org)
    stranger, _ = credential(org, organisation=org.other)
    person(org)
    emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]

    with pytest.raises(services.CommandNotFoundError):
        services.acknowledge(stranger, command_id, boot_id=None)
    assert services.acknowledge(agent, command_id, boot_id="b1")["status"] == "accepted"
    assert services.report(
        agent, command_id, {"status": "succeeded", "artefacts": {"users_deactivated": 0}}
    ) == (True, "succeeded")
    assert services.report(agent, command_id, {"status": "succeeded"}) == (False, "succeeded")
    with pytest.raises(services.CommandConflictError):
        services.report(agent, command_id, {"status": "failed", "error_code": "internal_error"})
    with pytest.raises(services.CommandConflictError):
        services.acknowledge(agent, command_id, boot_id=None)


@pytest.mark.parametrize(
    "body",
    [
        {"status": "done"},
        {"status": "failed"},
        {"status": "failed", "error_code": "not_a_code"},
        {"status": "succeeded", "error_code": "internal_error"},
        {"status": "succeeded", "artefacts": {"rogue": 1}},
        {"status": "succeeded", "artefacts": {"users_deactivated": -1}},
        {"status": "succeeded", "artefacts": {"users_deactivated": True}},
        {"status": "succeeded", "artefacts": {"revision_applied": 0}},
    ],
)
def test_a_result_that_contradicts_the_contract_is_refused(org, body):
    agent, _ = credential(org)
    person(org)
    emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    with pytest.raises(services.InvalidResultError):
        services.report(agent, command_id, body)


def test_a_transient_failure_is_reissued_with_backoff_and_a_permanent_one_is_not(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    first = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(agent, first, {"status": "failed", "error_code": "service_unhealthy"})

    retry = EngineCommand.objects.get(credential_id=agent.id, state="pending")
    assert retry.attempt == 2 and retry.not_before > timezone.now()
    assert services.pull(agent, kinds=None, limit=5).commands == []  # not before the backoff

    with time_machine.travel(retry.not_before + timedelta(seconds=1)):
        second = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(agent, second, {"status": "failed", "error_code": "invalid_payload"})
    assert not EngineCommand.objects.filter(credential_id=agent.id, state="pending").exists()


def test_an_agent_is_sent_the_latest_set_again_a_day_after_applying_it(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(agent, command_id, {"status": "succeeded"})
    assert services.pull(agent, kinds=None, limit=5).commands == []

    with time_machine.travel(timezone.now() + services.REFRESH_AFTER + timedelta(minutes=1)):
        again = services.pull(agent, kinds=None, limit=5).commands

    assert len(again) == 1 and again[0]["command_id"] != command_id and again[0]["attempt"] == 2


def test_an_agent_behind_the_latest_set_for_an_hour_is_reported_whatever_its_retries(org):
    agent, _ = credential(org)
    person(org)
    member_set = emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(agent, command_id, {"status": "failed", "error_code": "service_unhealthy"})
    assert services.lagging() == []  # within the hour

    with time_machine.travel(timezone.now() + timedelta(hours=1, minutes=1)):
        late = services.lagging()
    assert [(lag.credential_id, lag.head_revision, lag.applied_revision) for lag in late] == [
        (agent.id, member_set.revision, None)
    ]


def test_a_set_that_failed_beyond_retry_is_sent_again_a_day_later(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(agent, command_id, {"status": "failed", "error_code": "invalid_payload"})
    assert services.pull(agent, kinds=None, limit=5).commands == []

    with time_machine.travel(timezone.now() + services.REFRESH_AFTER + timedelta(minutes=1)):
        again = services.pull(agent, kinds=None, limit=5).commands

    assert len(again) == 1 and again[0]["command_id"] != command_id


def test_a_leaver_whose_identity_was_disabled_still_resolves_from_an_earlier_set(org):
    membership, bob = person(org)
    emit(org)  # bob is listed, so his subject is recorded
    apps.get_model("identity", "Identity").objects.filter(user_id=membership.user_id).update(
        enabled=False
    )

    left = leave(org, membership)

    assert bob in left.inactive_subjects


def test_a_recorded_subject_whose_identity_is_disabled_is_never_active(org):
    alice_membership, alice = person(org)
    carol_membership, carol = person(org)
    emit(org)  # both are listed active, so both subjects are recorded
    # Carol is suspended and her identity disabled before any set lists her inactive.
    org.models.Membership.objects.filter(pk=carol_membership.pk).update(state="suspended")
    apps.get_model("identity", "Identity").objects.filter(
        user_id__in=[alice_membership.user_id, carol_membership.user_id]
    ).update(enabled=False)

    later = emit(org)

    assert alice not in later.active_subjects + later.released_subjects
    assert alice in later.inactive_subjects
    assert carol in later.inactive_subjects


def test_a_leaver_whose_identity_was_disabled_before_any_set_is_still_listed(org):
    membership, bob = person(org)
    # No set ever listed bob; his identity row is disabled, then soft-deleted, but keeps his subject.
    apps.get_model("identity", "Identity").objects.filter(user_id=membership.user_id).update(
        enabled=False, deleted_at=timezone.now(), purge_after=timezone.now() + timedelta(days=1)
    )

    left = leave(org, membership)

    assert bob in left.inactive_subjects and left.unnamed_leavers == 0
    issued = apps.get_model("audit", "AuditEvent").objects.get(
        action="engine_member_set.issued", target_urn__endswith=str(left.id)
    )
    assert "unnamed_leavers" not in issued.metadata


def test_a_leaver_the_set_cannot_name_does_not_block_the_leave_and_is_counted(org, caplog):
    # No identity row in the realm at all, and no set recorded a subject: nothing names them.
    membership, _ = person(org, subject=NO_IDENTITY)
    with caplog.at_level("ERROR", logger="apps.engine_intents.services"):
        left = leave(org, membership)
    assert org.models.Membership.objects.get(pk=membership.pk).state == "removed"
    issued = apps.get_model("audit", "AuditEvent").objects.get(
        action="engine_member_set.issued", target_urn__endswith=str(left.id)
    )
    assert issued.metadata["unnamed_leavers"] == 1 and left.unnamed_leavers == 1
    assert "1 leaver(s) with no realm subject" in caplog.text


def test_an_unnamed_leaver_does_not_drop_another_leaver_s_subject(org):
    first, first_subject = person(org)
    second, _ = person(org, subject=NO_IDENTITY)
    with transaction.atomic():
        org.models.Membership.objects.filter(pk__in=[first.pk, second.pk]).update(state="removed")
        member_set = services.emit_member_set(
            organisation_id=org.organisation.pk,
            reason="test",
            left_user_ids=(first.user_id, second.user_id),
        )
    assert first_subject in member_set.inactive_subjects and member_set.unnamed_leavers == 1


def test_a_member_removed_before_any_set_is_listed_by_the_first_one(org):
    # Removed and suspended while no set was recorded (before the hooks were wired).
    removed, bob = person(org, state="removed")
    suspended, carol = person(org, state="suspended")
    _, alice = person(org)

    first = emit(org)

    assert {bob, carol} <= set(first.inactive_subjects)
    assert first.active_subjects == [alice]


def refused_row():
    return apps.get_model("audit", "AuditEvent").objects.get(action="engine_member_set.refused")


def test_a_leaver_whose_identity_row_was_purged_stays_listed(org):
    membership, bob = person(org)
    left = leave(org, membership)
    assert bob in left.inactive_subjects
    # The purge of the person: the identity row itself is deleted, which only erasure may do.
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE identity_identity DISABLE TRIGGER customer_identity_delete")
        try:
            cursor.execute("DELETE FROM identity_identity WHERE user_id = %s", [membership.user_id])
        finally:
            cursor.execute("ALTER TABLE identity_identity ENABLE TRIGGER customer_identity_delete")
    assert not apps.get_model("identity", "Identity").objects.filter(subject=bob).exists()

    later = emit(org)

    assert bob in later.inactive_subjects and later.revision > left.revision
    # A purge is retention running out, not an erasure: nothing is erased without the mark.
    assert later.erased_subjects == []


def test_an_erased_person_s_subject_is_listed_erased_and_delivered(org):
    agent, _ = credential(org)
    membership, bob = person(org)
    _, alice = person(org)
    leave(org, membership)
    now = timezone.now()
    org.models.User.objects.filter(pk=membership.user_id).update(
        deleted_at=now, purge_after=now + timedelta(days=30)
    )
    # A soft-deleted person is kept for retention: not erased.
    assert emit(org).erased_subjects == []
    with transaction.atomic():
        assert (
            services.mark_erased(organisation_id=org.organisation.pk, user_id=membership.user_id)
            == 1
        )

    erased = emit(org)

    assert erased.erased_subjects == [bob] and bob in erased.inactive_subjects
    assert alice not in erased.erased_subjects
    issued = apps.get_model("audit", "AuditEvent").objects.get(
        action="engine_member_set.issued", target_urn__endswith=str(erased.id)
    )
    assert issued.metadata["erased"] == 1
    [command] = services.pull(agent, kinds=("engine_set_member_subjects",), limit=5).commands
    assert command["payload"]["erased_subjects"] == [bob]
    services.report(
        agent,
        command["command_id"],
        {
            "status": "succeeded",
            "artefacts": {"revision_applied": erased.revision, "users_erased": 1},
        },
    )


def test_emission_holds_the_organisation_s_agent_credentials_until_it_commits(org):
    agent, _ = credential(org)
    person(org)
    with transaction.atomic():
        services.emit_member_set(organisation_id=org.organisation.pk, reason="test")
        # A pull locks its credential before its commands: it waits for this emission.
        assert locked("engine_intents_credential", "id", agent.id)
    assert not locked("engine_intents_credential", "id", agent.id)


def test_a_retry_holds_the_head_until_it_commits(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    [command] = services.pull(agent, kinds=None, limit=5).commands
    with transaction.atomic():
        services.report(agent, command["command_id"], {"status": "failed", "error_code": "timeout"})
        # An emission superseding commands meanwhile waits, so no retry outlives its set.
        assert locked("engine_intents_head", "organisation_id", org.organisation.pk)
    assert EngineCommand.objects.filter(state="pending").count() == 1


def test_a_subject_outside_the_contract_s_shape_is_never_recorded(org):
    membership, _ = person(org)
    known = apps.get_model("engine_intents", "EngineKnownSubject")
    with pytest.raises(IntegrityError, match="engine_known_subject_valid"):
        with transaction.atomic():
            known.objects.create(
                organisation=org.organisation, user_id=membership.user_id, subject="has a space"
            )
    known.objects.create(
        organisation=org.organisation, user_id=membership.user_id, subject="a-uuid-like-subject"
    )


def test_an_active_subject_outside_the_contract_s_shape_is_left_out_and_counted(
    org, monkeypatch, caplog
):
    legacy_person(org, monkeypatch)
    odd = LEGACY_SUBJECT
    _, alice = person(org)

    with caplog.at_level("CRITICAL", logger="apps.engine_intents.services"):
        member_set = emit(org)

    # Leaving them out grants less: the set is recorded.
    assert member_set.active_subjects == [alice] and member_set.malformed_subjects == 1
    assert odd not in member_set.inactive_subjects + member_set.released_subjects
    issued = apps.get_model("audit", "AuditEvent").objects.get(
        action="engine_member_set.issued", target_urn__endswith=str(member_set.id)
    )
    assert issued.metadata["malformed_subjects"] == 1
    assert "1 subject(s) outside the contract's shape left out" in caplog.text


def test_a_leaver_whose_subject_is_outside_the_contract_s_shape_fails_closed(
    org, monkeypatch, caplog
):
    membership = legacy_person(org, monkeypatch)
    person(org)

    with caplog.at_level("CRITICAL", logger="apps.engine_intents.services"):
        with pytest.raises(services.MemberSetRefusedError) as refused:
            leave(org, membership)

    # Never dropped from the deny list: the leave itself rolls back.
    assert org.models.Membership.objects.get(pk=membership.pk).state == "active"
    assert EngineMemberSet.objects.count() == 0
    assert "refused: a leaver's subject is outside the contract's shape" in caplog.text
    services.record_member_set_refusal(refused.value)
    row = refused_row()
    assert row.target_urn == f"urn:kodera:organisation:{org.organisation.slug}"
    assert row.actor_type == "system"
    assert row.metadata == {
        "reason": "member_left",
        "problem": "malformed_subjects",
        "malformed_subjects": 1,
    }
    assert [a.problem for a in services.anomalies()] == ["last set refused: malformed_subjects"]


def test_a_legacy_subject_outside_the_shape_is_quarantined_and_blocks_no_other_change(
    org, monkeypatch
):
    legacy_person(org, monkeypatch, state="removed")  # left long ago, never sent
    membership, bob = person(org)

    left = leave(org, membership)

    assert org.models.Membership.objects.get(pk=membership.pk).state == "removed"
    assert left.inactive_subjects == [bob] and left.malformed_subjects == 1
    assert [a.problem for a in services.anomalies()] == [
        "1 subject(s) outside the contract's shape left out"
    ]


def test_a_set_past_the_bound_fails_closed_when_an_agent_would_receive_it(org, monkeypatch, caplog):
    agent, _ = credential(org)
    person(org)
    membership, _ = person(org)
    monkeypatch.setattr(services, "MAX_SUBJECTS", 1)

    with caplog.at_level("CRITICAL", logger="apps.engine_intents.services"):
        with pytest.raises(services.MemberSetRefusedError) as refused:
            leave(org, membership)

    assert org.models.Membership.objects.get(pk=membership.pk).state == "active"
    assert EngineMemberSet.objects.count() == 0 and EngineCommand.objects.count() == 0
    assert "refused: 2 subjects exceed 1" in caplog.text
    services.record_member_set_refusal(refused.value)
    assert refused_row().metadata == {
        "reason": "member_left",
        "problem": "over_bound",
        "subjects": 2,
        "bound": 1,
    }
    assert services.pull(agent, kinds=None, limit=5).commands == []
    assert [a.problem for a in services.anomalies()] == ["last set refused: over_bound"]
    # The next set that is recorded clears the refusal.
    monkeypatch.setattr(services, "MAX_SUBJECTS", 10)
    emit(org)
    assert services.anomalies() == []


def test_a_set_past_the_bound_is_recorded_while_no_agent_would_receive_it(org, monkeypatch):
    person(org)
    membership, gone = person(org)
    monkeypatch.setattr(services, "MAX_SUBJECTS", 1)
    monkeypatch.setattr(services, "WARN_SUBJECTS", 1)

    left = leave(org, membership)

    assert org.models.Membership.objects.get(pk=membership.pk).state == "removed"
    assert gone in left.inactive_subjects
    assert [a.problem for a in services.anomalies()] == ["2 of 1 subjects"]


def test_the_lag_alert_reports_what_a_set_could_not_carry(org, monkeypatch):
    out = io.StringIO()
    person(org)
    emit(org)
    call_command("engine_member_sets_lag", stdout=out)  # nothing to report

    nameless, _ = person(org, subject=NO_IDENTITY)
    left = leave(org, nameless)
    legacy_person(org, monkeypatch)
    monkeypatch.setattr(services, "WARN_SUBJECTS", 1)
    latest = emit(org)

    problems = [(a.revision, a.problem) for a in services.anomalies()]
    assert problems == [
        (left.revision, "1 leaver(s) with no realm subject"),
        (latest.revision, "1 subject(s) outside the contract's shape left out"),
        (latest.revision, "1 of 10000 subjects"),
    ]
    with pytest.raises(CommandError, match="3 member-set problem"):
        call_command("engine_member_sets_lag", stdout=out)
    with time_machine.travel(timezone.now() + timedelta(days=2)):
        # An unnamed leaver is reported for a day; the latest set's problems until they are gone.
        assert [a.problem for a in services.anomalies()] == [
            "1 subject(s) outside the contract's shape left out",
            "1 of 10000 subjects",
        ]


def test_released_subjects_are_kept_until_every_agent_applied_the_set_that_listed_them(org):
    agent, _ = credential(org)
    membership, carol = person(org)
    leave(org, membership, state="suspended")
    with transaction.atomic():
        org.models.Membership.objects.filter(pk=membership.pk).update(state="active")
        resumed = services.emit_member_set(
            organisation_id=org.organisation.pk, reason="member_resumed"
        )
    assert carol in resumed.released_subjects
    # Not yet applied by the agent: the next set still releases carol.
    assert carol in emit(org).released_subjects

    for command in services.pull(agent, kinds=None, limit=5).commands:
        services.report(agent, command["command_id"], {"status": "succeeded"})
    after = emit(org)

    assert carol not in after.released_subjects and carol in after.active_subjects


def test_a_result_for_a_command_never_pulled_is_refused(org):
    agent, _ = credential(org)
    person(org)
    emit(org)
    pending = EngineCommand.objects.get(credential_id=agent.id, state="pending")
    with pytest.raises(services.CommandConflictError):
        services.report(agent, pending.id, {"status": "succeeded"})
    with pytest.raises(services.CommandConflictError):
        services.acknowledge(agent, pending.id, boot_id=None)


def test_a_token_is_refused_after_revocation_or_with_a_wrong_secret(org):
    agent, token = credential(org)
    assert services.authenticate(token[:-1] + ("A" if token[-1] != "A" else "B")) is None
    # A malformed id is refused before any lookup, never raised as an error.
    assert services.authenticate("eac1_" + "-" * 36 + "_" + "A" * 43) is None
    assert services.authenticate(token.replace("-", "0", 1)) is None
    services.revoke_credential(credential_id=agent.id)
    assert services.authenticate(token) is None
    assert EngineMemberSet.objects.count() == 0


# --- HTTP -----------------------------------------------------------------------------------


def test_the_agent_api_routes_serve_the_loop_and_refuse_without_a_credential(org):
    _, token = credential(org)
    person(org)
    emit(org)
    client = Client()
    auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    assert client.get("/agent/v1/commands").status_code == 401
    assert client.get("/agent/v1/commands", HTTP_AUTHORIZATION="Bearer eac1_x").status_code == 401
    assert client.get("/agent/v1/commands?max=99", **auth).status_code == 400
    assert client.get("/agent/v1/commands?kinds=nonsense", **auth).status_code == 400
    assert client.post("/agent/v1/commands", **auth).status_code == 405

    answer = client.get("/agent/v1/commands?kinds=engine_set_member_subjects&wait_s=0", **auth)
    assert answer.status_code == 200 and answer["Content-Type"] == "application/json"
    command_id = answer.json()["commands"][0]["command_id"]

    ack = client.post(
        f"/agent/v1/commands/{command_id}/ack",
        json.dumps({"accepted_at": "2026-01-01T00:00:00Z"}),
        content_type="application/json",
        **auth,
    )
    assert ack.status_code == 200 and ack.json()["status"] == "accepted"
    body = {
        "command_id": command_id,
        "status": "succeeded",
        "reported_at": "2026-01-01T00:00:01Z",
        "artefacts": {"revision_applied": 1},
    }
    done = client.post(
        f"/agent/v1/commands/{command_id}/result",
        json.dumps(body),
        content_type="application/json",
        **auth,
    )
    assert done.status_code == 200 and done.json() == {
        "command_id": command_id,
        "recorded": True,
        "status": "succeeded",
    }
    wrong_id = client.post(
        f"/agent/v1/commands/{command_id}/result",
        json.dumps({**body, "command_id": "x"}),
        content_type="application/json",
        **auth,
    )
    assert wrong_id.status_code == 400
    assert (
        client.post(
            f"/agent/v1/commands/{command_id}/ack",
            json.dumps({"accepted_at": "x"}),
            content_type="application/json",
            **auth,
        ).status_code
        == 409
    )


def test_every_set_and_every_terminal_result_writes_an_audit_event_without_subjects(org):
    agent, _ = credential(org)
    _, alice = person(org)
    member_set = emit(org)
    command_id = services.pull(agent, kinds=None, limit=5).commands[0]["command_id"]
    services.report(
        agent, command_id, {"status": "succeeded", "artefacts": {"users_deactivated": 0}}
    )

    events = (
        apps.get_model("audit", "AuditEvent")
        .objects.filter(target_urn=f"urn:kodera:member_set:{member_set.id}")
        .order_by("occurred_at")
    )
    assert [(e.action, e.actor_type) for e in events] == [
        ("engine_member_set.issued", "system"),
        ("engine_member_set.applied", "agent"),
    ]
    assert events[1].actor_id == agent.id and events[1].metadata["revision"] == member_set.revision
    assert alice not in json.dumps([e.metadata for e in events])


@pytest.mark.parametrize("value", [None, "2020-01-01T00:00:00Z"])
def test_an_erasure_mark_is_final(org, value):
    """No role clears or moves an erasure mark, not even the schema owner (migration 0009)."""
    membership, _ = person(org)
    leave(org, membership)
    with transaction.atomic():
        services.mark_erased(organisation_id=org.organisation.pk, user_id=membership.user_id)
    known = apps.get_model("engine_intents", "EngineKnownSubject").objects.filter(
        user_id=membership.user_id
    )
    marked = known.get().erased_at
    with pytest.raises(IntegrityError, match="erasure is final"):
        with transaction.atomic():
            known.update(erased_at=value)
    assert known.get().erased_at == marked


def test_known_subject_update_refuses_null_erased_at_and_identity_mutation(org):
    """Migration 0010 refuses an UPDATE that leaves `erased_at` NULL or mutates the recorded
    subject's identity columns, even before `erased_at` is set."""
    membership, subject = person(org)
    leave(org, membership)
    known = apps.get_model("engine_intents", "EngineKnownSubject").objects.filter(
        user_id=membership.user_id
    )
    assert known.get().erased_at is None
    with pytest.raises(IntegrityError, match="must set erased_at"):
        with transaction.atomic():
            known.update(erased_at=None)
    with pytest.raises(IntegrityError, match="identity is immutable"):
        with transaction.atomic():
            known.update(subject=f"{subject}-mutated", erased_at=timezone.now())
    assert known.get().subject == subject and known.get().erased_at is None


def test_explicit_gdpr_erasure_marks_subjects_erased_while_retention_does_not(org):
    """Explicit GDPR erasure (`membership_lifecycle.erase_member` -> `member_set_hooks.member_erased`)
    marks the person's subjects erased and emits `erased_subjects`, while retention never does."""
    from apps.orgs import membership_lifecycle

    owner_membership = org.models.Membership.objects.get(
        organisation=org.organisation, role="org_owner"
    )
    retained_membership, retained_subject = person(org)
    erased_membership, erased_subject = person(org)
    leave(org, retained_membership)
    now = timezone.now()
    org.models.User.objects.filter(pk=retained_membership.user_id).update(
        deleted_at=now, purge_after=now + timedelta(days=30)
    )
    assert emit(org).erased_subjects == []

    with pytest.raises(membership_lifecycle.LastOwnerError):
        membership_lifecycle.erase_member(
            organisation_id=org.organisation.pk, membership_id=owner_membership.pk
        )

    membership_lifecycle.erase_member(
        organisation_id=org.organisation.pk, membership_id=erased_membership.pk
    )

    latest_set = (
        apps.get_model("engine_intents", "EngineMemberSet")
        .objects.filter(organisation_id=org.organisation.pk)
        .order_by("-revision")
        .first()
    )
    assert latest_set is not None
    assert latest_set.reason == "member_erased"
    assert latest_set.erased_subjects == [erased_subject]
    assert retained_subject in latest_set.inactive_subjects
    assert retained_subject not in latest_set.erased_subjects
    assert org.models.Membership.objects.get(pk=erased_membership.pk).state == "removed"
