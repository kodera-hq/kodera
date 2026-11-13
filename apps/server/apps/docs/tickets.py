"""Application-key tickets shared with the separately deployed collaboration service."""

import base64
import hmac
import json
from datetime import timedelta
from uuid import UUID, uuid4

from django.conf import settings
from django.utils import timezone

from apps.orgs.actor_selectors import TenantCaller
from services.identity.access_tokens import VerifiedAccessToken

from .errors import RefusalError


def key() -> bytes:
    value = getattr(settings, "KODERA_COLLAB_TICKET_KEY", None)
    if not isinstance(value, bytes) or len(value) != 32:
        raise RefusalError(503, "service-unavailable")
    return value


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def mint(
    *, principal: TenantCaller, verified: VerifiedAccessToken, document_id: UUID, role: str
) -> tuple[str, str]:
    now = timezone.now().replace(microsecond=0)
    expires = now + timedelta(seconds=300)
    claims = {
        "v": 1,
        "organisation": str(principal.organisation_id),
        "document": str(document_id),
        "membership": str(principal.membership_id),
        "identity": str(principal.identity_id),
        "issuer": verified.issuer,
        "subject": verified.subject,
        "role": role,
        "issued": int(now.timestamp()),
        "expires": int(expires.timestamp()),
        "nonce": str(uuid4()),
    }
    body = encode(
        json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    )
    signature = encode(hmac.digest(key(), body.encode(), "sha256"))
    token = body + "." + signature
    if len(token) > 4096 or role not in {"editor", "viewer"}:
        raise RefusalError(503, "service-unavailable")
    return token, expires.isoformat()
