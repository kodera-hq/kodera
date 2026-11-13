"""Closed, bounded collection schemas; property identifiers never select SQL syntax."""

import math
from datetime import date
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from .errors import RefusalError

TYPES = {"text", "number", "checkbox", "date", "url", "select", "multi_select", "person"}
EMPTY = {"is_empty", "is_not_empty"}
ORDER = {"lt", "lte", "gt", "gte"}


def text(value: Any, maximum: int, *, empty: bool = False) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or (not empty and not value.strip())
        or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in value)
    ):
        raise RefusalError(422)
    return value


def object_fields(
    value: Any, required: set[str], optional: set[str] | frozenset[str] = frozenset()
) -> None:
    if (
        not isinstance(value, dict)
        or not required <= value.keys()
        or value.keys() - required - optional
    ):
        raise RefusalError(422)


def items(value: Any, bound: int) -> list:
    if not isinstance(value, list) or len(value) > bound:
        raise RefusalError(422)
    return value


def definitions(properties: Any) -> dict[str, dict]:
    result = {}
    for prop in items(properties, 100):
        object_fields(prop, {"id", "name", "type"}, {"options"})
        key = text(prop["id"], 64)
        text(prop["name"], 100)
        if key in result or not isinstance(prop["type"], str) or prop["type"] not in TYPES:
            raise RefusalError(422)
        if prop["type"] in {"select", "multi_select"}:
            options = set()
            for option in items(prop.get("options"), 100):
                object_fields(option, {"id", "label"})
                option_id = text(option["id"], 64)
                text(option["label"], 100)
                if option_id in options:
                    raise RefusalError(422)
                options.add(option_id)
        elif "options" in prop:
            raise RefusalError(422)
        result[key] = prop
    return result


def value(prop: dict, typed: Any) -> Any:
    object_fields(typed, {"type", "value"})
    kind, raw = prop["type"], typed["value"]
    if typed["type"] != kind:
        raise RefusalError(422)
    if raw is None and kind not in {"checkbox", "multi_select"}:
        return None
    if kind == "text":
        text(raw, 10000, empty=True)
    elif kind == "number":
        if type(raw) not in {int, float}:
            raise RefusalError(422)
        try:
            finite = math.isfinite(raw)
        except OverflowError:
            finite = False
        if not finite:
            raise RefusalError(422)
    elif kind == "checkbox":
        if type(raw) is not bool:
            raise RefusalError(422)
    elif kind == "date":
        try:
            if not isinstance(raw, str) or date.fromisoformat(raw).isoformat() != raw:
                raise ValueError
        except ValueError:
            raise RefusalError(422) from None
    elif kind == "url":
        text(raw, 2048)
        try:
            parsed = urlsplit(raw)
            if (
                parsed.scheme not in {"https", "http"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError
            _ = parsed.port
        except ValueError:
            raise RefusalError(422) from None
    elif kind == "person":
        try:
            if not isinstance(raw, str) or str(UUID(raw)) != raw:
                raise ValueError
        except ValueError:
            raise RefusalError(422) from None
    elif kind in {"select", "multi_select"}:
        options = {option["id"] for option in prop["options"]}
        chosen = [raw] if kind == "select" else items(raw, 100)
        if any(not isinstance(v, str) or v not in options for v in chosen) or len(
            set(chosen)
        ) != len(chosen):
            raise RefusalError(422)
    return raw


def values(properties: Any, supplied: Any) -> None:
    props = definitions(properties)
    if not isinstance(supplied, dict) or len(supplied) > 100 or supplied.keys() - props.keys():
        raise RefusalError(422)
    for key, typed in supplied.items():
        value(props[key], typed)


def query(properties: Any, filters: Any, sorts: Any) -> None:
    props = definitions(properties)
    for sort in items(sorts, 10):
        object_fields(sort, {"propertyId", "direction"})
        if (
            not isinstance(sort["propertyId"], str)
            or sort["propertyId"] not in props
            or not isinstance(sort["direction"], str)
            or sort["direction"] not in {"asc", "desc"}
        ):
            raise RefusalError(422)
        if props[sort["propertyId"]]["type"] == "multi_select":
            raise RefusalError(422)
    for filt in items(filters, 50):
        object_fields(filt, {"propertyId", "operator"}, {"value"})
        if (
            not isinstance(filt["propertyId"], str)
            or filt["propertyId"] not in props
            or not isinstance(filt["operator"], str)
        ):
            raise RefusalError(422)
        prop, op = props[filt["propertyId"]], filt["operator"]
        if op in EMPTY:
            if "value" in filt:
                raise RefusalError(422)
            continue
        if op not in {"eq", "ne", "contains", *ORDER} or "value" not in filt:
            raise RefusalError(422)
        raw = value(prop, filt["value"])
        if raw is None and op not in {"eq", "ne"}:
            raise RefusalError(422)
        if op in ORDER and prop["type"] not in {"number", "date", "text"}:
            raise RefusalError(422)
        if op == "contains" and prop["type"] not in {"text", "multi_select"}:
            raise RefusalError(422)


def views(properties: Any, supplied: Any) -> None:
    props, seen = definitions(properties), set()
    for view in items(supplied, 20):
        if not isinstance(view, dict):
            raise RefusalError(422)
        kind = view.get("type")
        if not isinstance(kind, str):
            raise RefusalError(422)
        extra = {
            "table": {"columns"},
            "board": {"groupByPropertyId", "showEmptyGroups"},
            "list": {"titlePropertyId"},
        }.get(kind)
        if extra is None:
            raise RefusalError(422)
        object_fields(view, {"id", "name", "type", *extra}, {"filters", "sorts"})
        key = text(view["id"], 64)
        text(view["name"], 100)
        if key in seen:
            raise RefusalError(422)
        seen.add(key)
        if kind == "table":
            columns = items(view["columns"], 100)
            if (
                not columns
                or any(not isinstance(c, str) or c not in props for c in columns)
                or len(set(columns)) != len(columns)
            ):
                raise RefusalError(422)
        elif kind == "board":
            group = view["groupByPropertyId"]
            if (
                not isinstance(group, str)
                or group not in props
                or props[group]["type"] != "select"
                or type(view["showEmptyGroups"]) is not bool
            ):
                raise RefusalError(422)
        elif (
            not isinstance(view["titlePropertyId"], str)
            or view["titlePropertyId"] not in props
            or props[view["titlePropertyId"]]["type"] != "text"
        ):
            raise RefusalError(422)
        query(properties, view.get("filters", []), view.get("sorts", []))
