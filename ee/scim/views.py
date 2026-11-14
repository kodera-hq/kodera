"""RFC 7644 SCIM 2.0 HTTP views (`/api/v1/ee/scim/v2/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
from typing import Final

from django.http import HttpRequest, HttpResponse

from ee.scim.auth import ScimAuthError, ScimTokenRecord
from ee.scim.schemas import (
    SCIM_ERROR_SCHEMA,
    SCIM_LIST_RESPONSE_SCHEMA,
    build_resource_types,
    build_schemas,
    build_service_provider_config,
)
from ee.scim.service import DEFAULT_PAGE_SIZE, ScimError, default_scim_service

_SCIM_PUBLIC_ERRORS: Final[tuple[tuple[str, int, str | None, str], ...]] = (
    # Authentication & tenant authorization rejections
    ("missing_token", 401, None, "Missing SCIM Bearer token"),
    ("malformed_auth_header", 401, None, "Malformed Authorization header"),
    ("invalid_auth_scheme", 401, None, "Authorization header must use Bearer scheme"),
    ("invalid_token", 401, None, "Invalid SCIM Bearer token"),
    ("token_revoked", 401, None, "SCIM Bearer token has been revoked"),
    ("token_expired", 401, None, "SCIM Bearer token has expired"),
    ("tenant_forbidden", 403, None, "SCIM Bearer token is not authorized for the target tenant"),
    ("insufficient_scope", 403, None, "SCIM Bearer token lacks required scope"),
    ("conflicting_tenant", 403, None, "Conflicting tenant path and X-Kodera-Tenant header"),
    # RFC 7644 resource & protocol rejections
    ("uniqueness", 409, "uniqueness", "Resource already exists in tenant"),
    ("not_found", 404, None, "Requested SCIM resource was not found"),
    ("forbidden", 403, None, "SCIM operation is not permitted"),
    ("scim_invalidFilter", 400, "invalidFilter", "Invalid or unsupported SCIM filter expression"),
    ("scim_invalidSyntax", 400, "invalidSyntax", "Invalid SCIM request syntax"),
    ("scim_invalidValue", 400, "invalidValue", "Invalid SCIM attribute value"),
    ("scim_invalidPath", 400, "invalidPath", "Invalid or unsupported SCIM PATCH path"),
    ("scim_mutability", 400, "mutability", "Target SCIM attribute cannot be modified"),
    ("scim_noTarget", 400, "noTarget", "SCIM PATCH operation requires a target path"),
    ("invalid_request", 400, None, "Invalid SCIM request"),
)


def _scim_response(
    payload: dict[str, object] | None,
    *,
    status: int = 200,
    location: str | None = None,
    etag: str | None = None,
) -> HttpResponse:
    if status == 204 or payload is None:
        resp = HttpResponse(status=status)
    else:
        resp = HttpResponse(
            json.dumps(payload).encode("utf-8"),
            status=status,
            content_type="application/scim+json",
        )
    resp["Cache-Control"] = "no-store"
    if location is not None:
        resp["Location"] = location
    if etag is not None:
        resp["ETag"] = etag
    return resp


def _scim_error(
    detail: str,
    *,
    status: int,
    scim_type: str | None = None,
) -> HttpResponse:
    body: dict[str, object] = {
        "schemas": [SCIM_ERROR_SCHEMA],
        "status": str(status),
        "detail": detail,
    }
    if scim_type is not None:
        body["scimType"] = scim_type
    resp = _scim_response(body, status=status)
    if status == 401:
        resp["WWW-Authenticate"] = 'Bearer realm="kodera-scim"'
    return resp


def _scim_error_from_code(error_code: str, *, default_status: int = 400) -> HttpResponse:
    """Resolve SCIM error response solely from static literals without exposing exception text."""
    for code_lit, status_lit, scim_type_lit, detail_lit in _SCIM_PUBLIC_ERRORS:
        if error_code == code_lit:
            return _scim_error(detail_lit, status=status_lit, scim_type=scim_type_lit)
    if default_status == 401:
        return _scim_error("Invalid SCIM Bearer token", status=401)
    return _scim_error("Invalid SCIM request", status=400)


def _scim_base_url(request: HttpRequest, tenant_slug: str | None = None) -> str:
    scheme = "https" if request.is_secure() else "http"
    origin = f"{scheme}://{request.get_host()}"
    if tenant_slug is not None and f"/tenants/{tenant_slug}/" in request.path_info:
        return f"{origin}/api/v1/ee/scim/v2/tenants/{tenant_slug}"
    return f"{origin}/api/v1/ee/scim/v2"


def _authenticate_scim_request(
    request: HttpRequest,
    *,
    required_scope: str,
    tenant_slug: str | None = None,
) -> ScimTokenRecord:
    header_tenant = request.META.get("HTTP_X_KODERA_TENANT")
    cleaned_header = (
        header_tenant.strip() if isinstance(header_tenant, str) and header_tenant.strip() else None
    )
    if tenant_slug is not None and cleaned_header is not None and cleaned_header != tenant_slug:
        raise ScimAuthError(
            "Conflicting tenant path and X-Kodera-Tenant header",
            code="conflicting_tenant",
            status=403,
        )
    expected = tenant_slug or cleaned_header
    return default_scim_service.tokens.authenticate(
        request.META.get("HTTP_AUTHORIZATION"),
        required_scope=required_scope,
        expected_tenant_slug=expected,
    )


def _parse_scim_json(request: HttpRequest) -> dict[str, object]:
    if not request.body or len(request.body) > 262_144:
        raise ScimError(
            "Missing or oversized SCIM JSON body", status=400, scim_type="invalidSyntax"
        )
    try:
        parsed = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ScimError(
            "Malformed JSON in SCIM request body", status=400, scim_type="invalidSyntax"
        ) from exc
    if not isinstance(parsed, dict):
        raise ScimError(
            "SCIM request body must be a JSON object", status=400, scim_type="invalidSyntax"
        )
    return parsed


def _parse_pagination(request: HttpRequest) -> tuple[int, int]:
    raw_start = request.GET.get("startIndex", "1").strip()
    raw_count = request.GET.get("count", str(DEFAULT_PAGE_SIZE)).strip()
    try:
        start_index = int(raw_start)
        count = int(raw_count)
    except ValueError as exc:
        raise ScimError(
            "startIndex and count must be integers", status=400, scim_type="invalidValue"
        ) from exc
    return start_index, count


def _extract_meta_headers(resource: dict[str, object]) -> tuple[str | None, str | None]:
    meta = resource.get("meta")
    if not isinstance(meta, dict):
        return None, None
    loc = meta.get("location")
    ver = meta.get("version")
    return (
        loc if isinstance(loc, str) else None,
        ver if isinstance(ver, str) else None,
    )


def service_provider_config_view(
    request: HttpRequest,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method != "GET":
        return _scim_error("Method not allowed", status=405)
    try:
        if request.META.get("HTTP_AUTHORIZATION") or tenant_slug is not None:
            _authenticate_scim_request(request, required_scope="scim:read", tenant_slug=tenant_slug)
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)
    return _scim_response(build_service_provider_config(_scim_base_url(request, tenant_slug)))


def schemas_view(
    request: HttpRequest,
    schema_id: str | None = None,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method != "GET":
        return _scim_error("Method not allowed", status=405)
    try:
        _authenticate_scim_request(request, required_scope="scim:read", tenant_slug=tenant_slug)
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    items = build_schemas(_scim_base_url(request, tenant_slug))
    if schema_id is not None:
        for item in items:
            if item.get("id") == schema_id:
                return _scim_response(item)
        return _scim_error("Requested SCIM Schema was not found", status=404)
    return _scim_response(
        {
            "schemas": [SCIM_LIST_RESPONSE_SCHEMA],
            "totalResults": len(items),
            "startIndex": 1,
            "itemsPerPage": len(items),
            "Resources": items,
        }
    )


def resource_types_view(
    request: HttpRequest,
    resource_type_id: str | None = None,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method != "GET":
        return _scim_error("Method not allowed", status=405)
    try:
        _authenticate_scim_request(request, required_scope="scim:read", tenant_slug=tenant_slug)
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    items = build_resource_types(_scim_base_url(request, tenant_slug))
    if resource_type_id is not None:
        for item in items:
            if item.get("id") == resource_type_id:
                return _scim_response(item)
        return _scim_error("Requested SCIM ResourceType was not found", status=404)
    return _scim_response(
        {
            "schemas": [SCIM_LIST_RESPONSE_SCHEMA],
            "totalResults": len(items),
            "startIndex": 1,
            "itemsPerPage": len(items),
            "Resources": items,
        }
    )


def users_collection_view(
    request: HttpRequest,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method not in {"GET", "POST"}:
        return _scim_error("Method not allowed", status=405)

    req_scope = "scim:users:read" if request.method == "GET" else "scim:users:write"
    try:
        token = _authenticate_scim_request(
            request,
            required_scope=req_scope,
            tenant_slug=tenant_slug,
        )
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    base_url = _scim_base_url(request, token.tenant_slug)
    try:
        if request.method == "GET":
            start_index, count = _parse_pagination(request)
            filter_expr = request.GET.get("filter")
            result = default_scim_service.list_users(
                tenant_slug=token.tenant_slug,
                base_url=base_url,
                filter_expr=filter_expr,
                start_index=start_index,
                count=count,
            )
            return _scim_response(result, status=200)

        payload = _parse_scim_json(request)
        created = default_scim_service.create_user(
            tenant_slug=token.tenant_slug,
            payload=payload,
            base_url=base_url,
            organisation_id=token.organisation_id,
        )
        loc, etag = _extract_meta_headers(created)
        return _scim_response(created, status=201, location=loc, etag=etag)
    except ScimError as exc:
        return _scim_error_from_code(exc.code)


def user_detail_view(
    request: HttpRequest,
    user_id: str,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method not in {"GET", "PUT", "PATCH", "DELETE"}:
        return _scim_error("Method not allowed", status=405)

    req_scope = "scim:users:read" if request.method == "GET" else "scim:users:write"
    try:
        token = _authenticate_scim_request(
            request,
            required_scope=req_scope,
            tenant_slug=tenant_slug,
        )
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    base_url = _scim_base_url(request, token.tenant_slug)
    try:
        if request.method == "GET":
            found = default_scim_service.get_user(
                tenant_slug=token.tenant_slug,
                user_id=user_id,
                base_url=base_url,
            )
            _, etag = _extract_meta_headers(found)
            return _scim_response(found, status=200, etag=etag)

        if request.method == "PUT":
            payload = _parse_scim_json(request)
            replaced = default_scim_service.replace_user(
                tenant_slug=token.tenant_slug,
                user_id=user_id,
                payload=payload,
                base_url=base_url,
                organisation_id=token.organisation_id,
            )
            _, etag = _extract_meta_headers(replaced)
            return _scim_response(replaced, status=200, etag=etag)

        if request.method == "PATCH":
            payload = _parse_scim_json(request)
            patched = default_scim_service.patch_user(
                tenant_slug=token.tenant_slug,
                user_id=user_id,
                payload=payload,
                base_url=base_url,
                organisation_id=token.organisation_id,
            )
            _, etag = _extract_meta_headers(patched)
            return _scim_response(patched, status=200, etag=etag)

        default_scim_service.delete_user(
            tenant_slug=token.tenant_slug,
            user_id=user_id,
            organisation_id=token.organisation_id,
        )
        return _scim_response(None, status=204)
    except ScimError as exc:
        return _scim_error_from_code(exc.code)


def groups_collection_view(
    request: HttpRequest,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method not in {"GET", "POST"}:
        return _scim_error("Method not allowed", status=405)

    req_scope = "scim:groups:read" if request.method == "GET" else "scim:groups:write"
    try:
        token = _authenticate_scim_request(
            request,
            required_scope=req_scope,
            tenant_slug=tenant_slug,
        )
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    base_url = _scim_base_url(request, token.tenant_slug)
    try:
        if request.method == "GET":
            start_index, count = _parse_pagination(request)
            filter_expr = request.GET.get("filter")
            result = default_scim_service.list_groups(
                tenant_slug=token.tenant_slug,
                base_url=base_url,
                filter_expr=filter_expr,
                start_index=start_index,
                count=count,
            )
            return _scim_response(result, status=200)

        payload = _parse_scim_json(request)
        created = default_scim_service.create_group(
            tenant_slug=token.tenant_slug,
            payload=payload,
            base_url=base_url,
        )
        loc, etag = _extract_meta_headers(created)
        return _scim_response(created, status=201, location=loc, etag=etag)
    except ScimError as exc:
        return _scim_error_from_code(exc.code)


def group_detail_view(
    request: HttpRequest,
    group_id: str,
    tenant_slug: str | None = None,
) -> HttpResponse:
    if request.method not in {"GET", "PUT", "PATCH", "DELETE"}:
        return _scim_error("Method not allowed", status=405)

    req_scope = "scim:groups:read" if request.method == "GET" else "scim:groups:write"
    try:
        token = _authenticate_scim_request(
            request,
            required_scope=req_scope,
            tenant_slug=tenant_slug,
        )
    except ScimAuthError as exc:
        return _scim_error_from_code(exc.code, default_status=401)

    base_url = _scim_base_url(request, token.tenant_slug)
    try:
        if request.method == "GET":
            found = default_scim_service.get_group(
                tenant_slug=token.tenant_slug,
                group_id=group_id,
                base_url=base_url,
            )
            _, etag = _extract_meta_headers(found)
            return _scim_response(found, status=200, etag=etag)

        if request.method == "PUT":
            payload = _parse_scim_json(request)
            replaced = default_scim_service.replace_group(
                tenant_slug=token.tenant_slug,
                group_id=group_id,
                payload=payload,
                base_url=base_url,
            )
            _, etag = _extract_meta_headers(replaced)
            return _scim_response(replaced, status=200, etag=etag)

        if request.method == "PATCH":
            payload = _parse_scim_json(request)
            patched = default_scim_service.patch_group(
                tenant_slug=token.tenant_slug,
                group_id=group_id,
                payload=payload,
                base_url=base_url,
            )
            _, etag = _extract_meta_headers(patched)
            return _scim_response(patched, status=200, etag=etag)

        default_scim_service.delete_group(
            tenant_slug=token.tenant_slug,
            group_id=group_id,
        )
        return _scim_response(None, status=204)
    except ScimError as exc:
        return _scim_error_from_code(exc.code)
