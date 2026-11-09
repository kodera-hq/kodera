"""The API writer role's workspace grants are enough, and no more: PILOT_WORKSPACE_ONBOARDING.md §9.

A role holding exactly `dev/api_writer_role.py`'s grants, the intake's included
(tests/test_intake_writer_role.py proves those), serves both workspace operations through the real
views: it initialises, replays, answers 200 to another key, reads the structure, and records a
403 as `authz.denied`. It administers the structure and a channel's access
(docs/specs/ESPACE_STRUCTURE.md). It is then refused, by privilege, a listed set of other writes on
the workspace tables, and every change to the audit row the step wrote.
"""

import uuid

import pytest
from django.db import connection
from order_fixtures import commit_order
from test_accepted_agreements import accept_unbilled
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused
from test_workspace_onboarding import (
    OTHER_KEY,
    expected_view,
    http_signer as http_signer,
    initialise,
    model,
    problem,
    read,
    w as w,
)

from dev.api_writer_role import grant_statements


@pytest.fixture
def writer(w):
    # The order the workspace needs is placed by the test database's owner, not the writer role.
    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    yield from _role()


@pytest.fixture
def unbilled_writer(w):
    # Billing off: the CGV and the DPA accepted for a tenant, with no order, by the database's owner.
    accept_unbilled(w)
    yield from _role()


def _role():
    role = f"workspace_writer_{uuid.uuid4().hex[:12]}"
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


@pytest.fixture
def bare_writer(w):
    # Nothing accepted and no order: the guard reads both branches and answers no.
    yield from _role()


def test_the_writer_role_creates_a_tenant_with_billing_off(w, bare_writer):
    # createTenant (QUICK_WORKSPACE.md §4, case 7): the tenant, its DPA, the acceptances and the
    # starter workspace, then the replay and the refusal of a second tenant, all under the role.
    # The catalogue and the documents are loaded by the database's owner.
    from datetime import timedelta

    from order_fixtures import owner_token
    from test_create_tenant import CGV, DPA, OTHER_KEY as SECOND_KEY, create, offer
    from test_workspace_onboarding import confirm_owner, realm_job

    from apps.legal import services as legal

    w.settings.KODERA_BILLING_ENABLED = False
    offer()
    realm_job(w.bravo, "succeeded")
    confirm_owner(w.bravo)
    # A DPA the wizard left, from a template since replaced: the role supersedes it.
    older, _ = legal.generate_dpa(
        verified=owner_token(w.alpha.issuer, "alpha-owner"),
        organisation_id=w.alpha.id,
        pack_code="workspace",
        locale="fr",
        tenant_id=None,
    )
    template = model("legal", "LegalDocument").objects.get(id=older.template_id)
    text = "Synthetic DPA, version 0.1."
    model("legal", "LegalDocument").objects.create(
        code="dpa",
        version="0.1",
        locale="fr",
        title=template.title,
        sha256=legal.text_digest(text),
        text=text,
        sub_processors=template.sub_processors,
        published_at=template.published_at + timedelta(seconds=1),
    )
    newer = [CGV, {**DPA, "version": "0.1"}]
    with acting_as(bare_writer):
        assert current_user() == bare_writer
        created = create(w, w.owner, legal_acceptances=newer)
        assert created.status_code == 201, created.content
        again = create(w, w.owner, legal_acceptances=newer)
        assert (again.status_code, again.content) == (201, created.content)
        refused = create(w, w.owner, key=SECOND_KEY, slug="alpha-other")
        assert refused.status_code == 409, refused.content
        assert refused.json()["type"].endswith("/tenant-exists")
        taken = create(w, w.foreigner, organisation=w.bravo, slug="alpha-team")
        assert taken.status_code == 409, taken.content
        assert taken.json()["type"].endswith("/slug-taken")
        assert taken.json()["suggestions"] == ["alpha-team-2", "alpha-team-3", "alpha-team-4"]
    assert model("legal", "Acceptance").objects.filter(organisation_id=w.alpha.id).count() == 2
    states = dict(
        model("legal", "Dpa").objects.filter(organisation_id=w.alpha.id).values_list("id", "state")
    )
    assert states.pop(older.id) == "superseded" and list(states.values()) == ["accepted"]


def test_the_writer_role_reads_that_nothing_was_accepted(w, bare_writer):
    with acting_as(bare_writer):
        before = read(w, w.owner)
        assert before.status_code == 200 and before.json()["can_initialise"] is False
        refused = initialise(w, w.owner)
        assert refused.status_code == 409, refused.content
        assert refused.json()["allowed_states"] == ["ordered"]


def test_the_writer_role_reads_agreements_accepted_without_an_order(w, unbilled_writer):
    # With no order, the guard reads the acceptances and the tenants (QUICK_WORKSPACE.md §3).
    with acting_as(unbilled_writer):
        assert current_user() == unbilled_writer
        before = read(w, w.owner)
        assert before.status_code == 200 and before.json()["can_initialise"] is True
        created = initialise(w, w.owner)
        assert created.status_code == 201, created.content


def test_the_writer_role_serves_both_workspace_operations(w, writer):
    with acting_as(writer):
        assert current_user() == writer
        before = read(w, w.owner)
        assert before.status_code == 200 and before.json()["can_initialise"] is True
        created = initialise(w, w.owner)
        assert created.status_code == 201, created.content
        replayed = initialise(w, w.owner)
        assert replayed.headers.get("Idempotency-Replayed") == "true"
        assert initialise(w, w.admin, key=OTHER_KEY).status_code == 200
        problem(initialise(w, w.billing, key=OTHER_KEY), 403, "forbidden")
        problem(read(w, w.staff), 403, "forbidden")
        after = read(w, w.member)
        assert after.status_code == 200, after.content
    assert after.json() == expected_view(w), "the writer role read a different structure"
    assert model("workspaces", "Workspace").objects.count() == 1
    assert model("audit", "AuditEvent").objects.filter(action="authz.denied").count() == 2


def test_the_writer_role_administers_the_structure_and_a_channels_access(w, writer):
    from test_espace_structure import (
        ACCESS,
        ADMINISTRATION,
        ARCHIVE,
        CATEGORY,
        UNARCHIVE,
        access_of,
        create_category,
        create_channel,
        membership,
        patch_channel,
        rows,
        send,
        set_access,
    )

    with acting_as(writer):
        assert initialise(w, w.owner).status_code == 201
        category = create_category(w, "Projets", position=0)
        channel = create_channel(w, category["id"], "annonces", position=0)
        moved = patch_channel(w, channel, {"category_id": None, "name": "nouvelles"})
        assert moved.status_code == 200, moved.content
        assert send(w, w.admin, "post", ARCHIVE, channel_id=channel["id"]).status_code == 200
        assert send(w, w.admin, "post", UNARCHIVE, channel_id=channel["id"]).status_code == 200
        restricted = set_access(
            w,
            channel["id"],
            visibility="restricted",
            allow_members=[membership(w.owner)],
            read_only=True,
        )
        assert restricted.status_code == 200, restricted.content
        own = set_access(
            w,
            channel["id"],
            who=w.admin,
            visibility="restricted",
            allow_members=[membership(w.admin)],
        )
        assert own.status_code == 200, own.content
        assert set_access(w, channel["id"], who=w.admin, mode="inherit").status_code == 200
        assert access_of(w, channel["id"])[0]["mode"] == "inherit"
        gone = send(w, w.owner, "delete", CATEGORY, category_id=category["id"])
        assert gone.status_code == 204, gone.content
        assert send(w, w.admin, "get", ADMINISTRATION).status_code == 200
        assert send(w, w.admin, "get", ACCESS, channel_id=channel["id"]).status_code == 200
        assert rows(w)[channel["id"]]["name"] == "nouvelles"
    assert model("workspaces", "ChannelNotice").objects.count() == 1
    assert (
        model("audit", "AuditEvent").objects.filter(action__startswith="workspace.").count() == 10
    )


def test_the_writer_role_applies_a_channel_set_result_and_runs_the_membership_hook(w, writer):
    """The channel set's result path and the membership hook (ESPACE_STRUCTURE.md §13), as the
    role: the room state, the applied tag, the result revision and a notice's acknowledgement;
    and the workspace lock a membership change takes before the heads."""
    from django.db import transaction
    from test_espace_channel_set import change_membership
    from test_espace_structure import create_channel, membership, set_access

    from apps.engine_intents.channel_hooks import channel_set_reported

    with acting_as(writer):
        assert initialise(w, w.owner).status_code == 201
        channel = create_channel(w, None, "direction")
        owner_only = {"visibility": "restricted", "allow_members": [membership(w.owner)]}
        assert set_access(w, channel["id"], **owner_only).status_code == 200
        with_admin = {**owner_only, "allow_members": [membership(w.owner), membership(w.admin)]}
        assert set_access(w, channel["id"], who=w.admin, **with_admin).status_code == 200
        notice = model("workspaces", "ChannelNotice").objects.get(channel_id=channel["id"])
        with transaction.atomic():
            channel_set_reported(
                organisation_id=w.alpha.id,
                revision=7,
                ready={channel["id"]: '"applied"'},
                failed=[],
                notices_posted=[str(notice.id)],
            )
        suspended = change_membership(w, w.owner, w.member, {"state": "suspended"})
        assert suspended.status_code == 200, suspended.content
    assert model("workspaces", "Channel").objects.values_list(
        "room_state", "applied_access_etag", "room_state_revision"
    ).get(pk=channel["id"]) == ("ready", '"applied"', 7)
    notice.refresh_from_db()
    assert notice.acknowledged_at is not None
    assert (
        model("engine_intents", "EngineChannelSet")
        .objects.filter(reason="membership.changed")
        .exists()
    )


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE workspaces_workspace SET organisation_id = organisation_id",
        "UPDATE workspaces_category SET workspace_id = workspace_id",
        "UPDATE workspaces_category SET default_policy_id = NULL",
        "UPDATE workspaces_channel SET kind = 'audio'",
        "UPDATE workspaces_channel SET workspace_id = workspace_id",
        "UPDATE workspaces_channel SET created_at = now()",
        "UPDATE workspaces_resourcepolicy SET workspace_id = workspace_id",
        "UPDATE workspaces_resourcepolicyrule SET kind = kind",
        "UPDATE workspaces_channelnotice SET membership_id = membership_id",
        "UPDATE workspaces_channelnotice SET channel_id = channel_id",
        "DELETE FROM workspaces_channelnotice",
        "DELETE FROM workspaces_channel",
        "DELETE FROM workspaces_resourcepolicy",
        "TRUNCATE workspaces_workspace CASCADE",
        "UPDATE audit_auditevent SET action = 'job.failed' WHERE action = 'workspace.initialised'",
        "DELETE FROM audit_auditevent WHERE action = 'workspace.initialised'",
    ],
)
def test_the_writer_role_cannot_change_the_workspace_it_created(w, writer, statement):
    with acting_as(writer):
        assert initialise(w, w.owner).status_code == 201
        assert refused(statement) == INSUFFICIENT_PRIVILEGE, statement
    # Control: the schema owner is not refused by privilege, so the refusal above is the role's.
    assert refused(statement) != INSUFFICIENT_PRIVILEGE, statement
