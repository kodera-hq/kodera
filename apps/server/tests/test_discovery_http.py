"""Anonymous WSGI discovery adapter over real quota and realm-selection services."""

import io
import ipaddress
import json
import time
from unittest.mock import patch
from uuid import UUID

import pytest
from django.core.handlers.wsgi import WSGIRequest
from django.test import Client, RequestFactory
from test_discovery_services import (
    http_signer as http_signer,
    owner_world as owner_world,
    quota_configuration as quota_configuration,
    ready as ready,
    w as w,
)

from apps.identity.api.discovery import discovery
from apps.identity.models import DiscoveryQuotaEvent
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)
URL = "/api/v1/auth/discover"
KEY = "public-compat-key-0001"


def post(body=b'{"slug":"unknown"}', **headers):
    return Client().generic(
        "POST",
        URL,
        body,
        content_type=headers.pop("content_type", "application/json"),
        HTTP_IDEMPOTENCY_KEY=KEY,
        **headers,
    )


def assert_headers(response, status, *, quota=True):
    assert response.status_code == status
    assert response["Cache-Control"] == "no-store"
    assert response["X-Request-Id"]
    assert "Idempotency-Replayed" not in response
    for name in ("RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"):
        assert (name in response) is quota
        if quota:
            assert int(response[name]) >= 0
    if status != 200:
        assert response["Content-Type"].startswith("application/problem+json")
        assert response.json()["status"] == status
        assert response.json()["request_id"] == response["X-Request-Id"]


def test_exact_zero_and_ready_shapes_ignore_bearer(ready):
    zero = post()
    assert_headers(zero, 200)
    assert zero.json() == dict(
        realm=None, issuer=None, openid_configuration_url=None, organisation=None, candidates=[]
    )
    body = json.dumps({"slug": ready.organisation.slug}).encode()
    with patch(
        "services.identity.trusted_issuers.verify_configured_token",
        side_effect=AssertionError("must not authenticate"),
    ):
        response = post(body, HTTP_AUTHORIZATION="Bearer deliberately-invalid")
    assert_headers(response, 200)
    assert response.json()["issuer"] == ready.organisation.issuer
    assert set(response.json()["organisation"]) == {"id", "slug", "name", "realm"}


@pytest.mark.parametrize(
    "body,media,status,kind",
    [
        (b"{", "application/json", 400, "malformed-request"),
        (b'{"slug":"alpha","slug":"bravo"}', "application/json", 400, "malformed-request"),
        (b"{}", "text/plain", 415, "unsupported-media-type"),
        (b'{"slug":"Alpha"}', "application/json", 422, "validation-error"),
        (b'{"email":"private-sentinel@not a domain"}', "application/json", 422, "validation-error"),
        (
            b'{"slug":"alpha","extra":"private-sentinel"}',
            "application/json",
            422,
            "validation-error",
        ),
        (b"\xff", "application/json", 400, "malformed-request"),
    ],
)
def test_safe_input_problems_have_current_counters(body, media, status, kind, caplog):
    response = post(body, content_type=media)
    # A wrong media type is refused from the headers alone, before any quota is evaluated.
    charged = status != 415
    assert_headers(response, status, quota=charged)
    assert response.json()["type"].endswith("/" + kind)
    if status in (400, 422):
        assert response.json()["errors"] and set(response.json()["errors"][0]) == {
            "pointer",
            "code",
        }
    if status == 415:
        assert response.json()["supported"] == ["application/json"]
    assert "private-sentinel" not in response.content.decode() + caplog.text
    assert DiscoveryQuotaEvent.objects.count() == int(charged)


def test_key_missing_and_invalid_are_not_replayed_or_retained():
    for headers, kind in (
        ({}, "idempotency-key-missing"),
        ({"HTTP_IDEMPOTENCY_KEY": "short"}, "malformed-request"),
    ):
        response = Client().generic(
            "POST", URL, b'{"slug":"alpha"}', content_type="application/json", **headers
        )
        assert_headers(response, 400, quota=False)
        assert response.json()["type"] == "https://kodera.io/problems/" + kind
        assert "errors" not in response.json()
    assert DiscoveryQuotaEvent.objects.count() == 0 and IdempotencyRecord.objects.count() == 0


def test_exact_received_byte_limit():
    body = b'{"slug":"alpha"}'
    assert_headers(post(body + b" " * (4096 - len(body))), 200)
    too_large = post(body + b" " * (4097 - len(body)))
    assert_headers(too_large, 413)
    assert too_large.json()["limit_bytes"] == 4096


class BoundedInput(io.BytesIO):
    def __init__(self, body, *, expected_events=1):
        super().__init__(body)
        self.calls = []
        self.expected_events = expected_events

    def read(self, size=-1):
        assert 0 <= size <= 4097, "unbounded HTTP body materialization"
        assert DiscoveryQuotaEvent.objects.count() == self.expected_events
        self.calls.append(size)
        return super().read(size)


def request(stream, *, length="999999", terminated=False):
    environ = RequestFactory()._base_environ(
        PATH_INFO=URL,
        REQUEST_METHOD="POST",
        CONTENT_TYPE="application/json",
        CONTENT_LENGTH=length,
        HTTP_IDEMPOTENCY_KEY=KEY,
        REMOTE_ADDR="192.0.2.1",
    )
    environ["wsgi.input"] = stream
    if terminated:
        environ["wsgi.input_terminated"] = True
    return WSGIRequest(environ)


@pytest.mark.parametrize("terminated,length", [(False, "999999"), (True, "")])
def test_body_is_read_once_with_bound_after_admission_not_header_guess(terminated, length):
    stream = BoundedInput(b'{"slug":"alpha"}')
    response = discovery(request(stream, length=length, terminated=terminated))
    assert response.status_code == 200 and stream.calls == [4097]


def test_chunked_received_bytes_over_limit_are_refused():
    stream = BoundedInput(b" " * 4097)
    response = discovery(request(stream, length="", terminated=True))
    assert response.status_code == 413 and stream.calls == [4097]


def test_missing_key_configuration_never_reads_body_and_does_not_break_other_routes(settings):
    settings.KODERA_DISCOVERY_HMAC_KEY = None
    stream = BoundedInput(b"private-sentinel", expected_events=0)
    with patch.object(stream, "read", side_effect=AssertionError("body must not be read")):
        response = discovery(request(stream))
    assert response.status_code == 503 and "RateLimit-Limit" not in response
    assert response["Retry-After"] == "5"
    assert Client().get("/health/live").status_code == 200
    assert Client().get("/api/v1/me").status_code == 401
    assert DiscoveryQuotaEvent.objects.count() == 0


@pytest.mark.parametrize(
    "exception,status",
    [(OSError("private-sentinel"), 400), (RuntimeError("private-sentinel"), 500)],
)
def test_body_read_failure_retains_safe_evaluated_quota(exception, status, caplog):
    stream = BoundedInput(b"")
    with patch.object(stream, "read", side_effect=exception):
        response = discovery(request(stream))
    assert response.status_code == status and response["RateLimit-Remaining"] == "29"
    assert "private-sentinel" not in response.content.decode() + caplog.text


def test_rate_limit_is_shared_by_direct_peer_not_forwarded_headers():
    for i in range(30):
        assert_headers(post(HTTP_X_FORWARDED_FOR=f"198.51.100.{i + 1}"), 200)
    response = post(HTTP_X_FORWARDED_FOR="203.0.113.1")
    assert_headers(response, 429)
    assert response["Retry-After"] == str(response.json()["retry_after_s"])
    assert int(response["Retry-After"]) >= 1 and response.json()["scope"] == "ip"
    assert DiscoveryQuotaEvent.objects.filter(scope="entry").count() == 30


# The test client's peer is 127.0.0.1. These are the trusted-edge cases of docs/specs/TRUSTED_EDGE.md.
EDGE = (ipaddress.ip_network("127.0.0.1/32"),)
ELSEWHERE = (ipaddress.ip_network("192.0.2.10/32"),)


def test_behind_the_trusted_edge_each_forwarded_client_has_its_own_bucket(settings):
    settings.KODERA_TRUSTED_EDGE = EDGE
    for i in range(31):
        assert_headers(post(HTTP_X_FORWARDED_FOR=f"198.51.100.{i + 1}"), 200)
    for _ in range(30):
        assert_headers(post(HTTP_X_FORWARDED_FOR="203.0.113.1"), 200)
    response = post(HTTP_X_FORWARDED_FOR="203.0.113.1")
    assert_headers(response, 429)
    assert response.json()["scope"] == "ip"
    assert_headers(post(HTTP_X_FORWARDED_FOR="203.0.113.2"), 200)


def test_a_forwarded_header_from_an_untrusted_peer_is_ignored(settings):
    settings.KODERA_TRUSTED_EDGE = ELSEWHERE
    for i in range(30):
        assert_headers(post(HTTP_X_FORWARDED_FOR=f"198.51.100.{i + 1}"), 200)
    response = post(HTTP_X_FORWARDED_FOR="203.0.113.1")
    assert_headers(response, 429)
    assert response.json()["scope"] == "ip"


def test_hops_a_caller_wrote_left_of_the_edge_do_not_choose_the_bucket(settings):
    settings.KODERA_TRUSTED_EDGE = EDGE
    for i in range(30):
        forged = f"198.51.100.{i + 1}, 203.0.113.7"
        assert_headers(post(HTTP_X_FORWARDED_FOR=forged), 200)
    response = post(HTTP_X_FORWARDED_FOR="198.51.100.200, 203.0.113.7")
    assert_headers(response, 429)
    assert response.json()["scope"] == "ip"


def test_a_malformed_hop_behind_the_edge_keeps_the_shared_peer_bucket(settings):
    settings.KODERA_TRUSTED_EDGE = EDGE
    for i in range(30):
        assert_headers(post(HTTP_X_FORWARDED_FOR=f"198.51.100.{i + 1}, not-an-address"), 200)
    # The edge's own bucket: a request it forwarded with no header at all lands there too.
    response = post()
    assert_headers(response, 429)
    assert response.json()["scope"] == "ip"


def test_email_lookup_is_the_zero_result_with_real_counters():
    response = post(b'{"email":"private-sentinel@example.test"}')
    assert_headers(response, 200)
    assert response.json() == dict(
        realm=None, issuer=None, openid_configuration_url=None, organisation=None, candidates=[]
    )
    assert "Retry-After" not in response
    assert "private-sentinel" not in response.content.decode()
    assert DiscoveryQuotaEvent.objects.count() == 2


def test_request_id_is_namespaced_or_generated_uuid7():
    response = post(HTTP_X_REQUEST_ID="safe-request-123")
    assert response["X-Request-Id"] == "c-safe-request-123"
    # A problem body carries the same namespaced id (a 200 answer has no request_id member).
    refused = post(b'{"slug":"Alpha"}', HTTP_X_REQUEST_ID="safe-request-124")
    assert refused.status_code == 422 and refused.json()["request_id"] == "c-safe-request-124"
    # A Core-shaped id from a caller never passes for Core's own.
    forged = "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    assert post(HTTP_X_REQUEST_ID=forged)["X-Request-Id"] == "c-" + forged
    # 63 characters fit the caller's rule but not the namespaced 64: Core generates its own.
    assert UUID(post(HTTP_X_REQUEST_ID="x" * 63)["X-Request-Id"]).version == 7
    generated = post(HTTP_X_REQUEST_ID="invalid value")
    assert UUID(generated["X-Request-Id"]).version == 7


def test_same_key_changed_body_always_charges_fresh_without_replay_state():
    assert_headers(post(b'{"slug":"alpha"}'), 200)
    assert_headers(post(b'{"slug":"bravo"}'), 200)
    assert DiscoveryQuotaEvent.objects.count() == 4 and IdempotencyRecord.objects.count() == 0


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "OPTIONS"])
def test_other_methods_have_safe_405_without_quota(method):
    response = Client().generic(method, URL)
    assert_headers(response, 405, quota=False)
    assert response["Allow"] == "POST" and DiscoveryQuotaEvent.objects.count() == 0


def test_slow_bounded_body_does_not_consume_remaining_database_budget():
    stream = BoundedInput(b'{"slug":"alpha"}')
    read = stream.read

    def delayed(size):
        time.sleep(2.1)
        return read(size)

    with patch.object(stream, "read", side_effect=delayed):
        response = discovery(request(stream))
    assert response.status_code == 200 and stream.calls == [4097]
    assert DiscoveryQuotaEvent.objects.count() == 2


@pytest.mark.parametrize("stage,events", [("admit_value", 1), ("select_realms", 2)])
def test_unexpected_post_charge_failure_keeps_real_counters_without_private_context(
    stage, events, caplog
):
    from apps.identity.discovery import DiscoveryRefusedError, discover

    with patch("apps.identity.discovery." + stage, side_effect=RuntimeError("private-sentinel")):
        response = post()
    assert_headers(response, 500)
    assert response["RateLimit-Remaining"] == "29"
    assert DiscoveryQuotaEvent.objects.count() == events
    assert "private-sentinel" not in response.content.decode() + caplog.text
    with patch("apps.identity.discovery." + stage, side_effect=RuntimeError("private-sentinel")):
        with pytest.raises(DiscoveryRefusedError) as caught:
            discover(
                b'{"slug":"alpha"}',
                peer="192.0.2.9",
                content_type="application/json",
                compatibility_key=KEY,
            )
    assert caught.value.__context__ is None and caught.value.__cause__ is None


def test_remaining_database_budget_is_preserved_across_body_reader():
    from apps.identity import discovery as service
    from services.identity.discovery_policy import QuotaDecision

    quota = QuotaDecision(True, "ip", 30, 29, 60, None)
    initial = service.Deadline()
    # The first stage used half of its DB allowance. Body parsing must not reset it.
    with (
        patch.object(
            service, "Deadline", side_effect=[initial, service.Deadline(seconds=1)]
        ) as deadlines,
        patch.object(service.time, "monotonic", return_value=initial.end - 1),
        patch.object(service, "admit_peer", return_value=quota),
        patch.object(service, "admit_value", return_value=quota),
        patch.object(service, "select_realms", return_value={}),
    ):
        service.discover(
            b'{"slug":"alpha"}',
            peer="192.0.2.1",
            content_type="application/json",
            compatibility_key=KEY,
        )
    assert deadlines.call_args_list[1].kwargs == {"seconds": 1}


ATTACKER = "https://attacker.example"
CONSOLE = "https://app.kodera.io"


@pytest.mark.parametrize(
    "media,headers",
    [
        ("text/plain", dict(HTTP_ORIGIN=ATTACKER, HTTP_SEC_FETCH_SITE="cross-site")),
        ("application/json", dict(HTTP_ORIGIN=ATTACKER, HTTP_SEC_FETCH_SITE="cross-site")),
        ("application/json", dict(HTTP_ORIGIN=ATTACKER)),
        ("application/json", dict(HTTP_SEC_FETCH_SITE="cross-site")),
        ("text/plain", {}),
    ],
)
def test_drive_by_requests_change_no_counter(settings, media, headers):
    settings.KODERA_CONSOLE_ORIGINS = CONSOLE
    for _ in range(3):
        response = post(b'{"slug":"alpha"}', content_type=media, **headers)
        assert response.status_code in (403, 415)
        assert_headers(response, response.status_code, quota=False)
    assert DiscoveryQuotaEvent.objects.count() == 0
    # The client those requests would have locked out is still fully admitted.
    assert post(b'{"slug":"alpha"}')["RateLimit-Remaining"] == "29"


def test_cross_site_problem_is_forbidden(settings):
    settings.KODERA_CONSOLE_ORIGINS = CONSOLE
    response = post(HTTP_ORIGIN=ATTACKER, HTTP_SEC_FETCH_SITE="cross-site")
    assert_headers(response, 403, quota=False)
    assert response.json()["type"] == "https://kodera.io/problems/forbidden"
    assert "errors" not in response.json()


def test_console_and_native_clients_pass(settings):
    settings.KODERA_CONSOLE_ORIGINS = CONSOLE
    assert_headers(post(HTTP_ORIGIN=CONSOLE, HTTP_SEC_FETCH_SITE="same-site"), 200)
    assert_headers(post(), 200)
    assert DiscoveryQuotaEvent.objects.count() == 4


@pytest.mark.parametrize("stage", ["admit_value", "select_realms"])
def test_internal_error_log_names_request_and_class_only(stage, caplog):
    with patch("apps.identity.discovery." + stage, side_effect=RuntimeError("private-sentinel")):
        response = post(HTTP_X_REQUEST_ID="safe-request-500")
    assert_headers(response, 500)
    records = [r.getMessage() for r in caplog.records if r.name == "apps.identity.api.discovery"]
    assert records == [
        "discovery internal error request_id=c-safe-request-500 exception=RuntimeError"
    ]
    assert "private-sentinel" not in caplog.text


def test_adapter_level_internal_error_is_logged_without_text(caplog):
    with patch("apps.identity.api.discovery.discover", side_effect=KeyError("private-sentinel")):
        response = post(HTTP_X_REQUEST_ID="safe-request-501")
    assert_headers(response, 500, quota=False)
    assert "request_id=c-safe-request-501 exception=KeyError" in caplog.text
    assert "private-sentinel" not in caplog.text
