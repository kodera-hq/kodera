"""What the runner reads of a provider: its terminal proof, and the provider's interface.

Shared by the runner (worker/runner.py) and the convergence registry (worker/convergence.py), and
kept apart from any provider's implementation: the deployed worker image carries this module and
no test provider (Dockerfile.worker.dockerignore excludes worker/providers/synthetic.py).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

Outcome = Literal["succeeded", "failed"]


@dataclass(frozen=True)
class TerminalProof:
    """What the provider says became of one dispatch, and the tag that authenticates it."""

    dispatch_id: str
    operation_ref: str
    outcome: Outcome
    tag: bytes

    def evidence_ref(self) -> str:
        return f"synthetic-proof:{self.dispatch_id}:{self.tag.hex()}"

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> TerminalProof:
        outcome = value["outcome"]
        if outcome not in ("succeeded", "failed"):
            raise ValueError("a terminal proof carries no known outcome")
        return cls(
            str(value["dispatch_id"]),
            str(value["operation_ref"]),
            outcome,
            bytes.fromhex(str(value["tag"])),
        )


class Provider(Protocol):
    """The runner's half of a provider: each call's request, and proof verification."""

    def request(
        self, *, dispatch_id: str, operation_ref: str, payload_hash: str, step: str, attempt: int
    ) -> dict[str, Any]: ...

    def verify(self, proof: TerminalProof) -> bool: ...
