"""Slow preview fetching never inherits the audit or HTTP replay transaction."""

import json
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.cache import cache
from django.db import connection, transaction
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from test_access_tokens import frozen_clock as frozen_clock
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

from apps.audit.models import AuditEvent
from apps.identity.models import Identity
from apps.media import services
from apps.media.context import RefusalError
from apps.orgs.models import Organisation, SlugReservation
from apps.workspaces.models import Workspace

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def fetch(monkeypatch):
    cache.clear()
    calls = []

    def unfurl(url):
        assert not connection.in_atomic_block
        calls.append(url)
        return {
            "url": url,
            "canonicalUrl": url,
            "title": "Example",
            "description": "",
            "siteName": "",
        }

    monkeypatch.setattr(services.unfurl, "unfurl", unfurl)
    yield calls
    cache.clear()


def test_preview_fetches_in_autocommit_caches_and_audits_each_request(world, fetch):
    org, _, _, tokens = world
    common = {"verified": tokens[3], "organisation_id": org.id, "url": "https://example.test/"}
    first = services.preview(**common, request_id=str(uuid4()))
    assert services.preview(**common, request_id=str(uuid4())) == first
    assert fetch == [common["url"]]
    assert AuditEvent.objects.filter(action="workspace.url.previewed").count() == 2


def test_preview_refuses_an_enclosing_transaction(world, fetch):
    org, _, _, tokens = world
    with transaction.atomic(), pytest.raises(RuntimeError, match="no enclosing transaction"):
        services.preview(
            verified=tokens[3],
            organisation_id=org.id,
            url="https://example.test/",
            request_id=str(uuid4()),
        )
    assert fetch == []


def test_cached_preview_still_rechecks_revocation(world, fetch):
    org, _, members, tokens = world
    common = {"verified": tokens[3], "organisation_id": org.id, "url": "https://example.test/"}
    services.preview(**common, request_id=str(uuid4()))
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    with pytest.raises(RefusalError):
        services.preview(**common, request_id=str(uuid4()))
    assert len(fetch) == 1


@pytest.mark.parametrize("url", [None, 42, "x" * 8193, "\ud800"])
@pytest.mark.parametrize("authority", ["current", "revoked", "foreign"])
def test_preview_checks_authority_before_url_validation(world, fetch, url, authority):
    org, _, members, tokens = world
    token = tokens[3]
    organisation_id = org.id
    expected = 422
    if authority == "revoked":
        Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
        expected = 403
    elif authority == "foreign":
        with transaction.atomic():
            slug = "foreign-" + uuid4().hex[:12]
            other = Organisation.objects.create(
                slug=slug,
                realm=slug,
                name="Foreign example",
                issuer=f"https://identity.example.test/realms/{slug}",
                state="prospect",
            )
            SlugReservation.objects.create(
                organisation=other, slug=slug, namespace="organisation", state="provisional"
            )
            Workspace.objects.create(organisation=other)
        organisation_id = other.id
        expected = 404
    with pytest.raises(RefusalError) as denied:
        services.prepare_preview(verified=token, organisation_id=organisation_id, url=url)
    assert denied.value.status == expected
    assert fetch == []
    assert not AuditEvent.objects.filter(action="workspace.url.previewed").exists()


def test_preview_preparation_never_takes_workspace_update_locks(world, fetch):
    org, _, _, tokens = world
    common = {"verified": tokens[3], "organisation_id": org.id, "url": "https://example.test/"}
    with CaptureQueriesContext(connection) as queries:
        result = services.prepare_preview(**common)
        assert services.prepare_preview(**common) == result
    assert fetch == [common["url"]]
    assert not any("FOR UPDATE" in query["sql"].upper() for query in queries)
    assert not AuditEvent.objects.filter(action="workspace.url.previewed").exists()


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_http_prepares_outside_replay_and_replays_without_fetch_or_audit(world, http, fetch):
    org, _, _, _ = world
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/unfurl"
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[3],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    data = json.dumps({"url": "https://example.test/"})
    first = client.post(path, data=data, content_type="application/json", **headers)
    assert first.status_code == 200, first.content
    cache.clear()  # Replay must skip preparation even when no cached preview survives.
    replay = client.post(path, data=data, content_type="application/json", **headers)
    assert replay["Idempotency-Replayed"] == "true" and replay.content == first.content
    assert len(fetch) == 1
    assert AuditEvent.objects.filter(action="workspace.url.previewed").count() == 1
    reused = client.post(
        path,
        data=json.dumps({"url": "https://other.test/"}),
        content_type="application/json",
        **headers,
    )
    assert reused.status_code == 409 and len(fetch) == 1
    headers.pop("HTTP_IDEMPOTENCY_KEY")
    missing = client.post(path, data=data, content_type="application/json", **headers)
    assert missing.status_code == 400 and len(fetch) == 1
