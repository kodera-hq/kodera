"""Real signed requests and independently seeded current relationship expectations."""

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
from test_access_tokens import NOW, frozen_clock as frozen_clock
from test_customer_persistence_models import identity, raw_update


@pytest.fixture(autouse=True)
def directory_key(settings):
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "17" * 32


def directory(w, target=None, *, query="", credential=None, **headers):
    credential = w.credential if credential is None else credential
    return w.client.get(
        f"/api/v1/organisations/{w.first.id if target is None else target}/memberships" + query,
        HTTP_AUTHORIZATION="Bearer " + credential,
        **headers,
    )


def seed(w, *, state="active", role="org_member", enabled=True):
    user = w.models.User.objects.create(email=f"person-{uuid4().hex}@example.test", enabled=enabled)
    membership = w.models.Membership.objects.create(
        user=user,
        organisation=w.first,
        role=role,
        state=state,
        accepted_at=None if state == "invited" else timezone.now(),
    )
    return user, membership


def expected(item, user):
    def stamp(value):
        return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    return {
        "id": str(item.id),
        "organisation_id": str(item.organisation_id),
        "email": user.email,
        "display_name": user.display_name,
        "role": item.role,
        "state": item.state,
        "created_at": stamp(item.created_at),
        "updated_at": stamp(item.updated_at),
    }


def test_route_declared():
    try:
        match = resolve(f"/api/v1/organisations/{uuid4()}/memberships")
    except Resolver404:
        pytest.fail("membership directory route is absent")
    from core.api.scopes import ATTRIBUTE

    operations = getattr(match.func, ATTRIBUTE, ())
    assert [(op.method, op.operation_id, op.scope) for op in operations] == [
        ("GET", "listMemberships", "membership:read")
    ]


@pytest.mark.parametrize("role", ["org_owner", "org_admin", "org_member"])
def test_projection_population_and_no_writes(http_world, role):
    w = http_world
    raw_update(w.member, role=role)
    w.member.refresh_from_db()
    pairs = [(item.user, item) for item in w.models.Membership.objects.filter(organisation=w.first)]
    pairs.extend(seed(w, state=state) for state in ("invited", "active", "suspended"))
    pairs.append(seed(w, enabled=False))
    _, removed = seed(w, state="removed")
    _, deleted = seed(w)
    soft_delete(deleted)
    deleted_person, retained = seed(w)
    soft_delete(deleted_person)
    before = rows(w.models)
    response = directory(w)
    assert response.status_code == 200, "eligible directory role was refused"
    body = response.json()
    assert {row["id"] for row in body["data"]}.isdisjoint(
        {str(removed.id), str(deleted.id), str(retained.id)}
    ), "directory included an excluded relationship"
    want = [expected(item, user) for user, item in sorted(pairs, key=lambda pair: pair[1].id)]
    assert body["data"] == want, "directory invented an unavailable fact"
    assert body == {"data": want, "has_more": False, "next_cursor": None}
    assert response.headers["Cache-Control"] == "no-store" and "ETag" not in response.headers
    assert rows(w.models) == before, "directory GET wrote persisted facts"


def test_issuer_bound_target(http_world):
    w = http_world
    identity(w.models, w.second, w.person, subject="other-realm-identity")
    w.models.Membership.objects.create(
        user=w.person,
        organisation=w.second,
        role="org_owner",
        state="active",
        accepted_at=timezone.now(),
    )
    headers = {"HTTP_X_REQUEST_ID": "directory-target-proof"}
    foreign = directory(w, w.second.id, **headers)
    missing = directory(w, uuid4(), **headers)
    assert foreign.status_code == missing.status_code == 404, (
        "directory target escaped current issuer"
    )
    assert foreign.content == missing.content
    safe_problem(foreign, 404, "not-found")


def test_billing_denied(http_world):
    w = http_world
    raw_update(w.member, role="org_billing")
    response = directory(w)
    assert response.status_code == 403, "billing caller gained directory access"
    assert directory(w, query="?limit=bad").status_code == 403
    safe_problem(response, 403, "forbidden")


def test_revoked_grant(http_world):
    w = http_world
    assert directory(w).status_code == 200
    raw_update(w.member, state="removed")
    response = directory(w)
    assert response.status_code == 403, "revoked directory grant was accepted"


def test_conditional_current_authority(http_world):
    w = http_world
    for tag in ('"synthetic"', "*"):
        response = directory(w, HTTP_IF_NONE_MATCH=tag)
        assert response.status_code == 200, "directory conditional bypassed current authority"
        assert "ETag" not in response.headers
    raw_update(w.member, state="removed")
    response = directory(w, HTTP_IF_NONE_MATCH="*")
    assert response.status_code == 403, "directory conditional bypassed current authority"


@pytest.mark.parametrize(
    "entity,change,status",
    [
        ("current", "disabled", 403),
        ("current", "deleted", 403),
        ("person", "disabled", 403),
        ("person", "deleted", 403),
        ("member", "deleted", 403),
        ("member", "suspended", 403),
        ("member", "invited", 403),
        ("first", "deleted", 403),
        ("first", "prospect", 403),
        ("first", "closed", 403),
    ],
)
def test_current_authority(http_world, entity, change, status):
    w = http_world
    item = getattr(w, entity)
    if change == "deleted":
        soft_delete(item)
    elif change == "disabled":
        raw_update(item, enabled=False)
    elif change == "invited":
        raw_update(item, state="invited", accepted_at=None)
    else:
        raw_update(item, state=change)
    response = directory(w, query="?limit=bad")
    safe_problem(
        response, status, "identity-unknown" if entity in {"current", "person"} else "forbidden"
    )


def test_suspended_organisation(http_world):
    raw_update(http_world.first, state="suspended")
    assert directory(http_world).status_code == 200


def test_staff_and_unknown_subject(http_world, http_signer, settings):
    w = http_world
    safe_problem(
        directory(w, credential=token(http_signer, w.first.issuer, "absent")),
        403,
        "identity-unknown",
    )
    issuer = "https://identity.customer.test/realms/kodera-staff"
    configure(settings, [trust_entry(http_signer, issuer, lane="staff")])
    safe_problem(directory(w, credential=token(http_signer, issuer, amr=["mfa"])), 403, "forbidden")


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete", "head", "options"])
def test_get_only(http_world, method):
    w = http_world
    before = rows(w.models)
    response = getattr(w.client, method)(f"/api/v1/organisations/{w.first.id}/memberships")
    assert response.status_code == 405 and response.headers["Allow"] == "GET"
    assert response.headers["Cache-Control"] == "no-store"
    assert rows(w.models) == before


@pytest.mark.parametrize("value", ["bad", "x" * 100, "{" + str(uuid4()) + "}"])
def test_malformed_target(http_world, value):
    safe_problem(directory(http_world, value), 400, "validation-error")


def test_safe_auth_and_nested_errors(http_world, caplog):
    w = http_world
    response = directory(w, credential="sensitive-invalid-bearer", HTTP_X_REQUEST_ID="invalid id")
    body = safe_problem(response, 401, "unauthenticated", sentinels=("sensitive-invalid-bearer",))
    assert UUID(body["request_id"]).version == 7
    with transaction.atomic():
        response = directory(w)
    safe_problem(response, 500, "internal-error", sentinels=(w.credential, w.current.subject))
    assert not connection.in_atomic_block
    assert w.credential not in caplog.text


@pytest.mark.parametrize("email", ["UPPER+tag@EXAMPLE.test", '"quoted.local"@example.test'])
def test_valid_contact_bytes_preserved(http_world, email):
    w = http_world
    raw_update(w.person, email=email)
    response = directory(w)
    assert response.status_code == 200
    assert (
        next(row for row in response.json()["data"] if row["id"] == str(w.member.id))["email"]
        == email
    )


@pytest.mark.parametrize(
    "email",
    ["not-an-email", "bad\n@example.test", "bad space@example.test", "x" * 321 + "@example.test"],
)
def test_invalid_contact_safe_failure(http_world, email):
    w = http_world
    raw_update(w.person, email=email)
    safe_problem(directory(w), 500, "internal-error", sentinels=(email,))


def test_query_free_serialization(http_world, monkeypatch):
    from apps.orgs.api import memberships

    w = http_world
    original = memberships.serialize_page

    def wrapped(page):
        def no_query(*args):
            raise AssertionError("directory serializer performed database work")

        with connection.execute_wrapper(no_query):
            return original(page)

    monkeypatch.setattr(memberships, "serialize_page", wrapped)
    assert directory(w).status_code == 200


@pytest.mark.parametrize(
    "case",
    [
        "absent",
        "malformed",
        "oversized",
        "wrong-signature",
        "id",
        "refresh",
        "audience",
        "issuer",
        "expired",
        "key-url",
        "unknown-kid",
    ],
)
def test_signed_and_malformed_denials_before_sql(http_world, http_signer, case):
    w = http_world
    credential = w.credential
    if case == "absent":
        credential = None
    elif case == "malformed":
        credential = "broken.compact"
    elif case == "oversized":
        credential = "x" * 16385
    elif case == "wrong-signature":
        segments = credential.split(".")
        segments[2] = ("A" if segments[2][0] != "A" else "B") + segments[2][1:]
        credential = ".".join(segments)
    elif case == "id":
        credential = token(http_signer, w.first.issuer, typ="ID")
    elif case == "refresh":
        credential = token(http_signer, w.first.issuer, typ="Refresh")
    elif case == "audience":
        credential = token(http_signer, w.first.issuer, aud="another-api")
    elif case == "issuer":
        credential = token(http_signer, "https://untrusted.invalid/realms/alpha")
    elif case == "expired":
        credential = token(http_signer, w.first.issuer, iat=NOW - 120, exp=NOW - 31)
    else:
        from test_access_tokens import claims, sign

        headers = (
            {"jku": "https://untrusted.invalid/keys"} if case == "key-url" else {"kid": "unknown"}
        )
        credential = sign(
            http_signer, claims(iss=w.first.issuer, sub=w.current.subject), headers=headers
        )
    query_count = 0

    def count_real_sql(execute, statement, params, many, context):
        nonlocal query_count
        query_count += 1
        return execute(statement, params, many, context)

    with connection.execute_wrapper(count_real_sql):
        response = w.client.get(
            f"/api/v1/organisations/{w.first.id}/memberships",
            **({"HTTP_AUTHORIZATION": "Bearer " + credential} if credential is not None else {}),
        )
    assert query_count == 0, "unverified token reached the customer database"
    safe_problem(
        response,
        401,
        "unauthenticated",
        sentinels=(credential or "unused-token",),
    )
    assert directory(w).status_code == 200


@pytest.mark.parametrize(
    "header", ["Basic abc", "Bearer", "Bearer one two", "Bearer one, Bearer two"]
)
def test_malformed_authorization_never_falls_back_to_anonymous(http_world, header):
    safe_problem(
        http_world.client.get(
            f"/api/v1/organisations/{http_world.first.id}/memberships", HTTP_AUTHORIZATION=header
        ),
        401,
        "unauthenticated",
    )


def test_signed_role_claims_do_not_replace_persisted_role(http_world, http_signer):
    w = http_world
    raw_update(w.member, role="org_billing")
    forged = token(
        http_signer,
        w.first.issuer,
        role="org_owner",
        is_staff=True,
        realm_access={"roles": ["org_owner"]},
    )
    safe_problem(directory(w, credential=forged), 403, "forbidden")


def test_foreign_target_and_denied_role_precede_query_parsing(http_world):
    w = http_world
    query = "?" + "a&" * 1100
    assert directory(w, w.second.id, query=query).status_code == 404
    raw_update(w.member, role="org_billing")
    assert directory(w, query=query).status_code == 403


def test_canonical_timestamp_precision(http_world):
    w = http_world
    instant = w.member.created_at.replace(microsecond=123456)
    raw_update(w.member, created_at=instant, updated_at=instant)
    row = next(item for item in directory(w).json()["data"] if item["id"] == str(w.member.id))
    assert row["created_at"] == row["updated_at"] == instant.strftime("%Y-%m-%dT%H:%M:%S") + ".123Z"
