"""Load a catalogue file into the catalogue tables: the catalogue is data, not code.

A file names packs, capacity tiers, plan versions and prices. Loading is additive and idempotent:
a row that is absent is created, a row that is present and equal is left alone, and a row that is
present and different is refused, so loading never edits what an order may already have
snapshotted (docs/domain/BILLING_MODEL.md §1). The edits allowed are those no snapshot depends on:
closing a price's window (`valid_to` from unset), publishing a draft plan and retiring a published
one, each with its date; putting a pack or a tier on sale or taking it off (an order copies its
price, not this flag); raising a tier's included capacity, never lowering it, and changing the
instance it runs on (an order names the tier, so its customer gains); and writing a description
left empty. A commercial change is a new plan version or a new price with its own `valid_from`,
which supersedes the older price from that date. A row the database's rules refuse is reported,
never half-written. A file that declares `placeholder = true` is refused unless the
caller allows placeholders, which only a development or test database does.
"""

import tomllib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from django.core.exceptions import ValidationError
from django.db import DataError, IntegrityError, transaction

from ..models import CapacityTier, Pack, Plan, Price

PLACEHOLDER = Path(__file__).with_name("placeholder.toml")
OFFER = Path(__file__).with_name("offer.toml")
# The contract's AppCode; `messaging` replaced `tchap` in 0.22.0 (docs/specs/ESPACE_STRUCTURE.md §8).
APP_CODES = frozenset({"visio", "docs", "drive", "messaging", "grist"})

PACK_FIELDS = {"code", "name", "description", "apps", "profile_ref", "available"}
TIER_FIELDS = {
    "code",
    "name",
    "description",
    "seats_included",
    "concurrent_participants_included",
    "storage_included_bytes",
    "vm_shape",
    "media_ip_dedicated",
    "available",
}
PLAN_FIELDS = {
    "code",
    "version",
    "name",
    "description",
    "state",
    "support_tier",
    "price_change_notice_days",
    "published_at",
    "retired_at",
}
PRICE_FIELDS = {
    "plan",
    "plan_version",
    "pack",
    "capacity_tier",
    "billing_period",
    "amount_minor",
    "setup_fee_minor",
    "currency",
    "valid_from",
    "valid_to",
}
SECTIONS = {"placeholder", "packs", "capacity_tiers", "plans", "prices"}


class CatalogueError(Exception):
    """The file is malformed, is a placeholder that was not allowed, or would edit a stored row."""


@dataclass
class LoadReport:
    created: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)


def read(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _rows(document: dict[str, Any], section: str, allowed: set[str]) -> list[dict[str, Any]]:
    rows = document.get(section, [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise CatalogueError(f"[{section}] is a list of tables")
    for row in rows:
        unknown = set(row) - allowed
        if unknown:
            raise CatalogueError(f"[{section}] has unknown keys: {', '.join(sorted(unknown))}")
    return rows


def _aware(value: object, where: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise CatalogueError(f"{where} is a timestamp with an offset")
    return value


TIER_CAPACITY = ("seats_included", "concurrent_participants_included", "storage_included_bytes")


def _allowed_change(model: Any, key: str, stored: Any, wanted: Any, values: dict[str, Any]) -> bool:
    """The edits a stored row allows: those no order's snapshot depends on (the module's
    docstring). Nothing else moves."""
    if model is Price and key == "valid_to":
        return stored is None and wanted is not None
    if model in (Pack, CapacityTier) and key == "available":
        return isinstance(wanted, bool)
    if model is CapacityTier and key in TIER_CAPACITY:
        return isinstance(wanted, int) and wanted > stored
    if model is CapacityTier and key == "vm_shape":
        return isinstance(wanted, str) and wanted != ""
    if key == "description":
        return stored is None and wanted is not None
    if model is Plan and key == "state":
        return (stored, wanted) in (("draft", "published"), ("published", "retired"))
    if model is Plan and key in ("published_at", "retired_at"):
        moving_to = {"published_at": "published", "retired_at": "retired"}[key]
        return stored is None and wanted is not None and values.get("state") == moving_to
    return False


def _save(row: Any, label: str) -> None:
    try:
        row.full_clean(validate_unique=False)
        with transaction.atomic():
            row.save()
    except (ValidationError, IntegrityError, DataError) as refused:
        raise CatalogueError(f"{label} is refused by the catalogue's rules: {refused}") from None


def _upsert(
    report: LoadReport, label: str, model: Any, lookup: dict[str, Any], values: dict[str, Any]
) -> Any:
    existing = model.objects.filter(**lookup).first()
    if existing is None:
        row = model(**lookup, **values)
        _save(row, label)
        report.created.append(label)
        return row
    different = sorted(key for key, value in values.items() if getattr(existing, key) != value)
    refused = [
        key
        for key in different
        if not _allowed_change(model, key, getattr(existing, key), values[key], values)
    ]
    if refused:
        raise CatalogueError(
            f"{label} exists with other values ({', '.join(refused)}): "
            "a catalogue change is a new plan version or a new price"
        )
    if not different:
        report.unchanged.append(label)
        return existing
    for key in different:
        setattr(existing, key, values[key])
    _save(existing, label)
    report.changed.append(label)
    return existing


def load(document: dict[str, Any], *, allow_placeholder: bool) -> LoadReport:
    unknown = set(document) - SECTIONS
    if unknown:
        raise CatalogueError(f"unknown sections: {', '.join(sorted(unknown))}")
    placeholder = document.get("placeholder", False)
    if not isinstance(placeholder, bool):
        raise CatalogueError("placeholder is true or false")
    if placeholder and not allow_placeholder:
        raise CatalogueError("this is a placeholder catalogue; it is loaded only where allowed")
    report = LoadReport()
    with transaction.atomic():
        for row in _rows(document, "packs", PACK_FIELDS):
            apps = row.get("apps")
            if not isinstance(apps, list) or not apps or not set(apps) <= APP_CODES:
                raise CatalogueError(f"pack {row.get('code')!r} names its applications")
            _upsert(
                report,
                f"pack {row['code']}",
                Pack,
                {"code": row["code"]},
                {
                    "name": row["name"],
                    "description": row.get("description"),
                    "apps": apps,
                    "profile_ref": row["profile_ref"],
                    "available": row.get("available", True),
                },
            )
        for row in _rows(document, "capacity_tiers", TIER_FIELDS):
            _upsert(
                report,
                f"capacity tier {row['code']}",
                CapacityTier,
                {"code": row["code"]},
                {key: row.get(key) for key in TIER_FIELDS - {"code"} if key in row},
            )
        for row in _rows(document, "plans", PLAN_FIELDS):
            values = {key: row[key] for key in PLAN_FIELDS - {"code", "version"} if key in row}
            for stamp in ("published_at", "retired_at"):
                if stamp in values:
                    values[stamp] = _aware(values[stamp], f"plan {row['code']} {stamp}")
            _upsert(
                report,
                f"plan {row['code']} v{row['version']}",
                Plan,
                {"code": row["code"], "version": row["version"]},
                values,
            )
        for row in _rows(document, "prices", PRICE_FIELDS):
            label = (
                f"price {row['plan']} v{row['plan_version']} {row['pack']} "
                f"{row['capacity_tier']} {row['billing_period']}"
            )
            try:
                plan = Plan.objects.get(code=row["plan"], version=row["plan_version"])
                pack = Pack.objects.get(code=row["pack"])
                tier = CapacityTier.objects.get(code=row["capacity_tier"])
            except (Plan.DoesNotExist, Pack.DoesNotExist, CapacityTier.DoesNotExist):
                raise CatalogueError(f"{label} names a plan, pack or tier that is absent") from None
            amount = row["amount_minor"]
            if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
                raise CatalogueError(f"{label}: amount_minor is a non-negative integer")
            _upsert(
                report,
                label,
                Price,
                {
                    "plan": plan,
                    "pack": pack,
                    "capacity_tier": tier,
                    "billing_period": row["billing_period"],
                    "valid_from": _aware(row["valid_from"], f"{label} valid_from"),
                },
                {
                    "amount_minor": amount,
                    "setup_fee_minor": row.get("setup_fee_minor"),
                    "currency": row.get("currency", "EUR"),
                    "valid_to": _aware(row.get("valid_to"), f"{label} valid_to"),
                },
            )
    return report
