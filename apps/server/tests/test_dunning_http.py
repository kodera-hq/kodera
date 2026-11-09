"""getDunning over HTTP: real signed tokens, the real view, the disposable PostgreSQL.

`GET /organisations/{organisation_id}/dunning` is read by the console's Invoices screen on every
visit. Every response a test receives is checked against contracts/core-api.openapi.yaml by
`call`, problem documents included. An organisation with no subscription and no invoice is
`current`, never `404`: a `404` there is what the console shows as a permanent error. The world is
the workspace scenarios' (`w`); `placed` is an order placed through the service, with its pending
subscription and its issued invoice.

The last test is the mutation proof: with the route taken out of the customer urlconf, the check
the other tests rely on names the missing route.
"""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection, transaction
from django.urls import clear_url_caches
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_http import _place_for, placed as placed
from test_workspace_onboarding import call, conformance_errors, w as w

from apps.billing import selectors
from apps.billing.models import Invoice, Order, Subscription

pytestmark = pytest.mark.django_db(transaction=True)

DUNNING = "/organisations/{organisation_id}/dunning"
PROBLEMS = "https://kodera.io/problems/"
CURRENT: dict[str, object] = {
    "state": "current",
    "oldest_overdue_invoice_id": None,
    "days_overdue": None,
    "amount_due": None,
    "hold_until": None,
    "steps": [],
}


def request(w, who, organisation_id, method="get"):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    return getattr(w.client, method)(f"/api/v1/organisations/{organisation_id}/dunning", **headers)


def dunning_errors(response):
    """Why the response is not a contract-conforming `200` dunning view; empty when it is."""
    errors = conformance_errors(response, DUNNING, "get")
    if response.status_code != 200:
        errors.insert(0, f"getDunning answered {response.status_code}, not 200")
    return errors


def view(w, who, organisation_id):
    response = request(w, who, organisation_id)
    assert dunning_errors(response) == []
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def problem(response, status, kind):
    call(response, DUNNING, "get")
    assert response.status_code == status, response.content
    assert json.loads(response.content)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Request-Id"]


def overdue(placed, *, days=None, due_at=None):
    """The order's invoice made overdue, due `days` and an hour ago (or at `due_at`). An issued
    invoice never changes (`billing_invoice_immutable`), so the row is set past the guard, as
    tests/test_billing_orders.py sets up its states."""
    due = timezone.now() - timedelta(days=days, hours=1) if due_at is None else due_at
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SET LOCAL session_replication_role = replica")
        cursor.execute(
            "UPDATE billing_invoice SET state = 'overdue', due_at = %s WHERE id = %s",
            [due, placed.invoice.id],
        )
    assert Invoice.objects.filter(id=placed.invoice.id, state="overdue", due_at=due).exists()


def denials():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, organisation_id, target_urn, metadata->>'required_scope'"
            " FROM audit_auditevent WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


def second_order(w):
    """A second order of alpha's, once the first is no longer live: an organisation holds one
    live order at most, and nothing limits it to one subscription."""
    Order.objects.filter(organisation_id=w.alpha.id).update(state="cancelled")
    return _place_for(w, w.alpha, "alpha-owner", key="order-key-000000009")


@pytest.mark.parametrize("role", ["owner", "admin", "billing"])
def test_an_organisation_with_no_subscription_or_invoice_is_current(w, role):
    assert view(w, getattr(w, role), w.alpha.id) == CURRENT


def test_a_pending_subscription_with_an_issued_invoice_is_current(w, placed):
    assert view(w, w.owner, w.alpha.id) == CURRENT


def test_a_past_due_subscription_names_its_oldest_overdue_invoice(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="past_due")
    overdue(placed, days=12)
    assert view(w, w.billing, w.alpha.id) == {
        **CURRENT,
        "state": "past_due",
        "oldest_overdue_invoice_id": str(placed.invoice.id),
        "days_overdue": 12,
    }
    # A newer invoice, issued later, overdue for fewer days: the oldest is still named.
    later = second_order(w)
    overdue(later, days=3)
    named = view(w, w.billing, w.alpha.id)
    assert (named["oldest_overdue_invoice_id"], named["days_overdue"]) == (
        str(placed.invoice.id),
        12,
    )


def test_the_oldest_overdue_invoice_is_the_one_due_first(w, placed):
    later = second_order(w)
    overdue(placed, days=3)
    # Issued after the first, but due before it: the ladder counts from the due date.
    overdue(later, days=20)
    assert view(w, w.owner, w.alpha.id)["oldest_overdue_invoice_id"] == str(later.invoice.id)


def test_a_newer_subscription_in_good_standing_never_hides_a_suspended_one(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="suspended")
    overdue(placed, days=40)
    newer = second_order(w)
    assert Subscription.objects.get(id=newer.subscription.id).state == "pending"
    found = view(w, w.owner, w.alpha.id)
    assert (found["state"], found["oldest_overdue_invoice_id"]) == (
        "suspended",
        str(placed.invoice.id),
    )
    Subscription.objects.filter(id=newer.subscription.id).update(state="past_due")
    assert view(w, w.owner, w.alpha.id)["state"] == "suspended"


def test_a_past_due_subscription_with_no_overdue_invoice_names_none(w, placed):
    # The state a payment reversed before the due date leaves: the subscription past due, its
    # invoice still issued and not yet overdue.
    Subscription.objects.filter(id=placed.subscription.id).update(state="past_due")
    assert view(w, w.owner, w.alpha.id) == {**CURRENT, "state": "past_due"}


def test_a_cancelled_subscription_puts_nothing_on_the_ladder(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(
        state="cancelled", cancelled_at=timezone.now()
    )
    overdue(placed, days=5)
    found = view(w, w.owner, w.alpha.id)
    assert (found["state"], found["oldest_overdue_invoice_id"]) == (
        "current",
        str(placed.invoice.id),
    )


def test_a_suspended_subscription_is_suspended(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="suspended")
    overdue(placed, days=40)
    found = view(w, w.owner, w.alpha.id)
    assert (found["state"], found["days_overdue"]) == ("suspended", 40)


def test_an_invoice_not_yet_due_counts_no_day_overdue(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="past_due")
    overdue(placed, due_at=timezone.now() + timedelta(days=2))
    assert view(w, w.owner, w.alpha.id)["days_overdue"] == 0


def test_another_organisation_s_dunning_never_shows(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="past_due")
    overdue(placed, days=3)
    assert view(w, w.foreigner, w.bravo.id) == CURRENT


def test_a_member_without_a_billing_role_is_refused_and_the_refusal_recorded(w):
    problem(request(w, w.member, w.alpha.id), 403, "forbidden")
    target = f"urn:kodera:organisation:{w.alpha.id}"
    assert denials() == [("tenant", w.alpha.id, target, "subscription:read")]


def test_a_staff_token_is_refused_until_its_lane_exists(w):
    problem(request(w, w.staff, w.alpha.id), 403, "forbidden")
    target = f"urn:kodera:organisation:{w.alpha.id}"
    assert denials() == [("staff", None, target, "subscription:read")]


def test_an_organisation_the_caller_is_not_a_member_of_reads_as_absent(w):
    absent = uuid4()
    answers = [
        request(w, w.stranger, w.alpha.id),
        request(w, w.foreigner, w.alpha.id),
        request(w, w.owner, w.bravo.id),
        request(w, w.owner, absent),
    ]
    for response in answers:
        problem(response, 404, "not-found")
    # An existing organisation and an absent one read alike, and a 404 is not a recorded denial.
    shape = [{k: v for k, v in json.loads(r.content).items() if k != "request_id"} for r in answers]
    assert shape[2] == shape[3]
    assert denials() == []


def test_without_a_token_nothing_is_said(w):
    problem(request(w, None, w.alpha.id), 401, "unauthenticated")
    problem(request(w, None, uuid4()), 401, "unauthenticated")


def test_the_route_answers_only_get(w):
    response = request(w, w.owner, w.alpha.id, method="post")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"


@pytest.fixture
def without_the_route(monkeypatch):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if "/dunning" not in str(p.pattern)]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, "the dunning route is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()
    yield
    monkeypatch.undo()
    clear_url_caches()


def test_mutation_control_the_check_passes_with_the_route(w):
    """The control: in the same world, the check passes with the route, so the mutated runs below
    fail because of the mutation, not because of the world."""
    assert dunning_errors(request(w, w.owner, w.alpha.id)) == []


def test_mutation_without_the_route_the_view_check_fails(w, without_the_route):
    found = dunning_errors(request(w, w.owner, w.alpha.id))
    assert found and found[0] == "getDunning answered 404, not 200", found


def test_mutation_a_view_with_nothing_to_say_for_an_organisation_owing_nothing_fails(
    w, monkeypatch
):
    """The staging defect's other shape: the route exists but an organisation with no subscription
    and no invoice has no view, which the read answers `404`."""
    monkeypatch.setattr(selectors, "dunning_view", lambda organisation_id: None)
    found = dunning_errors(request(w, w.owner, w.alpha.id))
    assert found and found[0] == "getDunning answered 404, not 200", found
