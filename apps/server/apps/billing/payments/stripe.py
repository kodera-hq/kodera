"""The Stripe adapter of the payment port: Checkout for card and SEPA Direct Debit, signed webhooks.

Core issues the invoice, numbers it and computes its VAT; Stripe only collects. So a payment link
is a Stripe Checkout Session in `payment` mode for the amount Core owes, card and `sepa_debit` (or
card-only for instant-activation Volet A boosts and Volet B Connect passes), with Core's invoice id
in its metadata when settling a Core invoice, and a Stripe Customer created by Checkout for the
payer. Stripe Billing's own invoices and subscriptions are not used: they would issue a second
legal document with Stripe's numbering beside Core's, and Stripe Tax is out of scope.

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
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from django.conf import settings

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
    ReturnUrlRequiredError,
)

API = "https://api.stripe.com/v1"
# Pinned to the dedicated Kodera Stripe account webhook contract (2025-02-24.acacia) while
# admitting prior reviewed snapshot versions during rolling cutovers.
API_VERSION = "2025-02-24.acacia"
SUPPORTED_EVENT_API_VERSIONS: frozenset[str] = frozenset(
    {
        "2024-06-20",
        "2024-12-18.acacia",
        API_VERSION,
    }
)
SIGNATURE_HEADER = "Stripe-Signature"
TOLERANCE_S = 300
# Stripe keeps a Checkout Session open for at most 24 hours.
MAX_SESSION = timedelta(hours=23, minutes=55)
TIMEOUT_S = 10
# The one line of an invoice's payment, as the payer reads it on Stripe's page.
LINE_ITEM = {"fr": "Facture {number}", "en": "Invoice {number}"}
VIP_LINE_ITEM = {"fr": "Pass VIP {number}", "en": "VIP Pass {number}"}
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
_ACCOUNT_ID_TOKEN_RE = re.compile(r"acct_[A-Za-z0-9_]+")


class StripeAccountPreflightError(ProviderUnavailableError):
    """Transient `/v1/account` preflight failure before any mutating Stripe request is sent."""


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
        expected_account_id: str | None = None,
    ) -> None:
        # A restricted key, scoped to Checkout Sessions: the API process holds no key that can
        # refund or pay out.
        if not secret_key.startswith("rk_") or not webhook_secret.startswith("whsec_"):
            raise ValueError("the Stripe keys are a restricted key and an endpoint secret")
        self._secret_key = secret_key
        self._webhook_secret = webhook_secret
        self._transport = transport or _urllib
        self._clock = clock
        self._expected_account_id = expected_account_id
        self._verified_bindings: set[tuple[str, str]] = set()

    # --- outbound --------------------------------------------------------------------------------

    _PROCESS_VERIFIED_URLLIB_BINDINGS: set[tuple[str, str]] = set()

    def _ensure_account_verified(self) -> None:
        expected_acct = (
            self._expected_account_id
            if self._expected_account_id is not None
            else (
                getattr(settings, "KODERA_STRIPE_PLATFORM_ACCOUNT_ID", None)
                if self._transport is _urllib
                else None
            )
        )
        if self._transport is _urllib and (
            not isinstance(expected_acct, str) or not CONNECT_ACCOUNT_ID.fullmatch(expected_acct)
        ):
            raise ProviderRefusedError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID is not configured")
        if expected_acct is None:
            return
        if not CONNECT_ACCOUNT_ID.fullmatch(expected_acct):
            raise ProviderRefusedError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID is invalid")
        binding = (self._secret_key, expected_acct)
        if binding in self._verified_bindings:
            return
        process_binding = (
            (hashlib.sha256(self._secret_key.encode("utf-8")).hexdigest(), expected_acct)
            if self._transport is _urllib
            else None
        )
        if (
            process_binding is not None
            and process_binding in self._PROCESS_VERIFIED_URLLIB_BINDINGS
        ):
            self._verified_bindings.add(binding)
            return
        headers = {
            "Authorization": f"Bearer {self._secret_key}",
            "Stripe-Version": API_VERSION,
        }
        try:
            status, answer = self._transport("GET", API + "/account", headers, b"")
        except ProviderUnavailableError as exc:
            raise StripeAccountPreflightError(str(exc)) from exc
        if status >= 500 or status == 429:
            raise StripeAccountPreflightError(f"Stripe answered {status}")
        try:
            decoded = json.loads(answer)
        except ValueError:
            raise StripeAccountPreflightError(
                "Stripe answered something that is not JSON"
            ) from None
        if not isinstance(decoded, dict):
            raise StripeAccountPreflightError("Stripe answered JSON that is not an object")
        matched = False
        if status == 200 and decoded.get("id") == expected_acct:
            matched = True
        elif status == 403:
            error = decoded.get("error")
            if isinstance(error, dict) and error.get("type") == "invalid_request_error":
                message = error.get("message")
                if (
                    isinstance(message, str)
                    and f"account '{expected_acct}'" in message
                    and set(_ACCOUNT_ID_TOKEN_RE.findall(message)) == {expected_acct}
                ):
                    matched = True
        if not matched:
            raise ProviderRefusedError(
                "Stripe credential does not authenticate as KODERA_STRIPE_PLATFORM_ACCOUNT_ID"
            )
        self._verified_bindings.add(binding)
        if process_binding is not None and len(self._PROCESS_VERIFIED_URLLIB_BINDINGS) < 64:
            self._PROCESS_VERIFIED_URLLIB_BINDINGS.add(process_binding)

    def _call(
        self,
        method: str,
        path: str,
        params: list[tuple[str, str]],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        self._ensure_account_verified()
        if method == "POST" and path == "/checkout/sessions":
            if [value for key, value in params if key == "mode"] != ["payment"] or any(
                key.startswith(("invoice_creation", "automatic_tax", "subscription_data"))
                for key, _value in params
            ):
                raise ValueError("Checkout must preserve Core invoice and tax authority")
        body = urllib.parse.urlencode(params).encode()
        headers = {
            "Authorization": f"Bearer {self._secret_key}",
            "Stripe-Version": API_VERSION,
            "Content-Type": "application/x-www-form-urlencoded",
            # Nothing retries a call yet; the key names each one in Stripe's request log.
            "Idempotency-Key": idempotency_key or f"core-{uuid4()}",
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
        ref_id = str(request.invoice_id)
        if request.checkout_label:
            name = request.checkout_label
        elif request.reference_kind == "vip_pass":
            name = VIP_LINE_ITEM.get(request.locale, VIP_LINE_ITEM["fr"]).format(
                number=request.invoice_number
            )
        else:
            name = LINE_ITEM.get(request.locale, LINE_ITEM["fr"]).format(
                number=request.invoice_number
            )

        params: list[tuple[str, str]] = [("mode", "payment")]
        for idx, pm_type in enumerate(request.payment_methods):
            params.append((f"payment_method_types[{idx}]", pm_type))
        params.extend(
            [
                ("line_items[0][quantity]", "1"),
                ("line_items[0][price_data][currency]", request.currency.lower()),
                ("line_items[0][price_data][unit_amount]", str(request.amount_minor)),
                ("line_items[0][price_data][product_data][name]", name),
                (
                    ("customer", request.customer_ref)
                    if request.customer_ref
                    else ("customer_creation", "always")
                ),
                ("client_reference_id", ref_id),
            ]
        )
        caller_set_project = bool(request.metadata and "samourai_project" in request.metadata)
        effective_metadata: dict[str, str] = {"samourai_project": "kodera"}
        if request.reference_kind == "invoice":
            effective_metadata["core_invoice_id"] = ref_id
        elif request.reference_kind == "extension_marketplace":
            effective_metadata["kodera_checkout_kind"] = "extension_marketplace"
            effective_metadata["kodera_marketplace_entitlement_id"] = ref_id
        if request.metadata:
            for key, value in request.metadata.items():
                effective_metadata[str(key)] = str(value)
        effective_metadata["samourai_project"] = "kodera"
        if request.reference_kind == "extension_marketplace":
            effective_metadata["kodera_checkout_kind"] = "extension_marketplace"
            effective_metadata["kodera_marketplace_entitlement_id"] = ref_id

        params.extend(
            [
                ("locale", request.locale),
                ("success_url", request.return_url),
                ("cancel_url", request.return_url),
                ("expires_at", str(int(expires_at.timestamp()))),
            ]
        )
        if request.connect_destination_account is not None:
            params.append(
                (
                    "payment_intent_data[transfer_data][destination]",
                    request.connect_destination_account,
                )
            )
            params.append(
                (
                    "payment_intent_data[application_fee_amount]",
                    str(request.application_fee_amount_minor),
                )
            )
        for key, value in sorted(effective_metadata.items()):
            lowered = key.lower()
            if "tax" in lowered or "invoice_creation" in lowered:
                raise ProviderRefusedError("forbidden Stripe Checkout parameter")
            params.append((f"metadata[{key}]", value))
            params.append((f"payment_intent_data[metadata][{key}]", value))
        try:
            session = self._call(
                "POST",
                "/checkout/sessions",
                params,
                idempotency_key=request.idempotency_key,
            )
        except StripeRefusedError as refused:
            if request.customer_ref and (
                refused.code == "resource_missing"
                or (refused.status in (400, 404) and refused.error_type == "invalid_request_error")
            ):
                fallback_params = [
                    ("customer_creation", "always") if key == "customer" else (key, val)
                    for key, val in params
                ]
                fallback_idem = (
                    f"{request.idempotency_key}:fresh-customer" if request.idempotency_key else None
                )
                session = self._call(
                    "POST",
                    "/checkout/sessions",
                    fallback_params,
                    idempotency_key=fallback_idem,
                )
            elif (
                refused.error_type == "idempotency_error"
                and request.idempotency_key
                and not caller_set_project
            ):
                # Rolling-upgrade compatibility: if a pre-upgrade worker created a session under
                # `request.idempotency_key` before `samourai_project` was injected and lost the
                # response, replay the original parameter shape under the same idempotency key.
                legacy_params = [
                    (key, val)
                    for key, val in params
                    if key
                    not in (
                        "metadata[samourai_project]",
                        "payment_intent_data[metadata][samourai_project]",
                    )
                ]
                session = self._call(
                    "POST",
                    "/checkout/sessions",
                    legacy_params,
                    idempotency_key=request.idempotency_key,
                )
            else:
                raise
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

    def create_connect_account(
        self,
        *,
        idempotency_key: str,
        country: str,
        seller_legal_name: str,
        workspace_id: str,
    ) -> ConnectAccountSnapshot:
        decoded = self._call(
            "POST",
            "/accounts",
            [
                ("type", "express"),
                ("country", country.upper()),
                ("capabilities[card_payments][requested]", "true"),
                ("capabilities[transfers][requested]", "true"),
                ("business_profile[name]", seller_legal_name),
                ("metadata[kodera_workspace_id]", workspace_id),
                ("metadata[samourai_project]", "kodera"),
            ],
            idempotency_key=f"connect-acct-{idempotency_key}",
        )
        return _decode_connect_account(decoded)

    def retrieve_connect_account(self, account_id: str) -> ConnectAccountSnapshot:
        if not CONNECT_ACCOUNT_ID.fullmatch(account_id):
            raise ProviderRefusedError("invalid Connect account id")
        decoded = self._call(
            "GET",
            f"/accounts/{urllib.parse.quote(account_id, safe='')}",
            [],
        )
        return _decode_connect_account(decoded)

    def create_connect_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ) -> ConnectOnboardingLink:
        if not CONNECT_ACCOUNT_ID.fullmatch(account_id):
            raise ProviderRefusedError("invalid Connect account id")
        decoded = self._call(
            "POST",
            "/account_links",
            [
                ("account", account_id),
                ("refresh_url", refresh_url),
                ("return_url", return_url),
                ("type", "account_onboarding"),
            ],
        )
        try:
            return ConnectOnboardingLink(
                url=str(decoded["url"]),
                expires_at=datetime.fromtimestamp(int(decoded["expires_at"]), UTC),
            )
        except (KeyError, TypeError, ValueError):
            raise ProviderUnavailableError(
                "Stripe answered an account link without url or expires_at"
            ) from None

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
        if not isinstance(version, str) or version not in SUPPORTED_EVENT_API_VERSIONS:
            raise EventRejectedError("the event is of another Stripe API version")
        if is_foreign_samourai_project(data):
            return None
        try:
            return _translate(kind, event_id, occurred_at, data)
        except (KeyError, TypeError, ValueError):
            raise EventRejectedError(f"the {kind} event is malformed") from None


def is_foreign_samourai_project(data_obj: object) -> bool:
    """Return True when `metadata` explicitly includes `samourai_project` with any value other than
    exact `'kodera'`. Legacy untagged objects (`'samourai_project' not in metadata` or `None`) return
    False; whitespace, non-canonical casing, non-strings, or other product tags return True."""
    if not isinstance(data_obj, Mapping):
        return False
    meta = data_obj.get("metadata")
    if not isinstance(meta, Mapping) or "samourai_project" not in meta:
        return False
    raw = meta["samourai_project"]
    if raw is None:
        return False
    return not isinstance(raw, str) or raw != "kodera"


def _translate(
    kind: str, event_id: str, occurred_at: datetime, data: Mapping[str, Any]
) -> ProviderEvent | None:
    if kind.startswith("checkout.session."):
        if (
            kind == "checkout.session.async_payment_succeeded"
            and data.get("payment_status") != "paid"
        ):
            return None
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


def _decode_connect_account(decoded: Mapping[str, Any]) -> ConnectAccountSnapshot:
    account_id = str(decoded.get("id", ""))
    if not CONNECT_ACCOUNT_ID.fullmatch(account_id):
        raise ProviderUnavailableError("Stripe answered an account without a valid acct_ id")
    requirements = decoded.get("requirements")
    disabled_reason: str | None = None
    if isinstance(requirements, Mapping):
        raw_reason = requirements.get("disabled_reason")
        if isinstance(raw_reason, str) and raw_reason.strip():
            disabled_reason = raw_reason.strip()
    raw_meta = decoded.get("metadata")
    meta_dict: dict[str, str] = {}
    if isinstance(raw_meta, Mapping):
        for k, v in raw_meta.items():
            if isinstance(k, str) and v is not None:
                meta_dict[k] = str(v)
    return ConnectAccountSnapshot(
        account_id=account_id,
        charges_enabled=bool(decoded.get("charges_enabled")),
        payouts_enabled=bool(decoded.get("payouts_enabled")),
        details_submitted=bool(decoded.get("details_submitted")),
        restricted_reason=disabled_reason,
        metadata=meta_dict,
    )
