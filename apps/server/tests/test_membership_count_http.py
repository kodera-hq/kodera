"""countMemberships over HTTP: real signed tokens, the real view, the disposable PostgreSQL.

`GET /organisations/{organisation_id}/memberships/count` gives the People screen its member,
admin and invitation counts. It counts exactly the
population `listMemberships` pages through: current, non-deleted `invited`, `active` and
`suspended` memberships of people who are not deleted, so `state=removed` counts 0. It is read by
an organisation's owner, admin or member. The `account_kind` filter is refused with `400`: Core
does not store how an account signs in, as `listMemberships` omits it, and a count that ignored
the filter would be a wrong number. The per-principal rate limit is not enforced yet; the contract
says both. Every response is checked against contracts/core-api.openapi.yaml by `call`. The world
is the workspace scenarios' (`w`): alpha holds one active owner, admin, billing user and member.

The last tests are the mutation proofs: with the route taken out of the customer urlconf, with
the eligible population widened to removed memberships, and with the count alone drifting from the
directory, the checks the other tests rely on fail by name.
"""

import json
from datetime import UTC, datetime

import pytest
from customer_http_fixtures import http_signer as http_signer, soft_delete
from django.db import connection
from django.urls import clear_url_caches
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call, conformance_errors, w as w

pytestmark = pytest.mark.django_db(transaction=True)

COUNT = "/organisations/{organisation_id}/memberships/count"
PROBLEMS = "https://kodera.io/problems/"


def request(w, who, query="", organisation=None, method="get"):
    organisation = w.alpha.id if organisation is None else organisation
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    path = f"/api/v1/organisations/{organisation}/memberships/count"
    return getattr(w.client, method)(path + ("?" + query if query else ""), **headers)


def count_errors(response):
    """Why the response is not a contract-conforming `200` count; empty when it is."""
    errors = conformance_errors(response, COUNT, "get")
    if response.status_code != 200:
        errors.insert(0, f"countMemberships answered {response.status_code}, not 200")
    return errors


def counted(w, who, query=""):
    response = request(w, who, query)
    assert count_errors(response) == []
    assert response.headers["Cache-Control"] == "no-store"
    body = json.loads(response.content)
    assert set(body) == {"count", "counted_at"}
    return body["count"]


def problem(response, status, kind):
    call(response, COUNT, "get")
    assert response.status_code == status, response.content
    assert json.loads(response.content)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"


def denials():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, organisation_id, target_urn, metadata->>'required_scope'"
            " FROM audit_auditevent WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


def join(w, organisation, role, state, *, email, deleted=False, person_deleted=False):
    """One more membership of `organisation`, written as the lifecycle would leave it."""
    user = w.models.User.objects.create(email=email)
    accepted = None if state == "invited" else timezone.now()
    member = w.models.Membership.objects.create(
        user=user, organisation=organisation, role=role, state=state, accepted_at=accepted
    )
    if deleted:
        soft_delete(member)
    if person_deleted:
        soft_delete(user)
    return member


@pytest.fixture
def populated(w):
    """alpha: the world's four active members, plus two invited, one suspended, one removed, one
    soft-deleted and one whose person is deleted; bravo: two active members of its own."""
    join(w, w.alpha, "org_member", "invited", email="invited-1@customer.test")
    join(w, w.alpha, "org_admin", "invited", email="invited-2@customer.test")
    join(w, w.alpha, "org_member", "suspended", email="suspended@customer.test")
    join(w, w.alpha, "org_member", "removed", email="removed@customer.test")
    join(w, w.alpha, "org_member", "active", email="deleted@customer.test", deleted=True)
    join(w, w.alpha, "org_member", "active", email="gone@customer.test", person_deleted=True)
    join(w, w.bravo, "org_member", "active", email="bravo-1@customer.test")
    join(w, w.bravo, "org_admin", "active", email="bravo-2@customer.test")
    return w


@pytest.mark.parametrize("role", ["owner", "admin", "member"])
def test_every_role_that_reads_the_directory_gets_the_count(populated, role):
    assert counted(populated, getattr(populated, role)) == 7


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("state=active", 4),
        ("state=invited", 2),
        ("state=suspended", 1),
        ("state=removed", 0),
        ("role=org_owner", 1),
        ("role=org_admin", 2),
        ("role=org_billing", 1),
        ("role=org_member", 3),
        ("role=org_admin&state=invited", 1),
        ("state=invited&role=org_admin", 1),
        ("role=org_member&state=active", 1),
    ],
)
def test_a_filter_counts_within_the_directory_s_population(populated, query, expected):
    assert counted(populated, populated.owner, query) == expected


PARITY_QUERIES = (
    "",
    "state=active",
    "state=invited",
    "state=suspended",
    "state=removed",
    "role=org_admin",
    "role=org_member",
    "role=org_admin&state=invited",
)


def parity_mismatches(w):
    """Each filter whose count differs from the length of `listMemberships`' one full page, as
    `(query, counted, listed)`; empty when the People screen's counts and its list agree."""
    found = []
    for query in PARITY_QUERIES:
        response = w.client.get(
            f"/api/v1/organisations/{w.alpha.id}/memberships" + ("?" + query if query else ""),
            HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
        )
        assert response.status_code == 200, (query, response.content)
        page = json.loads(response.content)
        assert page["has_more"] is False, query
        number = counted(w, w.owner, query)
        if number != len(page["data"]):
            found.append((query, number, len(page["data"])))
    return found


@pytest.fixture
def with_the_directory(populated, settings):
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "17" * 32
    return populated


def test_the_count_matches_the_directory_it_stands_for(with_the_directory):
    """The People screen's counts and its list read the same population, filter for filter."""
    assert parity_mismatches(with_the_directory) == []


def test_the_count_is_stamped_with_when_it_was_taken(w):
    before = datetime.now(UTC)
    response = request(w, w.owner)
    stamped = json.loads(response.content)["counted_at"]
    assert stamped.endswith("Z")
    assert before <= datetime.fromisoformat(stamped) <= datetime.now(UTC)


@pytest.mark.parametrize("kind", ["hosted", "federated", "on_site"])
def test_the_account_kind_filter_is_refused_until_core_stores_it(w, kind):
    problem(request(w, w.owner, "account_kind=" + kind), 400, "malformed-request")


def test_a_billing_user_is_refused_and_the_refusal_recorded(w):
    problem(request(w, w.billing), 403, "forbidden")
    assert denials() == [
        ("tenant", w.alpha.id, f"urn:kodera:organisation:{w.alpha.id}", "membership:read")
    ]


def test_a_staff_token_is_refused_until_its_lane_exists(w):
    problem(request(w, w.staff), 403, "forbidden")
    assert denials() == [
        ("staff", None, f"urn:kodera:organisation:{w.alpha.id}", "membership:read")
    ]


def test_another_organisation_is_not_found_and_never_counted(populated):
    # A known person of the organisation with no current membership is `404` here, as on every
    # billing-style read; `listMemberships` answers that case `403`. Both are in the contract.
    w = populated
    problem(request(w, w.owner, organisation=w.bravo.id), 404, "not-found")
    problem(request(w, w.foreigner, organisation=w.alpha.id), 404, "not-found")
    problem(request(w, w.stranger), 404, "not-found")
    problem(
        request(w, w.owner, organisation="00000000-0000-7000-8000-000000000000"), 404, "not-found"
    )
    assert denials() == []


def test_without_a_token_nothing_is_said(w):
    problem(request(w, None), 401, "unauthenticated")
    problem(request(w, None, "account_kind=hosted"), 401, "unauthenticated")


@pytest.mark.parametrize(
    "query",
    [
        "role=",
        "role=owner",
        "role=staff_operator",
        "state=",
        "state=deleted",
        "state=ACTIVE",
        "account_kind=",
        "account_kind=guest",
        "state=active&state=invited",
        "role=org_admin&role=org_member",
        "limit=10",
        "cursor=abc",
        "colour=red",
        "state=active&" + "x" * 300,
        "state",
        "&",
    ],
)
def test_a_query_that_is_not_the_contract_s_filters_is_malformed(w, query):
    problem(request(w, w.owner, query), 400, "malformed-request")


def test_the_route_answers_only_get(w):
    response = request(w, w.owner, method="post")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"


# --- the mutation proofs -------------------------------------------------------------------------


@pytest.fixture
def without_the_route(monkeypatch):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if "memberships/count" not in str(p.pattern)]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, "the route is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()
    yield
    monkeypatch.undo()
    clear_url_caches()


def test_mutation_control_the_checks_pass_with_the_route_and_the_population(populated):
    """The control: in the same world the count check passes and removed rows are not counted,
    so the mutated runs below fail because of the mutation, not because of the world."""
    assert count_errors(request(populated, populated.owner)) == []
    assert counted(populated, populated.owner) == 7


def test_mutation_without_the_route_the_count_check_fails(w, without_the_route):
    found = count_errors(request(w, w.owner))
    assert found and found[0] == "countMemberships answered 404, not 200", found


def test_mutation_a_population_that_counts_removed_rows_is_caught(populated, monkeypatch):
    from apps.orgs import membership_selectors

    monkeypatch.setattr(
        membership_selectors,
        "DIRECTORY_STATES",
        (*membership_selectors.DIRECTORY_STATES, "removed"),
    )
    # The population test's own number, 7, is now 8: the removed membership is counted.
    assert counted(populated, populated.owner) == 8


def test_mutation_a_count_that_drifts_from_the_directory_is_caught(with_the_directory, monkeypatch):
    """Only the count changes here, not the list: it forgets that a deleted person is not in the
    directory. The parity check names each filter where the two now disagree."""
    from apps.billing import membership_count
    from apps.orgs.models import Membership

    def drifted(*, organisation_id, role, state):
        rows = Membership.objects.filter(
            organisation_id=organisation_id,
            deleted_at__isnull=True,
            state__in=("invited", "active", "suspended"),
        )
        if role is not None:
            rows = rows.filter(role=role)
        if state is not None:
            rows = rows.filter(state=state)
        return rows.count()

    monkeypatch.setattr(membership_count, "count_memberships", drifted)
    assert parity_mismatches(with_the_directory) == [
        ("", 8, 7),
        ("state=active", 5, 4),
        ("role=org_member", 4, 3),
    ]
