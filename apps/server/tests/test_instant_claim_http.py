"""Real signed HTTP claims, persisted assignments, replay and current authority."""

import json

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.urls import resolve
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import conformance_errors, w as w

from apps.workspaces.api.instant_claim import instant_claim
from apps.workspaces.models import Category, Channel, WarmPoolAllocation, Workspace
from apps.workspaces.warm_pool import build_instant_claim_plan, parse_instant_claim_request

PATH = "/api/v1/workspaces/instant-claim"
KEY = "00000000-0000-4000-8000-000000000074"
PAYLOAD = {
    "organizationName": "Synthetic organisation",
    "slug": "alpha",
    "hostingMode": "cloud",
    "templateId": "tech-studio",
}
pytestmark = pytest.mark.django_db(transaction=True)


def call(w, actor=None, payload=None, key=KEY):
    headers = {"HTTP_AUTHORIZATION": "Bearer " + (actor or w.owner).credential}
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(
        PATH, json.dumps(payload or PAYLOAD), content_type="application/json", **headers
    )
    assert not conformance_errors(response, "/workspaces/instant-claim", "post")
    return response


def prepare(w):
    plan = build_instant_claim_plan(parse_instant_claim_request(json.dumps(PAYLOAD).encode()))
    workspace = Workspace.objects.create(organisation=w.alpha)
    categories = {
        c["key"]: Category.objects.create(
            workspace=workspace,
            name=c["name"],
            template_key=c["db_template_key"],
            position=c["position"],
        )
        for c in plan["categories"]
    }
    for channel in plan["channels"]:
        values = {
            k: v
            for k, v in channel.items()
            if k not in {"category_key", "db_template_key", "template_key"}
        }
        Channel.objects.create(
            workspace=workspace,
            category=categories[channel["category_key"]],
            template_key=channel["db_template_key"],
            room_state="ready",
            **values,
        )
    return WarmPoolAllocation.objects.create(
        workspace=workspace,
        slug="alpha",
        plan=plan,
        workspace_url="https://alpha.example.org",
        invitation_url="https://alpha.example.org/invite?signed=synthetic",
        offer_mode="cloud-shared",
    )


def test_route_is_exposed():
    assert resolve(PATH).func is instant_claim


def test_empty_pool_is_explicit_and_same_key_can_retry_after_allocation(w, frozen_clock):
    response = call(w)
    assert response.status_code == 503
    assert response.json()["code"] == "warm_pool_unavailable"
    allocation = prepare(w)
    response = call(w)
    assert response.status_code == 201
    assert response.json()["workspaceId"] == str(allocation.workspace_id)
    allocation.refresh_from_db()
    assert allocation.claimed_at is not None
    replay = call(w)
    assert replay.status_code == 201
    assert replay.content == response.content
    assert replay["Idempotency-Replayed"] == "true"
    assert call(w, key="another-valid-idempotency-key-74").status_code == 409
    assert call(w, payload=PAYLOAD | {"organizationName": "Changed"}).status_code == 409


@pytest.mark.parametrize("actor", ["admin", "member", "billing", "stranger", "staff"])
def test_only_current_owner_can_claim(w, frozen_clock, actor):
    assert call(w, getattr(w, actor)).status_code == 403


def test_anonymous_claim_is_refused(w):
    assert w.client.post(PATH, "{}", content_type="application/json").status_code == 401


@pytest.mark.parametrize("key", [None, "short", "invalid key with spaces"])
def test_idempotency_key_is_required_and_validated(w, frozen_clock, key):
    assert call(w, key=key).status_code == 400


def test_invalid_payload_and_reserved_slug_are_refused(w, frozen_clock):
    assert call(w, payload=PAYLOAD | {"slug": "community"}).status_code == 400


def test_foreign_owner_cannot_take_allocation(w, frozen_clock):
    allocation = prepare(w)
    assert call(w, w.foreigner).status_code == 503
    allocation.refresh_from_db()
    assert allocation.claimed_at is None


def test_unready_rooms_and_mismatched_plan_never_claim(w, frozen_clock):
    allocation = prepare(w)
    Channel.objects.filter(workspace=allocation.workspace).update(room_state="pending")
    assert call(w).status_code == 503
    Channel.objects.filter(workspace=allocation.workspace).update(room_state="ready")
    assert call(w, payload=PAYLOAD | {"themeId": "real-black"}).status_code == 503
    allocation.refresh_from_db()
    assert allocation.claimed_at is None


def test_replay_rechecks_current_identity(w, frozen_clock):
    prepare(w)
    assert call(w).status_code == 201
    w.models.Identity.objects.filter(pk=w.owner.identity.pk).update(enabled=False)
    assert call(w).status_code == 403
