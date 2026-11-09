"""The workspace side of the channel set: docs/specs/ESPACE_STRUCTURE.md §13.

What goes in (§13.1), when it is emitted (§13.2), what a result does (§13.3), the 501st channel
refused, the emitter's refusal rolling the change back, and the lock order that keeps a membership
change and a channel change from deadlocking (domain rows, then the heads). Real signed tokens, the
real HTTP views and the disposable PostgreSQL test database.
"""

import json
import threading
from uuid import uuid4

import pytest
from django.db import connection, transaction
from django.test import Client
from test_access_tokens import frozen_clock as frozen_clock
from test_espace_structure import (
    ACCESS,
    ARCHIVE,
    CATEGORIES,
    CATEGORY,
    CHANNELS,
    UNARCHIVE,
    access_of,
    create_category,
    create_channel,
    document,
    e as e,
    membership,
    patch_channel,
    rows,
    send,
    set_access,
    starter,
    written,
)
from test_workspace_onboarding import (
    call,
    http_signer as http_signer,
    model,
    problem,
    w as w,
)

pytestmark = pytest.mark.django_db(transaction=True)

MEMBERSHIP = "/organisations/{organisation_id}/memberships/{membership_id}"
SUBJECTS = {"owner": "alpha-owner", "admin": "alpha-admin", "billing": "alpha-billing"}
SUBJECTS["member"] = "alpha-member"
READ_ONLY_EXEMPT = ["alpha-admin", "alpha-owner"]


def sets(w):
    return list(
        model("engine_intents", "EngineChannelSet")
        .objects.filter(organisation_id=w.alpha.id)
        .order_by("revision")
    )


def latest(w):
    found = sets(w)
    assert found, "no channel set was emitted"
    return found[-1]


def entry(the_set, channel_id):
    return next(c for c in the_set.channels if c["channel_id"] == str(channel_id))


def compute(w):
    from apps.workspaces.channel_sets import channel_set_input

    workspace = model("workspaces", "Workspace").objects.get(organisation_id=w.alpha.id)
    with transaction.atomic():
        return channel_set_input(workspace.id)


# --- §13.1: what goes in ---------------------------------------------------------------------


def test_initialise_emits_the_starter_set(e):
    the_set = latest(e)
    assert the_set.reason == "workspace.initialised" and len(sets(e)) == 1
    assert set(SUBJECTS.values()) <= set(the_set.all_members), "an active member is missing"
    assert "alpha-stranger" not in the_set.all_members, "a non-member is a member"
    assert "bravo-owner" not in the_set.all_members, "another organisation's member is listed"
    assert {c["kind"] for c in the_set.channels} == {"text", "audio"}
    for channel in the_set.channels:
        assert (channel["audience"], channel["members"], channel["denied"]) == ("all", [], [])
        assert (channel["exempt"], channel["notices"], channel["archived"]) == ([], [], False)


def test_the_input_shape(e):
    listed = create_channel(e, None, "direction")
    assert (
        set_access(
            e, listed["id"], visibility="restricted", allow_members=[membership(e.member)]
        ).status_code
        == 200
    )
    denied = create_channel(e, None, "sans-facturation")
    assert set_access(e, denied["id"], deny_members=[membership(e.billing)]).status_code == 200
    announcements = create_channel(e, None, "annonces")
    assert (
        set_access(
            e, announcements["id"], deny_members=[membership(e.owner)], read_only=True
        ).status_code
        == 200
    )
    archived = create_channel(e, None, "ancien", kind="audio")
    assert send(e, e.owner, "post", ARCHIVE, channel_id=archived["id"]).status_code == 200

    everyone, channels = compute(e)
    by_id = {c["channel_id"]: c for c in channels}
    assert (by_id[listed["id"]]["audience"], by_id[listed["id"]]["members"]) == (
        "listed",
        ["alpha-member"],
    ), "a restricted channel does not list exactly its viewers"
    assert by_id[listed["id"]]["denied"] == []
    assert (by_id[denied["id"]]["audience"], by_id[denied["id"]]["denied"]) == (
        "all",
        ["alpha-billing"],
    ), "an organisation-wide channel does not list its denied member"
    assert by_id[denied["id"]]["exempt"] == [], "exempt is listed without a flag"
    assert by_id[announcements["id"]]["exempt"] == ["alpha-admin"], (
        "exempt is not the effective owners and admins of a flagged channel"
    )
    assert by_id[archived["id"]]["archived"] is True, "an archived channel is left out"
    assert by_id[archived["id"]]["audience"] == "all"
    assert {c["access_etag"] for c in channels} >= {access_of(e, listed["id"])[1]}
    assert sorted(everyone) == everyone


def test_a_notice_is_carried_while_its_member_still_views_the_channel(e):
    channel = create_channel(e, None, "direction")
    owner_only = {"visibility": "restricted", "allow_members": [membership(e.owner)]}
    assert set_access(e, channel["id"], **owner_only).status_code == 200
    with_admin = {**owner_only, "allow_members": [membership(e.owner), membership(e.admin)]}
    assert set_access(e, channel["id"], who=e.admin, **with_admin).status_code == 200
    notice = model("workspaces", "ChannelNotice").objects.get(channel_id=channel["id"])
    carried = entry(latest(e), channel["id"])["notices"]
    assert carried == [
        {
            "notice_id": str(notice.id),
            "body": "Un administrateur a rejoint ce salon en tant qu'administrateur",
        }
    ], "the notice is not carried, or its body is wrong"
    model("identity", "User").objects.filter(pk=e.admin.user.pk).update(display_name="Inès Martin")
    _, channels = compute(e)
    body = next(c for c in channels if c["channel_id"] == channel["id"])["notices"][0]["body"]
    assert body == "Inès Martin a rejoint ce salon en tant qu'administrateur"
    assert set_access(e, channel["id"], who=e.admin, **owner_only).status_code == 200
    assert entry(latest(e), channel["id"])["notices"] == [], "a notice outlived its member's view"


def test_a_member_without_an_enabled_identity_is_left_out(e):
    model("identity", "Identity").objects.filter(pk=e.member.identity.pk).update(enabled=False)
    everyone, _ = compute(e)
    assert "alpha-member" not in everyone and "alpha-admin" in everyone


# --- §13.2: when it is emitted ---------------------------------------------------------------


def test_each_change_emits_with_its_reason_and_a_position_only_move_does_not(e):
    general = starter(e)["general"]

    def emitted(act):
        before = len(sets(e))
        response = act()
        assert response.status_code in (200, 201, 204), response.content
        found = sets(e)[before:]
        return [s.reason for s in found]

    channel = create_channel(e, general["id"], "annonces")
    assert latest(e).reason == "channel.created"
    assert emitted(lambda: patch_channel(e, rows(e)[channel["id"]], {"name": "nouvelles"})) == [
        "channel.updated"
    ]
    assert emitted(lambda: patch_channel(e, rows(e)[channel["id"]], {"topic": "Le sujet"})) == [
        "channel.updated"
    ]
    assert emitted(lambda: patch_channel(e, rows(e)[channel["id"]], {"position": 0})) == [], (
        "a position-only move emitted a set"
    )
    other = create_category(e, "Autre")
    assert (
        emitted(lambda: patch_channel(e, rows(e)[channel["id"]], {"category_id": other["id"]}))
        == []
    ), "a move that keeps the inherited access emitted a set"
    assert emitted(lambda: set_access(e, channel["id"], read_only=True)) == [
        "channel.access_changed"
    ]
    assert emitted(lambda: send(e, e.owner, "post", ARCHIVE, channel_id=channel["id"])) == [
        "channel.archived"
    ]
    assert emitted(lambda: send(e, e.owner, "post", UNARCHIVE, channel_id=channel["id"])) == [
        "channel.unarchived"
    ]
    assert emitted(lambda: send(e, e.owner, "post", UNARCHIVE, channel_id=channel["id"])) == [], (
        "a change that changes nothing emitted a set"
    )
    assert emitted(lambda: send(e, e.owner, "post", CATEGORIES, {"name": "Encore"})) == []
    third = create_category(e, "Vide")
    assert emitted(lambda: send(e, e.owner, "delete", CATEGORY, category_id=third["id"])) == []


def change_membership(w, who, target, body):
    path = "/api/v1" + MEMBERSHIP.format(organisation_id=w.alpha.id, membership_id=target.member.id)
    tag = w.client.get(path, HTTP_AUTHORIZATION="Bearer " + who.credential).headers["ETag"]
    return w.client.patch(
        path,
        data=json.dumps(body),
        content_type="application/merge-patch+json",
        HTTP_AUTHORIZATION="Bearer " + who.credential,
        HTTP_IF_MATCH=tag,
    )


def test_a_membership_change_emits_the_channel_set_after_the_member_set(e):
    before = len(sets(e))
    suspended = change_membership(e, e.owner, e.member, {"state": "suspended"})
    assert suspended.status_code == 200, suspended.content
    found = sets(e)[before:]
    assert [s.reason for s in found] == ["membership.changed"]
    assert "alpha-member" not in found[0].all_members, "a suspended member stays in the rooms"
    member_head = model("engine_intents", "EngineMemberSetHead").objects.get(
        organisation_id=e.alpha.id
    )
    assert member_head.revision > 0, "the member set was not emitted"
    back = change_membership(e, e.owner, e.member, {"state": "active"})
    assert back.status_code == 200, back.content
    assert "alpha-member" in latest(e).all_members
    assert latest(e).reason == "membership.changed"


def test_a_membership_change_without_a_workspace_emits_no_channel_set(w):
    suspended = change_membership(w, w.owner, w.member, {"state": "suspended"})
    assert suspended.status_code == 200, suspended.content
    assert sets(w) == []


# --- §13.3: what a result does ---------------------------------------------------------------


def report(w, revision, ready=None, failed=(), posted=()):
    from apps.engine_intents.channel_hooks import channel_set_reported

    with transaction.atomic():
        channel_set_reported(
            organisation_id=w.alpha.id,
            revision=revision,
            ready=dict(ready or {}),
            failed=list(failed),
            notices_posted=list(posted),
        )


def stored(channel_id):
    return (
        model("workspaces", "Channel")
        .objects.values_list("room_state", "applied_access_etag", "room_state_revision")
        .get(pk=channel_id)
    )


def test_a_result_sets_room_states_and_posts_notices_in_revision_order(e):
    ready = create_channel(e, None, "pret")
    failing = create_channel(e, None, "echec")
    channel = create_channel(e, None, "direction")
    owner_only = {"visibility": "restricted", "allow_members": [membership(e.owner)]}
    assert set_access(e, channel["id"], **owner_only).status_code == 200
    with_admin = {**owner_only, "allow_members": [membership(e.owner), membership(e.admin)]}
    assert set_access(e, channel["id"], who=e.admin, **with_admin).status_code == 200
    notice = model("workspaces", "ChannelNotice").objects.get(channel_id=channel["id"])

    report(e, 10, ready={ready["id"]: '"tag-10"'}, failed=[failing["id"]], posted=[str(notice.id)])
    assert stored(ready["id"]) == ("ready", '"tag-10"', 10)
    assert stored(failing["id"]) == ("failed", None, 10)
    notice.refresh_from_db()
    assert notice.acknowledged_at is not None, "a posted notice is still pending"
    _, channels = compute(e)
    assert next(c for c in channels if c["channel_id"] == channel["id"])["notices"] == []

    report(e, 9, ready={failing["id"]: '"tag-9"'}, failed=[ready["id"]])
    assert stored(ready["id"]) == ("ready", '"tag-10"', 10), "a late older result undid a newer"
    assert stored(failing["id"]) == ("failed", None, 10)
    report(e, 10, ready={failing["id"]: '"tag-10b"'})
    assert stored(failing["id"]) == ("ready", '"tag-10b"', 10), "the same revision did not apply"


def test_a_result_ignores_unknown_deleted_and_foreign_ids(e):
    channel = create_channel(e, None)
    gone = create_channel(e, None, "supprime")
    model("workspaces", "Channel").objects.filter(pk=gone["id"]).update(lifecycle="deleted")
    workspace = model("workspaces", "Workspace").objects.create(organisation=e.bravo)
    foreign = model("workspaces", "Channel").objects.create(
        workspace=workspace, kind="text", name="ailleurs", position=0, lifecycle="active"
    )
    report(
        e,
        5,
        ready={
            channel["id"]: '"t"',
            gone["id"]: '"t"',
            str(foreign.id): '"t"',
            str(uuid4()): '"t"',
            "not-a-uuid": '"t"',
        },
        posted=[str(uuid4()), "nope"],
    )
    assert stored(channel["id"])[0] == "ready"
    assert stored(gone["id"])[0] == "pending", "a deleted channel was set ready"
    assert stored(foreign.id)[0] == "pending", "another organisation's channel was set ready"


# --- the 501st channel, and the emitter's refusal --------------------------------------------


def test_a_501st_channel_is_refused_before_the_emitter(e):
    workspace = model("workspaces", "Workspace").objects.get(organisation_id=e.alpha.id)
    Channel = model("workspaces", "Channel")  # noqa: N806
    existing = Channel.objects.filter(workspace=workspace).count()
    Channel.objects.bulk_create(
        Channel(
            workspace=workspace,
            category=None,
            kind="text",
            name=f"c{i}",
            position=i,
            lifecycle="archived" if i % 2 else "active",
        )
        for i in range(500 - existing)
    )
    before = written()
    refused = problem(
        send(e, e.owner, "post", CHANNELS, {"category_id": None, "kind": "text", "name": "x"}),
        409,
        "conflict",
    )
    assert refused["reason"] == "channel_limit"
    assert written() == before, "a refused 501st channel wrote something"


def refuse_sets(monkeypatch):
    from apps.engine_intents.channel_sets import ChannelSetError
    from apps.workspaces import channel_sets

    def refuse(**kwargs):
        raise ChannelSetError("a channel set lists at most 10000 members in all")

    monkeypatch.setattr(channel_sets, "emit_channel_set", refuse)


def test_a_structural_change_whose_set_is_refused_is_a_409_and_writes_nothing(e, monkeypatch):
    refuse_sets(monkeypatch)
    before, count = written(), len(sets(e))
    refused = problem(
        send(e, e.owner, "post", CHANNELS, {"category_id": None, "kind": "text", "name": "x"}),
        409,
        "conflict",
    )
    assert refused["reason"] == "channel_set_too_large"
    channel = rows(e)[starter(e)["general"]["channels"][0]["id"]]
    _, tag = access_of(e, channel["id"])
    refused = problem(
        send(
            e,
            e.owner,
            "patch",
            ACCESS,
            document(read_only=True),
            if_match=tag,
            channel_id=channel["id"],
        ),
        409,
        "conflict",
    )
    assert refused["reason"] == "channel_set_too_large"
    assert (written(), len(sets(e))) == (before, count), "a refused set left the change behind"


@pytest.mark.parametrize(
    ("body", "persisted"),
    [
        ({"state": "suspended"}, ("state", "suspended")),
        ({"role": "org_admin"}, ("role", "org_admin")),
    ],
)
def test_a_refused_set_never_blocks_a_membership_change(e, monkeypatch, caplog, body, persisted):
    refuse_sets(monkeypatch)
    count = len(sets(e))
    changed = change_membership(e, e.owner, e.member, body)
    assert changed.status_code == 200, changed.content
    field, value = persisted
    stored_value = (
        model("orgs", "Membership").objects.values_list(field, flat=True).get(pk=e.member.member.id)
    )
    assert stored_value == value, "the membership change did not commit"
    assert len(sets(e)) == count
    refusals = list(
        model("audit", "AuditEvent")
        .objects.filter(action="workspace.channel_set_refused")
        .values_list("actor_type", "metadata")
    )
    reason = "membership.changed" if field == "state" else "membership.role_changed"
    assert [(actor, metadata["reason"]) for actor, metadata in refusals] == [("system", reason)]
    assert any(
        record.levelname == "CRITICAL" and "channel set" in record.getMessage()
        for record in caplog.records
    ), "the refusal was not logged critical"
    if field == "state":
        head = model("engine_intents", "EngineMemberSetHead").objects.get(
            organisation_id=e.alpha.id
        )
        assert head.revision > 0, "the member set did not commit with the change"


def test_a_role_change_moves_a_member_in_or_out_of_exempt(e):
    channel = create_channel(e, None, "annonces")
    assert set_access(e, channel["id"], read_only=True).status_code == 200
    assert entry(latest(e), channel["id"])["exempt"] == READ_ONLY_EXEMPT
    demoted = change_membership(e, e.owner, e.admin, {"role": "org_member"})
    assert demoted.status_code == 200, demoted.content
    assert latest(e).reason == "membership.role_changed", "a role change emitted no channel set"
    assert entry(latest(e), channel["id"])["exempt"] == ["alpha-owner"], (
        "a demoted admin stayed exempt"
    )
    promoted = change_membership(e, e.owner, e.admin, {"role": "org_admin"})
    assert promoted.status_code == 200, promoted.content
    assert entry(latest(e), channel["id"])["exempt"] == READ_ONLY_EXEMPT


# --- the lock order: domain rows, then the heads ----------------------------------------------

WAITING_ON_WORKSPACE = (
    "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
    "AND query LIKE '%%FROM workspaces_workspace WHERE organisation_id%%FOR UPDATE%%'"
)


def waits_on_workspace():
    """Whether another connection waits on the workspace row's `FOR UPDATE`, watched for at most
    three seconds."""
    with connection.cursor() as cursor:
        for _ in range(60):
            # A transaction keeps its first view of pg_stat_activity unless it is cleared.
            cursor.execute("SELECT pg_stat_clear_snapshot()")
            cursor.execute(WAITING_ON_WORKSPACE)
            if cursor.fetchone()[0]:
                return True
            threading.Event().wait(0.05)
    return False


def patient(monkeypatch):
    """Lock and statement timeouts long enough that only the lock order decides, however loaded
    the machine: a wrong order still deadlocks, which PostgreSQL detects within a second."""
    from apps.orgs import membership_lifecycle
    from apps.workspaces import administration, initialise

    options = dict(connection.settings_dict["OPTIONS"])
    options["options"] = "-c statement_timeout=20000"
    monkeypatch.setitem(connection.settings_dict, "OPTIONS", options)
    connection.close()
    monkeypatch.setattr(administration, "LOCK_TIMEOUT", "SET LOCAL lock_timeout = '15s'")
    monkeypatch.setattr(membership_lifecycle, "LOCK_TIMEOUT", "SET LOCAL lock_timeout = '15s'")
    monkeypatch.setattr(initialise, "LOCK_TIMEOUT", "SET LOCAL lock_timeout = '15s'")


def run_threads(*requests):
    results = {}

    def run(name, request):
        try:
            results[name] = request(Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"))
        finally:
            connection.close()

    return results, [threading.Thread(target=run, args=item) for item in requests]


@pytest.mark.parametrize("path_taken", ["member_left", "member_set_changed"])
def test_a_membership_change_and_an_access_change_do_not_deadlock(e, monkeypatch, path_taken):
    """Two connections. The access change takes the workspace row first and then waits, before
    the heads, until the membership change has reached its workspace lock, and until that
    connection is seen waiting on it. With the workspace locked before the heads there, both
    complete; with the heads first, the access change would wait on a head the membership change
    holds while it waits on the workspace, and PostgreSQL would abort one of the two."""
    from apps.workspaces import administration, channel_sets

    if path_taken == "member_set_changed":
        assert change_membership(e, e.owner, e.member, {"state": "suspended"}).status_code == 200
    patient(monkeypatch)
    target_state = "suspended" if path_taken == "member_left" else "active"
    channel = create_channel(e, None)
    _, tag = access_of(e, channel["id"])
    path = "/api/v1" + MEMBERSHIP.format(
        organisation_id=e.alpha.id, membership_id=e.member.member.id
    )
    member_tag = e.client.get(path, HTTP_AUTHORIZATION="Bearer " + e.owner.credential).headers[
        "ETag"
    ]
    holding, reached = threading.Event(), threading.Event()
    observed = {}
    revise, lock = administration._revise, channel_sets.lock_workspace

    def revise_then_wait(organisation_id):
        found = revise(organisation_id)
        holding.set()
        observed["reached"] = reached.wait(timeout=5)
        observed["waiting"] = observed["reached"] and waits_on_workspace()
        return found

    def signal_then_lock(organisation_id):
        reached.set()
        return lock(organisation_id)

    monkeypatch.setattr(administration, "_revise", revise_then_wait)
    monkeypatch.setattr(channel_sets, "lock_workspace", signal_then_lock)
    access_url = "/api/v1" + ACCESS.format(organisation_id=e.alpha.id, channel_id=channel["id"])
    results, (access_change, membership_change) = run_threads(
        (
            "access",
            lambda client: client.patch(
                access_url,
                data=json.dumps(document(read_only=True)),
                content_type="application/merge-patch+json",
                HTTP_AUTHORIZATION="Bearer " + e.owner.credential,
                HTTP_IF_MATCH=tag,
            ),
        ),
        (
            "membership",
            lambda client: client.patch(
                path,
                data=json.dumps({"state": target_state}),
                content_type="application/merge-patch+json",
                HTTP_AUTHORIZATION="Bearer " + e.admin.credential,
                HTTP_IF_MATCH=member_tag,
            ),
        ),
    )
    access_change.start()
    assert holding.wait(timeout=10), "the access change never took the workspace"
    membership_change.start()
    for thread in (access_change, membership_change):
        thread.join(timeout=30)
    assert observed.get("reached") is True, "the membership change never reached its lock"
    assert observed.get("waiting") is True, (
        "the membership change was not seen waiting on the workspace row"
    )
    statuses = {name: response.status_code for name, response in results.items()}
    assert statuses == {"access": 200, "membership": 200}, (
        f"a membership change and an access change did not both complete: {statuses}"
    )
    call(results["access"], ACCESS, "patch")
    member_in = "alpha-member" in latest(e).all_members
    assert member_in is (target_state == "active"), "the later set lost the membership change"
    assert entry(latest(e), channel["id"])["read_only"] is True, "the later set lost a change"


def test_a_result_applied_while_a_create_shifts_its_siblings(e, monkeypatch):
    """A result reaches its workspace lock while a channel create holds the workspace and shifts
    the very rows the result sets; the result waits on the workspace row, and both complete."""
    from apps.engine_intents.channel_hooks import channel_set_reported
    from apps.workspaces import administration, channel_sets

    sibling = create_channel(e, None, "voisin")
    patient(monkeypatch)
    holding, reached = threading.Event(), threading.Event()
    observed = {}
    revise, lock = administration._revise, channel_sets.lock_workspace

    def revise_then_wait(organisation_id):
        found = revise(organisation_id)
        holding.set()
        observed["reached"] = reached.wait(timeout=5)
        observed["waiting"] = observed["reached"] and waits_on_workspace()
        return found

    def signal_then_lock(organisation_id):
        reached.set()
        return lock(organisation_id)

    monkeypatch.setattr(administration, "_revise", revise_then_wait)
    monkeypatch.setattr(channel_sets, "lock_workspace", signal_then_lock)
    url = "/api/v1" + CHANNELS.format(organisation_id=e.alpha.id)
    applied = {}

    def apply(client):
        with transaction.atomic():
            channel_set_reported(
                organisation_id=e.alpha.id,
                revision=11,
                ready={sibling["id"]: '"applied"'},
                failed=[],
                notices_posted=[],
            )
        applied["done"] = True
        return client

    results, (create, result) = run_threads(
        (
            "create",
            lambda client: client.post(
                url,
                data=json.dumps({"category_id": None, "kind": "text", "name": "x", "position": 0}),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer " + e.owner.credential,
                HTTP_IDEMPOTENCY_KEY=str(uuid4()),
            ),
        ),
        ("result", apply),
    )
    create.start()
    assert holding.wait(timeout=10), "the create never took the workspace"
    result.start()
    for thread in (create, result):
        thread.join(timeout=30)
    assert observed == {"reached": True, "waiting": True}, f"the result did not wait: {observed}"
    assert results["create"].status_code == 201, results["create"].content
    assert applied.get("done") is True, "the result was not applied"
    assert stored(sibling["id"])[0] == "ready"


def test_initialise_reads_the_members_after_a_concurrent_suspension(w, monkeypatch):
    """`initialiseWorkspace` stops before its channel set while a suspension, which sees no
    workspace yet, takes the heads with its member set and waits there until the initialisation
    waits on them. The initialisation's input is read under the heads, after the suspension
    commits, so its set leaves the suspended member out."""
    from order_fixtures import commit_order
    from test_workspace_onboarding import INITIALISE, path as workspace_path

    from apps.engine_intents import services
    from apps.workspaces import channel_sets

    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    patient(monkeypatch)
    ready, holds = threading.Event(), threading.Event()
    emit_for, emit_member_left = channel_sets.emit_for, services.emit_member_left
    observed = {}

    def pause_then_emit(**kwargs):
        ready.set()
        observed["held"] = holds.wait(timeout=5)
        return emit_for(**kwargs)

    def take_heads_then_wait(membership, *, reason):
        found = emit_member_left(membership, reason=reason)
        holds.set()
        with connection.cursor() as cursor:
            for _ in range(60):
                cursor.execute(
                    "SELECT count(*) FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()"
                )
                if cursor.fetchone()[0]:
                    observed["initialise_waited"] = True
                    break
                threading.Event().wait(0.05)
        return found

    monkeypatch.setattr(channel_sets, "emit_for", pause_then_emit)
    monkeypatch.setattr(services, "emit_member_left", take_heads_then_wait)
    member_path = "/api/v1" + MEMBERSHIP.format(
        organisation_id=w.alpha.id, membership_id=w.member.member.id
    )
    member_tag = w.client.get(member_path, HTTP_AUTHORIZATION="Bearer " + w.owner.credential)[
        "ETag"
    ]
    results, (initialising, suspending) = run_threads(
        (
            "initialise",
            lambda client: client.post(
                workspace_path(INITIALISE, w.alpha),
                data=b"",
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
                HTTP_IDEMPOTENCY_KEY=str(uuid4()),
            ),
        ),
        (
            "suspend",
            lambda client: client.patch(
                member_path,
                data=json.dumps({"state": "suspended"}),
                content_type="application/merge-patch+json",
                HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
                HTTP_IF_MATCH=member_tag,
            ),
        ),
    )
    initialising.start()
    assert ready.wait(timeout=10), "the initialisation never reached its channel set"
    suspending.start()
    for thread in (initialising, suspending):
        thread.join(timeout=30)
    statuses = {name: response.status_code for name, response in results.items()}
    assert statuses == {"initialise": 201, "suspend": 200}, statuses
    assert observed.get("held") is True and observed.get("initialise_waited") is True, observed
    the_set = latest(w)
    assert the_set.reason == "workspace.initialised"
    assert "alpha-member" not in the_set.all_members, (
        "the initialisation's set kept a member suspended before it was recorded"
    )


# --- the input's cost ------------------------------------------------------------------------


def seed_large(w, *, members=200, channels=500):
    """`members` current members with enabled identities, and `channels` channels of which one in
    five is restricted to ten members on a policy of its own."""
    from django.utils import timezone

    User = model("identity", "User")  # noqa: N806
    Identity = model("identity", "Identity")  # noqa: N806
    Membership = model("orgs", "Membership")  # noqa: N806
    Policy = model("workspaces", "ResourcePolicy")  # noqa: N806
    Rule = model("workspaces", "ResourcePolicyRule")  # noqa: N806
    Channel = model("workspaces", "Channel")  # noqa: N806
    current = Membership.objects.filter(organisation=w.alpha, state="active").count()
    added = []
    for i in range(members - current):
        user = User.objects.create(email=f"person-{i}@customer.test")
        Identity.objects.create(
            user=user,
            organisation=w.alpha,
            issuer=w.alpha.issuer,
            realm=w.alpha.realm,
            subject=f"alpha-person-{i}",
            email=f"person-{i}@customer.test",
            enabled=True,
        )
        added.append(
            Membership.objects.create(
                user=user,
                organisation=w.alpha,
                role="org_member",
                state="active",
                accepted_at=timezone.now(),
            )
        )
    workspace = model("workspaces", "Workspace").objects.get(organisation_id=w.alpha.id)
    existing = Channel.objects.filter(workspace=workspace).count()
    rows = []
    for i in range(channels - existing):
        policy = None
        if i % 5 == 0:
            policy = Policy.objects.create(workspace=workspace, visibility="restricted")
            Rule.objects.bulk_create(
                Rule(policy=policy, kind="allow_member", membership=m) for m in added[i % 7 :][:10]
            )
        rows.append(
            Channel(
                workspace=workspace,
                kind="text",
                name=f"salon-{i}",
                position=i,
                lifecycle="active",
                policy_mode="explicit" if policy else "inherit",
                explicit_policy=policy,
            )
        )
    Channel.objects.bulk_create(rows)
    return workspace


def test_the_inputs_cost_at_the_bound(e, capsys):
    import time

    from django.test.utils import CaptureQueriesContext

    from apps.workspaces.channel_sets import channel_set_input

    workspace = seed_large(e)
    with transaction.atomic(), CaptureQueriesContext(connection) as queries:
        started = time.perf_counter()
        everyone, channels = channel_set_input(workspace.id)
        elapsed = time.perf_counter() - started
    with capsys.disabled():
        print(f"\nMEASURED channel_set_input: {len(queries)} queries, {elapsed:.2f} s")
    assert len(channels) == 500 and len(everyone) >= 200
    assert len(queries) <= 20, f"the input took {len(queries)} queries"
