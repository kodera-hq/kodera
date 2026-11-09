"""Billing's pure rules: money, VAT regimes, state tables, periods, configuration. No database."""

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
import yaml

from apps.billing import configuration, money, states, vat
from apps.billing.actors import Actor
from apps.billing.services import period_end, series_year


@pytest.mark.parametrize(
    ("numerator", "denominator", "expected"),
    [(0, 10, 0), (4, 10, 0), (5, 10, 1), (14, 10, 1), (15, 10, 2), (897_600_000, 10_000, 89_760)],
)
def test_half_up_rounding(numerator, denominator, expected):
    assert money.round_half_up(numerator, denominator) == expected


@pytest.mark.parametrize(("numerator", "denominator"), [(-1, 10), (1, 0), (1, -10)])
def test_half_up_rounding_refuses_what_it_does_not_define(numerator, denominator):
    with pytest.raises(ValueError, match="non-negative"):
        money.round_half_up(numerator, denominator)


def test_line_amounts_match_the_contract_example():
    amounts = money.line_amounts(unit_amount_minor=448_800, quantity=1, vat_rate_bp=2000)
    assert (amounts.net_minor, amounts.vat_minor, amounts.gross_minor) == (448_800, 89_760, 538_560)


def test_line_vat_rounds_once_half_up():
    # 3 × 333 = 999 cents at 20 % is 199.8 → 200; at 5.5 % it is 54.945 → 55.
    assert money.line_amounts(unit_amount_minor=333, quantity=3, vat_rate_bp=2000).vat_minor == 200
    assert money.line_amounts(unit_amount_minor=333, quantity=3, vat_rate_bp=550).vat_minor == 55


@pytest.mark.parametrize(
    ("unit", "quantity", "rate", "message"),
    [(-1, 1, 0, "negative"), (1, 0, 0, "at least 1"), (1, 1, 10_001, "basis points")],
)
def test_line_amounts_refuse_out_of_range_inputs(unit, quantity, rate, message):
    with pytest.raises(ValueError, match=message):
        money.line_amounts(unit_amount_minor=unit, quantity=quantity, vat_rate_bp=rate)


def test_regimes_are_the_contract_enum():
    assert set(vat.REGIMES) == {"fr_standard", "eu_reverse_charge", "exempt", "outside_eu"}
    assert vat.regime("fr_standard").rate_bp == 2000
    assert vat.regime("fr_standard").mention is None
    assert all(vat.regime(code).mention for code in ("eu_reverse_charge", "exempt", "outside_eu"))
    with pytest.raises(ValueError, match="not a VAT regime"):
        vat.regime("zero")


@pytest.mark.parametrize(
    ("country", "validated", "exempt", "expected"),
    [
        ("FR", False, False, "fr_standard"),
        ("FR", True, False, "fr_standard"),
        ("DE", True, False, "eu_reverse_charge"),
        ("DE", False, False, "fr_standard"),
        ("CH", False, False, "outside_eu"),
        ("US", True, False, "outside_eu"),
        ("BE", True, True, "exempt"),
    ],
)
def test_regime_for_a_business_customer(country, validated, exempt, expected):
    assert (
        vat.regime_for(country=country, vat_number_validated=validated, exempt=exempt).code
        == expected
    )


@pytest.mark.parametrize("country", ["fr", "FRA", "", "F1"])
def test_regime_for_refuses_a_country_that_is_not_alpha_2(country):
    with pytest.raises(ValueError, match="alpha-2"):
        vat.regime_for(country=country, vat_number_validated=False)


@pytest.mark.parametrize(
    ("table", "domain"),
    [
        (states.ORDER_TRANSITIONS, states.ORDER_STATES),
        (states.SUBSCRIPTION_TRANSITIONS, states.SUBSCRIPTION_STATES),
        (states.INVOICE_TRANSITIONS, states.INVOICE_STATES),
        (states.PAYMENT_TRANSITIONS, states.PAYMENT_STATES),
    ],
)
def test_every_state_has_a_row_and_every_target_is_a_state(table, domain):
    assert set(table) == set(domain)
    assert set().union(*table.values()) <= set(domain)
    assert all(state not in targets for state, targets in table.items())


def test_contract_enums_are_the_state_sets():
    contract = Path(__file__).resolve().parents[1] / "contracts/core-api.openapi.yaml"
    schemas = yaml.safe_load(contract.read_text())["components"]["schemas"]
    assert tuple(schemas["OrderState"]["enum"]) == states.ORDER_STATES
    assert tuple(schemas["SubscriptionState"]["enum"]) == states.SUBSCRIPTION_STATES
    assert tuple(schemas["InvoiceState"]["enum"]) == states.INVOICE_STATES
    assert tuple(schemas["VatRegime"]["enum"]) == tuple(vat.REGIMES)


def test_a_refused_transition_names_both_states():
    states.require_transition(
        states.ORDER_TRANSITIONS, machine="order", current="placed", requested="paid"
    )
    with pytest.raises(states.TransitionRefusedError) as refused:
        states.require_transition(
            states.ORDER_TRANSITIONS, machine="order", current="fulfilled", requested="cancelled"
        )
    assert (refused.value.current, refused.value.requested) == ("fulfilled", "cancelled")
    assert states.predecessors(states.ORDER_TRANSITIONS, "cancelled") == (
        "placed",
        "awaiting_payment",
    )


@pytest.mark.parametrize(
    ("start", "period", "end"),
    [
        (datetime(2026, 1, 31, 9, tzinfo=UTC), "monthly", datetime(2026, 2, 28, 9, tzinfo=UTC)),
        (datetime(2028, 1, 31, 9, tzinfo=UTC), "monthly", datetime(2028, 2, 29, 9, tzinfo=UTC)),
        (datetime(2026, 12, 15, tzinfo=UTC), "monthly", datetime(2027, 1, 15, tzinfo=UTC)),
        (datetime(2028, 2, 29, tzinfo=UTC), "yearly", datetime(2029, 2, 28, tzinfo=UTC)),
    ],
)
def test_period_end_clamps_to_the_last_day(start, period, end):
    assert period_end(start=start, billing_period=period) == end


def test_period_end_refuses_an_unknown_period():
    with pytest.raises(ValueError, match="billing period"):
        period_end(start=datetime(2026, 1, 1, tzinfo=UTC), billing_period="weekly")


ISSUER = {
    "KODERA_BILLING_ISSUER_NAME": "Issuer SAS",
    "KODERA_BILLING_ISSUER_ADDRESS": "1 rue de l'Exemple, 75000 Paris",
    "KODERA_BILLING_ISSUER_SIREN": "000000000",
    "KODERA_BILLING_ISSUER_VAT_NUMBER": "FR00000000000",
}


def test_the_issuer_is_configured_whole_or_not_at_all():
    assert configuration.issuer_from_environment({}) is None
    issuer = configuration.issuer_from_environment(ISSUER)
    assert (issuer.legal_name, issuer.siren) == ("Issuer SAS", "000000000")
    with pytest.raises(ValueError, match="all four"):
        configuration.issuer_from_environment({"KODERA_BILLING_ISSUER_NAME": "Issuer SAS"})
    for name, bad, message in (
        ("KODERA_BILLING_ISSUER_SIREN", "12345", "nine digits"),
        ("KODERA_BILLING_ISSUER_VAT_NUMBER", "00000000000", "country prefix"),
        ("KODERA_BILLING_ISSUER_NAME", "Issuer\tSAS", "printable"),
    ):
        with pytest.raises(ValueError, match=message):
            configuration.issuer_from_environment({**ISSUER, name: bad})


def test_the_series_from_the_environment():
    assert configuration.series_from_environment({}) == "INV"
    assert configuration.series_from_environment({"KODERA_INVOICE_SERIES": "KOD-INV"}) == "KOD-INV"
    for bad in ("inv", "I", "INV-2026", "INV-"):
        with pytest.raises(ValueError, match="capitals"):
            configuration.series_from_environment({"KODERA_INVOICE_SERIES": bad})


def test_a_period_is_counted_on_the_paris_calendar():
    # 23:30 UTC on 30 January is 31 January in Paris: one month later is 28 February in Paris.
    start = datetime(2026, 1, 30, 23, 30, tzinfo=UTC)
    assert period_end(start=start, billing_period="monthly") == datetime(
        2026, 2, 27, 23, 30, tzinfo=UTC
    )


def test_an_actor_names_an_identity_unless_it_is_the_system():
    with pytest.raises(ValueError, match="system names none"):
        Actor("system", uuid4())
    with pytest.raises(ValueError, match="system names none"):
        Actor("tenant", None)
    with pytest.raises(ValueError, match="not a billing actor"):
        Actor("agent", None)


def test_a_number_belongs_to_the_paris_year_of_its_issue():
    # 23:30 UTC on 31 December is already 1 January in Paris.
    assert series_year(datetime(2026, 12, 31, 23, 30, tzinfo=UTC)) == 2027
    assert series_year(datetime(2026, 12, 31, 22, 59, tzinfo=UTC)) == 2026
