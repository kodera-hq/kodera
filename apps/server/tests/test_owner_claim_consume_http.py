"""Consume request and real route controls; synthetic facts only."""

import json

import pytest


def parse(body):
    from apps.orgs.api.owner_claim_serializers import parse_consume_request

    return parse_consume_request(body)


@pytest.mark.parametrize("name", [None, "", "  ", "é" * 200])
def test_consume_request_preserves_explicit_nullable_and_untrimmed_profile(name):
    request = parse(json.dumps({"token": "x" * 43, "display_name": name}).encode())
    assert request.token == "x" * 43
    assert request.has_display_name is True
    assert request.display_name == name


def test_consume_request_omitted_profile_is_distinct_from_explicit_null():
    request = parse(b'{"token":"' + b"x" * 43 + b'"}')
    assert request.has_display_name is False
    assert request.display_name is None


@pytest.mark.parametrize(
    "body",
    [
        b"null",
        b"[]",
        b"{}",
        b"{",
        b"\xff",
        b'{"token":null}',
        b'{"token":123}',
        b'{"token":true}',
        json.dumps({"token": "x" * 42}).encode(),
        json.dumps({"token": "x" * 257}).encode(),
        json.dumps({"token": "x" * 43, "extra": "private"}).encode(),
        json.dumps({"token": "x" * 43, "display_name": 0}).encode(),
        json.dumps({"token": "x" * 43, "display_name": False}).encode(),
        json.dumps({"token": "x" * 43, "display_name": []}).encode(),
        json.dumps({"token": "x" * 43, "display_name": "é" * 201}).encode(),
        b'{"token":"' + b"x" * 43 + b'","token":"' + b"y" * 43 + b'"}',
    ],
)
def test_consume_request_refuses_schema_coercion_unknown_members_and_duplicate_keys(body):
    from apps.orgs.api.owner_claim_serializers import ConsumeRequestError

    with pytest.raises(ConsumeRequestError):
        parse(body)


def test_consume_wire_token_bounds_do_not_invent_an_ascii_schema_requirement():
    assert parse(json.dumps({"token": "é" * 43}).encode()).token == "é" * 43


def test_consume_request_type_weakening_control_exposes_coercion(monkeypatch):
    from apps.orgs.api import owner_claim_serializers as serializers

    malformed = json.dumps({"token": "x" * 43, "display_name": 5}).encode()
    with pytest.raises(serializers.ConsumeRequestError):
        serializers.parse_consume_request(malformed)
    monkeypatch.setattr(serializers, "_valid_display_name", lambda value: True)
    assert serializers.parse_consume_request(malformed).display_name == 5


def test_actual_consume_view_method_and_unauthenticated_refusals_are_closed():
    from django.test import RequestFactory

    from apps.orgs.api.owner_claims import consume_owner_claim

    factory = RequestFactory()
    method = consume_owner_claim(factory.get("/api/v1/owner-claims/actions/consume"))
    assert method.status_code == 405 and method["Allow"] == "POST"
    missing = consume_owner_claim(
        factory.post(
            "/api/v1/owner-claims/actions/consume", data=b"{}", content_type="application/json"
        )
    )
    assert missing.status_code == 401 and missing["WWW-Authenticate"] == "Bearer"
    assert missing["Cache-Control"] == "no-store"
    assert "Idempotency-Replayed" not in missing


def test_route_preflight_unknown_identity_precedes_missing_key_and_store(monkeypatch):
    from contextlib import contextmanager

    from django.test import RequestFactory

    from apps.orgs.api import owner_claims as view
    from apps.orgs.claim_consumption import ConsumerUnknownError
    from services.identity.access_tokens import VerifiedAccessToken

    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    monkeypatch.setattr(
        view, "verify_configured_token", lambda *args, **kwargs: (verified, "customer")
    )

    @contextmanager
    def unknown(**kwargs):
        raise ConsumerUnknownError()
        yield  # pragma: no cover

    monkeypatch.setattr(view, "consumption_operation", unknown)
    monkeypatch.setattr(
        view,
        "respond_once",
        lambda *args, **kwargs: pytest.fail("unknown identity reached the replay adapter"),
    )
    request = RequestFactory().post(
        "/api/v1/owner-claims/actions/consume",
        data=b"{}",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer synthetic-public-unit-credential",
    )
    response = view.consume_owner_claim(request)
    assert response.status_code == 403
    assert json.loads(response.content)["type"] == "https://kodera.io/problems/identity-unknown"
    assert "WWW-Authenticate" not in response and response["Cache-Control"] == "no-store"


def test_known_staff_consume_refusal_has_its_required_audit_before_adapter(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    from uuid import UUID

    from django.test import RequestFactory

    from apps.orgs import claim_consumption as service
    from apps.orgs.api import owner_claims as view
    from services.identity.access_tokens import VerifiedAccessToken

    actor = UUID("01900000-0000-7000-8000-000000000001")
    verified = VerifiedAccessToken(
        "https://identity.staff.test/realms/kodera-staff",
        "public-staff",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    seen = []
    monkeypatch.setattr(
        view, "verify_configured_token", lambda *args, **kwargs: (verified, "staff")
    )
    monkeypatch.setattr(
        service, "current_staff_identity", lambda **kwargs: SimpleNamespace(id=actor), raising=False
    )
    monkeypatch.setattr(service, "record_authz_denied", lambda **row: seen.append(row))
    monkeypatch.setattr(service, "transaction", SimpleNamespace(atomic=nullcontext))
    monkeypatch.setattr(
        view,
        "respond_once",
        lambda *args, **kwargs: pytest.fail("staff denial reached receipt adapter"),
    )
    request = RequestFactory().post(
        "/api/v1/owner-claims/actions/consume",
        data=b"{}",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer public-staff-unit-credential",
    )
    assert view.consume_owner_claim(request).status_code == 403
    assert len(seen) == 1 and seen[0]["actor_type"] == "staff"
    assert seen[0]["actor_id"] == actor


def test_unknown_or_disabled_staff_is_nonstored_401_without_an_audit(monkeypatch):
    from django.test import RequestFactory

    from apps.orgs import claim_consumption as service
    from apps.orgs.api import owner_claims as view
    from services.identity.access_tokens import VerifiedAccessToken

    verified = VerifiedAccessToken(
        "https://identity.staff.test/realms/kodera-staff",
        "public-unknown-staff",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    monkeypatch.setattr(
        view, "verify_configured_token", lambda *args, **kwargs: (verified, "staff")
    )
    monkeypatch.setattr(service, "current_staff_identity", lambda **kwargs: None, raising=False)
    monkeypatch.setattr(
        service,
        "record_authz_denied",
        lambda **kwargs: pytest.fail("unknown staff denial wrote an audit"),
    )
    request = RequestFactory().post(
        "/api/v1/owner-claims/actions/consume",
        data=b"{}",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer public-unknown-unit-credential",
    )
    assert view.consume_owner_claim(request).status_code == 401
