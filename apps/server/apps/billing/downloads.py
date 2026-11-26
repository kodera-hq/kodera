"""Short-lived object-store document signing port; the API holds no storage credential."""

import hashlib
import http.client
import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol
from urllib.parse import parse_qsl, quote, urlencode, urlsplit
from uuid import UUID

from django.conf import settings
from django.utils import timezone

from apps.media.storage import ObjectDescriptor, S3Credential, S3Location, _sign, presign
from apps.media.storage_gateway import _Connection
from apps.media.storage_protocol import MAX_RPC_BYTES, unique_object

from .artifacts import verify_artifact
from .integrity import IntegrityRefusedError
from .models import BillingArtifact, CreditNote, Invoice
from .selectors import InvoicePdfNotRenderedError


class DownloadSigner(Protocol):
    def sign(self, *, artifact_id: UUID, format: str, expires_at: datetime) -> str:
        """Sign the validated worker-published object; no API infrastructure credential."""
        ...


def _gateway_socket() -> object:
    return getattr(settings, "KODERA_BILLING_GATEWAY_SOCKET", None) or os.environ.get(
        "KODERA_BILLING_GATEWAY_SOCKET"
    )


def link(
    *, organisation_id: UUID, document_id: UUID, credit_note: bool, format: str
) -> dict[str, object]:
    if format not in {"pdf", "xml"}:
        raise IntegrityRefusedError("billing_download_format")
    prefix = "credit_note" if credit_note else "invoice"
    row = BillingArtifact.objects.filter(
        **{prefix + "_id": document_id, prefix + "__organisation_id": organisation_id}
    ).first()
    if row is None:
        model = CreditNote if credit_note else Invoice
        if model.objects.filter(
            id=document_id, organisation_id=organisation_id, pdf_ref__isnull=False
        ).exists():
            raise IntegrityRefusedError("billing_artifact_missing")
        raise InvoicePdfNotRenderedError()
    verify_artifact(row)
    signer: DownloadSigner | None = getattr(settings, "KODERA_BILLING_DOWNLOAD_SIGNER", None)
    if signer is None and _gateway_socket():
        signer = GatewayBillingDownloadSigner()
    if signer is None:
        raise InvoicePdfNotRenderedError()
    document = row.credit_note if credit_note else row.invoice
    if document is None or document.number is None:
        raise IntegrityRefusedError("billing_artifact_parent_missing")
    filename = _safe_target(organisation_id, row.id, document.number, format)
    expires = timezone.now() + timedelta(minutes=5)
    url = signer.sign(artifact_id=row.id, format=format, expires_at=expires)
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.port not in (None, 443)
        or parts.username
        or parts.password
        or parts.fragment
        or any(ord(c) < 33 for c in url)
        or len(url) > 8192
    ):
        raise IntegrityRefusedError("billing_download_signer_url_invalid")
    return {
        "url": url,
        "expires_at": expires.isoformat(),
        "content_type": "application/pdf" if format == "pdf" else "application/xml",
        "filename": filename,
        "sha256": row.pdf_sha256 if format == "pdf" else row.xml_sha256,
        "size_bytes": len(row.pdf if format == "pdf" else row.xml),
    }


@dataclass(frozen=True)
class _BillingObject(ObjectDescriptor):
    extension: str = "pdf"

    @property
    def key(self) -> str:
        return f"organisations/{self.organisation_id}/billing-artifacts/{self.attachment_id}.{self.extension}"


def _safe_target(organisation_id: UUID, artifact_id: UUID, number: str, format: str) -> str:
    if (
        not isinstance(organisation_id, UUID)
        or not isinstance(artifact_id, UUID)
        or format not in {"pdf", "xml"}
        or not isinstance(number, str)
        or re.fullmatch(r"[A-Z0-9][A-Z0-9-]{0,99}", number) is None
    ):
        raise IntegrityRefusedError("billing_download_target_invalid")
    return f"{number}.{format}"


def _artifact_target(artifact_id: UUID) -> tuple[UUID, str]:
    row = BillingArtifact.objects.select_related("invoice", "credit_note").get(id=artifact_id)
    verify_artifact(row)
    document = row.invoice if row.invoice_id else row.credit_note
    if document is None or document.number is None:
        raise IntegrityRefusedError("billing_artifact_parent_missing")
    return document.organisation_id, document.number


class S3ArtifactDownloadSigner:
    """Worker-only signer. Credentials must be passed explicitly by the private worker."""

    def __init__(
        self,
        *,
        location: S3Location,
        credential: S3Credential,
        clock: Callable[[], datetime] = timezone.now,
    ) -> None:
        parts = urlsplit(location.endpoint)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.port not in (None, 443)
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or parts.path not in {"", "/"}
        ):
            raise IntegrityRefusedError("billing_storage_endpoint_invalid")
        self.location, self.credential, self.clock = location, credential, clock

    def sign_object(
        self,
        *,
        organisation_id: UUID,
        artifact_id: UUID,
        number: str,
        format: str,
        ttl_seconds: int = 300,
    ) -> str:
        name = _safe_target(organisation_id, artifact_id, number, format)
        if type(ttl_seconds) is not int:
            raise IntegrityRefusedError("billing_download_expiry_invalid")
        ttl = max(60, min(300, ttl_seconds))
        now = self.clock()
        descriptor = _BillingObject(
            organisation_id,
            artifact_id,
            name,
            "application/pdf" if format == "pdf" else "application/octet-stream",
            1,
            "0" * 64,
            format,
        )
        # Reuse the media worker's strict SigV4 credential/key handling. Its attachment policy
        # fixes TTL=300 and disposition=attachment, so re-sign our narrower billing overrides.
        url, _ = presign(self.location, self.credential, descriptor, method="GET", now=now)
        parts = urlsplit(url)
        parameters = dict(parse_qsl(parts.query, strict_parsing=True))
        parameters.pop("X-Amz-Signature")
        parameters["X-Amz-Expires"] = str(ttl)
        parameters["response-cache-control"] = "private, no-store"
        parameters["response-content-disposition"] = f'attachment; filename="{name}"'
        parameters["response-content-type"] = (
            "application/pdf" if format == "pdf" else "application/xml"
        )
        query = urlencode(sorted(parameters.items()), quote_via=quote, safe="-_.~")
        stamp = parameters["X-Amz-Date"]
        scope = parameters["X-Amz-Credential"].split("/", 1)[1]
        canonical = "\n".join(
            ("GET", parts.path, query, f"host:{parts.netloc}\n", "host", "UNSIGNED-PAYLOAD")
        )
        to_sign = "\n".join(
            ("AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest())
        )
        key = _sign(("AWS4" + self.credential.secret_key).encode(), stamp[:8])
        for part in (self.location.region, "s3", "aws4_request"):
            key = _sign(key, part)
        return (
            parts.scheme
            + "://"
            + parts.netloc
            + parts.path
            + "?"
            + query
            + "&X-Amz-Signature="
            + _sign(key, to_sign).hex()
        )

    def sign(self, *, artifact_id: UUID, format: str, expires_at: datetime) -> str:
        organisation_id, number = _artifact_target(artifact_id)
        return self.sign_object(
            organisation_id=organisation_id,
            artifact_id=artifact_id,
            number=number,
            format=format,
            ttl_seconds=int((expires_at - self.clock()).total_seconds()),
        )


class GatewayBillingDownloadSigner:
    """API-side private socket client. This object contains no storage credentials."""

    def __init__(
        self, socket_path: str | None = None, *, clock: Callable[[], datetime] = timezone.now
    ) -> None:
        path = socket_path if socket_path is not None else _gateway_socket()
        if (
            not isinstance(path, str)
            or not path
            or "\x00" in path
            or len(os.fsencode(path)) > 103
            or not Path(path).is_absolute()
        ):
            raise IntegrityRefusedError("billing_gateway_socket_invalid")
        self.path, self.clock = path, clock

    def sign(self, *, artifact_id: UUID, format: str, expires_at: datetime) -> str:
        organisation_id, number = _artifact_target(artifact_id)
        _safe_target(organisation_id, artifact_id, number, format)
        ttl = max(60, min(300, int((expires_at - self.clock()).total_seconds())))
        raw = json.dumps(
            {
                "operation": "billing_download",
                "object": {
                    "organisationId": str(organisation_id),
                    "artifactId": str(artifact_id),
                    "number": number,
                    "format": format,
                    "ttl": ttl,
                },
            },
            separators=(",", ":"),
        ).encode()
        connection = _Connection(self.path)
        response = None
        try:
            connection.request(
                "POST",
                "/rpc",
                body=raw,
                headers={"Content-Type": "application/json", "Connection": "close"},
            )
            response = connection.getresponse()
            body = response.read(MAX_RPC_BYTES + 1)
            if response.status != 200 or len(body) > MAX_RPC_BYTES:
                raise ValueError
            result = json.loads(body, object_pairs_hook=unique_object)
            if (
                not isinstance(result, dict)
                or set(result) != {"url"}
                or not isinstance(result["url"], str)
            ):
                raise ValueError
            parts = urlsplit(result["url"])
            expected = f"/organisations/{organisation_id}/billing-artifacts/{artifact_id}.{format}"
            pairs = parse_qsl(parts.query, strict_parsing=True)
            query = dict(pairs)
            issued = datetime.strptime(query["X-Amz-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            remaining = (issued + timedelta(seconds=ttl) - self.clock()).total_seconds()
            if (
                len(query) != len(pairs)
                or not 0 < remaining <= 300
                or query.get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256"
                or query.get("X-Amz-SignedHeaders") != "host"
                or re.fullmatch(r"[a-f0-9]{64}", query.get("X-Amz-Signature", "")) is None
                or parts.scheme != "https"
                or not parts.hostname
                or parts.port not in (None, 443)
                or parts.username
                or parts.password
                or parts.fragment
                or re.fullmatch(
                    r"(?:/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9])?" + re.escape(expected), parts.path
                )
                is None
                or len(result["url"]) > 8192
                or any(ord(c) < 33 for c in result["url"])
                or query.get("X-Amz-Expires") != str(ttl)
                or query.get("response-content-disposition")
                != f'attachment; filename="{number}.{format}"'
                or query.get("response-cache-control") != "private, no-store"
            ):
                raise ValueError
            return str(result["url"])
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException):
            raise IntegrityRefusedError("billing_gateway_refused") from None
        finally:
            if response is not None:
                response.close()
            connection.close()


def billing_download_rpc(signer: S3ArtifactDownloadSigner, raw: bytes) -> bytes:
    """Worker dispatch port for the billing_download Unix RPC; never loads credentials."""
    try:
        if len(raw) > MAX_RPC_BYTES:
            raise ValueError
        request = json.loads(raw, object_pairs_hook=unique_object)
        if set(request) != {"operation", "object"} or request["operation"] != "billing_download":
            raise ValueError
        obj = request["object"]
        if set(obj) != {"organisationId", "artifactId", "number", "format", "ttl"}:
            raise ValueError
        if not isinstance(obj["organisationId"], str) or not isinstance(obj["artifactId"], str):
            raise ValueError
        org_id, artifact_id = UUID(obj["organisationId"]), UUID(obj["artifactId"])
        # Re-read immutable authority; a socket caller cannot rename an artifact or its tenant.
        if _artifact_target(artifact_id) != (org_id, obj["number"]):
            raise ValueError
        url = signer.sign_object(
            organisation_id=org_id,
            artifact_id=artifact_id,
            number=obj["number"],
            format=obj["format"],
            ttl_seconds=obj["ttl"],
        )
        return json.dumps({"url": url}).encode()
    except (ValueError, TypeError, KeyError, BillingArtifact.DoesNotExist):
        raise IntegrityRefusedError("billing_gateway_refused") from None
