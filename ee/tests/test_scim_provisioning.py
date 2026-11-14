"""RFC 7643 / RFC 7644 SCIM 2.0 provisioning, Okta/Entra lifecycle, & tenant isolation tests."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from django.test import Client, override_settings

from ee.scim.schemas import (
    SCIM_ENTERPRISE_USER_SCHEMA,
    SCIM_ERROR_SCHEMA,
    SCIM_GROUP_SCHEMA,
    SCIM_LIST_RESPONSE_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_SP_CONFIG_SCHEMA,
    SCIM_USER_SCHEMA,
)
from ee.scim.service import default_scim_service


@pytest.fixture
def enterprise_client(monkeypatch: pytest.MonkeyPatch) -> Client:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    return Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")


def _auth(token: str, *, tenant_header: str | None = None) -> dict[str, Any]:
    headers: dict[str, Any] = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
    if tenant_header is not None:
        headers["HTTP_X_KODERA_TENANT"] = tenant_header
    return headers


def test_scim_discovery_endpoints_and_token_security(enterprise_client: Client) -> None:
    with override_settings(KODERA_EDITION="enterprise"):
        token_full, rec_full = default_scim_service.tokens.issue_token(
            tenant_slug="acme-corp",
            description="Okta SCIM Connector",
        )
        token_ro, _ = default_scim_service.tokens.issue_token(
            tenant_slug="acme-corp",
            scopes={"scim:users:read"},
        )
        token_expired, _ = default_scim_service.tokens.issue_token(
            tenant_slug="acme-corp",
            expires_at=datetime.now(UTC) - timedelta(seconds=5),
        )

        # Stored secret is strictly 32-byte SHA-256 digest, never plaintext
        assert len(rec_full.secret_sha256) == 32
        assert token_full.encode("utf-8") not in rec_full.secret_sha256

        # Discovery: /ServiceProviderConfig, /Schemas, /ResourceTypes
        spc = enterprise_client.get(
            "/api/v1/ee/scim/v2/ServiceProviderConfig",
            **_auth(token_full),
        )
        assert spc.status_code == 200
        assert spc["Content-Type"] == "application/scim+json"
        assert spc.json()["schemas"] == [SCIM_SP_CONFIG_SCHEMA]
        assert spc.json()["patch"]["supported"] is True

        schemas = enterprise_client.get("/api/v1/ee/scim/v2/Schemas", **_auth(token_full))
        assert schemas.status_code == 200
        assert schemas.json()["totalResults"] == 2
        user_schema = enterprise_client.get(
            f"/api/v1/ee/scim/v2/Schemas/{SCIM_USER_SCHEMA}",
            **_auth(token_full),
        )
        assert user_schema.status_code == 200
        assert user_schema.json()["id"] == SCIM_USER_SCHEMA

        rtypes = enterprise_client.get("/api/v1/ee/scim/v2/ResourceTypes", **_auth(token_full))
        assert rtypes.status_code == 200
        assert {r["id"] for r in rtypes.json()["Resources"]} == {"User", "Group"}

        # Missing / invalid / expired token -> 401 RFC 7644 Error
        for bad_hdr in (
            {},
            _auth("scim_bad.secret"),
            _auth("not-a-scim-token"),
            _auth(token_expired),
        ):
            unauth = enterprise_client.get("/api/v1/ee/scim/v2/Users", **bad_hdr)
            assert unauth.status_code == 401
            assert unauth["Content-Type"] == "application/scim+json"
            assert unauth.json()["schemas"] == [SCIM_ERROR_SCHEMA]

        # Read-only token cannot POST /Users -> 403
        ro_write = enterprise_client.post(
            "/api/v1/ee/scim/v2/Users",
            data=json.dumps({"schemas": [SCIM_USER_SCHEMA], "userName": "bob@acme.fr"}),
            content_type="application/scim+json",
            **_auth(token_ro),
        )
        assert ro_write.status_code == 403
        assert ro_write.json()["schemas"] == [SCIM_ERROR_SCHEMA]

        # Instant token revocation immediately invalidates subsequent requests
        assert default_scim_service.tokens.revoke_token(rec_full.token_id) is True
        revoked_resp = enterprise_client.get("/api/v1/ee/scim/v2/Users", **_auth(token_full))
        assert revoked_resp.status_code == 401
        assert "revoked" in revoked_resp.json()["detail"].lower()


@pytest.mark.django_db(transaction=True)
def test_scim_okta_and_entra_user_group_lifecycle_and_instant_deprovisioning(
    enterprise_client: Client,
) -> None:
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation
    from django.db import transaction

    with transaction.atomic():
        org = Organisation.objects.create(
            slug="acme-scim-org",
            name="Acme SCIM SAS",
            realm="acme-scim-org",
            issuer="https://sso.kodera.test/realms/acme-scim-org",
        )
        SlugReservation.objects.create(organisation=org, slug=org.slug, state="provisional")

    with override_settings(KODERA_EDITION="enterprise"):
        token, _ = default_scim_service.tokens.issue_token(
            tenant_slug="acme-corp",
            organisation_id=org.id,
        )

        # 1. POST /Users (Okta / Entra provisioning)
        u1_resp = enterprise_client.post(
            "/api/v1/ee/scim/v2/Users",
            data=json.dumps(
                {
                    "schemas": [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA],
                    "userName": "Alice.Martin@acme.fr",
                    "externalId": "okta-00u1",
                    "name": {"givenName": "Alice", "familyName": "Martin"},
                    "displayName": "Alice Martin",
                    "active": True,
                    "emails": [{"value": "alice.martin@acme.fr", "type": "work", "primary": True}],
                    SCIM_ENTERPRISE_USER_SCHEMA: {"department": "Security"},
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert u1_resp.status_code == 201, u1_resp.content
        assert u1_resp["Content-Type"] == "application/scim+json"
        assert u1_resp["Location"].endswith(f"/Users/{u1_resp.json()['id']}")
        assert u1_resp["ETag"]
        u1_id = u1_resp.json()["id"]

        u2_resp = enterprise_client.post(
            "/api/v1/ee/scim/v2/Users",
            data=json.dumps(
                {
                    "schemas": [SCIM_USER_SCHEMA],
                    "userName": "bob@acme.fr",
                    "externalId": "entra-00u2",
                    "displayName": "Bob Dupont",
                    "active": True,
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert u2_resp.status_code == 201
        u2_id = u2_resp.json()["id"]

        # Case-insensitive userName uniqueness -> 409 uniqueness
        dup = enterprise_client.post(
            "/api/v1/ee/scim/v2/Users",
            data=json.dumps({"schemas": [SCIM_USER_SCHEMA], "userName": "alice.martin@acme.fr"}),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert dup.status_code == 409
        assert dup.json()["scimType"] == "uniqueness"

        # 2. Filter & Pagination (`filter=userName eq "..."`, `startIndex`, `count`)
        filtered = enterprise_client.get(
            "/api/v1/ee/scim/v2/Users",
            {"filter": 'userName eq "alice.martin@acme.fr"'},
            **_auth(token),
        )
        assert filtered.status_code == 200
        f_body = filtered.json()
        assert f_body["schemas"] == [SCIM_LIST_RESPONSE_SCHEMA]
        assert f_body["totalResults"] == 1
        assert f_body["Resources"][0]["id"] == u1_id

        page1 = enterprise_client.get(
            "/api/v1/ee/scim/v2/Users",
            {"startIndex": "1", "count": "1"},
            **_auth(token),
        ).json()
        page2 = enterprise_client.get(
            "/api/v1/ee/scim/v2/Users",
            {"startIndex": "2", "count": "1"},
            **_auth(token),
        ).json()
        assert page1["totalResults"] == 2 and page1["itemsPerPage"] == 1
        assert page2["totalResults"] == 2 and page2["itemsPerPage"] == 1
        assert page1["Resources"][0]["id"] != page2["Resources"][0]["id"]

        # 3. Groups lifecycle (`POST /Groups`, `PATCH` add & Entra filter remove, `DELETE`)
        grp_resp = enterprise_client.post(
            "/api/v1/ee/scim/v2/Groups",
            data=json.dumps(
                {
                    "schemas": [SCIM_GROUP_SCHEMA],
                    "displayName": "Security-Admins",
                    "members": [{"value": u1_id}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert grp_resp.status_code == 201
        grp_id = grp_resp.json()["id"]

        # Patch Group: add u2
        patch_add = enterprise_client.patch(
            f"/api/v1/ee/scim/v2/Groups/{grp_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "add", "path": "members", "value": [{"value": u2_id}]}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert patch_add.status_code == 200
        assert {m["value"] for m in patch_add.json()["members"]} == {u1_id, u2_id}

        # User GET reflects group membership
        u2_detail = enterprise_client.get(
            f"/api/v1/ee/scim/v2/Users/{u2_id}", **_auth(token)
        ).json()
        assert u2_detail["groups"][0]["value"] == grp_id

        # Patch Group: Entra ID style remove `members[value eq "<u2_id>"]`
        patch_rem = enterprise_client.patch(
            f"/api/v1/ee/scim/v2/Groups/{grp_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "Remove", "path": f'members[value eq "{u2_id}"]'}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert patch_rem.status_code == 200
        assert [m["value"] for m in patch_rem.json()["members"]] == [u1_id]

        # 4. Bind active sessions to u1 & u2, then trigger Okta & Entra `active: false` instant deprovisioning!
        default_scim_service.register_session("acme-corp", u1_id, "sess-web-01")
        default_scim_service.register_session("acme-corp", u1_id, "sess-mobile-02")
        default_scim_service.register_session("acme-corp", u2_id, "sess-entra-01")
        assert len(default_scim_service.active_sessions("acme-corp", u1_id)) == 2

        # Okta style pathless PatchOp: `{"op": "replace", "value": {"active": false}}`
        okta_deprov = enterprise_client.patch(
            f"/api/v1/ee/scim/v2/Users/{u1_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "replace", "value": {"active": False}}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert okta_deprov.status_code == 200
        assert okta_deprov.json()["active"] is False
        assert default_scim_service.active_sessions("acme-corp", u1_id) == frozenset()

        # Verify PostgreSQL Django User, Identity, and Membership were suspended immediately!
        ident_u1 = Identity.objects.get(organisation=org, subject="alice.martin@acme.fr")
        assert ident_u1.enabled is False
        assert User.objects.get(id=ident_u1.user_id).enabled is False
        assert (
            Membership.objects.get(organisation=org, user_id=ident_u1.user_id).state
            == Membership.State.SUSPENDED
        )

        # Microsoft Entra ID style PatchOp: `{"op": "Replace", "path": "active", "value": "False"}`
        entra_deprov = enterprise_client.patch(
            f"/api/v1/ee/scim/v2/Users/{u2_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "Replace", "path": "active", "value": "False"}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert entra_deprov.status_code == 200
        assert entra_deprov.json()["active"] is False
        assert default_scim_service.active_sessions("acme-corp", u2_id) == frozenset()

        events = default_scim_service.deprovision_events("acme-corp")
        assert len(events) == 2
        assert "sess-mobile-02" in events[0].revoked_sessions

        # 5. PUT & DELETE User + DELETE Group
        put_u2 = enterprise_client.put(
            f"/api/v1/ee/scim/v2/Users/{u2_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_USER_SCHEMA],
                    "userName": "bob.updated@acme.fr",
                    "displayName": "Bob Dupont Updated",
                    "active": True,
                }
            ),
            content_type="application/scim+json",
            **_auth(token),
        )
        assert put_u2.status_code == 200
        assert put_u2.json()["active"] is True

        del_u1 = enterprise_client.delete(f"/api/v1/ee/scim/v2/Users/{u1_id}", **_auth(token))
        assert del_u1.status_code == 204
        # Deleting u1 automatically removes u1 from group members
        grp_after = enterprise_client.get(
            f"/api/v1/ee/scim/v2/Groups/{grp_id}",
            **_auth(token),
        ).json()
        assert grp_after["members"] == []

        del_grp = enterprise_client.delete(f"/api/v1/ee/scim/v2/Groups/{grp_id}", **_auth(token))
        assert del_grp.status_code == 204


def test_scim_cross_tenant_bearer_token_isolation(enterprise_client: Client) -> None:
    with override_settings(KODERA_EDITION="enterprise"):
        token_alpha, _ = default_scim_service.tokens.issue_token(tenant_slug="tenant-alpha")
        token_beta, _ = default_scim_service.tokens.issue_token(tenant_slug="tenant-beta")

        beta_user = enterprise_client.post(
            "/api/v1/ee/scim/v2/tenants/tenant-beta/Users",
            data=json.dumps({"schemas": [SCIM_USER_SCHEMA], "userName": "secret@beta.fr"}),
            content_type="application/scim+json",
            **_auth(token_beta),
        )
        assert beta_user.status_code == 201
        beta_uid = beta_user.json()["id"]

        # 1. Tenant Alpha token rejected with 403 on Tenant Beta's explicit SCIM endpoint
        cross_path = enterprise_client.get(
            "/api/v1/ee/scim/v2/tenants/tenant-alpha/../tenant-beta/Users"
            if False
            else "/api/v1/ee/scim/v2/tenants/tenant-beta/Users",
            **_auth(token_alpha),
        )
        assert cross_path.status_code == 403
        assert cross_path.json()["schemas"] == [SCIM_ERROR_SCHEMA]

        # 2. Tenant Alpha token rejected with 403 when spoofing X-Kodera-Tenant: tenant-beta
        cross_hdr = enterprise_client.get(
            "/api/v1/ee/scim/v2/Users",
            **_auth(token_alpha, tenant_header="tenant-beta"),
        )
        assert cross_hdr.status_code == 403

        # 3. Tenant Alpha token sees 0 users in its own scope and gets 404 on Beta's user_id
        alpha_list = enterprise_client.get("/api/v1/ee/scim/v2/Users", **_auth(token_alpha)).json()
        assert alpha_list["totalResults"] == 0

        for method in ("get", "delete"):
            attempt = getattr(enterprise_client, method)(
                f"/api/v1/ee/scim/v2/Users/{beta_uid}",
                **_auth(token_alpha),
            )
            assert attempt.status_code == 404

        patch_attempt = enterprise_client.patch(
            f"/api/v1/ee/scim/v2/Users/{beta_uid}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "replace", "value": {"active": False}}],
                }
            ),
            content_type="application/scim+json",
            **_auth(token_alpha),
        )
        assert patch_attempt.status_code == 404

        # Confirm Beta's user remains untouched and active!
        still_active = enterprise_client.get(
            f"/api/v1/ee/scim/v2/Users/{beta_uid}",
            **_auth(token_beta),
        )
        assert still_active.status_code == 200 and still_active.json()["active"] is True
