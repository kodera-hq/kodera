"""HTTP views for Enterprise SAML 2.0 Federation (`/api/v1/ee/sso/saml/*`).

Security invariants (`W2-1`):
- Public SAML 2.0 protocol endpoints are strictly limited to SP metadata (`GET .../metadata`),
  SP-initiated login redirect (`GET`/`POST .../login`), and IdP-signed Assertion Consumer Service
  (`POST .../acs`, which verifies cryptographic RSA-SHA256 / ECDSA-SHA256 signatures against the
  tenant's pre-registered IdP certificate + single-use `RelayState` + replay cache).
- Tenant IdP administration & inspection (`GET`/`POST .../providers`) requires a verified Kodera
  customer Bearer token with active `org_owner` or `org_admin` membership for `tenant_slug` (`401`
  anonymous, `403` cross-tenant or insufficient role).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
from typing import Final
from urllib.parse import parse_qs

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from ee.auth import ADMIN_ROLES, EeAuthError, authenticate_tenant_request
from ee.saml.service import SamlError, SamlIdpConfig, default_saml_service

_SAML_PUBLIC_ERRORS: Final[tuple[tuple[str, int, str], ...]] = (
    # Authentication & tenant admin authorization rejections (401 / 403)
    ("unauthenticated", 401, "Authentication required"),
    ("forbidden_lane", 403, "Customer authentication lane required"),
    ("identity_unknown", 403, "Authenticated identity is not provisioned"),
    ("tenant_membership_required", 403, "Active tenant membership is required"),
    ("cross_tenant_forbidden", 403, "Cross-tenant SAML administration is forbidden"),
    ("insufficient_role", 403, "Organisation owner or admin role is required"),
    # XML pre-parse & structural security rejections (400)
    ("unexpected_child_element", 400, "SAML XML element contains forbidden child elements"),
    ("malformed_qname", 400, "Malformed XML qualified name"),
    ("xml_size_limit", 400, "SAML XML size is outside permitted bounds"),
    ("forbidden_encoding", 400, "Forbidden or non-UTF-8 XML encoding"),
    ("null_byte_forbidden", 400, "Null bytes are forbidden in SAML XML"),
    ("dtd_or_entity_forbidden", 400, "XML DTD and entity declarations are strictly forbidden"),
    ("invalid_utf8", 400, "SAML XML must be valid UTF-8"),
    ("processing_instruction_forbidden", 400, "XML processing instructions are forbidden"),
    ("xml_comments_forbidden", 400, "XML comments are forbidden in SAML payloads"),
    ("cdata_forbidden", 400, "CDATA sections are forbidden in SAML assertions"),
    ("unterminated_entity", 400, "Malformed ampersand or entity reference"),
    ("external_or_custom_entity_forbidden", 400, "Custom or external XML entity is forbidden"),
    ("invalid_char_ref", 400, "Invalid numeric character reference"),
    ("external_entity_forbidden", 400, "External entity resolution is forbidden"),
    ("xml_element_limit", 400, "XML exceeds maximum element count"),
    ("xml_depth_limit", 400, "XML exceeds maximum nesting depth"),
    ("invalid_xmlns", 400, "Invalid xmlns prefix declaration"),
    ("empty_xmlns_uri", 400, "Empty namespace URI on prefix"),
    ("xinclude_forbidden", 400, "XInclude elements and namespaces are forbidden"),
    ("unbound_prefix", 400, "Unbound XML element prefix"),
    ("unbound_attr_prefix", 400, "Unbound XML attribute prefix"),
    ("ambiguous_id_attribute", 400, "SAML elements must use exact ID attribute casing"),
    ("invalid_xml_id", 400, "Empty or invalid XML ID attribute"),
    ("duplicate_xml_id", 400, "Duplicate XML ID attribute detected across document"),
    ("malformed_xml", 400, "Malformed SAML XML document"),
    # Request & configuration errors (400 / 404)
    ("invalid_tenant_slug", 400, "Invalid tenant slug"),
    ("invalid_idp_id", 400, "Invalid Identity Provider identifier"),
    ("invalid_idp_entity_id", 400, "Invalid Identity Provider entityID"),
    ("invalid_idp_sso_url", 400, "Invalid Identity Provider SSO URL"),
    ("missing_verified_domains", 400, "Missing verified email domains"),
    ("invalid_verified_domain", 400, "Invalid verified email domain"),
    ("invalid_default_role", 400, "Unsupported default role"),
    ("invalid_group_mapping", 400, "Unsupported group role mapping"),
    ("invalid_clock_skew", 400, "Invalid SAML clock skew configuration"),
    ("invalid_idp_certificate", 400, "Invalid Identity Provider certificate or key"),
    ("invalid_sp_base_url", 400, "Invalid Service Provider base URL"),
    ("invalid_return_path", 400, "Invalid return path"),
    ("invalid_saml_response", 400, "Missing or oversized SAMLResponse payload"),
    ("invalid_base64_response", 400, "SAMLResponse is not valid base64"),
    ("unsupported_saml_version", 400, "SAML Version must be 2.0"),
    ("idp_not_found", 404, "SAML Identity Provider is not configured for tenant"),
    ("organisation_not_found", 404, "Bound organisation does not exist"),
    # Cryptographic signature & XSW rejections (403)
    ("key_algorithm_mismatch", 403, "SAML signature algorithm does not match IdP key"),
    ("invalid_signature", 403, "SAML cryptographic signature verification failed"),
    ("invalid_ecdsa_signature_length", 403, "Invalid ECDSA-SHA256 signature length"),
    ("unsupported_signature_algorithm", 403, "Unsupported or forbidden SAML signature algorithm"),
    ("missing_signed_element_id", 403, "Signed SAML element lacks an ID attribute"),
    ("signature_object_forbidden", 403, "ds:Object elements inside ds:Signature are forbidden"),
    ("malformed_signature", 403, "Malformed XMLDSig Signature structure"),
    ("malformed_signed_info", 403, "Malformed XMLDSig SignedInfo structure"),
    ("unsupported_c14n_algorithm", 403, "CanonicalizationMethod must be exc-c14n#"),
    ("reference_uri_mismatch", 403, "ds:Reference URI does not match parent element ID"),
    ("missing_transforms", 403, "ds:Reference lacks explicit Transforms"),
    ("invalid_transforms", 403, "Invalid ds:Transforms chain"),
    ("malformed_reference", 403, "Malformed ds:Reference element"),
    ("unsupported_digest_algorithm", 403, "DigestMethod must be SHA-256"),
    ("invalid_base64", 403, "Invalid base64 in DigestValue or SignatureValue"),
    ("digest_mismatch", 403, "Computed SHA-256 digest does not match DigestValue"),
    ("invalid_root_element", 403, "Root element must be samlp:Response"),
    ("encrypted_assertion_unsupported", 403, "EncryptedAssertion is not enabled"),
    ("invalid_assertion_count", 403, "SAML Response must contain exactly one Assertion"),
    ("wrapped_assertion_detected", 403, "SAML Assertion must be a direct child of Response"),
    ("multiple_signatures", 403, "Multiple Signature elements on single target are forbidden"),
    ("stray_signature_detected", 403, "Unexpected nested Signature element detected"),
    ("unsigned_assertion", 403, "SAML Assertion element must be signed"),
    ("missing_signature", 403, "SAML payload is unsigned"),
    # Protocol, RelayState CSRF, replay, & domain binding rejections (403)
    ("missing_timestamp", 403, "Missing required SAML timestamp"),
    ("malformed_timestamp", 403, "Malformed SAML UTC timestamp"),
    ("invalid_relay_state", 403, "Invalid, expired, or consumed SAML RelayState"),
    ("cross_tenant_relay_state", 403, "SAML RelayState belongs to a different tenant"),
    ("sp_origin_mismatch", 403, "Service Provider origin mismatch"),
    ("in_response_to_mismatch", 403, "SAML InResponseTo does not match pending AuthnRequest"),
    ("invalid_destination", 403, "SAML Response Destination mismatch"),
    ("saml_status_not_success", 403, "Identity Provider returned non-Success SAML Status"),
    ("issuer_mismatch", 403, "SAML Issuer does not match configured Identity Provider"),
    ("missing_assertion_issuer", 403, "SAML Assertion lacks Issuer"),
    ("missing_assertion_id", 403, "SAML Assertion lacks ID attribute"),
    ("missing_subject", 403, "SAML Assertion lacks Subject"),
    ("missing_name_id", 403, "SAML Subject lacks NameID"),
    ("empty_name_id", 403, "SAML Subject NameID is empty"),
    ("missing_bearer_confirmation", 403, "SAML Subject lacks bearer SubjectConfirmationData"),
    ("invalid_recipient", 403, "SAML SubjectConfirmationData Recipient mismatch"),
    ("assertion_expired", 403, "SAML Assertion validity window has expired"),
    ("assertion_not_yet_valid", 403, "SAML Assertion NotBefore is in the future"),
    ("missing_conditions", 403, "SAML Assertion lacks Conditions"),
    ("invalid_condition_window", 403, "Invalid SAML Conditions validity window"),
    ("missing_audience_restriction", 403, "SAML Conditions lacks AudienceRestriction"),
    ("invalid_audience", 403, "SAML AudienceRestriction does not authorize this Service Provider"),
    ("replayed_assertion_id", 403, "SAML Assertion ID has already been consumed"),
    ("ambiguous_email_attribute", 403, "Multiple email attribute values are forbidden"),
    ("subject_email_mismatch", 403, "Subject NameID email does not match email attribute"),
    ("missing_email_claim", 403, "SAML Assertion lacks an email claim"),
    ("invalid_email_claim", 403, "Malformed email address in SAML Assertion"),
    ("unverified_email_domain", 403, "Email domain is not verified for this tenant"),
)


def _json(payload: dict[str, object], *, status: int = 200) -> HttpResponse:
    resp = HttpResponse(
        json.dumps(payload).encode("utf-8"),
        status=status,
        content_type="application/json",
    )
    resp["Cache-Control"] = "no-store"
    if status == 401:
        resp["WWW-Authenticate"] = "Bearer"
    return resp


def _saml_error_response(error_code: str) -> HttpResponse:
    """Map domain error code to static constant HTTP status & message without exposing exception text."""
    for code_lit, status_lit, detail_lit in _SAML_PUBLIC_ERRORS:
        if error_code == code_lit:
            return _json({"detail": detail_lit, "code": code_lit}, status=status_lit)
    return _json({"detail": "SAML request rejected", "code": "saml_error"}, status=400)


def _sp_base_url(request: HttpRequest) -> str:
    configured = getattr(settings, "KODERA_SAML_SP_BASE_URL", None)
    if isinstance(configured, str) and configured.strip():
        return configured.strip().rstrip("/")
    scheme = "https" if request.is_secure() else "http"
    return f"{scheme}://{request.get_host()}"


def metadata_view(request: HttpRequest, tenant_slug: str) -> HttpResponse:
    """Serve SAML 2.0 Service Provider `EntityDescriptor` XML metadata for `tenant_slug`."""
    if request.method != "GET":
        resp = _json({"detail": "Method not allowed", "code": "method_not_allowed"}, status=405)
        resp["Allow"] = "GET"
        return resp
    try:
        xml_bytes = default_saml_service.build_sp_metadata_xml(tenant_slug, _sp_base_url(request))
    except SamlError as exc:
        return _saml_error_response(exc.code)
    resp = HttpResponse(
        xml_bytes,
        status=200,
        content_type="application/samlmetadata+xml; charset=utf-8",
    )
    resp["Cache-Control"] = "no-store"
    return resp


def providers_view(request: HttpRequest, tenant_slug: str) -> HttpResponse:
    """List or configure federated SAML 2.0 Identity Providers for authenticated tenant admins."""
    if request.method not in {"GET", "POST"}:
        resp = _json({"detail": "Method not allowed", "code": "method_not_allowed"}, status=405)
        resp["Allow"] = "GET, POST"
        return resp

    try:
        auth = authenticate_tenant_request(
            request,
            required_roles=ADMIN_ROLES,
            target_tenant_slug=tenant_slug,
        )
    except EeAuthError as exc:
        return _saml_error_response(exc.code)

    if request.method == "POST":
        if not request.body or len(request.body) > 65_536:
            return _json({"detail": "Invalid JSON body", "code": "invalid_json"}, status=400)
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return _json({"detail": "Invalid JSON body", "code": "invalid_json"}, status=400)
        if not isinstance(payload, dict):
            return _json({"detail": "JSON object expected", "code": "invalid_json"}, status=400)

        raw_idp_id = payload.get("idp_id")
        raw_entity_id = payload.get("idp_entity_id")
        raw_sso_url = payload.get("idp_sso_url")
        raw_pub_pem = payload.get("public_key_pem")
        raw_domains = payload.get("verified_domains")
        raw_mapping = payload.get("group_role_mapping", {})
        raw_default_role = payload.get("default_role", "org_member")

        if not isinstance(raw_idp_id, str):
            return _saml_error_response("invalid_idp_id")
        if not isinstance(raw_entity_id, str):
            return _saml_error_response("invalid_idp_entity_id")
        if not isinstance(raw_sso_url, str):
            return _saml_error_response("invalid_idp_sso_url")
        if not isinstance(raw_pub_pem, str):
            return _saml_error_response("invalid_idp_certificate")
        if not isinstance(raw_domains, list) or not all(isinstance(d, str) for d in raw_domains):
            return _saml_error_response("missing_verified_domains")
        if not isinstance(raw_mapping, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in raw_mapping.items()
        ):
            return _saml_error_response("invalid_group_mapping")
        if not isinstance(raw_default_role, str):
            return _saml_error_response("invalid_default_role")

        try:
            cfg = default_saml_service.register_idp(
                SamlIdpConfig(
                    tenant_slug=auth.tenant_slug,
                    idp_id=raw_idp_id.strip(),
                    idp_entity_id=raw_entity_id.strip(),
                    idp_sso_url=raw_sso_url.strip(),
                    public_key_pem=raw_pub_pem,
                    verified_domains=frozenset(raw_domains),
                    group_role_mapping=raw_mapping,
                    default_role=raw_default_role.strip(),
                    organisation_id=auth.organisation_id,
                )
            )
        except SamlError as exc:
            return _saml_error_response(exc.code)

        return _json(
            {
                "tenant_slug": cfg.tenant_slug,
                "idp_id": cfg.idp_id,
                "idp_entity_id": cfg.idp_entity_id,
                "idp_sso_url": cfg.idp_sso_url,
                "verified_domains": sorted(cfg.verified_domains),
            },
            status=201,
        )

    idps = default_saml_service.list_idps(auth.tenant_slug)
    return _json(
        {
            "tenant_slug": auth.tenant_slug,
            "providers": [
                {
                    "idp_id": cfg.idp_id,
                    "idp_entity_id": cfg.idp_entity_id,
                    "idp_sso_url": cfg.idp_sso_url,
                    "verified_domains": sorted(cfg.verified_domains),
                }
                for cfg in idps
            ],
        },
        status=200,
    )


def login_view(request: HttpRequest, tenant_slug: str) -> HttpResponse:
    """Initiate SP-initiated SAML 2.0 login (`AuthnRequest` + cryptographic `RelayState`)."""
    if request.method not in {"GET", "POST"}:
        resp = _json({"detail": "Method not allowed", "code": "method_not_allowed"}, status=405)
        resp["Allow"] = "GET, POST"
        return resp

    idp_id = request.GET.get("idp_id", "").strip()
    return_path = request.GET.get("return_path", "/").strip() or "/"
    want_redirect = request.GET.get("redirect", "").strip() == "1"

    if request.method == "POST" and request.body:
        content_type = (request.content_type or "").lower()
        if "application/json" in content_type:
            try:
                body_obj = json.loads(request.body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return _json({"detail": "Invalid JSON body", "code": "invalid_json"}, status=400)
            if not isinstance(body_obj, dict):
                return _json({"detail": "JSON object expected", "code": "invalid_json"}, status=400)
            if isinstance(body_obj.get("idp_id"), str):
                idp_id = body_obj["idp_id"].strip()
            if isinstance(body_obj.get("return_path"), str):
                return_path = body_obj["return_path"].strip() or "/"
            if body_obj.get("redirect") is True:
                want_redirect = True

    if not idp_id:
        configured_idps = default_saml_service.list_idps(tenant_slug)
        if len(configured_idps) == 1:
            idp_id = configured_idps[0].idp_id
        elif not configured_idps:
            return _json(
                {
                    "detail": "No SAML Identity Provider configured for tenant",
                    "code": "idp_not_found",
                },
                status=404,
            )
        else:
            return _json(
                {
                    "detail": "Multiple Identity Providers configured; specify idp_id",
                    "code": "idp_id_required",
                },
                status=400,
            )

    try:
        bundle = default_saml_service.create_authn_request(
            tenant_slug=tenant_slug,
            idp_id=idp_id,
            sp_base_url=_sp_base_url(request),
            return_path=return_path,
        )
    except SamlError as exc:
        return _saml_error_response(exc.code)

    if want_redirect:
        redirect_resp = HttpResponse(status=302)
        redirect_resp["Location"] = bundle.redirect_url
        redirect_resp["Cache-Control"] = "no-store"
        return redirect_resp

    return _json(
        {
            "tenant_slug": bundle.tenant_slug,
            "idp_id": bundle.idp_id,
            "request_id": bundle.request_id,
            "relay_state": bundle.relay_state,
            "redirect_url": bundle.redirect_url,
            "sp_entity_id": bundle.sp_entity_id,
            "acs_url": bundle.acs_url,
        },
        status=200,
    )


def acs_view(request: HttpRequest, tenant_slug: str) -> HttpResponse:
    """Assertion Consumer Service (`POST /api/v1/ee/sso/saml/<tenant_slug>/acs`)."""
    if request.method != "POST":
        resp = _json({"detail": "Method not allowed", "code": "method_not_allowed"}, status=405)
        resp["Allow"] = "POST"
        return resp

    content_type = (request.content_type or "").lower()
    saml_response_b64 = ""
    relay_state = ""

    if "application/json" in content_type:
        try:
            data = json.loads(request.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return _json({"detail": "Invalid JSON body", "code": "invalid_json"}, status=400)
        if not isinstance(data, dict):
            return _json({"detail": "JSON object expected", "code": "invalid_json"}, status=400)
        raw_resp = data.get("SAMLResponse")
        raw_relay = data.get("RelayState")
        if isinstance(raw_resp, str):
            saml_response_b64 = raw_resp
        if isinstance(raw_relay, str):
            relay_state = raw_relay
    elif "application/x-www-form-urlencoded" in content_type:
        try:
            parsed_form = parse_qs(
                request.body.decode("utf-8"),
                keep_blank_values=True,
                max_num_fields=16,
            )
        except (UnicodeDecodeError, ValueError):
            return _json({"detail": "Invalid form payload", "code": "invalid_form"}, status=400)
        saml_response_b64 = (parsed_form.get("SAMLResponse") or [""])[0]
        relay_state = (parsed_form.get("RelayState") or [""])[0]
    else:
        saml_response_b64 = request.POST.get("SAMLResponse", "")
        relay_state = request.POST.get("RelayState", "")

    try:
        principal = default_saml_service.consume_saml_response(
            tenant_slug=tenant_slug,
            saml_response_b64=saml_response_b64,
            relay_state=relay_state,
            sp_base_url=_sp_base_url(request),
        )
    except SamlError as exc:
        return _saml_error_response(exc.code)

    return _json(
        {
            "authenticated": True,
            "user_id": principal.user_id,
            "tenant_slug": principal.tenant_slug,
            "idp_id": principal.idp_id,
            "idp_entity_id": principal.idp_entity_id,
            "assertion_id": principal.assertion_id,
            "email": principal.email,
            "display_name": principal.display_name,
            "groups": list(principal.groups),
            "role": principal.role,
            "return_path": principal.return_path,
        },
        status=200,
    )
