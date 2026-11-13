"""Quota reversal excludes only its exact objects and refuses incomplete inventories."""

import pytest

from workspace_quotas.schema_inventory import (
    CONSTRAINTS,
    FUNCTIONS,
    TABLE,
    TRIGGERS,
    without_quotas,
)


def inventory():
    objects = {("relation", TABLE, TABLE): ()}
    objects.update({("function", *value): () for value in FUNCTIONS})
    objects.update({("trigger", *value): () for value in TRIGGERS})
    objects.update({("constraint", *value): () for value in CONSTRAINTS})
    return objects


def test_quota_inventory_preserves_older_objects_and_unknown_overloads():
    objects = inventory()
    unrelated = {
        ("function", "workspace_structure_immutable", ""): ("older",),
        ("function", "workspace_quota_usage", "p_workspace text"): ("unexpected overload",),
        ("trigger", "docs_document", "unknown_quota_guard"): ("unexpected trigger",),
    }
    objects.update(unrelated)
    assert without_quotas(objects) == unrelated


@pytest.mark.parametrize("kind", ["function", "trigger", "constraint", "relation"])
def test_quota_inventory_refuses_a_missing_owned_object(kind):
    objects = inventory()
    del objects[next(key for key in objects if key[0] == kind)]
    with pytest.raises(AssertionError, match="workspace quota"):
        without_quotas(objects)
