"""The API writer role's membership grants are enough, and no more: MEMBERSHIP_LIFECYCLE.md §7.

A role holding exactly `dev/api_writer_role.py`'s grants serves the three membership operations
through the real view, records a refusal, and records the organisation's next member set when a
member is suspended, reactivated or removed, with a command for each active agent credential
(ADR-0016). It is then refused, by privilege, every other write on the membership table
and every change to the audit rows the operations wrote.
"""

import uuid

import pytest
from django.db import connection
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused
from test_membership_lifecycle import audit, delete, get, m as m, patch, problem, stored
from test_workspace_onboarding import http_signer as http_signer, model

from apps.engine_intents import services as engine_services
from apps.engine_intents.services import issue_credential
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer(m):
    role = f"membership_writer_{uuid.uuid4().hex[:12]}"
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


def test_the_writer_role_serves_the_membership_operations(m, writer):
    with acting_as(writer):
        assert current_user() == writer
        assert get(m, m.owner, m.member.member).status_code == 200
        assert patch(m, m.owner, m.member.member, {"role": "org_admin"}).status_code == 200
        assert patch(m, m.owner, m.member.member, {"state": "suspended"}).status_code == 200
        assert delete(m, m.owner, m.member.member).status_code == 200
        problem(patch(m, m.admin, m.owner.member, {"role": "org_admin"}), 403, "forbidden")
    assert stored(m.member.member).state == "removed"
    # Suspension records the member set; removing a suspended member does not change it
    # (MEMBERSHIP_LIFECYCLE.md §6).
    assert [row["action"] for row in audit()] == [
        "membership.role_changed",
        "membership.suspended",
        "engine_member_set.issued",
        "membership.removed",
        "authz.denied",
    ]
    [member_set] = model("engine_intents", "EngineMemberSet").objects.all()
    assert "alpha-member" in member_set.inactive_subjects
    assert "alpha-owner" in member_set.active_subjects
    # The suspension and the removal each enqueued their realm access delivery as the role
    # (MEMBERSHIP_LIFECYCLE.md §§6.1, 7).
    [suspended, removed] = model("outbox", "OutboxRealmAccess").objects.order_by("delivery_id")
    assert (suspended.operation, removed.operation) == ("access_off", "access_off")
    assert suspended.realm_user_id == "alpha-member"


def test_the_writer_role_records_each_member_set_and_its_commands_through_the_views(m, writer):
    # The real hooks, nothing monkeypatched: suspend, reactivate, then remove an active member.
    issue_credential(organisation_id=m.alpha.id)
    with acting_as(writer):
        assert patch(m, m.owner, m.member.member, {"state": "suspended"}).status_code == 200
        assert patch(m, m.owner, m.member.member, {"state": "active"}).status_code == 200
        assert delete(m, m.owner, m.member.member).status_code == 200
    assert stored(m.member.member).state == "removed"

    sets = list(model("engine_intents", "EngineMemberSet").objects.order_by("revision"))
    assert [s.reason for s in sets] == ["member_suspended", "member_reactivated", "member_removed"]
    suspended, reactivated, removed = sets
    assert "alpha-member" in suspended.inactive_subjects
    assert "alpha-member" not in suspended.active_subjects
    assert "alpha-member" in reactivated.active_subjects
    assert "alpha-member" in reactivated.released_subjects
    assert "alpha-member" not in reactivated.inactive_subjects
    assert "alpha-member" in removed.inactive_subjects
    assert "alpha-member" not in removed.active_subjects + removed.released_subjects
    assert all("alpha-owner" in s.active_subjects for s in sets)
    commands = model("engine_intents", "EngineCommand").objects.order_by("issued_at")
    assert [(c.member_set_id, c.state) for c in commands] == [
        (suspended.id, "superseded"),
        (reactivated.id, "superseded"),
        (removed.id, "pending"),
    ]
    assert [row["action"] for row in audit("engine_member_set.issued")] == [
        "engine_member_set.issued"
    ] * 3


def test_a_refused_member_set_rolls_the_change_back_and_is_recorded_as_the_role(
    m, writer, monkeypatch
):
    issue_credential(organisation_id=m.alpha.id)  # an agent would receive the set
    monkeypatch.setattr(engine_services, "MAX_SUBJECTS", 1)
    with acting_as(writer):
        problem(patch(m, m.owner, m.member.member, {"state": "suspended"}), 500, "internal-error")
        problem(delete(m, m.owner, m.member.member), 500, "internal-error")
    # Failing closed: the member is not suspended or removed while the engines cannot be told.
    assert stored(m.member.member).state == "active"
    assert model("engine_intents", "EngineMemberSet").objects.count() == 0
    refused = audit("engine_member_set.refused")
    assert [row["metadata"]["problem"] for row in refused] == ["over_bound", "over_bound"]
    assert [row["metadata"]["reason"] for row in refused] == ["member_suspended", "member_removed"]
    assert audit("membership.suspended") == [] and audit("membership.removed") == []
    head = model("engine_intents", "EngineMemberSetHead").objects.get(organisation_id=m.alpha.id)
    assert head.refused_problem == "over_bound" and head.revision == 0


@pytest.mark.parametrize(
    "statement",
    [
        # An accepted invitation inserts a membership and stamps a revived one's `accepted_at`
        # (INVITATIONS.md section 7); nothing else of the row's keys is the API's to rewrite.
        "UPDATE orgs_membership SET user_id = gen_random_uuid()",
        "UPDATE orgs_membership SET organisation_id = gen_random_uuid()",
        "DELETE FROM orgs_membership",
        "TRUNCATE orgs_membership CASCADE",
        # An invitation's token, address, role and lifetime are written once.
        "UPDATE orgs_invitation SET token_digest = '\\x00'::bytea",
        "UPDATE orgs_invitation SET email = 'someone@else.test'",
        "UPDATE orgs_invitation SET role = 'org_admin'",
        "UPDATE orgs_invitation SET expires_at = now() + interval '30 days'",
        "DELETE FROM orgs_invitation",
        "UPDATE outbox_realmaccount SET realm_user_id = 'someone-else'",
        "DELETE FROM outbox_realmaccount",
        "UPDATE orgs_membership SET deleted_at = now(), purge_after = now() + interval '1 day'",
        "UPDATE orgs_organisation SET state = 'closed'",
        "UPDATE identity_user SET email = 'someone@else.test'",
        "UPDATE audit_auditevent SET action = 'job.failed' WHERE action LIKE 'membership.%'",
        "DELETE FROM audit_auditevent WHERE action LIKE 'membership.%'",
        # The realm access delivery: enqueue only, never read, change or delete one.
        "SELECT count(*) FROM outbox_outboxdelivery",
        "UPDATE outbox_outboxdelivery SET status = 'failed'",
        "DELETE FROM outbox_realmaccess",
        "UPDATE outbox_realmaccess SET operation = 'access_on'",
        "INSERT INTO outbox_deliveryattempt (id, delivery_id, seq, message_id) "
        "VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'x')",
    ],
)
def test_the_writer_role_is_refused_every_other_membership_write(m, writer, statement):
    with acting_as(writer):
        assert patch(m, m.owner, m.member.member, {"role": "org_admin"}).status_code == 200
        assert refused(statement) == INSUFFICIENT_PRIVILEGE, statement
    # Control: the schema owner is not refused by privilege, so the refusal above is the role's.
    assert refused(statement) != INSUFFICIENT_PRIVILEGE, statement
