"""Integer minor-unit arithmetic: docs/domain/BILLING_MODEL.md §2.

No float and no Decimal anywhere in a money path. Rounding is half-up, once per line.
"""

from dataclasses import dataclass

BASIS_POINTS = 10_000


def round_half_up(numerator: int, denominator: int) -> int:
    """`numerator / denominator` rounded half-up, for non-negative integers."""
    if numerator < 0 or denominator <= 0:
        raise ValueError("half-up rounding is defined here for non-negative amounts only")
    return (2 * numerator + denominator) // (2 * denominator)


@dataclass(frozen=True, slots=True)
class LineAmounts:
    net_minor: int
    vat_minor: int

    @property
    def gross_minor(self) -> int:
        return self.net_minor + self.vat_minor


def line_amounts(*, unit_amount_minor: int, quantity: int, vat_rate_bp: int) -> LineAmounts:
    """`net = unit × quantity`, `vat = round(net × rate / 10000)`."""
    if unit_amount_minor < 0:
        raise ValueError("a unit amount is never negative")
    if quantity < 1:
        raise ValueError("a quantity is at least 1")
    if not 0 <= vat_rate_bp <= BASIS_POINTS:
        raise ValueError("a VAT rate is between 0 and 10000 basis points")
    net = unit_amount_minor * quantity
    return LineAmounts(net_minor=net, vat_minor=round_half_up(net * vat_rate_bp, BASIS_POINTS))
