"""Deep Audit Wave 2 security & multi-worker PostgreSQL tests (`W2-1`, `W2-2`, `W2-3`).

Covers:
- `W2-1`: Kodera customer Bearer token authentication + active `Organisation` & `Membership`
  (`org_owner` / `org_admin`) across all Enterprise compliance audit and SAML admin endpoints,
  cross-tenant `403` isolation, anti-forgery actor binding, and `redact_pii=True` default (`org_owner`
  required for `redact_pii=False`).
- `W2-2`: Strict pinned-key bundle verification (`POST .../verify`, `verify_compliance_bundle`,
  `verify_export_bundle`, `structural_self_check_only`, and CLI) — attacker self-signed bundles
  embedding `public_key_pem` or supplying `public_key_pem`/`hmac_key_hex` in request JSON are
  refused (`422`, `verified=False`).
- `W2-3`: Multi-worker PostgreSQL persistence across independent service instances (`ScimService`,
  `SamlService`, `ComplianceAuditLedger`) + deterministic HKDF-SHA256 per-tenant signing keys and
  SAML `RelayState` HMAC secrets.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.test import Client, override_settings

from ee.audit_export.crypto import Ed25519AuditSigner, HmacAuditSigner
from ee.audit_export.exporter import export_compliance_bundle
from ee.audit_export.ledger import ComplianceAuditLedger, default_audit_ledger
from ee.audit_export.verify import (
    main as verify_cli_main,
    structural_self_check_only,
    verify_compliance_bundle,
    verify_export_bundle,
)
from ee.saml.service import SamlError, SamlIdpConfig, SamlService
from ee.scim.auth import ScimAuthError
from ee.scim.schemas import SCIM_PATCH_OP_SCHEMA
from ee.scim.service import ScimService
from ee.store import can_use_postgres
from ee.tests.conftest import ProvisionedTestPrincipal
from ee.tests.test_saml_security import _build_saml_response_xml

pytestmark = pytest.mark.django_db


@pytest.fixture
def enterprise_client(monkeypatch: pytest.MonkeyPatch) -> Client:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    return Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")


# ==============================================================================
# W2-1: Tenant Bearer Auth, Role Enforcement, Anti-Forgery & PII Default
# ==============================================================================


def test_w2_1_anonymous_and_invalid_tokens_rejected_across_admin_endpoints(
    enterprise_client: Client,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    stranger = tenant_principal_factory(
        "audit-victim",
        role="org_owner",
        sign_with_stranger=True,
    )
    auth_cases: list[dict[str, str] | None] = [
        None,
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer malformed.jwt.token"},
        stranger.headers,
    ]

    with override_settings(KODERA_EDITION="enterprise"):
        for hdrs in auth_cases:
            r_append = enterprise_client.post(
                "/api/v1/ee/compliance/audit-exports/events",
                data=json.dumps({"action": "forged.write", "target_urn": "urn:kodera:org:victim"}),
                content_type="application/json",
                headers=hdrs,
            )
            assert r_append.status_code == 401
            assert r_append["WWW-Authenticate"] == "Bearer"
            assert json.loads(r_append.content)["code"] == "unauthenticated"

            r_get_export = enterprise_client.get(
                "/api/v1/ee/compliance/audit-exports?tenant_slug=audit-victim",
                headers=hdrs,
            )
            assert r_get_export.status_code == 401
            assert r_get_export["WWW-Authenticate"] == "Bearer"

            r_post_export = enterprise_client.post(
                "/api/v1/ee/compliance/audit-exports",
                data=json.dumps({"tenant_slug": "audit-victim"}),
                content_type="application/json",
                headers=hdrs,
            )
            assert r_post_export.status_code == 401

            r_stream = enterprise_client.get(
                "/api/v1/ee/compliance/audit-exports/stream?tenant_slug=audit-victim",
                headers=hdrs,
            )
            assert r_stream.status_code == 401

            r_verify = enterprise_client.post(
                "/api/v1/ee/compliance/audit-exports/verify",
                data=json.dumps({"payload": "", "manifest": {"tenant_slug": "audit-victim"}}),
                content_type="application/json",
                headers=hdrs,
            )
            assert r_verify.status_code == 401

            r_saml_list = enterprise_client.get(
                "/api/v1/ee/sso/saml/audit-victim/providers",
                headers=hdrs,
            )
            assert r_saml_list.status_code == 401
            assert r_saml_list["WWW-Authenticate"] == "Bearer"

            r_saml_post = enterprise_client.post(
                "/api/v1/ee/sso/saml/audit-victim/providers",
                data=json.dumps({"idp_id": "rogue"}),
                content_type="application/json",
                headers=hdrs,
            )
            assert r_saml_post.status_code == 401


def test_w2_1_lane_identity_membership_and_role_checks_enforced(
    enterprise_client: Client,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    _, _, cert_pem = rsa_idp_keypair
    staff_principal = tenant_principal_factory("audit-victim", lane="staff")
    unknown_principal = tenant_principal_factory("audit-victim", provision_identity=False)
    suspended_owner = tenant_principal_factory(
        "audit-victim",
        role="org_owner",
        membership_state="suspended",
    )
    regular_member = tenant_principal_factory("audit-victim", role="org_member")
    billing_member = tenant_principal_factory("audit-victim", role="org_billing")
    valid_admin = tenant_principal_factory("audit-victim", role="org_admin")

    with override_settings(KODERA_EDITION="enterprise"):
        # Staff lane token must be refused on customer tenant endpoints (403 forbidden_lane)
        r_staff = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports",
            headers=staff_principal.headers,
        )
        assert r_staff.status_code == 403
        assert json.loads(r_staff.content)["code"] == "forbidden_lane"

        # Unprovisioned identity -> 403 identity_unknown
        r_unknown = enterprise_client.get(
            "/api/v1/ee/sso/saml/audit-victim/providers",
            headers=unknown_principal.headers,
        )
        assert r_unknown.status_code == 403
        assert json.loads(r_unknown.content)["code"] == "identity_unknown"

        # Suspended membership -> 403 tenant_membership_required
        r_susp = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports",
            headers=suspended_owner.headers,
        )
        assert r_susp.status_code == 403
        assert json.loads(r_susp.content)["code"] == "tenant_membership_required"

        # Non-admin roles (org_member, org_billing) -> 403 insufficient_role
        for low_priv in (regular_member, billing_member):
            for path in (
                "/api/v1/ee/compliance/audit-exports",
                "/api/v1/ee/sso/saml/audit-victim/providers",
            ):
                resp = enterprise_client.get(path, headers=low_priv.headers)
                assert resp.status_code == 403
                assert json.loads(resp.content)["code"] == "insufficient_role"

            resp_post = enterprise_client.post(
                "/api/v1/ee/compliance/audit-exports/events",
                data=json.dumps({"action": "attempt.write", "target_urn": "urn:kodera:org:1"}),
                content_type="application/json",
                headers=low_priv.headers,
            )
            assert resp_post.status_code == 403
            assert json.loads(resp_post.content)["code"] == "insufficient_role"

        # Active org_admin succeeds in registering and listing SAML IdPs for their own tenant
        reg_resp = enterprise_client.post(
            "/api/v1/ee/sso/saml/audit-victim/providers",
            data=json.dumps(
                {
                    "idp_id": "entra-corp",
                    "idp_entity_id": "https://login.microsoftonline.com/audit-victim/v2.0",
                    "idp_sso_url": "https://login.microsoftonline.com/audit-victim/saml2",
                    "public_key_pem": cert_pem,
                    "verified_domains": ["audit-victim.fr"],
                }
            ),
            content_type="application/json",
            headers=valid_admin.headers,
        )
        assert reg_resp.status_code == 201

        list_resp = enterprise_client.get(
            "/api/v1/ee/sso/saml/audit-victim/providers",
            headers=valid_admin.headers,
        )
        assert list_resp.status_code == 200
        assert len(json.loads(list_resp.content)["providers"]) == 1


def test_w2_1_cross_tenant_isolation_actor_spoofing_and_pii_redaction_default(
    enterprise_client: Client,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    victim_owner = tenant_principal_factory(
        "audit-victim",
        role="org_owner",
        email="ceo@audit-victim.fr",
    )
    victim_admin = tenant_principal_factory(
        "audit-victim",
        role="org_admin",
        email="secops@audit-victim.fr",
    )
    attacker_owner = tenant_principal_factory(
        "tenant-alpha",
        role="org_owner",
        email="owner@tenant-alpha.fr",
    )

    with override_settings(KODERA_EDITION="enterprise"):
        # Valid append by victim_admin binds actor_id & tenant_slug strictly to authenticated principal
        ok_append = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "action": "policy.updated",
                    "target_urn": "urn:kodera:policy:retention",
                    "metadata": {"ticket": "SEC-42", "contact_email": "dpo@audit-victim.fr"},
                }
            ),
            content_type="application/json",
            REMOTE_ADDR="198.51.100.77",
            headers=victim_admin.headers,
        )
        assert ok_append.status_code == 201
        appended = json.loads(ok_append.content)
        assert appended["tenant_slug"] == "audit-victim"
        assert appended["actor_id"] == str(victim_admin.user_id)
        assert appended["actor_type"] == "customer_user"

        # Authenticated admin cannot spoof actor_id or actor_type!
        spoof_id = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "actor_id": str(victim_owner.user_id),
                    "action": "audit.forge",
                    "target_urn": "urn:kodera:org:victim",
                }
            ),
            content_type="application/json",
            headers=victim_admin.headers,
        )
        assert spoof_id.status_code == 403
        assert json.loads(spoof_id.content)["code"] == "actor_spoofing_forbidden"

        spoof_type = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "actor_type": "system",
                    "action": "audit.forge",
                    "target_urn": "urn:kodera:org:victim",
                }
            ),
            content_type="application/json",
            headers=victim_admin.headers,
        )
        assert spoof_type.status_code == 403
        assert json.loads(spoof_type.content)["code"] == "actor_spoofing_forbidden"

        # Cross-tenant owner of `tenant-alpha` cannot append, read, export, verify, or inspect SAML IdPs of `audit-victim`
        ct_append = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps(
                {
                    "tenant_slug": "audit-victim",
                    "action": "cross.write",
                    "target_urn": "urn:kodera:org:victim",
                }
            ),
            content_type="application/json",
            headers=attacker_owner.headers,
        )
        assert ct_append.status_code == 403
        assert json.loads(ct_append.content)["code"] == "cross_tenant_forbidden"

        ct_get = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports?tenant_slug=audit-victim",
            headers=attacker_owner.headers,
        )
        assert ct_get.status_code == 403
        assert json.loads(ct_get.content)["code"] == "cross_tenant_forbidden"

        ct_post = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports",
            data=json.dumps({"tenant_slug": "audit-victim"}),
            content_type="application/json",
            headers=attacker_owner.headers,
        )
        assert ct_post.status_code == 403
        assert json.loads(ct_post.content)["code"] == "cross_tenant_forbidden"

        ct_saml = enterprise_client.get(
            "/api/v1/ee/sso/saml/audit-victim/providers",
            headers=attacker_owner.headers,
        )
        assert ct_saml.status_code == 403
        assert json.loads(ct_saml.content)["code"] == "cross_tenant_forbidden"

        # Default GET export has `redact_pii=True`
        default_exp = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports?tenant_slug=audit-victim",
            headers=victim_admin.headers,
        )
        assert default_exp.status_code == 200
        exp_body = json.loads(default_exp.content)
        assert exp_body["manifest"]["pii_redacted"] is True
        assert "secops@audit-victim.fr" not in exp_body["payload"]
        assert "dpo@audit-victim.fr" not in exp_body["payload"]
        assert "198.51.100.77" not in exp_body["payload"]
        assert "198.51.100.0/24" in exp_body["payload"]

        # `org_admin` requesting `redact_pii=false` is refused (403 owner_required_for_unredacted_export)
        admin_unredacted = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports?redact_pii=false",
            headers=victim_admin.headers,
        )
        assert admin_unredacted.status_code == 403
        assert json.loads(admin_unredacted.content)["code"] == (
            "owner_required_for_unredacted_export"
        )

        # `org_owner` requesting `redact_pii=false` is permitted
        owner_unredacted = enterprise_client.get(
            "/api/v1/ee/compliance/audit-exports?redact_pii=false",
            headers=victim_owner.headers,
        )
        assert owner_unredacted.status_code == 200
        unredacted_body = json.loads(owner_unredacted.content)
        assert unredacted_body["manifest"]["pii_redacted"] is False
        assert "secops@audit-victim.fr" in unredacted_body["payload"]
        assert "dpo@audit-victim.fr" in unredacted_body["payload"]

        # Cross-tenant verify attempt with victim bundle submitted by `tenant-alpha` -> 403
        ct_verify = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": exp_body["payload"],
                    "manifest": exp_body["manifest"],
                }
            ),
            content_type="application/json",
            headers=attacker_owner.headers,
        )
        assert ct_verify.status_code == 403
        assert json.loads(ct_verify.content)["code"] == "cross_tenant_forbidden"


# ==============================================================================
# W2-2: Attacker-Supplied Signing Key Rejection & Pinned Verification
# ==============================================================================


def test_w2_2_attacker_self_signed_bundle_rejected_by_http_api_library_and_cli(
    enterprise_client: Client,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    victim_owner = tenant_principal_factory("audit-victim", role="org_owner")

    with override_settings(KODERA_EDITION="enterprise"):
        # Build a structurally valid forged ledger + bundle signed by an attacker's Ed25519 key
        forged_ledger = ComplianceAuditLedger()
        # Populate one forged event directly in a detached ledger tenant namespace or export directly
        default_audit_ledger.append_event(
            tenant_slug="audit-victim",
            actor_type="customer_user",
            actor_id=str(victim_owner.user_id),
            actor_label=victim_owner.email,
            action="forged.backdoor.grant",
            target_urn="urn:kodera:user:attacker",
        )
        rogue_ed_signer = Ed25519AuditSigner(Ed25519PrivateKey.generate())
        forged_ed_bundle = export_compliance_bundle(
            ledger=forged_ledger,
            tenant_slug="audit-victim",
            signer=rogue_ed_signer,
            export_format="ndjson",
            framework="SOC2",
        )
        # Sanity check: forged manifest embeds attacker's own public_key_pem
        assert forged_ed_bundle.manifest["public_key_pem"] == rogue_ed_signer.public_key_pem

        # 1. HTTP `/verify` WITHOUT caller public_key_pem MUST reject (422, verified=False)
        resp_no_key = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": forged_ed_bundle.payload_text,
                    "manifest": forged_ed_bundle.manifest,
                }
            ),
            content_type="application/json",
            headers=victim_owner.headers,
        )
        assert resp_no_key.status_code == 422
        body_no_key = json.loads(resp_no_key.content)
        assert body_no_key["verified"] is False
        assert "invalid_manifest_signature" in body_no_key["errors"]

        # 2. HTTP `/verify` WITH caller-supplied `"public_key_pem": rogue_ed_signer.public_key_pem`
        #    MUST ALSO reject (server ignores caller trust key and pins to tenant registry!)
        resp_injected_key = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": forged_ed_bundle.payload_text,
                    "manifest": forged_ed_bundle.manifest,
                    "public_key_pem": rogue_ed_signer.public_key_pem,
                }
            ),
            content_type="application/json",
            headers=victim_owner.headers,
        )
        assert resp_injected_key.status_code == 422
        body_injected = json.loads(resp_injected_key.content)
        assert body_injected["verified"] is False
        assert "invalid_manifest_signature" in body_injected["errors"]

        # 3. Same attack using HMAC-SHA256 + caller-supplied `"hmac_key_hex"` -> MUST reject (422)
        rogue_hmac_signer = HmacAuditSigner(b"R" * 32)
        forged_hmac_bundle = export_compliance_bundle(
            ledger=forged_ledger,
            tenant_slug="audit-victim",
            signer=rogue_hmac_signer,
            export_format="ndjson",
            framework="SOC2",
        )
        resp_hmac_attack = enterprise_client.post(
            "/api/v1/ee/compliance/audit-exports/verify",
            data=json.dumps(
                {
                    "payload": forged_hmac_bundle.payload_text,
                    "manifest": forged_hmac_bundle.manifest,
                    "hmac_key_hex": rogue_hmac_signer.secret_key.hex(),
                }
            ),
            content_type="application/json",
            headers=victim_owner.headers,
        )
        assert resp_hmac_attack.status_code == 422
        body_hmac = json.loads(resp_hmac_attack.content)
        assert body_hmac["verified"] is False
        assert "invalid_manifest_signature" in body_hmac["errors"]

        # 4. Direct Python `verify_compliance_bundle` / `verify_export_bundle` without trusted key
        #    NEVER falls back to manifest["public_key_pem"]!
        unpinned_res = verify_compliance_bundle(
            forged_ed_bundle.payload_text,
            forged_ed_bundle.manifest,
        )
        assert unpinned_res.verified is False
        assert "missing_trusted_public_key" in unpinned_res.errors

        alias_res = verify_export_bundle(
            forged_ed_bundle.payload_text,
            forged_ed_bundle.manifest,
        )
        assert alias_res.verified is False
        assert "missing_trusted_public_key" in alias_res.errors

        # 5. Unpinned structural helper explicitly returns `verified=False` and `trusted=False`
        self_check = structural_self_check_only(
            forged_ed_bundle.payload_text,
            forged_ed_bundle.manifest,
        )
        assert self_check["verified"] is False
        assert self_check["trusted"] is False
        assert self_check["structurally_consistent"] is True

        # 6. CLI `python3 -m ee.audit_export.verify` WITHOUT `--public-key` exits 1 (`verified=False`)
        combined_path = tmp_path / "forged_combined.json"
        combined_path.write_text(
            json.dumps(
                {
                    "payload": forged_ed_bundle.payload_text,
                    "manifest": forged_ed_bundle.manifest,
                }
            ),
            encoding="utf-8",
        )
        capsys.readouterr()
        exit_code = verify_cli_main(["--bundle", str(combined_path)])
        captured = capsys.readouterr()
        assert exit_code == 1
        cli_out = json.loads(captured.out)
        assert cli_out["verified"] is False
        assert "missing_trusted_public_key" in cli_out["errors"]


# ==============================================================================
# W2-3: Multi-Worker PostgreSQL State Sharing & Deterministic HKDF Keys
# ==============================================================================


def test_w2_3_scim_multi_worker_postgresql_persistence_and_revocation() -> None:
    assert can_use_postgres() is True, "Wave 2 multi-worker suite requires active PostgreSQL"

    with override_settings(KODERA_EDITION="enterprise"):
        worker_a = ScimService()
        worker_b = ScimService()

        # Worker A issues SCIM token; Worker B immediately authenticates it via PostgreSQL
        raw_token, token_rec = worker_a.tokens.issue_token(
            tenant_slug="acme-corp",
            description="Gunicorn multi-worker token",
        )
        verified_on_b = worker_b.tokens.authenticate(
            f"Bearer {raw_token}",
            required_scope="scim:write",
            expected_tenant_slug="acme-corp",
        )
        assert verified_on_b.token_id == token_rec.token_id

        # Worker B provisions user, group, and active session
        base_url = "https://kodera.test/api/v1/ee/scim/v2"
        created_user = worker_b.create_user(
            tenant_slug="acme-corp",
            payload={
                "userName": "claire@acme-corp.fr",
                "displayName": "Claire Dupont",
                "active": True,
            },
            base_url=base_url,
        )
        user_id = str(created_user["id"])
        worker_b.create_group(
            tenant_slug="acme-corp",
            payload={
                "displayName": "Platform-Security",
                "members": [{"value": user_id}],
            },
            base_url=base_url,
        )
        worker_b.register_session("acme-corp", user_id, "sess-worker-b-1")

        # Worker A immediately observes user, group membership, and active session from PostgreSQL
        listed_on_a = worker_a.list_users(tenant_slug="acme-corp", base_url=base_url)
        assert listed_on_a["totalResults"] == 1
        resources = listed_on_a["Resources"]
        assert isinstance(resources, list)
        first_user = resources[0]
        assert isinstance(first_user, dict)
        assert first_user["userName"] == "claire@acme-corp.fr"
        user_groups = first_user["groups"]
        assert isinstance(user_groups, list) and len(user_groups) == 1
        assert worker_a.active_sessions("acme-corp", user_id) == frozenset({"sess-worker-b-1"})

        # Worker A deprovisions user (`active: False`); Worker B sees sessions revoked & deprovision log
        worker_a.patch_user(
            tenant_slug="acme-corp",
            user_id=user_id,
            payload={
                "schemas": [SCIM_PATCH_OP_SCHEMA],
                "Operations": [{"op": "Replace", "path": "active", "value": False}],
            },
            base_url=base_url,
        )
        assert worker_b.active_sessions("acme-corp", user_id) == frozenset()
        deprov_on_b = worker_b.deprovision_events("acme-corp")
        assert len(deprov_on_b) == 1
        assert deprov_on_b[0].revoked_sessions == ("sess-worker-b-1",)

        # Worker A revokes SCIM token; Worker B immediately rejects it with 401 token_revoked
        assert worker_a.tokens.revoke_token(token_rec.token_id) is True
        with pytest.raises(ScimAuthError) as exc_info:
            worker_b.tokens.authenticate(
                f"Bearer {raw_token}",
                required_scope="scim:read",
                expected_tenant_slug="acme-corp",
            )
        assert exc_info.value.status == 401
        assert exc_info.value.code == "token_revoked"


def test_w2_3_saml_multi_worker_postgresql_relay_state_and_replay_protection(
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    assert can_use_postgres() is True
    idp_signing_key, _, cert_pem = rsa_idp_keypair
    sp_base = "http://127.0.0.1"

    with override_settings(KODERA_EDITION="enterprise"):
        saml_worker_a = SamlService()
        saml_worker_b = SamlService()

        # Register IdP and initiate AuthnRequest + RelayState on Worker A
        saml_worker_a.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta-ha",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso/saml",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
                group_role_mapping={"kodera-admins": "org_admin"},
            )
        )
        authn_a = saml_worker_a.create_authn_request(
            tenant_slug="acme-corp",
            idp_id="okta-ha",
            sp_base_url=sp_base,
            return_path="/workspace",
        )

        fixed_assertion_id = "_assn_multiworker_fixed_01"
        signed_xml_1 = _build_saml_response_xml(
            assertion_id=fixed_assertion_id,
            in_response_to=authn_a.request_id,
            sign_key=idp_signing_key,
        )
        b64_1 = base64.b64encode(signed_xml_1.encode("utf-8")).decode("ascii")

        # Worker B consumes ACS callback using Worker A's RelayState & HKDF HMAC key!
        principal_b = saml_worker_b.consume_saml_response(
            tenant_slug="acme-corp",
            saml_response_b64=b64_1,
            relay_state=authn_a.relay_state,
            sp_base_url=sp_base,
        )
        assert principal_b.email == "alice@acme.fr"
        assert principal_b.role == "org_admin"

        # Worker A observes JIT-provisioned principal written by Worker B
        from_a = saml_worker_a.get_provisioned_principal("acme-corp", "alice@acme.fr")
        assert from_a is not None
        assert from_a.user_id == principal_b.user_id

        # Replaying the consumed RelayState on Worker A fails immediately (`invalid_relay_state`)
        with pytest.raises(SamlError) as relay_err:
            saml_worker_a.consume_saml_response(
                tenant_slug="acme-corp",
                saml_response_b64=b64_1,
                relay_state=authn_a.relay_state,
                sp_base_url=sp_base,
            )
        assert relay_err.value.code == "invalid_relay_state"

        # Replaying the same `assertion_id` on Worker A with a fresh AuthnRequest fails (`replayed_assertion_id`)
        authn_a2 = saml_worker_a.create_authn_request(
            tenant_slug="acme-corp",
            idp_id="okta-ha",
            sp_base_url=sp_base,
            return_path="/workspace",
        )
        signed_xml_replay = _build_saml_response_xml(
            assertion_id=fixed_assertion_id,
            in_response_to=authn_a2.request_id,
            sign_key=idp_signing_key,
        )
        b64_replay = base64.b64encode(signed_xml_replay.encode("utf-8")).decode("ascii")
        with pytest.raises(SamlError) as replay_err:
            saml_worker_a.consume_saml_response(
                tenant_slug="acme-corp",
                saml_response_b64=b64_replay,
                relay_state=authn_a2.relay_state,
                sp_base_url=sp_base,
            )
        assert replay_err.value.code == "replayed_assertion_id"


def test_w2_3_audit_ledger_multi_worker_hash_chain_and_hkdf_signing_keys() -> None:
    assert can_use_postgres() is True

    with override_settings(
        KODERA_EDITION="enterprise",
        KODERA_EE_AUDIT_SIGNING_SEED="deterministic-wave2-signing-master-seed-32b",
    ):
        ledger_a = ComplianceAuditLedger()
        ledger_b = ComplianceAuditLedger()

        # Deterministic HKDF keys match across workers for the same tenant and differ across tenants
        pub_a = ledger_a.ed25519_signer_for_tenant("audit-victim").public_key_pem
        pub_b = ledger_b.ed25519_signer_for_tenant("audit-victim").public_key_pem
        pub_other = ledger_a.ed25519_signer_for_tenant("tenant-alpha").public_key_pem
        assert pub_a == pub_b
        assert pub_a != pub_other

        # Interleaved appends across Worker A and Worker B produce one contiguous PostgreSQL hash chain
        base_dt = datetime(2026, 11, 14, 18, 0, 0, tzinfo=UTC)
        e1 = ledger_a.append_event(
            tenant_slug="audit-victim",
            actor_type="customer_user",
            actor_id="u-1",
            action="saml.login",
            target_urn="urn:kodera:user:u-1",
            occurred_at=base_dt,
        )
        e2 = ledger_b.append_event(
            tenant_slug="audit-victim",
            actor_type="customer_user",
            actor_id="u-2",
            action="scim.provision",
            target_urn="urn:kodera:user:u-2",
            occurred_at=base_dt,
        )
        e3 = ledger_a.append_event(
            tenant_slug="audit-victim",
            actor_type="customer_user",
            actor_id="u-1",
            action="audit.export",
            target_urn="urn:kodera:org:audit-victim",
            occurred_at=base_dt,
        )

        assert (e1.sequence, e2.sequence, e3.sequence) == (1, 2, 3)
        assert e2.prev_hash == e1.entry_hash
        assert e3.prev_hash == e2.entry_hash

        ok, errs = ledger_b.verify_vault_integrity("audit-victim")
        assert ok is True
        assert errs == []
        assert len(ledger_b.snapshot_events("audit-victim")) == 3

        # Bundle exported on Worker A verifies cleanly against Worker B's deterministic tenant key
        bundle_from_a = export_compliance_bundle(
            ledger=ledger_a,
            tenant_slug="audit-victim",
            signer=ledger_a.ed25519_signer_for_tenant("audit-victim"),
            export_format="ndjson",
            framework="SECNUMCLOUD",
        )
        ver_on_b = verify_compliance_bundle(
            bundle_from_a.payload_text,
            bundle_from_a.manifest,
            trusted_public_key_pem=pub_b,
        )
        assert ver_on_b.verified is True
        assert ver_on_b.record_count == 3
