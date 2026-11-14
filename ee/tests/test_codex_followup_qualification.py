"""PostgreSQL qualification tests for Enterprise Edition database boundary, fencing, erasure & key rotation.

Covers:
1. Sequence-free `ee_*` schema in `orgs.0032` + restricted `kodera_api` writer-role qualification
   (`assert_authority`, `assert_writer_grants`, full SAML/SCIM/Audit HTTP & service execution under
   `SET ROLE`, and `42501` refusal of DDL and append-only ledger/key mutations).
2. Single-snapshot `resolve_member_authority` admission + `fence_authenticated_ee_operation`
   two-connection interleave against concurrent role demotion (`409 authority_fenced`) and blocking
   privacy erasure cutoff (`403 tenant_cutoff_fenced`).
3. Organisation & account durable privacy erasure cutoff, operational `ee_*` row deletion, ledger
   actor PII scrubbing with unbroken structural SHA-256 hash chain, sibling-tenant preservation,
   and `orgs 0031 <-> 0032` migration round-trip.
4. `KODERA_EE_AUDIT_SIGNING_SEED` validation and historical Ed25519 audit-export verification across
   signing-key rotations via `public.ee_audit_signing_key`.
"""

from __future__ import annotations

import base64
import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.test import Client, RequestFactory, override_settings
from psycopg import sql

from ee.audit_export.crypto import canonical_json_bytes
from ee.audit_export.exporter import export_compliance_bundle
from ee.audit_export.ledger import default_audit_ledger
from ee.auth import (
    OWNER_ROLES,
    EeAuthError,
    authenticate_tenant_request,
    fence_authenticated_ee_operation,
)
from ee.saml.service import SamlIdpConfig, default_saml_service
from ee.saml.xml_security import SAML_ASSERTION_NS, SAML_PROTOCOL_NS, sign_enveloped_xml
from ee.scim.service import default_scim_service
from ee.tests.conftest import ProvisionedTestPrincipal

pytestmark = pytest.mark.django_db(transaction=True)

INSUFFICIENT_PRIVILEGE = "42501"
CHECK_VIOLATION = "23514"

EE_TABLES: tuple[str, ...] = (
    "ee_saml_idp",
    "ee_saml_pending_request",
    "ee_saml_replay_assertion",
    "ee_saml_principal",
    "ee_scim_token",
    "ee_scim_user",
    "ee_scim_group",
    "ee_scim_group_member",
    "ee_scim_session",
    "ee_scim_deprovision",
    "ee_audit_ledger",
    "ee_audit_signing_key",
)


def _current_pg_user() -> str:
    with connection.cursor() as cur:
        cur.execute("SELECT current_user")
        row = cur.fetchone()
        assert row is not None
        return str(row[0])


@contextmanager
def _acting_as(role: str) -> Iterator[None]:
    with connection.cursor() as cur:
        cur.execute(f'SET ROLE "{role}"')
    try:
        assert _current_pg_user() == role
        yield
        assert _current_pg_user() == role
    finally:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")


def _refused_sqlstate(statement: str, params: list[Any] | None = None) -> str | None:
    try:
        with transaction.atomic(), connection.cursor() as cur:
            if params is None:
                cur.execute(statement)
            else:
                cur.execute(statement, params)
    except DatabaseError as exc:
        return getattr(exc.__cause__, "sqlstate", None)
    return None


def _build_signed_saml_response(
    *,
    in_response_to: str,
    tenant_slug: str,
    idp_entity_id: str,
    email: str,
    sign_key: rsa.RSAPrivateKey,
    groups: tuple[str, ...] = ("kodera-admins",),
) -> str:
    now = datetime.now(UTC)
    resp_id = "_resp_" + uuid4().hex
    assn_id = "_assn_" + uuid4().hex
    issued = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    nb = (now - timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    noa = (now + timedelta(seconds=300)).strftime("%Y-%m-%dT%H:%M:%SZ")
    acs_url = f"http://127.0.0.1/api/v1/ee/sso/saml/{tenant_slug}/acs"
    sp_entity = f"http://127.0.0.1/api/v1/ee/sso/saml/{tenant_slug}/metadata"
    group_vals = "".join(f"<saml:AttributeValue>{g}</saml:AttributeValue>" for g in groups)
    unsigned = (
        f'<samlp:Response xmlns:samlp="{SAML_PROTOCOL_NS}" xmlns:saml="{SAML_ASSERTION_NS}" '
        f'ID="{resp_id}" Version="2.0" IssueInstant="{issued}" '
        f'Destination="{acs_url}" InResponseTo="{in_response_to}">'
        f"<saml:Issuer>{idp_entity_id}</saml:Issuer>"
        '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
        f'<saml:Assertion ID="{assn_id}" Version="2.0" IssueInstant="{issued}">'
        f"<saml:Issuer>{idp_entity_id}</saml:Issuer>"
        "<saml:Subject>"
        f'<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">{email}</saml:NameID>'
        '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        f'<saml:SubjectConfirmationData InResponseTo="{in_response_to}" NotOnOrAfter="{noa}" Recipient="{acs_url}"/>'
        "</saml:SubjectConfirmation>"
        "</saml:Subject>"
        f'<saml:Conditions NotBefore="{nb}" NotOnOrAfter="{noa}">'
        f"<saml:AudienceRestriction><saml:Audience>{sp_entity}</saml:Audience></saml:AudienceRestriction>"
        "</saml:Conditions>"
        "<saml:AttributeStatement>"
        f'<saml:Attribute Name="email"><saml:AttributeValue>{email}</saml:AttributeValue></saml:Attribute>'
        '<saml:Attribute Name="displayName"><saml:AttributeValue>Federation User</saml:AttributeValue></saml:Attribute>'
        f'<saml:Attribute Name="groups">{group_vals}</saml:Attribute>'
        "</saml:AttributeStatement>"
        "</saml:Assertion>"
        "</samlp:Response>"
    )
    return sign_enveloped_xml(unsigned, assn_id, sign_key)


def _open_secondary_pg_connection() -> psycopg.Connection[Any]:
    db_cfg = settings.DATABASES["default"]
    return psycopg.connect(
        dbname=str(db_cfg["NAME"]),
        user=str(db_cfg["USER"]),
        password=str(db_cfg["PASSWORD"]),
        host=str(db_cfg.get("HOST") or "127.0.0.1"),
        port=int(db_cfg.get("PORT") or 5432),
        autocommit=False,
    )


def _create_staff_operator_identity_id() -> UUID:
    from apps.identity.models import Identity, StaffRole, User

    user = User.objects.create(email=f"{uuid4()}@staff.kodera.test")
    principal = Identity.objects.create(
        user=user,
        realm="kodera-staff",
        issuer="https://identity.staff.test/realms/kodera-staff",
        subject=str(uuid4()),
        email=user.email,
    )
    StaffRole.objects.create(identity=principal, realm="kodera-staff", role="staff_operator")
    return UUID(str(principal.id))


def _create_erasure_world() -> tuple[Any, list[Any], list[Any]]:
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation
    from apps.workspaces.models import Workspace
    from django.utils import timezone

    from services.identity.access_tokens import VerifiedAccessToken

    with transaction.atomic():
        slug = "erase-" + uuid4().hex[:10]
        org = Organisation.objects.create(
            slug=slug,
            realm=slug,
            name="Erasure Target SAS",
            issuer=f"https://identity.example.org/realms/{slug}",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=org,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        Workspace.objects.create(organisation=org)
        members: list[Any] = []
        tokens: list[Any] = []
        for role in ("org_owner", "org_owner", "org_member"):
            subject = str(uuid4())
            user = User.objects.create(email=f"{subject}@erasure.test")
            Identity.objects.create(
                user=user,
                organisation=org,
                issuer=org.issuer,
                realm=slug,
                subject=subject,
                email=user.email,
            )
            member = Membership.objects.create(
                user=user,
                organisation=org,
                role=role,
                state="active",
                accepted_at=timezone.now(),
            )
            members.append(member)
            tokens.append(
                VerifiedAccessToken(
                    org.issuer,
                    subject,
                    ("kodera-server",),
                    0,
                    2**31,
                    None,
                    None,
                    None,
                    None,
                    email_verified=True,
                )
            )
        return org, members, tokens


def test_p1_1_ee_schema_zero_sequences_and_restricted_kodera_api_writer_role(
    monkeypatch: pytest.MonkeyPatch,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Verify sequence-free `ee_*` schema and end-to-end execution under `api_writer_role`."""
    from core.db.api_database_boundary import assert_authority, assert_writer_grants
    from core.db.api_writer_role import grant_statements

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    priv_key, _, cert_pem = rsa_idp_keypair
    owner = tenant_principal_factory("acme-corp", role="org_owner")

    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'ee_%'
            ORDER BY c.relname
            """
        )
        found_tables = tuple(str(r[0]) for r in cur.fetchall())
        assert set(found_tables) == set(EE_TABLES)

        cur.execute(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE 'ee_%'
            """
        )
        assert cur.fetchall() == [], "EE tables must never create PostgreSQL sequences"

    role = f"ee_api_writer_{uuid4().hex[:12]}"
    bad_role = f"ee_overgranted_{uuid4().hex[:12]}"
    with connection.cursor() as cur:
        cur.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for stmt in grant_statements(role):
            cur.execute(stmt)
        assert_authority(cur, role)
        assert_writer_grants(cur, role)

        cur.execute(f'CREATE ROLE "{bad_role}" NOLOGIN NOINHERIT')
        for stmt in grant_statements(bad_role):
            cur.execute(stmt)
        cur.execute(f'GRANT DELETE ON TABLE "ee_audit_ledger" TO "{bad_role}"')
        with pytest.raises(DatabaseError, match="API database role refused"):
            assert_writer_grants(cur, bad_role)

    try:
        with _acting_as(role):
            # 1. SAML IdP registration, update, metadata, AuthnRequest, and twice-exercised ACS sync
            reg_payload = {
                "idp_id": "okta-corp",
                "idp_entity_id": "https://idp.acme-corp.test/saml2",
                "idp_sso_url": "https://idp.acme-corp.test/sso",
                "public_key_pem": cert_pem,
                "verified_domains": ["acme.fr"],
                "group_role_mapping": {"kodera-admins": "org_admin"},
                "default_role": "org_member",
            }
            reg_resp = client.post(
                "/api/v1/ee/sso/saml/acme-corp/providers",
                data=json.dumps(reg_payload),
                content_type="application/json",
                headers=owner.headers,
            )
            assert reg_resp.status_code == 201, reg_resp.content

            reg_payload["default_role"] = "org_billing"
            upd_resp = client.post(
                "/api/v1/ee/sso/saml/acme-corp/providers",
                data=json.dumps(reg_payload),
                content_type="application/json",
                headers=owner.headers,
            )
            assert upd_resp.status_code == 201, upd_resp.content

            list_resp = client.get(
                "/api/v1/ee/sso/saml/acme-corp/providers",
                headers=owner.headers,
            )
            assert list_resp.status_code == 200
            assert len(list_resp.json()["providers"]) == 1

            meta_resp = client.get("/api/v1/ee/sso/saml/acme-corp/metadata")
            assert meta_resp.status_code == 200

            for groups_tuple in (("kodera-admins",), ()):
                login_resp = client.get(
                    "/api/v1/ee/sso/saml/acme-corp/login",
                    {"idp_id": "okta-corp", "return_path": "/workspace"},
                )
                assert login_resp.status_code == 200, login_resp.content
                login_data = login_resp.json()
                relay_state = str(login_data["relay_state"])
                request_id = str(login_data["request_id"])

                signed_xml = _build_signed_saml_response(
                    in_response_to=request_id,
                    tenant_slug="acme-corp",
                    idp_entity_id="https://idp.acme-corp.test/saml2",
                    email="federated.alice@acme.fr",
                    sign_key=priv_key,
                    groups=groups_tuple,
                )
                acs_resp = client.post(
                    "/api/v1/ee/sso/saml/acme-corp/acs",
                    data={
                        "SAMLResponse": base64.b64encode(signed_xml.encode("utf-8")).decode(
                            "ascii"
                        ),
                        "RelayState": relay_state,
                    },
                )
                assert acs_resp.status_code == 200, acs_resp.content

            # 2. SCIM token lifecycle, user create/deprovision/reactivate/delete, group CRUD
            raw_bearer, scim_tok = default_scim_service.tokens.issue_token(
                tenant_slug="acme-corp",
                description="Okta SCIM Writer Role Test",
                organisation_id=owner.organisation_id,
            )
            scim_headers = {"Authorization": f"Bearer {raw_bearer}"}

            u_resp = client.post(
                "/api/v1/ee/scim/v2/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "scim.bob@acme.fr",
                        "displayName": "Bob Martin",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_headers,
            )
            assert u_resp.status_code == 201, u_resp.content
            scim_user_id = str(u_resp.json()["id"])
            default_scim_service.register_session(
                "acme-corp",
                scim_user_id,
                "sess-writer-1",
                organisation_id=owner.organisation_id,
            )

            deprov_resp = client.patch(
                f"/api/v1/ee/scim/v2/Users/{scim_user_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": False}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_headers,
            )
            assert deprov_resp.status_code == 200, deprov_resp.content
            assert deprov_resp.json()["active"] is False

            react_resp = client.patch(
                f"/api/v1/ee/scim/v2/Users/{scim_user_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": True}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_headers,
            )
            assert react_resp.status_code == 200, react_resp.content
            assert react_resp.json()["active"] is True

            g_resp = client.post(
                "/api/v1/ee/scim/v2/Groups",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
                        "displayName": "Security Team",
                        "members": [{"value": scim_user_id}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_headers,
            )
            assert g_resp.status_code == 201, g_resp.content
            scim_group_id = g_resp.json()["id"]

            del_g_resp = client.delete(
                f"/api/v1/ee/scim/v2/Groups/{scim_group_id}",
                headers=scim_headers,
            )
            assert del_g_resp.status_code == 204

            del_u_resp = client.delete(
                f"/api/v1/ee/scim/v2/Users/{scim_user_id}",
                headers=scim_headers,
            )
            assert del_u_resp.status_code == 204
            assert default_scim_service.tokens.revoke_token(scim_tok.token_id) is True

            # 3. Compliance Audit event append, Ed25519 signed export, and server-key verification
            ev_resp = client.post(
                "/api/v1/ee/compliance/audit-exports/events",
                data=json.dumps(
                    {
                        "action": "policy.reviewed",
                        "target_urn": "urn:kodera:org:acme-corp",
                        "metadata": {"ticket": "SEC-101"},
                    }
                ),
                content_type="application/json",
                headers=owner.headers,
            )
            assert ev_resp.status_code == 201, ev_resp.content

            exp_resp = client.get(
                "/api/v1/ee/compliance/audit-exports",
                {"signing_algorithm": "ed25519", "format": "ndjson"},
                headers=owner.headers,
            )
            assert exp_resp.status_code == 200, exp_resp.content
            bundle = exp_resp.json()

            ver_resp = client.post(
                "/api/v1/ee/compliance/audit-exports/verify",
                data=json.dumps(
                    {
                        "manifest": bundle["manifest"],
                        "payload": bundle["payload"],
                    }
                ),
                content_type="application/json",
                headers=owner.headers,
            )
            assert ver_resp.status_code == 200, ver_resp.content
            assert ver_resp.json()["verified"] is True

            # 4. Privilege & FK guard refusals: no DDL, no UPDATE/DELETE on append-only tables,
            #    and `23503` when `organisation_id` does not exist in `orgs_organisation`.
            assert (
                _refused_sqlstate(
                    "INSERT INTO public.ee_audit_signing_key "
                    "(id, organisation_id, tenant_slug, algorithm, key_id, public_key_b64, public_key_pem, created_at) "
                    "VALUES (%s, %s, 'ghost', 'ed25519', 'k1', 'aa', 'bb', clock_timestamp())",
                    [uuid4(), uuid4()],
                )
                == "23503"
            )
            for forbidden_sql in (
                "CREATE TABLE public.ee_runtime_forbidden (id int)",
                "UPDATE public.ee_audit_ledger SET action = 'tampered'",
                "DELETE FROM public.ee_audit_ledger",
                "TRUNCATE public.ee_audit_ledger",
                "UPDATE public.ee_audit_signing_key SET key_id = 'tampered'",
                "DELETE FROM public.ee_audit_signing_key",
                "UPDATE public.ee_scim_deprovision SET reason = 'tampered'",
                "DELETE FROM public.ee_scim_deprovision",
            ):
                assert _refused_sqlstate(forbidden_sql) == INSUFFICIENT_PRIVILEGE, forbidden_sql
    finally:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")
            cur.execute(f'DROP OWNED BY "{role}"')
            cur.execute(f'DROP ROLE "{role}"')
            cur.execute(f'DROP OWNED BY "{bad_role}"')
            cur.execute(f'DROP ROLE "{bad_role}"')


def test_p1_2_single_snapshot_authority_and_two_connection_interleave_fence(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Prove `resolve_member_authority` + `fence_authenticated_ee_operation` close TOCTOU windows."""
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    rf = RequestFactory()
    owner = tenant_principal_factory("fence-corp", role="org_owner")
    second_owner = tenant_principal_factory("fence-corp", role="org_owner")
    assert second_owner.organisation_id == owner.organisation_id

    req = rf.get(
        "/api/v1/ee/compliance/audit-exports",
        HTTP_AUTHORIZATION=f"Bearer {owner.token}",
    )
    snapshot_principal = authenticate_tenant_request(req)
    assert snapshot_principal.role == "org_owner"

    # Interleave A: Concurrent demotion on a second PostgreSQL connection after snapshot admission
    with _open_secondary_pg_connection() as conn2:
        with conn2.cursor() as cur2:
            cur2.execute(
                """
                UPDATE public.orgs_membership
                SET role = 'org_member', updated_at = clock_timestamp()
                WHERE id = %s
                """,
                [owner.membership_id],
            )
        conn2.commit()

    with pytest.raises(EeAuthError) as demoted_exc:
        with fence_authenticated_ee_operation(snapshot_principal):
            pass
    assert demoted_exc.value.status == 409
    assert demoted_exc.value.code == "authority_fenced"

    # Interleave B: Concurrent blocking privacy erasure cutoff held on connection 2
    req2 = rf.get(
        "/api/v1/ee/compliance/audit-exports",
        HTTP_AUTHORIZATION=f"Bearer {second_owner.token}",
    )
    snapshot_owner2 = authenticate_tenant_request(req2)

    lock_acquired = threading.Event()
    worker_entered = threading.Event()
    outcomes: list[tuple[str, int]] = []
    staff_op_id = _create_staff_operator_identity_id()

    def _concurrent_fenced_export() -> None:
        connections.close_all()
        try:
            worker_entered.set()
            with fence_authenticated_ee_operation(snapshot_owner2):
                outcomes.append(("admitted", 200))
        except EeAuthError as exc:
            outcomes.append((exc.code, exc.status))
        finally:
            connections.close_all()

    with _open_secondary_pg_connection() as conn2:
        with conn2.cursor() as cur2:
            cur2.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                [str(second_owner.organisation_id)],
            )
            lock_acquired.set()

            worker = threading.Thread(target=_concurrent_fenced_export, daemon=True)
            worker.start()
            assert worker_entered.wait(timeout=5.0)
            # While conn2 holds the exclusive cutoff lock, the EE operation must wait, not pass.
            worker.join(timeout=0.15)
            assert worker.is_alive(), (
                "EE operation must block on active privacy_erasure_cutoff lock"
            )

            from core.db.ids import new_uuid7

            cur2.execute(
                "SELECT privacy_begin_erasure(%s, %s, %s, %s, clock_timestamp(), %s)",
                [
                    new_uuid7(),
                    second_owner.organisation_id,
                    "DEL-101",
                    "a" * 64,
                    staff_op_id,
                ],
            )
        conn2.commit()

        worker.join(timeout=5.0)
        assert not worker.is_alive()

    assert outcomes == [("tenant_cutoff_fenced", 403)]

    # Interleave C: In-flight yielded `FOR SHARE` fence under restricted `kodera_api` role
    # blocks concurrent membership demotion and user disable (`55P03` LockNotAvailable) until
    # the privileged operation commits, after which demotion succeeds and A is rejected (`409`/`403`).
    from core.db.api_database_boundary import assert_authority, assert_writer_grants
    from core.db.api_writer_role import grant_statements

    inflight_owner = tenant_principal_factory("yield-fence-corp", role="org_owner")
    co_owner = tenant_principal_factory("yield-fence-corp", role="org_owner")
    assert co_owner.organisation_id == inflight_owner.organisation_id

    writer_role = f"ee_fence_writer_{uuid4().hex[:12]}"
    with connection.cursor() as cur:
        cur.execute(f'CREATE ROLE "{writer_role}" NOLOGIN NOINHERIT')
        for stmt in grant_statements(writer_role):
            cur.execute(stmt)
        assert_authority(cur, writer_role)
        assert_writer_grants(cur, writer_role)

    try:
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        with _acting_as(writer_role):
            req_inflight = rf.get(
                "/api/v1/ee/compliance/audit-exports",
                {"redact_pii": "false"},
                HTTP_AUTHORIZATION=f"Bearer {inflight_owner.token}",
            )
            snapshot_inflight = authenticate_tenant_request(
                req_inflight,
                required_roles=OWNER_ROLES,
            )
            assert snapshot_inflight.role == "org_owner"

            with fence_authenticated_ee_operation(
                snapshot_inflight,
                required_roles=OWNER_ROLES,
            ) as seed_fenced:
                default_audit_ledger.append_event(
                    tenant_slug=seed_fenced.tenant_slug,
                    organisation_id=seed_fenced.organisation_id,
                    user_id=seed_fenced.user_id,
                    actor_type="customer_user",
                    actor_id=f"user:{seed_fenced.user_id}",
                    actor_label=seed_fenced.actor_email,
                    action="sso.idp.registered",
                    target_urn="urn:kodera:idp:okta",
                    source_ip="198.51.100.42",
                )

            # Connection A enters `fence_authenticated_ee_operation` and pauses at the yield
            # before `export_compliance_bundle` while holding `FOR SHARE` on user, org & membership.
            with fence_authenticated_ee_operation(
                snapshot_inflight,
                required_roles=OWNER_ROLES,
            ) as active_fenced:
                with _open_secondary_pg_connection() as conn2:
                    with pytest.raises(psycopg.errors.LockNotAvailable) as demote_blocked:
                        with conn2.cursor() as cur2:
                            cur2.execute("SET LOCAL lock_timeout = '150ms'")
                            cur2.execute(
                                """
                                UPDATE public.orgs_membership
                                SET role = 'org_member', updated_at = clock_timestamp()
                                WHERE id = %s
                                """,
                                [inflight_owner.membership_id],
                            )
                    assert demote_blocked.value.sqlstate == "55P03"
                    conn2.rollback()

                    with pytest.raises(psycopg.errors.LockNotAvailable) as disable_blocked:
                        with conn2.cursor() as cur2:
                            cur2.execute("SET LOCAL lock_timeout = '150ms'")
                            cur2.execute(
                                """
                                UPDATE public.identity_user
                                SET enabled = false
                                WHERE id = %s
                                """,
                                [inflight_owner.user_id],
                            )
                    assert disable_blocked.value.sqlstate == "55P03"
                    conn2.rollback()

                bundle = export_compliance_bundle(
                    ledger=default_audit_ledger,
                    tenant_slug=active_fenced.tenant_slug,
                    organisation_id=active_fenced.organisation_id,
                    signer=default_audit_ledger.ed25519_signer_for_tenant(
                        active_fenced.tenant_slug
                    ),
                    export_format="ndjson",
                    framework="SOC2",
                    redact_pii=False,
                )
                assert inflight_owner.email in bundle.payload_text

            # Once Connection A commits and releases its `FOR SHARE` fence, Connection B's
            # membership demotion succeeds immediately and advances `authority_revision`.
            with _open_secondary_pg_connection() as conn2:
                with conn2.cursor() as cur2:
                    cur2.execute("SET LOCAL lock_timeout = '150ms'")
                    cur2.execute(
                        """
                        UPDATE public.orgs_membership
                        SET role = 'org_admin', updated_at = clock_timestamp()
                        WHERE id = %s
                        """,
                        [inflight_owner.membership_id],
                    )
                conn2.commit()

            # Stale pre-demotion snapshot is rejected at the fence (`409 authority_fenced`).
            with pytest.raises(EeAuthError) as stale_after_demote:
                with fence_authenticated_ee_operation(
                    snapshot_inflight,
                    required_roles=OWNER_ROLES,
                ):
                    pass
            assert stale_after_demote.value.status == 409
            assert stale_after_demote.value.code == "authority_fenced"

            # Fresh HTTP unredacted export by demoted `org_admin` fails closed (`403`).
            admin_unredacted_resp = client.get(
                "/api/v1/ee/compliance/audit-exports",
                {"redact_pii": "false"},
                headers=inflight_owner.headers,
            )
            assert admin_unredacted_resp.status_code == 403
            assert admin_unredacted_resp.json()["code"] == "owner_required_for_unredacted_export"

            # Further demoting to `org_member` rejects even standard redacted admin export (`403`).
            with _open_secondary_pg_connection() as conn2:
                with conn2.cursor() as cur2:
                    cur2.execute("SET LOCAL lock_timeout = '150ms'")
                    cur2.execute(
                        """
                        UPDATE public.orgs_membership
                        SET role = 'org_member', updated_at = clock_timestamp()
                        WHERE id = %s
                        """,
                        [inflight_owner.membership_id],
                    )
                conn2.commit()

            member_export_resp = client.get(
                "/api/v1/ee/compliance/audit-exports",
                headers=inflight_owner.headers,
            )
            assert member_export_resp.status_code == 403
            assert member_export_resp.json()["code"] == "insufficient_role"
    finally:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")
            cur.execute(f'DROP OWNED BY "{writer_role}"')
            cur.execute(f'DROP ROLE "{writer_role}"')


def test_p1_3_organisation_and_account_erasure_cutoff_purge_scrub_and_migration_roundtrip(
    monkeypatch: pytest.MonkeyPatch,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Prove account & organisation erasure purge EE PII, scrub audit rows, and preserve hash chain."""
    from apps.identity.models import Identity
    from apps.orgs.account_erasure_services import (
        AccountAbsenceProof,
        AccountErasureAdapter,
        advance_account_erasure,
        begin_account_erasure,
    )
    from apps.orgs.erasure_services import (
        AbsenceProof,
        ErasureAdapter,
        advance_erasure,
        begin_erasure,
        database_now,
    )

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    _, _, cert_pem = rsa_idp_keypair

    target_org, members, tokens = _create_erasure_world()
    sibling_owner = tenant_principal_factory("sibling-corp", role="org_owner")

    def _seed_ee_for_org(
        *,
        org_id: UUID,
        slug: str,
        user_a_id: UUID,
        user_a_email: str,
        user_b_id: UUID,
        user_b_email: str,
    ) -> None:
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug=slug,
                idp_id="okta-main",
                idp_entity_id=f"https://idp.{slug}.test/saml2",
                idp_sso_url=f"https://idp.{slug}.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset(
                    {user_a_email.split("@")[1], user_b_email.split("@")[1]}
                ),
                organisation_id=org_id,
            ),
        )
        default_saml_service.create_authn_request(
            tenant_slug=slug,
            idp_id="okta-main",
            sp_base_url="http://127.0.0.1",
            return_path="/app",
        )
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.ee_saml_replay_assertion
                    (id, organisation_id, tenant_slug, idp_entity_id, assertion_id, expires_at)
                VALUES (%s, %s, %s, %s, %s, clock_timestamp() + interval '10 minutes')
                """,
                [uuid4(), org_id, slug, f"https://idp.{slug}.test/saml2", f"_assn_{uuid4().hex}"],
            )
            for uid, uemail in ((user_a_id, user_a_email), (user_b_id, user_b_email)):
                cur.execute(
                    """
                    INSERT INTO public.ee_saml_principal (
                        id, organisation_id, user_id, principal_ref, tenant_slug, email_lower,
                        idp_id, idp_entity_id, assertion_id, subject_name_id, email,
                        display_name, groups_json, role, return_path, authenticated_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s,
                        'okta-main', %s, %s, %s, %s,
                        'SAML Person', '[]', 'member', '/app', clock_timestamp(), clock_timestamp()
                    )
                    """,
                    [
                        uuid4(),
                        org_id,
                        uid,
                        str(uid),
                        slug,
                        uemail.lower(),
                        f"https://idp.{slug}.test/saml2",
                        f"_assn_{uuid4().hex}",
                        uemail,
                        uemail,
                    ],
                )

        default_scim_service.tokens.issue_token(
            tenant_slug=slug, description="SCIM Sync", organisation_id=org_id
        )
        su_a = default_scim_service.create_user(
            tenant_slug=slug,
            payload={"userName": user_a_email, "displayName": "Member Alpha", "active": True},
            base_url="http://127.0.0.1/api/v1/ee/scim/v2",
            organisation_id=org_id,
        )
        su_b = default_scim_service.create_user(
            tenant_slug=slug,
            payload={"userName": user_b_email, "displayName": "Member Beta", "active": True},
            base_url="http://127.0.0.1/api/v1/ee/scim/v2",
            organisation_id=org_id,
        )
        su_a_id = str(su_a["id"])
        su_b_id = str(su_b["id"])
        default_scim_service.register_session(
            slug, su_a_id, f"sess-a-{slug}", organisation_id=org_id
        )
        default_scim_service.register_session(
            slug, su_b_id, f"sess-b-{slug}", organisation_id=org_id
        )
        default_scim_service.create_group(
            tenant_slug=slug,
            payload={
                "displayName": "Core Team",
                "members": [{"value": su_a_id}, {"value": su_b_id}],
            },
            base_url="http://127.0.0.1/api/v1/ee/scim/v2",
            organisation_id=org_id,
        )
        # Deprovision + reactivate user_a so `ee_scim_deprovision` has a row bound to user_a_id
        default_scim_service.patch_user(
            tenant_slug=slug,
            user_id=su_a_id,
            payload={
                "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                "Operations": [{"op": "replace", "path": "active", "value": False}],
            },
            base_url="http://127.0.0.1/api/v1/ee/scim/v2",
            organisation_id=org_id,
        )
        default_scim_service.patch_user(
            tenant_slug=slug,
            user_id=su_a_id,
            payload={
                "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                "Operations": [{"op": "replace", "path": "active", "value": True}],
            },
            base_url="http://127.0.0.1/api/v1/ee/scim/v2",
            organisation_id=org_id,
        )
        default_scim_service.register_session(
            slug, su_a_id, f"sess-a2-{slug}", organisation_id=org_id
        )

        default_audit_ledger.append_event(
            tenant_slug=slug,
            organisation_id=org_id,
            user_id=user_a_id,
            actor_type="customer_user",
            actor_id=str(user_a_id),
            actor_label=user_a_email,
            action="document.exported",
            target_urn=f"urn:kodera:org:{slug}",
            source_ip="198.51.100.42",
            metadata={"email": user_a_email, "ip": "198.51.100.42"},
        )
        default_audit_ledger.append_event(
            tenant_slug=slug,
            organisation_id=org_id,
            user_id=user_b_id,
            actor_type="customer_user",
            actor_id=str(user_b_id),
            actor_label=user_b_email,
            action="saml.idp.configured",
            target_urn=f"urn:kodera:org:{slug}",
            source_ip="198.51.100.99",
            metadata={"email": user_b_email},
        )
        from ee.audit_export.exporter import export_compliance_bundle

        export_compliance_bundle(
            ledger=default_audit_ledger,
            tenant_slug=slug,
            organisation_id=org_id,
            signer=default_audit_ledger.ed25519_signer_for_tenant(slug),
            export_format="ndjson",
            framework="SOC2",
            redact_pii=True,
        )

    sibling_second = tenant_principal_factory("sibling-corp", role="org_member")
    _seed_ee_for_org(
        org_id=target_org.id,
        slug=target_org.slug,
        user_a_id=members[0].user_id,
        user_a_email=members[0].user.email,
        user_b_id=members[1].user_id,
        user_b_email=members[1].user.email,
    )
    _seed_ee_for_org(
        org_id=sibling_owner.organisation_id,
        slug="sibling-corp",
        user_a_id=sibling_owner.user_id,
        user_a_email=sibling_owner.email,
        user_b_id=sibling_second.user_id,
        user_b_email=sibling_second.email,
    )

    # --- PART A: Individual Account Erasure for `members[0]` ---
    erased_person_id = members[0].user_id
    acct_row = begin_account_erasure(
        verified=replace(tokens[0], auth_time=int(database_now().timestamp())),
        confirmation="delete",
        instruction_ref="DEL-201",
        instruction_sha256="7" * 64,
        purge_not_before=database_now(),
        actor_identity_id=_create_staff_operator_identity_id(),
    )

    # Post-account-cutoff trigger refuses new EE row bound to `erased_person_id`
    with pytest.raises(IntegrityError, match="durable account cutoff"), transaction.atomic():
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.ee_scim_deprovision (
                    id, organisation_id, scim_user_id, user_id, tenant_slug,
                    user_name, reason, revoked_sessions_json, occurred_at
                ) VALUES (%s, %s, %s, %s, %s, 'post@cutoff.test', 'test', '[]', clock_timestamp())
                """,
                [uuid4(), target_org.id, uuid4(), erased_person_id, target_org.slug],
            )

    class _AcctAdapter:
        revision = "ee-acct-control-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope: Any) -> AccountAbsenceProof:
            return AccountAbsenceProof(
                scope.request_id,
                scope.user_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "8" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope: Any, proof: AccountAbsenceProof) -> bool:
            return proof.evidence_sha256 == "8" * 64

    acct_adapters: dict[str, AccountErasureAdapter] = {
        str(dom): _AcctAdapter(str(dom)) for dom in acct_row.inventory["required_domains"]
    }
    acct_result = advance_account_erasure(acct_row.id, acct_adapters)
    assert acct_result["complete"] is True and not acct_result["held_domains"]

    with connection.cursor() as cur:
        for tbl in ("ee_saml_principal", "ee_scim_user", "ee_scim_session", "ee_scim_deprovision"):
            person_count_q = sql.SQL("SELECT count(*) FROM public.{} WHERE user_id = %s").format(
                sql.Identifier(tbl)
            )
            cur.execute(person_count_q, [erased_person_id])
            row_erased = cur.fetchone()
            assert row_erased is not None and row_erased[0] == 0, (
                f"{tbl} must have 0 rows for erased person"
            )
            cur.execute(person_count_q, [members[1].user_id])
            row_colleague = cur.fetchone()
            assert row_colleague is not None
            if tbl != "ee_scim_deprovision":
                assert row_colleague[0] >= 1, f"{tbl} for active colleague must remain intact"

        cur.execute(
            """
            SELECT actor_label, source_ip, metadata_json, pii_scrubbed_at
            FROM public.ee_audit_ledger
            WHERE user_id = %s
            """,
            [erased_person_id],
        )
        scrubbed_row = cur.fetchone()
        assert scrubbed_row is not None
        assert scrubbed_row[0] == f"erased:{erased_person_id}"
        assert scrubbed_row[1] == ""
        assert scrubbed_row[2] == "{}"
        assert scrubbed_row[3] is not None

    vault_ok_after_acct, errs_acct = default_audit_ledger.verify_vault_integrity(target_org.slug)
    assert vault_ok_after_acct is True and errs_acct == []

    # --- PART B: Organisation Erasure on `target_org` ---
    org_row = begin_erasure(
        organisation_id=target_org.id,
        instruction_ref="DEL-301",
        instruction_sha256="1" * 64,
        purge_not_before=database_now(),
        actor_identity_id=_create_staff_operator_identity_id(),
    )

    # Post-org-cutoff writes are refused at both service pre-check and DB trigger layers
    with pytest.raises(PermissionError):
        default_scim_service.tokens.issue_token(
            tenant_slug=target_org.slug, organisation_id=target_org.id
        )
    with pytest.raises(IntegrityError, match="durable erasure cutoff"), transaction.atomic():
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.ee_audit_signing_key (
                    id, organisation_id, tenant_slug, algorithm, key_id,
                    public_key_b64, public_key_pem, created_at
                ) VALUES (%s, %s, %s, 'ed25519', 'post-cutoff-k', 'aa', 'bb', clock_timestamp())
                """,
                [uuid4(), target_org.id, target_org.slug],
            )

    class _OrgAdapter:
        revision = "ee-org-control-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope: Any) -> AbsenceProof:
            return AbsenceProof(
                scope.request_id,
                scope.organisation_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "4" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope: Any, proof: AbsenceProof) -> bool:
            return proof.evidence_sha256 == "4" * 64

    org_adapters: dict[str, ErasureAdapter] = {
        str(dom): _OrgAdapter(str(dom)) for dom in org_row.inventory["required_domains"]
    }
    org_result = advance_erasure(org_row.id, org_adapters)
    assert org_result["complete"] is True and not org_result["held_domains"]

    with connection.cursor() as cur:
        for tbl in EE_TABLES:
            org_count_q = sql.SQL(
                "SELECT count(*) FROM public.{} WHERE organisation_id = %s"
            ).format(sql.Identifier(tbl))
            if tbl == "ee_audit_ledger":
                cur.execute(
                    """
                    SELECT count(*), count(*) FILTER (
                        WHERE actor_label = 'erased'
                          AND source_ip = ''
                          AND metadata_json = '{}'
                          AND pii_scrubbed_at IS NOT NULL
                    )
                    FROM public.ee_audit_ledger
                    WHERE organisation_id = %s
                    """,
                    [target_org.id],
                )
                ledger_counts = cur.fetchone()
                assert ledger_counts is not None
                total_rows, scrubbed_rows = ledger_counts
                assert total_rows == 2 and scrubbed_rows == 2
            else:
                cur.execute(org_count_q, [target_org.id])
                target_cnt = cur.fetchone()
                assert target_cnt is not None and target_cnt[0] == 0, (
                    f"{tbl} must be completely purged for target_org"
                )

            # Sibling tenant rows must remain untouched across all 12 tables
            cur.execute(org_count_q, [sibling_owner.organisation_id])
            sibling_cnt = cur.fetchone()
            assert sibling_cnt is not None and sibling_cnt[0] >= 1, (
                f"{tbl} for sibling_org must remain intact"
            )

    vault_ok_after_org, errs_org = default_audit_ledger.verify_vault_integrity(target_org.slug)
    assert vault_ok_after_org is True and errs_org == []
    assert Identity.objects.filter(organisation=target_org).exists()

    # --- PART C: Migration `orgs 0031 <-> 0032` Round-Trip ---
    call_command("migrate", "orgs", "0031", verbosity=0)
    with connection.cursor() as cur:
        cur.execute("SELECT to_regclass('public.ee_audit_ledger')")
        assert cur.fetchone()[0] is None
    call_command("migrate", "orgs", "0032", verbosity=0)
    with connection.cursor() as cur:
        for tbl in EE_TABLES:
            cur.execute("SELECT to_regclass(%s)", [f"public.{tbl}"])
            assert cur.fetchone()[0] == tbl


def test_p2_ee_audit_signing_seed_validation_and_historical_key_rotation_verification(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Verify `KODERA_EE_AUDIT_SIGNING_SEED` validation and multi-key rotation verification."""
    from config.environment import ee_audit_signing_seed

    assert ee_audit_signing_seed({}) is None
    assert ee_audit_signing_seed({"KODERA_EE_AUDIT_SIGNING_SEED": ""}) is None

    valid_seed_str = "K9mP2vX8qL4nR7wZ1cY5bN3jH6tF0dGsW2eA9uJ4"
    assert ee_audit_signing_seed({"KODERA_EE_AUDIT_SIGNING_SEED": valid_seed_str}) == (
        valid_seed_str.encode("utf-8")
    )

    for invalid_val in (
        "too-short-seed",
        " " + valid_seed_str,
        "a" * 48,
        "-----BEGIN PRIVATE KEY-----abcdefghijklmnopqrstuv",
        "non-ascii-éèàçù-" + valid_seed_str,
    ):
        with pytest.raises(ImproperlyConfigured) as cfg_exc:
            ee_audit_signing_seed({"KODERA_EE_AUDIT_SIGNING_SEED": invalid_val})
        assert invalid_val.strip() not in str(cfg_exc.value)

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    owner = tenant_principal_factory("rotation-corp", role="org_owner")

    seed_gen_1 = b"Gen1-AuditSigningSeed-HighEntropy-9876543210!"
    seed_gen_2 = b"Gen2-AuditSigningSeed-HighEntropy-ABCDEF0123!"

    with override_settings(
        KODERA_EE_AUDIT_SIGNING_SEED=seed_gen_1,
        SECRET_KEY="sk-gen-1-" + "x" * 48,
    ):
        ev1 = client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps({"action": "key.gen1.recorded", "target_urn": "urn:kodera:gen:1"}),
            content_type="application/json",
            headers=owner.headers,
        )
        assert ev1.status_code == 201
        exp1 = client.get(
            "/api/v1/ee/compliance/audit-exports",
            {"signing_algorithm": "ed25519", "format": "ndjson"},
            headers=owner.headers,
        )
        assert exp1.status_code == 200, exp1.content
        bundle_gen_1 = exp1.json()

    with override_settings(
        KODERA_EE_AUDIT_SIGNING_SEED=seed_gen_2,
        SECRET_KEY="sk-gen-2-" + "y" * 48,
    ):
        ev2 = client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps({"action": "key.gen2.recorded", "target_urn": "urn:kodera:gen:2"}),
            content_type="application/json",
            headers=owner.headers,
        )
        assert ev2.status_code == 201
        exp2 = client.get(
            "/api/v1/ee/compliance/audit-exports",
            {"signing_algorithm": "ed25519", "format": "ndjson"},
            headers=owner.headers,
        )
        assert exp2.status_code == 200, exp2.content
        bundle_gen_2 = exp2.json()

        assert bundle_gen_1["manifest"]["key_id"] != bundle_gen_2["manifest"]["key_id"]

        # Both historical Generation 1 AND active Generation 2 bundles MUST verify after rotation!
        for candidate in (bundle_gen_1, bundle_gen_2):
            ver = client.post(
                "/api/v1/ee/compliance/audit-exports/verify",
                data=json.dumps(
                    {
                        "manifest": candidate["manifest"],
                        "payload": candidate["payload"],
                    }
                ),
                content_type="application/json",
                headers=owner.headers,
            )
            assert ver.status_code == 200, ver.content
            assert ver.json()["verified"] is True

        # Attacker self-signed Ed25519 bundle with untrusted embedded `public_key_pem` MUST fail!
        attacker_priv = ed25519.Ed25519PrivateKey.generate()
        attacker_pem = (
            attacker_priv.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("ascii")
        )
        forged_manifest = dict(bundle_gen_1["manifest"])
        forged_manifest.pop("signature", None)
        forged_manifest["key_id"] = "ed25519-attacker000000"
        forged_manifest["public_key_pem"] = attacker_pem
        sig_payload = b"kodera-audit-manifest-v1\x00" + canonical_json_bytes(forged_manifest)
        forged_manifest["signature"] = base64.b64encode(attacker_priv.sign(sig_payload)).decode(
            "ascii"
        )
        forged_ver = client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "manifest": forged_manifest,
                    "payload": bundle_gen_1["payload"],
                }
            ),
            content_type="application/json",
            headers=owner.headers,
        )
        assert forged_ver.status_code == 422
        assert forged_ver.json()["verified"] is False
