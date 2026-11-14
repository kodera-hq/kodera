# ruff: noqa: S101
"""Baseline isolation preserves every older and unknown shared schema object."""

import pytest

from workspace_documents.schema_inventory import (
    COLLECTION_QUOTA_FUNCTIONS,
    FUNCTIONS,
    TABLES,
    without_documents,
)


def test_document_inventory_refuses_a_missing_scope_guard():
    objects = {("relation", table, table): () for table in TABLES}
    objects.update({("function", name, ""): () for name in FUNCTIONS})
    objects.update({("function", *value): () for value in COLLECTION_QUOTA_FUNCTIONS})
    older = ("function", "workspace_structure_immutable", "")
    unknown = ("function", "workspace_unknown_guard", "")
    objects[older], objects[unknown] = ("original",), ("unexpected",)
    assert without_documents(objects) == {
        older: ("original",),
        unknown: ("unexpected",),
    }
    del objects[("function", sorted(FUNCTIONS)[0], "")]
    with pytest.raises(AssertionError, match="document scope functions"):
        without_documents(objects)


@pytest.mark.parametrize("function", sorted(COLLECTION_QUOTA_FUNCTIONS))
def test_document_inventory_uses_exact_collection_and_quota_signatures(function):
    objects = {("relation", table, table): () for table in TABLES}
    objects.update({("function", name, ""): () for name in FUNCTIONS})
    objects.update({("function", *value): () for value in COLLECTION_QUOTA_FUNCTIONS})
    unknown = ("function", function[0], "p_unknown text")
    objects[unknown] = ("unexpected overload",)
    assert without_documents(objects) == {unknown: ("unexpected overload",)}
    del objects[("function", *function)]
    with pytest.raises(AssertionError, match="document collection/quota functions"):
        without_documents(objects)
