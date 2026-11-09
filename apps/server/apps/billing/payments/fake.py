"""The fake payment provider: the only adapter until the provider is chosen.

It moves no money and calls nothing. A link is a URL under `.invalid` (RFC 2606), which no browser
can reach. Its webhook body is JSON signed with HMAC-SHA256 under a test-only secret, so the
reconciliation is exercised through the same signature refusal a real adapter needs. `deliver`
builds such a delivery for a test.
"""

import hashlib
import hmac
import json
from collections.abc import Mapping
from datetime import datetime
from uuid import uuid4

from .port import EventRejectedError, LinkRequest, ProviderEvent, ProviderLink

SIGNATURE_HEADER = "X-Fake-Signature"


class FakeProvider:
    name = "fake"

    def __init__(self, *, secret: bytes) -> None:
        if len(secret) < 16:
            raise ValueError("the fake provider's secret is at least 16 bytes")
        self._secret = secret
        self.links: list[LinkRequest] = []
        self.cancelled: list[str] = []

    def create_link(self, request: LinkRequest) -> ProviderLink:
        self.links.append(request)
        reference = f"fake_link_{uuid4().hex}"
        return ProviderLink(provider_ref=reference, url=f"https://pay.fake.invalid/{reference}")

    def cancel_link(self, provider_ref: str) -> None:
        self.cancelled.append(provider_ref)

    def _signature(self, body: bytes) -> str:
        return hmac.new(self._secret, body, hashlib.sha256).hexdigest()

    def parse_event(self, *, body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        supplied = headers.get(SIGNATURE_HEADER, "")
        if not hmac.compare_digest(supplied, self._signature(body)):
            raise EventRejectedError("the signature does not verify")
        try:
            data = json.loads(body)
            return ProviderEvent(
                event_id=str(data["id"]),
                kind=str(data["type"]),
                payment_ref=str(data["payment"]),
                link_ref=None if data.get("link") is None else str(data["link"]),
                amount_minor=int(data["amount"]),
                currency=str(data["currency"]),
                occurred_at=datetime.fromisoformat(data["occurred_at"]),
            )
        except (ValueError, KeyError, TypeError) as malformed:
            raise EventRejectedError(f"malformed event: {type(malformed).__name__}") from None

    def deliver(
        self,
        *,
        event_id: str,
        kind: str,
        payment_ref: str,
        amount_minor: int,
        occurred_at: datetime,
        link_ref: str | None = None,
        currency: str = "EUR",
    ) -> tuple[bytes, dict[str, str]]:
        """A signed webhook delivery, as the provider would post it."""
        body = json.dumps(
            {
                "id": event_id,
                "type": kind,
                "payment": payment_ref,
                "link": link_ref,
                "amount": amount_minor,
                "currency": currency,
                "occurred_at": occurred_at.isoformat(),
            },
            separators=(",", ":"),
        ).encode()
        return body, {SIGNATURE_HEADER: self._signature(body)}
