"""What a step may replay, and what its provider's answer settles (JOB_CATALOGUE.md §1, recovery).

The convergence registry records each dispatch this runner opened: its id, its `operation_ref` and
the hash of the payload it sent. A step whose response was lost may be replayed only by the runner
that opened the dispatch, only when its plan registers a safe-convergence contract, and only under
that same still-open dispatch with the same `operation_ref` and an unchanged payload: a replay is a
retransmission under the existing dispatch, never a new `record_dispatch`, and it proves nothing.

Only authenticated terminal proof closes a dispatch. `settle()` turns the provider's answer into one
of two acts: `close_dispatch` with the proof as evidence, or `hold_for_reconciliation`, for anything
else: no proof, a proof of another dispatch, or a proof whose tag does not verify.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from . import mutants
from .proof import TerminalProof
from .registry import StepPlan

# A dispatch outcome, from the provider's own.
OUTCOMES = {"succeeded": "completed", "failed": "failed"}


def payload_hash(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class Dispatched:
    dispatch_id: UUID
    operation_ref: str
    payload_hash: str


class Convergence:
    """The dispatches this runner opened, and whether one of them may be replayed."""

    def __init__(self) -> None:
        self._recorded: dict[UUID, Dispatched] = {}

    def record(self, dispatched: Dispatched) -> None:
        self._recorded[dispatched.dispatch_id] = dispatched

    def forget(self, dispatch_id: UUID) -> None:
        self._recorded.pop(dispatch_id, None)

    def replay_refusals(
        self,
        plan: StepPlan,
        again: Dispatched,
        open_dispatch: tuple[UUID, str] | None,
    ) -> list[str]:
        """Why `again` may not be replayed, or []. `open_dispatch` is the job's one open dispatch
        at the claim's fence, read from the database just before: (id, operation_ref), or None."""
        refusals = []
        if not plan.convergent:
            refusals.append(f"step {plan.name} registers no safe-convergence contract")
        recorded = self._recorded.get(again.dispatch_id)
        if recorded is None:
            return [*refusals, f"dispatch {again.dispatch_id} was not opened by this runner"]
        if not mutants.on("replay_ignores_open_dispatch") and (
            open_dispatch is None or open_dispatch[0] != again.dispatch_id
        ):
            refusals.append(f"dispatch {again.dispatch_id} is no longer the job's open dispatch")
        if not mutants.on("replay_ignores_operation_ref") and (
            again.operation_ref != recorded.operation_ref
            or (open_dispatch is not None and open_dispatch[1] != recorded.operation_ref)
        ):
            refusals.append(f"dispatch {again.dispatch_id}'s operation_ref changed")
        if not mutants.on("replay_ignores_payload_hash") and (
            again.payload_hash != recorded.payload_hash
        ):
            refusals.append(f"dispatch {again.dispatch_id}'s payload changed since it was sent")
        return refusals


@dataclass(frozen=True)
class Settlement:
    action: Literal["close", "hold"]
    reason: str
    outcome: str | None = None
    evidence_ref: str | None = None


def _hold(reason: str) -> Settlement:
    return Settlement("hold", reason)


def settle(
    proof: TerminalProof | None,
    *,
    dispatch_id: UUID,
    operation_ref: str,
    verify: Callable[[TerminalProof], bool],
) -> Settlement:
    """Close on authenticated terminal proof of this very dispatch; hold on anything else."""
    if proof is None:
        return _hold("the provider returned no terminal proof")
    if proof.dispatch_id != str(dispatch_id) or proof.operation_ref != operation_ref:
        return _hold("the terminal proof names another dispatch")
    if proof.outcome not in OUTCOMES:
        return _hold("the terminal proof carries no known outcome")
    if not mutants.on("settle_accepts_unauthenticated_proof") and not verify(proof):
        return _hold("the terminal proof is not authenticated")
    return Settlement(
        "close",
        "authenticated terminal proof",
        outcome=OUTCOMES[proof.outcome],
        evidence_ref=proof.evidence_ref(),
    )
