"""HTTP views for Enterprise SAML 2.0 Federation (`/api/v1/ee/sso/saml/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from ee.saml.service import SamlError, default_saml_service


def _json(payload: dict[str, object], *, status: int = 200) -> HttpResponse:
    resp = HttpResponse(
        json.dumps(payload).encode("utf-8"),
        status=status,
        content_type="application/json",
    )
    resp["Cache-Control"] = "no-store"
    return resp


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
        return _json({"detail": str(exc), "code": exc.code}, status=exc.status)
    resp = HttpResponse(
        xml_bytes,
        status=200,
        content_type="application/samlmetadata+xml; charset=utf-8",
    )
    resp["Cache-Control"] = "no-store"
    return resp


def providers_view(request: HttpRequest, tenant_slug: str) -> HttpResponse:
    """List federated SAML 2.0 Identity Providers configured for `tenant_slug`."""
    if request.method != "GET":
        resp = _json({"detail": "Method not allowed", "code": "method_not_allowed"}, status=405)
        resp["Allow"] = "GET"
        return resp
    idps = default_saml_service.list_idps(tenant_slug)
    return _json(
        {
            "tenant_slug": tenant_slug,
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
        return _json({"detail": str(exc), "code": exc.code}, status=exc.status)

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
        return _json({"detail": str(exc), "code": exc.code}, status=exc.status)

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
