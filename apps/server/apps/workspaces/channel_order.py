"""Arrivals has display precedence independently of mutable sibling positions."""

import unicodedata

from django.db.models import Case, F, IntegerField, Q, Value, When


def is_arrivals(name: str, template_key: str | None = None) -> bool:
    for value in (name, template_key or ""):
        normalized = "".join(
            c
            for c in unicodedata.normalize("NFD", value.strip().lstrip("#"))
            if not unicodedata.combining(c)
        ).lower()
        if normalized in {"arrivals", "arrivees"}:
            return True
    return False


def arrivals_order() -> Case:
    return Case(
        When(
            Q(template_key="arrivals")
            | Q(name__iregex=r"^\s*#?(arrivals|arriv[eé]es)\s*$")
            | Q(id=F("workspace__arrivals_channel_id")),
            then=Value(0),
        ),
        default=Value(1),
        output_field=IntegerField(),
    )
