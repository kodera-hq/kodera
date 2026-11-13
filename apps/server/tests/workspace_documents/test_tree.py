"""Tree move validation includes every descendant, with a closed depth budget."""

from uuid import uuid4

import pytest

from apps.docs.tree import TreeRefusedError, validate


def chain(length):
    nodes = [uuid4() for _ in range(length)]
    return nodes, {node: nodes[index - 1] if index else None for index, node in enumerate(nodes)}


def test_tree_boundary_and_subtree_move_reject_the_final_excess_depth():
    nodes, parents = chain(16)
    validate(parents)
    parent, child = uuid4(), uuid4()
    parents[parent], parents[child] = None, parent
    validate(parents)
    parents[parent] = nodes[-2]
    with pytest.raises(TreeRefusedError, match="^document tree exceeds maximum depth$"):
        validate(parents)


def test_cycles_and_foreign_parent_refuse_by_message():
    nodes, parents = chain(3)
    parents[nodes[0]] = nodes[-1]
    with pytest.raises(TreeRefusedError, match="^document parent cycle refused$"):
        validate(parents)
    parents[nodes[0]] = uuid4()
    with pytest.raises(TreeRefusedError, match="^document parent is outside the active workspace$"):
        validate(parents)
