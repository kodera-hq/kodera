# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Opt-in PA transport for already-issued legal documents; no invoice authority or SDK."""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import math
import os
import secrets
import ssl
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Protocol
from urllib.parse import urlsplit

from apps.billing.facturx_pdfa_validator import validate_facturx_pdfa3b

from ee.billing import require_enterprise_edition

MAX_RESPONSE = 2 * 1024 * 1024
PRODUCTION = "https://thirdparty.qonto.com"
SANDBOX = "https://thirdparty-sandbox.staging.qonto.co"


def _identifier(value: object) -> bool:
    """Equivalent to the provider's anchored ASCII identifier grammar, without regexes."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 128
        and value.isascii()
        and all(char.isalnum() or char in "_-" for char in value)
    )


def _prefix(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.endswith("-")
        and 2 <= len(value[:-1]) <= 8
        and value[:-1].isascii()
        and value[:-1].isalpha()
        and value[:-1].isupper()
    )


def _number(value: str, prefix: str) -> bool:
    suffix = value.removeprefix(prefix)
    return (
        value.startswith(prefix)
        and len(suffix) == 10
        and suffix[4] == "-"
        and suffix[:4].isascii()
        and suffix[:4].isdigit()
        and suffix[5:].isascii()
        and suffix[5:].isdigit()
    )


class QontoConfigError(ValueError):
    """Missing or unsafe operator configuration, without secret values."""


class QontoTransientError(Exception):
    def __init__(self, *, status: int | None = None, retry_after: int | None = None) -> None:
        self.status, self.retry_after = status, retry_after
        super().__init__("qonto_temporarily_unavailable")


class QontoPermanentError(Exception):
    def __init__(self, *, status: int | None = None) -> None:
        self.status = status
        super().__init__("qonto_request_refused")


@dataclass(frozen=True, init=False)
class QontoPaConfig:
    enabled: bool
    base_url: str
    token: str = field(repr=False)
    timeout_seconds: float
    invoice_prefix: str

    def __init__(
        self,
        *,
        enabled: bool | None = None,
        base_url: str | None = None,
        token: str | None = None,
        timeout_seconds: float | None = None,
        allow_sandbox: bool = False,
        invoice_prefix: str = "KOD-",
    ) -> None:
        try:
            raw_enabled = (
                os.environ.get("QONTO_EINVOICING_ENABLED", "false") if enabled is None else enabled
            )
            if type(raw_enabled) not in (bool, str) or raw_enabled not in (
                True,
                False,
                "true",
                "false",
            ):
                raise ValueError
            active = raw_enabled is True or raw_enabled == "true"
            url = os.environ.get("QONTO_EINVOICING_BASE_URL", "") if base_url is None else base_url
            secret = os.environ.get("KODERA_QONTO_PA_TOKEN", "") if token is None else token
            timeout = float(
                os.environ.get("QONTO_EINVOICING_TIMEOUT_SECONDS", "10")
                if timeout_seconds is None
                else timeout_seconds
            )
            parts = urlsplit(url)
            allowed = {urlsplit(PRODUCTION).hostname}
            if allow_sandbox is True:
                allowed.add(urlsplit(SANDBOX).hostname)
            safe_url = (
                parts.scheme == "https"
                and parts.hostname in allowed
                and parts.username is None
                and parts.password is None
                and parts.port in (None, 443)
                and parts.path in {"", "/"}
                and not parts.query
                and not parts.fragment
                and not any(ord(c) <= 32 for c in url)
                and "?" not in url
                and "#" not in url
            )
            if (
                not math.isfinite(timeout)
                or not 0 < timeout <= 10
                or not isinstance(secret, str)
                or (not active and secret)
                or (active and (not safe_url or not secret))
                or (url and not safe_url)
                or (
                    secret
                    and (len(secret) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in secret))
                )
                or not _prefix(invoice_prefix)
                or invoice_prefix in {"QONTO-", "INV-", "AV-"}
            ):
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise QontoConfigError("qonto_configuration_invalid") from None
        object.__setattr__(self, "enabled", active)
        object.__setattr__(self, "base_url", "https://" + str(parts.hostname) if url else "")
        object.__setattr__(self, "token", secret)
        object.__setattr__(self, "timeout_seconds", timeout)
        object.__setattr__(self, "invoice_prefix", invoice_prefix)


class QontoTransport(Protocol):
    def __call__(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


def _transport(
    *, method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float
) -> tuple[int, Mapping[str, str], bytes]:
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.hostname is None
        or parts.hostname not in {urlsplit(PRODUCTION).hostname, urlsplit(SANDBOX).hostname}
        or parts.port not in (None, 443)
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
    ):
        raise QontoPermanentError()
    host: str = parts.hostname
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(host, timeout=timeout, context=context)
    response = None
    try:
        connection.request(
            method,
            parts.path,
            body=body,
            headers={**headers, "Accept-Encoding": "identity", "Connection": "close"},
        )
        response = connection.getresponse()
        payload = response.read(MAX_RESPONSE + 1)
        if (
            len(payload) > MAX_RESPONSE
            or response.getheader("Content-Encoding", "identity").lower() != "identity"
        ):
            raise QontoPermanentError()
        return response.status, dict(response.getheaders()), payload
    finally:
        if response is not None:
            response.close()
        connection.close()


def _retry_after(headers: Mapping[str, str]) -> int | None:
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), "")
    try:
        seconds = (
            int(value)
            if (1 <= len(value) <= 9 and value.isascii() and value.isdigit())
            else int((parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds())
        )
        return max(0, min(86400, seconds))
    except (ValueError, TypeError, OverflowError):
        return None


class QontoPaClient:
    def __init__(
        self,
        config: QontoPaConfig | None = None,
        *,
        transport: QontoTransport = _transport,
        **config_args: Any,
    ) -> None:
        self.config = config if config is not None else QontoPaConfig(**config_args)
        self.transport = transport

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str = "application/json",
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        require_enterprise_edition()
        if not self.config.enabled:
            raise QontoConfigError("qonto_disabled")
        headers = {
            "Authorization": "Bearer " + self.config.token,
            "Accept": "application/json",
            "Content-Type": content_type,
        }
        if method == "POST":
            if not isinstance(idempotency_key, str) or not _identifier(idempotency_key):
                raise QontoPermanentError()
            headers["X-Qonto-Idempotency-Key"] = idempotency_key
        try:
            status, response_headers, payload = self.transport(
                method=method,
                url=self.config.base_url + path,
                headers=headers,
                body=body,
                timeout=self.config.timeout_seconds,
            )
        except ssl.SSLCertVerificationError:
            raise QontoPermanentError() from None
        except ssl.SSLError:
            raise QontoPermanentError() from None
        except (OSError, http.client.HTTPException):
            raise QontoTransientError() from None
        except Exception:
            raise QontoPermanentError() from None
        if status == 429 or status in {500, 502, 503, 504}:
            raise QontoTransientError(
                status=status, retry_after=_retry_after(response_headers) if status == 429 else None
            )
        if not 200 <= status < 300 or not isinstance(payload, bytes) or len(payload) > MAX_RESPONSE:
            raise QontoPermanentError(status=status)
        if status == 204:
            return {}
        try:
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError
            return result
        except (ValueError, TypeError, RecursionError):
            raise QontoPermanentError(status=status) from None

    def get_einvoicing_settings(self) -> dict[str, Any]:
        return self._request("GET", "/v2/einvoicing/settings")

    def submit_client_invoices_bulk(
        self, invoices: Sequence[bytes], *, idempotency_key: str, require_ledger_match: bool = True
    ) -> dict[str, Any]:
        """Upload 1..5 immutable Factur-X PDFs using Qonto's multipart client_invoices field."""
        require_enterprise_edition()
        from apps.billing.documents import NS
        from apps.billing.rendering import _xml_parser
        from django.conf import settings
        from lxml import etree
        from pypdf import PdfReader

        try:
            if (
                isinstance(invoices, (bytes, str))
                or not 1 <= len(invoices) <= 5
                or sum(len(pdf) for pdf in invoices) > 15_000_000
            ):
                raise ValueError
            parts = []
            numbers: set[str] = set()
            if type(require_ledger_match) is not bool or (
                not require_ledger_match and getattr(settings, "KODERA_INVOICE_SERIES", "") != "TST"
            ):
                raise ValueError
            boundary = "billing-" + secrets.token_hex(24)
            for pdf in invoices:
                if not isinstance(pdf, bytes) or len(pdf) > 5_000_000:
                    raise ValueError
                validate_facturx_pdfa3b(pdf)
                xml = PdfReader(io.BytesIO(pdf), strict=True).attachments["factur-x.xml"][0]
                root = etree.fromstring(xml, parser=_xml_parser())
                number = root.findtext("rsm:ExchangedDocument/ram:ID", namespaces=NS)
                type_code = root.findtext("rsm:ExchangedDocument/ram:TypeCode", namespaces=NS)
                prefix = (
                    self.config.invoice_prefix
                    if type_code == "380"
                    else self.config.invoice_prefix.rstrip("-") + "-AV-"
                )
                if (
                    type_code not in {"380", "381"}
                    or not isinstance(number, str)
                    or not _number(number, prefix)
                    or number in numbers
                ):
                    raise ValueError
                numbers.add(number)
                if require_ledger_match:
                    from apps.billing.artifacts import verify_artifact
                    from apps.billing.models import BillingArtifact

                    parent = "invoice" if type_code == "380" else "credit_note"
                    artifact = BillingArtifact.objects.select_related(parent).get(
                        **{parent + "__number": number}
                    )
                    verify_artifact(artifact)
                    if hashlib.sha256(pdf).hexdigest() != artifact.pdf_sha256:
                        raise ValueError
                parts.append(
                    f'--{boundary}\r\nContent-Disposition: form-data; name="client_invoices"; filename="{number}.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()
                    + pdf
                    + b"\r\n"
                )
            body = b"".join(parts) + f"--{boundary}--\r\n".encode()
            if len(body) > 15_000_000:
                raise ValueError
        except Exception:
            raise QontoPermanentError() from None
        return self._request(
            "POST",
            "/v2/client_invoices/bulk",
            body=body,
            content_type="multipart/form-data; boundary=" + boundary,
            idempotency_key=idempotency_key,
        )

    def send_by_einvoice(self, client_invoice_id: str, *, idempotency_key: str) -> dict[str, Any]:
        require_enterprise_edition()
        if not isinstance(client_invoice_id, str) or not _identifier(client_invoice_id):
            raise QontoPermanentError()
        return self._request(
            "POST",
            f"/v2/client_invoices/{client_invoice_id}/send_by_einvoice",
            idempotency_key=idempotency_key,
        )
