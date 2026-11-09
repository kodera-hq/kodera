"""getMembership, changeMembershipRole and removeMembership: docs/specs/MEMBERSHIP_LIFECYCLE.md §8.

Real signed requests through the routed view, every response checked against the contract.
"""

import json
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import connection
from django.test import Client
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor, anchor_models, identity, raw_update
from test_workspace_onboarding import STAFF_ISSUER, call, model, person

from apps.orgs import member_set_hooks

pytestmark = pytest.mark.django_db(transaction=True)

ONE = "/organisations/{organisation_id}/memberships/{membership_id}"
PROBLEMS = "https://kodera.io/problems/"
MERGE_PATCH = "application/merge-patch+json"


@pytest.fixture
def m(transactional_db, settings, http_signer):
    models = anchor_models()
    alpha, _, owners = anchor(models, slug="alpha")
    bravo, _, _ = anchor(models, slug="bravo")
    configure(
        settings,
        [
            trust_entry(http_signer, alpha.issuer),
            trust_entry(http_signer, bravo.issuer),
            trust_entry(http_signer, STAFF_ISSUER, lane="staff"),
        ],
    )
    world = SimpleNamespace(
        models=models,
        signer=http_signer,
        alpha=alpha,
        bravo=bravo,
        client=Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"),
    )
    owner_user = owners[0].user
    world.owner = SimpleNamespace(
        user=owner_user,
        identity=identity(models, alpha, owner_user, subject="alpha-owner"),
        member=owners[0],
        credential=token(http_signer, alpha.issuer, subject="alpha-owner"),
    )
    world.admin = person(world, alpha, "org_admin", "alpha-admin")
    world.billing = person(world, alpha, "org_billing", "alpha-billing")
    world.member = person(world, alpha, "org_member", "alpha-member")
    world.foreigner = person(world, bravo, "org_owner", "bravo-owner")
    world.staff = SimpleNamespace(credential=token(http_signer, STAFF_ISSUER, subject="staff-one"))
    return world


def target(w, member, organisation=None):
    return f"/api/v1/organisations/{(organisation or w.alpha).id}/memberships/{member.id}"


def get(w, who, member, organisation=None):
    response = w.client.get(
        target(w, member, organisation), HTTP_AUTHORIZATION="Bearer " + who.credential
    )
    return call(response, ONE, "get")


def tag(w, member):
    response = get(w, w.owner, member)
    assert response.status_code == 200, response.content
    return response.headers["ETag"]


def patch(w, who, member, body, *, if_match="current", content_type=MERGE_PATCH):
    headers = {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if if_match == "current":
        if_match = tag(w, member)
    if if_match is not None:
        headers["HTTP_IF_MATCH"] = if_match
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    response = w.client.patch(target(w, member), data=raw, content_type=content_type, **headers)
    return call(response, ONE, "patch")


def delete(w, who, member, *, if_match=None):
    headers = {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if if_match is not None:
        headers["HTTP_IF_MATCH"] = if_match
    return call(w.client.delete(target(w, member), **headers), ONE, "delete")


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert response.json()["type"] == PROBLEMS + kind, response.content
    return response.json()


def stored(member):
    return model("orgs", "Membership").objects.get(id=member.id)


def audit(action=None):
    rows = model("audit", "AuditEvent").objects.order_by("occurred_at", "id")
    if action is not None:
        rows = rows.filter(action=action)
    return list(rows.values("action", "actor_type", "target_urn", "before", "after", "metadata"))


def revision(w):
    return model("orgs", "Organisation").objects.get(id=w.alpha.id).authority_revision


def second_owner(w):
    return person(w, w.alpha, "org_owner", f"alpha-owner-{uuid4().hex[:8]}")


# --- getMembership ----------------------------------------------------------------------------


def test_a_reader_gets_the_row_its_tag_and_honest_flags(m):
    seen = get(m, m.owner, m.admin.member)
    assert seen.status_code == 200 and seen.headers["Cache-Control"] == "no-store"
    body = seen.json()
    assert body["id"] == str(m.admin.member.id) and body["role"] == "org_admin"
    assert body["person_id"] == str(m.admin.user.id)
    assert body["identity_id"] == str(m.admin.identity.id)
    assert (body["can_change_role"], body["can_remove"], body["blocked_reason"]) == (
        True,
        True,
        None,
    )
    own = get(m, m.owner, m.owner.member).json()
    assert (own["can_remove"], own["blocked_reason"]) == (False, "last_owner")
    assert get(m, m.admin, m.admin.member).json()["blocked_reason"] == "self"
    admin_on_owner = get(m, m.admin, m.owner.member).json()
    assert (admin_on_owner["can_change_role"], admin_on_owner["can_remove"]) == (False, False)
    member_view = get(m, m.member, m.admin.member).json()
    assert (member_view["can_change_role"], member_view["blocked_reason"]) == (False, None)
    assert seen.headers["ETag"] == get(m, m.member, m.admin.member).headers["ETag"]


def test_a_read_outside_the_rows_reach_is_refused(m):
    problem(get(m, m.billing, m.member.member), 403, "forbidden")
    problem(get(m, m.staff, m.member.member), 403, "forbidden")
    problem(get(m, m.owner, m.foreigner.member), 404, "not-found")
    problem(get(m, m.foreigner, m.member.member), 404, "not-found")
    problem(get(m, m.owner, SimpleNamespace(id=uuid4())), 404, "not-found")
    raw_update(m.member.member, state="removed")
    problem(get(m, m.owner, m.member.member), 404, "not-found")
    # AUTHZ.md §9: a refused staff read is recorded; a refused tenant read is not, so a reader
    # cannot fill the trail by repeating it.
    assert [(row["actor_type"], row["metadata"]["required_scope"]) for row in audit()] == [
        ("staff", "membership:read"),
    ]


# --- changeMembershipRole ---------------------------------------------------------------------


def test_an_owner_changes_role_and_state_with_one_audit_row_each(m, monkeypatch):
    calls = []
    monkeypatch.setattr(
        member_set_hooks,
        "member_left",
        lambda membership, *, reason: calls.append(
            ("left", membership.id, membership.state, reason, connection.in_atomic_block)
        ),
    )
    monkeypatch.setattr(
        member_set_hooks,
        "member_set_changed",
        lambda *, organisation_id, reason: calls.append(
            ("set", organisation_id, reason, connection.in_atomic_block)
        ),
    )
    before = revision(m)
    promoted = patch(m, m.owner, m.member.member, {"role": "org_admin"})
    assert promoted.status_code == 200 and promoted.json()["role"] == "org_admin"
    assert promoted.headers["ETag"] == tag(m, m.member.member)
    assert revision(m) > before
    suspended = patch(m, m.owner, m.member.member, {"state": "suspended"})
    assert suspended.json()["state"] == "suspended"
    reactivated = patch(m, m.owner, m.member.member, {"state": "active", "role": "org_member"})
    assert reactivated.json() == {**reactivated.json(), "state": "active", "role": "org_member"}
    urn = f"urn:kodera:membership:{m.member.member.id}"
    assert [(row["action"], row["before"], row["after"]) for row in audit()] == [
        ("membership.role_changed", {"role": "org_member"}, {"role": "org_admin"}),
        ("membership.suspended", {"state": "active"}, {"state": "suspended"}),
        ("membership.role_changed", {"role": "org_admin"}, {"role": "org_member"}),
        ("membership.reactivated", {"state": "suspended"}, {"state": "active"}),
    ]
    assert {row["target_urn"] for row in audit()} == {urn}
    assert {row["actor_type"] for row in audit()} == {"tenant"}
    assert calls == [
        ("left", m.member.member.id, "suspended", "member_suspended", True),
        ("set", m.alpha.id, "member_reactivated", True),
    ]


def test_a_suspended_member_loses_every_read_at_once(m):
    patch(m, m.owner, m.member.member, {"state": "suspended"})
    problem(get(m, m.member, m.admin.member), 404, "not-found")
    directory = m.client.get(
        f"/api/v1/organisations/{m.alpha.id}/memberships",
        HTTP_AUTHORIZATION="Bearer " + m.member.credential,
    )
    assert directory.status_code == 403


def test_an_admin_reaches_only_admins_and_members(m):
    assert patch(m, m.admin, m.member.member, {"role": "org_admin"}).status_code == 200
    peer = person(m, m.alpha, "org_admin", "alpha-peer")
    assert patch(m, m.admin, peer.member, {"role": "org_member"}).status_code == 200
    problem(patch(m, m.admin, m.owner.member, {"role": "org_admin"}), 403, "forbidden")
    problem(patch(m, m.admin, peer.member, {"role": "org_owner"}), 403, "forbidden")
    problem(patch(m, m.admin, m.billing.member, {"state": "suspended"}), 403, "forbidden")
    problem(patch(m, m.admin, peer.member, {"role": "org_billing"}), 403, "forbidden")
    assert stored(m.owner.member).role == "org_owner"
    assert stored(peer.member).role == "org_member"
    assert stored(m.billing.member).state == "active"
    denied = audit("authz.denied")
    assert len(denied) == 4
    assert {row["metadata"]["required_scope"] for row in denied} == {"membership:update"}
    assert {row["actor_type"] for row in denied} == {"tenant"}


def test_no_one_changes_their_own_membership(m):
    problem(patch(m, m.admin, m.admin.member, {"role": "org_member"}), 403, "forbidden")
    other = second_owner(m)
    problem(patch(m, m.owner, m.owner.member, {"role": "org_admin"}), 403, "forbidden")
    problem(delete(m, other, other.member), 403, "forbidden")
    assert stored(m.owner.member).role == "org_owner"
    assert stored(other.member).state == "active"


def test_the_last_owner_cannot_be_demoted_suspended_or_removed(m):
    for body in ({"role": "org_admin"}, {"state": "suspended"}):
        refusal = problem(patch(m, m.owner, m.owner.member, body), 409, "last-owner-protected")
        assert refusal["organisation_id"] == str(m.alpha.id)
    # First-slice FS-ID-03: removing one's own last-owner row answers why, not 403.
    problem(delete(m, m.owner, m.owner.member), 409, "last-owner-protected")
    other = second_owner(m)
    assert patch(m, m.owner, other.member, {"role": "org_admin"}).status_code == 200
    problem(patch(m, other, m.owner.member, {"role": "org_admin"}), 403, "forbidden")
    assert stored(m.owner.member).role == "org_owner"


def test_preconditions_are_required_and_enforced(m):
    problem(
        patch(m, m.owner, m.member.member, {"role": "org_admin"}, if_match=None),
        428,
        "precondition-required",
    )
    current = tag(m, m.member.member)
    stale = patch(m, m.owner, m.member.member, {"role": "org_admin"}, if_match='"stale"')
    assert problem(stale, 412, "precondition-failed")["current_etag"] == current
    assert stale.headers["ETag"] == current
    problem(delete(m, m.owner, m.member.member, if_match='"stale"'), 412, "precondition-failed")
    assert stored(m.member.member).role == "org_member"
    assert stored(m.member.member).state == "active"
    assert delete(m, m.owner, m.member.member, if_match=current).status_code == 200


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b"[]", MERGE_PATCH),
        (b"not json", MERGE_PATCH),
        (b'{"role":"boss"}', MERGE_PATCH),
        (b'{"state":"removed"}', MERGE_PATCH),
        (b'{"state":"invited"}', MERGE_PATCH),
        (b'{"role":"org_admin","extra":1}', MERGE_PATCH),
        (b'{"role":null}', MERGE_PATCH),
        (b'{"state":[]}', MERGE_PATCH),
        (b'{"state":{}}', MERGE_PATCH),
        (b"[" * 200_000, MERGE_PATCH),
        ('{"role":"org_admin"}'.encode("utf-16"), MERGE_PATCH),
        (b'{"role":"' + b"x" * 3_000_000 + b'"}', MERGE_PATCH),
        (b'{"role":"org_admin"}', "application/json"),
    ],
)
def test_a_body_outside_the_patch_schema_is_malformed(m, body, content_type):
    problem(
        patch(m, m.owner, m.member.member, body, content_type=content_type),
        400,
        "malformed-request",
    )
    assert stored(m.member.member).role == "org_member"
    assert audit() == []


def test_a_change_that_changes_nothing_writes_nothing(m):
    before = revision(m)
    unchanged = patch(m, m.owner, m.member.member, {"role": "org_member", "state": "active"})
    assert unchanged.status_code == 200 and unchanged.headers["ETag"] == tag(m, m.member.member)
    assert revision(m) == before and audit() == []


def test_an_invited_membership_has_no_role_to_change(m):
    invited = person(m, m.alpha, None, "alpha-invited")
    row = m.models.Membership.objects.create(
        user=invited.user, organisation=m.alpha, role="org_member", state="invited"
    )
    refusal = patch(m, m.owner, row, {"role": "org_admin"})
    assert problem(refusal, 409, "invalid-state-transition")["allowed_states"] == [
        "active",
        "suspended",
    ]


def test_a_suspended_organisation_reads_but_does_not_administer(m):
    current = tag(m, m.member.member)
    raw_update(m.alpha, state="suspended")
    assert get(m, m.owner, m.member.member).status_code == 200
    problem(
        patch(m, m.owner, m.member.member, {"role": "org_admin"}, if_match=current),
        403,
        "forbidden",
    )
    problem(delete(m, m.owner, m.member.member), 403, "forbidden")
    assert len(audit("authz.denied")) == 2


def test_staff_never_change_a_customer_membership_and_are_recorded(m):
    current = tag(m, m.member.member)
    problem(
        patch(m, m.staff, m.member.member, {"role": "org_admin"}, if_match=current),
        403,
        "forbidden",
    )
    problem(delete(m, m.staff, m.member.member), 403, "forbidden")
    denied = audit("authz.denied")
    assert [row["actor_type"] for row in denied] == ["staff", "staff"]
    assert [row["metadata"]["required_scope"] for row in denied] == [
        "membership:update",
        "membership:delete",
    ]
    assert stored(m.member.member).role == "org_member"


# --- removeMembership -------------------------------------------------------------------------


def test_a_removal_is_recorded_once_and_answered_again(m, monkeypatch):
    calls = []
    monkeypatch.setattr(
        member_set_hooks,
        "member_left",
        lambda membership, *, reason: calls.append(
            (membership.id, membership.state, reason, connection.in_atomic_block)
        ),
    )
    before = revision(m)
    removed = delete(m, m.admin, m.member.member)
    assert removed.status_code == 200 and removed.json()["state"] == "removed"
    assert "ETag" not in removed.headers
    again = delete(m, m.admin, m.member.member)
    assert again.status_code == 200 and again.json() == removed.json()
    # A removed row is a 404 to a read, so a removal never discloses the former member's contact.
    assert set(removed.json()) == {
        "id",
        "organisation_id",
        "role",
        "state",
        "created_at",
        "updated_at",
    }
    assert [(row["action"], row["before"], row["after"]) for row in audit()] == [
        ("membership.removed", {"state": "active"}, {"state": "removed"})
    ]
    assert calls == [(m.member.member.id, "removed", "member_removed", True)]
    removed_revision = revision(m)
    assert removed_revision > before
    # The repeat wrote nothing, not even the lock-taking touch.
    assert delete(m, m.admin, m.member.member).status_code == 200
    assert revision(m) == removed_revision
    assert stored(m.member.member).deleted_at is None
    problem(get(m, m.member, m.admin.member), 404, "not-found")
    problem(delete(m, m.admin, m.owner.member), 403, "forbidden")


def test_a_retried_removal_answers_the_row_whatever_tag_it_carries(m):
    first_tag = tag(m, m.member.member)
    first = delete(m, m.owner, m.member.member, if_match=first_tag)
    retried = delete(m, m.owner, m.member.member, if_match=first_tag)
    assert first.status_code == retried.status_code == 200
    assert retried.json() == first.json()
    assert len(audit("membership.removed")) == 1


def test_a_removed_membership_cannot_be_changed_back(m):
    removed = delete(m, m.owner, m.member.member)
    assert removed.status_code == 200
    problem(
        patch(m, m.owner, m.member.member, {"state": "active"}, if_match=None), 404, "not-found"
    )
    problem(
        patch(m, m.owner, m.member.member, {"state": "active"}, if_match='"any"'), 404, "not-found"
    )
    assert stored(m.member.member).state == "removed"


def test_an_admin_cannot_learn_a_removed_owner_through_a_repeated_removal(m):
    other = second_owner(m)
    assert delete(m, m.owner, other.member).status_code == 200
    problem(delete(m, m.admin, other.member), 403, "forbidden")


def test_a_change_that_changes_nothing_still_obeys_the_rules(m):
    problem(patch(m, m.admin, m.owner.member, {"role": "org_owner"}), 403, "forbidden")
    problem(patch(m, m.admin, m.billing.member, {}), 403, "forbidden")
    problem(patch(m, m.admin, m.admin.member, {"role": "org_admin"}), 403, "forbidden")
    assert len(audit("authz.denied")) == 3


def test_the_flags_follow_the_rules_the_writes_apply(m):
    invited = person(m, m.alpha, None, "alpha-invited-flags")
    row = m.models.Membership.objects.create(
        user=invited.user, organisation=m.alpha, role="org_member", state="invited"
    )
    flags = get(m, m.owner, row).json()
    assert (flags["can_change_role"], flags["can_remove"]) == (False, True)
    assert delete(m, m.owner, row).status_code == 200
    raw_update(m.alpha, state="suspended")
    suspended = get(m, m.owner, m.member.member).json()
    assert (suspended["can_change_role"], suspended["can_remove"]) == (False, False)


def test_only_an_active_member_leaves_the_member_set_on_removal(m, monkeypatch):
    calls = []
    monkeypatch.setattr(
        member_set_hooks,
        "member_left",
        lambda membership, *, reason: calls.append((membership.id, reason)),
    )
    invited = person(m, m.alpha, None, "alpha-invited-hook")
    row = m.models.Membership.objects.create(
        user=invited.user, organisation=m.alpha, role="org_member", state="invited"
    )
    assert delete(m, m.owner, row).status_code == 200
    assert patch(m, m.owner, m.member.member, {"state": "suspended"}).status_code == 200
    assert delete(m, m.owner, m.member.member).status_code == 200
    assert calls == [(m.member.member.id, "member_suspended")]
    assert [(row["action"], row["before"]) for row in audit("membership.removed")] == [
        ("membership.removed", {"state": "invited"}),
        ("membership.removed", {"state": "suspended"}),
    ]


def test_the_commit_time_owner_guard_answers_last_owner(m, monkeypatch):
    from apps.orgs import membership_lifecycle

    monkeypatch.setattr(membership_lifecycle, "_is_last_owner", lambda view: False)
    monkeypatch.setattr(membership_lifecycle, "_check_not_self", lambda caller, view: None)
    refusal = problem(
        patch(m, m.owner, m.owner.member, {"role": "org_admin"}), 409, "last-owner-protected"
    )
    assert refusal["organisation_id"] == str(m.alpha.id)
    assert stored(m.owner.member).role == "org_owner" and audit() == []


def test_other_methods_are_not_allowed(m):
    response = m.client.post(
        target(m, m.member.member), HTTP_AUTHORIZATION="Bearer " + m.owner.credential
    )
    assert response.status_code == 405 and response["Allow"] == "GET, PATCH, DELETE"


# --- concurrency ------------------------------------------------------------------------------


def lock_waiters():
    """How many other sessions of this database wait on a lock now."""
    with session() as observer:
        return observer.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND wait_event_type = 'Lock'"
        ).fetchone()[0]


def await_waiters(count):
    deadline = time.monotonic() + 1.5
    while lock_waiters() < count:
        assert time.monotonic() < deadline, "the requests never reached the lock"
        time.sleep(0.02)


def holding(organisation):
    """A session holding the organisation row as the membership triggers take it."""
    blocker = session()
    blocker.execute("BEGIN")
    blocker.execute(
        "SELECT 1 FROM orgs_organisation WHERE id = %s FOR NO KEY UPDATE", [organisation.id]
    )
    return blocker


def send(results, name, m, who, member, if_match, body=b'{"role":"org_admin"}'):
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    response = client.patch(
        target(m, member),
        data=body,
        content_type=MERGE_PATCH,
        HTTP_AUTHORIZATION="Bearer " + who.credential,
        HTTP_IF_MATCH=if_match,
    )
    results[name] = response.status_code
    connection.close()


def test_two_owners_demoting_each_other_leave_one_owner(m):
    other = second_owner(m)
    tags = {"first": tag(m, other.member), "second": tag(m, m.owner.member)}
    blocker = holding(m.alpha)
    results = {}
    threads = [
        threading.Thread(
            target=send, args=(results, "first", m, m.owner, other.member, tags["first"])
        ),
        threading.Thread(
            target=send, args=(results, "second", m, other, m.owner.member, tags["second"])
        ),
    ]
    for thread in threads:
        thread.start()
    await_waiters(2)
    blocker.execute("COMMIT")
    blocker.close()
    for thread in threads:
        thread.join(10)
    # The loser was demoted by the winner first, so as an admin it may not touch an owner.
    assert sorted(results.values()) == [200, 403], results
    owners = model("orgs", "Membership").objects.filter(
        organisation_id=m.alpha.id, role="org_owner", state="active"
    )
    assert owners.count() == 1


def test_a_caller_demoted_while_waiting_is_refused(m):
    current = tag(m, m.member.member)
    blocker = session()
    blocker.execute("BEGIN")
    # The demotion takes the admin's person and organisation locks, as any membership write does.
    blocker.execute(
        "UPDATE orgs_membership SET role = 'org_member' WHERE id = %s", [m.admin.member.id]
    )
    results = {}
    thread = threading.Thread(
        target=send, args=(results, "admin", m, m.admin, m.member.member, current)
    )
    thread.start()
    await_waiters(1)
    blocker.execute("COMMIT")
    blocker.close()
    thread.join(10)
    assert results == {"admin": 403}
    assert stored(m.member.member).role == "org_member"


def test_a_lock_held_past_the_timeout_changes_nothing(m):
    current = tag(m, m.member.member)
    blocker = holding(m.alpha)
    try:
        results = {}
        send(results, "late", m, m.owner, m.member.member, current)
    finally:
        blocker.execute("ROLLBACK")
        blocker.close()
    assert results == {"late": 500}
    assert stored(m.member.member).role == "org_member" and audit() == []
