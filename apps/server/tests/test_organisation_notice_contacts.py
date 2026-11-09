"""getNoticeContacts and patchNoticeContacts: docs/specs/ORGANISATION_NOTICE_CONTACTS.md §5.

Real signed requests through the routed view, every response checked against the contract.
"""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import raw_update
from test_intake_writer_role import acting_as
from test_membership_lifecycle import holding, m as m, second_owner
from test_membership_writer_role import writer as writer
from test_workspace_onboarding import call, model, person

from apps.orgs.notice_contacts import deliverable, notice_recipients

pytestmark = pytest.mark.django_db(transaction=True)

PATH = "/organisations/{organisation_id}/notice-contacts"
PROBLEMS = "https://kodera.io/problems/"
MERGE_PATCH = "application/merge-patch+json"
UNSET = {
    "security_contact_email": None,
    "security_contact_defaults_to_owners": True,
    "privacy_contact_email": None,
    "privacy_contact_defaults_to_owners": True,
    "subprocessor_notice_email": None,
    "subprocessor_notice_defaults_to_owners": True,
}


def url(m, organisation=None):
    return f"/api/v1/organisations/{(organisation or m.alpha).id}/notice-contacts"


def get(m, who, organisation=None):
    response = m.client.get(url(m, organisation), HTTP_AUTHORIZATION="Bearer " + who.credential)
    return call(response, PATH, "get")


def tag(m):
    response = get(m, m.owner)
    assert response.status_code == 200, response.content
    return response.headers["ETag"]


def patch(m, who, body, *, if_match="current", content_type=MERGE_PATCH):
    headers = {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if if_match == "current":
        if_match = tag(m)
    if if_match is not None:
        headers["HTTP_IF_MATCH"] = if_match
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    response = m.client.patch(url(m), data=raw, content_type=content_type, **headers)
    return call(response, PATH, "patch")


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert response.json()["type"] == PROBLEMS + kind, response.content
    return response.json()


def audit(action):
    return list(
        model("audit", "AuditEvent")
        .objects.filter(action=action)
        .order_by("occurred_at", "id")
        .values("actor_type", "target_urn", "before", "after", "metadata")
    )


def test_an_owner_and_an_admin_read_the_unset_defaults(m):
    for who in (m.owner, m.admin):
        seen = get(m, who)
        assert seen.status_code == 200 and seen.headers["Cache-Control"] == "no-store"
        assert seen.json() == {"organisation_id": str(m.alpha.id), **UNSET}
    assert get(m, m.owner).headers["ETag"] == get(m, m.admin).headers["ETag"]


def test_a_read_outside_owners_and_admins_is_refused_and_recorded(m):
    problem(get(m, m.billing), 403, "forbidden")
    problem(get(m, m.member), 403, "forbidden")
    problem(get(m, m.staff), 403, "forbidden")
    problem(get(m, m.foreigner), 404, "not-found")
    problem(get(m, m.owner, m.bravo), 404, "not-found")
    # AUTHZ.md §9: the refused staff read is recorded; refused tenant reads are not.
    denied = audit("authz.denied")
    assert [(row["actor_type"], row["metadata"]["required_scope"]) for row in denied] == [
        ("staff", "organisation:read"),
    ]


def test_an_owner_sets_changes_and_clears_each_address_with_one_audit_row(m):
    first = tag(m)
    set_ = patch(m, m.owner, {"security_contact_email": "securite@acme.test"})
    assert set_.status_code == 200, set_.content
    assert set_.json()["security_contact_email"] == "securite@acme.test"
    assert set_.json()["security_contact_defaults_to_owners"] is False
    assert set_.headers["ETag"] != first and set_.headers["ETag"] == tag(m)
    both = patch(
        m,
        m.owner,
        {"privacy_contact_email": "dpo@acme.test", "subprocessor_notice_email": "legal@acme.test"},
    )
    assert both.json()["privacy_contact_email"] == "dpo@acme.test"
    replaced = patch(m, m.owner, {"security_contact_email": "rssi@acme.test"})
    assert replaced.json()["security_contact_email"] == "rssi@acme.test"
    cleared = patch(m, m.owner, {"security_contact_email": None})
    assert cleared.json()["security_contact_defaults_to_owners"] is True
    rows = audit("organisation.updated")
    # AUDIT_TAXONOMY.md §4: the trail says which address changed and whether it is set, never
    # the address.
    assert [(row["before"], row["after"]) for row in rows] == [
        ({"security_contact_email": None}, {"security_contact_email": "set"}),
        (
            {"privacy_contact_email": None, "subprocessor_notice_email": None},
            {"privacy_contact_email": "set", "subprocessor_notice_email": "set"},
        ),
        ({"security_contact_email": "set"}, {"security_contact_email": "set"}),
        ({"security_contact_email": "set"}, {"security_contact_email": None}),
    ]
    assert "@" not in json.dumps(rows, default=str)
    assert {row["target_urn"] for row in rows} == {f"urn:kodera:organisation:{m.alpha.slug}"}
    assert {row["actor_type"] for row in rows} == {"tenant"}


def test_an_admin_reads_but_does_not_set_and_is_recorded(m):
    problem(patch(m, m.admin, {"privacy_contact_email": "dpo@acme.test"}), 403, "forbidden")
    assert get(m, m.owner).json()["privacy_contact_email"] is None
    assert [row["metadata"]["required_scope"] for row in audit("authz.denied")] == [
        "organisation:update"
    ]


def test_preconditions_are_required_and_enforced(m):
    problem(
        patch(m, m.owner, {"security_contact_email": "s@acme.test"}, if_match=None),
        428,
        "precondition-required",
    )
    current = tag(m)
    stale = patch(m, m.owner, {"security_contact_email": "s@acme.test"}, if_match='"stale"')
    assert problem(stale, 412, "precondition-failed")["current_etag"] == current
    assert stale.headers["ETag"] == current
    assert audit("organisation.updated") == []


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b"[]", MERGE_PATCH),
        (b"not json", MERGE_PATCH),
        (b'{"billing_email":"a@acme.test"}', MERGE_PATCH),
        (b'{"security_contact_email":"not an address"}', MERGE_PATCH),
        (b'{"security_contact_email":7}', MERGE_PATCH),
        (b'{"security_contact_email":[]}', MERGE_PATCH),
        (b'{"security_contact_email":"' + b"a" * 250 + b'@acme.test"}', MERGE_PATCH),
        ('{"security_contact_email":"s@acme.test"}'.encode("utf-16"), MERGE_PATCH),
        (b"[" * 200_000, MERGE_PATCH),
        (b'{"security_contact_email":"' + b"x" * 3_000_000 + b'"}', MERGE_PATCH),
        (b'{"security_contact_email":"s@acme.test"}', "application/json"),
        # Valid to Django, refused by the mail sender, so a notice could never be delivered.
        (b'{"security_contact_email":"o\'brien@acme.test"}', MERGE_PATCH),
        ('{"security_contact_email":"dpo@ex\u00e4mple.fr"}'.encode(), MERGE_PATCH),
        (b'{"security_contact_email":"user@[127.0.0.1]"}', MERGE_PATCH),
        (b'{"security_contact_email":"a@\\ud800.test"}', MERGE_PATCH),
        (b'{"security_contact_email":"' + b"a" * 65 + b'@acme.test"}', MERGE_PATCH),
    ],
)
def test_a_body_outside_the_patch_schema_is_malformed(m, body, content_type):
    problem(patch(m, m.owner, body, content_type=content_type), 400, "malformed-request")
    assert audit("organisation.updated") == []


def test_a_change_that_changes_nothing_writes_nothing(m):
    patch(m, m.owner, {"privacy_contact_email": "dpo@acme.test"})
    before = model("orgs", "Organisation").objects.get(id=m.alpha.id).updated_at
    same = patch(m, m.owner, {"privacy_contact_email": "dpo@acme.test"})
    assert same.status_code == 200 and same.headers["ETag"] == tag(m)
    assert model("orgs", "Organisation").objects.get(id=m.alpha.id).updated_at == before
    assert len(audit("organisation.updated")) == 1


def test_a_suspended_organisation_reads_but_does_not_set(m):
    current = tag(m)
    raw_update(m.alpha, state="suspended")
    assert get(m, m.owner).status_code == 200
    problem(
        patch(m, m.owner, {"security_contact_email": "s@acme.test"}, if_match=current),
        403,
        "forbidden",
    )


def test_notices_go_to_the_stored_addresses_or_else_to_the_current_owners(m):
    other = second_owner(m)
    suspended = person(m, m.alpha, "org_owner", "alpha-owner-suspended")
    raw_update(suspended.member, state="suspended")
    disabled = person(m, m.alpha, "org_owner", "alpha-owner-disabled")
    raw_update(disabled.user, enabled=False)
    removed = person(m, m.alpha, "org_owner", "alpha-owner-removed")
    raw_update(removed.member, state="removed")
    invited = person(m, m.alpha, None, "alpha-owner-invited")
    m.models.Membership.objects.create(
        user=invited.user, organisation=m.alpha, role="org_owner", state="invited"
    )
    owners = (m.owner.user.email, other.user.email)
    for kind in ("breach", "subprocessor"):
        assert notice_recipients(organisation_id=m.alpha.id, kind=kind) == owners
    # DPA 11.6: a breach notification goes to the security contact and the DPO.
    patch(m, m.owner, {"privacy_contact_email": "dpo@acme.test"})
    assert notice_recipients(organisation_id=m.alpha.id, kind="breach") == ("dpo@acme.test",)
    patch(m, m.owner, {"security_contact_email": "securite@acme.test"})
    assert notice_recipients(organisation_id=m.alpha.id, kind="breach") == (
        "securite@acme.test",
        "dpo@acme.test",
    )
    assert notice_recipients(organisation_id=m.alpha.id, kind="subprocessor") == owners
    assert notice_recipients(organisation_id=uuid4(), kind="breach") == ()
    # With no enabled owner left, nobody can be told: the sender must escalate.
    for user in (m.owner.user, other.user):
        raw_update(user, enabled=False)
    assert notice_recipients(organisation_id=m.alpha.id, kind="subprocessor") == ()
    raw_update(
        m.alpha, deleted_at=m.alpha.created_at, purge_after=m.alpha.created_at + timedelta(days=1)
    )
    assert notice_recipients(organisation_id=m.alpha.id, kind="breach") == ()


@pytest.mark.parametrize(
    "address",
    [
        "s@acme.test",
        "first.last+tag@sub.acme.test",
        "o'brien@acme.test",
        "dpo@ex\u00e4mple.fr",
        "user@[127.0.0.1]",
        "a" * 64 + "@acme.test",
        "a" * 65 + "@acme.test",
        "a@acme",
        "a@-acme.test",
        "a..b@acme.test",
    ],
)
def test_an_address_is_accepted_exactly_when_the_mail_sender_would_deliver_it(address):
    from apps.outbox.sender import check_recipient

    assert deliverable(address) == check_recipient(address), address


def test_an_owner_demoted_while_waiting_is_refused(m):
    import threading

    from test_membership_lifecycle import await_waiters, session

    other = second_owner(m)
    current = tag(m)
    blocker = session()
    blocker.execute("BEGIN")
    # The demotion locks the organisation row through the membership triggers.
    blocker.execute(
        "UPDATE orgs_membership SET role = 'org_admin' WHERE id = %s", [other.member.id]
    )
    results = {}

    def write():
        from django.db import connection

        results["status"] = patch(
            m, other, {"security_contact_email": "s@acme.test"}, if_match=current
        ).status_code
        connection.close()

    thread = threading.Thread(target=write)
    thread.start()
    await_waiters(1)
    blocker.execute("COMMIT")
    blocker.close()
    thread.join(10)
    assert results == {"status": 403}
    assert get(m, m.owner).json()["security_contact_email"] is None


def test_a_lock_held_past_the_timeout_answers_retry(m):
    current = tag(m)
    blocker = holding(m.alpha)
    try:
        # Sent directly: the shared conformance helper compares a header's raw string with its
        # schema, and the contract declares Retry-After an integer, as everywhere else.
        busy = m.client.patch(
            url(m),
            data=b'{"security_contact_email":"s@acme.test"}',
            content_type=MERGE_PATCH,
            HTTP_AUTHORIZATION="Bearer " + m.owner.credential,
            HTTP_IF_MATCH=current,
        )
    finally:
        blocker.execute("ROLLBACK")
        blocker.close()
    problem(busy, 503, "service-unavailable")
    assert busy.headers["Retry-After"] == "1" and busy.json()["retry_after_s"] == 1
    assert get(m, m.owner).json()["security_contact_email"] is None


def test_the_writer_role_serves_both_operations(m, writer):
    with acting_as(writer):
        assert get(m, m.owner).status_code == 200
        changed = patch(
            m,
            m.owner,
            {
                "security_contact_email": "s@acme.test",
                "privacy_contact_email": "dpo@acme.test",
                "subprocessor_notice_email": "legal@acme.test",
            },
        )
        assert changed.status_code == 200, changed.content
        problem(patch(m, m.admin, {"security_contact_email": "x@acme.test"}), 403, "forbidden")
    assert len(audit("organisation.updated")) == 1


def test_other_methods_are_not_allowed(m):
    response = m.client.post(url(m), HTTP_AUTHORIZATION="Bearer " + m.owner.credential)
    assert response.status_code == 405 and response["Allow"] == "GET, PATCH"
