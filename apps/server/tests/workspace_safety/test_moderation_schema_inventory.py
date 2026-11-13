# ruff: noqa: S101
"""Baseline isolation preserves every older and unknown shared schema object."""

import pytest

from workspace_safety.schema_inventory import FUNCTIONS, TABLES, without_moderation


def test_moderation_inventory_refuses_a_missing_scope_guard():
    objects = {("relation", table, table): () for table in TABLES}
    objects.update({("function", name, ""): () for name in FUNCTIONS})
    older = ("function", "workspace_structure_immutable", "")
    unknown = ("function", "workspace_unknown_guard", "")
    objects[older], objects[unknown] = ("original",), ("unexpected",)
    assert without_moderation(objects) == {
        older: ("original",),
        unknown: ("unexpected",),
    }
    # A dropped new guard cannot make this baseline helper silently report a complete schema.
    del objects[("function", sorted(FUNCTIONS)[0], "")]
    with pytest.raises(AssertionError, match="scope functions"):
        without_moderation(objects)
