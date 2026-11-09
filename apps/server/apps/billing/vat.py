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

EU_MEMBER_STATES = frozenset(
    "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split()
)


ALPHA_2 = re.compile(r"[A-Z]{2}\Z")


def regime(code: str) -> Regime:
    try:
        return REGIMES[code]
    except KeyError:
        raise ValueError(f"{code!r} is not a VAT regime") from None


def regime_for(*, country: str, vat_number_validated: bool, exempt: bool = False) -> Regime:
    """The regime for a business customer established in `country` (ISO 3166-1 alpha-2).

    A customer elsewhere in the EU without a validated VAT number is charged French VAT: the
    fallback BILLING_MODEL.md §3 avoids by requiring a number, never a silent 0 %.
    """
    if not ALPHA_2.match(country):
        raise ValueError(f"{country!r} is not an ISO 3166-1 alpha-2 country code")
    if exempt:
        return REGIMES["exempt"]
    if country == "FR":
        return REGIMES["fr_standard"]
    if country in EU_MEMBER_STATES:
        return REGIMES["eu_reverse_charge" if vat_number_validated else "fr_standard"]
    return REGIMES["outside_eu"]


# When VAT becomes due (exigibilité): on payment, the rule for services, the owner decided. Core has
# not opted to pay VAT on invoicing (« option pour les débits »), so no invoice prints that mention.
VAT_DUE_ON = "payment"
