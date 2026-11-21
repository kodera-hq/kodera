"""Stage 4 regression suite for Enterprise SAML, SCIM, Edition & Audit Export (`PR-K3`).

Covers:
- `BUG-0036`: Cold-start `/api/v1/ee/billing/*` import dispatch when repo root is absent from
  `sys.path`, `config.settings.deploy` validation of `KODERA_PUBLIC_API_ORIGIN` /
  `KODERA_SAML_SP_BASE_URL`, and canonical `https://` SAML/SCIM URL derivation behind TLS proxies.
- `BUG-0060`: Pre-mutation SAML XML signature verification (unverified responses never burn
  `RelayState`), single-`transaction.atomic()` rollback under `55P03` lock contention (`409
  authority_fenced` leaves `RelayState` + assertion replay intact for immediate retry), and
  Keycloak OIDC broker handoff (`303 See Other` + HMAC-signed `handoff_token`).
- `BUG-0061`: `org_admin` role ceiling on SAML IdP registration (`org_billing` -> `403`), DNS TXT
  domain ownership verification (`422 unverified_domain` / `409 domain_already_claimed`), refusal
  of SAML email fallback linking onto non-SAML identities (`403 email_bound_to_non_saml_identity`),
  protection of `org_billing`/`org_owner` from JIT overwrites, and `AuditEvent` +
  `EngineChannelSet` / `EngineMemberSetHead` emission on SAML role/membership changes.
- `BUG-0062`: Non-blocking `pg_try_advisory_xact_lock_shared('privacy_account_cutoff:' || user)`
  eliminating SCIM `Organisation -> User` vs `User -> Organisation` deadlocks (`409
  authority_fenced`), authenticated `org_owner`/`org_admin` SCIM token management routes, and SCIM
  `PUT`/`PATCH` syncing `email`/`displayName`/`roles` onto `orgs_membership` + engine channel sets.
- `BUG-0063`: Canonical KC-02 UUID `Identity.subject` matching `tenant_agent/synapse.py:_LOCALPART`,
  tenant-scoped email matching & full revocation (`Membership`, `EngineMemberSetHead`,
  `OutboxRealmAccess`) when `userName != email`, and refusal to revive `REMOVED` `org_admin` roles.
- `BUG-0054`, `BUG-0055`, `BUG-0056`: Keyed HMAC-SHA256 PII pseudonymization (`target_urn`,
  `given_name`/`family_name`, `"Alice @ Finance"`), ingestion IP truncation + opaque `target_urn`
  enforcement + `Identity.user_id` population + `EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL`
  subject-referenced GDPR Art. 17 scrubbing, and SQL cursor pagination + `32 KiB` metadata cap +
  `413 export_limit_exceeded` + `429 rate_limit_exceeded`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.test import Client, override_settings
from django.utils import timezone

from ee.audit_export.exporter import MAX_EXPORT_ROWS, export_compliance_bundle
from ee.audit_export.ledger import (
    EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL,
    EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL,
    EE_AUDIT_ERASURE_RESTORE_0032_GUARDS_SQL,
    MAX_EVENT_METADATA_BYTES,
    default_audit_ledger,
)
from ee.saml.service import _canonical_saml_subject_uuid, default_saml_service
from ee.scim.schemas import (
    SCIM_ENTERPRISE_USER_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
)
from ee.scim.service import default_scim_service
from ee.tests.conftest import ProvisionedTestPrincipal
from ee.tests.test_saml_security import _build_saml_response_xml

pytestmark = pytest.mark.django_db(transaction=True)

MONOREPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_ROOT = MONOREPO_ROOT / "apps" / "server"


def _seed_verified_domain(tenant_slug: str, domain: str, organisation_id: UUID) -> None:
    chal = default_saml_service.build_domain_challenge(
        tenant_slug=tenant_slug,
        domain=domain,
        organisation_id=organisation_id,
    )
    default_saml_service.seed_dns_txt_record(
        str(chal["dns_record_name"]),
        str(chal["txt_value"]),
    )
    default_saml_service.verify_domain_challenge(
        tenant_slug=tenant_slug,
        domain=domain,
        organisation_id=organisation_id,
    )


def test_bug_0036_cold_start_ee_billing_import_and_canonical_https_origins(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    # 1. Cold-start subprocess with cwd=apps/server and PYTHONPATH=apps/server ONLY:
    #    very first request is GET /api/v1/ee/billing/plans -> must dispatch (401, NEVER 404)!
    probe = """
import json, sys
import django
from pathlib import Path
repo_root = str(Path.cwd().parents[1])
sys.path = [p for p in sys.path if Path(p or '.').resolve() != Path(repo_root).resolve()]
django.setup()
from django.test import Client
resp = Client().get("/api/v1/ee/billing/plans", HTTP_HOST="127.0.0.1")
print(json.dumps({"status": resp.status_code, "www_auth": resp.headers.get("WWW-Authenticate")}))
"""
    clean_env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "PYTHONPATH": str(SERVER_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.test",
        "DJANGO_SECRET_KEY": "synthetic-cold-start-secret-0123456789abcdef0123456789abcdef",
        "DATABASE_URL": "postgresql://kodera:kodera@127.0.0.1:5434/kodera_server",
        "KODERA_EDITION": "enterprise",
    }
    proc = subprocess.run(  # noqa: S603 - isolated synthetic subprocess probe
        [sys.executable, "-c", probe],
        cwd=SERVER_ROOT,
        env=clean_env,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == {"status": 401, "www_auth": "Bearer"}

    # 2. `config.settings.deploy` validates `KODERA_PUBLIC_API_ORIGIN` & `KODERA_SAML_SP_BASE_URL`
    deploy_base_env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(SERVER_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
        "DJANGO_SECRET_KEY": "synthetic-deploy-only-" + ("a1b2c3d4e5" * 6),
        "DJANGO_ALLOWED_HOSTS": "api.kodera.example",
        "DATABASE_URL": "postgresql://kodera:kodera@127.0.0.1:5434/kodera_server",
    }
    ok_deploy = subprocess.run(  # noqa: S603 - isolated deploy settings probe
        [
            sys.executable,
            "-c",
            "import json, django; django.setup(); from django.conf import settings; "
            "print(json.dumps({'api': settings.KODERA_PUBLIC_API_ORIGIN, 'saml': settings.KODERA_SAML_SP_BASE_URL}))",
        ],
        cwd=SERVER_ROOT,
        env=deploy_base_env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert ok_deploy.returncode == 0, ok_deploy.stderr
    assert json.loads(ok_deploy.stdout) == {
        "api": "https://api.kodera.example",
        "saml": "https://api.kodera.example",
    }

    for bad_env in (
        {"KODERA_PUBLIC_API_ORIGIN": "http://api.kodera.example"},
        {"KODERA_SAML_SP_BASE_URL": "https://api.kodera.example/extra-path"},
    ):
        bad_deploy = subprocess.run(  # noqa: S603 - isolated deploy refusal probe
            [sys.executable, "-c", "import config.settings.deploy"],
            cwd=SERVER_ROOT,
            env={**deploy_base_env, **bad_env},
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert bad_deploy.returncode != 0
        assert "Deployment configuration refused" in bad_deploy.stderr

    # 3. Behind TLS-terminating proxy (`DEBUG=False`), SAML & SCIM derive canonical `https://` URLs
    priv_key, _pub_pem, cert_pem = rsa_idp_keypair
    owner = tenant_principal_factory("tls-corp", role="org_owner", email="owner@tls-corp.fr")
    monkeypatch.setenv("KODERA_EDITION", "enterprise")

    with override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["api.kodera.example", "127.0.0.1"],
        KODERA_PUBLIC_API_ORIGIN="https://api.kodera.example",
        KODERA_SAML_SP_BASE_URL="https://api.kodera.example",
    ):
        _seed_verified_domain("tls-corp", "tls-corp.fr", owner.organisation_id)
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        reg = client.post(
            "/api/v1/ee/sso/saml/tls-corp/providers",
            data=json.dumps(
                {
                    "idp_id": "okta-tls",
                    "idp_entity_id": "https://idp.tls-corp.test/saml2",
                    "idp_sso_url": "https://idp.tls-corp.test/sso",
                    "public_key_pem": cert_pem,
                    "verified_domains": ["tls-corp.fr"],
                }
            ),
            content_type="application/json",
            headers=owner.headers,
        )
        assert reg.status_code == 201, reg.content

        meta = client.get(
            "/api/v1/ee/sso/saml/tls-corp/metadata",
            HTTP_X_FORWARDED_HOST="evil.attacker.invalid",
            HTTP_X_FORWARDED_PROTO="http",
        )
        assert meta.status_code == 200
        meta_xml = meta.content.decode("utf-8")
        assert "https://api.kodera.example/api/v1/ee/sso/saml/tls-corp/acs" in meta_xml
        assert "evil.attacker.invalid" not in meta_xml

        login = client.get("/api/v1/ee/sso/saml/tls-corp/login", {"idp_id": "okta-tls"}).json()
        xml_https = _build_saml_response_xml(
            in_response_to=str(login["request_id"]),
            destination="https://api.kodera.example/api/v1/ee/sso/saml/tls-corp/acs",
            recipient="https://api.kodera.example/api/v1/ee/sso/saml/tls-corp/acs",
            audience="https://api.kodera.example/api/v1/ee/sso/saml/tls-corp/metadata",
            idp_entity_id="https://idp.tls-corp.test/saml2",
            name_id="alice@tls-corp.fr",
            email_attr="alice@tls-corp.fr",
            sign_key=priv_key,
        )
        acs = client.post(
            "/api/v1/ee/sso/saml/tls-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(xml_https.encode("utf-8")).decode("ascii"),
                "RelayState": str(login["relay_state"]),
            },
        )
        assert acs.status_code == 200, acs.content

        raw_tok, _ = default_scim_service.tokens.issue_token(
            tenant_slug="tls-corp",
            description="TLS Probe",
            organisation_id=owner.organisation_id,
        )
        sp_cfg = client.get(
            "/api/v1/ee/scim/v2/ServiceProviderConfig",
            HTTP_AUTHORIZATION=f"Bearer {raw_tok}",
            HTTP_X_FORWARDED_HOST="evil.attacker.invalid",
        )
        assert sp_cfg.status_code == 200
        assert sp_cfg.json()["meta"]["location"].startswith("https://api.kodera.example/")


def test_bug_0060_saml_atomic_acs_rollback_and_oidc_handoff(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    priv_key, _pub_pem, cert_pem = rsa_idp_keypair
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setenv("KODERA_EDITION", "enterprise")

    owner = tenant_principal_factory("atomic-corp", role="org_owner", email="owner@atomic.fr")
    _seed_verified_domain("atomic-corp", "atomic.fr", owner.organisation_id)
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    assert (
        client.post(
            "/api/v1/ee/sso/saml/atomic-corp/providers",
            data=json.dumps(
                {
                    "idp_id": "okta-atomic",
                    "idp_entity_id": "https://idp.atomic.test/saml2",
                    "idp_sso_url": "https://idp.atomic.test/sso",
                    "public_key_pem": cert_pem,
                    "verified_domains": ["atomic.fr"],
                }
            ),
            content_type="application/json",
            headers=owner.headers,
        ).status_code
        == 201
    )

    login = client.get(
        "/api/v1/ee/sso/saml/atomic-corp/login",
        {"idp_id": "okta-atomic", "return_path": "/workspace/channels"},
    ).json()
    relay_state = str(login["relay_state"])
    req_id = str(login["request_id"])

    # 1. Forged signature fails BEFORE RelayState is burned -> RelayState stays usable!
    bad_xml = _build_saml_response_xml(
        in_response_to=req_id,
        destination="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/acs",
        recipient="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/acs",
        audience="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/metadata",
        idp_entity_id="https://idp.atomic.test/saml2",
        name_id="claire@atomic.fr",
        email_attr="claire@atomic.fr",
        sign_key=wrong_key,
    )
    r_bad = client.post(
        "/api/v1/ee/sso/saml/atomic-corp/acs",
        data={
            "SAMLResponse": base64.b64encode(bad_xml.encode("utf-8")).decode("ascii"),
            "RelayState": relay_state,
        },
    )
    assert r_bad.status_code == 403

    # 2. Valid signature under concurrent `orgs_organisation` lock (`55P03` -> `409 authority_fenced`)
    #    rolls back BOTH `ee_saml_pending_request` burn AND `ee_saml_replay_assertion` insert!
    good_xml = _build_saml_response_xml(
        assertion_id="_assn_atomic_retry_01",
        in_response_to=req_id,
        destination="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/acs",
        recipient="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/acs",
        audience="http://127.0.0.1/api/v1/ee/sso/saml/atomic-corp/metadata",
        idp_entity_id="https://idp.atomic.test/saml2",
        name_id="claire@atomic.fr",
        email_attr="claire@atomic.fr",
        sign_key=priv_key,
    )
    b64_good = base64.b64encode(good_xml.encode("utf-8")).decode("ascii")

    cfg = connection.settings_dict
    with psycopg.connect(
        host=cfg["HOST"],
        port=cfg["PORT"],
        dbname=cfg["NAME"],
        user=cfg["USER"],
        password=cfg["PASSWORD"],
        autocommit=False,
    ) as conn2:
        conn2.execute(
            "SELECT 1 FROM orgs_organisation WHERE id = %s FOR UPDATE",
            [owner.organisation_id],
        )
        r_fenced = client.post(
            "/api/v1/ee/sso/saml/atomic-corp/acs",
            data={"SAMLResponse": b64_good, "RelayState": relay_state},
        )
        assert r_fenced.status_code == 409
        assert r_fenced.json()["code"] == "authority_fenced"
        conn2.rollback()

    # Immediate retry with the EXACT SAME `SAMLResponse` + `RelayState` succeeds (`303` on HTML)!
    r_browser = client.post(
        "/api/v1/ee/sso/saml/atomic-corp/acs",
        data={"SAMLResponse": b64_good, "RelayState": relay_state},
        HTTP_ACCEPT="text/html,application/xhtml+xml",
    )
    assert r_browser.status_code == 303
    location = r_browser["Location"]
    assert location.startswith("https://sso.kodera.test/realms/atomic-corp/protocol/openid-connect/auth?")
    assert "kc_idp_hint=okta-atomic" in location
    parsed_q = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
    assert parsed_q["login_hint"] == ["claire@atomic.fr"]
    assert "." in parsed_q["state"][0]


def test_bug_0061_saml_role_ceiling_domain_ownership_and_audit_hooks(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    from apps.audit.models import AuditEvent
    from apps.engine_intents.models import EngineChannelSet, EngineMemberSetHead
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership
    from apps.workspaces.models import ResourcePolicy, Workspace
    from tenant_agent.synapse import _LOCALPART

    priv_key, _pub_pem, cert_pem = rsa_idp_keypair
    monkeypatch.setenv("KODERA_EDITION", "enterprise")

    owner = tenant_principal_factory("ceiling-corp", role="org_owner", email="owner@ceiling.fr")
    admin = tenant_principal_factory("ceiling-corp", role="org_admin", email="admin@ceiling.fr")
    billing = tenant_principal_factory(
        "ceiling-corp", role="org_billing", email="billing@ceiling.fr"
    )
    other_owner = tenant_principal_factory("other-corp", role="org_owner", email="owner@other.fr")
    with transaction.atomic():
        ws_ceil = Workspace.objects.create(organisation_id=owner.organisation_id)
        pol_ceil = ResourcePolicy.objects.create(
            workspace=ws_ceil,
            visibility=ResourcePolicy.Visibility.ORGANISATION,
        )
        ws_ceil.default_policy = pol_ceil
        ws_ceil.save(update_fields=["default_policy", "updated_at"])
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    # 1. Unverified domain & freemail domain (`gmail.com`) are rejected (`422`)
    for bad_dom in ("unverified-ceiling.fr", "gmail.com"):
        r_unver = client.post(
            "/api/v1/ee/sso/saml/ceiling-corp/providers",
            data=json.dumps(
                {
                    "idp_id": "okta-bad",
                    "idp_entity_id": "https://idp.ceiling.test/saml2",
                    "idp_sso_url": "https://idp.ceiling.test/sso",
                    "public_key_pem": cert_pem,
                    "verified_domains": [bad_dom],
                }
            ),
            content_type="application/json",
            headers=owner.headers,
        )
        assert r_unver.status_code == 422, r_unver.content

    # Issue (`GET`) + verify (`POST`) DNS TXT challenge via HTTP API (`.../domain-challenges`)
    r_chal = client.get(
        "/api/v1/ee/sso/saml/ceiling-corp/domain-challenges",
        {"domain": "ceiling.fr"},
        headers=admin.headers,
    )
    assert r_chal.status_code == 200
    chal_data = r_chal.json()
    default_saml_service.seed_dns_txt_record(
        chal_data["dns_record_name"],
        chal_data["txt_value"],
    )
    r_ver_chal = client.post(
        "/api/v1/ee/sso/saml/ceiling-corp/domain-challenges",
        data=json.dumps({"domain": "ceiling.fr"}),
        content_type="application/json",
        headers=admin.headers,
    )
    assert r_ver_chal.status_code == 200
    assert r_ver_chal.json()["verified"] is True

    # Cross-tenant claim of `ceiling.fr` by `other-corp` ONCE registered on `ceiling-corp` fails (`409`)!
    r_idp_own = client.post(
        "/api/v1/ee/sso/saml/ceiling-corp/providers",
        data=json.dumps(
            {
                "idp_id": "okta-own",
                "idp_entity_id": "https://idp-own.ceiling.test/saml2",
                "idp_sso_url": "https://idp-own.ceiling.test/sso",
                "public_key_pem": cert_pem,
                "verified_domains": ["ceiling.fr"],
                "default_role": "org_member",
            }
        ),
        content_type="application/json",
        headers=admin.headers,
    )
    assert r_idp_own.status_code == 201
    r_conflict = client.get(
        "/api/v1/ee/sso/saml/other-corp/domain-challenges",
        {"domain": "ceiling.fr"},
        headers=other_owner.headers,
    )
    assert r_conflict.status_code == 409
    assert r_conflict.json()["code"] == "domain_already_claimed"

    # 2. (1) `org_admin` POSTing `providers` with `default_role` or mapping `org_billing` gets `403`!
    for forbidden_payload in (
        {"default_role": "org_billing", "group_role_mapping": {}},
        {"default_role": "org_member", "group_role_mapping": {"finance": "org_billing"}},
    ):
        r_ceil = client.post(
            "/api/v1/ee/sso/saml/ceiling-corp/providers",
            data=json.dumps(
                {
                    "idp_id": "okta-ceil",
                    "idp_entity_id": "https://idp.ceiling.test/saml2",
                    "idp_sso_url": "https://idp.ceiling.test/sso",
                    "public_key_pem": cert_pem,
                    "verified_domains": ["ceiling.fr"],
                    **forbidden_payload,
                }
            ),
            content_type="application/json",
            headers=admin.headers,
        )
        assert r_ceil.status_code == 403
        assert r_ceil.json()["code"] == "insufficient_role"

    # `org_admin` CAN register IdP mapping `org_admin` / `org_member` (`201`)
    r_ok_idp = client.post(
        "/api/v1/ee/sso/saml/ceiling-corp/providers",
        data=json.dumps(
            {
                "idp_id": "okta-ceil",
                "idp_entity_id": "https://idp.ceiling.test/saml2",
                "idp_sso_url": "https://idp.ceiling.test/sso",
                "public_key_pem": cert_pem,
                "verified_domains": ["ceiling.fr"],
                "default_role": "org_member",
                "group_role_mapping": {"admins": "org_admin"},
            }
        ),
        content_type="application/json",
        headers=admin.headers,
    )
    assert r_ok_idp.status_code == 201

    def _run_acs(name_id: str, email: str, groups: tuple[str, ...]) -> tuple[int, dict[str, Any]]:
        lg = client.get("/api/v1/ee/sso/saml/ceiling-corp/login", {"idp_id": "okta-ceil"}).json()
        xml = _build_saml_response_xml(
            in_response_to=str(lg["request_id"]),
            destination="http://127.0.0.1/api/v1/ee/sso/saml/ceiling-corp/acs",
            recipient="http://127.0.0.1/api/v1/ee/sso/saml/ceiling-corp/acs",
            audience="http://127.0.0.1/api/v1/ee/sso/saml/ceiling-corp/metadata",
            idp_entity_id="https://idp.ceiling.test/saml2",
            name_id=name_id,
            email_attr=email,
            groups=groups,
            sign_key=priv_key,
        )
        res = client.post(
            "/api/v1/ee/sso/saml/ceiling-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(xml.encode("utf-8")).decode("ascii"),
                "RelayState": str(lg["relay_state"]),
            },
        )
        return res.status_code, res.json()

    # 3. (2) Assertion matching an existing non-SAML Keycloak-realm identity is REFUSED (`403`)
    #        and NEVER changes that membership's role!
    kc_member = tenant_principal_factory(
        "ceiling-corp", role="org_member", email="kc.user@ceiling.fr"
    )
    code_kc, body_kc = _run_acs("kc.user@ceiling.fr", "kc.user@ceiling.fr", ("admins",))
    assert code_kc == 403
    assert body_kc["code"] == "email_bound_to_non_saml_identity"
    assert Membership.objects.get(id=kc_member.membership_id).role == Membership.Role.MEMBER

    # 4. (3) Existing `org_billing` membership on a SAML-bound identity is NEVER overwritten by JIT!
    saml_subj_billing = _canonical_saml_subject_uuid(
        owner.organisation_id, "okta-ceil", "saml.bill@ceiling.fr"
    )
    bill_u = User.objects.create(email="saml.bill@ceiling.fr", display_name="SAML Billing", enabled=True)
    Identity.objects.create(
        user=bill_u,
        organisation_id=owner.organisation_id,
        realm="ceiling-corp",
        issuer=owner.issuer,
        subject=saml_subj_billing,
        email="saml.bill@ceiling.fr",
        enabled=True,
    )
    bill_m = Membership.objects.create(
        organisation_id=owner.organisation_id,
        user=bill_u,
        role=Membership.Role.BILLING,
        state=Membership.State.ACTIVE,
        accepted_at=timezone.now(),
    )
    code_bill, body_bill = _run_acs("saml.bill@ceiling.fr", "saml.bill@ceiling.fr", ("admins",))
    assert code_bill == 200
    assert body_bill["role"] == "org_billing"
    bill_m.refresh_from_db()
    assert bill_m.role == Membership.Role.BILLING
    assert billing.role == "org_billing"

    # 5. (4) SAML JIT creation + subsequent SAML-driven role change emit `AuditEvent`,
    #        `EngineMemberSetHead`, and `EngineChannelSet`, and mint canonical KC-02 UUID subject!
    head_before = (
        EngineMemberSetHead.objects.filter(organisation_id=owner.organisation_id)
        .values_list("revision", flat=True)
        .first()
        or 0
    )
    code_jit, _ = _run_acs("new.saml@ceiling.fr", "new.saml@ceiling.fr", ())
    assert code_jit == 200
    jit_ident = Identity.objects.get(
        organisation_id=owner.organisation_id, email="new.saml@ceiling.fr"
    )
    assert _LOCALPART.fullmatch(jit_ident.subject) is not None
    assert str(UUID(jit_ident.subject)) == jit_ident.subject
    head_after = EngineMemberSetHead.objects.get(organisation_id=owner.organisation_id).revision
    assert head_after > head_before

    chan_count_before = EngineChannelSet.objects.filter(
        organisation_id=owner.organisation_id
    ).count()
    audit_role_before = AuditEvent.objects.filter(
        organisation_id=owner.organisation_id, action="membership.role_changed"
    ).count()

    code_elevate, body_elevate = _run_acs(
        "new.saml@ceiling.fr", "new.saml@ceiling.fr", ("admins",)
    )
    assert code_elevate == 200
    assert body_elevate["role"] == "org_admin"
    assert (
        Membership.objects.get(organisation_id=owner.organisation_id, user_id=jit_ident.user_id).role
        == Membership.Role.ADMIN
    )
    assert (
        AuditEvent.objects.filter(
            organisation_id=owner.organisation_id, action="membership.role_changed"
        ).count()
        == audit_role_before + 1
    )
    assert (
        EngineChannelSet.objects.filter(organisation_id=owner.organisation_id).count()
        > chan_count_before
    )


def test_bug_0062_and_0063_scim_nonblocking_cutoff_tokens_attribute_sync_and_revocation(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    from apps.engine_intents.models import EngineChannelSet, EngineMemberSetHead
    from apps.identity.models import Identity
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership
    from apps.outbox.models import OutboxRealmAccess
    from apps.outbox.realm_enqueue import ACCESS_OFF
    from apps.workspaces.models import ResourcePolicy, Workspace
    from tenant_agent.synapse import _LOCALPART

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    owner = tenant_principal_factory("scim-s4", role="org_owner", email="owner@scim-s4.fr")
    member = tenant_principal_factory("scim-s4", role="org_member", email="member@scim-s4.fr")
    other_owner = tenant_principal_factory("scim-other", role="org_owner", email="owner@other.fr")
    with transaction.atomic():
        ws_scim = Workspace.objects.create(organisation_id=owner.organisation_id)
        pol_scim = ResourcePolicy.objects.create(
            workspace=ws_scim,
            visibility=ResourcePolicy.Visibility.ORGANISATION,
        )
        ws_scim.default_policy = pol_scim
        ws_scim.save(update_fields=["default_policy", "updated_at"])
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    # 1. Authenticated SCIM token management routes (`BUG-0062`): `org_member` gets 403, `org_owner` issues/lists/revokes
    assert (
        client.post(
            "/api/v1/ee/scim/v2/tenants/scim-s4/Tokens",
            data=json.dumps({"description": "Forbidden"}),
            content_type="application/json",
            headers=member.headers,
        ).status_code
        == 403
    )
    tok_create = client.post(
        "/api/v1/ee/scim/v2/tenants/scim-s4/Tokens",
        data=json.dumps({"description": "Okta Directory Sync"}),
        content_type="application/json",
        headers=owner.headers,
    )
    assert tok_create.status_code == 201, tok_create.content
    raw_scim_tok = str(tok_create.json()["token"])
    scim_tok_id = str(tok_create.json()["token_id"])
    scim_hdr = {"Authorization": f"Bearer {raw_scim_tok}"}

    tok_list = client.get("/api/v1/ee/scim/v2/tenants/scim-s4/Tokens", headers=owner.headers)
    assert tok_list.status_code == 200
    assert len(tok_list.json()["tokens"]) == 1
    assert raw_scim_tok not in tok_list.content.decode("utf-8")

    # Cross-tenant owner cannot revoke `scim-s4`'s token (`404`)
    assert (
        client.delete(
            f"/api/v1/ee/scim/v2/tenants/scim-other/Tokens/{scim_tok_id}",
            headers=other_owner.headers,
        ).status_code
        == 404
    )

    # 2. `BUG-0063`: Existing OIDC-active user with `userName='jdoe'` and `email='jane@scim-s4.fr'`
    #    (`Identity.subject` = UUID) is matched and fully revoked upon SCIM `active=false`!
    jane_sub = str(uuid4())
    jane = tenant_principal_factory(
        "scim-s4",
        role="org_member",
        email="jane@scim-s4.fr",
        subject=jane_sub,
    )
    with transaction.atomic():
        member_set_hooks.member_set_changed(
            organisation_id=owner.organisation_id, reason="seed_jane"
        )
    head_pre = EngineMemberSetHead.objects.get(organisation_id=owner.organisation_id).revision

    create_jane = client.post(
        "/api/v1/ee/scim/v2/tenants/scim-s4/Users",
        data=json.dumps(
            {
                "schemas": [SCIM_USER_SCHEMA],
                "userName": "jdoe",
                "displayName": "Jane Doe",
                "active": True,
                "emails": [{"value": "jane@scim-s4.fr", "primary": True}],
            }
        ),
        content_type="application/scim+json",
        headers=scim_hdr,
    )
    assert create_jane.status_code == 201, create_jane.content
    jane_scim_id = str(create_jane.json()["id"])

    # 3. `BUG-0062`: Non-blocking `privacy_account_cutoff` lock on `conn2` returns immediate `409`!
    cfg = connection.settings_dict
    with psycopg.connect(
        host=cfg["HOST"],
        port=cfg["PORT"],
        dbname=cfg["NAME"],
        user=cfg["USER"],
        password=cfg["PASSWORD"],
        autocommit=False,
    ) as conn2:
        conn2.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:' || %s, 0))",
            [str(jane.user_id)],
        )
        r_patch_fenced = client.patch(
            f"/api/v1/ee/scim/v2/tenants/scim-s4/Users/{jane_scim_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_PATCH_OP_SCHEMA],
                    "Operations": [{"op": "replace", "path": "active", "value": False}],
                }
            ),
            content_type="application/scim+json",
            headers=scim_hdr,
        )
        assert r_patch_fenced.status_code == 409
        conn2.rollback()

    # Once `conn2` releases, `PATCH active=false` revokes Jane (`Membership`, `EngineMemberSetHead`, `OutboxRealmAccess`)!
    r_deprov = client.patch(
        f"/api/v1/ee/scim/v2/tenants/scim-s4/Users/{jane_scim_id}",
        data=json.dumps(
            {
                "schemas": [SCIM_PATCH_OP_SCHEMA],
                "Operations": [{"op": "replace", "path": "active", "value": False}],
            }
        ),
        content_type="application/scim+json",
        headers=scim_hdr,
    )
    assert r_deprov.status_code == 200
    assert Membership.objects.get(id=jane.membership_id).state == Membership.State.SUSPENDED
    assert EngineMemberSetHead.objects.get(organisation_id=owner.organisation_id).revision > head_pre
    assert OutboxRealmAccess.objects.filter(
        membership_id=jane.membership_id,
        operation=ACCESS_OFF,
    ).exists()

    # 4. `BUG-0062` & `BUG-0063`: New SCIM user mints UUID `Identity.subject` matching `_LOCALPART`;
    #    SCIM `PATCH` syncs `roles` (`org_admin`) + `channel_set_changed`, refuses `org_billing` (`403`),
    #    and a `REMOVED` `org_admin` re-synced via SCIM resets to `org_member` (never revived as `org_admin`)!
    r_bob = client.post(
        "/api/v1/ee/scim/v2/tenants/scim-s4/Users",
        data=json.dumps(
            {
                "schemas": [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA],
                "userName": "bob.admin@scim-s4.fr",
                "displayName": "Bob Initial",
                "active": True,
            }
        ),
        content_type="application/scim+json",
        headers=scim_hdr,
    )
    assert r_bob.status_code == 201
    bob_scim_id = str(r_bob.json()["id"])
    bob_ident = Identity.objects.get(
        organisation_id=owner.organisation_id, email="bob.admin@scim-s4.fr"
    )
    assert _LOCALPART.fullmatch(bob_ident.subject) is not None

    # Refuses `org_billing` via SCIM `roles` (`403`)
    assert (
        client.put(
            f"/api/v1/ee/scim/v2/tenants/scim-s4/Users/{bob_scim_id}",
            data=json.dumps(
                {
                    "schemas": [SCIM_USER_SCHEMA],
                    "userName": "bob.admin@scim-s4.fr",
                    "displayName": "Bob Billing Try",
                    "active": True,
                    "roles": [{"value": "org_billing", "primary": True}],
                }
            ),
            content_type="application/scim+json",
            headers=scim_hdr,
        ).status_code
        == 403
    )

    chan_before = EngineChannelSet.objects.filter(organisation_id=owner.organisation_id).count()
    r_put_bob = client.put(
        f"/api/v1/ee/scim/v2/tenants/scim-s4/Users/{bob_scim_id}",
        data=json.dumps(
            {
                "schemas": [SCIM_USER_SCHEMA],
                "userName": "bob.renamed@scim-s4.fr",
                "displayName": "Bob Elevated",
                "active": True,
                "roles": [{"value": "org_admin", "primary": True}],
            }
        ),
        content_type="application/scim+json",
        headers=scim_hdr,
    )
    assert r_put_bob.status_code == 200, r_put_bob.content
    bob_ident.refresh_from_db()
    assert bob_ident.email == "bob.renamed@scim-s4.fr"
    bob_memb = Membership.objects.get(
        organisation_id=owner.organisation_id, user_id=bob_ident.user_id
    )
    assert bob_memb.role == Membership.Role.ADMIN
    assert EngineChannelSet.objects.filter(organisation_id=owner.organisation_id).count() > chan_before

    # Delete Bob (`Membership.State.REMOVED`), then re-provision WITHOUT explicit admin role -> resets to `org_member`!
    assert (
        client.delete(
            f"/api/v1/ee/scim/v2/tenants/scim-s4/Users/{bob_scim_id}",
            headers=scim_hdr,
        ).status_code
        == 204
    )
    bob_memb.refresh_from_db()
    assert bob_memb.state == Membership.State.REMOVED

    r_reprov_bob = client.post(
        "/api/v1/ee/scim/v2/tenants/scim-s4/Users",
        data=json.dumps(
            {
                "schemas": [SCIM_USER_SCHEMA],
                "userName": "bob.renamed@scim-s4.fr",
                "displayName": "Bob Rejoined",
                "active": True,
            }
        ),
        content_type="application/scim+json",
        headers=scim_hdr,
    )
    assert r_reprov_bob.status_code == 201
    bob_memb.refresh_from_db()
    assert bob_memb.state == Membership.State.ACTIVE
    assert bob_memb.role == Membership.Role.MEMBER

    # Revoke SCIM token via authenticated `DELETE .../Tokens/<id>` -> subsequent SCIM call gets 401!
    assert (
        client.delete(
            f"/api/v1/ee/scim/v2/tenants/scim-s4/Tokens/{scim_tok_id}",
            headers=owner.headers,
        ).status_code
        == 204
    )
    assert (
        client.get("/api/v1/ee/scim/v2/tenants/scim-s4/Users", headers=scim_hdr).status_code == 401
    )


def test_bug_0054_0055_0056_audit_hmac_redaction_ingestion_erasure_and_pagination(
    monkeypatch: pytest.MonkeyPatch,
    tenant_principal_factory: Callable[..., ProvisionedTestPrincipal],
) -> None:
    from apps.audit.models import AuditEvent
    from apps.orgs.account_erasure_services import (
        AccountAbsenceProof,
        AccountErasureAdapter,
        AccountErasureScope,
        advance_account_erasure,
        begin_account_erasure,
    )
    from apps.orgs.erasure_services import database_now
    from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
    from test_core_erasure import operator

    from services.identity.trusted_issuers import verify_configured_token

    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    owner = tenant_principal_factory("audit-s4", role="org_owner", email="owner@audit-s4.fr")
    second_owner = tenant_principal_factory(
        "audit-s4", role="org_owner", email="victim.erase@audit-s4.fr"
    )
    client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")

    # 1. `BUG-0055` & `BUG-0056` ingestion guards:
    #    - Email-bearing or whitespace `target_urn` rejected with `400 invalid_target_urn`
    #    - Metadata > 32 KiB rejected with `400 invalid_metadata`
    #    - `source_ip` truncated to `/24` BEFORE storage in `ee_audit_ledger`
    for bad_urn in ("urn:kodera:user:alice@audit-s4.fr", "free text urn", "http://example.com"):
        r_bad_urn = client.post(
            "/api/v1/ee/compliance/audit-exports/events",
            data=json.dumps({"action": "user.invited", "target_urn": bad_urn}),
            content_type="application/json",
            headers=owner.headers,
        )
        assert r_bad_urn.status_code == 400
        assert r_bad_urn.json()["code"] == "invalid_target_urn"

    r_huge = client.post(
        "/api/v1/ee/compliance/audit-exports/events",
        data=json.dumps(
            {
                "action": "doc.exported",
                "target_urn": "urn:kodera:doc:1",
                "metadata": {"blob": "x" * (MAX_EVENT_METADATA_BYTES + 128)},
            }
        ),
        content_type="application/json",
        headers=owner.headers,
    )
    assert r_huge.status_code == 400
    assert r_huge.json()["code"] == "invalid_metadata"

    r_ing = client.post(
        "/api/v1/ee/compliance/audit-exports/events",
        data=json.dumps(
            {
                "action": "member.profile.updated",
                "target_urn": f"urn:kodera:user:{second_owner.user_id}",
                "metadata": {
                    "email": second_owner.email,
                    "display_name": "Alice @ Finance",
                    "given_name": "Alice",
                    "family_name": "Dupont",
                    "username": "adupont",
                },
            }
        ),
        content_type="application/json",
        REMOTE_ADDR="198.51.100.77",
        headers=owner.headers,
    )
    assert r_ing.status_code == 201, r_ing.content
    with connection.cursor() as cur:
        cur.execute(
            "SELECT source_ip, user_id FROM public.ee_audit_ledger WHERE organisation_id = %s",
            [owner.organisation_id],
        )
        stored_ip, stored_uid = cur.fetchone()
    assert stored_ip == "198.51.100.0/24"
    assert stored_uid == owner.user_id

    # 2. `BUG-0054`: Keyed HMAC-SHA256 redaction (`given_name`, `family_name`, `username`,
    #    `"Alice @ Finance"`, and `target_urn` email fallback) depends on secret seed!
    with override_settings(
        KODERA_EDITION="enterprise",
        KODERA_EE_AUDIT_SIGNING_SEED="seed-alpha-0123456789abcdef0123456789abcdef",
    ):
        b1 = export_compliance_bundle(
            ledger=default_audit_ledger,
            signer=default_audit_ledger.ed25519_signer_for_tenant("audit-s4"),
            tenant_slug="audit-s4",
            organisation_id=owner.organisation_id,
            export_format="ndjson",
            framework="SOC2",
            redact_pii=True,
        )
    with override_settings(
        KODERA_EDITION="enterprise",
        KODERA_EE_AUDIT_SIGNING_SEED="seed-bravo-fedcba9876543210fedcba9876543210",
    ):
        b2 = export_compliance_bundle(
            ledger=default_audit_ledger,
            signer=default_audit_ledger.ed25519_signer_for_tenant("audit-s4"),
            tenant_slug="audit-s4",
            organisation_id=owner.organisation_id,
            export_format="ndjson",
            framework="SOC2",
            redact_pii=True,
        )
    p1 = b1.payload_bytes.decode("utf-8")
    p2 = b2.payload_bytes.decode("utf-8")
    for forbidden_cleartext in (
        second_owner.email,
        "Alice @ Finance",
        '"Alice"',
        '"Dupont"',
        '"adupont"',
        "198.51.100.77",
        hashlib.sha256(f"audit-s4:{second_owner.email}".encode()).hexdigest()[:16],
    ):
        assert forbidden_cleartext not in p1
    assert p1 != p2, "HMAC redaction pseudonyms must depend on KODERA_EE_AUDIT_SIGNING_SEED!"

    # 3. `BUG-0056`: Cursor pagination (`limit` + `after_seq`), `413` ceiling, and `429` rate limit!
    for idx in range(3):
        default_audit_ledger.append_event(
            tenant_slug="audit-s4",
            organisation_id=owner.organisation_id,
            actor_type="system",
            actor_id="system",
            action=f"batch.step.{idx}",
            target_urn=f"urn:kodera:job:{idx}",
        )

    page1 = client.post(
        "/api/v1/ee/compliance/audit-exports",
        data=json.dumps({"tenant_slug": "audit-s4", "limit": 2}),
        content_type="application/json",
        headers=owner.headers,
    )
    assert page1.status_code == 200
    assert page1.json()["has_more"] is True
    next_cursor = int(page1.json()["next_after_seq"])

    page2 = client.post(
        "/api/v1/ee/compliance/audit-exports",
        data=json.dumps({"tenant_slug": "audit-s4", "limit": 10, "after_seq": next_cursor}),
        content_type="application/json",
        headers=owner.headers,
    )
    assert page2.status_code == 200
    assert page2.json()["has_more"] is False
    assert page2.json()["manifest"]["record_count"] == 2

    # Unpaginated export exceeding `max_rows` returns `413 export_limit_exceeded`
    monkeypatch.setattr("ee.audit_export.exporter.MAX_EXPORT_ROWS", 2)
    r_413 = client.post(
        "/api/v1/ee/compliance/audit-exports",
        data=json.dumps({"tenant_slug": "audit-s4"}),
        content_type="application/json",
        headers=owner.headers,
    )
    assert r_413.status_code == 413
    assert r_413.json()["code"] == "export_limit_exceeded"
    monkeypatch.setattr("ee.audit_export.exporter.MAX_EXPORT_ROWS", MAX_EXPORT_ROWS)

    # Exhaust rolling-minute rate limit -> `429 rate_limit_exceeded` with `Retry-After: 60`
    for _ in range(30):
        default_audit_ledger.check_export_rate_limit("audit-s4")
    r_429 = client.post(
        "/api/v1/ee/compliance/audit-exports",
        data=json.dumps({"tenant_slug": "audit-s4", "limit": 1}),
        content_type="application/json",
        headers=owner.headers,
    )
    assert r_429.status_code == 429
    assert r_429["Retry-After"] == "60"
    default_audit_ledger._export_rate_windows.clear()

    # 4. `BUG-0055` end-to-end PostgreSQL test of `sync_from_django_audit` + `0035` SQL migration!
    AuditEvent.objects.create(
        action="workspace.member_updated",
        actor_type="tenant",
        actor_id=second_owner.identity_id,
        actor_label=second_owner.email,
        organisation_id=owner.organisation_id,
        target_urn=f"urn:kodera:user:{second_owner.user_id}",
        retention_class="standard",
        metadata={"note": f"Self update by {second_owner.email}"},
    )
    synced_count = default_audit_ledger.sync_from_django_audit(
        organisation_id=owner.organisation_id,
        tenant_slug="audit-s4",
    )
    assert synced_count >= 1
    with connection.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM public.ee_audit_ledger WHERE user_id = %s",
            [second_owner.user_id],
        )
        assert cur.fetchone()[0] >= 1

    # Apply `EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL`, verify clean reverse when empty,
    # re-apply `FORWARD`, run `begin_account_erasure` + `advance_account_erasure` on `second_owner`,
    # and assert BOTH actor-owned (`user_id = second_owner.user_id`) AND subject-referenced
    # (`r_ing` acted by `owner.user_id` whose `metadata` had `second_owner.email`!) are scrubbed!
    class _StubAccAdapter:
        revision = "audit-s4-acc-stub"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
            return AccountAbsenceProof(
                scope.request_id,
                scope.user_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "a" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
            return proof.evidence_sha256 == "a" * 64

    with transaction.atomic(), connection.cursor() as cur:
        cur.execute(EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL)
        cur.execute(EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL)
        cur.execute(EE_AUDIT_ERASURE_MIGRATION_0035_FORWARD_SQL)

    try:
        staff_op = operator()
        now_epoch = int(database_now().timestamp())
        verified_raw, _ = verify_configured_token(
            second_owner.token,
            trusted=settings.KODERA_AUTH_TRUST,
        )
        verified_victim = replace(verified_raw, auth_time=now_epoch, expires_at=now_epoch + 600)
        erasure_req = begin_account_erasure(
            verified=verified_victim,
            confirmation="delete",
            instruction_ref="DEL-5501",
            instruction_sha256="9" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_op.id,
        )
        assert len(erasure_req.inventory["ee_audit_scrub_ids"]) >= 2

        adapters: dict[str, AccountErasureAdapter] = {
            str(d): (
                PassportAccountOutboxErasureAdapter()
                if d == "account_message_outbox"
                else _StubAccAdapter(str(d))
            )
            for d in erasure_req.inventory["required_domains"]
        }
        done = advance_account_erasure(erasure_req.id, adapters)
        assert done["complete"] is True

        with connection.cursor() as cur:
            cur.execute(
                "SELECT metadata_json, actor_label, pii_scrubbed_at IS NOT NULL "
                "FROM public.ee_audit_ledger WHERE organisation_id = %s",
                [owner.organisation_id],
            )
            ledger_rows = cur.fetchall()

        for meta_txt, actor_lbl, is_scrubbed in ledger_rows:
            assert second_owner.email not in meta_txt
            assert second_owner.email not in actor_lbl
            if str(second_owner.user_id) in actor_lbl:
                assert actor_lbl == f"erased:{second_owner.user_id}"
                assert is_scrubbed is True

        # Hash chain integrity remains 100% valid after GDPR Art. 17 scrubbing!
        ok_chain, chain_errs = default_audit_ledger.verify_vault_integrity("audit-s4")
        assert ok_chain is True and chain_errs == []

        # Reverse migration refuses downgrade while admitted obligations exist (`23514`)!
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
            cur.execute(EE_AUDIT_ERASURE_MIGRATION_0035_REVERSE_SQL)

        # Syncing a newly discovered pre-cutoff historical `AuditEvent` for the already-erased
        # `second_owner` ingests in pre-scrubbed form instead of raising `account_cutoff_fenced`!
        AuditEvent.objects.create(
            action="workspace.legacy_event",
            actor_type="tenant",
            actor_id=second_owner.identity_id,
            actor_label="victim.erase@audit-s4.fr",
            organisation_id=owner.organisation_id,
            target_urn="urn:kodera:workspace:legacy",
            retention_class="standard",
            metadata={"legacy_email": "victim.erase@audit-s4.fr"},
        )
        added_post = default_audit_ledger.sync_from_django_audit(
            organisation_id=owner.organisation_id,
            tenant_slug="audit-s4",
        )
        assert added_post >= 1
        legacy_evts = [
            e
            for e in default_audit_ledger.snapshot_events(
                "audit-s4", organisation_id=owner.organisation_id
            )
            if e.action == "workspace.legacy_event"
        ]
        assert len(legacy_evts) == 1
        assert legacy_evts[0].actor_label == f"erased:{second_owner.user_id}"
        assert legacy_evts[0].metadata == {}
    finally:
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute(EE_AUDIT_ERASURE_RESTORE_0032_GUARDS_SQL)
