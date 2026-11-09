"""checkSlugAvailability over HTTP: real signed tokens, the real view, the disposable PostgreSQL.

`GET /slug-availability?slug=` is asked by the console's order step on every blur of the tenant
slug field. It answers for the tenant slug only, never says which organisation holds a taken one,
and is read by an organisation's owner or admin, the roles that prepare an order. Every response is checked
against contracts/core-api.openapi.yaml by `call`, problem documents included. The world is the
workspace scenarios' (`w`). The per-principal rate limit the contract describes is not enforced
yet (its description says so); placeOrder stays the authority on a slug.

The last tests are the mutation proofs: with the route taken out of the customer urlconf, and with
the role set widened to a plain member, the checks the other tests rely on fail by name.
"""

import json
import re

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection
from django.urls import clear_url_caches
from test_access_tokens import frozen_clock as frozen_clock
from test_tenant_reads_http import tenant
from test_workspace_onboarding import call, conformance_errors, w as w

pytestmark = pytest.mark.django_db(transaction=True)

AVAILABILITY = "/slug-availability"
PROBLEMS = "https://kodera.io/problems/"
SLUG = r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$"


def request(w, who, query, method="get"):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    return getattr(w.client, method)("/api/v1/slug-availability?" + query, **headers)


def availability_errors(response):
    """Why the response is not a contract-conforming `200` answer; empty when it is."""
    errors = conformance_errors(response, AVAILABILITY, "get")
    if response.status_code != 200:
        errors.insert(0, f"checkSlugAvailability answered {response.status_code}, not 200")
    return errors


def answer(w, who, slug):
    response = request(w, who, "slug=" + slug)
    assert availability_errors(response) == []
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def problem(response, status, kind):
    call(response, AVAILABILITY, "get")
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


@pytest.mark.parametrize("role", ["owner", "admin"])
def test_a_free_slug_is_available_to_an_owner_or_an_admin(w, role):
    assert answer(w, getattr(w, role), "alpha-team") == {
        "slug": "alpha-team",
        "available": True,
        "reason": None,
        "suggestions": [],
    }


def test_a_taken_slug_says_so_with_free_suggestions_and_never_who_holds_it(w):
    tenant(w.bravo, "acme")
    tenant(w.bravo, "acme-2")
    found = answer(w, w.owner, "acme")
    assert (found["slug"], found["available"], found["reason"]) == ("acme", False, "taken")
    assert found["suggestions"] and "acme-2" not in found["suggestions"]
    assert all(s.startswith("acme-") for s in found["suggestions"])
    assert str(w.bravo.id) not in json.dumps(found) and "bravo" not in json.dumps(found)
    # Each suggestion is a tenant slug, and itself free.
    for suggestion in found["suggestions"]:
        assert re.fullmatch(SLUG, suggestion), suggestion
        assert answer(w, w.owner, suggestion)["available"] is True


def test_the_caller_s_own_tenant_slug_is_taken_too(w):
    tenant(w.alpha, "alpha-team")
    assert answer(w, w.owner, "alpha-team")["reason"] == "taken"


def test_a_deleted_tenant_s_slug_is_never_released(w):
    tenant(w.bravo, "gone-team", status="deleted")
    assert answer(w, w.owner, "gone-team")["reason"] == "taken"


@pytest.mark.parametrize("slug", ["app", "kodera", "status", "staging", "matrix"])
def test_a_platform_name_is_reserved_with_suggestions(w, slug):
    found = answer(w, w.owner, slug)
    assert (found["available"], found["reason"]) == (False, "reserved")
    assert found["suggestions"] and all(s.startswith(slug + "-") for s in found["suggestions"])


def test_a_punycode_label_is_reserved_and_nothing_is_suggested(w):
    found = answer(w, w.owner, "xn--abc")
    assert (found["available"], found["reason"], found["suggestions"]) == (False, "reserved", [])


def test_a_longest_slug_s_suggestions_stay_within_the_label_rule(w):
    longest = "a" * 31 + "b"
    tenant(w.bravo, longest)
    found = answer(w, w.owner, longest)
    assert found["reason"] == "taken" and found["suggestions"]
    for suggestion in found["suggestions"]:
        assert re.fullmatch(SLUG, suggestion), suggestion


def test_a_suggestion_cut_at_a_hyphen_never_doubles_it(w):
    # Cut to make room for "-2", the stem ends in a hyphen: it is dropped, never kept as "--".
    taken = "a" * 29 + "-bc"
    tenant(w.bravo, taken)
    found = answer(w, w.owner, taken)
    assert found["suggestions"] and found["suggestions"][0] == "a" * 29 + "-2"
    assert not any("--" in suggestion for suggestion in found["suggestions"])


@pytest.mark.parametrize("role", ["member", "billing"])
def test_a_member_who_cannot_order_is_refused_and_the_refusal_recorded(w, role):
    problem(request(w, getattr(w, role), "slug=alpha-team"), 403, "forbidden")
    assert denials() == [
        ("tenant", w.alpha.id, "urn:kodera:slug-availability", "organisation:read")
    ]


def test_a_staff_token_is_refused_until_its_lane_exists(w):
    problem(request(w, w.staff, "slug=alpha-team"), 403, "forbidden")
    assert denials() == [("staff", None, "urn:kodera:slug-availability", "organisation:read")]


def test_a_person_with_no_membership_is_refused_not_told_it_is_absent(w):
    problem(request(w, w.stranger, "slug=alpha-team"), 403, "forbidden")
    (denial,) = denials()
    assert denial == ("tenant", w.alpha.id, "urn:kodera:slug-availability", "organisation:read")
    with connection.cursor() as cursor:
        cursor.execute("SELECT actor_id FROM audit_auditevent WHERE action = 'authz.denied'")
        assert cursor.fetchone()[0] is not None, "the refusal names no identity"


def test_without_a_token_nothing_is_said(w):
    problem(request(w, None, "slug=alpha-team"), 401, "unauthenticated")
    problem(request(w, None, "slug=A"), 401, "unauthenticated")


@pytest.mark.parametrize(
    "query",
    [
        "",
        "slug=",
        "slug=ab",
        "slug=Alpha",
        "slug=-alpha",
        "slug=alpha-",
        "slug=" + "a" * 33,
        "slug=alpha%20team",
        "slug=alpha&slug=bravo",
        "slug=alpha&colour=red",
        # A second pair, and past the 128-character cap: malformed either way, so the cap itself
        # (which only bounds parsing, no valid query reaching it) is not what this case proves.
        "slug=alpha&" + "x" * 130,
    ],
)
def test_a_query_that_is_not_one_tenant_slug_is_malformed(w, query):
    problem(request(w, w.owner, query), 400, "malformed-request")


def test_the_route_answers_only_get(w):
    response = request(w, w.owner, "slug=alpha-team", method="post")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"


# --- the mutation proofs -------------------------------------------------------------------------


@pytest.fixture
def without_the_route(monkeypatch):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if "slug-availability" not in str(p.pattern)]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, "the route is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()
    yield
    monkeypatch.undo()
    clear_url_caches()


def test_mutation_control_the_checks_pass_with_the_route_and_the_role_set(w):
    """The control: in the same world, the answer check passes for the owner and the member is
    refused, so the mutated runs below fail because of the mutation, not because of the world."""
    assert availability_errors(request(w, w.owner, "slug=alpha-team")) == []
    assert request(w, w.member, "slug=alpha-team").status_code == 403


def test_mutation_without_the_route_the_answer_check_fails(w, without_the_route):
    found = availability_errors(request(w, w.owner, "slug=alpha-team"))
    assert found and found[0] == "checkSlugAvailability answered 404, not 200", found


def test_mutation_a_role_set_that_admits_a_plain_member_is_caught(w, monkeypatch):
    from apps.billing.api import slug_availability

    monkeypatch.setattr(
        slug_availability,
        "SLUG_CHECK_ROLES",
        slug_availability.SLUG_CHECK_ROLES | {"org_member"},
    )
    response = request(w, w.member, "slug=alpha-team")
    assert response.status_code == 200, "the widened role set did not reach the view"
    # The refusal test's own check fails on the mutated answer.
    with pytest.raises(AssertionError):
        problem(response, 403, "forbidden")
    assert denials() == []
