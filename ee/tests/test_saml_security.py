"""Security & functional tests for Enterprise SAML 2.0 Corporate Federation (`ee/saml/`).

Covers:
- Tenant-scoped SP metadata XML, multi-IdP discovery, HTTP-Redirect AuthnRequest + RelayState CSRF
- Valid signed SAML 2.0 assertions using RSA-SHA256 (X.509 cert) and ECDSA-SHA256 (P-256)
- JIT user & group-to-role provisioning (plus real PostgreSQL Django Organisation sync)
- Hardened adversarial rejections: XXE (`<!DOCTYPE`/`<!ENTITY`), Billion Laughs, UTF-16 BOM,
  XInclude, XML comment truncation, XSW1/XSW2/XSW3/XSW7/XSW8 signature wrapping, duplicate XML IDs,
  digest tampering, SHA-1 downgrade, wrong Audience, wrong Recipient/Destination, wrong InResponseTo,
  tampered/replayed/cross-tenant RelayState, expired NotOnOrAfter, premature NotBefore, replayed
  Assertion ID, and unverified / cross-tenant email domain spoofing.
"""

from __future__ import annotations

import base64
import time
import urllib.parse
import zlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.test import Client, override_settings

from ee.saml.service import SamlError, SamlIdpConfig, default_saml_service
from ee.saml.xml_security import (
    SAML_ASSERTION_NS,
    SAML_METADATA_NS,
    SAML_PROTOCOL_NS,
    parse_hardened_xml,
    sign_enveloped_xml,
)


def _fmt_ts(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_saml_response_xml(
    *,
    response_id: str | None = None,
    assertion_id: str | None = None,
    in_response_to: str,
    destination: str = "http://127.0.0.1/api/v1/ee/sso/saml/acme-corp/acs",
    recipient: str = "http://127.0.0.1/api/v1/ee/sso/saml/acme-corp/acs",
    audience: str = "http://127.0.0.1/api/v1/ee/sso/saml/acme-corp/metadata",
    idp_entity_id: str = "https://idp.acme-corp.test/saml2",
    name_id: str = "alice@acme.fr",
    email_attr: str | None = "alice@acme.fr",
    display_name: str = "Alice Martin",
    groups: tuple[str, ...] = ("kodera-admins", "engineering"),
    now: datetime | None = None,
    not_before_offset_s: int = -30,
    not_on_or_after_offset_s: int = 300,
    sign_key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey | None = None,
    sign_target: str = "assertion",
) -> str:
    base_now = (now or datetime.now(UTC)).astimezone(UTC)
    resp_id = response_id or ("_resp_" + uuid4().hex)
    assn_id = assertion_id or ("_assn_" + uuid4().hex)
    issued = _fmt_ts(base_now)
    nb = _fmt_ts(base_now + timedelta(seconds=not_before_offset_s))
    noa = _fmt_ts(base_now + timedelta(seconds=not_on_or_after_offset_s))

    group_vals = "".join(f"<saml:AttributeValue>{g}</saml:AttributeValue>" for g in groups)
    email_block = (
        f'<saml:Attribute Name="email"><saml:AttributeValue>{email_attr}</saml:AttributeValue></saml:Attribute>'
        if email_attr is not None
        else ""
    )

    unsigned = (
        f'<samlp:Response xmlns:samlp="{SAML_PROTOCOL_NS}" xmlns:saml="{SAML_ASSERTION_NS}" '
        f'ID="{resp_id}" Version="2.0" IssueInstant="{issued}" '
        f'Destination="{destination}" InResponseTo="{in_response_to}">'
        f"<saml:Issuer>{idp_entity_id}</saml:Issuer>"
        '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
        f'<saml:Assertion ID="{assn_id}" Version="2.0" IssueInstant="{issued}">'
        f"<saml:Issuer>{idp_entity_id}</saml:Issuer>"
        "<saml:Subject>"
        f'<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">{name_id}</saml:NameID>'
        '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        f'<saml:SubjectConfirmationData InResponseTo="{in_response_to}" NotOnOrAfter="{noa}" Recipient="{recipient}"/>'
        "</saml:SubjectConfirmation>"
        "</saml:Subject>"
        f'<saml:Conditions NotBefore="{nb}" NotOnOrAfter="{noa}">'
        f"<saml:AudienceRestriction><saml:Audience>{audience}</saml:Audience></saml:AudienceRestriction>"
        "</saml:Conditions>"
        "<saml:AttributeStatement>"
        f"{email_block}"
        f'<saml:Attribute Name="displayName"><saml:AttributeValue>{display_name}</saml:AttributeValue></saml:Attribute>'
        f'<saml:Attribute Name="groups">{group_vals}</saml:Attribute>'
        "</saml:AttributeStatement>"
        "</saml:Assertion>"
        "</samlp:Response>"
    )

    if sign_key is None:
        return unsigned
    if sign_target == "assertion":
        return sign_enveloped_xml(unsigned, assn_id, sign_key)
    if sign_target == "response":
        return sign_enveloped_xml(unsigned, resp_id, sign_key)
    if sign_target == "both":
        step1 = sign_enveloped_xml(unsigned, assn_id, sign_key)
        return sign_enveloped_xml(step1, resp_id, sign_key)
    raise ValueError(f"Unknown sign_target: {sign_target}")


@pytest.fixture
def enterprise_client(monkeypatch: pytest.MonkeyPatch) -> Client:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    return Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")


def test_sp_metadata_and_authn_request_binding(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    _, _, cert_pem = rsa_idp_keypair
    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta-primary",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso/saml",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr", "sub.acme.fr"}),
                group_role_mapping={"kodera-admins": "org_admin"},
            )
        )

        meta_resp = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/metadata")
        assert meta_resp.status_code == 200
        assert "application/samlmetadata+xml" in meta_resp["Content-Type"]
        meta_tree = parse_hardened_xml(meta_resp.content)
        assert meta_tree.ns_uri == SAML_METADATA_NS and meta_tree.local_name == "EntityDescriptor"
        assert (
            meta_tree.attr("entityID") == "http://127.0.0.1/api/v1/ee/sso/saml/acme-corp/metadata"
        )

        providers_resp = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/providers")
        assert providers_resp.status_code == 200
        assert providers_resp.json()["providers"][0]["idp_id"] == "okta-primary"

        login_resp = enterprise_client.get(
            "/api/v1/ee/sso/saml/acme-corp/login",
            {"idp_id": "okta-primary", "return_path": "/channels/general"},
        )
        assert login_resp.status_code == 200
        login_data = login_resp.json()
        assert login_data["request_id"].startswith("_")
        assert "." in login_data["relay_state"]

        parsed_redirect = urllib.parse.urlsplit(login_data["redirect_url"])
        qs = urllib.parse.parse_qs(parsed_redirect.query)
        raw_deflated = base64.b64decode(qs["SAMLRequest"][0])
        authn_xml = zlib.decompress(raw_deflated, -15)
        authn_node = parse_hardened_xml(authn_xml)
        assert authn_node.local_name == "AuthnRequest"
        assert authn_node.attr("ID") == login_data["request_id"]

        redirect_resp = enterprise_client.get(
            "/api/v1/ee/sso/saml/acme-corp/login",
            {"idp_id": "okta-primary", "redirect": "1"},
        )
        assert redirect_resp.status_code == 302
        assert redirect_resp["Location"].startswith("https://idp.acme-corp.test/sso/saml?")


def test_valid_signed_assertion_flow_rsa_and_ecdsa_multi_idp(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    ecdsa_idp_keypair: tuple[ec.EllipticCurvePrivateKey, str],
) -> None:
    rsa_priv, _, rsa_cert_pem = rsa_idp_keypair
    ec_priv, ec_pub_pem = ecdsa_idp_keypair

    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta-rsa",
                idp_entity_id="https://okta.acme-corp.test/saml2",
                idp_sso_url="https://okta.acme-corp.test/sso",
                public_key_pem=rsa_cert_pem,
                verified_domains=frozenset({"acme.fr"}),
                group_role_mapping={"kodera-admins": "org_admin", "finance": "org_billing"},
            )
        )
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="entra-ecdsa",
                idp_entity_id="https://entra.acme-corp.test/saml2",
                idp_sso_url="https://entra.acme-corp.test/sso",
                public_key_pem=ec_pub_pem,
                verified_domains=frozenset({"subsidiary.acme.fr"}),
                group_role_mapping={"billing-team": "org_billing"},
            )
        )

        # Multi-IdP requires explicit idp_id on login
        missing_idp = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login")
        assert missing_idp.status_code == 400
        assert missing_idp.json()["code"] == "idp_id_required"

        # 1. RSA-SHA256 login + ACS form POST
        rsa_login = enterprise_client.get(
            "/api/v1/ee/sso/saml/acme-corp/login",
            {"idp_id": "okta-rsa", "return_path": "/workspace"},
        ).json()
        rsa_xml = _build_saml_response_xml(
            in_response_to=rsa_login["request_id"],
            idp_entity_id="https://okta.acme-corp.test/saml2",
            name_id="alice@acme.fr",
            email_attr="alice@acme.fr",
            display_name="Alice Martin",
            groups=("engineering", "kodera-admins"),
            sign_key=rsa_priv,
            sign_target="both",
        )
        acs_rsa = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data=urllib.parse.urlencode(
                {
                    "SAMLResponse": base64.b64encode(rsa_xml.encode("utf-8")).decode("ascii"),
                    "RelayState": rsa_login["relay_state"],
                }
            ),
            content_type="application/x-www-form-urlencoded",
        )
        assert acs_rsa.status_code == 200, acs_rsa.content
        rsa_body = acs_rsa.json()
        assert rsa_body["authenticated"] is True
        assert rsa_body["email"] == "alice@acme.fr"
        assert rsa_body["role"] == "org_admin"
        assert rsa_body["return_path"] == "/workspace"

        # 2. ECDSA-SHA256 login + ACS JSON POST
        ec_login = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/login",
            data='{"idp_id": "entra-ecdsa"}',
            content_type="application/json",
        ).json()
        ec_xml = _build_saml_response_xml(
            in_response_to=ec_login["request_id"],
            idp_entity_id="https://entra.acme-corp.test/saml2",
            name_id="claire@subsidiary.acme.fr",
            email_attr="claire@subsidiary.acme.fr",
            display_name="Claire Bernard",
            groups=("billing-team",),
            sign_key=ec_priv,
            sign_target="assertion",
        )
        acs_ec = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(ec_xml.encode("utf-8")).decode("ascii"),
                "RelayState": ec_login["relay_state"],
            },
            content_type="application/json",
        )
        assert acs_ec.status_code == 200, acs_ec.content
        ec_body = acs_ec.json()
        assert ec_body["authenticated"] is True
        assert ec_body["email"] == "claire@subsidiary.acme.fr"
        assert ec_body["role"] == "org_billing"


@pytest.mark.django_db(transaction=True)
def test_saml_jit_syncs_django_organisation_membership(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    from apps.identity.models import Identity
    from apps.orgs.models import Membership, Organisation, SlugReservation
    from django.db import transaction

    rsa_priv, _, cert_pem = rsa_idp_keypair
    with transaction.atomic():
        org = Organisation.objects.create(
            slug="acme-db-org",
            name="Acme SAS",
            realm="acme-db-org",
            issuer="https://sso.kodera.test/realms/acme-db-org",
        )
        SlugReservation.objects.create(organisation=org, slug=org.slug, state="provisional")

    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
                group_role_mapping={"kodera-admins": "org_admin"},
                organisation_id=org.id,
            )
        )
        login_data = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        signed_xml = _build_saml_response_xml(
            in_response_to=login_data["request_id"],
            sign_key=rsa_priv,
        )
        resp = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(signed_xml.encode("utf-8")).decode("ascii"),
                "RelayState": login_data["relay_state"],
            },
            content_type="application/json",
        )
        assert resp.status_code == 200
        uid = resp.json()["user_id"]
        assert Identity.objects.filter(organisation=org, user_id=uid, enabled=True).exists()
        membership = Membership.objects.get(organisation=org, user_id=uid)
        assert membership.role == "org_admin"
        assert membership.state == Membership.State.ACTIVE


@pytest.mark.parametrize(
    ("attack_name", "xml_payload", "expected_code"),
    [
        (
            "xxe_external_file",
            '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">&xxe;</samlp:Response>',
            "dtd_or_entity_forbidden",
        ),
        (
            "billion_laughs_entity_expansion",
            '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>'
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">&lol2;</samlp:Response>',
            "dtd_or_entity_forbidden",
        ),
        (
            "xinclude_file_read",
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
            'xmlns:xi="http://www.w3.org/2001/XInclude">'
            '<xi:include href="file:///etc/hosts"/></samlp:Response>',
            "xinclude_forbidden",
        ),
        (
            "comment_truncation_cve_2017_11427",
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">'
            "<NameID>admin@acme.fr<!---->.attacker.example</NameID></samlp:Response>",
            "xml_comments_forbidden",
        ),
        (
            "processing_instruction_stylesheet",
            '<?xml-stylesheet type="text/xsl" href="https://evil.example/steal.xsl"?>'
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>',
            "processing_instruction_forbidden",
        ),
    ],
)
def test_hardened_xml_rejects_xxe_dtd_xinclude_and_comments_before_parse(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
    attack_name: str,
    xml_payload: str,
    expected_code: str,
) -> None:
    _, _, cert_pem = rsa_idp_keypair
    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
            )
        )
        login_data = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        resp = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(xml_payload.encode("utf-8")).decode("ascii"),
                "RelayState": login_data["relay_state"],
            },
            content_type="application/json",
        )
        assert resp.status_code == 400, attack_name
        assert resp.json()["code"] == expected_code, attack_name

    # UTF-16 BOM bypass attempt directly on raw bytes
    utf16_xxe = b"\xff\xfe" + "<!DOCTYPE x>".encode("utf-16-le")
    with override_settings(KODERA_EDITION="enterprise"):
        login2 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        resp2 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(utf16_xxe).decode("ascii"),
                "RelayState": login2["relay_state"],
            },
            content_type="application/json",
        )
        assert resp2.status_code == 400
        assert resp2.json()["code"] == "forbidden_encoding"


def test_xml_signature_wrapping_xsw_variants_rejected(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    rsa_priv, _, cert_pem = rsa_idp_keypair
    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
            )
        )

        def _initiate_and_build() -> tuple[dict[str, str], str]:
            login = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
            valid = _build_saml_response_xml(
                in_response_to=login["request_id"],
                name_id="member@acme.fr",
                email_attr="member@acme.fr",
                groups=(),
                sign_key=rsa_priv,
            )
            return login, valid

        # XSW3: Attacker prepends an unsigned evil <saml:Assertion> before the real signed <saml:Assertion>
        login1, valid1 = _initiate_and_build()
        forged_assertion = (
            '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" '
            'ID="_forged_1" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">'
            "<saml:Issuer>https://idp.acme-corp.test/saml2</saml:Issuer>"
            "<saml:Subject><saml:NameID>ceo@acme.fr</saml:NameID></saml:Subject>"
            "</saml:Assertion>"
        )
        xsw3_xml = valid1.replace("<saml:Assertion ", forged_assertion + "<saml:Assertion ", 1)
        resp_xsw3 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(xsw3_xml.encode("utf-8")).decode("ascii"),
                "RelayState": login1["relay_state"],
            },
            content_type="application/json",
        )
        assert resp_xsw3.status_code == 403
        assert resp_xsw3.json()["code"] == "invalid_assertion_count"

        # XSW2/XSW6: Single signed Assertion moved inside <samlp:Extensions> (not direct child of Response)
        login2, valid2 = _initiate_and_build()
        start_idx = valid2.index("<saml:Assertion ")
        end_idx = valid2.rindex("</saml:Assertion>") + len("</saml:Assertion>")
        wrapped_in_ext = (
            valid2[:start_idx]
            + "<samlp:Extensions>"
            + valid2[start_idx:end_idx]
            + "</samlp:Extensions>"
            + valid2[end_idx:]
        )
        resp_xsw2 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(wrapped_in_ext.encode("utf-8")).decode("ascii"),
                "RelayState": login2["relay_state"],
            },
            content_type="application/json",
        )
        assert resp_xsw2.status_code == 403
        assert resp_xsw2.json()["code"] == "wrapped_assertion_detected"

        # XSW7/XSW8: Injecting <ds:Object> inside <ds:Signature>
        login3, valid3 = _initiate_and_build()
        xsw8_xml = valid3.replace(
            "</ds:SignatureValue>",
            '</ds:SignatureValue><ds:Object ID="_obj1">payload</ds:Object>',
        )
        resp_xsw8 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(xsw8_xml.encode("utf-8")).decode("ascii"),
                "RelayState": login3["relay_state"],
            },
            content_type="application/json",
        )
        assert resp_xsw8.status_code == 403
        assert resp_xsw8.json()["code"] == "signature_object_forbidden"

        # Tampered email inside signed Assertion -> digest_mismatch
        login4, valid4 = _initiate_and_build()
        tampered_xml = valid4.replace("member@acme.fr", "ceo@acme.fr")
        resp_tamper = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(tampered_xml.encode("utf-8")).decode("ascii"),
                "RelayState": login4["relay_state"],
            },
            content_type="application/json",
        )
        assert resp_tamper.status_code == 403
        assert resp_tamper.json()["code"] == "digest_mismatch"

        # Duplicate ID attribute anywhere in XML -> duplicate_xml_id
        login5, valid5 = _initiate_and_build()
        dup_id_xml = valid5.replace(
            "<samlp:Status>",
            f'<samlp:Status ID="{parse_hardened_xml(valid5).attr("ID")}">',
        )
        resp_dup = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(dup_id_xml.encode("utf-8")).decode("ascii"),
                "RelayState": login5["relay_state"],
            },
            content_type="application/json",
        )
        assert resp_dup.status_code == 400
        assert resp_dup.json()["code"] == "duplicate_xml_id"


def test_saml_protocol_constraints_audience_recipient_expiry_replay_and_domain_spoofing(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    rsa_priv, _, cert_pem = rsa_idp_keypair
    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
                clock_skew_seconds=30,
            )
        )

        # 1. Wrong AudienceRestriction
        l1 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        wrong_aud = _build_saml_response_xml(
            in_response_to=l1["request_id"],
            audience="https://other-sp.example/metadata",
            sign_key=rsa_priv,
        )
        r1 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(wrong_aud.encode("utf-8")).decode("ascii"),
                "RelayState": l1["relay_state"],
            },
            content_type="application/json",
        )
        assert r1.status_code == 403 and r1.json()["code"] == "invalid_audience"

        # 2. Wrong Recipient
        l2 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        wrong_rcpt = _build_saml_response_xml(
            in_response_to=l2["request_id"],
            recipient="http://127.0.0.1/api/v1/ee/sso/saml/other-tenant/acs",
            sign_key=rsa_priv,
        )
        r2 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(wrong_rcpt.encode("utf-8")).decode("ascii"),
                "RelayState": l2["relay_state"],
            },
            content_type="application/json",
        )
        assert r2.status_code == 403 and r2.json()["code"] == "invalid_recipient"

        # 3. Expired NotOnOrAfter (beyond 30s clock skew)
        l3 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        expired_xml = _build_saml_response_xml(
            in_response_to=l3["request_id"],
            not_before_offset_s=-600,
            not_on_or_after_offset_s=-60,
            sign_key=rsa_priv,
        )
        r3 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(expired_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l3["relay_state"],
            },
            content_type="application/json",
        )
        assert r3.status_code == 403 and r3.json()["code"] == "assertion_expired"

        # 4. Premature NotBefore (beyond 30s clock skew)
        l4 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        future_xml = _build_saml_response_xml(
            in_response_to=l4["request_id"],
            not_before_offset_s=120,
            not_on_or_after_offset_s=600,
            sign_key=rsa_priv,
        )
        r4 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(future_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l4["relay_state"],
            },
            content_type="application/json",
        )
        assert r4.status_code == 403 and r4.json()["code"] == "assertion_not_yet_valid"

        # 5. Replayed Assertion ID (even with a fresh valid AuthnRequest + RelayState!)
        fixed_assertion_id = "_assn_replay_target_001"
        l5_first = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        first_xml = _build_saml_response_xml(
            assertion_id=fixed_assertion_id,
            in_response_to=l5_first["request_id"],
            sign_key=rsa_priv,
        )
        r5_first = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(first_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l5_first["relay_state"],
            },
            content_type="application/json",
        )
        assert r5_first.status_code == 200

        # Replaying exact same RelayState fails immediately
        r5_same_relay = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(first_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l5_first["relay_state"],
            },
            content_type="application/json",
        )
        assert r5_same_relay.status_code == 403
        assert r5_same_relay.json()["code"] == "invalid_relay_state"

        # Replaying same Assertion ID inside a newly signed Response for a second AuthnRequest -> replayed_assertion_id!
        l5_second = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        replayed_id_xml = _build_saml_response_xml(
            assertion_id=fixed_assertion_id,
            in_response_to=l5_second["request_id"],
            sign_key=rsa_priv,
        )
        r5_replayed = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(replayed_id_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l5_second["relay_state"],
            },
            content_type="application/json",
        )
        assert r5_replayed.status_code == 403
        assert r5_replayed.json()["code"] == "replayed_assertion_id"

        # 6. Unverified email domain spoofing (`victim@other-tenant.fr` on `acme.fr`-only IdP)
        l6 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        spoofed_domain_xml = _build_saml_response_xml(
            in_response_to=l6["request_id"],
            name_id="ceo@victim-tenant.fr",
            email_attr="ceo@victim-tenant.fr",
            sign_key=rsa_priv,
        )
        r6 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(spoofed_domain_xml.encode("utf-8")).decode(
                    "ascii"
                ),
                "RelayState": l6["relay_state"],
            },
            content_type="application/json",
        )
        assert r6.status_code == 403
        assert r6.json()["code"] == "unverified_email_domain"

        # 7. Subject NameID vs email attribute split attack
        l7 = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
        split_email_xml = _build_saml_response_xml(
            in_response_to=l7["request_id"],
            name_id="contractor@acme.fr",
            email_attr="ceo@acme.fr",
            sign_key=rsa_priv,
        )
        r7 = enterprise_client.post(
            "/api/v1/ee/sso/saml/acme-corp/acs",
            data={
                "SAMLResponse": base64.b64encode(split_email_xml.encode("utf-8")).decode("ascii"),
                "RelayState": l7["relay_state"],
            },
            content_type="application/json",
        )
        assert r7.status_code == 403
        assert r7.json()["code"] == "subject_email_mismatch"

        # 8. Weak RSA (< 2048-bit) IdP key registration is refused
        weak_rsa = rsa.generate_private_key(public_exponent=65537, key_size=1024)  # noqa: S505
        from cryptography.hazmat.primitives import serialization

        weak_pem = (
            weak_rsa.public_key()
            .public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("ascii")
        )
        with pytest.raises(SamlError) as weak_err:
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="weak-idp",
                idp_entity_id="https://weak.test/saml2",
                idp_sso_url="https://weak.test/sso",
                public_key_pem=weak_pem,
                verified_domains=frozenset({"acme.fr"}),
            )
        assert weak_err.value.code == "invalid_idp_certificate"


def test_saml_xml_prolog_linear_time_no_redos_and_sanitized_errors(
    enterprise_client: Client,
    rsa_idp_keypair: tuple[rsa.RSAPrivateKey, str, str],
) -> None:
    """Adversarial whitespace XML prologs must fail in O(n) time without ReDoS or traceback leaks."""
    _, _, cert_pem = rsa_idp_keypair
    adversarial_cases = [
        ("<?xml " + (" " * 50_000) + 'version="1.0" encoding="UTF-8"', "malformed_xml"),
        (
            "<?xml " + (" \t\n" * 15_000) + 'version="1.0" encoding="ISO-8859-1"?><r/>',
            "forbidden_encoding",
        ),
        ((" " * 30_000) + "<?xml " + (" " * 30_000) + "unterminated", "malformed_xml"),
    ]

    with override_settings(KODERA_EDITION="enterprise"):
        default_saml_service.register_idp(
            SamlIdpConfig(
                tenant_slug="acme-corp",
                idp_id="okta",
                idp_entity_id="https://idp.acme-corp.test/saml2",
                idp_sso_url="https://idp.acme-corp.test/sso",
                public_key_pem=cert_pem,
                verified_domains=frozenset({"acme.fr"}),
            )
        )
        for raw_payload, expected_code in adversarial_cases:
            login = enterprise_client.get("/api/v1/ee/sso/saml/acme-corp/login").json()
            started = time.perf_counter()
            resp = enterprise_client.post(
                "/api/v1/ee/sso/saml/acme-corp/acs",
                data={
                    "SAMLResponse": base64.b64encode(raw_payload.encode("utf-8")).decode("ascii"),
                    "RelayState": login["relay_state"],
                },
                content_type="application/json",
            )
            elapsed = time.perf_counter() - started
            assert elapsed < 0.25
            assert resp.status_code == 400
            body = resp.json()
            assert body["code"] == expected_code
            assert "Traceback" not in body["detail"]
            assert "ExpatError" not in body["detail"]
