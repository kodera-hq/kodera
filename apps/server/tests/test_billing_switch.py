"""The billing switch (docs/specs/QUICK_WORKSPACE.md §2): `KODERA_BILLING_ENABLED`.

Unset or `true`, Core bills as it always has. `false`, nothing that charges runs: `placeOrder` and
`createPaymentLink` answer `409 billing-disabled` and `settle_complimentary_order` exits non-zero,
each writing nothing, and the status summary tells the console. Real signed tokens, the real views
and the replay store, the disposable PostgreSQL; every response is checked against the contract by
`call`.
"""

import json
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.exceptions import ImproperlyConfigured
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_http import placed as placed
from test_billing_orders import offer, place as place_offer, world
from test_complimentary_order import REASON, rows, run, staff
from test_invoice_actions_http import LINK, fake as fake, post as post_link
from test_place_order_http import ORDERS, generate, order_body, place, ready as ready, url
from test_tenant_reads_http import SUMMARY, get
from test_workspace_onboarding import call, w as w

from apps.billing import complimentary, services, switch
from apps.billing.models import Invoice, Order, PaymentLink
from apps.billing.payments import services as payments
from apps.legal.models import Acceptance
from apps.tenancy.models import Tenant
from config.environment import billing_enabled
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)

PROBLEMS = "https://kodera.io/problems/"


def disabled(response):
    """A `409 billing-disabled`, as the contract declares it, never cached."""
    assert response.status_code == 409, response.content
    assert json.loads(response.content)["type"] == PROBLEMS + "billing-disabled"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Request-Id"]


def counts():
    return (
        Order.objects.count(),
        Tenant.objects.count(),
        Invoice.objects.count(),
        Acceptance.objects.count(),
        PaymentLink.objects.count(),
        IdempotencyRecord.objects.count(),
    )


def summary(w, who):
    response = get(w, SUMMARY, who, organisation_id=w.alpha.id)
    assert response.status_code == 200, response.content
    found = json.loads(response.content)
    return found["billing_enabled"], found["workspace_pack_code"]


# --- the setting ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({}, True),
        ({"KODERA_BILLING_ENABLED": ""}, True),
        ({"KODERA_BILLING_ENABLED": "true"}, True),
        ({"KODERA_BILLING_ENABLED": "false"}, False),
    ],
)
def test_unset_or_true_bills_and_only_false_turns_billing_off(environment, expected):
    assert billing_enabled(environment) is expected


@pytest.mark.parametrize("value", ["yes", "no", "True", "FALSE", "0", "1", " false", "off"])
def test_any_other_value_stops_the_process_naming_the_variable(value):
    with pytest.raises(ImproperlyConfigured, match="KODERA_BILLING_ENABLED"):
        billing_enabled({"KODERA_BILLING_ENABLED": value})


def test_the_test_profile_bills_by_default():
    # The test profile bills whatever the environment says (config/settings/test.py), so the
    # billing suites run unchanged; the parser's default is proven above.
    assert switch.billing_enabled() is True


# --- billing on: nothing a client sees changes but the summary's two members ---------------------


def test_with_billing_on_the_summary_says_so_and_names_no_pack(w):
    assert summary(w, w.member) == (True, None)


def test_with_billing_on_the_owner_still_places_an_order(ready):
    dpa = json.loads(generate(ready).content)
    response = place(ready, order_body(dpa["id"]))
    assert response.status_code == 201, response.content


# --- billing off ---------------------------------------------------------------------------------


def test_with_billing_off_the_summary_names_the_unbilled_pack(w, settings):
    settings.KODERA_BILLING_ENABLED = False
    assert summary(w, w.member) == (False, "workspace")


def test_with_billing_off_an_order_is_refused_and_nothing_is_written(ready, settings):
    dpa = json.loads(generate(ready).content)
    settings.KODERA_BILLING_ENABLED = False
    before = counts()

    disabled(place(ready, order_body(dpa["id"])))

    assert counts() == before


def test_the_refusal_is_not_stored_so_billing_on_again_judges_the_same_request_afresh(
    ready, settings
):
    dpa = json.loads(generate(ready).content)
    settings.KODERA_BILLING_ENABLED = False
    disabled(place(ready, order_body(dpa["id"]), key="00000000-0000-4000-8000-000000000302"))

    settings.KODERA_BILLING_ENABLED = True
    again = place(ready, order_body(dpa["id"]), key="00000000-0000-4000-8000-000000000302")

    assert again.status_code == 201, again.content
    assert again.headers.get("Idempotency-Replayed") != "true"
    assert Order.objects.filter(organisation_id=ready.alpha.id).count() == 1


def test_an_order_stored_before_billing_was_turned_off_is_replayed_after(ready, settings):
    dpa = json.loads(generate(ready).content)
    first = place(ready, order_body(dpa["id"]), key="00000000-0000-4000-8000-000000000303")
    assert first.status_code == 201, first.content
    settings.KODERA_BILLING_ENABLED = False
    before = counts()

    again = place(ready, order_body(dpa["id"]), key="00000000-0000-4000-8000-000000000303")

    assert again.status_code == 201, again.content
    assert again.headers["Idempotency-Replayed"] == "true"
    assert json.loads(again.content) == json.loads(first.content)
    assert counts() == before


def test_with_billing_off_a_body_it_cannot_read_is_refused_by_the_switch_not_stored(
    ready, settings
):
    # The route refuses before the replay store runs the step: without that, the body's 400 would
    # be stored against the key and replayed once billing is on.
    settings.KODERA_BILLING_ENABLED = False
    before = counts()
    disabled(place(ready, None, raw="not json", key="00000000-0000-4000-8000-000000000304"))
    assert counts() == before


def test_with_billing_off_the_caller_is_judged_first(ready, settings):
    dpa = json.loads(generate(ready).content)
    settings.KODERA_BILLING_ENABLED = False
    before = counts()
    payload = order_body(dpa["id"])

    # A member without the owner's role, and a stranger, are answered as billing on answers them:
    # neither learns anything about the switch.
    forbidden = place(ready, payload, who=ready.billing)
    assert forbidden.status_code == 403, forbidden.content
    stranger = place(ready, payload, who=ready.stranger)
    assert stranger.status_code == 404, stranger.content
    anonymous = ready.client.post(
        url(ORDERS, organisation_id=ready.alpha.id),
        data=json.dumps(payload),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="00000000-0000-4000-8000-000000000301",
    )
    assert call(anonymous, ORDERS, "post").status_code == 401

    assert counts() == before


def test_with_billing_off_no_payment_link_is_created_and_no_provider_asked(
    w, placed, fake, settings
):
    settings.KODERA_BILLING_ENABLED = False
    before = counts()

    response = call(post_link(w, w.owner, placed.invoice.id), LINK, "post")

    disabled(response)
    assert counts() == before
    assert fake.links == []


def test_a_link_stored_before_billing_was_turned_off_is_replayed_after(w, placed, fake, settings):
    first = call(post_link(w, w.owner, placed.invoice.id), LINK, "post")
    assert first.status_code == 201, first.content
    settings.KODERA_BILLING_ENABLED = False
    before = counts()

    again = call(post_link(w, w.owner, placed.invoice.id), LINK, "post")

    assert again.status_code == 201, again.content
    assert again.headers["Idempotency-Replayed"] == "true"
    assert counts() == before
    assert len(fake.links) == 1


def test_with_billing_off_a_link_body_it_cannot_read_is_refused_not_stored(
    w, placed, fake, settings
):
    settings.KODERA_BILLING_ENABLED = False
    before = counts()
    disabled(call(post_link(w, w.owner, placed.invoice.id, {"colour": "red"}), LINK, "post"))
    assert counts() == before
    assert fake.links == []


def test_with_billing_off_a_member_without_the_link_role_is_still_refused(
    w, placed, fake, settings
):
    settings.KODERA_BILLING_ENABLED = False
    response = call(post_link(w, w.admin, placed.invoice.id), LINK, "post")
    assert response.status_code == 403, response.content
    assert fake.links == []


def test_with_billing_off_no_order_is_settled_as_complimentary(capsys, settings):
    w = world()
    operator = staff("operator")
    placed = place_offer(w, offer())
    before = rows(placed)
    settings.KODERA_BILLING_ENABLED = False

    code, out, err = run(
        capsys,
        "--staff-identity",
        str(operator.id),
        "--organisation",
        w.organisation.slug,
        "--order",
        str(placed.order.id),
        "--reason",
        REASON,
    )

    assert code != 0, out
    assert "billing is disabled" in err and "nothing written" in err
    assert rows(placed) == before


def test_the_services_refuse_too_so_no_future_caller_charges_past_the_switch(
    w, placed, fake, settings
):
    settings.KODERA_BILLING_ENABLED = False
    before = counts()
    with pytest.raises(switch.BillingDisabledError):
        payments.issue_link(invoice_id=placed.invoice.id, organisation_id=w.alpha.id)
    with pytest.raises(switch.BillingDisabledError):
        complimentary.settle_complimentary(
            principal=None, organisation_id=w.alpha.id, order_id=uuid4(), reason="any"
        )
    with pytest.raises(switch.BillingDisabledError):
        # Refused before it reads a single argument.
        services.place_order(
            verified=None, organisation_id=w.alpha.id, idempotency_key="k", request=None
        )
    assert counts() == before
    assert fake.links == []
