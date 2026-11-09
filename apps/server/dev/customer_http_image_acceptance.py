# ruff: noqa: S101 -- Explicitly selected pytest acceptance uses assertions.
"""External owned image probes; selection requires actual controller-generated input."""

import json
import os
from http.client import HTTPConnection
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def image_input():
    supplied = os.environ.get("KODERA_HTTP_ACCEPTANCE_INPUT")
    assert supplied, (
        "actual owned HTTP image input was not supplied; image acceptance is unexecuted"
    )
    with Path(supplied).open("rb") as source:
        raw = source.read(65537)
    assert len(raw) <= 65536, "owned HTTP image fixture input exceeds its bound"
    try:
        value = json.loads(raw)
        required = {
            "api_port",
            "access_token",
            "id_token",
            "refresh_token",
            "wrong_audience",
            "expected_me",
        }
        assert isinstance(value, dict) and set(value) == required
        assert type(value["api_port"]) is int and 0 < value["api_port"] <= 65535
        assert isinstance(value["expected_me"], dict)
        for name in required - {"expected_me", "api_port"}:
            assert isinstance(value[name], str) and 0 < len(value[name]) <= 16384
    except (AssertionError, ValueError, TypeError, KeyError):
        raise AssertionError("owned HTTP image fixture input is invalid") from None
    return value


def get_image(fixture, credential, **headers):
    # Fixed loopback/path. HTTPConnection performs no proxy lookup or redirect following.
    client = HTTPConnection("127.0.0.1", fixture["api_port"], timeout=3)
    try:
        client.request(
            "GET", "/api/v1/me", headers={"Authorization": "Bearer " + credential, **headers}
        )
        response = client.getresponse()
        body = response.read(65537)
        assert len(body) <= 65536, "owned HTTP image response exceeded its bound"
        return response.status, response.headers, body
    except Exception:
        raise AssertionError("owned HTTP image request could not complete safely") from None
    finally:
        client.close()


def test_ar01_ar18_real_provider_access_reaches_persisted_image(image_input):
    status, headers, body = get_image(image_input, image_input["access_token"])
    assert status == 200, "real provider access did not reach persisted image /me"
    if json.loads(body) != image_input["expected_me"]:
        pytest.fail("actual image projection differs from controller's persisted fixture")
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-Request-Id"]
    assert headers["ETag"].startswith('"')
    repeated, later_headers, later_body = get_image(image_input, image_input["access_token"])
    assert repeated == 200 and later_body == body
    assert later_headers["ETag"] == headers["ETag"]


@pytest.mark.parametrize("kind", ["id_token", "refresh_token", "wrong_audience"])
def test_ar18_actual_provider_nonaccess_material_is_refused_by_image(image_input, kind):
    status, headers, raw = get_image(image_input, image_input[kind])
    assert status == 401, "actual provider nonaccess or wrong-audience token entered image /me"
    assert headers["Cache-Control"] == "no-store"
    assert headers["Content-Type"].split(";")[0] == "application/problem+json"
    body = json.loads(raw)
    assert body["type"] == "https://kodera.io/problems/unauthenticated"
    assert body["request_id"] == headers["X-Request-Id"]
    if any(
        image_input[name].encode() in raw
        for name in ("access_token", "id_token", "refresh_token", "wrong_audience")
    ):
        pytest.fail("provider bearer material appeared in image denial")
