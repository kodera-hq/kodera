"""The VAT regimes the contract names (`VatRegime`), their rate and the mention printed.

docs/domain/BILLING_MODEL.md §3. The regime is decided once and snapshotted onto the subscription
and every invoice; nothing recomputes it at render time. Every rate and mention is to be confirmed
with the accountant before first use: this table is the shape the model supports, not tax advice.
The mentions are invoice copy, in French.
"""

import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Regime:
    code: str
    rate_bp: int
    mention: str | None


REGIMES: dict[str, Regime] = {
    regime.code: regime
    for regime in (
        Regime("fr_standard", 2000, None),
        Regime(
            "eu_reverse_charge",
            0,
            "Autoliquidation — art. 283-2 du CGI / art. 196 directive 2006/112/CE",
        ),
        Regime("exempt", 0, "Exonération — art. 151 directive 2006/112/CE"),
        Regime("outside_eu", 0, "TVA non applicable — art. 259-1 du CGI"),
    )
}

EU_OSS_REGIME_CODE = "eu_oss"
EU_OSS_MENTION = (
    "TVA de l'État membre de consommation — régime UE OSS "
    "(art. 259 D CGI / art. 369 bis directive 2006/112/CE)"
)

# Statutory standard VAT rates in basis points (100 bp = 1.00 %) across all 27 EU member states
# for cross-border B2C electronically supplied services under the Union One-Stop Shop (EU OSS).
EU_OSS_RATES_BP: dict[str, int] = {
    "AT": 2000,
    "BE": 2100,
    "BG": 2000,
    "CY": 1900,
    "CZ": 2100,
    "DE": 1900,
    "DK": 2500,
    "EE": 2400,
    "ES": 2100,
    "FI": 2550,
    "FR": 2000,
    "GR": 2400,
    "HR": 2500,
    "HU": 2700,
    "IE": 2300,
    "IT": 2200,
    "LT": 2100,
    "LU": 1700,
    "LV": 2100,
    "MT": 1800,
    "NL": 2100,
    "PL": 2300,
    "PT": 2300,
    "RO": 2100,
    "SE": 2500,
    "SI": 2200,
    "SK": 2300,
}

EU_MEMBER_STATES = frozenset(EU_OSS_RATES_BP)
LEDGER_VAT_REGIMES = (*REGIMES, EU_OSS_REGIME_CODE)


ALPHA_2 = re.compile(r"[A-Z]{2}\Z")


def oss_rate_bp(country: str) -> int:
    """Statutory standard VAT rate in basis points for an EU member state (`country`)."""
    if not ALPHA_2.match(country):
        raise ValueError(f"{country!r} is not an ISO 3166-1 alpha-2 country code")
    try:
        return EU_OSS_RATES_BP[country]
    except KeyError:
        raise ValueError(f"{country!r} is not an EU member state") from None


def oss_regime_for(*, country: str) -> Regime:
    """VAT regime for a B2C consumer established in `country` when supplied from France."""
    if not ALPHA_2.match(country):
        raise ValueError(f"{country!r} is not an ISO 3166-1 alpha-2 country code")
    if country == "FR":
        return REGIMES["fr_standard"]
    if country in EU_OSS_RATES_BP:
        return Regime(EU_OSS_REGIME_CODE, EU_OSS_RATES_BP[country], EU_OSS_MENTION)
    return REGIMES["outside_eu"]


def regime(code: str, *, country: str | None = None) -> Regime:
    if code == EU_OSS_REGIME_CODE:
        if country is None:
            raise ValueError("eu_oss requires a consumption EU member-state country code")
        if not ALPHA_2.match(country) or country not in EU_OSS_RATES_BP or country == "FR":
            raise ValueError(f"{country!r} is not a cross-border EU OSS consumption state")
        return Regime(EU_OSS_REGIME_CODE, EU_OSS_RATES_BP[country], EU_OSS_MENTION)
    try:
        return REGIMES[code]
    except KeyError:
        raise ValueError(f"{code!r} is not a VAT regime") from None


def regime_for(
    *,
    country: str,
    vat_number_validated: bool = False,
    exempt: bool = False,
    b2c: bool = False,
) -> Regime:
    """The regime for a customer established in `country` (ISO 3166-1 alpha-2).

    For B2B (`b2c=False`), a customer elsewhere in the EU without a validated VAT number is
    charged French VAT: the fallback BILLING_MODEL.md §3 avoids by requiring a number, never a
    silent 0 %. For cross-border EU B2C (`b2c=True`), Union OSS (`eu_oss`) applies the member
    state of consumption's statutory VAT rate (`EU_OSS_RATES_BP[country]`).
    """
    if not ALPHA_2.match(country):
        raise ValueError(f"{country!r} is not an ISO 3166-1 alpha-2 country code")
    if exempt:
        return REGIMES["exempt"]
    if b2c:
        if vat_number_validated:
            raise ValueError("a B2C supply cannot claim VIES reverse charge")
        return oss_regime_for(country=country)
    if country == "FR":
        return REGIMES["fr_standard"]
    if country in EU_MEMBER_STATES:
        return REGIMES["eu_reverse_charge" if vat_number_validated else "fr_standard"]
    return REGIMES["outside_eu"]


# When VAT becomes due (exigibilité): on payment, the rule for services, the owner decided. Core has
# not opted to pay VAT on invoicing (« option pour les débits »), so no invoice prints that mention.
VAT_DUE_ON = "payment"
