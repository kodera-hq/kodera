"""getHelpContext over HTTP: real signed tokens, the real view, the disposable PostgreSQL.

`GET /support/help-context?area=&screen=&locale=` feeds the console's help entry and the home
screen's support card. Core holds no article catalogue, no incident feed and no service level per
support tier yet, so the answer is honest about it: no articles, no incident, and no `sla`, which
the contract leaves optional and the console reads as "no promise to state" (it omits its support
card rather than inventing a delay). The contract says so. The path names no organisation: it is
the caller's own. Every tenant role reads it; a staff token is refused until the staff lane of the
customer reads is built, and a known person with no membership is refused, recorded, since the
contract declares no `404`. Every response is checked against contracts/core-api.openapi.yaml by
`call`. The world is the workspace scenarios' (`w`).

The last tests are the mutation proofs: with the route taken out of the customer urlconf, and
with the area check loosened, the checks the other tests rely on fail by name.
"""

import json

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection
from django.urls import clear_url_caches
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call, conformance_errors, w as w

pytestmark = pytest.mark.django_db(transaction=True)

HELP = "/support/help-context"
PROBLEMS = "https://kodera.io/problems/"
AREAS = [
    "shell",
    "login",
    "order",
    "status",
    "people",
    "domain",
    "invoices",
    "support",
    "federation",
]
TARGET = "urn:kodera:help-context"


def request(w, who, query, method="get"):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    return getattr(w.client, method)("/api/v1/support/help-context?" + query, **headers)


def help_errors(response):
    """Why the response is not a contract-conforming `200` help context; empty when it is."""
    errors = conformance_errors(response, HELP, "get")
    if response.status_code != 200:
        errors.insert(0, f"getHelpContext answered {response.status_code}, not 200")
    return errors


def answer(w, who, query):
    response = request(w, who, query)
    assert help_errors(response) == []
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def problem(response, status, kind):
    call(response, HELP, "get")
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


@pytest.mark.parametrize("role", ["owner", "admin", "billing", "member"])
def test_every_tenant_role_gets_the_home_screen_s_context(w, role):
    assert answer(w, getattr(w, role), "area=shell&screen=home&locale=fr") == {
        "area": "shell",
        "screen": "home",
        "articles": [],
        "incident": None,
    }


@pytest.mark.parametrize("area", AREAS)
def test_every_console_area_is_answered_and_echoed(w, area):
    found = answer(w, w.member, "area=" + area)
    assert (found["area"], found["screen"]) == (area, None)


def test_no_service_level_is_stated_until_core_holds_one(w):
    """The console omits its support card without `sla.first_response_target_minutes`; a
    promise Core cannot keep is never put in a customer's mouth."""
    found = answer(w, w.owner, "area=support&screen=new-ticket&locale=en")
    assert "sla" not in found


@pytest.mark.parametrize("locale", ["fr", "en"])
def test_either_locale_is_accepted(w, locale):
    assert answer(w, w.owner, "area=domain&screen=verify&locale=" + locale)["screen"] == "verify"


def test_a_staff_token_is_refused_until_its_lane_exists(w):
    problem(request(w, w.staff, "area=shell"), 403, "forbidden")
    assert denials() == [("staff", None, TARGET, "support_ticket:read")]


def test_a_person_with_no_membership_is_refused_not_told_it_is_absent(w):
    problem(request(w, w.stranger, "area=shell"), 403, "forbidden")
    (denial,) = denials()
    assert denial == ("tenant", w.alpha.id, TARGET, "support_ticket:read")
    with connection.cursor() as cursor:
        cursor.execute("SELECT actor_id FROM audit_auditevent WHERE action = 'authz.denied'")
        assert cursor.fetchone()[0] is not None, "the refusal names no identity"


def test_without_a_token_nothing_is_said(w):
    problem(request(w, None, "area=shell"), 401, "unauthenticated")
    problem(request(w, None, "area=nowhere"), 401, "unauthenticated")


@pytest.mark.parametrize(
    "query",
    [
        "",
        "area=",
        "area=Shell",
        "area=nowhere",
        "screen=home",
        "area=shell&area=order",
        "area=shell&screen=",
        "area=shell&screen=Home",
        "area=shell&screen=home_page",
        "area=shell&screen=" + "a" * 65,
        "area=shell&screen=home&screen=list",
        "area=shell&locale=de",
        "area=shell&locale=FR",
        "area=shell&locale=",
        "area=shell&colour=red",
        "area=shell&" + "x" * 300,
        "area",
    ],
)
def test_a_query_that_is_not_the_contract_s_parameters_is_malformed(w, query):
    problem(request(w, w.owner, query), 400, "malformed-request")


def test_the_longest_screen_is_accepted_even_percent_encoded(w):
    assert answer(w, w.owner, "area=people&screen=" + "a" * 64)["screen"] == "a" * 64
    encoded = "area=federation&screen=" + "%61" * 64 + "&locale=fr"
    assert answer(w, w.owner, encoded)["screen"] == "a" * 64


def test_the_route_answers_only_get(w):
    response = request(w, w.owner, "area=shell", method="post")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"


# --- the mutation proofs -------------------------------------------------------------------------


@pytest.fixture
def without_the_route(monkeypatch):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if "help-context" not in str(p.pattern)]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, "the route is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()
    yield
    monkeypatch.undo()
    clear_url_caches()


def test_mutation_control_the_checks_pass_with_the_route_and_the_area_check(w):
    """The control: in the same world the answer check passes and an unknown area is refused,
    so the mutated runs below fail because of the mutation, not because of the world."""
    assert help_errors(request(w, w.owner, "area=shell")) == []
    assert request(w, w.owner, "area=nowhere").status_code == 400


def test_mutation_without_the_route_the_answer_check_fails(w, without_the_route):
    found = help_errors(request(w, w.owner, "area=shell"))
    assert found and found[0] == "getHelpContext answered 404, not 200", found


def test_mutation_an_area_check_that_admits_any_value_is_caught(w, monkeypatch):
    from apps.billing.api import help_context

    monkeypatch.setattr(help_context, "AREAS", help_context.AREAS | {"nowhere"})
    response = request(w, w.owner, "area=nowhere")
    # The malformed-query test expects 400 and gets 200; and the answer itself breaks the
    # contract's closed ConsoleArea enum, which the answer check names.
    assert response.status_code == 200, "the loosened area check did not reach the view"
    found = help_errors(response)
    assert found and any("nowhere" in error for error in found), found
