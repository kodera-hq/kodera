"""Current cutoff guards are mandatory only in the schema that installs retention."""

import pytest
from test_workspace_metadata_schema import (
    GUARD_TRIGGERS,
    PRIVACY_CUTOFF_TRIGGERS,
    PRIVACY_SCHEMA_MARKER,
    assert_workspace_trigger_inventory,
)


def inventory(retention):
    result = {("trigger", *value): () for value in GUARD_TRIGGERS}
    if retention:
        result[PRIVACY_SCHEMA_MARKER] = ()
        result.update({("trigger", *value): () for value in PRIVACY_CUTOFF_TRIGGERS})
    return result


@pytest.mark.parametrize("retention", [False, True])
def test_exact_trigger_inventory_accepts_its_declared_schema(retention):
    assert_workspace_trigger_inventory(inventory(retention))


@pytest.mark.parametrize("missing", sorted(PRIVACY_CUTOFF_TRIGGERS))
def test_exact_trigger_inventory_refuses_each_missing_cutoff_guard(missing):
    objects = inventory(True)
    del objects[("trigger", *missing)]
    with pytest.raises(
        AssertionError, match="workspace trigger inventory differs from the declared schema"
    ):
        assert_workspace_trigger_inventory(objects)


@pytest.mark.parametrize("retention", [False, True])
def test_exact_trigger_inventory_refuses_an_unknown_shared_trigger(retention):
    objects = inventory(retention)
    objects[("trigger", "workspaces_workspace", "unknown_retention_guard")] = ()
    with pytest.raises(
        AssertionError, match="workspace trigger inventory differs from the declared schema"
    ):
        assert_workspace_trigger_inventory(objects)
