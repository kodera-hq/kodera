"""Closed HTTP decoding and operator input refusal controls without a database."""

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.db import IntegrityError
from django.test import RequestFactory
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.workspaces.management.commands.configure_workspace_quotas import ceiling
from apps.workspaces.quota_http import QuotaRefusalMiddleware
from apps.workspaces.quotas import violation


@pytest.mark.django_db(transaction=True)
def test_deferred_seat_quota_refusal_is_retained_before_outer_commit(world):
    from apps.identity.models import User
    from apps.orgs.models import Membership
    from apps.workspaces.models import WorkspaceQuota
    from apps.workspaces.quota_http import respond_once
    from core.api.idempotency import StoredResponse

    org, workspace, _, tokens = world
    WorkspaceQuota.objects.filter(workspace=workspace).update(seats=4)
    key = str(uuid4())

    def request(request_key):
        return RequestFactory().post(
            "/api/v1/synthetic/seat-quota",
            data="{}",
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )

    def effect():
        person = User.objects.create(email=f"{uuid4()}@example.org")
        Membership.objects.create(
            user=person,
            organisation=org,
            state="active",
            role="org_member",
            accepted_at=timezone.now(),
        )
        return StoredResponse(status=201, body=b"{}", content_type="application/json")

    def submit(request_key):
        return respond_once(
            request(request_key),
            handler=effect,
            request_id=str(uuid4()),
            issuer=org.issuer,
            subject=tokens[3].subject,
        )

    denied = submit(key)
    assert denied.status_code == 402
    assert Membership.objects.filter(organisation=org, state="active").count() == 4
    WorkspaceQuota.objects.filter(workspace=workspace).update(seats=5)
    replayed = submit(key)
    assert replayed.status_code == 402 and replayed["Idempotency-Replayed"] == "true"
    assert replayed.content == denied.content
    assert submit(str(uuid4())).status_code == 201
    assert Membership.objects.filter(organisation=org, state="active").count() == 5


def failure(detail, constraint="workspace_quota_exceeded"):
    error = IntegrityError("synthetic quota refusal")
    error.__cause__ = Exception("synthetic database guard")
    error.__cause__.diag = SimpleNamespace(
        constraint_name=constraint, message_detail=json.dumps(detail)
    )
    return error


DETAIL = {
    "quota_key": "pages",
    "status": 402,
    "limit": 1,
    "used": 1,
    "requested": 1,
    "remaining": 0,
}


@pytest.mark.parametrize(
    "change",
    [
        {"quota_key": "unknown"},
        {"status": 500},
        {"used": -1},
        {"limit": True},
        {"remaining": "0"},
        {"unexpected": 1},
    ],
)
def test_quota_diagnostic_mutations_are_not_trusted(change):
    assert violation(failure({**DETAIL, **change})) is None


def test_quota_refusal_http_has_typed_metadata_and_safe_registry_type():
    request = RequestFactory().post("/api/v1/fixture")
    middleware = QuotaRefusalMiddleware(lambda request: None)
    response = middleware.process_exception(request, failure(DETAIL))
    assert response.status_code == 402 and response["Cache-Control"] == "no-store"
    payload = json.loads(response.content)
    assert payload["type"] == "https://kodera.io/problems/subscription-required"
    assert payload["quota_key"] == "pages" and payload["remaining"] == 0
    response = middleware.process_exception(request, failure({}, "workspace_quota_missing"))
    assert response.status_code == 503 and response["Retry-After"] == "1"
    assert middleware.process_exception(request, failure(DETAIL, "unrelated_guard")) is None


@pytest.mark.parametrize("raw", ["-1", "+1", "01", "1.5", "", "UNLIMITED", str(2**63)])
def test_operator_quota_values_refuse_ambiguous_and_overflow_inputs(raw):
    with pytest.raises(ValueError, match="quota must be a nonnegative integer or unlimited"):
        ceiling(raw)


def test_operator_quota_limits_are_explicit():
    assert ceiling("unlimited") is None
    assert ceiling("0") == 0 and ceiling("100") == 100
