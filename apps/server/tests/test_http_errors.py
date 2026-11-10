"""Resolver errors and middleware short circuits retain safe correlation."""

from uuid import UUID

import pytest
from django.http import HttpResponseNotAllowed
from django.test import Client, RequestFactory, override_settings
from django.urls import path

from core.api.edge import CallerRequestIdMiddleware


def crash(request):
    raise RuntimeError("private diagnostic must not reach the response")


urlpatterns = [path("crash", crash)]
handler404 = "core.api.errors.not_found"
handler500 = "core.api.errors.server_error"


@pytest.mark.parametrize("urlconf", ["config.urls", "config.customer_urls", __name__])
@pytest.mark.parametrize("caller", [None, "safe-correlation", "unsafe/id"])
def test_unrouted_path_is_a_correlated_json_problem(urlconf, caller):
    with override_settings(ROOT_URLCONF=urlconf, DEBUG=False):
        client = Client(raise_request_exception=False)
        response = client.get("/unrouted-path", **({"HTTP_X_REQUEST_ID": caller} if caller else {}))
    assert response.status_code == 404
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["request_id"] == response["X-Request-Id"]
    if caller == "safe-correlation":
        assert response["X-Request-Id"] == "c-safe-correlation"
    else:
        assert UUID(response["X-Request-Id"]).version == 7


@override_settings(ROOT_URLCONF=__name__, DEBUG=False)
def test_uncaught_exception_is_safe_and_correlated():
    response = Client(raise_request_exception=False).get("/crash")
    assert response.status_code == 500
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["request_id"] == response["X-Request-Id"]
    assert b"private diagnostic" not in response.content


def test_middleware_response_405_has_request_id():
    response = CallerRequestIdMiddleware(lambda request: HttpResponseNotAllowed(["GET"]))(
        RequestFactory().post("/method")
    )
    assert response.status_code == 405
    assert UUID(response["X-Request-Id"]).version == 7
