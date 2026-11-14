"""Reference billing catalogue fixture (`apps/billing/catalogue/offer.toml`)."""

import copy
from datetime import UTC, datetime

import pytest

from apps.billing import catalogue, selectors
from apps.billing.models import CapacityTier, Pack, Plan, Price
from apps.billing.services import BillingValidationError, OrderRequest, current_price

pytestmark = pytest.mark.django_db

# Synthetic reference amounts in euros excluding VAT: (monthly, yearly).
GRID = {
    ("team", "visio", "S"): (100, 1_080),
    ("team", "visio-docs", "S"): (150, 1_620),
    ("business", "visio", "M"): (200, 2_160),
    ("business", "visio-docs", "M"): (250, 2_700),
    ("business-plus", "visio", "L"): (400, 4_320),
    ("business-plus", "visio-docs", "L"): (450, 4_860),
    ("enterprise", "visio", "XL"): (None, 9_600),
    ("enterprise", "visio-docs", "XL"): (None, 9_600),
}
WORKSPACE = {
    ("team", "workspace", "S"): (100, 1_080),
    ("business", "workspace", "M"): (200, 2_160),
    ("business-plus", "workspace", "L"): (400, 4_320),
    ("enterprise", "workspace", "XL"): (None, 9_600),
}
UNIFIED = {(plan, "workspace-v2", tier): amounts for (plan, _, tier), amounts in WORKSPACE.items()}
NOW = datetime(2026, 11, 14, 9, tzinfo=UTC)
# Counts in the file: 3 packs, 4 tiers, 4 plans, 14 grid prices and 7 workspace prices.
ROWS = 4 + 4 + 8 + 14 + 7 + 7


@pytest.fixture
def offer():
    document = catalogue.read(catalogue.OFFER)
    catalogue.load(document, allow_placeholder=False)
    return document


def _prices():
    return {
        (p.plan.code, p.pack.code, p.capacity_tier.code, p.billing_period): p.amount_minor
        for p in Price.objects.select_related("plan", "pack", "capacity_tier")
    }


def _tier(document, code):
    return next(tier for tier in document["capacity_tiers"] if tier["code"] == code)


def _pack(document, code):
    return next(pack for pack in document["packs"] if pack["code"] == code)


def test_the_offer_is_not_a_placeholder_and_loads_once():
    document = catalogue.read(catalogue.OFFER)
    first = catalogue.load(document, allow_placeholder=False)
    assert len(first.created) == ROWS and not first.changed
    names = [
        *Plan.objects.values_list("name", flat=True),
        *Pack.objects.values_list("name", flat=True),
    ]
    assert not any("placeholder" in name.lower() for name in names)
    again = catalogue.load(document, allow_placeholder=False)
    assert not again.created and not again.changed and len(again.unchanged) == ROWS


def test_the_offer_prices_are_the_grid(offer):
    expected = {}
    for (plan, pack, tier), (monthly, yearly) in (GRID | WORKSPACE | UNIFIED).items():
        expected[plan, pack, tier, "yearly"] = yearly * 100
        if monthly is not None:
            expected[plan, pack, tier, "monthly"] = monthly * 100
    assert _prices() == expected
    rows = Price.objects.all()
    assert {(p.currency, p.setup_fee_minor, p.valid_to) for p in rows} == {("EUR", None, None)}
    assert set(Plan.objects.values_list("state", "support_tier")) == {("published", "standard")}


def test_only_the_workspace_is_orderable_and_at_the_visio_grid(offer):
    for (plan, pack, tier), (monthly, yearly) in (GRID | WORKSPACE | UNIFIED).items():
        for period, amount in (("monthly", monthly), ("yearly", yearly)):
            # `current_price` reads the codes only: the tenant and the agreements play no part.
            request = OrderRequest(
                pack_code=pack,
                capacity_tier_code=tier,
                billing_period=period,
                tenant=None,
                agreements=None,
            )
            if pack != "workspace-v2" or amount is None:
                with pytest.raises(BillingValidationError) as refused:
                    current_price(request=request, now=NOW)
                reason = "unavailable" if pack != "workspace-v2" else "not_offered"
                assert refused.value.reason == reason, (plan, pack, period)
            else:
                price = current_price(request=request, now=NOW)
                assert (price.plan.code, price.amount_minor) == (plan, amount * 100)


def test_the_public_catalogue_offers_only_what_can_be_ordered(offer):
    offered = {(p.pack.code, p.billing_period) for p in selectors._offered_prices()}
    assert offered == {("workspace-v2", "monthly"), ("workspace-v2", "yearly")}
    _pack(offer, "visio-docs")["available"] = True
    catalogue.load(offer, allow_placeholder=False)
    assert len(selectors._offered_prices().filter(pack__code="visio-docs")) == 7


def test_the_tiers_sold_and_their_capacity(offer):
    tiers = {
        t.code: (t.seats_included, t.concurrent_participants_included, t.storage_included_bytes)
        for t in CapacityTier.objects.all()
    }
    gb = 1_000_000_000
    assert set(CapacityTier.objects.values_list("name", flat=True)) == {
        "Capacité S",
        "Capacité M",
        "Capacité L",
        "Capacité XL",
    }
    assert tiers == {
        "S": (80, 25, 50 * gb),
        "M": (165, 50, 100 * gb),
        "L": (250, 75, 250 * gb),
        "XL": (665, 200, 500 * gb),
    }


def test_a_tier_is_raised_in_place_and_never_lowered(offer):
    small = _tier(offer, "S")
    small.update(concurrent_participants_included=30, vm_shape="vm-micro")
    report = catalogue.load(offer, allow_placeholder=False)
    assert report.changed == ["capacity tier S"]
    stored = CapacityTier.objects.get(code="S")
    assert (stored.concurrent_participants_included, stored.vm_shape) == (30, "vm-micro")
    for key, lower in (
        ("concurrent_participants_included", 29),
        ("seats_included", 79),
        ("storage_included_bytes", 1),
    ):
        lowered = {**small, key: lower}
        offer["capacity_tiers"] = [
            lowered if t["code"] == "S" else t for t in offer["capacity_tiers"]
        ]
        with pytest.raises(catalogue.CatalogueError, match=key):
            catalogue.load(offer, allow_placeholder=False)
    assert CapacityTier.objects.get(code="S").concurrent_participants_included == 30


def test_a_pack_goes_on_and_off_sale_and_a_description_is_written_once(offer):
    docs = _pack(offer, "visio-docs")
    docs["available"] = True
    assert catalogue.load(offer, allow_placeholder=False).changed == ["pack visio-docs"]
    docs["available"] = False
    catalogue.load(offer, allow_placeholder=False)
    assert not Pack.objects.get(code="visio-docs").available
    # A tier's description is left empty by the offer: written once, then frozen.
    small = _tier(offer, "S")
    small["description"] = "Conçue pour une petite organisation."
    assert catalogue.load(offer, allow_placeholder=False).changed == ["capacity tier S"]
    small["description"] = "Autre texte"
    with pytest.raises(catalogue.CatalogueError, match="description"):
        catalogue.load(offer, allow_placeholder=False)
    small["description"] = "Conçue pour une petite organisation."
    small["name"] = "Petit"
    with pytest.raises(catalogue.CatalogueError, match="name"):
        catalogue.load(offer, allow_placeholder=False)


def test_the_offer_carries_the_design_lanes_copy(offer):
    plans = dict(Plan.objects.values_list("code", "description"))
    assert all(plans[code] for code in ("team", "business", "business-plus", "enterprise"))
    assert "documents included" in Plan.objects.get(code="business-plus", version=2).description
    packs = dict(Pack.objects.values_list("code", "description"))
    assert "hosted in the European Union" in packs["workspace-v2"]
    assert "Docs" not in packs["workspace"]
    assert set(CapacityTier.objects.values_list("description", flat=True)) == {None}


def test_the_workspace_pack_is_visio_and_espace_and_names_no_other_pack(offer):
    workspace = Pack.objects.get(code="workspace")
    assert (workspace.apps, workspace.profile_ref, workspace.available) == (
        ["visio", "messaging"],
        "workspace/1.0",
        False,
    )
    current = Pack.objects.get(code="workspace-v2")
    assert (current.apps, current.profile_ref) == (["messaging", "visio", "docs"], "workspace/2.0")
    assert set(Pack.objects.filter(available=True).values_list("code", flat=True)) == {
        "workspace-v2"
    }


def _before_the_workspace(document):
    """Earlier catalogue state without the workspace pack, with Visio on sale."""
    earlier = copy.deepcopy(document)
    earlier["packs"] = [
        p for p in earlier["packs"] if p["code"] not in {"workspace", "workspace-v2"}
    ]
    earlier["prices"] = [
        p for p in earlier["prices"] if p["pack"] not in {"workspace", "workspace-v2"}
    ]
    earlier["plans"] = [plan for plan in earlier["plans"] if plan["version"] == 1]
    del _pack(earlier, "visio")["available"]
    return earlier


def test_loading_over_the_catalogue_already_loaded_adds_the_workspace_and_closes_visio():
    document = catalogue.read(catalogue.OFFER)
    earlier = _before_the_workspace(document)
    assert len(catalogue.load(earlier, allow_placeholder=False).created) == 24
    assert Pack.objects.get(code="visio").available
    report = catalogue.load(document, allow_placeholder=False)
    assert report.changed == ["pack visio"]
    assert sorted(report.created) == sorted(
        [
            "pack workspace",
            "pack workspace-v2",
            *(f"plan {plan} v2" for plan in ("team", "business", "business-plus", "enterprise")),
            *(
                f"price {plan} v2 workspace-v2 {tier} {period}"
                for (plan, _, tier), (monthly, _) in WORKSPACE.items()
                for period in (("monthly", "yearly") if monthly is not None else ("yearly",))
            ),
            *(
                f"price {plan} v1 workspace {tier} {period}"
                for (plan, _, tier), (monthly, _) in WORKSPACE.items()
                for period in (("monthly", "yearly") if monthly is not None else ("yearly",))
            ),
        ]
    )
    assert len(report.unchanged) == 24 - 1
    assert not Pack.objects.get(code="visio").available
    again = catalogue.load(document, allow_placeholder=False)
    assert not again.created and not again.changed and len(again.unchanged) == ROWS
