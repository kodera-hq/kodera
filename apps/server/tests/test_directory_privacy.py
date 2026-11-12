"""Directory privacy on the two reads of a membership: docs/specs/MEMBERSHIP_LIFECYCLE.md §2.1.

`listMemberships` and `getMembership` disclose a person's private member facts (`email`,
`identity_id`, `account_kind`, `mfa_enrolled`, `last_seen_at`) on a row only to that person and to
a caller who holds `org_owner` or `org_admin`. To an `org_member` reading a colleague they are
absent, the answer is still `200`, and nothing else on the route can be made to tell them: no
filter, no ordering, no count, no validator.

Real signed requests through the routed views, every answer checked against the contract. The
world is the membership lifecycle's (`m`): alpha holds one owner, one admin, one billing user and
one member; a second member, the colleague, is added here.

The last tests are the refusal proofs. Each mutant removes one mask from the source of one read
and must make that read's acceptance check fail by name; a control runs the same checks on the
unmutated source first, so a mutant fails because of the mutation and not because of the world.
"""

import hashlib
import inspect
import json
import textwrap

import pytest
from customer_http_fixtures import http_signer as http_signer
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import raw_update
from test_membership_count_http import request as count_request
from test_membership_lifecycle import ONE, get, m as m, patch
from test_workspace_onboarding import call, person

from apps.orgs import (
    membership_lifecycle,
    membership_selectors as directory_privacy,
    membership_services,
)
from apps.orgs.api import membership_detail

pytestmark = pytest.mark.django_db(transaction=True)

LIST = "/organisations/{organisation_id}/memberships"
PRIVATE = set(directory_privacy.PRIVATE_MEMBER_FACTS)
# What a row keeps for every reader, on each read.
LIST_PUBLIC = {
    "id",
    "organisation_id",
    "display_name",
    "role",
    "state",
    "created_at",
    "updated_at",
}
DETAIL_PUBLIC = LIST_PUBLIC | {
    "person_id",
    "can_change_role",
    "can_remove",
    "blocked_reason",
    "invitation_id",
}


@pytest.fixture(autouse=True)
def directory_key(settings):
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "17" * 32


@pytest.fixture
def d(m):
    """The lifecycle world with a second member, and a display name on every person so that a
    row without an address still names someone."""
    m.colleague = person(m, m.alpha, "org_member", "alpha-colleague")
    for who in (m.owner, m.admin, m.billing, m.member, m.colleague):
        raw_update(who.user, display_name="Name of " + who.identity.subject)
    return m


def listed(w, who, query=""):
    """The caller's page of alpha's directory, by membership id; the answer conforms."""
    response = w.client.get(
        f"/api/v1/organisations/{w.alpha.id}/memberships" + query,
        HTTP_AUTHORIZATION="Bearer " + who.credential,
    )
    call(response, LIST, "get")
    assert response.status_code == 200, response.content
    assert response.headers["Cache-Control"] == "no-store" and "ETag" not in response.headers
    return {row["id"]: row for row in response.json()["data"]}


def detail(w, who, target):
    response = get(w, who, target.member)
    assert response.status_code == 200, response.content
    assert response.headers["Cache-Control"] == "no-store"
    return response


def people(w):
    return (w.owner, w.admin, w.billing, w.member, w.colleague)


def leaked(w, body):
    """The private values of anyone in the world that `body`'s text carries, as a set of the
    people it tells on: an address or an identity found anywhere, not only under its own key."""
    text = json.dumps(body)
    return {
        who.identity.subject
        for who in people(w)
        if who.user.email in text or str(who.identity.id) in text
    }


# --- the rule ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "own_row", "disclosed"),
    [
        ("org_owner", False, True),
        ("org_admin", False, True),
        ("org_owner", True, True),
        ("org_member", True, True),
        ("org_member", False, False),
        # Not a reading role today; held to the rule all the same should it become one.
        ("org_billing", False, False),
        ("", False, False),
    ],
)
def test_the_rule_discloses_to_the_person_and_to_owners_and_admins_only(role, own_row, disclosed):
    assert directory_privacy.discloses_private_facts(caller_role=role, own_row=own_row) is disclosed


def test_withholding_omits_every_private_fact_and_nothing_else():
    row = {name: "value" for name in (*LIST_PUBLIC, "person_id", *PRIVATE)}
    kept = directory_privacy.withhold_private_facts(row)
    assert set(kept) == LIST_PUBLIC | {"person_id"}
    assert PRIVATE == {"email", "identity_id", "account_kind", "mfa_enrolled", "last_seen_at"}


# --- listMemberships --------------------------------------------------------------------------


def list_discloses_to(w, who):
    """Whose address `who` reads in the directory, by subject."""
    rows = listed(w, who)
    disclosed = set()
    for target in people(w):
        row = rows[str(target.member.id)]
        assert LIST_PUBLIC <= set(row), "a row lost a fact that is not private"
        assert row["display_name"] == "Name of " + target.identity.subject
        if PRIVATE & set(row):
            assert set(row) == LIST_PUBLIC | {"email"} and row["email"] == target.user.email
            disclosed.add(target.identity.subject)
        else:
            assert set(row) == LIST_PUBLIC, "a withheld fact is absent, never null or masked"
    return disclosed


def check_list_privacy(w):
    everyone = {who.identity.subject for who in people(w)}
    assert list_discloses_to(w, w.owner) == everyone, "an owner reads every row in full"
    assert list_discloses_to(w, w.admin) == everyone, "an admin reads every row in full"
    assert list_discloses_to(w, w.member) == {"alpha-member"}, (
        "listMemberships disclosed a colleague's private member facts to an org_member"
    )
    assert leaked(w, listed(w, w.member)) == {"alpha-member"}, (
        "listMemberships carried a colleague's private value somewhere in a member's page"
    )


def test_the_list_discloses_to_self_owner_and_admin_and_withholds_from_a_member(d):
    check_list_privacy(d)


def test_a_member_page_carries_their_own_row_in_full_beside_withheld_colleagues(d):
    rows = listed(d, d.colleague)
    assert rows[str(d.colleague.member.id)]["email"] == d.colleague.user.email
    for other in (d.owner, d.admin, d.billing, d.member):
        assert "email" not in rows[str(other.member.id)]
    # Row by row on every page, not only the first: each page of one row holds to the rule.
    seen, cursor = {}, ""
    for _ in range(len(people(d))):
        response = d.client.get(
            f"/api/v1/organisations/{d.alpha.id}/memberships?limit=1" + cursor,
            HTTP_AUTHORIZATION="Bearer " + d.colleague.credential,
        )
        page = call(response, LIST, "get").json()
        seen.update({row["id"]: row for row in page["data"]})
        if not page["has_more"]:
            break
        cursor = "&cursor=" + page["next_cursor"]
    assert seen == rows


@pytest.mark.parametrize("state", ["invited", "suspended"])
def test_a_colleague_in_any_listed_state_is_withheld_from_a_member(d, state):
    raw_update(
        d.colleague.member,
        state=state,
        **({"accepted_at": None} if state == "invited" else {}),
    )
    assert "email" not in listed(d, d.member)[str(d.colleague.member.id)]
    assert listed(d, d.admin)[str(d.colleague.member.id)]["email"] == d.colleague.user.email


@pytest.mark.parametrize(
    "query",
    [
        "?email=alpha-colleague@customer.test",
        "?q=alpha-colleague",
        "?search=colleague",
        "?sort=email",
        "?order_by=email",
        "?account_kind=hosted",
        "?mfa_enrolled=true",
        "?identity_id=00000000-0000-4000-8000-000000000000",
        "?last_seen_at=2026-01-01T00:00:00Z",
    ],
)
@pytest.mark.parametrize("who", ["member", "owner"])
def test_no_filter_search_or_ordering_reads_a_private_fact(d, who, query):
    """An answer that depended on the value would be an oracle for it: every such input is refused
    the same way whatever it names, for an administrator as for a member."""
    response = d.client.get(
        f"/api/v1/organisations/{d.alpha.id}/memberships" + query,
        HTTP_AUTHORIZATION="Bearer " + getattr(d, who).credential,
    )
    call(response, LIST, "get")
    assert response.status_code == 400, response.content
    assert leaked(d, response.json()) == set()


def test_the_public_filters_do_not_widen_what_a_member_reads(d):
    for query in ("?role=org_member", "?state=active", "?role=org_admin&state=active", "?limit=2"):
        for row in listed(d, d.member, query).values():
            assert ("email" in row) is (row["id"] == str(d.member.member.id))


# --- countMemberships -------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["member", "admin", "owner"])
@pytest.mark.parametrize("kind", ["hosted", "federated"])
def test_no_count_narrows_on_a_private_fact(d, who, kind):
    """`account_kind` is a private member fact: a count filtered by it would tell a member what the
    list withholds. Core does not answer the filter for anyone, so no caller is given a number."""
    response = count_request(d, getattr(d, who), "account_kind=" + kind)
    assert response.status_code in (400, 403), response.content
    assert "count" not in response.json()


# --- getMembership ----------------------------------------------------------------------------


def detail_discloses(w, who, target):
    body = detail(w, who, target).json()
    assert DETAIL_PUBLIC <= set(body), "the row lost a fact that is not private"
    assert body["person_id"] == str(target.user.id)
    assert body["display_name"] == "Name of " + target.identity.subject
    if not PRIVATE & set(body):
        assert set(body) == DETAIL_PUBLIC, "a withheld fact is absent, never null or masked"
        return False
    assert set(body) == DETAIL_PUBLIC | {"email", "identity_id"}
    assert body["email"] == target.user.email
    assert body["identity_id"] == str(target.identity.id)
    return True


def check_detail_privacy(w):
    for target in people(w):
        assert detail_discloses(w, w.owner, target), "an owner reads every row in full"
        assert detail_discloses(w, w.admin, target), "an admin reads every row in full"
    assert detail_discloses(w, w.member, w.member), "a member reads their own row in full"
    for colleague in (w.owner, w.admin, w.billing, w.colleague):
        assert not detail_discloses(w, w.member, colleague), (
            "getMembership disclosed a colleague's private member facts to an org_member"
        )
        assert leaked(w, detail(w, w.member, colleague).json()) == set(), (
            "getMembership carried a colleague's private value somewhere in a member's answer"
        )


def test_the_detail_discloses_to_self_owner_and_admin_and_withholds_from_a_member(d):
    check_detail_privacy(d)


def test_the_withheld_detail_is_still_a_200_with_its_advice(d):
    body = detail(d, d.member, d.colleague).json()
    assert (body["can_change_role"], body["can_remove"], body["blocked_reason"]) == (
        False,
        False,
        None,
    )


def test_a_colleague_with_no_identity_tells_a_member_nothing_more_or_less(d):
    """`identity_id` is null for an administrator when the person has no identity yet; a member
    sees neither that null nor a value, so cannot tell the two apart."""
    d.models.Identity.objects.filter(id=d.colleague.identity.id).update(enabled=False)
    assert detail(d, d.admin, d.colleague).json()["identity_id"] is None
    assert set(detail(d, d.member, d.colleague).json()) == DETAIL_PUBLIC


def test_the_writes_withhold_nothing_from_an_administrator(d):
    changed = patch(d, d.admin, d.colleague.member, {"role": "org_admin"})
    assert changed.status_code == 200, changed.content
    assert changed.json()["email"] == d.colleague.user.email
    assert changed.json()["identity_id"] == str(d.colleague.identity.id)


# --- the validator ----------------------------------------------------------------------------


def check_validator(w):
    full = detail(w, w.owner, w.colleague)
    own = detail(w, w.colleague, w.colleague)
    withheld = detail(w, w.member, w.colleague)
    assert full.headers["ETag"] == own.headers["ETag"], "one representation, one tag"
    assert (
        full.content == own.content
        or json.loads(full.content).keys() == json.loads(own.content).keys()
    )
    assert withheld.headers["ETag"] != full.headers["ETag"], (
        "getMembership gave two different representations the same strong validator"
    )


def test_the_withheld_representation_has_its_own_strong_tag(d):
    check_validator(d)


def test_the_tag_an_administrator_round_trips_is_the_stored_rows(d):
    tag = detail(d, d.admin, d.colleague).headers["ETag"]
    assert (
        patch(d, d.admin, d.colleague.member, {"role": "org_admin"}, if_match=tag).status_code
        == 200
    )


def test_no_tag_moves_with_a_private_fact(d):
    """The validator is not an oracle: changing the address or the identity changes no tag, so a
    guess cannot be confirmed against one, by a member or by anyone else."""
    before = {
        who: detail(d, getattr(d, who), d.colleague).headers["ETag"] for who in ("owner", "member")
    }
    raw_update(d.colleague.user, email="moved@customer.test")
    d.models.Identity.objects.filter(id=d.colleague.identity.id).update(enabled=False)
    after = {
        who: detail(d, getattr(d, who), d.colleague).headers["ETag"] for who in ("owner", "member")
    }
    assert after == before
    # And neither tag is a digest of anything private.
    for value in (d.colleague.user.email, str(d.colleague.identity.id)):
        digest = hashlib.sha256(value.encode()).hexdigest()
        assert all(digest not in tag for tag in before.values())


def test_a_member_cannot_spend_the_withheld_tag_on_a_write(d):
    tag = detail(d, d.member, d.colleague).headers["ETag"]
    refused = patch(d, d.member, d.colleague.member, {"role": "org_admin"}, if_match=tag)
    assert refused.status_code == 403, refused.content


def test_neither_read_answers_a_conditional_request_from_another_callers_tag(d):
    """No `304` exists on these reads: a tag one caller was given never stands in for a body, so
    one caller's projection is never served to another."""
    tag = detail(d, d.owner, d.colleague).headers["ETag"]
    response = d.client.get(
        f"/api/v1/organisations/{d.alpha.id}/memberships/{d.colleague.member.id}",
        HTTP_AUTHORIZATION="Bearer " + d.member.credential,
        HTTP_IF_NONE_MATCH=tag,
    )
    call(response, ONE, "get")
    assert response.status_code == 200 and "email" not in response.json()
    assert response.headers["Cache-Control"] == "no-store"


# --- the refusal proofs -----------------------------------------------------------------------

# Each mutant removes one mask from one function: (function, the exact source it replaces, what
# it becomes, the acceptance check that owns it and fails by name).
MUTANTS = {
    "the list forgets to withhold": (
        membership_services._row,
        "contact.email if disclosed else None",
        "contact.email",
        "check_list_privacy",
    ),
    "the list treats every row as the caller's own": (
        membership_services.read_directory,
        "own_row=item.user_id == person.id",
        "own_row=True",
        "check_list_privacy",
    ),
    "the detail forgets to withhold": (
        membership_lifecycle.read_membership,
        "view = withheld(view)",
        "pass",
        "check_detail_privacy",
    ),
    "the detail treats every row as the caller's own": (
        membership_lifecycle.read_membership,
        "own_row=view.id == caller.membership_id",
        "own_row=True",
        "check_detail_privacy",
    ),
    "the withheld view keeps the contact": (
        membership_lifecycle.withheld,
        "replace(view, email=None, identity_id=None, private_facts=False)",
        "replace(view, private_facts=True)",
        "check_detail_privacy",
    ),
    "the rule discloses the list to every reading role": (
        directory_privacy.discloses_private_facts,
        "return own_row or caller_role in DISCLOSING_ROLES",
        "return True",
        "check_list_privacy",
    ),
    "the rule discloses the detail to every reading role": (
        directory_privacy.discloses_private_facts,
        "return own_row or caller_role in DISCLOSING_ROLES",
        "return True",
        "check_detail_privacy",
    ),
    "the withheld representation shares the full tag": (
        membership_lifecycle.etag,
        "if not view.private_facts:",
        "if False:",
        "check_validator",
    ),
}
CHECKS = {
    "check_list_privacy": check_list_privacy,
    "check_detail_privacy": check_detail_privacy,
    "check_validator": check_validator,
}
# Where a mutated function is bound besides its own module: the views and services import these
# names when they load.
REBOUND = {
    "read_directory": ("apps.orgs.api.memberships",),
    "read_membership": ("apps.orgs.api.membership_detail",),
    "discloses_private_facts": ("apps.orgs.membership_services", "apps.orgs.membership_lifecycle"),
}


def mutated(monkeypatch, name):
    """Install the mutant: the function's own source with one anchor replaced, compiled against
    the function's globals, and bound wherever the original is."""
    function, before, after, _ = MUTANTS[name]
    source = textwrap.dedent(inspect.getsource(function))
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace = dict(function.__globals__)
    exec(compile(source.replace(before, after), f"<mutant: {name}>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    mutant = namespace[function.__name__]
    for module in (function.__module__, *REBOUND.get(function.__name__, ())):
        monkeypatch.setattr(f"{module}.{function.__name__}", mutant)


def test_refusal_control_every_check_passes_on_the_unmutated_reads(d):
    for check in CHECKS.values():
        check(d)


@pytest.mark.parametrize("name", sorted(MUTANTS))
def test_refusal_removing_a_mask_fails_the_check_that_owns_it(d, monkeypatch, name):
    owner = CHECKS[MUTANTS[name][3]]
    owner(d)  # holds before the mutation, in this very world
    mutated(monkeypatch, name)
    with pytest.raises(AssertionError) as caught:
        owner(d)
    # The failure is the privacy assertion itself, not an accident of the mutation.
    assert any(
        word in str(caught.value)
        for word in ("private member facts", "private value", "strong validator", "withheld fact")
    ), str(caught.value)


def test_refusal_the_serializer_cannot_emit_what_the_service_withheld(d, monkeypatch):
    """The second line of the mask: with the view's own omission removed, a member's answer still
    carries no address and no identity, because the withheld view holds none. The mutant fails
    closed (an internal error), never open."""
    function, before = membership_detail._membership, "if not view.private_facts:"
    source = textwrap.dedent(inspect.getsource(function))
    assert source.count(before) == 1, "mutation anchor moved"
    namespace = dict(function.__globals__)
    exec(compile(source.replace(before, "if False:"), "<mutant: view>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    monkeypatch.setattr(membership_detail, "_membership", namespace["_membership"])
    response = d.client.get(
        f"/api/v1/organisations/{d.alpha.id}/memberships/{d.colleague.member.id}",
        HTTP_AUTHORIZATION="Bearer " + d.member.credential,
    )
    assert response.status_code == 500, response.content
    assert leaked(d, response.json()) == set()


def test_each_read_has_a_mutant_and_each_mutant_a_check():
    owners = {check for _, _, _, check in MUTANTS.values()}
    assert owners == set(CHECKS)
    mutated_modules = {function.__module__ for function, _, _, _ in MUTANTS.values()}
    assert {"apps.orgs.membership_services", "apps.orgs.membership_lifecycle"} <= mutated_modules
