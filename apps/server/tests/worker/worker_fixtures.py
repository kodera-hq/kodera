"""Test-only inputs of the runner: the synthetic registry and a sentinel credential source.

Neither is in the worker image (it carries no tests/). The synthetic registry binds `backup`, a
tenant kind with a retry-class C step, to the synthetic provider: its first step is handed a
credential, its class A steps register a safe-convergence contract and its class C step does not.
It is the registry of the worker these tests start, never the production one, which binds no kind
before G1.5-C.

The sentinel source hands a fresh synthetic secret per load and records, in the control directory,
each issue and each release with the process that made it, so a test can prove from outside the
worker that no credential outlived its call: every issue released, or issued by a process that no
longer exists. The secrets are generated at run time and carry SENTINEL, which nothing else does.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from apps.jobs.kinds import KINDS
from worker.credentials import WORKER_CLIENT_ID, ClientCredential
from worker.registry import Registry, StepPlan

SENTINEL = "kodera-sentinel-credential-"
KIND = "backup"
CREDENTIAL_REALM = "synthetic-realm"
LEDGER = "credentials.jsonl"


def synthetic_registry() -> Registry:
    return Registry(
        StepPlan(
            KIND,
            seq,
            spec.name,
            convergent=spec.retry_class != "C",
            credential_realm=CREDENTIAL_REALM if seq == 1 else None,
        )
        for seq, spec in enumerate(KINDS[KIND].steps, start=1)
    )


class SentinelCredentialSource:
    def __init__(self, control: Path) -> None:
        self.ledger = control / LEDGER

    def _record(self, event: str, token: str, realm: str) -> None:
        with self.ledger.open("a", encoding="utf-8") as handle:
            line = {"event": event, "token": token, "realm": realm, "pid": os.getpid()}
            handle.write(json.dumps(line) + "\n")

    @contextmanager
    def load(self, realm: str) -> Iterator[ClientCredential]:
        token = uuid.uuid4().hex
        self._record("issued", token, realm)
        try:
            yield ClientCredential(WORKER_CLIENT_ID, SENTINEL + uuid.uuid4().hex)
        finally:
            self._record("released", token, realm)


def credential_ledger(control: Path) -> list[dict[str, object]]:
    path = control / LEDGER
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
