"""Customer privacy routes enforce real bearer, current authority and durable scope boundaries."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import connection, transaction
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_onboarding import conformance_errors
from test_workspace_writer_role import _role
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity
from apps.orgs.models import Membership
from apps.orgs.privacy_models import AccountErasure, PrivacyErasure, PrivacyExport

pytestmark = pytest.mark.django_db


@pytest.fixture
def api(world, settings, http_signer, frozen_clock):
    org, _, members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])

    def call(
        scope,
        resource,
        *,
        actor=0,
        request_id=None,
        download=False,
        body=None,
        idem_header="x" * 24,
        credential=True,
        method=None,
        target=None,
    ):
        template = (
            (
                "/me/privacy"
                if scope == "account"
                else "/organisations/{organisation_id}/workspace/privacy"
            )
            + "/"
            + resource
        )
        if request_id is not None:
            template += "/{request_id}"
        if download:
            template += "/download"
        path = "/api/v1" + template.format(organisation_id=target or org.id, request_id=request_id)
        verb = method or ("post" if request_id is None else "get")
        headers = {}
        if verb == "post" and idem_header is not None:
            headers["HTTP_IDEMPOTENCY_KEY"] = idem_header
        if credential:
            headers["HTTP_AUTHORIZATION"] = "Bearer " + (
                credential
                if isinstance(credential, str)
                else token(http_signer, tokens[actor].issuer, tokens[actor].subject)
            )
        raw_payload = body if isinstance(body, (bytes, str)) else json.dumps(body)
        response = getattr(Client(), verb)(
            path,
            data=raw_payload if verb == "post" else None,
            content_type="application/json",
            **headers,
        )
        if verb in {"post", "get"}:
            assert conformance_errors(response, template, verb) == [], response.content
        assert response["Cache-Control"] == "no-store"
        return response

    return call


@pytest.mark.parametrize("scope", ["account", "workspace"])
@pytest.mark.parametrize(
    "resource,body", [("exports", {"format": "zip"}), ("deletions", {"confirmation": "delete"})]
)
def test_authentication_precedes_validation_on_all_routes(api, scope, resource, body):
    assert api(scope, resource, credential=False, body=body).status_code == 401
    assert api(scope, resource, request_id=uuid4(), credential=False).status_code == 401
    if resource == "exports":
        assert (
            api(scope, resource, request_id=uuid4(), download=True, credential=False).status_code
            == 401
        )


@pytest.mark.parametrize("actor", [1, 2])
@pytest.mark.parametrize("resource", ["exports", "deletions"])
def test_workspace_requires_current_owner(api, actor, resource):
    assert api("workspace", resource, actor=actor, body={}).status_code == 403
    assert api("workspace", resource, actor=actor, request_id=uuid4()).status_code == 403


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        True,
        {},
        {"format": "tar"},
        {"format": "zip", "includeMedia": 1},
        {"format": "zip", "include_media": True},
    ],
)
def test_export_body_strictly_matches_contract(api, body):
    assert api("account", "exports", body=body).status_code == 400


@pytest.mark.parametrize(
    "body",
    [
        {},
        [],
        {"confirmation": True},
        {"confirm": True},
        {"confirmation": "delete", "reason": 1},
        {"confirmation": "delete", "reason": "x" * 501},
        {"confirmation": "delete", "slug": "example"},
    ],
)
def test_deletion_body_strictly_matches_contract(api, body):
    assert api("account", "deletions", body=body).status_code == 400


@pytest.mark.parametrize("idem_header", ["short", "x" * 256, "contains a space", "é" * 20])
def test_invalid_idempotency_key_refuses_before_hold(api, idem_header):
    response = api("account", "exports", body={"format": "zip"}, idem_header=idem_header)
    assert response.status_code == 400
    assert response.json()["type"] == "https://kodera.io/problems/malformed-request"


@pytest.mark.parametrize("idem_header", [None, ""])
def test_missing_idempotency_key_returns_dedicated_problem_type(api, idem_header):
    response = api("account", "exports", body={"format": "zip"}, idem_header=idem_header)
    assert response.status_code == 400
    assert response.json()["type"] == "https://kodera.io/problems/idempotency-key-missing"


def test_duplicate_json_keys_oversized_body_and_nul_reason_are_refused(api):
    dup = '{"confirmation":"no","confirmation":"delete"}'
    assert api("account", "deletions", body=dup).status_code == 400
    assert api("account", "deletions", body="{" + " " * 5000 + "}").status_code == 400
    assert (
        api(
            "account", "deletions", body={"confirmation": "delete", "reason": "bad\x00reason"}
        ).status_code
        == 400
    )


@pytest.mark.parametrize("scope", ["account", "workspace"])
@pytest.mark.parametrize("media", [True, False])
def test_export_hold_never_admits_partial_rows(api, scope, media):
    response = api(scope, "exports", body={"format": "zip", "includeMedia": media})
    assert response.status_code == 503
    assert response["Retry-After"] == "60"
    assert response.json()["type"] == "https://kodera.io/problems/service-unavailable"
    assert response.json()["retry_after_s"] == 60
    assert not PrivacyExport.objects.exists()


def test_last_owner_must_transfer_before_account_deletion(api, world):
    org, _, members, _ = world
    refused_owner = api("account", "deletions", body={"confirmation": "delete"})
    assert refused_owner.status_code == 409
    assert refused_owner.json()["type"] == "https://kodera.io/problems/last-owner-protected"
    assert refused_owner.json()["organisation_id"] == str(org.id)
    Membership.objects.filter(pk=members[1].pk).update(role="org_owner")
    for scope in ("account", "workspace"):
        response = api(scope, "deletions", body={"confirmation": "delete", "reason": "Example"})
        assert response.status_code == 503 and response["Retry-After"] == "60"
        assert response.json()["retry_after_s"] == 60
    assert not AccountErasure.objects.exists() and not PrivacyErasure.objects.exists()


def export_row(world, scope="account", actor=0, status="queued"):
    org, _, members, _ = world
    identity = Identity.objects.get(user_id=members[actor].user_id, organisation=org)
    return PrivacyExport.objects.create(
        identity=identity,
        user_id=identity.user_id,
        scope=scope,
        organisation=org if scope == "workspace" else None,
        status=status,
        request_snapshot={},
        checkpoint={},
        expires_at=timezone.now() + timedelta(hours=1),
    )


@pytest.mark.parametrize("scope", ["account", "workspace"])
@pytest.mark.parametrize("status", ["queued", "running", "failed", "expired", "ready"])
def test_durable_export_read_and_download_hold(api, world, scope, status):
    row = export_row(world, scope, status=status)
    response = api(scope, "exports", request_id=row.id)
    assert response.status_code == 200 and response.json()["status"] == status
    assert response.json()["purgeAfter"] is None
    assert "ETag" in response
    response = api(scope, "exports", request_id=row.id, download=True)
    assert response.status_code == (503 if status == "ready" else 409)
    if status == "ready":
        assert response["Retry-After"] == "60"


def test_account_reads_never_disclose_other_actor_or_workspace(api, world):
    for row in (export_row(world, actor=1), export_row(world, scope="workspace")):
        for download in (False, True):
            assert (
                api("account", "exports", request_id=row.id, download=download).status_code == 404
            )
    assert api("workspace", "exports", request_id=export_row(world).id).status_code == 404


def test_unknown_rows_and_wrong_methods(api):
    for scope in ("account", "workspace"):
        for resource in ("exports", "deletions"):
            assert api(scope, resource, request_id=uuid4()).status_code == 404
            response = api(scope, resource, method="delete")
            assert response.status_code == 405 and response["Allow"] == "POST"
        assert api(scope, "exports", request_id=uuid4(), download=True).status_code == 404


@pytest.fixture
def privacy_writer(world):
    yield from _role()


def test_api_role_reads_exports_but_cannot_write_privacy_journals(api, world, privacy_writer):
    row = export_row(world)
    with acting_as(privacy_writer):
        assert api("account", "exports", request_id=row.id).status_code == 200
        for table in ("orgs_privacyexport", "orgs_privacyerasure", "orgs_accounterasure"):
            assert refused(f"DELETE FROM {table}") == INSUFFICIENT_PRIVILEGE  # noqa: S608 - fixed table allowlist
            assert refused(f"INSERT INTO {table} DEFAULT VALUES") == INSUFFICIENT_PRIVILEGE
            assert refused(f"UPDATE {table} SET id=id") == INSUFFICIENT_PRIVILEGE  # noqa: S608 - fixed table allowlist


def erasure_row(world, scope, *, actor=0, foreign=False, status="cutoff"):
    org, _, members, _ = world
    now = timezone.now()
    values = {
        "instruction_ref": "DSAR-1",
        "instruction_sha256": "a" * 64,
        "cutoff_at": now,
        "purge_not_before": now + timedelta(hours=1),
        "inventory": {},
        "inventory_sha256": "b" * 64,
        "status": status,
        "core_purged_at": now if status != "cutoff" else None,
        "completed_at": now if status == "complete" else None,
    }
    if scope == "account":
        model, table = AccountErasure, "orgs_accounterasure"
        values.update(
            user_reference=uuid4() if foreign else members[actor].user_id,
            requester_identity_reference=uuid4(),
        )
    else:
        model, table = PrivacyErasure, "orgs_privacyerasure"
        values.update(organisation_reference=uuid4() if foreign else org.id)
    # Owner-only seed isolates HTTP projection from cutoff, which would revoke the caller.
    # Every user trigger on the journal is restored before any API-role access; no finalizer runs.
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(f"ALTER TABLE {table} DISABLE TRIGGER USER")
        row = model.objects.create(**values)
        cursor.execute(f"ALTER TABLE {table} ENABLE TRIGGER USER")
    return row


@pytest.mark.parametrize("scope", ["account", "workspace"])
@pytest.mark.parametrize(
    "status,wire", [("cutoff", "running"), ("core_purged", "running"), ("complete", "completed")]
)
def test_api_role_reads_durable_erasure_without_inventing_retention(
    api, world, privacy_writer, scope, status, wire
):
    row = erasure_row(world, scope, status=status)
    with acting_as(privacy_writer):
        response = api(scope, "deletions", request_id=row.id)
    assert response.status_code == 200
    assert response.json()["status"] == wire
    assert response.json()["purgeAfter"] is None
    assert response.json()["expiresAt"] is None


@pytest.mark.parametrize("scope", ["account", "workspace"])
def test_erasure_scope_never_discloses_other_person_or_organisation(api, world, scope):
    row = erasure_row(world, scope, foreign=True)
    assert api(scope, "deletions", request_id=row.id).status_code == 404


def test_revoked_owner_and_outside_organisation_are_rechecked(api, world):
    org, _, members, _ = world
    row = export_row(world, scope="workspace")
    assert api("workspace", "exports", request_id=row.id, target=uuid4()).status_code == 404
    Membership.objects.filter(pk=members[1].id).update(role="org_owner")
    Membership.objects.filter(pk=members[0].id).update(role="org_member")
    assert api("workspace", "exports", request_id=row.id).status_code == 403
    assert api("workspace", "exports", body={"format": "zip"}).status_code == 403


def test_ready_but_expired_export_never_downloads(api, world):
    row = export_row(world, status="ready")
    PrivacyExport.objects.filter(pk=row.id).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert api("account", "exports", request_id=row.id).json()["status"] == "expired"
    assert api("account", "exports", request_id=row.id, download=True).status_code == 409


@pytest.mark.parametrize("scope", ["account", "workspace"])
def test_invalid_bearer_is_unauthenticated_on_every_operation(api, scope):
    for resource in ("exports", "deletions"):
        assert api(scope, resource, body={}, credential="invalid-token").status_code == 401
        assert (
            api(scope, resource, request_id=uuid4(), credential="invalid-token").status_code == 401
        )
    assert (
        api(
            scope, "exports", request_id=uuid4(), download=True, credential="invalid-token"
        ).status_code
        == 401
    )


@pytest.mark.parametrize("scope", ["account", "workspace"])
def test_only_declared_methods_are_admitted(api, scope):
    for resource in ("exports", "deletions"):
        response = api(scope, resource, request_id=uuid4(), method="delete")
        assert response.status_code == 405 and response["Allow"] == "GET"
    response = api(scope, "exports", request_id=uuid4(), download=True, method="delete")
    assert response.status_code == 405 and response["Allow"] == "GET"


def test_disabled_identity_refuses_previously_authorized_reads(api, world):
    org, _, members, _ = world
    row = export_row(world)
    Identity.objects.filter(user_id=members[0].user_id, organisation=org).update(enabled=False)
    response = api("account", "exports", request_id=row.id)
    assert response.status_code == 403
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"


def test_account_routes_require_active_membership_and_active_org_for_mutations(api, world):
    org, _, members, _ = world
    row = export_row(world, actor=2)
    Membership.objects.filter(pk=members[2].id).update(state="removed")
    assert api("account", "exports", actor=2, request_id=row.id).status_code == 403
    assert api("account", "exports", actor=2, body={"format": "zip"}).status_code == 403
    Membership.objects.filter(pk=members[2].id).update(state="active")
    org.state = "suspended"
    org.save(update_fields=["state"])
    assert api("account", "exports", actor=2, request_id=row.id).status_code == 200
    assert api("account", "exports", actor=2, body={"format": "zip"}).status_code == 403


@pytest.mark.parametrize("actor", [1, 2])
def test_account_self_service_is_available_to_admins_and_members(api, actor):
    assert api("account", "exports", actor=actor, body={"format": "zip"}).status_code == 503
    response = api("account", "deletions", actor=actor, body={"confirmation": "delete"})
    assert response.status_code == 503 and response["Retry-After"] == "60"
