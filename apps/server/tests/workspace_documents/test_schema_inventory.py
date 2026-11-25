# ruff: noqa: S101
"""Baseline isolation preserves every older and unknown shared schema object."""

import pytest

from workspace_documents.schema_inventory import (
    COLLECTION_QUOTA_FUNCTIONS,
    FUNCTIONS,
    ROLE_GRANT_FUNCTION,
    ROLE_GRANT_KEYS,
    ROLE_GRANT_KIND_TRIGGER,
    ROLE_GRANT_TABLE,
    TABLES,
    without_documents,
)

ROLE_SIGNATURE = (
    "p_document uuid, p_organisation uuid, p_member uuid, p_identity uuid, "
    "p_issuer text, p_subject text"
)
FENCE_SIGNATURE = ROLE_SIGNATURE + ", p_role text, p_confidential boolean, p_epoch bigint"
HISTORICAL_FENCE_SIGNATURE = ROLE_SIGNATURE + ", p_role text"
ROLE_GRANT_ADDITIONS = (
    ("relation", ROLE_GRANT_TABLE, ROLE_GRANT_TABLE),
    ("function", ROLE_GRANT_FUNCTION, ""),
    ("trigger", ROLE_GRANT_TABLE, "docs_role_grant_scope"),
    ("trigger", ROLE_GRANT_TABLE, "aa_privacy_cutoff"),
    ROLE_GRANT_KIND_TRIGGER,
    ("function", "docs_document_role", ROLE_SIGNATURE + ", p_device uuid"),
    ("function", "docs_collab_fence", FENCE_SIGNATURE + ", p_device uuid"),
)
CONFIDENTIAL_ADDITIONS = (
    ("column", "docs_document", "is_confidential"),
    ("column", "docs_document", "encryption_epoch"),
    ("constraint", "docs_document", "docs_confidential_markdown_empty"),
    ("constraint", "docs_document", "docs_encryption_epoch_nonnegative"),
    ("function", "docs_collab_fence", FENCE_SIGNATURE),
)


def document_inventory(migration):
    objects = {("relation", table, table): () for table in TABLES}
    objects.update(
        {
            ("function", name, ""): ()
            for name in FUNCTIONS - {"docs_document_role", "docs_collab_fence"}
        }
    )
    objects[("function", "docs_document_role", ROLE_SIGNATURE)] = ()
    objects[("function", "docs_collab_fence", HISTORICAL_FENCE_SIGNATURE)] = ()
    objects.update({("function", *value): () for value in COLLECTION_QUOTA_FUNCTIONS})
    if migration in {"docs_0012", "docs_0013"}:
        objects.update({key: () for key in CONFIDENTIAL_ADDITIONS})
    if migration == "docs_0013":
        objects.update({key: () for key in ROLE_GRANT_ADDITIONS})
    return objects


@pytest.fixture(params=["docs_0007", "docs_0012"])
def historical_inventory(request):
    return document_inventory(request.param)


@pytest.fixture(params=["docs_0007", "docs_0012", "docs_0013"])
def inventory(request):
    return document_inventory(request.param)


@pytest.fixture(params=["docs_0012", "docs_0013"])
def confidential_inventory(request):
    return document_inventory(request.param)


def test_document_inventory_refuses_a_missing_scope_guard(historical_inventory):
    objects = historical_inventory
    older = ("function", "workspace_structure_immutable", "")
    unknown = ("function", "workspace_unknown_guard", "")
    objects[older], objects[unknown] = ("original",), ("unexpected",)
    assert without_documents(objects) == {
        older: ("original",),
        unknown: ("unexpected",),
    }
    del objects[("function", "docs_scope_guard", "")]
    with pytest.raises(AssertionError, match="document scope functions"):
        without_documents(objects)


@pytest.mark.parametrize("function", sorted(COLLECTION_QUOTA_FUNCTIONS))
def test_document_inventory_uses_exact_collection_and_quota_signatures(
    function, historical_inventory
):
    objects = historical_inventory
    unknown = ("function", function[0], "p_unknown text")
    objects[unknown] = ("unexpected overload",)
    assert without_documents(objects) == {unknown: ("unexpected overload",)}
    del objects[("function", *function)]
    with pytest.raises(AssertionError, match="document collection/quota functions"):
        without_documents(objects)


def test_document_inventory_handles_complete_historical_and_current_grant_schemas(inventory):
    assert without_documents(inventory) == {}


def test_document_inventory_accepts_docs_0007_seven_argument_collab_fence():
    objects = document_inventory("docs_0007")
    # The index is replaced in 0012, but its key exists in 0007 too.
    objects[("index", "docs_document", "docs_fulltext")] = ()
    assert without_documents(objects) == {}


def test_role_grant_keys_identify_only_new_0013_objects():
    assert ROLE_GRANT_KEYS == set(ROLE_GRANT_ADDITIONS)
    assert ROLE_GRANT_KEYS.isdisjoint(document_inventory("docs_0012"))


@pytest.mark.parametrize("missing", CONFIDENTIAL_ADDITIONS)
def test_document_inventory_requires_every_confidential_addition(missing, confidential_inventory):
    del confidential_inventory[missing]
    with pytest.raises(AssertionError, match="pre-role-grant document functions"):
        without_documents(confidential_inventory)


@pytest.mark.parametrize("survivor", CONFIDENTIAL_ADDITIONS)
def test_document_inventory_cannot_mistake_partial_0012_for_0007(survivor):
    objects = document_inventory("docs_0007")
    objects[survivor] = ()
    with pytest.raises(AssertionError, match="pre-role-grant document functions"):
        without_documents(objects)


@pytest.mark.parametrize("signature", [HISTORICAL_FENCE_SIGNATURE, FENCE_SIGNATURE])
def test_document_inventory_requires_each_compatibility_fence(signature, confidential_inventory):
    del confidential_inventory[("function", "docs_collab_fence", signature)]
    with pytest.raises(AssertionError, match="pre-role-grant document functions"):
        without_documents(confidential_inventory)


def test_document_inventory_cannot_hide_both_missing_fences_behind_an_unknown_overload(
    confidential_inventory,
):
    del confidential_inventory[("function", "docs_collab_fence", HISTORICAL_FENCE_SIGNATURE)]
    del confidential_inventory[("function", "docs_collab_fence", FENCE_SIGNATURE)]
    confidential_inventory[("function", "docs_collab_fence", "p_unknown text")] = ()
    with pytest.raises(AssertionError, match="pre-role-grant document functions"):
        without_documents(confidential_inventory)


@pytest.mark.parametrize("survivor", ROLE_GRANT_ADDITIONS)
def test_document_inventory_refuses_any_isolated_role_grant_object(survivor, historical_inventory):
    historical_inventory[survivor] = ()
    with pytest.raises(AssertionError, match="document role grant objects"):
        without_documents(historical_inventory)


@pytest.mark.parametrize("missing", ROLE_GRANT_ADDITIONS)
def test_document_inventory_requires_every_role_grant_object(missing, historical_inventory):
    historical_inventory.update({key: () for key in ROLE_GRANT_ADDITIONS})
    del historical_inventory[missing]
    with pytest.raises(AssertionError, match="document role grant objects"):
        without_documents(historical_inventory)


@pytest.mark.parametrize("name", ["docs_document_role", "docs_collab_fence"])
def test_document_inventory_requires_exact_predecessor_signatures(name, inventory):
    key = next(key for key in inventory if key[:2] == ("function", name))
    del inventory[key]
    inventory[("function", name, "p_unknown text")] = ()
    with pytest.raises(AssertionError, match="pre-role-grant document functions"):
        without_documents(inventory)


def test_document_inventory_retains_a_relation_named_after_the_role_grant_function(
    inventory,
):
    unrelated = ("relation", ROLE_GRANT_FUNCTION, ROLE_GRANT_FUNCTION)
    inventory[unrelated] = ("unrelated relation",)
    assert without_documents(inventory) == {unrelated: ("unrelated relation",)}
