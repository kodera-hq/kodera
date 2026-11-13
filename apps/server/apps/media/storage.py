"""Strict object descriptors and short-lived S3 signatures, used only by the media worker."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import quote, urlencode, urlsplit
from uuid import UUID

ALLOWED_TYPES = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "application/octet-stream",
    }
)
MAX_BYTES = 25 * 1024 * 1024
EXPIRY_SECONDS = 300


class StorageRefusedError(ValueError):
    def __init__(self) -> None:
        super().__init__("object-storage operation refused")


class ObjectMismatchError(StorageRefusedError):
    """The provider's actual object differs from the accepted upload descriptor."""


def filename(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 255:
        raise StorageRefusedError()
    value = unicodedata.normalize("NFC", value)
    if value in {".", ".."} or any(
        c in "/\\" or unicodedata.category(c).startswith("C") for c in value
    ):
        raise StorageRefusedError()
    return value


def disposition(value: str) -> str:
    # Every download is an attachment. A filename never becomes a header delimiter.
    return "attachment; filename=\"attachment\"; filename*=UTF-8''" + quote(
        filename(value), safe=""
    )


@dataclass(frozen=True)
class ObjectDescriptor:
    organisation_id: UUID
    attachment_id: UUID
    filename: str
    content_type: str
    size_bytes: int
    sha256: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.organisation_id, UUID)
            or not isinstance(self.attachment_id, UUID)
            or not isinstance(self.content_type, str)
            or self.content_type not in ALLOWED_TYPES
            or type(self.size_bytes) is not int
            or not 1 <= self.size_bytes <= MAX_BYTES
            or not isinstance(self.sha256, str)
            or re.fullmatch(r"[a-f0-9]{64}", self.sha256) is None
        ):
            raise StorageRefusedError()
        filename(self.filename)

    @property
    def key(self) -> str:
        return f"organisations/{self.organisation_id}/attachments/{self.attachment_id}"

    @property
    def checksum(self) -> str:
        return base64.b64encode(bytes.fromhex(self.sha256)).decode("ascii")


@dataclass(frozen=True)
class S3Credential:
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    session_token: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class S3Location:
    endpoint: str
    bucket: str
    region: str

    def __post_init__(self) -> None:
        from .outbound import target

        destination = target(self.endpoint, https_only=True)
        parsed = urlsplit(self.endpoint)
        if (
            parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.bucket)
            or not re.fullmatch(r"[a-z0-9-]{1,63}", self.region)
        ):
            raise StorageRefusedError()
        object.__setattr__(self, "endpoint", f"https://{destination.authority}")


def _sign(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def presign(
    location: S3Location,
    credential: S3Credential,
    descriptor: ObjectDescriptor,
    *,
    method: str,
    now: datetime,
) -> tuple[str, dict[str, str]]:
    if method not in {"PUT", "GET", "HEAD"} or now.tzinfo is None:
        raise StorageRefusedError()
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", credential.access_key)
        or not credential.secret_key
        or len(credential.secret_key) > 4096
        or (
            credential.session_token is not None
            and (
                not credential.session_token
                or len(credential.session_token) > 8192
                or any(ord(c) <= 32 or ord(c) > 126 for c in credential.session_token)
            )
        )
    ):
        raise StorageRefusedError()
    stamp = now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    scope = f"{date}/{location.region}/s3/aws4_request"
    host = urlsplit(location.endpoint).netloc
    headers = {"host": host}
    if method == "PUT":
        headers.update(
            {
                "content-type": descriptor.content_type,
                "content-length": str(descriptor.size_bytes),
                "x-amz-checksum-sha256": descriptor.checksum,
                "content-disposition": disposition(descriptor.filename),
            }
        )
    if method == "HEAD":
        headers["x-amz-checksum-mode"] = "ENABLED"
    signed_headers = ";".join(sorted(headers))
    parameters = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": credential.access_key + "/" + scope,
        "X-Amz-Date": stamp,
        "X-Amz-Expires": str(EXPIRY_SECONDS),
        "X-Amz-SignedHeaders": signed_headers,
    }
    if credential.session_token:
        parameters["X-Amz-Security-Token"] = credential.session_token
    if method == "GET":
        parameters.update(
            {
                "response-content-type": descriptor.content_type,
                "response-content-disposition": "attachment",
                "response-cache-control": "private, no-store",
            }
        )
    canonical_query = urlencode(sorted(parameters.items()), quote_via=quote, safe="-_.~")
    path = "/" + quote(location.bucket + "/" + descriptor.key, safe="/-_.~")
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in sorted(headers))
    canonical = "\n".join(
        (method, path, canonical_query, canonical_headers, signed_headers, "UNSIGNED-PAYLOAD")
    )
    to_sign = "\n".join(
        ("AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest())
    )
    key = _sign(("AWS4" + credential.secret_key).encode(), date)
    for part in (location.region, "s3", "aws4_request"):
        key = _sign(key, part)
    signature = _sign(key, to_sign).hex()
    return (
        location.endpoint + path + "?" + canonical_query + "&X-Amz-Signature=" + signature,
        {name: value for name, value in headers.items() if name != "host"},
    )
