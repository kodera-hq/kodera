"""Independent complete-set traversal, strict inputs and continuation authority."""

import base64
from uuid import uuid4

import pytest
from customer_http_fixtures import (
    http_signer as http_signer,
    http_world as http_world,
    safe_problem,
    token,
)
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import identity, raw_update
from test_membership_directory_http import directory, directory_key as directory_key, seed


def test_defaults_and_page_sizes(http_world):
    w = http_world
    for _ in range(51):
        seed(w)
    for query, size in [("", 50), ("?limit=1", 1), ("?limit=25", 25), ("?limit=200", 53)]:
        response = directory(w, query=query)
        assert response.status_code == 200
        body = response.json()
        assert len(body["data"]) == size
        assert body["has_more"] is (size < 53)
        assert (body["next_cursor"] is not None) is body["has_more"]


def test_complete_traversal_uses_independent_expected_set(http_world):
    w = http_world
    expected = {str(w.member.id)}
    owner = w.models.Membership.objects.get(organisation=w.first, role="org_owner")
    expected.add(str(owner.id))
    for _ in range(5):
        _, item = seed(w)
        expected.add(str(item.id))
    seen, cursor = [], None
    for _ in range(5):
        query = "?limit=2" + ("&cursor=" + cursor if cursor else "")
        response = directory(w, query=query)
        assert response.status_code == 200
        body = response.json()
        ids = [row["id"] for row in body["data"]]
        assert len(ids) == min(2, len(expected) - len(seen))
        seen.extend(ids)
        cursor = body["next_cursor"]
        if not body["has_more"]:
            assert cursor is None
            break
        assert cursor.isascii() and len(cursor) <= 512
    assert len(seen) == len(set(seen)) and set(seen) == expected
    assert seen == sorted(seen)


def test_filters_and_removed_empty(http_world):
    w = http_world
    _, wanted = seed(w, role="org_admin", state="invited")
    seed(w, role="org_admin", state="active")
    seed(w, state="invited")
    seed(w, state="removed")
    response = directory(w, query="?role=org_admin&state=invited")
    assert [row["id"] for row in response.json()["data"]] == [str(wanted.id)]
    assert directory(w, query="?state=removed").json() == {
        "data": [],
        "has_more": False,
        "next_cursor": None,
    }
    assert directory(w, query="?role=org_billing").json()["data"] == []


@pytest.mark.parametrize(
    "query",
    [
        "limit=",
        "limit=0",
        "limit=201",
        "limit=-1",
        "limit=01",
        "limit=1.0",
        "limit=true",
        "limit=1&limit=1",
        "role=",
        "role=owner",
        "role=org_member&role=org_member",
        "state=",
        "state=unknown",
        "state=active&state=active",
        "cursor=",
        "cursor=a&cursor=a",
        "search=person",
        "limit=1&unknown=x",
        "cursor=" + "x" * 513,
        "unknown=" + "x" * 2048,
    ],
)
def test_invalid_queries(http_world, query):
    safe_problem(directory(http_world, query="?" + query), 400, "validation-error")


def first_cursor(w):
    response = directory(w, query="?limit=1")
    assert response.status_code == 200
    cursor = response.json()["next_cursor"]
    assert cursor is not None
    return cursor


def test_invalid_cursor_integrity(http_world):
    w = http_world
    cursor = first_cursor(w)
    raw = bytearray(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    raw[-1] ^= 1
    forged = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    response = directory(w, query="?limit=1&cursor=" + forged)
    assert response.status_code == 400, "directory accepted invalid cursor integrity"
    safe_problem(response, 400, "validation-error")
    for malformed in (cursor + "=", "a", "!" * 20, "é", "A" * 512):
        safe_problem(directory(w, query="?limit=1&cursor=" + malformed), 400, "validation-error")


@pytest.mark.parametrize("binding", ["limit", "role", "state", "person", "organisation"])
def test_cursor_binding(http_world, http_signer, binding):
    w = http_world
    cursor = first_cursor(w)
    query = "?limit=1&cursor=" + cursor
    credential, target = w.credential, w.first.id
    if binding == "limit":
        query = query.replace("limit=1", "limit=2")
    elif binding == "role":
        query += "&role=org_member"
    elif binding == "state":
        query += "&state=active"
    elif binding == "person":
        user, _ = seed(w)
        identity(w.models, w.first, user, subject="another-principal")
        credential = token(http_signer, w.first.issuer, "another-principal")
    else:
        identity(w.models, w.second, w.person, subject="same-person-second-realm")
        w.models.Membership.objects.create(
            user=w.person,
            organisation=w.second,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        credential = token(http_signer, w.second.issuer, "same-person-second-realm")
        target = w.second.id
    assert directory(w, target, credential=credential, query="?limit=1").status_code == 200
    response = directory(w, target, credential=credential, query=query)
    assert response.status_code == 400, "directory accepted a rebound cursor"


def test_refreshed_bearer_and_revocation(http_world, http_signer):
    w = http_world
    cursor = first_cursor(w)
    refreshed = token(http_signer, w.first.issuer, jti=str(uuid4()))
    assert directory(w, query="?limit=1&cursor=" + cursor, credential=refreshed).status_code == 200
    raw_update(w.member, state="removed")
    assert directory(w, query="?limit=1&cursor=" + cursor, credential=refreshed).status_code == 403


def test_ceiling_and_deletion(http_world):
    w = http_world
    original = [w.models.Membership.objects.get(organisation=w.first, role="org_owner"), w.member]
    original.extend(seed(w)[1] for _ in range(3))
    original.sort(key=lambda item: item.id)
    first = directory(w, query="?limit=1").json()
    from customer_http_fixtures import soft_delete

    soft_delete(original[2])
    _, added = seed(w)
    seen = [row["id"] for row in first["data"]]
    cursor = first["next_cursor"]
    while cursor:
        body = directory(w, query="?limit=1&cursor=" + cursor).json()
        seen.extend(row["id"] for row in body["data"])
        cursor = body["next_cursor"]
    assert str(added.id) not in seen
    assert seen == [str(item.id) for item in original if item != original[2]]


@pytest.mark.parametrize(
    "key", [None, "", "x" * 64, "17" * 31, "17" * 33, "AA" * 32, 123, b"a" * 32]
)
def test_invalid_key_fails_only_directory(http_world, settings, key):
    w = http_world
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = key
    safe_problem(directory(w), 500, "internal-error")
    for path in ("/api/v1/me", f"/api/v1/organisations/{w.first.id}"):
        assert w.client.get(path, HTTP_AUTHORIZATION="Bearer " + w.credential).status_code == 200


def test_rotation_invalidates_cursor(http_world, settings):
    w = http_world
    cursor = first_cursor(w)
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "28" * 32
    safe_problem(directory(w, query="?limit=1&cursor=" + cursor), 400, "validation-error")


@pytest.mark.parametrize("change", ["version", "order", "shape"])
def test_authenticated_malformed_cursor_payload(http_world, change):
    """Independently encode the documented binary envelope with the synthetic key."""
    import hashlib
    import hmac
    import struct
    from uuid import UUID

    w = http_world
    ceiling = max(item.id for item in w.models.Membership.objects.filter(organisation=w.first))
    after = w.member.id
    version = 1
    if change == "version":
        version = 2
    if change == "order":
        after = UUID(int=ceiling.int + 1)
    payload = struct.pack(
        "!B16s16sBBH16s16s",
        version,
        w.person.id.bytes,
        w.first.id.bytes,
        0,
        0,
        1,
        after.bytes,
        ceiling.bytes,
    )
    if change == "shape":
        payload += b"x"
    mac = hmac.digest(
        bytes.fromhex("17" * 32), b"membership-directory-cursor-v1\x00" + payload, hashlib.sha256
    )
    cursor = base64.urlsafe_b64encode(payload + mac).decode().rstrip("=")
    safe_problem(directory(w, query="?limit=1&cursor=" + cursor), 400, "validation-error")


def test_cursor_contains_no_contact_subject_or_bearer(http_world):
    w = http_world
    cursor = first_cursor(w)
    raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
    for value in (w.person.email, w.current.subject, w.credential):
        assert value.encode() not in raw
