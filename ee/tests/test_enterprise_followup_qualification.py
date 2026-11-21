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
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relname LIKE 'ee_%'
              AND c.relname NOT LIKE 'ee_billing_%'
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
            chal_acme = default_saml_service.build_domain_challenge(
                tenant_slug="acme-corp",
                domain="acme.fr",
                organisation_id=owner.organisation_id,
            )
            default_saml_service.seed_dns_txt_record(
                str(chal_acme["dns_record_name"]),
                str(chal_acme["txt_value"]),
            )
            default_saml_service.verify_domain_challenge(
                tenant_slug="acme-corp",
                domain="acme.fr",
                organisation_id=owner.organisation_id,
            )
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


def test_p2_reverse_order_membership_mutation_vs_ee_fence_returns_typed_409_and_unblocks_writer(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Reproduce reverse-order schedule (`u -> m NOWAIT` vs `membership_lifecycle` `m -> u`).

    1. Owner A acquires `FOR SHARE OF u` (and `FOR SHARE OF o NOWAIT`) and pauses before
       `FOR SHARE OF m NOWAIT` inside a real HTTP `GET /api/v1/ee/compliance/audit-exports`.
    2. Owner B invokes Core's normal `change_membership` on A's membership, holding A's
       `orgs_membership` tuple lock while waiting for A's `identity_user` lock in
       `member_authority_user_touch` (verified directly via `pg_locks`).
    3. Resuming A hits `FOR SHARE OF m NOWAIT` (`55P03`), rolls back A's atomic block (releasing
       `FOR SHARE OF u` so B's `change_membership` immediately commits!), returns a typed HTTP
       `409` JSON refusal (`authority_fenced`), and permits a clean subsequent retry.
    """
    import time

    from apps.orgs.membership_lifecycle import change_membership, read_membership

    from core.api import lanes
    from core.db.api_database_boundary import assert_authority, assert_writer_grants
    from core.db.api_writer_role import grant_statements
    from services.identity.trusted_issuers import verify_configured_token

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    owner_a = tenant_principal_factory("reverse-fence-corp", role="org_owner")
    owner_b = tenant_principal_factory("reverse-fence-corp", role="org_owner")
    assert owner_a.organisation_id == owner_b.organisation_id

    writer_role = f"ee_reverse_writer_{uuid4().hex[:12]}"
    with connection.cursor() as cur:
        cur.execute(f'CREATE ROLE "{writer_role}" NOLOGIN NOINHERIT')
        for stmt in grant_statements(writer_role):
            cur.execute(stmt)
        assert_authority(cur, writer_role)
        assert_writer_grants(cur, writer_role)

    trusted = getattr(settings, "KODERA_AUTH_TRUST", ())
    verified_b, lane_b = lanes.admit(*verify_configured_token(owner_b.token, trusted=trusted))
    assert lane_b == "customer"

    intercepted = [False]
    b_blocked_observed = [False]
    b_outcomes: list[tuple[str, str]] = []
    b_errors: list[BaseException] = []
    spawned_workers: list[threading.Thread] = []

    try:
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        with _acting_as(writer_role):
            seed_resp = client.post(
                "/api/v1/ee/compliance/audit-exports/events",
                data=json.dumps(
                    {
                        "action": "sso.idp.registered",
                        "target_urn": "urn:kodera:idp:reverse-test",
                    }
                ),
                content_type="application/json",
                headers=owner_a.headers,
            )
            assert seed_resp.status_code == 201, seed_resp.content

            _detail_a, etag_a = read_membership(
                verified=verified_b,
                organisation_id=owner_a.organisation_id,
                membership_id=owner_a.membership_id,
            )

            def _run_owner_b_membership_change() -> None:
                connections.close_all()
                try:
                    with _acting_as(writer_role):
                        changed, next_etag = change_membership(
                            verified=verified_b,
                            organisation_id=owner_a.organisation_id,
                            membership_id=owner_a.membership_id,
                            patch={"role": "org_admin"},
                            if_match=etag_a,
                            request_id=str(uuid4()),
                        )
                        b_outcomes.append((changed.role, next_etag))
                except BaseException as exc:  # noqa: BLE001
                    b_errors.append(exc)
                finally:
                    connections.close_all()

            def _pause_before_membership_lock(
                execute: Any,
                sql_text: Any,
                params: Any,
                many: bool,
                context: dict[str, Any],
            ) -> Any:
                if (
                    not intercepted[0]
                    and isinstance(sql_text, str)
                    and "FROM public.orgs_membership m" in sql_text
                    and "FOR SHARE OF m NOWAIT" in sql_text
                ):
                    intercepted[0] = True
                    worker_b = threading.Thread(
                        target=_run_owner_b_membership_change,
                        daemon=True,
                    )
                    spawned_workers.append(worker_b)
                    worker_b.start()

                    with _open_secondary_pg_connection() as conn_probe:
                        conn_probe.autocommit = True
                        deadline = time.monotonic() + 3.0
                        while time.monotonic() < deadline:
                            with conn_probe.cursor() as probe_cur:
                                probe_cur.execute(
                                    """
                                    SELECT COUNT(*)
                                    FROM pg_locks wait_l
                                    WHERE NOT wait_l.granted
                                      AND EXISTS (
                                          SELECT 1
                                          FROM pg_locks held_m
                                          WHERE held_m.pid = wait_l.pid
                                            AND held_m.granted
                                            AND held_m.relation = 'public.orgs_membership'::regclass
                                            AND held_m.mode = 'RowExclusiveLock'
                                      )
                                      AND EXISTS (
                                          SELECT 1
                                          FROM pg_locks held_u
                                          WHERE held_u.pid = wait_l.pid
                                            AND held_u.granted
                                            AND held_u.relation = 'public.identity_user'::regclass
                                      )
                                    """
                                )
                                row = probe_cur.fetchone()
                                if row is not None and int(row[0]) >= 1:
                                    b_blocked_observed[0] = True
                                    break
                            time.sleep(0.015)

                return execute(sql_text, params, many, context)

            with connection.execute_wrapper(_pause_before_membership_lock):
                contended_resp = client.get(
                    "/api/v1/ee/compliance/audit-exports",
                    {"redact_pii": "false"},
                    headers=owner_a.headers,
                )

            assert intercepted[0] is True
            assert b_blocked_observed[0] is True, (
                "Owner B must hold orgs_membership tuple lock and block on identity_user before A resumes"
            )
            assert contended_resp.status_code == 409, contended_resp.content
            assert contended_resp["Content-Type"] == "application/json"
            assert contended_resp.json()["code"] == "authority_fenced"
            assert not connection.in_atomic_block
            assert not connection.needs_rollback

            assert len(spawned_workers) == 1
            spawned_workers[0].join(timeout=5.0)
            assert not spawned_workers[0].is_alive()
            assert b_errors == []
            assert len(b_outcomes) == 1
            assert b_outcomes[0][0] == "org_admin"

            # Clean subsequent retry on the same connection succeeds for redacted admin export
            # (`200`) and enforces the committed demotion on unredacted export (`403`).
            retry_redacted = client.get(
                "/api/v1/ee/compliance/audit-exports",
                headers=owner_a.headers,
            )
            assert retry_redacted.status_code == 200, retry_redacted.content
            assert "bundle_id" in retry_redacted.json()

            retry_unredacted = client.get(
                "/api/v1/ee/compliance/audit-exports",
                {"redact_pii": "false"},
                headers=owner_a.headers,
            )
            assert retry_unredacted.status_code == 403
            assert retry_unredacted.json()["code"] == "owner_required_for_unredacted_export"
    finally:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")
            cur.execute(f'DROP OWNED BY "{writer_role}"')
            cur.execute(f'DROP ROLE "{writer_role}"')


def test_p1_3_organisation_and_account_erasure_cutoff_purge_scrub_and_migration_roundtrip(
    monkeypatch: pytest.MonkeyPatch,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    django_db_blocker: Any,
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
        user_a_id=members[2].user_id,
        user_a_email=members[2].user.email,
        user_b_id=members[1].user_id,
        user_b_email=members[1].user.email,
    )
    _seed_ee_for_org(
        org_id=sibling_owner.organisation_id,
        slug="sibling-corp",
        user_a_id=sibling_second.user_id,
        user_a_email=sibling_second.email,
        user_b_id=sibling_owner.user_id,
        user_b_email=sibling_owner.email,
    )

    # --- PART A: Individual Account Erasure for `members[2]` (`org_member`) ---
    erased_person_id = members[2].user_id
    acct_row = begin_account_erasure(
        verified=replace(tokens[2], auth_time=int(database_now().timestamp())),
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

    # --- PART C: Migration `orgs 0031 <-> 0034` Round-Trip on isolated empty database ---
    from django.db.migrations.executor import MigrationExecutor
    from test_customer_persistence_migrations import empty_database

    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate([("orgs", "0034_ee_audit_ledger_erasure")])
        with target.cursor() as cur:
            for tbl in EE_TABLES:
                cur.execute("SELECT to_regclass(%s)", [f"public.{tbl}"])
                row_34 = cur.fetchone()
                assert row_34 is not None and row_34[0] == tbl
            cur.execute("SELECT to_regprocedure('public.ee_scim_sync_member_contact(uuid,uuid,text,text)')")
            proc_34 = cur.fetchone()
            assert proc_34 is not None and proc_34[0] is not None

        executor.loader.build_graph()
        executor.migrate([("orgs", "0033_proximity_erasure_inventory")])
        with target.cursor() as cur:
            cur.execute("SELECT to_regprocedure('public.ee_scim_sync_member_contact(uuid,uuid,text,text)')")
            proc_33 = cur.fetchone()
            assert proc_33 is not None and proc_33[0] is None

        executor.loader.build_graph()
        executor.migrate([("orgs", "0031_account_erasure_completion")])
        with target.cursor() as cur:
            cur.execute("SELECT to_regclass('public.ee_audit_ledger')")
            row_31 = cur.fetchone()
            assert row_31 is not None and row_31[0] is None

        executor.loader.build_graph()
        executor.migrate([("orgs", "0034_ee_audit_ledger_erasure")])
        with target.cursor() as cur:
            for tbl in EE_TABLES:
                cur.execute("SELECT to_regclass(%s)", [f"public.{tbl}"])
                row_re = cur.fetchone()
                assert row_re is not None and row_re[0] == tbl


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


def test_p1_4_scim_and_saml_never_mutate_global_user_enabled_across_sibling_tenants(
    monkeypatch: pytest.MonkeyPatch,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    oidc_signing_keys: tuple[rsa.RSAPrivateKey, rsa.RSAPrivateKey, dict[str, Any]],
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    """Verify under restricted `kodera_api` writer role (`SET ROLE`) that:
    1. Explicitly pre-linked `User` across Tenant A + Tenant B (`ADR-0024`): Tenant A SCIM `create`
       -> `PATCH active:false` -> `PATCH active:true` -> `DELETE` -> re-`POST active:false` ->
       `PUT active:true` never mutates global `User.enabled` and leaves Tenant B's
       `Identity.enabled`, `Membership.state`, and `resolve_member_authority` active throughout
       while transitioning Tenant A atomically.
    2. Globally disabled `User` (`User.enabled = False`) and tenant-disabled `Identity`: Tenant A
       SCIM `POST` (`active:true` and `active:false`), `PATCH` (`active:true`), and `PUT`
       (`active:true`) plus SAML ACS login on an existing Tenant A `Identity` all refuse (`403`)
       with atomic rollback and never flip `User.enabled` or `Identity.enabled` back to `True`.
    3. Tenant A `org_owner` protection: SCIM `POST active:false`, `PATCH active:false`,
       `PUT active:false`, and `DELETE` all refuse (`403`) with atomic rollback while keeping
       `User.enabled == True`, owner `Identity.enabled == True`, owner `Membership` active, and
       SCIM user state consistent.
    4. Cross-tenant unverified email isolation & `GET /api/v1/me` non-disclosure: neither SCIM
       `POST /Users` (across case-insensitive victim-only emails, differing `userName` vs primary
       `email`, identical A/B contact collisions, and multiple global `User` contact matches) nor
       SAML ACS fresh-tenant JIT ever links or reuses a global `User` across tenants by contact
       string; each creates a distinct `User` person root and `GET /api/v1/me` discloses zero
       Tenant B `organisation_id`, `Identity.id`, `Membership.id`, `realm`, or `issuer`.
    """
    import jwt
    from apps.identity.models import Identity, User
    from apps.orgs.authority_selectors import (
        MemberAuthorityNotFoundError,
        resolve_member_authority,
    )
    from apps.orgs.models import Membership, Organisation
    from django.utils import timezone

    from core.db.api_database_boundary import assert_authority, assert_writer_grants
    from core.db.api_writer_role import grant_statements
    from services.identity.access_tokens import VerifiedAccessToken

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    saml_priv_key, _, saml_cert_pem = rsa_idp_keypair
    oidc_trusted_priv, _, _ = oidc_signing_keys

    owner_a = tenant_principal_factory(
        "scim-tenant-a",
        role="org_owner",
        email="owner@scim-a.fr",
    )
    owner_b = tenant_principal_factory(
        "scim-tenant-b",
        role="org_owner",
        email="owner@scim-b.fr",
    )
    org_a = Organisation.objects.get(id=owner_a.organisation_id)
    org_b = Organisation.objects.get(id=owner_b.organisation_id)

    # Seed one explicitly pre-linked (`ADR-0024`) `User` across Tenant A and Tenant B, a
    # globally-disabled `User` (`enabled=False`) with an existing Tenant A `Identity`, and
    # cross-tenant / collision person-isolation fixtures for Scenario 4.
    with transaction.atomic():
        now_seed = timezone.now()
        shared_user = User.objects.create(
            email="shared.claire@corp.fr",
            display_name="Claire Shared",
            enabled=True,
        )
        ident_a = Identity.objects.create(
            user=shared_user,
            organisation=org_a,
            realm=org_a.realm,
            issuer=org_a.issuer,
            subject="shared.claire@corp.fr",
            email="shared.claire@corp.fr",
            enabled=True,
        )
        ident_b = Identity.objects.create(
            user=shared_user,
            organisation=org_b,
            realm=org_b.realm,
            issuer=org_b.issuer,
            subject="shared.claire@corp.fr",
            email="shared.claire@corp.fr",
            enabled=True,
        )
        memb_b = Membership.objects.create(
            organisation=org_b,
            user=shared_user,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )
        globally_disabled_user = User.objects.create(
            email="disabled.sec@corp.fr",
            display_name="Security Disabled Person",
            enabled=False,
        )
        Identity.objects.create(
            user=globally_disabled_user,
            organisation=org_a,
            realm=org_a.realm,
            issuer=org_a.issuer,
            subject="disabled.sec@corp.fr",
            email="disabled.sec@corp.fr",
            enabled=True,
        )

        # Scenario 4 fixtures: victim-only Tenant B people + independent A/B contact collisions +
        # multiple global contact matches (`CUSTOMER_PERSISTENCE.md:29` non-unique `User.email`).
        victim_b_user = User.objects.create(
            email="victim.only@corp.fr",
            display_name="Tenant B Victim",
            enabled=True,
        )
        victim_b_ident = Identity.objects.create(
            user=victim_b_user,
            organisation=org_b,
            realm=org_b.realm,
            issuer=org_b.issuer,
            subject="victim-b-sub",
            email="victim.only@corp.fr",
            enabled=True,
        )
        victim_b_memb = Membership.objects.create(
            organisation=org_b,
            user=victim_b_user,
            role=Membership.Role.ADMIN,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )
        extra_global_victim = User.objects.create(
            email="victim.only@corp.fr",
            display_name="Second Unaffiliated Contact Match",
            enabled=True,
        )

        victim2_b_user = User.objects.create(
            email="victim.samename@corp.fr",
            display_name="Tenant B Same-Name Victim",
            enabled=True,
        )
        victim2_b_ident = Identity.objects.create(
            user=victim2_b_user,
            organisation=org_b,
            realm=org_b.realm,
            issuer=org_b.issuer,
            subject="victim.samename@corp.fr",
            email="victim.samename@corp.fr",
            enabled=True,
        )
        victim2_b_memb = Membership.objects.create(
            organisation=org_b,
            user=victim2_b_user,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )

        indep_a_user = User.objects.create(
            email="collision@corp.fr",
            display_name="Independent Tenant A Person",
            enabled=True,
        )
        indep_a_ident = Identity.objects.create(
            user=indep_a_user,
            organisation=org_a,
            realm=org_a.realm,
            issuer=org_a.issuer,
            subject="indep-a-sub",
            email="collision@corp.fr",
            enabled=True,
        )
        indep_a_memb = Membership.objects.create(
            organisation=org_a,
            user=indep_a_user,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )
        indep_b_user = User.objects.create(
            email="collision@corp.fr",
            display_name="Independent Tenant B Person",
            enabled=True,
        )
        indep_b_ident = Identity.objects.create(
            user=indep_b_user,
            organisation=org_b,
            realm=org_b.realm,
            issuer=org_b.issuer,
            subject="indep-b-sub",
            email="collision@corp.fr",
            enabled=True,
        )
        indep_b_memb = Membership.objects.create(
            organisation=org_b,
            user=indep_b_user,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )
        extra_global_collision = User.objects.create(
            email="collision@corp.fr",
            display_name="Third Global Collision Match",
            enabled=True,
        )

        saml_victim_b_user = User.objects.create(
            email="saml.victim@corp.fr",
            display_name="SAML Tenant B Victim",
            enabled=True,
        )
        saml_victim_b_ident = Identity.objects.create(
            user=saml_victim_b_user,
            organisation=org_b,
            realm=org_b.realm,
            issuer=org_b.issuer,
            subject="saml-victim-b-sub",
            email="saml.victim@corp.fr",
            enabled=True,
        )
        saml_victim_b_memb = Membership.objects.create(
            organisation=org_b,
            user=saml_victim_b_user,
            role=Membership.Role.MEMBER,
            state=Membership.State.ACTIVE,
            accepted_at=now_seed,
        )

    def _mint_verified_and_bearer(
        issuer: str, subject: str, email: str
    ) -> tuple[VerifiedAccessToken, str]:
        now_epoch = int(datetime.now(UTC).timestamp())
        raw_jwt = jwt.encode(
            {
                "iss": issuer,
                "sub": subject,
                "aud": "kodera-server",
                "iat": now_epoch - 5,
                "exp": now_epoch + 900,
                "typ": "Bearer",
                "email": email,
                "email_verified": True,
                "azp": "console",
                "amr": ["pwd", "otp"],
            },
            oidc_trusted_priv,
            algorithm="RS256",
            headers={"kid": "ee-test-oidc-k1"},
        )
        verified = VerifiedAccessToken(
            issuer=issuer,
            subject=subject,
            audience=("kodera-server",),
            issued_at=now_epoch - 5,
            expires_at=now_epoch + 900,
            not_before=None,
            amr=("pwd", "otp"),
            acr=None,
            auth_time=now_epoch - 5,
            email_verified=True,
            authorized_party="console",
            email=email,
        )
        return verified, raw_jwt

    verified_b, _bearer_b = _mint_verified_and_bearer(
        org_b.issuer,
        "shared.claire@corp.fr",
        "shared.claire@corp.fr",
    )
    verified_a, bearer_a = _mint_verified_and_bearer(
        org_a.issuer,
        "shared.claire@corp.fr",
        "shared.claire@corp.fr",
    )

    role = f"ee_scim_iso_{uuid4().hex[:12]}"
    with connection.cursor() as cur:
        cur.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for stmt in grant_statements(role):
            cur.execute(stmt)
        assert_authority(cur, role)
        assert_writer_grants(cur, role)

    def _count_outbox_deliveries(target_org_id: UUID) -> int:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")
            try:
                cur.execute(
                    "SELECT count(*) FROM public.outbox_outboxdelivery WHERE organisation_id = %s",
                    [target_org_id],
                )
                row = cur.fetchone()
                return int(row[0]) if row is not None else 0
            finally:
                cur.execute(f'SET ROLE "{role}"')

    try:
        with _acting_as(role):
            raw_scim_a, _ = default_scim_service.tokens.issue_token(
                tenant_slug="scim-tenant-a",
                description="Tenant A SCIM Token",
                organisation_id=org_a.id,
            )
            scim_a_headers = {"Authorization": f"Bearer {raw_scim_a}"}

            # Register SAML IdP on Tenant A (verifies SAML ACS also respects global User.enabled=False)
            chal_corp = default_saml_service.build_domain_challenge(
                tenant_slug="scim-tenant-a",
                domain="corp.fr",
                organisation_id=org_a.id,
            )
            default_saml_service.seed_dns_txt_record(
                str(chal_corp["dns_record_name"]),
                str(chal_corp["txt_value"]),
            )
            default_saml_service.verify_domain_challenge(
                tenant_slug="scim-tenant-a",
                domain="corp.fr",
                organisation_id=org_a.id,
            )
            reg_saml = client.post(
                "/api/v1/ee/sso/saml/scim-tenant-a/providers",
                data=json.dumps(
                    {
                        "idp_id": "okta-a",
                        "idp_entity_id": "https://idp.scim-a.test/saml2",
                        "idp_sso_url": "https://idp.scim-a.test/sso",
                        "public_key_pem": saml_cert_pem,
                        "verified_domains": ["corp.fr"],
                        "default_role": "org_member",
                    }
                ),
                content_type="application/json",
                headers=owner_a.headers,
            )
            assert reg_saml.status_code == 201, reg_saml.content

            # --- Scenario 1: Shared User across Tenant A and Tenant B ---
            # 1a. Provision shared Claire into Tenant A via HTTP POST /Users (active=True)
            create_shared = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "shared.claire@corp.fr",
                        "displayName": "Claire Shared",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert create_shared.status_code == 201, create_shared.content
            scim_claire_id = str(create_shared.json()["id"])

            assert User.objects.filter(email__iexact="shared.claire@corp.fr").count() == 1
            shared_user.refresh_from_db()
            assert shared_user.enabled is True

            ident_a = Identity.objects.get(organisation=org_a, user=shared_user)
            memb_a = Membership.objects.get(organisation=org_a, user=shared_user)
            assert ident_a.enabled is True
            assert memb_a.state == Membership.State.ACTIVE
            assert resolve_member_authority(verified=verified_a).membership_id == memb_a.id
            assert resolve_member_authority(verified=verified_b).membership_id == memb_b.id

            rev_a_before = Organisation.objects.values_list("authority_revision", flat=True).get(
                id=org_a.id
            )

            # 1b. Deprovision Claire in Tenant A (`PATCH active: false`)
            patch_off = client.patch(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": False}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert patch_off.status_code == 200, patch_off.content
            assert patch_off.json()["active"] is False

            shared_user.refresh_from_db()
            ident_b.refresh_from_db()
            memb_b.refresh_from_db()
            memb_a.refresh_from_db()
            rev_a_after_off = Organisation.objects.values_list("authority_revision", flat=True).get(
                id=org_a.id
            )

            assert shared_user.enabled is True, (
                "Tenant A SCIM deprovision must NEVER disable global User!"
            )
            assert memb_a.state == Membership.State.SUSPENDED
            assert rev_a_after_off > rev_a_before
            with pytest.raises(MemberAuthorityNotFoundError):
                resolve_member_authority(verified=verified_a)

            # Sibling Tenant B authority, Identity, and Membership MUST remain 100% active!
            assert ident_b.enabled is True
            assert memb_b.state == Membership.State.ACTIVE
            facts_b = resolve_member_authority(verified=verified_b)
            assert facts_b.organisation_id == org_b.id
            assert facts_b.membership_id == memb_b.id

            # SAML ACS login on Tenant A while Tenant A membership is suspended must also refuse 403!
            login_susp = client.get(
                "/api/v1/ee/sso/saml/scim-tenant-a/login",
                {"idp_id": "okta-a"},
            ).json()
            xml_susp = _build_signed_saml_response(
                in_response_to=str(login_susp["request_id"]),
                tenant_slug="scim-tenant-a",
                idp_entity_id="https://idp.scim-a.test/saml2",
                email="shared.claire@corp.fr",
                sign_key=saml_priv_key,
                groups=(),
            )
            acs_susp = client.post(
                "/api/v1/ee/sso/saml/scim-tenant-a/acs",
                data={
                    "SAMLResponse": base64.b64encode(xml_susp.encode("utf-8")).decode("ascii"),
                    "RelayState": str(login_susp["relay_state"]),
                },
            )
            assert acs_susp.status_code == 403
            assert acs_susp.json()["code"] == "user_disabled"

            # 1c. Reactivate Claire in Tenant A (`PATCH active: true`)
            patch_on = client.patch(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": True}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert patch_on.status_code == 200, patch_on.content
            assert patch_on.json()["active"] is True
            memb_a.refresh_from_db()
            assert memb_a.state == Membership.State.ACTIVE
            assert resolve_member_authority(verified=verified_a).membership_id == memb_a.id
            assert resolve_member_authority(verified=verified_b).membership_id == memb_b.id

            # 1d. DELETE Claire from Tenant A SCIM (`DELETE /Users/{id}`)
            del_claire = client.delete(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                headers=scim_a_headers,
            )
            assert del_claire.status_code == 204
            shared_user.refresh_from_db()
            ident_b.refresh_from_db()
            memb_b.refresh_from_db()
            memb_a.refresh_from_db()
            assert shared_user.enabled is True
            assert memb_a.state == Membership.State.REMOVED
            with pytest.raises(MemberAuthorityNotFoundError):
                resolve_member_authority(verified=verified_a)
            assert ident_b.enabled is True
            assert memb_b.state == Membership.State.ACTIVE
            assert resolve_member_authority(verified=verified_b).membership_id == memb_b.id

            # 1e. Re-provision Claire in Tenant A as `active: false`, then `PUT active: true`
            recreate_claire = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "shared.claire@corp.fr",
                        "displayName": "Claire Shared",
                        "active": False,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert recreate_claire.status_code == 201, recreate_claire.content
            scim_claire_id = str(recreate_claire.json()["id"])
            shared_user.refresh_from_db()
            assert shared_user.enabled is True
            assert resolve_member_authority(verified=verified_b).membership_id == memb_b.id

            put_on = client.put(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "shared.claire@corp.fr",
                        "displayName": "Claire Reactivated",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert put_on.status_code == 200, put_on.content
            memb_a.refresh_from_db()
            assert memb_a.state == Membership.State.ACTIVE
            assert resolve_member_authority(verified=verified_a).membership_id == memb_a.id
            assert resolve_member_authority(verified=verified_b).membership_id == memb_b.id

            # Brand-new person created via SCIM with `active: false` still creates `User(enabled=True)`!
            brand_new_inactive = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "newhire.staged@corp.fr",
                        "displayName": "Staged Hire",
                        "active": False,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert brand_new_inactive.status_code == 201, brand_new_inactive.content
            staged_user = User.objects.get(email="newhire.staged@corp.fr")
            assert staged_user.enabled is True
            assert (
                Membership.objects.get(organisation=org_a, user=staged_user).state
                == Membership.State.SUSPENDED
            )

            # Deactivate Claire in Tenant A before testing global security disable refusal
            assert (
                client.patch(
                    f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                    data=json.dumps(
                        {
                            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                            "Operations": [{"op": "replace", "path": "active", "value": False}],
                        }
                    ),
                    content_type="application/scim+json",
                    headers=scim_a_headers,
                ).status_code
                == 200
            )

        # --- Scenario 2: Globally disabled User (`User.enabled = False`) & disabled Identity ---
        # Platform security disables `shared_user` globally and disables Tenant A's `ident_a`.
        User.objects.filter(id=shared_user.id).update(enabled=False)
        Identity.objects.filter(id=ident_a.id).update(enabled=False)

        with _acting_as(role):
            # 2a. SCIM POST /Users (`active: true` AND `active: false`) on existing globally-disabled User refuses 403!
            for active_flag in (True, False):
                prov_disabled = client.post(
                    "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                    data=json.dumps(
                        {
                            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                            "userName": "disabled.sec@corp.fr",
                            "displayName": "Security Disabled Person",
                            "active": active_flag,
                        }
                    ),
                    content_type="application/scim+json",
                    headers=scim_a_headers,
                )
                assert prov_disabled.status_code == 403, prov_disabled.content
                assert prov_disabled.json()["scimType"] == "mutability"

            globally_disabled_user.refresh_from_db()
            assert globally_disabled_user.enabled is False
            assert not Membership.objects.filter(
                organisation=org_a, user=globally_disabled_user
            ).exists()
            list_check = client.get(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                {"filter": 'userName eq "disabled.sec@corp.fr"'},
                headers=scim_a_headers,
            )
            assert list_check.status_code == 200
            assert list_check.json()["totalResults"] == 0

            # 2b. SCIM PATCH `active: true` and PUT `active: true` on globally-disabled Claire refuse 403
            # with 100% atomic rollback (zero revision, outbox, or deprovision-log drift)!
            rev_a_pre_dis = Organisation.objects.values_list("authority_revision", flat=True).get(
                id=org_a.id
            )
            rev_b_pre_dis = Organisation.objects.values_list("authority_revision", flat=True).get(
                id=org_b.id
            )
            outbox_a_pre_dis = _count_outbox_deliveries(org_a.id)

            patch_disabled = client.patch(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": True}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert patch_disabled.status_code == 403, patch_disabled.content
            assert patch_disabled.json()["scimType"] == "mutability"

            put_disabled = client.put(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "shared.claire@corp.fr",
                        "displayName": "Attempt Unfreeze",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert put_disabled.status_code == 403, put_disabled.content
            assert put_disabled.json()["scimType"] == "mutability"

            shared_user.refresh_from_db()
            ident_a.refresh_from_db()
            memb_a.refresh_from_db()
            assert shared_user.enabled is False
            assert ident_a.enabled is False
            assert memb_a.state == Membership.State.SUSPENDED
            assert (
                Organisation.objects.values_list("authority_revision", flat=True).get(id=org_a.id)
                == rev_a_pre_dis
            )
            assert (
                Organisation.objects.values_list("authority_revision", flat=True).get(id=org_b.id)
                == rev_b_pre_dis
            )
            assert _count_outbox_deliveries(org_a.id) == outbox_a_pre_dis
            claire_scim_state = client.get(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                headers=scim_a_headers,
            ).json()
            assert claire_scim_state["active"] is False
            assert claire_scim_state["displayName"] != "Attempt Unfreeze"

            # 2c. SAML ACS login for globally-disabled user refuses 403 without flipping User.enabled!
            login_dis = client.get(
                "/api/v1/ee/sso/saml/scim-tenant-a/login",
                {"idp_id": "okta-a"},
            ).json()
            xml_dis = _build_signed_saml_response(
                in_response_to=str(login_dis["request_id"]),
                tenant_slug="scim-tenant-a",
                idp_entity_id="https://idp.scim-a.test/saml2",
                email="disabled.sec@corp.fr",
                sign_key=saml_priv_key,
                groups=(),
            )
            acs_dis = client.post(
                "/api/v1/ee/sso/saml/scim-tenant-a/acs",
                data={
                    "SAMLResponse": base64.b64encode(xml_dis.encode("utf-8")).decode("ascii"),
                    "RelayState": str(login_dis["relay_state"]),
                },
            )
            assert acs_dis.status_code == 403, acs_dis.content
            assert acs_dis.json()["code"] == "user_disabled"
            globally_disabled_user.refresh_from_db()
            assert globally_disabled_user.enabled is False

        # Restore global `shared_user.enabled = True` while keeping `ident_a.enabled = False`:
        # SCIM reactivation must STILL refuse 403 while `ident_a.enabled == False`!
        User.objects.filter(id=shared_user.id).update(enabled=True)
        with _acting_as(role):
            patch_ident_dis = client.patch(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{scim_claire_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": True}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert patch_ident_dis.status_code == 403
            ident_a.refresh_from_db()
            assert ident_a.enabled is False

            # --- Scenario 3: Tenant A `org_owner` protection on SCIM deactivate & DELETE ---
            # 3a. Direct `POST /Users` with `active: false` for Tenant A's `org_owner` refuses 403!
            post_owner_off = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "owner@scim-a.fr",
                        "displayName": "Tenant A Owner",
                        "active": False,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert post_owner_off.status_code == 403, post_owner_off.content
            assert post_owner_off.json()["scimType"] == "mutability"

            # 3b. Provision SCIM entry for Tenant A's `org_owner` with `active: true`, then attempt
            # `PATCH active: false`, `PUT active: false`, and `DELETE` — all MUST refuse 403 atomically!
            post_owner_on = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "owner@scim-a.fr",
                        "displayName": "Tenant A Owner",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert post_owner_on.status_code == 201, post_owner_on.content
            owner_scim_id = str(post_owner_on.json()["id"])
            rev_owner_pre = Organisation.objects.values_list("authority_revision", flat=True).get(
                id=org_a.id
            )
            outbox_owner_pre = _count_outbox_deliveries(org_a.id)
            deprov_owner_pre = len(default_scim_service.deprovision_events("scim-tenant-a"))

            patch_owner_off = client.patch(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{owner_scim_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                        "Operations": [{"op": "replace", "path": "active", "value": False}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert patch_owner_off.status_code == 403, patch_owner_off.content
            assert patch_owner_off.json()["scimType"] == "mutability"

            put_owner_off = client.put(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{owner_scim_id}",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "owner@scim-a.fr",
                        "displayName": "Tenant A Owner Mutated",
                        "active": False,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert put_owner_off.status_code == 403, put_owner_off.content
            assert put_owner_off.json()["scimType"] == "mutability"

            del_owner = client.delete(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{owner_scim_id}",
                headers=scim_a_headers,
            )
            assert del_owner.status_code == 403, del_owner.content
            assert del_owner.json()["scimType"] == "mutability"

            owner_user = User.objects.get(id=owner_a.user_id)
            owner_ident = Identity.objects.get(id=owner_a.identity_id)
            owner_memb = Membership.objects.get(id=owner_a.membership_id)
            assert owner_user.enabled is True
            assert owner_ident.enabled is True
            assert owner_memb.state == Membership.State.ACTIVE
            assert owner_memb.role == Membership.Role.OWNER
            assert (
                Organisation.objects.values_list("authority_revision", flat=True).get(id=org_a.id)
                == rev_owner_pre
            )
            assert _count_outbox_deliveries(org_a.id) == outbox_owner_pre
            assert len(default_scim_service.deprovision_events("scim-tenant-a")) == deprov_owner_pre
            verified_owner_a, _ = _mint_verified_and_bearer(
                owner_a.issuer,
                owner_a.subject,
                owner_a.email,
            )
            assert (
                resolve_member_authority(verified=verified_owner_a).stored_role
                == Membership.Role.OWNER
            )
            owner_scim_get = client.get(
                f"/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users/{owner_scim_id}",
                headers=scim_a_headers,
            )
            assert owner_scim_get.status_code == 200
            assert owner_scim_get.json()["active"] is True
            assert owner_scim_get.json()["displayName"] == "Tenant A Owner"
            assert bearer_a  # sanity check minted JWT non-empty

            # --- Scenario 4: Cross-Tenant Unverified Email Isolation & `GET /api/v1/me` ---
            forbidden_b_markers = (
                str(org_b.id),
                org_b.slug,
                org_b.realm,
                org_b.issuer,
                str(victim_b_user.id),
                str(victim_b_ident.id),
                str(victim_b_memb.id),
                str(victim2_b_user.id),
                str(victim2_b_ident.id),
                str(victim2_b_memb.id),
                str(indep_b_user.id),
                str(indep_b_ident.id),
                str(indep_b_memb.id),
                str(saml_victim_b_user.id),
                str(saml_victim_b_ident.id),
                str(saml_victim_b_memb.id),
            )

            # 4a. Controlled Tenant A `userName` + case-insensitive Tenant B victim primary email
            # (with secondary email + multiple global `User` contact matches) creates a fresh User!
            scim_probe_1 = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "controlled-sub-a",
                        "displayName": "Controlled A Subject",
                        "active": True,
                        "emails": [
                            {"value": "decoy@corp.fr", "type": "other", "primary": False},
                            {"value": "VICTIM.ONLY@corp.fr", "type": "work", "primary": True},
                        ],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert scim_probe_1.status_code == 201, scim_probe_1.content
            ident_probe_1 = Identity.objects.get(
                organisation=org_a, email__iexact="VICTIM.ONLY@corp.fr"
            )
            assert str(UUID(ident_probe_1.subject)) == ident_probe_1.subject
            assert ident_probe_1.email == "VICTIM.ONLY@corp.fr"
            assert ident_probe_1.user_id not in {
                victim_b_user.id,
                extra_global_victim.id,
            }, "SCIM must never reuse a cross-tenant or global User by contact email!"

            _, bearer_probe_1 = _mint_verified_and_bearer(
                org_a.issuer,
                ident_probe_1.subject,
                "VICTIM.ONLY@corp.fr",
            )
            me_probe_1 = client.get(
                "/api/v1/me",
                headers={"Authorization": f"Bearer {bearer_probe_1}"},
            )
            assert me_probe_1.status_code == 200, me_probe_1.content
            me_raw_1 = me_probe_1.content.decode("utf-8")
            me_json_1 = json.loads(me_raw_1)
            assert me_json_1["id"] == str(ident_probe_1.user_id)
            assert [i["id"] for i in me_json_1["identities"]] == [str(ident_probe_1.id)]
            assert [o["organisation"]["id"] for o in me_json_1["organisations"]] == [str(org_a.id)]
            for marker in forbidden_b_markers:
                assert marker not in me_raw_1, f"Cross-tenant marker {marker!r} leaked in /me!"

            # 4b. Matching `userName == email` against a Tenant-B-only victim AND controlled
            # `userName` against identical A/B contact collision (`collision@corp.fr`) never link
            # cross-tenant or unaffiliated global `User` rows and disclose zero Tenant B data!
            scim_probe_2 = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "VICTIM.SAMENAME@corp.fr",
                        "displayName": "Same-Name Tenant A",
                        "active": True,
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert scim_probe_2.status_code == 201, scim_probe_2.content
            ident_probe_2 = Identity.objects.get(
                organisation=org_a, email__iexact="victim.samename@corp.fr"
            )
            assert str(UUID(ident_probe_2.subject)) == ident_probe_2.subject
            assert ident_probe_2.user_id != victim2_b_user.id

            _, bearer_probe_2 = _mint_verified_and_bearer(
                org_a.issuer,
                ident_probe_2.subject,
                "victim.samename@corp.fr",
            )
            me_probe_2 = client.get(
                "/api/v1/me",
                headers={"Authorization": f"Bearer {bearer_probe_2}"},
            )
            assert me_probe_2.status_code == 200, me_probe_2.content
            me_raw_2 = me_probe_2.content.decode("utf-8")
            me_json_2 = json.loads(me_raw_2)
            assert me_json_2["id"] == str(ident_probe_2.user_id)
            assert [o["organisation"]["id"] for o in me_json_2["organisations"]] == [str(org_a.id)]
            for marker in forbidden_b_markers:
                assert marker not in me_raw_2

            scim_probe_3 = client.post(
                "/api/v1/ee/scim/v2/tenants/scim-tenant-a/Users",
                data=json.dumps(
                    {
                        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
                        "userName": "controlled-collision-sub",
                        "displayName": "Collision Subject",
                        "active": True,
                        "emails": [{"value": "COLLISION@corp.fr", "primary": True}],
                    }
                ),
                content_type="application/scim+json",
                headers=scim_a_headers,
            )
            assert scim_probe_3.status_code == 201, scim_probe_3.content
            ident_probe_3 = Identity.objects.get(
                organisation=org_a, email__iexact="collision@corp.fr"
            )
            assert ident_probe_3.id == indep_a_ident.id
            assert ident_probe_3.user_id not in {
                indep_b_user.id,
                extra_global_collision.id,
            }
            _, bearer_probe_3 = _mint_verified_and_bearer(
                org_a.issuer,
                ident_probe_3.subject,
                "COLLISION@corp.fr",
            )
            me_probe_3 = client.get(
                "/api/v1/me",
                headers={"Authorization": f"Bearer {bearer_probe_3}"},
            )
            assert me_probe_3.status_code == 200, me_probe_3.content
            me_raw_3 = me_probe_3.content.decode("utf-8")
            me_json_3 = json.loads(me_raw_3)
            assert me_json_3["id"] == str(ident_probe_3.user_id)
            assert indep_a_memb.state == Membership.State.ACTIVE
            for marker in forbidden_b_markers:
                assert marker not in me_raw_3

            # Verify pre-existing independent A person's `/api/v1/me` also never discloses B!
            _, bearer_indep_a = _mint_verified_and_bearer(
                org_a.issuer,
                "indep-a-sub",
                "collision@corp.fr",
            )
            me_indep_a = client.get(
                "/api/v1/me",
                headers={"Authorization": f"Bearer {bearer_indep_a}"},
            )
            assert me_indep_a.status_code == 200, me_indep_a.content
            me_indep_a_raw = me_indep_a.content.decode("utf-8")
            assert json.loads(me_indep_a_raw)["id"] == str(indep_a_user.id)
            for marker in forbidden_b_markers:
                assert marker not in me_indep_a_raw

            # 4c. SAML ACS fresh-tenant JIT assertion on Tenant A when Tenant B already has
            # `saml.victim@corp.fr` creates a distinct `User` and discloses zero Tenant B data!
            login_saml_iso = client.get(
                "/api/v1/ee/sso/saml/scim-tenant-a/login",
                {"idp_id": "okta-a"},
            ).json()
            xml_saml_iso = _build_signed_saml_response(
                in_response_to=str(login_saml_iso["request_id"]),
                tenant_slug="scim-tenant-a",
                idp_entity_id="https://idp.scim-a.test/saml2",
                email="SAML.VICTIM@corp.fr",
                sign_key=saml_priv_key,
                groups=(),
            )
            acs_saml_iso = client.post(
                "/api/v1/ee/sso/saml/scim-tenant-a/acs",
                data={
                    "SAMLResponse": base64.b64encode(xml_saml_iso.encode("utf-8")).decode("ascii"),
                    "RelayState": str(login_saml_iso["relay_state"]),
                },
            )
            assert acs_saml_iso.status_code == 200, acs_saml_iso.content
            saml_ident_a = Identity.objects.get(
                organisation=org_a,
                email__iexact="saml.victim@corp.fr",
            )
            assert saml_ident_a.user_id != saml_victim_b_user.id, (
                "SAML JIT must never reuse a cross-tenant User by asserted email!"
            )

            _, bearer_saml_a = _mint_verified_and_bearer(
                org_a.issuer,
                saml_ident_a.subject,
                saml_ident_a.email,
            )
            me_saml_a = client.get(
                "/api/v1/me",
                headers={"Authorization": f"Bearer {bearer_saml_a}"},
            )
            assert me_saml_a.status_code == 200, me_saml_a.content
            me_saml_raw = me_saml_a.content.decode("utf-8")
            me_saml_json = json.loads(me_saml_raw)
            assert me_saml_json["id"] == str(saml_ident_a.user_id)
            assert [i["id"] for i in me_saml_json["identities"]] == [str(saml_ident_a.id)]
            assert [o["organisation"]["id"] for o in me_saml_json["organisations"]] == [
                str(org_a.id)
            ]
            for marker in forbidden_b_markers:
                assert marker not in me_saml_raw, f"Cross-tenant marker {marker!r} leaked in /me!"
    finally:
        with connection.cursor() as cur:
            cur.execute("RESET ROLE")
            cur.execute(f'DROP OWNED BY "{role}"')
            cur.execute(f'DROP ROLE "{role}"')
