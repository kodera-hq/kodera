"""Database-free contract tests for SAML->OIDC RFC 7636 PKCE callback and audit erasure seals.

Runs without PostgreSQL (`can_use_postgres() == False`) while exercising real Django HTTP routing,
RFC 7636 PKCE `S256` verifier retention and `/token` `id_token` verification, scrubbed audit row
tamper detection (`erasure_commitment`), and `0034_ee_audit_ledger_erasure` SQL parity.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import secrets
import time
import urllib.parse
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import Client, override_settings

from ee.audit_export.crypto import GENESIS_PREV_HASH, LEDGER_HASH_DOMAIN, compute_domain_sha256
from ee.audit_export.ledger import (
    EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL,
    EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL,
    ComplianceAuditEvent,
    _ledger_hash_fields,
    build_erasure_commitment_seal,
    compute_erasure_row_mac,
    verify_ledger_sequence,
)
from ee.saml.service import (
    ProvisionedSamlPrincipal,
    SamlIdpConfig,
    _compute_pkce_s256,
    default_saml_service,
)

MONOREPO_ROOT = Path(__file__).resolve().parents[2]


def test_inmemory_oidc_callback_rfc7636_pkce_exchange_and_provider_error_burn(
    monkeypatch: pytest.MonkeyPatch,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    monkeypatch.setattr("ee.saml.service.can_use_postgres", lambda: False)
    monkeypatch.setattr("ee.auth.can_use_postgres", lambda: False)

    _idp_priv, _idp_pub_pem, idp_cert_pem = rsa_idp_keypair
    oidc_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issuer = "https://sso.kodera.test/realms/mem-saml"
    default_saml_service.register_oidc_public_key(
        issuer=issuer,
        kid="mem-oidc-k1",
        algorithm="RS256",
        public_key=oidc_priv.public_key(),
    )
    chal = default_saml_service.build_domain_challenge(
        tenant_slug="mem-saml",
        domain="mem-saml.fr",
    )
    default_saml_service.seed_dns_txt_record(
        str(chal["dns_record_name"]),
        str(chal["txt_value"]),
    )
    default_saml_service.verify_domain_challenge(
        tenant_slug="mem-saml",
        domain="mem-saml.fr",
    )
    default_saml_service.register_idp(
        SamlIdpConfig(
            tenant_slug="mem-saml",
            idp_id="okta-mem",
            idp_entity_id="https://idp.mem-saml.test/saml2",
            idp_sso_url="https://idp.mem-saml.test/sso",
            public_key_pem=idp_cert_pem,
            verified_domains=frozenset({"mem-saml.fr"}),
        )
    )

    issued_codes: dict[str, dict[str, str]] = {}

    def _exchanger(endpoint: str, form: Mapping[str, str]) -> Mapping[str, object]:
        assert endpoint == f"{issuer}/protocol/openid-connect/token"
        rec = issued_codes.pop(form.get("code", ""), None)
        verifier = form.get("code_verifier", "")
        if (
            rec is None
            or form.get("grant_type") != "authorization_code"
            or form.get("client_id") != rec["client_id"]
            or form.get("redirect_uri") != rec["redirect_uri"]
            or not verifier
            or _compute_pkce_s256(verifier) != rec["code_challenge"]
        ):
            return {"error": "invalid_grant"}
        now_ts = int(time.time())
        id_tok = jwt.encode(
            {
                "iss": issuer,
                "sub": rec["sub"],
                "aud": rec["client_id"],
                "email": rec["email"],
                "email_verified": True,
                "nonce": rec["nonce"],
                "iat": now_ts,
                "exp": now_ts + 300,
            },
            oidc_priv,
            algorithm="RS256",
            headers={"kid": "mem-oidc-k1"},
        )
        return {"token_type": "Bearer", "id_token": id_tok}

    default_saml_service.set_oidc_token_exchanger(_exchanger)
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    def _make_handoff(*, with_client_pkce: bool) -> tuple[str, dict[str, str], str]:
        user_sub = str(uuid4())
        client_ver = "client-pkce-verifier-0123456789abcdef0123456789abcdef"
        cc = _compute_pkce_s256(client_ver)
        principal = ProvisionedSamlPrincipal(
            user_id=user_sub,
            tenant_slug="mem-saml",
            idp_id="okta-mem",
            idp_entity_id="https://idp.mem-saml.test/saml2",
            assertion_id=f"_assn_{secrets.token_hex(8)}",
            subject_name_id="alice@mem-saml.fr",
            email="alice@mem-saml.fr",
            display_name="Alice",
            groups=(),
            role="org_member",
            return_path="/app",
            authenticated_at=datetime.now(UTC),
            oidc_client_id="console",
            oidc_redirect_uri="http://127.0.0.1/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
            oidc_code_challenge=cc if with_client_pkce else None,
        )
        url, _state = default_saml_service.build_oidc_handoff(
            principal,
            sp_base_url="http://127.0.0.1",
        )
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        return user_sub, {k: v[0] for k, v in parsed.items()}, client_ver

    # 0. `P2-1`: Unconfigured `client_id` and `redirect_uri` are rejected (`400`) at `/login`!
    assert (
        client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem", "client_id": "evil-client"},
        ).status_code
        == 400
    )
    assert (
        client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem", "redirect_uri": "https://evil.example/cb"},
        ).status_code
        == 400
    )

    # 1. `error=access_denied` + valid `state` (without client PKCE) -> `403` + burns `state`!
    sub_err, q_err, _ = _make_handoff(with_client_pkce=False)
    unused_code = f"code-{secrets.token_hex(8)}"
    issued_codes[unused_code] = {
        "code_challenge": q_err["code_challenge"],
        "nonce": q_err["nonce"],
        "sub": sub_err,
        "email": "alice@mem-saml.fr",
        "redirect_uri": q_err["redirect_uri"],
        "client_id": q_err["client_id"],
    }
    r_err = client.get(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        {"error": "access_denied", "state": q_err["state"]},
    )
    assert r_err.status_code == 403
    assert r_err.json()["code"] == "oidc_provider_error"

    r_err_replay = client.get(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        {"code": unused_code, "state": q_err["state"]},
    )
    assert r_err_replay.status_code == 403
    assert r_err_replay.json()["code"] == "replayed_handoff_token"

    # 2. `P1-2`: When `code_challenge` WAS registered on `/login`, missing (`None`) or blank (`""`)
    #    `code_verifier` fails closed (`400 missing_pkce_verifier`), while supplying the matching
    #    `code_verifier` completes (`200`)!
    sub_pkce, q_pkce, client_ver = _make_handoff(with_client_pkce=True)
    assert (
        client.get(
            "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
            {"state": q_pkce["state"]},
        ).status_code
        == 400
    )
    valid_code = f"code-{secrets.token_hex(8)}"
    issued_codes[valid_code] = {
        "code_challenge": q_pkce["code_challenge"],
        "nonce": q_pkce["nonce"],
        "sub": sub_pkce,
        "email": "alice@mem-saml.fr",
        "redirect_uri": q_pkce["redirect_uri"],
        "client_id": q_pkce["client_id"],
    }
    r_missing_ver = client.get(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        {"code": valid_code, "state": q_pkce["state"]},
    )
    assert r_missing_ver.status_code == 400
    assert r_missing_ver.json()["code"] == "missing_pkce_verifier"

    r_blank_ver = client.post(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        data=json.dumps({"code": valid_code, "state": q_pkce["state"], "code_verifier": ""}),
        content_type="application/json",
    )
    assert r_blank_ver.status_code == 400
    assert r_blank_ver.json()["code"] == "missing_pkce_verifier"

    r_ok = client.post(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        data=json.dumps(
            {"code": valid_code, "state": q_pkce["state"], "code_verifier": client_ver}
        ),
        content_type="application/json",
    )
    assert r_ok.status_code == 200, r_ok.content
    body = r_ok.json()
    assert body["authenticated"] is True
    assert body["user_id"] == sub_pkce
    assert str(body["access_token"]).startswith("kes1.")

    # 3. Wrong `sub` or wrong `nonce` in `id_token` is rejected (`403 oidc_identity_mismatch`)!
    _sub_bad, q_bad, _ = _make_handoff(with_client_pkce=False)
    bad_sub_code = f"code-{secrets.token_hex(8)}"
    issued_codes[bad_sub_code] = {
        "code_challenge": q_bad["code_challenge"],
        "nonce": q_bad["nonce"],
        "sub": str(uuid4()),
        "email": "alice@mem-saml.fr",
        "redirect_uri": q_bad["redirect_uri"],
        "client_id": q_bad["client_id"],
    }
    r_bad_sub = client.get(
        "/api/v1/ee/sso/saml/mem-saml/oidc-handoff",
        {"code": bad_sub_code, "state": q_bad["state"]},
    )
    assert r_bad_sub.status_code == 403
    assert r_bad_sub.json()["code"] == "oidc_identity_mismatch"

    # 4. `Mistral P2-1`: Explicit empty or invalid `KODERA_SAML_ALLOWED_OIDC_CLIENT_IDS` fails
    #    closed (`400 invalid_client_id`) even when `client_id` is omitted (`None`) or `""`!
    for empty_allowlist in ("", ["invalid client!", "   "]):
        with override_settings(KODERA_SAML_ALLOWED_OIDC_CLIENT_IDS=empty_allowlist):
            for candidate_params in (
                {"idp_id": "okta-mem"},
                {"idp_id": "okta-mem", "client_id": ""},
                {"idp_id": "okta-mem", "client_id": "console"},
            ):
                r_deny_cid = client.get(
                    "/api/v1/ee/sso/saml/mem-saml/login",
                    candidate_params,
                )
                assert r_deny_cid.status_code == 400
                assert r_deny_cid.json()["code"] == "invalid_client_id"

    # 5. `R5 P2-2`: Core fallback `KODERA_ALLOWED_OIDC_CLIENT_IDS="kodera-ios,kodera-android"`
    #    unions in `KODERA_CONSOLE_CLIENT_ID="console-prod"` (both explicit and default omitted
    #    `client_id`), while native-only allowlists with no console client reject omitted `client_id`
    #    (`400 invalid_client_id`) rather than picking `kodera-android`!
    with override_settings(
        KODERA_ALLOWED_OIDC_CLIENT_IDS="kodera-ios,kodera-android",
        KODERA_CONSOLE_CLIENT_ID="console-prod",
    ):
        r_console_explicit = client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem", "client_id": "console-prod"},
        )
        assert r_console_explicit.status_code == 200, r_console_explicit.content
        r_console_default = client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem"},
        )
        assert r_console_default.status_code == 200, r_console_default.content

    with override_settings(
        KODERA_ALLOWED_OIDC_CLIENT_IDS="kodera-ios,kodera-android",
        KODERA_CONSOLE_CLIENT_ID=None,
    ):
        monkeypatch.delenv("KODERA_CONSOLE_CLIENT_ID", raising=False)
        r_native_explicit = client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem", "client_id": "kodera-ios"},
        )
        assert r_native_explicit.status_code == 200, r_native_explicit.content
        r_native_omitted = client.get(
            "/api/v1/ee/sso/saml/mem-saml/login",
            {"idp_id": "okta-mem"},
        )
        assert r_native_omitted.status_code == 400
        assert r_native_omitted.json()["code"] == "invalid_client_id"


def test_inmemory_erased_row_commitment_detects_actor_and_action_tampering() -> None:
    req_id = str(uuid4())
    orig_urn = "urn:kodera:user:legacy-jane@corp.example"
    scrubbed_urn = "urn:kodera:user:erased:0123456789abcdef01234567"
    eid_1 = str(uuid4())
    ts_1 = "2026-02-01T12:00:00.000000Z"
    orig_hash = compute_domain_sha256(
        LEDGER_HASH_DOMAIN,
        _ledger_hash_fields(
            sequence=1,
            event_id=eid_1,
            occurred_at=ts_1,
            tenant_slug="acme",
            actor_type="customer_user",
            actor_id="owner-uuid",
            action="member.targeted",
            target_urn=orig_urn,
            prev_hash=GENESIS_PREV_HASH,
        ),
    )
    seal = build_erasure_commitment_seal(
        scope="account",
        erasure_request_id=req_id,
        instruction_sha256="a" * 64,
        inventory_sha256="b" * 64,
        sequence=1,
        event_id=eid_1,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="owner@corp.example",
        action="member.targeted",
        target_urn=scrubbed_urn,
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=orig_hash,
    )
    scrubbed_evt = ComplianceAuditEvent(
        sequence=1,
        event_id=eid_1,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="owner@corp.example",
        action="member.targeted",
        target_urn=scrubbed_urn,
        source_ip="",
        metadata={},
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=orig_hash,
        pii_scrubbed=True,
        erasure_commitment=seal,
    )

    eid_2 = str(uuid4())
    ts_2 = "2026-02-01T12:01:00.000000Z"
    hash_2 = compute_domain_sha256(
        LEDGER_HASH_DOMAIN,
        _ledger_hash_fields(
            sequence=2,
            event_id=eid_2,
            occurred_at=ts_2,
            tenant_slug="acme",
            actor_type="system",
            actor_id="system",
            action="vault.checked",
            target_urn="urn:kodera:vault:1",
            prev_hash=orig_hash,
        ),
    )
    next_evt = ComplianceAuditEvent(
        sequence=2,
        event_id=eid_2,
        occurred_at=ts_2,
        tenant_slug="acme",
        actor_type="system",
        actor_id="system",
        actor_label="system",
        action="vault.checked",
        target_urn="urn:kodera:vault:1",
        source_ip="",
        metadata={},
        prev_hash=orig_hash,
        entry_hash=hash_2,
    )

    assert verify_ledger_sequence((scrubbed_evt, next_evt)) == (True, [])

    # Mutating `action`, `occurred_at`, or `actor_id` while keeping `entry_hash` and `erasure_commitment` fails!
    for tampered_evt in (
        replace(scrubbed_evt, action="forged.action", actor_id="mallory"),
        replace(scrubbed_evt, occurred_at="2026-02-01T12:00:59.000000Z"),
    ):
        ok_tamp, errs_tamp = verify_ledger_sequence((tampered_evt, next_evt))
        assert ok_tamp is False
        assert any("erasure_commitment mismatch" in err for err in errs_tamp)

    # Recomputing a plain SHA-256 + DB-only HMAC without the server HKDF secret ALSO fails!
    forged_seal = f"account:{req_id}:{'c' * 64}:{'d' * 64}"
    assert (
        verify_ledger_sequence(
            (replace(scrubbed_evt, action="forged.dump", erasure_commitment=forged_seal), next_evt)
        )[0]
        is False
    )

    # Removing `erasure_commitment` or retaining `metadata` / `source_ip` also fails!
    assert verify_ledger_sequence((replace(scrubbed_evt, erasure_commitment=None), next_evt))[0] is False
    assert verify_ledger_sequence((replace(scrubbed_evt, source_ip="198.51.100.0/24"), next_evt))[0] is False
    assert verify_ledger_sequence((replace(scrubbed_evt, metadata={"leak": "x"}), next_evt))[0] is False

    # `Codex P2-3`: Pipe-delimited field-boundary shifting (`actor_label="erased", action="member|targeted"`
    # vs `actor_label="erased|member", action="targeted"`) is rejected by length-prefixed row MAC!
    pipe_eid = str(uuid4())
    pipe_hash = compute_domain_sha256(
        LEDGER_HASH_DOMAIN,
        _ledger_hash_fields(
            sequence=1,
            event_id=pipe_eid,
            occurred_at=ts_1,
            tenant_slug="acme",
            actor_type="customer_user",
            actor_id="owner-uuid",
            action="member|targeted",
            target_urn=orig_urn,
            prev_hash=GENESIS_PREV_HASH,
        ),
    )
    pipe_seal = build_erasure_commitment_seal(
        scope="account",
        erasure_request_id=req_id,
        instruction_sha256="a" * 64,
        inventory_sha256="b" * 64,
        sequence=1,
        event_id=pipe_eid,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="erased",
        action="member|targeted",
        target_urn=scrubbed_urn,
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=pipe_hash,
    )
    mac_a = compute_erasure_row_mac(
        scope="account",
        erasure_request_id=req_id,
        sequence=1,
        event_id=pipe_eid,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="erased",
        action="member|targeted",
        target_urn=scrubbed_urn,
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=pipe_hash,
    )
    mac_b = compute_erasure_row_mac(
        scope="account",
        erasure_request_id=req_id,
        sequence=1,
        event_id=pipe_eid,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="erased|member",
        action="targeted",
        target_urn=scrubbed_urn,
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=pipe_hash,
    )
    assert mac_a != mac_b
    pipe_evt = ComplianceAuditEvent(
        sequence=1,
        event_id=pipe_eid,
        occurred_at=ts_1,
        tenant_slug="acme",
        actor_type="customer_user",
        actor_id="owner-uuid",
        actor_label="erased",
        action="member|targeted",
        target_urn=scrubbed_urn,
        source_ip="",
        metadata={},
        prev_hash=GENESIS_PREV_HASH,
        entry_hash=pipe_hash,
        pii_scrubbed=True,
        erasure_commitment=pipe_seal,
    )
    assert verify_ledger_sequence((pipe_evt,)) == (True, [])
    ok_shift, errs_shift = verify_ledger_sequence(
        (replace(pipe_evt, actor_label="erased|member", action="targeted"),)
    )
    assert ok_shift is False
    assert any("erasure_commitment mismatch" in err for err in errs_shift)


def test_migration_0034_sql_parity_and_embedded_target_scrub_obligations() -> None:
    mig_file = (
        MONOREPO_ROOT
        / "apps"
        / "server"
        / "apps"
        / "orgs"
        / "migrations"
        / "0035_ee_audit_ledger_erasure.py"
    )
    spec = importlib.util.spec_from_file_location("mig_0035", mig_file)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod.FORWARD == EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL
    assert mod.REVERSE == EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL
    assert "ee_audit_target_scrub_ids" in mod.FORWARD
    assert "ee_audit_actor_scrub_ids" in mod.FORWARD
    assert "ee_audit_resolve_erasure_master_key" in mod.FORWARD
    assert "scim contact sync forbidden for protected role" in mod.FORWARD
    assert "scim contact sync requires scim-provisioned identity" in mod.FORWARD
    assert "ADD COLUMN provisioned_by_scim boolean NOT NULL DEFAULT FALSE" in mod.FORWARD
    assert "su.provisioned_by_scim = TRUE" in mod.FORWARD
    assert "octet_length(convert_to(p_actor_label, 'UTF8'))" in mod.FORWARD
    assert mod.FORWARD.count("public.ee_audit_row_requires_target_scrub(") >= 3
    assert mod.FORWARD.count("public.ee_audit_build_erasure_seal(") >= 2
    # Ensure base64/json/secrets imports remain exercised cleanly without warnings
    assert len(base64.urlsafe_b64encode(json.dumps({"ok": True}).encode())) > 4
