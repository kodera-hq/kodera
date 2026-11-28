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
STRIPE_PLATFORM_ACCOUNT_ID = re.compile(r"acct_[A-Za-z0-9_]+\Z")
LIVE_STRIPE_PLATFORM_ACCOUNT_ID = "acct_1UgN9ORytJJnrEun"
SANDBOX_STRIPE_PLATFORM_ACCOUNT_ID = "acct_1UgN9jRu1W0izUsy"
LEGACY_STRIPE_PLATFORM_ACCOUNT_ID = "acct_1QhZ8fRwfVmWKPLR"
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
    series = environ.get("KODERA_INVOICE_SERIES")
    if series is None:
        series = environ.get("KODERA_INVOICE_PREFIX", DEFAULT_SERIES).removesuffix("-")
    if not SERIES.fullmatch(series):
        raise ValueError("KODERA_INVOICE_SERIES is two to eight capitals, optionally twice")
    if series.startswith("AV") or series.endswith("-AV"):
        raise ValueError("KODERA_INVOICE_SERIES does not start with AV or end with -AV")
    return series


CREDIT_NOTE_SERIES = re.compile(
    r"(?:AV-(?!AV)[A-Z]{2,8}(?:-(?!AV\Z)[A-Z]{2,8})?|(?!AV)[A-Z]{2,8}-AV)\Z"
)


def credit_note_series_from_environment(environ: Mapping[str, str], *, invoice_series: str) -> str:
    default = "KOD-AV" if invoice_series == "KOD" else f"AV-{invoice_series}"
    series = environ.get("KODERA_CREDIT_NOTE_SERIES", default)
    base = series.removeprefix("AV-") if series.startswith("AV-") else series.removesuffix("-AV")
    if CREDIT_NOTE_SERIES.fullmatch(series) is None or base != invoice_series:
        raise ValueError("KODERA_CREDIT_NOTE_SERIES must match the invoice series")
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


def stripe_runtime_binding_from_environment(
    environ: Mapping[str, str],
    *,
    stripe_secret_key: str | None,
) -> tuple[bool | None, str | None]:
    """Bind `KODERA_STRIPE_EXPECTED_LIVEMODE` and `KODERA_STRIPE_PLATFORM_ACCOUNT_ID` to the
    configured restricted key mode (`rk_live_` vs `rk_test_`). Configured keys require an explicit
    `KODERA_STRIPE_PLATFORM_ACCOUNT_ID` so self-hosted deployments never silently inherit Kodera's
    hosted platform account."""
    raw_mode = environ.get("KODERA_STRIPE_EXPECTED_LIVEMODE", "").strip()
    raw_platform = environ.get("KODERA_STRIPE_PLATFORM_ACCOUNT_ID", "").strip()
    if raw_mode and raw_mode not in {"true", "false"}:
        raise ValueError("KODERA_STRIPE_EXPECTED_LIVEMODE must be lowercase true or false")
    if raw_platform and STRIPE_PLATFORM_ACCOUNT_ID.fullmatch(raw_platform) is None:
        raise ValueError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID is malformed")
    if raw_platform == LEGACY_STRIPE_PLATFORM_ACCOUNT_ID:
        raise ValueError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID refuses the retired company account")
    if stripe_secret_key is None:
        if raw_mode or raw_platform:
            raise ValueError(
                "KODERA_STRIPE_EXPECTED_LIVEMODE and KODERA_STRIPE_PLATFORM_ACCOUNT_ID require Stripe keys"
            )
        return None, None
    derived_live = stripe_secret_key.startswith("rk_live_")
    if raw_mode and (raw_mode == "true") is not derived_live:
        raise ValueError(
            "KODERA_STRIPE_EXPECTED_LIVEMODE disagrees with KODERA_STRIPE_SECRET_KEY mode"
        )
    if not raw_platform:
        raise ValueError(
            "KODERA_STRIPE_PLATFORM_ACCOUNT_ID is required when KODERA_STRIPE_SECRET_KEY is configured"
        )
    if derived_live and raw_platform == SANDBOX_STRIPE_PLATFORM_ACCOUNT_ID:
        raise ValueError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID names sandbox account in live mode")
    if not derived_live and raw_platform == LIVE_STRIPE_PLATFORM_ACCOUNT_ID:
        raise ValueError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID names live account in test mode")
    return derived_live, raw_platform


def default_stripe_livemode() -> bool:
    """Resolve the active Stripe livemode boolean for new `CreatorConnectAccount` rows."""
    from django.conf import settings

    expected_live = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
    if isinstance(expected_live, bool):
        return expected_live
    secret = getattr(settings, "KODERA_STRIPE_SECRET_KEY", None)
    return isinstance(secret, str) and secret.startswith("rk_live_")


def default_stripe_platform_account_id() -> str:
    """Resolve the active Stripe platform account ID for new `CreatorConnectAccount` rows without
    defaulting configured deployments to Kodera's hosted platform accounts."""
    from django.conf import settings

    configured = getattr(settings, "KODERA_STRIPE_PLATFORM_ACCOUNT_ID", None)
    if configured is not None:
        if (
            not isinstance(configured, str)
            or STRIPE_PLATFORM_ACCOUNT_ID.fullmatch(configured) is None
            or configured == LEGACY_STRIPE_PLATFORM_ACCOUNT_ID
        ):
            raise ValueError("KODERA_STRIPE_PLATFORM_ACCOUNT_ID is invalid")
        return configured
    secret = getattr(settings, "KODERA_STRIPE_SECRET_KEY", None)
    if isinstance(secret, str) and secret.strip():
        raise ValueError(
            "KODERA_STRIPE_PLATFORM_ACCOUNT_ID is required when KODERA_STRIPE_SECRET_KEY is configured"
        )
    return SANDBOX_STRIPE_PLATFORM_ACCOUNT_ID


def payment_return_origins(raw: object, *, loopback_http: bool = False) -> frozenset[str]:
    """Where createPaymentLink may send the payer back: the console's own origins, read from
    `KODERA_CONSOLE_ORIGINS` by the one parser discovery admits browsers with
    (services.identity.discovery_input.allowed_origins), so the two readers of the variable never
    disagree. Unset, or malformed, none: every return URL is refused, and nothing else is."""
    return allowed_origins(raw, loopback_http=loopback_http) or frozenset()
