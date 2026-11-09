"""The payment-provider port: what Core asks of a provider, and what a provider tells Core.

The provider is not chosen yet, so Core depends on this port only. An adapter creates a payment
link for one invoice and turns a delivered webhook into a `ProviderEvent`, refusing one whose
signature it cannot verify. Core never sends or stores a card number, an IBAN or a provider
secret; it keeps the provider's references (docs/domain/BILLING_MODEL.md §8).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

EVENT_KINDS = (
    "payment.processing",
    "payment.succeeded",
    "payment.failed",
    "payment.reversed",
    "payment.reinstated",
)


@dataclass(frozen=True, slots=True)
class LinkRequest:
    invoice_id: UUID
    invoice_number: str
    amount_minor: int
    currency: str
    expires_at: datetime
    return_url: str | None
    locale: str


@dataclass(frozen=True, slots=True)
class ProviderLink:
    """The link as the provider created it; `expires_at` when it keeps it open for less than asked."""

    provider_ref: str
    url: str
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ProviderEvent:
    """One fact the provider reports about one payment.

    `payment.processing` is a debit submitted and not yet settled (SEPA); `payment.reversed` is
    money returned after a success, a refund or a chargeback; `payment.reinstated` is money a
    chargeback took that came back (a dispute won). `occurred_at` is the provider's clock, the
    order reconciliation applies events in. `customer_ref` is the provider's customer, when the
    event names one: recurring collection will charge it again.
    """

    event_id: str
    kind: str
    payment_ref: str
    link_ref: str | None
    amount_minor: int
    currency: str
    occurred_at: datetime
    customer_ref: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in EVENT_KINDS:
            raise EventRejectedError(f"{self.kind!r} is not a payment event")
        if not self.event_id or not self.payment_ref:
            raise EventRejectedError("an event names itself and its payment")
        if self.amount_minor <= 0:
            raise EventRejectedError("an event's amount is positive")
        if self.occurred_at.tzinfo is None:
            raise EventRejectedError("an event's time carries an offset")


class EventRejectedError(Exception):
    """The delivery is not an authentic, well-formed event: nothing is recorded."""


class ProviderRefusedError(Exception):
    """The provider refused the request (a 4xx): a defect or a configuration error, never retried."""


class ReturnUrlRequiredError(ProviderRefusedError):
    """The provider cannot issue a link without the URL the payer returns to: refused before any
    call, so the client can send one (`400`, pointer `/return_url`)."""


class ProviderUnavailableError(Exception):
    """No provider is configured, or it did not answer: `502 upstream-unavailable`."""


class ProviderNotConfiguredError(ProviderUnavailableError):
    """This process has no provider of that name configured: nothing was asked. Told apart from a
    provider that did not answer, which is an outage rather than a deployment's choice."""


class PaymentProvider(Protocol):
    name: str

    def create_link(self, request: LinkRequest) -> ProviderLink: ...

    def cancel_link(self, provider_ref: str) -> None: ...

    def parse_event(self, *, body: bytes, headers: Mapping[str, str]) -> ProviderEvent | None:
        """The verified delivery as a port event, or None for a type reconciliation ignores."""
        ...
