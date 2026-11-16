"""Production customer routing keeps confidential transport opt-in and authority-scoped."""

import os
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.urls import resolve
from test_access_tokens import frozen_clock as frozen_clock
from test_e2ee_relay import b64, relay as relay
from test_e2ee_relay_http import http as http, path, post, send, writer as writer
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.audit.models import AuditEvent
from apps.e2ee.api import http as relay_http
from apps.e2ee.models import Device, Envelope, KeyPackage, Participant, Room
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)


def snapshot():
    return tuple(
        model.objects.count()
        for model in (
            Device,
            Room,
            Participant,
            KeyPackage,
            Envelope,
            AuditEvent,
            IdempotencyRecord,
        )
    )


@pytest.fixture
def production_route(settings):
    # Never substitute the relay-only test URLConf: this is the real customer route graph.
    assert settings.ROOT_URLCONF == "config.customer_urls"
    settings.KODERA_E2EE_RELAY_ENABLED = True


@pytest.mark.parametrize(
    ("method", "suffix", "view"),
    [
        ("post", "devices", "devices"),
        ("post", "devices/revoke", "revoke"),
        ("post", "key-packages", "packages"),
        ("post", "rooms", "rooms"),
        ("post", "rooms/{room}/key-packages/claims", "claims"),
        ("post", "rooms/{room}/commits", "commits"),
        ("post", "rooms/{room}/participants/retire", "retire"),
        ("get", "rooms/{room}/envelopes", "envelopes"),
        ("post", "rooms/{room}/envelopes", "envelopes"),
    ],
)
def test_production_gate_refuses_every_operation_before_authentication_or_effects(
    relay, http, settings, monkeypatch, production_route, writer, method, suffix, view
):
    settings.KODERA_E2EE_RELAY_ENABLED = False
    url = path(relay, suffix.format(room=relay[6]))
    resolved = resolve(url, urlconf=settings.ROOT_URLCONF)
    assert resolved.func.__module__ == "apps.e2ee.api.views"
    assert resolved.func.__name__ == view

    def authentication_must_not_run(*args, **kwargs):
        raise AssertionError("Disabled confidential transport reached token verification")

    monkeypatch.setattr(relay_http, "verify_configured_token", authentication_must_not_run)
    before = snapshot()
    with acting_as(writer):
        # No bearer, replay key or valid operation body: the gate must precede all of them.
        response = getattr(http[0], method)(url, data={}, content_type="application/json")
    assert response.status_code == 503, response.content
    assert response["Retry-After"] == "1"
    assert response["Cache-Control"] == "no-store"
    assert response["Content-Type"] == "application/problem+json"
    assert "Idempotency-Replayed" not in response
    assert snapshot() == before


def test_production_mount_carries_opaque_bytes_and_replays_once_under_real_writer(
    relay, http, production_route, writer
):
    ciphertext = os.urandom(48)
    key = str(uuid4())
    with acting_as(writer):
        created = send(relay, http, key=key, ciphertext=ciphertext)
        replayed = send(relay, http, key=key, ciphertext=ciphertext)
        received = http[0].get(
            path(relay, f"rooms/{relay[6]}/envelopes"),
            {"deviceId": str(relay[5][0])},
            HTTP_AUTHORIZATION="Bearer " + http[1][0],
        )
    assert created.status_code == 201, created.content
    assert replayed.status_code == 201 and replayed.content == created.content
    assert replayed["Idempotency-Replayed"] == "true"
    assert Envelope.objects.count() == 1
    assert bytes(Envelope.objects.get().ciphertext) == ciphertext
    assert received.status_code == 200, received.content
    assert [item["ciphertext"] for item in received.json()["envelopes"]] == [b64(ciphertext)]
    assert received["Cache-Control"] == "no-store"


def test_production_mount_refuses_foreign_organisation_before_replay_or_writes(
    relay, http, production_route, writer
):
    document = relay[7](
        0,
        "send-application",
        {"deviceId": str(relay[5][0]), "epoch": 0, "ciphertext": b64(os.urandom(32))},
        relay[6],
    )
    before = snapshot()
    with acting_as(writer):
        import json

        response = http[0].post(
            f"/api/v1/organisations/{uuid4()}/confidential/rooms/{relay[6]}/envelopes",
            data=json.dumps(document),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + http[1][0],
            HTTP_IDEMPOTENCY_KEY=str(uuid4()),
        )
    assert response.status_code == 404, response.content
    assert snapshot() == before


def test_production_mount_refuses_another_members_device_without_replay_or_writes(
    relay, http, production_route, writer
):
    before = snapshot()
    with acting_as(writer):
        response = post(
            relay,
            http,
            "send-application",
            f"rooms/{relay[6]}/envelopes",
            {"deviceId": str(relay[5][0]), "epoch": 0, "ciphertext": b64(os.urandom(32))},
            index=2,
            room=True,
        )
    assert response.status_code == 404, response.content
    assert snapshot() == before
