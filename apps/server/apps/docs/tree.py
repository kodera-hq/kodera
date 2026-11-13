"""Bounded final-tree validation, including the full height of a moved subtree."""

from uuid import UUID

MAX_DEPTH = 16
MAX_DOCUMENTS = 10000


class TreeRefusedError(ValueError):
    pass


def validate(parents: dict[UUID, UUID | None]) -> None:
    if len(parents) > MAX_DOCUMENTS:
        raise TreeRefusedError("document tree exceeds capacity")
    depths: dict[UUID, int] = {}
    for document in parents:
        chain: list[UUID] = []
        seen: set[UUID] = set()
        current: UUID | None = document
        while current is not None and current not in depths:
            if current in seen:
                raise TreeRefusedError("document parent cycle refused")
            if current not in parents:
                raise TreeRefusedError("document parent is outside the active workspace")
            seen.add(current)
            chain.append(current)
            if len(chain) > MAX_DEPTH:
                raise TreeRefusedError("document tree exceeds maximum depth")
            current = parents[current]
        depth = depths[current] if current is not None else 0
        for node in reversed(chain):
            depth += 1
            if depth > MAX_DEPTH:
                raise TreeRefusedError("document tree exceeds maximum depth")
            depths[node] = depth
