"""Closed HTTP decoding and operator input refusal controls without a database."""

import json
from types import SimpleNamespace

import pytest
from django.db import IntegrityError
from django.test import RequestFactory

from apps.workspaces.management.commands.configure_workspace_quotas import ceiling
from apps.workspaces.quota_http import QuotaRefusalMiddleware
from apps.workspaces.quotas import violation


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
