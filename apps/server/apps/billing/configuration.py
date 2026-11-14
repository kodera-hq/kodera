"""Billing settings read from the environment, once, at start; a malformed value stops the process.

The issuer is the legal entity printed on every invoice: its name, address, SIREN and VAT number,
from `KODERA_BILLING_ISSUER_NAME`, `_ADDRESS`, `_SIREN` and `_VAT_NUMBER`. All four or none:
unset, no invoice can be issued and an order is refused before anything is written. The series
prefix names the invoice number series (`<series>-<year>-<NNNNN>`).
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from services.identity.discovery_input import allowed_origins

SERIES = re.compile(r"[A-Z]{2,8}(-[A-Z]{2,8})?\Z")
# The API holds a Stripe restricted key only (docs/dev/SETTINGS_AND_SECRETS.md §2), matched whole.
RESTRICTED_KEY = re.compile(r"rk_(live|test)_[A-Za-z0-9]+")
SIREN = re.compile(r"[0-9]{9}\Z")
VAT_NUMBER = re.compile(r"[A-Z]{2}[0-9A-Z]{2,13}\Z")
DEFAULT_SERIES = "INV"
PAYMENT_TERMS_DAYS = 30
ISSUER_VARIABLES = (
    "KODERA_BILLING_ISSUER_NAME",
    "KODERA_BILLING_ISSUER_ADDRESS",
    "KODERA_BILLING_ISSUER_SIREN",
    "KODERA_BILLING_ISSUER_VAT_NUMBER",
)


@dataclass(frozen=True, slots=True)
class Issuer:
    legal_name: str
    address: str
    siren: str
    vat_number: str
    # Kept separately: a VAT registration prefix does not establish legal address country.
    country: str | None = None


def _text(name: str, value: str, limit: int) -> str:
    if len(value) > limit or not value.isprintable():
        raise ValueError(f"{name} is not printable text of at most {limit} characters")
    return value


def issuer_from_environment(environ: Mapping[str, str]) -> Issuer | None:
    values = [environ.get(name, "").strip() for name in ISSUER_VARIABLES]
    if not any(values):
        return None
    if not all(values):
        raise ValueError("the billing issuer is configured with all four variables or none")
    name, address, siren, vat_number = values
    country = environ.get("KODERA_BILLING_ISSUER_COUNTRY", "").strip() or None
    if country is not None and re.fullmatch(r"[A-Z]{2}", country) is None:
        raise ValueError("KODERA_BILLING_ISSUER_COUNTRY is an explicit ISO alpha-2 country")
    if not SIREN.match(siren):
        raise ValueError("KODERA_BILLING_ISSUER_SIREN is nine digits")
    if not VAT_NUMBER.match(vat_number):
        raise ValueError("KODERA_BILLING_ISSUER_VAT_NUMBER is a country prefix and its number")
    return Issuer(
        legal_name=_text(ISSUER_VARIABLES[0], name, 200),
        address=_text(ISSUER_VARIABLES[1], address, 400),
        siren=siren,
        vat_number=vat_number,
        country=country,
    )


def series_from_environment(environ: Mapping[str, str]) -> str:
    series = environ.get("KODERA_INVOICE_SERIES", DEFAULT_SERIES)
    if not SERIES.match(series):
        raise ValueError("KODERA_INVOICE_SERIES is two to eight capitals, optionally twice")
    if series.startswith("AV"):
        # `AV-<series>` is the credit notes' series: an invoice series there would share its counter.
        raise ValueError("KODERA_INVOICE_SERIES does not start with AV, the credit notes' prefix")
    return series


def stripe_from_environment(
    environ: Mapping[str, str],
) -> tuple[str | None, str | None, str | None]:
    """`KODERA_STRIPE_SECRET_KEY` and `KODERA_STRIPE_WEBHOOK_SECRET`, both or neither, and the
    provider they select: `stripe` when both are set, None when neither is. Never logged."""
    secret = environ.get("KODERA_STRIPE_SECRET_KEY", "").strip()
    webhook = environ.get("KODERA_STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret and not webhook:
        return None, None, None
    if not secret or not webhook:
        raise ValueError("the Stripe keys are configured both or not at all")
    # A restricted key scoped to Checkout Sessions (apps/billing/payments/stripe.py), whole: a mode
    # and a body of letters and digits, nothing embedded, never a full secret key behind `rk_`.
    if RESTRICTED_KEY.fullmatch(secret) is None or not webhook.startswith("whsec_"):
        raise ValueError("KODERA_STRIPE_SECRET_KEY or KODERA_STRIPE_WEBHOOK_SECRET is malformed")
    return "stripe", secret, webhook


def payment_return_origins(raw: object, *, loopback_http: bool = False) -> frozenset[str]:
    """Where createPaymentLink may send the payer back: the console's own origins, read from
    `KODERA_CONSOLE_ORIGINS` by the one parser discovery admits browsers with
    (services.identity.discovery_input.allowed_origins), so the two readers of the variable never
    disagree. Unset, or malformed, none: every return URL is refused, and nothing else is."""
    return allowed_origins(raw, loopback_http=loopback_http) or frozenset()
