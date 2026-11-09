"""The billing reads over HTTP: real signed tokens, the real views, the disposable PostgreSQL.

Every response a test receives is checked against contracts/core-api.openapi.yaml by `call`,
problem documents included. The world is the workspace scenarios' (`w`): organisation alpha with
an owner, an admin, a billing member, a plain member and a person with no membership; bravo's
owner; and a staff token.
"""

import json
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer, token
from django.db import connection
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_orders import CGV, documents_published, verified
from test_workspace_onboarding import call, w as w

from apps.billing import catalogue, services
from apps.billing.models import Invoice, Order, PaymentLink, Price
from apps.billing.payments import services as payments
from apps.billing.services import Agreements, OrderRequest, TenantRequest
from apps.legal import services as legal

pytestmark = pytest.mark.django_db(transaction=True)

PLANS = "/catalog/plans"
PACKS = "/catalog/packs"
TIERS = "/catalog/capacity-tiers"
PRICES = "/catalog/prices"
ORDERS = "/organisations/{organisation_id}/orders"
ORDER = "/orders/{order_id}"
SUBSCRIPTIONS = "/organisations/{organisation_id}/subscriptions"
SUBSCRIPTION = "/subscriptions/{subscription_id}"
INVOICES = "/organisations/{organisation_id}/invoices"
INVOICE = "/invoices/{invoice_id}"
PAYMENT_LINK = "/invoices/{invoice_id}/payment-link"
PROBLEMS = "https://kodera.io/problems/"


def get(w, template, who=None, query="", **values):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    url = "/api/v1" + template.format(**{k: str(v) for k, v in values.items()})
    response = w.client.get(url + (("?" + query) if query else ""), **headers)
    return call(response, template, "get")


def body(response):
    return json.loads(response.content)


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert body(response)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Request-Id"]


@pytest.fixture
def placed(w):
    catalogue.load(catalogue.read(catalogue.PLACEHOLDER), allow_placeholder=True)
    return _place_for(
        w,
        w.alpha,
        "alpha-owner",
        key="order-key-000000001",
        pack_code="visio-docs",
        capacity_tier_code="M",
        billing_period="yearly",
    )


def _denials(organisation_id=None):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, metadata->>'required_scope' FROM audit_auditevent"
            " WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


# --- the public catalogue ---------------------------------------------------------------------


def test_the_catalogue_is_public_and_shows_what_is_offered(w, placed):
    plans = body(get(w, PLANS))
    assert [plan["code"] for plan in plans["data"]] == ["essentiel"]
    assert plans["data"][0]["packs"] == ["visio", "visio-docs"]
    assert plans["has_more"] is False and plans["next_cursor"] is None
    packs = {pack["code"]: pack for pack in body(get(w, PACKS))["data"]}
    assert packs["visio-docs"]["capacity_tier_codes"] == ["M"]
    assert packs["visio"]["apps"] == ["visio"]
    tiers = body(get(w, TIERS, query="pack_code=visio"))["data"]
    assert [tier["code"] for tier in tiers] == ["S"]
    assert "vm_shape" not in tiers[0]
    prices = body(get(w, PRICES, query="pack_code=visio-docs&billing_period=yearly"))["data"]
    assert [(p["capacity_tier_code"], p["amount_excl_vat"]) for p in prices] == [
        ("M", {"amount_minor": 300_000, "currency": "EUR"})
    ]


def test_an_anonymous_caller_sees_no_draft_or_retired_plan(w, placed):
    assert body(get(w, PLANS, query="state=draft"))["data"] == []
    assert body(get(w, PLANS, query="state=retired"))["data"] == []


def test_pages_follow_their_cursor_to_the_end(w, placed):
    seen, query = [], "limit=1"
    while True:
        page = body(get(w, PRICES, query=query))
        seen += [price["id"] for price in page["data"]]
        if not page["has_more"]:
            break
        query = "limit=1&cursor=" + page["next_cursor"]
    assert len(seen) == len(set(seen)) == 4


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=201",
        "limit=ten",
        "colour=red",
        "billing_period=weekly",
        "pack_code=a%20b",
        "cursor=forged",
        "limit=1&limit=2",
    ],
)
def test_a_query_the_operation_does_not_accept_is_malformed(w, placed, query):
    problem(get(w, PRICES, query=query), 400, "malformed-request")


def test_a_cursor_is_bound_to_its_operation_and_its_filters(w, placed):
    cursor = body(get(w, PRICES, query="limit=1"))["next_cursor"]
    problem(get(w, PACKS, query="cursor=" + cursor), 400, "malformed-request")
    problem(get(w, PRICES, query="pack_code=visio&cursor=" + cursor), 400, "malformed-request")
    tampered = cursor[:-1] + ("0" if cursor[-1] != "0" else "1")
    problem(get(w, PRICES, query="cursor=" + tampered), 400, "malformed-request")


# --- an organisation's rows -------------------------------------------------------------------


@pytest.mark.parametrize("role", ["owner", "admin", "billing"])
def test_the_billing_roles_read_the_order_its_subscription_and_its_invoice(w, placed, role):
    who = getattr(w, role)
    (order,) = body(get(w, ORDERS, who, organisation_id=w.alpha.id))["data"]
    assert order["id"] == str(placed.order.id)
    assert order["state"] == "placed"
    assert order["subscription_id"] == str(placed.subscription.id)
    assert order["invoice_id"] == str(placed.invoice.id)
    assert order["price_snapshot"]["total_incl_vat"] == {"amount_minor": 360_000, "currency": "EUR"}
    assert body(get(w, ORDER, who, order_id=placed.order.id)) == order
    (subscription,) = body(get(w, SUBSCRIPTIONS, who, organisation_id=w.alpha.id))["data"]
    assert subscription["state"] == "pending" and subscription["order_id"] == order["id"]
    assert body(get(w, SUBSCRIPTION, who, subscription_id=placed.subscription.id)) == subscription
    (invoice,) = body(get(w, INVOICES, who, organisation_id=w.alpha.id))["data"]
    assert invoice["number"].startswith("TST-") and invoice["state"] == "issued"
    assert invoice["amount_due"] == {"amount_minor": 360_000, "currency": "EUR"}
    assert "external_ref" not in invoice
    assert body(get(w, INVOICE, who, invoice_id=placed.invoice.id)) == invoice


def test_state_filters_narrow_the_lists(w, placed):
    assert (
        body(get(w, SUBSCRIPTIONS, w.owner, "state=active", organisation_id=w.alpha.id))["data"]
        == []
    )
    assert (
        len(body(get(w, INVOICES, w.owner, "state=issued", organisation_id=w.alpha.id))["data"])
        == 1
    )


def test_a_member_without_a_billing_role_is_refused_and_the_refusal_recorded(w, placed):
    problem(get(w, ORDERS, w.member, organisation_id=w.alpha.id), 403, "forbidden")
    problem(get(w, INVOICE, w.member, invoice_id=placed.invoice.id), 403, "forbidden")
    assert _denials() == [("tenant", "order:read"), ("tenant", "invoice:read")]


def test_a_staff_token_is_refused_until_its_lane_exists(w, placed):
    problem(get(w, ORDERS, w.staff, organisation_id=w.alpha.id), 403, "forbidden")
    assert _denials() == [("staff", "order:read")]


def test_another_organisations_rows_and_unknown_ids_read_as_absent(w, placed):
    problem(get(w, ORDERS, w.foreigner, organisation_id=w.alpha.id), 404, "not-found")
    problem(get(w, ORDER, w.foreigner, order_id=placed.order.id), 404, "not-found")
    problem(get(w, INVOICE, w.foreigner, invoice_id=placed.invoice.id), 404, "not-found")
    problem(get(w, ORDERS, w.stranger, organisation_id=w.alpha.id), 404, "not-found")
    problem(get(w, ORDER, w.owner, order_id=uuid4()), 404, "not-found")
    problem(get(w, SUBSCRIPTION, w.owner, subscription_id=uuid4()), 404, "not-found")


def test_without_a_token_nothing_is_said_about_an_identifier(w, placed):
    problem(get(w, ORDER, order_id=placed.order.id), 401, "unauthenticated")
    problem(get(w, ORDER, order_id=uuid4()), 401, "unauthenticated")
    problem(get(w, INVOICES, organisation_id=w.alpha.id), 401, "unauthenticated")


def test_the_payment_link_is_read_by_the_owner_and_billing_only(w, placed):
    problem(get(w, PAYMENT_LINK, w.owner, invoice_id=placed.invoice.id), 404, "not-found")
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=w.alpha.id
    ).link
    for who in (w.owner, w.billing):
        read = body(get(w, PAYMENT_LINK, who, invoice_id=placed.invoice.id))
        assert read["id"] == str(link.id) and read["state"] == "active"
        assert read["amount"] == {"amount_minor": 360_000, "currency": "EUR"}
        assert "provider" not in read
    problem(get(w, PAYMENT_LINK, w.admin, invoice_id=placed.invoice.id), 403, "forbidden")
    assert body(get(w, ORDER, w.owner, order_id=placed.order.id))["state"] == "awaiting_payment"


def test_a_list_route_answers_only_get(w, placed):
    response = w.client.delete(
        f"/api/v1/organisations/{w.alpha.id}/orders",
        HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
    )
    assert response.status_code == 405 and response.headers["Allow"] == "GET"


# --- isolation, and what an identifier discloses ----------------------------------------------


def _place_for(w, organisation, subject, key="order-key-000000002", **request):
    """An order placed through the service, with the legal documents, the DPA and a tenant."""
    documents_published()
    services.set_billing_profile(
        organisation_id=organisation.id,
        legal_name="Synthetic Customer SAS",
        address_line1="1 rue Synthétique",
        postal_code="75000",
        city="Paris",
        country="FR",
    )
    owner = verified(organisation.issuer, subject)
    values = {"pack_code": "visio", "capacity_tier_code": "S", "billing_period": "monthly"}
    values.update(request)
    dpa, _ = legal.generate_dpa(
        verified=owner,
        organisation_id=organisation.id,
        pack_code=values["pack_code"],
        locale="fr",
        tenant_id=None,
    )
    return services.place_order(
        verified=owner,
        organisation_id=organisation.id,
        idempotency_key=key,
        request=OrderRequest(
            **values,
            tenant=TenantRequest(slug=f"t{uuid4().hex[:12]}", name="Synthetic tenant"),
            agreements=Agreements(dpa_id=dpa.id, documents=(CGV,)),
        ),
        request_id="request-0001",
    )


def test_an_organisations_lists_and_reads_never_hold_another_organisations_rows(w, placed):
    other = _place_for(w, w.bravo, "bravo-owner")
    payments.create_payment_link(invoice_id=other.invoice.id, organisation_id=w.bravo.id)
    for template, key in ((ORDERS, "id"), (SUBSCRIPTIONS, "id"), (INVOICES, "id")):
        listed = [
            row[key] for row in body(get(w, template, w.owner, organisation_id=w.alpha.id))["data"]
        ]
        assert str(other.order.id) not in listed and str(other.invoice.id) not in listed
        assert str(other.subscription.id) not in listed and len(listed) == 1
    problem(get(w, ORDER, w.owner, order_id=other.order.id), 404, "not-found")
    problem(get(w, INVOICE, w.owner, invoice_id=other.invoice.id), 404, "not-found")
    problem(get(w, PAYMENT_LINK, w.owner, invoice_id=other.invoice.id), 404, "not-found")
    problem(get(w, SUBSCRIPTION, w.owner, subscription_id=other.subscription.id), 404, "not-found")


def test_a_cursor_issued_for_one_organisation_is_refused_for_another(w, placed):
    # A second order once the first is cancelled: an organisation holds one live order at most.
    Order.objects.filter(id=placed.order.id).update(state="cancelled")
    _place_for(w, w.alpha, "alpha-owner", key="order-key-000000003")
    page = body(get(w, ORDERS, w.owner, "limit=1", organisation_id=w.alpha.id))
    assert page["has_more"] is True
    _place_for(w, w.bravo, "bravo-owner")
    problem(
        get(
            w,
            ORDERS,
            w.foreigner,
            "limit=1&cursor=" + page["next_cursor"],
            organisation_id=w.bravo.id,
        ),
        400,
        "malformed-request",
    )


def test_a_draft_invoice_is_never_listed_or_read(w, placed):
    draft = Invoice.objects.create(
        organisation_id=w.alpha.id,
        vat_regime="fr_standard",
        issuer_legal_name="x",
        issuer_address="x",
        issuer_siren="000000000",
        issuer_vat_number="FR00000000000",
        customer_legal_name="x",
        customer_address_line1="x",
        customer_postal_code="x",
        customer_city="x",
        customer_country="FR",
    )
    listed = [
        row["id"] for row in body(get(w, INVOICES, w.owner, organisation_id=w.alpha.id))["data"]
    ]
    assert str(draft.id) not in listed and listed == [str(placed.invoice.id)]
    problem(get(w, INVOICE, w.owner, invoice_id=draft.id), 404, "not-found")


def test_a_payment_link_is_served_only_while_unexpired_and_owed(w, placed):
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=w.alpha.id
    ).link
    PaymentLink.objects.filter(id=link.id).update(expires_at=timezone.now())
    problem(get(w, PAYMENT_LINK, w.owner, invoice_id=placed.invoice.id), 404, "not-found")
    PaymentLink.objects.filter(id=link.id).update(expires_at=timezone.now() + timedelta(days=1))
    Invoice.objects.filter(id=placed.invoice.id).update(
        amount_paid_minor=placed.invoice.total_incl_vat_minor
    )
    problem(get(w, PAYMENT_LINK, w.owner, invoice_id=placed.invoice.id), 404, "not-found")


def test_the_catalogue_lists_only_the_price_an_order_would_use_now(w, placed):
    current = Price.objects.get(pack__code="visio", billing_period="monthly")
    newer = Price.objects.create(
        plan=current.plan,
        pack=current.pack,
        capacity_tier=current.capacity_tier,
        billing_period="monthly",
        amount_minor=12_000,
        valid_from=timezone.now() - timedelta(minutes=1),
    )
    Price.objects.create(
        plan=current.plan,
        pack=current.pack,
        capacity_tier=current.capacity_tier,
        billing_period="monthly",
        amount_minor=99_999,
        valid_from=timezone.now() + timedelta(days=30),
    )
    listed = body(get(w, PRICES, query="pack_code=visio&billing_period=monthly"))["data"]
    assert [price["id"] for price in listed] == [str(newer.id)]


@pytest.mark.parametrize("known", [True, False])
def test_an_identifier_discloses_nothing_to_an_unknown_identity_or_a_staff_token(w, placed, known):
    ghost = SimpleNamespace(credential=token(w.signer, w.alpha.issuer, subject="ghost-subject"))
    order_id = placed.order.id if known else uuid4()
    unknown = get(w, ORDER, ghost, order_id=order_id)
    problem(unknown, 403, "identity-unknown")
    assert "WWW-Authenticate" not in unknown.headers, "identity-unknown asked to re-authenticate"
    problem(get(w, ORDER, w.staff, order_id=order_id), 403, "forbidden")


def test_an_unauthenticated_list_is_401_whatever_its_query(w, placed):
    problem(get(w, ORDERS, None, "limit=0", organisation_id=w.alpha.id), 401, "unauthenticated")
