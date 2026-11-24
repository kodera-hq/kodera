"""Views for zero-mutation workspace import preview, execution, and coexistence bridges."""

from __future__ import annotations

import base64
import binascii
from typing import Any
from uuid import UUID

from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import coexistence, imports, marketplace, services, widgets
from ..wire import ExtensionRefusedError
from . import http
from .permissions import (
    CHECKOUT_MARKETPLACE_EXTENSION,
    CREATE_COEXISTENCE_BRIDGE,
    EXECUTE_WORKSPACE_IMPORT,
    INSTALL_MARKETPLACE_EXTENSION,
    INVOKE_CHANNEL_WIDGET_ACTION,
    LIST_COEXISTENCE_BRIDGES,
    LIST_MARKETPLACE_EXTENSIONS,
    PREVIEW_WORKSPACE_IMPORT,
    PUBLISH_MARKETPLACE_EXTENSION,
    RECEIVE_COEXISTENCE_EVENT,
    REVOKE_COEXISTENCE_BRIDGE,
)

MAX_INLINE_ARCHIVE_BYTES = 512 * 1024  # Strictly < 512 KiB inline preview cap.


def _resolve_archive_bytes(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> bytes:
    inline_b64 = body.get("inlineArchiveBase64")
    attachment_raw = body.get("attachmentId")
    if (inline_b64 is None) == (attachment_raw is None):
        raise ExtensionRefusedError("import_archive_source_ambiguous", 422)
    if inline_b64 is not None:
        if not isinstance(inline_b64, str) or not inline_b64 or len(inline_b64) > 700_000:
            raise ExtensionRefusedError(
                "import_inline_archive_bound"
                if isinstance(inline_b64, str) and len(inline_b64) > 700_000
                else "import_inline_archive_invalid",
                413 if isinstance(inline_b64, str) and len(inline_b64) > 700_000 else 422,
            )
        try:
            raw = base64.b64decode(inline_b64, validate=True)
        except (ValueError, binascii.Error):
            raise ExtensionRefusedError("import_inline_archive_invalid", 400) from None
        if not 0 < len(raw) < MAX_INLINE_ARCHIVE_BYTES:
            raise ExtensionRefusedError(
                "import_inline_archive_bound"
                if len(raw) >= MAX_INLINE_ARCHIVE_BYTES
                else "import_inline_archive_invalid",
                413 if len(raw) >= MAX_INLINE_ARCHIVE_BYTES else 422,
            )
        return raw

    attachment_id = http.parse_uuid(attachment_raw)
    return services.read_import_attachment(
        verified=verified, organisation_id=organisation_id, attachment_id=attachment_id
    )


def _parse_channel_map(raw_map: Any) -> dict[str, UUID] | None:
    if raw_map is None:
        return None
    if not isinstance(raw_map, dict) or len(raw_map) > 100:
        raise ExtensionRefusedError("import_channel_map_invalid", 422)
    out: dict[str, UUID] = {}
    for key, val in raw_map.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 160:
            raise ExtensionRefusedError("import_channel_map_invalid", 422)
        out[key] = http.parse_uuid(val)
    return out


@declares(PREVIEW_WORKSPACE_IMPORT)
def import_preview(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={"source", "inlineArchiveBase64", "attachmentId", "channelMap"},
            required={"source"},
        )
        source = body["source"]
        if not isinstance(source, str):
            raise ExtensionRefusedError("import_source_or_size_invalid", 422)
        channel_map = _parse_channel_map(body.get("channelMap"))
        raw = _resolve_archive_bytes(verified=verified, organisation_id=organisation_id, body=body)
        report = imports.preview(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            channel_map=channel_map,
        )
        return http.json_response(report, 200)

    # Zero-mutation dry-run: never persist an idempotency record.
    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(PREVIEW_WORKSPACE_IMPORT,),
        idempotent_post=False,
    )


@declares(EXECUTE_WORKSPACE_IMPORT)
def import_execute(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    is_dry_run = False
    if request.method == "POST":
        try:
            peek = http.parse_json_body(
                request,
                fields={
                    "source",
                    "inlineArchiveBase64",
                    "attachmentId",
                    "dryRun",
                    "limit",
                    "channelMap",
                },
                required={"source"},
            )
            is_dry_run = peek.get("dryRun") is True
        except ExtensionRefusedError:
            is_dry_run = False

    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={
                "source",
                "inlineArchiveBase64",
                "attachmentId",
                "dryRun",
                "limit",
                "channelMap",
            },
            required={"source"},
        )
        source = body["source"]
        if not isinstance(source, str):
            raise ExtensionRefusedError("import_source_or_size_invalid", 422)
        dry_run = body.get("dryRun", False)
        if type(dry_run) is not bool:
            raise ExtensionRefusedError("import_dry_run_invalid", 422)
        limit = body.get("limit", 25)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise ExtensionRefusedError("import_batch_limit", 422)
        channel_map = _parse_channel_map(body.get("channelMap"))
        raw = _resolve_archive_bytes(verified=verified, organisation_id=organisation_id, body=body)
        report = imports.execute(
            verified=verified,
            organisation_id=organisation_id,
            source=source,
            raw=raw,
            limit=limit,
            dry_run=dry_run,
            channel_map=channel_map,
        )
        return http.json_response(report, 200)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(EXECUTE_WORKSPACE_IMPORT,),
        idempotent_post=not is_dry_run,
    )


@declares(LIST_COEXISTENCE_BRIDGES, CREATE_COEXISTENCE_BRIDGE)
def coexistence_bridges(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        bridges = coexistence.list_bridges(verified=verified, organisation_id=organisation_id)
        return http.json_response({"bridges": bridges}, 200)

    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={
                "channelId",
                "source",
                "externalWorkspaceId",
                "externalChannelId",
                "outboundEndpoint",
                "signingSecret",
            },
            required={
                "channelId",
                "source",
                "externalWorkspaceId",
                "externalChannelId",
                "outboundEndpoint",
                "signingSecret",
            },
        )
        row = coexistence.create_bridge(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=http.parse_uuid(body["channelId"]),
            source=str(body["source"]) if isinstance(body["source"], str) else "",
            external_workspace_id=(
                body["externalWorkspaceId"] if isinstance(body["externalWorkspaceId"], str) else ""
            ),
            external_channel_id=(
                body["externalChannelId"] if isinstance(body["externalChannelId"], str) else ""
            ),
            outbound_endpoint=(
                body["outboundEndpoint"] if isinstance(body["outboundEndpoint"], str) else ""
            ),
            signing_secret=(
                body["signingSecret"] if isinstance(body["signingSecret"], str) else ""
            ),
        )
        return http.json_response(coexistence.serialize_bridge(row), 201)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"GET": get, "POST": post},
        operations=(LIST_COEXISTENCE_BRIDGES, CREATE_COEXISTENCE_BRIDGE),
        idempotent_post=True,
    )


@declares(REVOKE_COEXISTENCE_BRIDGE)
def coexistence_bridge(
    request: HttpRequest, organisation_id: UUID, bridge_id: UUID
) -> HttpResponse:
    def delete(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        coexistence.revoke_bridge(
            verified=verified, organisation_id=organisation_id, bridge_id=bridge_id
        )
        return HttpResponse(status=204)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"DELETE": delete},
        operations=(REVOKE_COEXISTENCE_BRIDGE,),
        idempotent_post=False,
    )


@declares(RECEIVE_COEXISTENCE_EVENT)
def coexistence_webhook(request: HttpRequest, bridge_id: UUID) -> HttpResponse:
    req_id = http.request_id(request)
    try:
        if request.method != "POST":
            return http.finish(http.problem(405, req_id, allowed=["POST"]), req_id)
        content_length = request.META.get("CONTENT_LENGTH", "")
        if isinstance(content_length, str) and content_length.isdigit():
            if int(content_length) > coexistence.MAX_COEXISTENCE_BODY:
                raise ExtensionRefusedError("coexistence_payload_bound", 413)
        raw_body = bytes(request.body[: coexistence.MAX_COEXISTENCE_BODY + 1])
        receipt = coexistence.receive_webhook(
            bridge_id=bridge_id,
            raw_body=raw_body,
            headers=dict(request.headers),
        )
        status_code = 202 if receipt.get("queued") is True else 200
        response = http.json_response(receipt, status_code)
    except RequestDataTooBig:
        response = http.problem(413, req_id, reason="coexistence_payload_bound")
    except ExtensionRefusedError as refused:
        response = http.problem(
            refused.status,
            req_id,
            reason=refused.reason,
            www_authenticate="Kodera-Coexistence-Signature",
        )
    return http.finish(response, req_id)


@declares(LIST_MARKETPLACE_EXTENSIONS, PUBLISH_MARKETPLACE_EXTENSION)
def marketplace_listings(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        payload = marketplace.list_marketplace_listings(
            verified=verified,
            organisation_id=organisation_id,
        )
        return http.json_response(payload, 200)

    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={
                "slug",
                "title",
                "summary",
                "manifest",
                "pricingMode",
                "priceExclVatMinor",
            },
            required={"slug", "title", "summary", "manifest"},
        )
        raw_manifest = body["manifest"]
        if not isinstance(raw_manifest, dict):
            raise ExtensionRefusedError("marketplace_manifest_invalid", 422)
        pricing_mode = body.get("pricingMode", "free")
        price_minor = body.get("priceExclVatMinor", 0)
        if not isinstance(pricing_mode, str):
            raise ExtensionRefusedError("marketplace_pricing_mode_invalid", 422)
        if type(price_minor) is not int:
            raise ExtensionRefusedError("marketplace_price_invalid", 422)
        created = marketplace.publish_marketplace_listing(
            verified=verified,
            organisation_id=organisation_id,
            slug=body["slug"] if isinstance(body["slug"], str) else "",
            title=body["title"] if isinstance(body["title"], str) else "",
            summary=body["summary"] if isinstance(body["summary"], str) else "",
            manifest=raw_manifest,
            pricing_mode=pricing_mode,
            price_excl_vat_minor=price_minor,
        )
        return http.json_response(created, 201)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"GET": get, "POST": post},
        operations=(LIST_MARKETPLACE_EXTENSIONS, PUBLISH_MARKETPLACE_EXTENSION),
        idempotent_post=True,
        require_admin=request.method != "GET",
    )


@declares(CHECKOUT_MARKETPLACE_EXTENSION)
def marketplace_checkout(
    request: HttpRequest, organisation_id: UUID, listing_id: UUID
) -> HttpResponse:
    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        idem_key = http.require_idempotency_key(request)
        body = http.parse_json_body(
            request,
            fields={
                "customerKind",
                "buyerCountry",
                "returnUrl",
                "locale",
                "withdrawalWaiverAccepted",
                "withdrawalWaiverAt",
                "withdrawalWaiverStatement",
            },
            required=set(),
        )
        customer_kind = body.get("customerKind", "b2c")
        buyer_country = body.get("buyerCountry", "FR")
        return_url = body.get("returnUrl")
        locale = body.get("locale", "fr")
        waiver_accepted = body.get("withdrawalWaiverAccepted", False)
        waiver_at = body.get("withdrawalWaiverAt")
        waiver_stmt = body.get("withdrawalWaiverStatement")
        if (
            not isinstance(customer_kind, str)
            or not isinstance(buyer_country, str)
            or (return_url is not None and not isinstance(return_url, str))
            or not isinstance(locale, str)
            or type(waiver_accepted) is not bool
            or (waiver_at is not None and not isinstance(waiver_at, str))
            or (waiver_stmt is not None and not isinstance(waiver_stmt, str))
        ):
            raise ExtensionRefusedError("marketplace_checkout_invalid", 422)

        result = marketplace.checkout_marketplace_listing(
            verified=verified,
            organisation_id=organisation_id,
            listing_id=listing_id,
            idempotency_key=idem_key,
            customer_kind=customer_kind,
            buyer_country=buyer_country,
            return_url=return_url,
            locale=locale,
            withdrawal_waiver_accepted=waiver_accepted,
            withdrawal_waiver_at=waiver_at,
            withdrawal_waiver_statement=waiver_stmt,
        )
        status_code = 200 if result.get("replayed") is True else 201
        return http.json_response(result, status_code)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(CHECKOUT_MARKETPLACE_EXTENSION,),
        idempotent_post=False,
        require_admin=False,
    )


@declares(INSTALL_MARKETPLACE_EXTENSION)
def marketplace_install(
    request: HttpRequest, organisation_id: UUID, listing_id: UUID
) -> HttpResponse:
    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        body = http.parse_json_body(
            request,
            fields={"signingSecret", "endpoint"},
            required={"signingSecret"},
        )
        signing_secret = body["signingSecret"]
        endpoint = body.get("endpoint")
        if not isinstance(signing_secret, str) or (
            endpoint is not None and not isinstance(endpoint, str)
        ):
            raise ExtensionRefusedError("marketplace_install_invalid", 422)
        result = marketplace.install_marketplace_listing(
            verified=verified,
            organisation_id=organisation_id,
            listing_id=listing_id,
            signing_secret=signing_secret,
            endpoint=endpoint,
        )
        status_code = 200 if result.get("replayed") is True else 201
        return http.json_response(result, status_code)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(INSTALL_MARKETPLACE_EXTENSION,),
        idempotent_post=True,
        require_admin=True,
    )


@declares(INVOKE_CHANNEL_WIDGET_ACTION)
def channel_widget_actions(
    request: HttpRequest,
    organisation_id: UUID,
    channel_id: UUID,
    widget_id: str,
) -> HttpResponse:
    def post(verified: VerifiedAccessToken, _req_id: str) -> HttpResponse:
        idem_key = http.require_idempotency_key(request)
        body = http.parse_json_body(
            request,
            fields={"installationId", "actionId", "payload"},
            required={"installationId", "actionId"},
        )
        installation_id = http.parse_uuid(body["installationId"])
        action_id = body["actionId"]
        if not isinstance(action_id, str):
            raise ExtensionRefusedError("widget_action_id_invalid", 422)
        raw_payload = body.get("payload")
        if raw_payload is not None and not isinstance(raw_payload, dict):
            raise ExtensionRefusedError("widget_action_payload_invalid", 422)
        result = widgets.dispatch_widget_action(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            widget_id=widget_id,
            installation_id=installation_id,
            action_id=action_id,
            idempotency_key=idem_key,
            payload=raw_payload,
        )
        return http.json_response(result, 200)

    return http.serve_authenticated(
        request,
        organisation_id=organisation_id,
        handlers={"POST": post},
        operations=(INVOKE_CHANNEL_WIDGET_ACTION,),
        idempotent_post=False,
        require_admin=False,
    )
