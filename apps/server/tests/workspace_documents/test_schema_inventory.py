# ruff: noqa: S101
"""Baseline isolation preserves every older and unknown shared schema object."""

import pytest

from workspace_documents.schema_inventory import FUNCTIONS, TABLES, without_documents


def test_document_inventory_refuses_a_missing_scope_guard():
    objects = {("relation", table, table): () for table in TABLES}
    objects.update({("function", name, ""): () for name in FUNCTIONS})
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
