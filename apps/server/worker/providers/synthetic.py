"""The synthetic provider: the provider interface the first slice runs against (lane decision W3).

It runs inside the worker, in the step's own child process (worker/step.py), holds no credential and
keeps its ledger in a test-only control directory: `<KODERA_FAULT_CONTROL>/provider/`. Its terminal
proof is authenticated by an HMAC-SHA256 tag over (dispatch id, operation_ref, outcome), with a key
generated per run under the test profile: `for_run()` passes core/faults.py's gate before it reads,
or writes, anything in that directory, so no other profile reads the key (and every deployed
profile refuses `KODERA_FAULT_CONTROL` at start).

Two halves. In the runner, `SyntheticProvider` builds each call's request, reads what the test
asked of that call (`plan.json`: step name -> one instruction per attempt, the last repeated;
`complete` when absent) and verifies the proofs. In the step child, `perform()` records the call in
the ledger and answers it: `complete` and `fail` answer with a proof, `hold` first waits until the
test writes `release/<dispatch>-<attempt>`, `silent` answers nothing (a lost response), `garble`
answers with a tag that does not verify. The key reaches the child in its request on stdin, never
in its environment. The ledger records whether a credential was handed to the call, never its value.
Ledger, held and answer files are written whole or not at all (core/faults.py `write_atomically`):
the test polls for them while the child writes.

**What the proof proves.** The child that answers holds the key that tags the answer: the proof is
signed by the very process it authenticates. It proves the runner's wiring (only a verifying tag of
this dispatch and operation_ref closes a dispatch; anything else holds) and nothing about a provider
independent of the step. G1.5-C's real providers must keep the verifying key out of the step child,
so that a step cannot vouch for itself.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from worker.proof import Outcome as Outcome, TerminalProof as TerminalProof

INSTRUCTIONS = ("complete", "fail", "hold", "silent", "garble")
KEY_BYTES = 32
PROVIDER_DIRECTORY = "provider"
HOLD_POLL_S = 0.05
# A held call that is never released ends as a lost response, not a hang.
HOLD_LIMIT_S = 120.0


def _tag(key: bytes, dispatch_id: str, operation_ref: str, outcome: str) -> bytes:
    message = json.dumps([dispatch_id, operation_ref, outcome], separators=(",", ":"))
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


class SyntheticProvider:
    """The runner's half: requests, the test's instructions, and proof verification."""

    def __init__(self, *, key: bytes, directory: Path) -> None:
        """Refused, as `for_run()` is, unless the process runs the test profile with its
        permission: a provider that verifies proofs is test-only however it is built."""
        from core import faults

        faults.require_permitted()
        if len(key) != KEY_BYTES:
            raise ValueError("the synthetic provider's key is 32 bytes")
        self._key = key
        self.directory = directory

    @classmethod
    def for_run(cls, control: Path) -> SyntheticProvider:
        """The provider of this run's control directory, its key generated on first use. Refused,
        before any file is touched, unless the process runs the test profile with its permission."""
        from core import faults

        faults.require_permitted()
        directory = control / PROVIDER_DIRECTORY
        directory.mkdir(mode=0o700, exist_ok=True)
        key_path = directory / "key"
        try:
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(secrets.token_bytes(KEY_BYTES))
        return cls(key=key_path.read_bytes(), directory=directory)

    def terminal_proof(
        self, *, dispatch_id: str, operation_ref: str, outcome: Outcome
    ) -> TerminalProof:
        return TerminalProof(
            dispatch_id,
            operation_ref,
            outcome,
            _tag(self._key, dispatch_id, operation_ref, outcome),
        )

    def verify(self, proof: TerminalProof) -> bool:
        expected = _tag(self._key, proof.dispatch_id, proof.operation_ref, proof.outcome)
        return hmac.compare_digest(expected, proof.tag)

    def instruction(self, step: str, attempt: int) -> str:
        plan_path = self.directory / "plan.json"
        if not plan_path.exists():
            return "complete"
        planned = json.loads(plan_path.read_text(encoding="utf-8")).get(step)
        if not planned:
            return "complete"
        found = str(planned[min(attempt, len(planned)) - 1])
        if found not in INSTRUCTIONS:
            raise ValueError(f"{found!r} is not a synthetic provider instruction")
        return found

    def request(
        self, *, dispatch_id: str, operation_ref: str, payload_hash: str, step: str, attempt: int
    ) -> dict[str, Any]:
        return {
            "provider": "synthetic",
            "directory": str(self.directory),
            "key": self._key.hex(),
            "dispatch_id": dispatch_id,
            "operation_ref": operation_ref,
            "payload_hash": payload_hash,
            "step": step,
            "attempt": attempt,
            "instruction": self.instruction(step, attempt),
        }


def _write(path: Path, value: Mapping[str, Any]) -> None:
    from core.faults import write_atomically

    path.parent.mkdir(exist_ok=True)
    write_atomically(path, json.dumps(value))


def perform(
    request: Mapping[str, Any], *, credential_handed: bool, guarded: bool
) -> dict[str, Any] | None:
    """The child's half: record the call, follow its instruction, answer with a proof or nothing."""
    directory = Path(str(request["directory"]))
    name = f"{request['dispatch_id']}-{request['attempt']}"
    _write(
        directory / "ledger" / f"{name}.json",
        {
            "dispatch_id": request["dispatch_id"],
            "operation_ref": request["operation_ref"],
            "payload_hash": request["payload_hash"],
            "step": request["step"],
            "attempt": request["attempt"],
            "pid": os.getpid(),
            "pgid": os.getpgrp(),
            "credential_handed": credential_handed,
            "guarded": guarded,
        },
    )
    instruction = request["instruction"]
    if instruction == "hold":
        _write(directory / "held" / f"{name}.json", {"pid": os.getpid()})
        deadline = time.monotonic() + HOLD_LIMIT_S
        while not (directory / "release" / name).exists():
            if time.monotonic() > deadline:
                return None
            time.sleep(HOLD_POLL_S)
    if instruction == "silent":
        return None
    outcome = "failed" if instruction == "fail" else "succeeded"
    tag = _tag(
        bytes.fromhex(str(request["key"])),
        str(request["dispatch_id"]),
        str(request["operation_ref"]),
        outcome,
    )
    if instruction == "garble":
        tag = bytes(byte ^ 0xFF for byte in tag)
    return {
        "dispatch_id": request["dispatch_id"],
        "operation_ref": request["operation_ref"],
        "outcome": outcome,
        "tag": tag.hex(),
    }
