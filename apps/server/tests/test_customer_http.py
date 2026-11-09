"""Actual customer HTTP/SQL acceptance, pending the admitted implementation."""

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime

import pytest
import time_machine
from customer_http_fixtures import (
    ME,
    configure,
    http_signer as http_signer,
    http_world as http_world,
    request,
    require_route,
    rows,
    safe_problem,
    soft_delete,
    token,
    trust_entry,
)
from django.db import connection
from django.test import Client
from test_access_tokens import NOW, frozen_clock as frozen_clock
from test_customer_persistence_models import identity, raw_update


def test_customer_get_route_is_present_without_database():
    require_route()


def test_ar01_actual_rows_supply_complete_projection(http_world):
    w = http_world
    response = request(w.client, w.credential)
    assert response.status_code == 200, "persisted customer read was not accepted"
    body = response.json()
    assert set(body) == {"id", "email", "display_name", "staff", "identities", "organisations"}
    assert body["id"] == str(w.person.pk)
    assert body["email"] == w.person.email and body["display_name"] == w.person.display_name
    assert body["staff"] is False and "staff_roles" not in body and "locale" not in body
    expected = {
        "id": str(w.current.pk),
        "issuer": w.first.issuer,
        "realm": w.first.realm,
        "subject": w.current.subject,
        "email": w.current.email,
    }
    assert body["identities"] == [expected], "identity projection is not exact stored data"
    assert len(body["organisations"]) == 1
    item = body["organisations"][0]
    assert item["organisation"] == {
        "id": str(w.first.pk),
        "slug": w.first.slug,
        "name": w.first.name,
        "realm": w.first.realm,
    }
    assert item["membership_id"] == str(w.member.pk) and item["identity_id"] == str(w.current.pk)
    assert item["role"] == "org_member" and item["state"] == "active"
    assert item["joined_at"].endswith("Z")
    assert datetime.fromisoformat(item["joined_at"]) == w.member.accepted_at
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("fact", [True, False])
def test_registered_factor_projects_strict_boolean_only_on_current_identity(
    http_world, http_signer, monkeypatch, fact
):
    from apps.identity import services

    w = http_world
    linked = identity(w.models, w.second, w.person, subject="linked-factor-subject")
    credential = token(
        http_signer,
        w.first.issuer,
        email_verified=True,
        azp="synthetic-console",
        amr=["pwd", "otp"],
        kodera_mfa_enrolled=fact,
    )
    calls = []
    monkeypatch.setattr(
        services,
        "database_now",
        lambda: calls.append(True) or datetime.fromtimestamp(NOW, UTC),
    )
    response = request(w.client, credential)
    assert response.status_code == 200 and calls == [True]
    identities = {item["id"]: item for item in response.json()["identities"]}
    assert identities[str(w.current.id)]["mfa_enrolled"] is fact
    assert "mfa_enrolled" not in identities[str(linked.id)]


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"kodera_mfa_enrolled": "true"},
        # An admitted client that is not the Console: the token verifies, the factor is unknown.
        {"kodera_mfa_enrolled": True, "azp": "kodera-ios"},
        {"kodera_mfa_enrolled": True, "azp": "synthetic-console", "amr": ["OTP"]},
        {"kodera_mfa_enrolled": True, "azp": "synthetic-console", "amr": ["webauthn"]},
        {
            "kodera_mfa_enrolled": True,
            "azp": "synthetic-console",
            "amr": ["otp"],
            "email_verified": False,
        },
    ],
)
def test_registered_factor_unknown_is_omitted(http_world, http_signer, changes):
    credential = token(http_signer, http_world.first.issuer, **changes)
    identity_body = request(http_world.client, credential).json()["identities"][0]
    assert "mfa_enrolled" not in identity_body


@pytest.mark.parametrize("fact", [True, False])
def test_registered_factor_horizon_changes_content_and_etag(
    http_world, http_signer, monkeypatch, fact
):
    from apps.identity import services

    credential = token(
        http_signer,
        http_world.first.issuer,
        email_verified=True,
        azp="synthetic-console",
        amr=["otp"],
        kodera_mfa_enrolled=fact,
    )
    monkeypatch.setattr(services, "database_now", lambda: datetime.fromtimestamp(NOW + 289, UTC))
    before = request(http_world.client, credential)
    assert before.json()["identities"][0]["mfa_enrolled"] is fact
    monkeypatch.setattr(services, "database_now", lambda: datetime.fromtimestamp(NOW + 290, UTC))
    after = request(http_world.client, credential, HTTP_IF_NONE_MATCH=before.headers["ETag"])
    assert after.status_code == 200
    assert after.headers["ETag"] != before.headers["ETag"]
    assert "mfa_enrolled" not in after.json()["identities"][0]


@pytest.mark.parametrize("role", ["org_owner", "org_admin", "org_billing", "org_member"])
def test_ar02_all_current_roles_can_read(http_world, role):
    w = http_world
    raw_update(w.member, role=role)
    response = request(w.client, w.credential)
    assert response.status_code == 200
    assert response.json()["organisations"][0]["role"] == role


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
def test_ar03_signed_and_malformed_denials(http_world, http_signer, case):
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
        response = request(w.client, credential)
    assert query_count == 0, "unverified token reached the customer database"
    safe_problem(
        response,
        401,
        "unauthenticated",
        sentinels=(credential or "unused-token",),
    )
    assert request(w.client, w.credential).status_code == 200


@pytest.mark.parametrize(
    "header", ["Basic abc", "Bearer", "Bearer one two", "Bearer one, Bearer two"]
)
def test_malformed_authorization_never_falls_back_to_anonymous(http_world, header):
    safe_problem(http_world.client.get(ME, HTTP_AUTHORIZATION=header), 401, "unauthenticated")


def test_ar04_unknown_subject_and_equal_email_never_create_or_link(http_world, http_signer):
    w = http_world
    before = rows(w.models)
    credential = token(http_signer, w.first.issuer, subject="unknown-subject", email=w.person.email)
    # A token that verifies is never 401: an unknown subject is 403 identity-unknown, with no
    # Bearer challenge (AUTHZ.md section 2 step 6), and still creates or links nothing.
    response = request(w.client, credential)
    safe_problem(response, 403, "identity-unknown")
    assert "WWW-Authenticate" not in response.headers, "identity-unknown asked to re-authenticate"
    assert rows(w.models) == before, "authentication created or changed stored authority"


def test_ar05_exact_issuer_and_subject_select_distinct_people(http_world):
    w = http_world
    first = request(w.client, w.credential).json()
    second = request(w.client, w.other_credential).json()
    assert first["id"] == str(w.person.pk) and second["id"] == str(w.other.pk), (
        "issuer-specific identities were confused"
    )
    assert [i["issuer"] for i in first["identities"]] == [w.first.issuer]
    assert [i["issuer"] for i in second["identities"]] == [w.second.issuer]


def test_ar06_role_email_and_staff_claims_never_override_persistence(http_world, http_signer):
    w = http_world
    before = rows(w.models)
    credential = token(
        http_signer,
        w.first.issuer,
        email=w.other.email,
        realm_access={"roles": ["org_owner", "staff_operator"]},
        amr=["mfa"],
        is_staff=True,
    )
    body = request(w.client, credential).json()
    assert body["id"] == str(w.person.pk) and body["email"] == w.person.email
    assert body["staff"] is False and "staff_roles" not in body
    assert body["organisations"][0]["role"] == "org_member", "token role became customer authority"
    assert rows(w.models) == before


@pytest.mark.parametrize("state", ["removed", "suspended"])
def test_ar07_committed_membership_revocation_denies_same_token(http_world, state):
    w = http_world
    assert request(w.client, w.credential).status_code == 200
    raw_update(w.member, state=state)
    safe_problem(request(w.client, w.credential), 403, "forbidden")
    assert request(w.client, w.other_credential).status_code == 200


def test_ar08_role_change_is_visible_without_token_refresh(http_world, http_signer):
    w = http_world
    credential = token(http_signer, w.first.issuer, realm_access={"roles": ["org_admin"]})
    raw_update(w.member, role="org_admin")
    assert request(w.client, credential).json()["organisations"][0]["role"] == "org_admin"
    raw_update(w.member, role="org_member")
    assert request(w.client, credential).json()["organisations"][0]["role"] == "org_member"


@pytest.mark.parametrize("target", ["current", "person"])
@pytest.mark.parametrize("change", ["disable", "delete"])
def test_ar09_disabled_or_deleted_person_identity_denies(http_world, target, change):
    w = http_world
    assert request(w.client, w.credential).status_code == 200
    item = getattr(w, target)
    raw_update(item, enabled=False) if change == "disable" else soft_delete(item)
    safe_problem(request(w.client, w.credential), 403, "identity-unknown")
    assert request(w.client, w.other_credential).status_code == 200


@pytest.mark.parametrize("state", ["absent", "invited", "removed", "suspended", "deleted"])
def test_ar10_current_membership_eligibility(http_world, state):
    w = http_world
    if state == "absent":
        w.member.delete()
    elif state == "invited":
        raw_update(w.member, state=state, accepted_at=None)
    elif state == "deleted":
        soft_delete(w.member)
    else:
        raw_update(w.member, state=state)
    safe_problem(request(w.client, w.credential), 403, "forbidden")


@pytest.mark.parametrize(
    "state,status",
    [("active", 200), ("suspended", 200), ("prospect", 403), ("closed", 403), ("deleted", 403)],
)
def test_ar11_current_organisation_eligibility(http_world, state, status):
    w = http_world
    if state == "deleted":
        soft_delete(w.first)
    else:
        raw_update(w.first, state=state)
    response = request(w.client, w.credential)
    if status == 200:
        assert response.status_code == 200
    else:
        safe_problem(response, status, "forbidden")


@pytest.mark.parametrize("state", ["invited", "active", "suspended", "removed"])
def test_ar12_switcher_describes_explicit_links_without_granting_them(
    http_world, http_signer, state
):
    w = http_world
    linked = identity(w.models, w.second, w.person, subject="linked-existing-subject")
    member = w.models.Membership.objects.create(
        user=w.person,
        organisation=w.second,
        role="org_billing",
        state=state,
        accepted_at=None if state == "invited" else w.member.accepted_at,
    )
    response = request(w.client, w.credential)
    assert response.status_code == 200
    body = response.json()
    assert {i["id"] for i in body["identities"]} == {str(w.current.pk), str(linked.pk)}
    item = next(i for i in body["organisations"] if i["membership_id"] == str(member.pk))
    assert item["state"] == state and item["identity_id"] == str(linked.pk)
    other_token = token(http_signer, w.second.issuer, subject=linked.subject)
    assert request(w.client, other_token).status_code == (200 if state == "active" else 403)


@pytest.mark.parametrize(
    "change",
    ["identity-disabled", "identity-deleted", "membership-deleted", "organisation-deleted"],
)
def test_ar12_switcher_omits_unavailable_link_history(http_world, change):
    w = http_world
    linked = identity(w.models, w.second, w.person, subject="linked-existing-subject")
    member = w.models.Membership.objects.create(
        user=w.person,
        organisation=w.second,
        role="org_member",
        state="active",
        accepted_at=w.member.accepted_at,
    )
    if change == "identity-disabled":
        raw_update(linked, enabled=False)
    elif change == "identity-deleted":
        soft_delete(linked)
    elif change == "membership-deleted":
        soft_delete(member)
    else:
        soft_delete(w.second)
    body = request(w.client, w.credential).json()
    available_ids = {i["id"] for i in body["identities"]}
    entries = [i for i in body["organisations"] if i["membership_id"] == str(member.pk)]
    if change.startswith("identity-"):
        assert str(linked.pk) not in available_ids
        assert len(entries) == 1 and "identity_id" not in entries[0]
    elif change == "membership-deleted":
        assert not entries
    else:
        assert not entries and str(linked.pk) not in available_ids


def test_ar13_verified_staff_lane_is_explicitly_unimplemented(
    settings, http_signer, django_db_blocker
):
    issuer = "https://identity.customer.test/realms/kodera-staff"
    configure(settings, [trust_entry(http_signer, issuer, lane="staff")])
    credential = token(http_signer, issuer, realm_access={"roles": ["staff_operator"]}, amr=["mfa"])
    with django_db_blocker.block():
        safe_problem(request(Client(HTTP_HOST="127.0.0.1"), credential), 403, "forbidden")


def test_ar14_missing_and_expired_snapshot_denies(http_world, settings, http_signer):
    w = http_world
    configure(settings, [])
    safe_problem(request(w.client, w.credential), 401, "unauthenticated")
    configure(settings, [trust_entry(http_signer, w.first.issuer, expires_at=NOW + 60)])
    assert request(w.client, w.credential).status_code == 200
    with time_machine.travel(datetime.fromtimestamp(NOW + 61, UTC), tick=False):
        safe_problem(request(w.client, w.credential), 401, "unauthenticated")
        configure(settings, [trust_entry(http_signer, w.first.issuer, expires_at=NOW + 600)])
        assert request(w.client, w.credential).status_code == 200


@pytest.mark.parametrize("condition", ["exact", "weak", "list", "wildcard"])
def test_ar15_conditional_requests_never_skip_current_authority(http_world, condition):
    w = http_world
    first = request(w.client, w.credential)
    assert first.status_code == 200
    etag = first.headers["ETag"]
    conditional = {
        "exact": etag,
        "weak": "W/" + etag,
        "list": '"unmatched", W/' + etag,
        "wildcard": "*",
    }[condition]
    same = request(w.client, w.credential, HTTP_IF_NONE_MATCH=conditional)
    assert same.status_code == 304 and same.content == b""
    assert same.headers["ETag"] == etag and same.headers["Cache-Control"] == "no-store"
    assert re.fullmatch(r"[A-Za-z0-9_-]{8,64}", same.headers["X-Request-Id"])
    raw_update(w.member, state="removed")
    response = request(w.client, w.credential, HTTP_IF_NONE_MATCH=conditional)
    assert response.status_code == 403, "conditional response resurrected revoked authority"
    safe_problem(response, 403, "forbidden")


def test_etag_tracks_canonical_projection_not_hidden_timestamp(http_world):
    w = http_world
    first = request(w.client, w.credential)
    assert first.status_code == 200
    body = first.json()
    for name, key in (("identities", "id"), ("organisations", "membership_id")):
        assert [v[key] for v in body[name]] == sorted(v[key] for v in body[name])
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    assert first.headers["ETag"] == '"' + hashlib.sha256(canonical).hexdigest() + '"'
    raw_update(w.person, updated_at=w.person.updated_at.replace(year=2034))
    assert request(w.client, w.credential).headers["ETag"] == first.headers["ETag"]
    raw_update(w.person, display_name="Updated")
    changed = request(w.client, w.credential)
    assert changed.headers["ETag"] != first.headers["ETag"]


@pytest.mark.parametrize(
    "request_id", ["valid_ID-123", "bad", "x" * 63, "x" * 65, "unsafe/subject", "accent-é"]
)
def test_ar19_request_ids_are_safe_and_correlated(http_world, request_id):
    w = http_world
    response = request(w.client, "invalid-token", HTTP_X_REQUEST_ID=request_id)
    body = safe_problem(response, 401, "unauthenticated", sentinels=("invalid-token",))
    actual = body["request_id"]
    assert re.fullmatch(r"[A-Za-z0-9_-]{8,64}", actual)
    if request_id == "valid_ID-123":
        # A caller's id is kept under the `c-` namespace (core/api/edge.py).
        assert actual == "c-" + request_id
    else:
        assert actual != request_id and uuid.UUID(actual).version == 7


def test_ar19_denials_and_logs_do_not_contain_sensitive_sentinels(http_world, http_signer, caplog):
    w = http_world
    subject = "synthetic-subject-sentinel"
    email = "synthetic-email-sentinel@customer.test"
    credential = token(http_signer, w.first.issuer, subject=subject, email=email)
    caplog.set_level("DEBUG")
    # The token verifies and names no identity: 403 identity-unknown, whose WARNING line carries
    # the request id and the operation, never the subject, the email or the token.
    safe_problem(
        request(w.client, credential),
        403,
        "identity-unknown",
        sentinels=(credential, subject, email),
    )
    assert "identity-unknown correlation_id=" in caplog.text, "the refusal was not logged"
    if any(value in caplog.text for value in (credential, subject, email)):
        pytest.fail("sensitive sentinel appeared in customer request logs")


def test_ar20_repeated_reads_do_not_write_authority(http_world):
    w = http_world
    before = rows(w.models)
    statements = []

    def observe(execute, sql, params, many, context):
        statements.append(sql.lstrip().split(None, 1)[0].upper())
        return execute(sql, params, many, context)

    with connection.execute_wrapper(observe):
        for _ in range(3):
            assert request(w.client, w.credential).status_code == 200
    assert not {"INSERT", "UPDATE", "DELETE", "TRUNCATE"}.intersection(statements)
    assert rows(w.models) == before, "customer read changed authority-bearing rows"


@pytest.mark.parametrize("state", ["prospect", "closed", "suspended"])
def test_switcher_noncurrent_organisation_states_are_descriptions(http_world, http_signer, state):
    w = http_world
    linked = identity(w.models, w.second, w.person, subject="explicit-linked-subject")
    member = w.models.Membership.objects.create(
        user=w.person,
        organisation=w.second,
        role="org_member",
        state="active",
        accepted_at=w.member.accepted_at,
    )
    raw_update(w.second, state=state)
    response = request(w.client, w.credential)
    assert response.status_code == 200
    entries = [v for v in response.json()["organisations"] if v["membership_id"] == str(member.pk)]
    assert len(entries) == 1 and entries[0]["state"] == "active"
    assert "state" not in entries[0]["organisation"]
    linked_response = request(w.client, token(http_signer, w.second.issuer, subject=linked.subject))
    assert linked_response.status_code == (200 if state == "suspended" else 403)


def test_projection_arrays_sort_ids_instead_of_insertion_order(http_world):
    w = http_world
    earlier = uuid.UUID("019467a3-0f9b-7cc3-98c2-1fa48f28f562")
    linked = w.models.Identity.objects.create(
        id=earlier,
        user=w.person,
        organisation=w.second,
        issuer=w.second.issuer,
        realm=w.second.realm,
        subject="explicit-sorted-link",
        email="linked@customer.test",
        enabled=True,
    )
    member = w.models.Membership.objects.create(
        id=earlier,
        user=w.person,
        organisation=w.second,
        role="org_member",
        state="active",
        accepted_at=w.member.accepted_at,
    )
    assert linked.pk < w.current.pk and member.pk < w.member.pk
    response = request(w.client, w.credential)
    assert response.status_code == 200
    body = response.json()
    assert [v["id"] for v in body["identities"]] == [str(linked.pk), str(w.current.pk)]
    assert [v["membership_id"] for v in body["organisations"]] == [str(member.pk), str(w.member.pk)]
