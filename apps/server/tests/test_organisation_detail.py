"""Persisted own-organisation read acceptance with real signed credentials."""

import hashlib
import json
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import (
    configure,
    http_signer as http_signer,
    http_world as http_world,
    rows,
    safe_problem,
    soft_delete,
    token,
    trust_entry,
)
from django.db import connection, transaction
from django.urls import Resolver404, resolve
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import identity, raw_update


def detail(w, organisation_id=None, credential=None, **headers):
    return w.client.get(
        f"/api/v1/organisations/{organisation_id or w.first.id}",
        HTTP_AUTHORIZATION="Bearer " + (credential or w.credential),
        **headers,
    )


def test_detail_route():
    try:
        resolve(f"/api/v1/organisations/{uuid4()}")
    except Resolver404:
        pytest.fail("organisation detail route is missing")


@pytest.mark.parametrize("role", ["org_owner", "org_admin", "org_billing", "org_member"])
def test_required_projection_and_roles(http_world, role):
    w = http_world
    raw_update(w.member, role=role)
    before = rows(w.models)
    response = detail(w)
    assert response.status_code == 200, "current customer role cannot read own organisation"
    assert response.json() == {
        "id": str(w.first.id),
        "slug": w.first.slug,
        "name": w.first.name,
        "state": w.first.state,
        "created_at": w.first.created_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }, "organisation projection leaked or invented fields"
    assert response.headers["Cache-Control"] == "no-store"
    assert rows(w.models) == before, "organisation GET wrote persisted rows"


def test_issuer_bound_multi_org_isolation(http_world):
    w = http_world
    identity(w.models, w.second, w.person, subject="second-identity")
    w.models.Membership.objects.create(
        user=w.person,
        organisation=w.second,
        role="org_owner",
        state="active",
        accepted_at=timezone.now(),
    )
    headers = {"HTTP_X_REQUEST_ID": "same-safe-request"}
    foreign = detail(w, w.second.id, **headers)
    unknown = detail(w, uuid4(), **headers)
    assert foreign.status_code == unknown.status_code == 404, "issuer-path scope was bypassed"
    assert foreign.content == unknown.content, "foreign and unknown targets differ"
    safe_problem(foreign, 404, "not-found")
    assert "ETag" not in foreign.headers


@pytest.mark.parametrize(
    "entity,change,status",
    [
        ("current", "disabled", 403),
        ("current", "deleted", 403),
        ("person", "disabled", 403),
        ("person", "deleted", 403),
        ("member", "deleted", 403),
        ("member", "removed", 403),
        ("member", "suspended", 403),
        ("member", "invited", 403),
        ("first", "deleted", 403),
        ("first", "prospect", 403),
        ("first", "closed", 403),
    ],
)
def test_current_authority_before_conditional(http_world, entity, change, status):
    w = http_world
    initial = detail(w)
    assert initial.status_code == 200
    item = getattr(w, entity)
    if change == "deleted":
        soft_delete(item)
    elif change == "disabled":
        raw_update(item, enabled=False)
    elif change == "invited":
        raw_update(item, state=change, accepted_at=None)
    else:
        raw_update(item, state=change)
    for tag in (initial.headers["ETag"], "*"):
        response = detail(w, HTTP_IF_NONE_MATCH=tag)
        assert response.status_code == status, "conditional response bypassed current authority"
        safe_problem(
            response, status, "identity-unknown" if entity in {"current", "person"} else "forbidden"
        )
        assert "ETag" not in response.headers


def test_unknown_subject_and_missing_grant(http_world, http_signer):
    w = http_world
    safe_problem(
        detail(w, credential=token(http_signer, w.first.issuer, "missing")), 403, "identity-unknown"
    )
    w.member.delete()
    response = detail(w)
    assert response.status_code == 403, "missing grant was accepted"


def test_suspended_organisation_read(http_world):
    raw_update(http_world.first, state="suspended")
    response = detail(http_world)
    assert response.status_code == 200
    assert response.json()["state"] == "suspended"


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete", "head", "options"])
def test_mutations_refused(http_world, method):
    w = http_world
    before = rows(w.models)
    response = getattr(w.client, method)(f"/api/v1/organisations/{w.first.id}")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"
    assert response.headers["Cache-Control"] == "no-store"
    assert rows(w.models) == before


def test_staff_refused(http_world, http_signer, settings):
    issuer = "https://identity.customer.test/realms/kodera-staff"
    configure(settings, [trust_entry(http_signer, issuer, lane="staff")])
    response = detail(http_world, credential=token(http_signer, issuer, amr=["mfa"]))
    safe_problem(response, 403, "forbidden")


def test_etag_authoritative_timestamp_and_conditionals(http_world):
    w = http_world
    response = detail(w)
    assert response.status_code == 200
    canonical = {
        **response.json(),
        "updated_at": w.first.updated_at.isoformat().replace("+00:00", "Z"),
    }
    expected = (
        '"'
        + hashlib.sha256(
            json.dumps(
                canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
        + '"'
    )
    assert response.headers["ETag"] == expected, "ETag omitted authoritative update timestamp"
    for tag in (expected, "W/" + expected, '"other", W/' + expected, "*"):
        cached = detail(w, HTTP_IF_NONE_MATCH=tag)
        assert cached.status_code == 304 and cached.content == b""
        assert cached.headers["ETag"] == expected
        assert cached.headers["Cache-Control"] == "no-store"
    raw_update(w.first, updated_at=w.first.updated_at + timedelta(microseconds=1))
    changed = detail(w, HTTP_IF_NONE_MATCH=expected)
    assert changed.status_code == 200, "timestamp-only change did not invalidate ETag"
    assert changed.json() == response.json()
    assert changed.headers["ETag"] != expected
    raw_update(w.first, name="Updated synthetic organisation")
    changed_name = detail(w, HTTP_IF_NONE_MATCH=changed.headers["ETag"])
    assert (
        changed_name.status_code == 200 and changed_name.headers["ETag"] != changed.headers["ETag"]
    )


@pytest.mark.parametrize("request_id", ["safe-request_123", "invalid id", "x" * 63, "x" * 65, ""])
def test_safe_errors_and_request_ids(http_world, request_id):
    w = http_world
    response = detail(w, credential="invalid-token", HTTP_X_REQUEST_ID=request_id)
    body = safe_problem(response, 401, "unauthenticated", sentinels=("invalid-token",))
    if request_id == "safe-request_123":
        assert body["request_id"] == "c-" + request_id
    else:
        assert UUID(body["request_id"]).version == 7


def test_nested_snapshot_refused_safely(http_world, caplog):
    w = http_world
    with transaction.atomic():
        response = detail(w)
    safe_problem(response, 500, "internal-error", sentinels=(w.credential, w.current.subject))
    assert w.credential not in caplog.text and w.current.subject not in caplog.text
    assert not connection.in_atomic_block


def test_public_timestamp_precision(http_world):
    w = http_world
    created = w.first.created_at.replace(microsecond=123456)
    raw_update(w.first, created_at=created)
    response = detail(w)
    assert response.status_code == 200
    expected = created.strftime("%Y-%m-%dT%H:%M:%S") + ".123Z"
    assert response.json()["created_at"] == expected, (
        "public timestamp precision is not milliseconds"
    )
