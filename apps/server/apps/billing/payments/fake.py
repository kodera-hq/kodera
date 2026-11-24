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
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from .port import (
    CONNECT_ACCOUNT_ID,
    ConnectAccountSnapshot,
    ConnectOnboardingLink,
    EventRejectedError,
    LinkRequest,
    ProviderEvent,
    ProviderLink,
    ProviderRefusedError,
    ProviderUnavailableError,
)
from .stripe import API_VERSION, SIGNATURE_HEADER as STRIPE_SIGNATURE_HEADER

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


class FakePaymentsAdapter(FakeProvider):
    """Offline deterministic adapter for Volet A boosts, Volet B Connect splits, and webhooks."""

    def __init__(
        self,
        *,
        secret: bytes = b"synthetic-fake-adapter-secret-32b",
        stripe_webhook_secret: str | None = None,
    ) -> None:
        super().__init__(secret=secret)
        self.stripe_webhook_secret = stripe_webhook_secret or (
            "whsec_" + "synthetic_offline_test_secret"
        )
        self.connect_accounts: dict[str, ConnectAccountSnapshot] = {}
        self.connect_by_idempotency: dict[str, str] = {}
        self.onboarding_links: list[tuple[str, str, str]] = []
        self.fail_next_connect_create_timeout = False
        self._seq = 0

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def create_link(self, request: LinkRequest) -> ProviderLink:
        if request.connect_destination_account is not None:
            acct = self.connect_accounts.get(request.connect_destination_account)
            if acct is not None and not acct.charges_enabled:
                raise ProviderRefusedError("connected account cannot accept charges")
        self.links.append(request)
        seq = self._next_seq()
        reference = f"cs_fake_{seq:06d}"
        return ProviderLink(
            provider_ref=reference,
            url=f"https://pay.fake.invalid/checkout/{reference}",
            expires_at=request.expires_at,
        )

    def create_connect_account(
        self,
        *,
        idempotency_key: str,
        country: str,
        seller_legal_name: str,
        workspace_id: str,
    ) -> ConnectAccountSnapshot:
        del country, seller_legal_name
        if self.fail_next_connect_create_timeout:
            self.fail_next_connect_create_timeout = False
            raise ProviderUnavailableError("simulated timeout before Connect account response")
        existing_id = self.connect_by_idempotency.get(idempotency_key)
        if existing_id is not None:
            return self.connect_accounts[existing_id]
        seq = self._next_seq()
        account_id = f"acct_fake{seq:06d}"
        snapshot = ConnectAccountSnapshot(
            account_id=account_id,
            charges_enabled=False,
            payouts_enabled=False,
            details_submitted=False,
            restricted_reason="requirements.past_due",
            metadata={"kodera_workspace_id": workspace_id},
        )
        self.connect_accounts[account_id] = snapshot
        self.connect_by_idempotency[idempotency_key] = account_id
        return snapshot

    def set_connect_account_state(
        self,
        account_id: str,
        *,
        charges_enabled: bool,
        payouts_enabled: bool,
        details_submitted: bool,
        restricted_reason: str | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> ConnectAccountSnapshot:
        if not CONNECT_ACCOUNT_ID.fullmatch(account_id):
            raise ProviderRefusedError("invalid Connect account id")
        previous = self.connect_accounts.get(account_id)
        resolved_meta = (
            dict(metadata)
            if metadata is not None
            else (dict(previous.metadata) if previous is not None else {})
        )
        snapshot = ConnectAccountSnapshot(
            account_id=account_id,
            charges_enabled=charges_enabled,
            payouts_enabled=payouts_enabled,
            details_submitted=details_submitted,
            restricted_reason=restricted_reason,
            metadata=resolved_meta,
        )
        self.connect_accounts[account_id] = snapshot
        return snapshot

    def retrieve_connect_account(self, account_id: str) -> ConnectAccountSnapshot:
        snapshot = self.connect_accounts.get(account_id)
        if snapshot is None:
            raise ProviderRefusedError("unknown Connect account")
        return snapshot

    def create_connect_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ) -> ConnectOnboardingLink:
        if account_id not in self.connect_accounts:
            raise ProviderRefusedError("Connect account must be persisted before onboarding link")
        self.onboarding_links.append((account_id, refresh_url, return_url))
        return ConnectOnboardingLink(
            url=f"https://connect.fake.invalid/setup/{account_id}",
            expires_at=datetime.now(UTC) + timedelta(minutes=15),
        )

    def build_signed_stripe_webhook(
        self,
        *,
        event_id: str,
        event_type: str,
        data_object: Mapping[str, Any],
        created_ts: int,
        api_version: str = API_VERSION,
        livemode: bool = False,
    ) -> tuple[bytes, dict[str, str]]:
        """Build an offline HMAC-SHA256 signed Stripe webhook payload + `Stripe-Signature` header."""
        raw_body = json.dumps(
            {
                "id": event_id,
                "type": event_type,
                "api_version": api_version,
                "created": created_ts,
                "livemode": livemode,
                "data": {"object": dict(data_object)},
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        sig = hmac.new(
            self.stripe_webhook_secret.encode("utf-8"),
            f"{created_ts}.".encode("ascii") + raw_body,
            hashlib.sha256,
        ).hexdigest()
        return raw_body, {STRIPE_SIGNATURE_HEADER: f"t={created_ts},v1={sig}"}
