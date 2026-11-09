"""The Stripe adapter of the payment port: Checkout for card and SEPA Direct Debit, signed webhooks.

Core issues the invoice, numbers it and computes its VAT; Stripe only collects. So a payment link
is a Stripe Checkout Session in `payment` mode for the amount Core owes, card and `sepa_debit`,
with Core's invoice id in its metadata, and a Stripe Customer created by Checkout for the payer.
Stripe Billing's own invoices and subscriptions are not used: they would issue a second legal
document with Stripe's numbering beside Core's, and Stripe Tax is out of scope.

A delivery is verified by its `Stripe-Signature` (HMAC-SHA256 over `<timestamp>.<body>` with the
endpoint secret), refused outside a five-minute window so a captured delivery cannot be replayed,
and turned into a port event, or into nothing for a type reconciliation does not act on:

| Stripe event | Port event |
|---|---|
| `checkout.session.completed` with `payment_status = paid` (card) | `payment.succeeded` |
| `checkout.session.completed` otherwise (SEPA submitted, not settled) | `payment.processing` |
| `checkout.session.async_payment_succeeded` (SEPA settled) | `payment.succeeded` |
| `checkout.session.async_payment_failed` (SEPA failed) | `payment.failed` |
| `charge.refunded` | `payment.reversed` for the amount refunded (a partial one is a mismatch) |
| `charge.dispute.created` (not an inquiry, `warning_*`) | `payment.reversed` |
| `charge.dispute.funds_reinstated` (a dispute won) | `payment.reinstated`, for a person |

Stripe does not deliver in order and stamps whole seconds; reconciliation orders by `created` and
treats duplicates, so the adapter does neither. No key is in the code or the tree: the secret key
and the endpoint secret come from settings, empty unless the environment sets them.
"""

import hashlib
import hmac
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from .port import (
    EventRejectedError,
    LinkRequest,
    ProviderEvent,
    ProviderLink,
    ProviderRefusedError,
    ProviderUnavailableError,
    ReturnUrlRequiredError,
)

API = "https://api.stripe.com/v1"
# Pinned so a change of Stripe's default API version changes nothing here until it is reviewed. The
# webhook endpoint is created at the same version: an event of another version is refused, its
# payload not being the shape translated here. To review before the first live key.
API_VERSION = "2024-06-20"
SIGNATURE_HEADER = "Stripe-Signature"
TOLERANCE_S = 300
# Stripe keeps a Checkout Session open for at most 24 hours.
MAX_SESSION = timedelta(hours=23, minutes=55)
TIMEOUT_S = 10
# The one line of an invoice's payment, as the payer reads it on Stripe's page.
LINE_ITEM = {"fr": "Facture {number}", "en": "Invoice {number}"}
# A withdrawal Stripe answers with one of these has nothing left to withdraw: the session is
# already completed, expired or gone. Any other refusal (a revoked or under-scoped key) is raised.
CLOSED = frozenset(
    {
        (400, "checkout_session_not_open"),
        (400, "checkout_session_expired"),
        (404, "resource_missing"),
    }
)

# (method, url, headers, body) -> (status, body): urllib in production, a stub in tests.
Transport = Callable[[str, str, Mapping[str, str], bytes], tuple[int, bytes]]


class StripeRefusedError(ProviderRefusedError):
    """Stripe's refusal, with its status and error type (never its message)."""

    def __init__(self, status: int, error_type: str | None, code: str | None) -> None:
        super().__init__(f"Stripe refused: {status} {error_type} {code}")
        self.status = status
        self.error_type = error_type
        self.code = code


def _urllib(method: str, url: str, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body or None, method=method, headers=dict(headers))  # noqa: S310 - the URL is API, a constant
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310
            return int(response.status), bytes(response.read())
    except urllib.error.HTTPError as answered:
        return int(answered.code), bytes(answered.read())
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
        raise ProviderUnavailableError("Stripe did not answer") from None


class StripeProvider:
    name = "stripe"

    def __init__(
        self,
        *,
        secret_key: str,
        webhook_secret: str,
        transport: Transport | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        # A restricted key, scoped to Checkout Sessions: the API process holds no key that can
        # refund or pay out.
        if not secret_key.startswith("rk_") or not webhook_secret.startswith("whsec_"):
            raise ValueError("the Stripe keys are a restricted key and an endpoint secret")
        self._secret_key = secret_key
        self._webhook_secret = webhook_secret
        self._transport = transport or _urllib
        self._clock = clock

    # --- outbound --------------------------------------------------------------------------------

    def _call(self, method: str, path: str, params: list[tuple[str, str]]) -> dict[str, Any]:
        body = urllib.parse.urlencode(params).encode()
        headers = {
            "Authorization": f"Bearer {self._secret_key}",
            "Stripe-Version": API_VERSION,
            "Content-Type": "application/x-www-form-urlencoded",
            # Nothing retries a call yet; the key names each one in Stripe's request log.
            "Idempotency-Key": f"core-{uuid4()}",
        }
        status, answer = self._transport(method, API + path, headers, body)
        if status >= 500 or status == 429:
            raise ProviderUnavailableError(f"Stripe answered {status}")
        try:
            decoded = json.loads(answer)
        except ValueError:
            raise ProviderUnavailableError("Stripe answered something that is not JSON") from None
        if not isinstance(decoded, dict):
            raise ProviderUnavailableError("Stripe answered JSON that is not an object")
        if status >= 400:
            # Stripe's error type and code only: its message may echo request parameters.
            error = decoded.get("error")
            error = error if isinstance(error, dict) else {}
            raise StripeRefusedError(status, error.get("type"), error.get("code"))
        return decoded

    def create_link(self, request: LinkRequest) -> ProviderLink:
        if request.return_url is None:
            raise ReturnUrlRequiredError(
                "a Stripe Checkout Session needs the URL the payer returns to"
            )
        now = datetime.fromtimestamp(self._clock(), UTC)
        expires_at = min(request.expires_at, now + MAX_SESSION)
        invoice = str(request.invoice_id)
        name = LINE_ITEM.get(request.locale, LINE_ITEM["fr"]).format(number=request.invoice_number)
        session = self._call(
            "POST",
            "/checkout/sessions",
            [
                ("mode", "payment"),
                ("payment_method_types[0]", "card"),
                ("payment_method_types[1]", "sepa_debit"),
                ("line_items[0][quantity]", "1"),
                ("line_items[0][price_data][currency]", request.currency.lower()),
                ("line_items[0][price_data][unit_amount]", str(request.amount_minor)),
                ("line_items[0][price_data][product_data][name]", name),
                ("customer_creation", "always"),
                ("client_reference_id", invoice),
                ("metadata[core_invoice_id]", invoice),
                ("payment_intent_data[metadata][core_invoice_id]", invoice),
                ("locale", request.locale),
                ("success_url", request.return_url),
                ("cancel_url", request.return_url),
                ("expires_at", str(int(expires_at.timestamp()))),
            ],
        )
        try:
            return ProviderLink(
                provider_ref=str(session["id"]),
                url=str(session["url"]),
                expires_at=datetime.fromtimestamp(int(session["expires_at"]), UTC),
            )
        except (KeyError, TypeError, ValueError):
            raise ProviderUnavailableError(
                "Stripe answered a session without id, url or expiry"
            ) from None

    def cancel_link(self, provider_ref: str) -> None:
        path = f"/checkout/sessions/{urllib.parse.quote(provider_ref, safe='')}/expire"
        try:
            self._call("POST", path, [])
        except StripeRefusedError as refused:
            if (refused.status, refused.code) not in CLOSED:
                raise

    # --- inbound ---------------------------------------------------------------------------------

    def _verify(self, body: bytes, header: str) -> None:
        timestamp, signatures = None, []
        for part in header.split(","):
            key, _, value = part.strip().partition("=")
            if key == "t":
                timestamp = value
            elif key == "v1":
                signatures.append(value)
        if timestamp is None or not timestamp.isdigit() or not signatures:
            raise EventRejectedError("the signature header is malformed")
        expected = hmac.new(
            self._webhook_secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
        ).hexdigest()
        # Bytes, not strings: compare_digest refuses a non-ASCII string with a TypeError.
        digest = expected.encode()
        if not any(
            hmac.compare_digest(digest, candidate.encode("utf-8", "replace"))
            for candidate in signatures
        ):
            raise EventRejectedError("the signature does not verify")
        if abs(self._clock() - int(timestamp)) > TOLERANCE_S:
            raise EventRejectedError("the delivery is outside the replay window")

    def parse_event(self, *, body: bytes, headers: Mapping[str, str]) -> ProviderEvent | None:
        header = next(
            (value for name, value in headers.items() if name.lower() == SIGNATURE_HEADER.lower()),
            "",
        )
        self._verify(body, header)
        try:
            event = json.loads(body)
            kind = str(event["type"])
            version = event.get("api_version")
            occurred_at = datetime.fromtimestamp(int(event["created"]), UTC)
            event_id = str(event["id"])
            data = event["data"]["object"]
        except (ValueError, KeyError, TypeError):
            raise EventRejectedError("the event is malformed") from None
        if version != API_VERSION:
            raise EventRejectedError("the event is of another Stripe API version")
        try:
            return _translate(kind, event_id, occurred_at, data)
        except (KeyError, TypeError, ValueError):
            raise EventRejectedError(f"the {kind} event is malformed") from None


def _translate(
    kind: str, event_id: str, occurred_at: datetime, data: Mapping[str, Any]
) -> ProviderEvent | None:
    if kind.startswith("checkout.session."):
        port_kind = {
            # Paid by card at once; a SEPA debit is submitted now and settles later.
            "checkout.session.completed": (
                "payment.succeeded"
                if data.get("payment_status") == "paid"
                else "payment.processing"
            ),
            "checkout.session.async_payment_succeeded": "payment.succeeded",
            "checkout.session.async_payment_failed": "payment.failed",
        }.get(kind)
        if port_kind is None:
            return None
        if not data.get("payment_intent"):
            # A session that took money always names its payment intent; one still unpaid may not.
            if port_kind == "payment.processing":
                return None
            raise KeyError("payment_intent")
        return ProviderEvent(
            event_id=event_id,
            kind=port_kind,
            payment_ref=str(data["payment_intent"]),
            link_ref=str(data["id"]),
            amount_minor=int(data["amount_total"]),
            currency=str(data["currency"]).upper(),
            occurred_at=occurred_at,
            customer_ref=str(data["customer"]) if data.get("customer") else None,
        )
    if kind == "charge.dispute.created" and str(data.get("status", "")).startswith("warning_"):
        # An inquiry withdraws no funds; only a dispute that does reverses the payment.
        return None
    if kind in ("charge.refunded", "charge.dispute.created", "charge.dispute.funds_reinstated"):
        if not data.get("payment_intent"):
            raise KeyError("payment_intent")
        # For a refund, the amount refunded so far: a partial refund differs from the payment's
        # amount and is recorded as a mismatch for a person to allocate, never applied as a full
        # reversal. A dispute won is for a person too.
        amount = data["amount_refunded"] if kind == "charge.refunded" else data["amount"]
        return ProviderEvent(
            event_id=event_id,
            kind="payment.reinstated" if kind.endswith("funds_reinstated") else "payment.reversed",
            payment_ref=str(data["payment_intent"]),
            link_ref=None,
            amount_minor=int(amount),
            currency=str(data["currency"]).upper(),
            occurred_at=occurred_at,
        )
    return None
