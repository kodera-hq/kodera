"""The tenant reads and the shell's status summary over HTTP: real signed tokens, the real views,
the disposable PostgreSQL. Every response is checked against contracts/core-api.openapi.yaml by
`call`, problem documents included. The world is the workspace scenarios' (`w`)."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_http import _place_for, placed as placed
from test_workspace_onboarding import call, w as w

from apps.billing.models import Order, Subscription
from apps.engine_intents import services as agents
from apps.engine_intents.models import EngineAgentCredential
from apps.tenancy.models import Tenant

pytestmark = pytest.mark.django_db(transaction=True)

TENANTS = "/organisations/{organisation_id}/tenants"
TENANT = "/tenants/{tenant_id}"
STATUS = "/tenants/{tenant_id}/status"
SUMMARY = "/organisations/{organisation_id}/status-summary"
PROBLEMS = "https://kodera.io/problems/"


def get(w, template, who, query="", **values):
    url = "/api/v1" + template.format(**{k: str(v) for k, v in values.items()})
    response = w.client.get(
        url + (("?" + query) if query else ""), HTTP_AUTHORIZATION="Bearer " + who.credential
    )
    return call(response, template, "get")


def body(response, status=200):
    assert response.status_code == status, response.content
    return json.loads(response.content)


def problem(response, status, kind):
    assert body(response, status)["type"] == PROBLEMS + kind


def tenant(organisation, slug, *, status="active", apps=("visio", "messaging"), age=0):
    row = Tenant.objects.create(
        organisation=organisation,
        slug=slug,
        name=slug.title(),
        status=status,
        status_changed_at=timezone.now(),
        pack_code="visio",
        capacity_tier_code="S",
        apps=list(apps),
    )
    if age:
        Tenant.objects.filter(id=row.id).update(created_at=timezone.now() - timedelta(days=age))
    return row


def test_every_member_lists_the_organisation_s_tenants_newest_first(w):
    older = tenant(w.alpha, "alpha-old", status="ordered", age=2)
    newer = tenant(w.alpha, "alpha-team")
    tenant(w.bravo, "bravo-team")
    for who in (w.owner, w.admin, w.billing, w.member):
        page = body(get(w, TENANTS, who, organisation_id=w.alpha.id))
        assert [row["id"] for row in page["data"]] == [str(newer.id), str(older.id)]
    first = body(get(w, TENANTS, w.member, organisation_id=w.alpha.id))["data"][0]
    assert first["default_urls"] == {
        "visio": "https://alpha-team.visio.customer.test",
        "messaging": "https://alpha-team.espace.customer.test",
    }
    ordered = body(get(w, TENANTS, w.owner, query="status=ordered", organisation_id=w.alpha.id))
    assert [row["slug"] for row in ordered["data"]] == ["alpha-old"]


def test_a_tenant_list_follows_its_cursor(w):
    for n in range(3):
        tenant(w.alpha, f"alpha-{n}", age=3 - n)
    seen, query = [], "limit=1"
    while True:
        page = body(get(w, TENANTS, w.owner, query=query, organisation_id=w.alpha.id))
        seen += [row["slug"] for row in page["data"]]
        if not page["has_more"]:
            break
        query = "limit=1&cursor=" + page["next_cursor"]
    assert seen == ["alpha-2", "alpha-1", "alpha-0"]


def test_the_status_view_gives_each_app_its_url_and_state(w):
    row = tenant(w.alpha, "alpha-team", apps=("visio", "docs", "messaging"))
    view = body(get(w, STATUS, w.member, tenant_id=row.id))
    # docs has no URL template in this environment, so it has no launch link.
    assert [(app["code"], app["url"], app["state"]) for app in view["apps"]] == [
        ("visio", "https://alpha-team.visio.customer.test", "live"),
        ("messaging", "https://alpha-team.espace.customer.test", "live"),
    ]
    assert view["status"] == "active" and view["provisioning_steps"] == []
    assert view["agent"] == {
        "stale": True,
        "last_heartbeat_at": None,
        "agent_version": None,
        "maintenance": False,
    }
    single = body(get(w, TENANT, w.member, tenant_id=row.id))
    assert single["id"] == str(row.id) and single["apps"] == ["visio", "docs", "messaging"]


@pytest.mark.parametrize(
    ("status", "state"),
    [
        ("ordered", "pending"),
        ("provisioning", "pending"),
        ("maintenance", "maintenance"),
        ("suspended", "unavailable"),
        ("failed", "unavailable"),
    ],
)
def test_an_app_s_state_follows_its_tenant_s_status(w, status, state):
    row = tenant(w.alpha, "alpha-team", status=status, apps=("visio",))
    view = body(get(w, STATUS, w.owner, tenant_id=row.id))
    assert [app["state"] for app in view["apps"]] == [state]


def test_the_agent_is_fresh_until_three_heartbeats_are_missed(w):
    row = tenant(w.alpha, "alpha-team")
    credential_id, _ = agents.issue_credential(organisation_id=w.alpha.id, tenant_ref=row.id)
    seen = timezone.now() - timedelta(seconds=30)
    EngineAgentCredential.objects.filter(id=credential_id).update(last_seen_at=seen)
    agent = body(get(w, STATUS, w.owner, tenant_id=row.id))["agent"]
    assert agent["stale"] is False and agent["last_heartbeat_at"] is not None
    EngineAgentCredential.objects.filter(id=credential_id).update(
        last_seen_at=timezone.now() - timedelta(seconds=181)
    )
    assert body(get(w, STATUS, w.owner, tenant_id=row.id))["agent"]["stale"] is True
    agents.revoke_credential(credential_id=credential_id)
    EngineAgentCredential.objects.filter(id=credential_id).update(last_seen_at=timezone.now())
    assert body(get(w, STATUS, w.owner, tenant_id=row.id))["agent"]["stale"] is True


def test_the_summary_names_the_newest_live_tenant_and_its_overall_state(w):
    summary = body(get(w, SUMMARY, w.member, organisation_id=w.alpha.id))
    assert (summary["tenant_id"], summary["overall"]) == (None, "operational")
    assert summary["billing"]["dunning_state"] == "current"
    tenant(w.alpha, "alpha-old", age=2)
    newest = tenant(w.alpha, "alpha-team", status="maintenance")
    tenant(w.alpha, "alpha-gone", status="deleted")
    Tenant.objects.filter(slug="alpha-gone").update(created_at=timezone.now() + timedelta(1))
    summary = body(get(w, SUMMARY, w.member, organisation_id=w.alpha.id))
    assert (summary["tenant_id"], summary["overall"]) == (str(newest.id), "maintenance")
    Tenant.objects.filter(id=newest.id).update(status="suspended")
    summary = body(get(w, SUMMARY, w.member, organisation_id=w.alpha.id))
    assert summary["overall"] == "major_outage"


def test_the_summary_s_dunning_state_is_the_most_severe_subscription_s(w, placed):
    Subscription.objects.filter(id=placed.subscription.id).update(state="suspended")
    # A second order once the first is no longer live: its subscription is newer and pending.
    Order.objects.filter(organisation_id=w.alpha.id).update(state="cancelled")
    newer = _place_for(w, w.alpha, "alpha-owner", key="order-key-000000009")
    assert Subscription.objects.get(id=newer.subscription.id).state == "pending"
    summary = body(get(w, SUMMARY, w.member, organisation_id=w.alpha.id))
    assert summary["billing"]["dunning_state"] == "suspended"


def test_another_organisation_s_tenant_is_not_found(w):
    foreign = tenant(w.bravo, "bravo-team")
    problem(get(w, TENANT, w.owner, tenant_id=foreign.id), 404, "not-found")
    problem(get(w, STATUS, w.owner, tenant_id=foreign.id), 404, "not-found")
    problem(get(w, TENANT, w.owner, tenant_id=uuid4()), 404, "not-found")
    problem(get(w, TENANTS, w.owner, organisation_id=w.bravo.id), 404, "not-found")
    problem(get(w, SUMMARY, w.owner, organisation_id=w.bravo.id), 404, "not-found")


def test_a_person_with_no_membership_and_a_staff_token_are_refused(w):
    row = tenant(w.alpha, "alpha-team")
    problem(get(w, TENANTS, w.stranger, organisation_id=w.alpha.id), 404, "not-found")
    problem(get(w, STATUS, w.stranger, tenant_id=row.id), 404, "not-found")
    problem(get(w, TENANTS, w.staff, organisation_id=w.alpha.id), 403, "forbidden")
    problem(get(w, SUMMARY, w.staff, organisation_id=w.alpha.id), 403, "forbidden")


@pytest.mark.parametrize("query", ["status=unknown", "limit=0", "colour=red", "cursor=forged"])
def test_a_tenant_list_query_it_does_not_accept_is_malformed(w, query):
    problem(
        get(w, TENANTS, w.owner, query=query, organisation_id=w.alpha.id), 400, "malformed-request"
    )
