"""Fail-closed legal issuer inputs, independent of provider and database configuration."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

from django.conf import settings

from .documents import Party
from .integrity import IntegrityRefusedError

REQUIRED = ("NAME", "ADDRESS", "POSTAL_CODE", "CITY", "COUNTRY", "SIREN", "VAT_NUMBER")
OPTIONAL = ("SIRET", "LEGAL_FORM", "SHARE_CAPITAL", "RCS", "NAF")
# ISO 3166-1 assigned alpha-2 codes; user-assigned and reserved codes are excluded.
COUNTRIES = frozenset(
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO "
    "BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ "
    "DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP "
    "GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG "
    "KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML "
    "MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE "
    "PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL "
    "SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM "
    "US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split()
)


def _refuse() -> None:
    raise IntegrityRefusedError("billing_issuer_invalid")


def _luhn(value: str, length: int) -> bool:
    if re.fullmatch(rf"[0-9]{{{length}}}", value) is None:
        return False
    digits = [int(c) for c in value[::-1]]
    return (
        sum((2 * d - 9 if d > 4 else 2 * d) if i % 2 else d for i, d in enumerate(digits)) % 10 == 0
    )


def _validate(values: Mapping[str, str], *, synthetic: bool) -> None:
    if values.get("COUNTRY") not in COUNTRIES:
        _refuse()
    siren = values.get("SIREN", "")
    if not _luhn(siren, 9) or (siren == "000000000" and not synthetic):
        _refuse()
    siret = values.get("SIRET")
    if siret is not None and (
        not _luhn(siret, 14) or not siret.startswith(siren) or siret[9:] == "00000"
    ):
        _refuse()
    vat = values.get("VAT_NUMBER", "")
    if values["COUNTRY"] == "FR":
        if synthetic and siren == "000000000" and vat == "FR00000000000":
            return
        if re.fullmatch(r"FR[0-9A-HJ-NP-Z]{2}" + siren, vat) is None:
            _refuse()
        key = vat[2:4]
        if key.isdigit() and int(key) != (12 + 3 * (int(siren) % 97)) % 97:
            _refuse()
    elif re.fullmatch(r"[A-Z]{2}[A-Z0-9]{2,13}", vat) is None:
        _refuse()


def validate_issuer(
    environment: Mapping[str, str] | None = None,
    *,
    seller: Party | None = None,
    allow_synthetic: bool = False,
) -> dict[str, str]:
    """Validate aliases and, when supplied, the immutable document's seller identity.

    Synthetic or absent issuers are permitted only in test mode. Values are
    never included in refusal messages. Optional fields are nonblank whenever configured.
    """
    source = os.environ if environment is None else environment
    samourai = "SAMOURAI_BILLING_ISSUER_"
    kodera = "KODERA_BILLING_ISSUER_"
    synthetic = allow_synthetic is True or getattr(settings, "KODERA_INVOICE_SERIES", "") == "TST"
    if any(
        name.startswith(prefix) and name.removeprefix(prefix) not in (*REQUIRED, *OPTIONAL)
        for name in source
        for prefix in (samourai, kodera)
    ):
        _refuse()
    active = any(name.startswith(samourai) for name in source)
    prefix = samourai if active else kodera
    values = {
        field: source[prefix + field].strip()
        for field in (*REQUIRED, *OPTIONAL)
        if prefix + field in source
    }
    if values:
        required = (
            REQUIRED
            if active or not synthetic
            else ("NAME", "ADDRESS", "COUNTRY", "SIREN", "VAT_NUMBER")
        )
        if any(not values.get(field) for field in required) or any(
            not value or len(value) > 400 or not value.isprintable() for value in values.values()
        ):
            _refuse()
        if active:
            for field in (*REQUIRED, *OPTIONAL):
                if kodera + field in source and source[kodera + field].strip() != values.get(field):
                    _refuse()
        _validate(values, synthetic=synthetic and not active)
    elif active or not synthetic:
        _refuse()
    if seller is not None:
        if seller.country not in COUNTRIES or any(
            not value.strip() or len(value) > 400 or not value.isprintable()
            for value in (seller.name, seller.address)
        ):
            _refuse()
        if seller.registration_id is None and not (
            synthetic
            and not active
            and seller.country == "FR"
            and seller.vat_number == "FR00000000000"
        ):
            _refuse()
        if values and any(
            values[field] != actual
            for field, actual in (
                ("NAME", seller.name),
                ("ADDRESS", seller.address),
                ("COUNTRY", seller.country),
                ("VAT_NUMBER", seller.vat_number),
                ("SIREN", seller.registration_id),
            )
        ):
            _refuse()
        if seller.registration_id is not None:
            _validate(
                {
                    "COUNTRY": seller.country,
                    "SIREN": seller.registration_id,
                    "VAT_NUMBER": seller.vat_number or "",
                },
                synthetic=synthetic and not active,
            )
    return values
