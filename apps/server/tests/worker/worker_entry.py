"""The worker the real-kill tests start: `python tests/worker/worker_entry.py`, under the test profile.

It enters the accident guard first, as `python -m worker run` does, then starts Django on
config.settings.test against the test database pytest-django created, arms what the harness wrote
into KODERA_FAULT_CONTROL (core/faults.py, after its gate), and serves the synthetic registry
(worker_fixtures.py) with the synthetic provider of that control directory until SIGTERM, or until
it is killed. Every event the runner emits is one JSON line on stdout. A worker mutant flag named in
WORKER_TEST_MUTANT is activated in process, through worker/mutants.py's gate.

It speaks to the test database and to nothing else. The worker image carries no tests/.
"""

import json
import os
import signal
import sys
import threading
import time
from contextlib import ExitStack, nullcontext
from pathlib import Path
from unittest.mock import patch


def main() -> int:
    from worker import boot

    boot.enter()
    from django.conf import settings

    database = os.environ["WORKER_TEST_DATABASE"]
    if not database.startswith("test_"):
        raise SystemExit(f"the test worker refuses database {database!r}")
    settings.DATABASES["default"]["NAME"] = database

    import django

    django.setup()

    from django.db import connection
    from worker_fixtures import SentinelCredentialSource, synthetic_registry

    from core import faults
    from worker import mutants
    from worker.providers.synthetic import SyntheticProvider
    from worker.runner import Runner

    flag = os.environ.get("WORKER_TEST_MUTANT")
    if flag:
        mutants.activate(flag)
    control = faults.load_control(os.environ)
    if control is None:
        raise SystemExit("the test worker needs KODERA_FAULT_CONTROL")

    # All injections below are after both test-database and fault permission gates. Plans are
    # local to this process; neither registry file nor the production kind bindings change.
    completion_mode = os.environ.get("WORKER_TEST_COMPLETION_MODE")
    completion_seq = int(os.environ.get("WORKER_TEST_COMPLETION_SEQ", "1"))
    if completion_mode not in (
        None,
        "normal",
        "legacy",
        "commit-loss",
        "claim-commit-loss",
        "skip-recovery",
    ):
        raise SystemExit("unknown test completion mode")
    registry = synthetic_registry()
    if completion_mode:
        from apps.jobs.kinds import KINDS
        from worker.registry import Registry, StepPlan

        registry = Registry(
            StepPlan(
                kind,
                seq,
                spec.name,
                convergent=spec.retry_class != "C",
                credential_realm="synthetic-realm",
            )
            for kind in ("backup", "provision")
            for seq, spec in enumerate(KINDS[kind].steps, start=1)
        )

    def barrier(phase, fields):
        faults.write_atomically(
            control / "completion-marker.json", json.dumps({"phase": phase, **fields})
        )
        time.sleep(45)
        raise AssertionError("completion barrier was not killed")

    def emit(event: str, fields: object) -> None:
        line = {"event": event, **dict(fields)}  # type: ignore[call-overload]
        if event == "claimed":
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                line["backend_pid"] = cursor.fetchone()[0]
        if event == "started":
            line["pid"] = os.getpid()
            line["guarded"] = boot.entered()
        sys.stdout.write(json.dumps(line, default=str) + "\n")
        sys.stdout.flush()

    runner = Runner(
        runner_id=os.environ.get("WORKER_TEST_RUNNER_ID", f"test-worker-{os.getpid()}"),
        registry=registry,
        provider=SyntheticProvider.for_run(control),
        credentials=SentinelCredentialSource(control),
        job_root=Path(os.environ["WORKER_TEST_JOB_ROOT"]),
        renew_every_s=float(os.environ.get("WORKER_TEST_RENEW_S", "0.3")),
        emit=emit,
    )
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    # The owned recovery-removal counterexample exists only in this test entry, after the test
    # database and fault permission gates; no production flag or registry entry is introduced.
    recovery = (
        patch("apps.jobs._claim._recover_failed_class_c", return_value=None)
        if os.environ.get("WORKER_TEST_SKIP_FAILED_RECOVERY") == "1"
        else nullcontext()
    )
    with ExitStack() as stack:
        stack.enter_context(recovery)
        if completion_mode:
            from apps.jobs import _claim, _runner

            real_ack = _runner._acknowledge_completed_dispatch
            real_commit = connection.commit

            def acknowledge(**fields):
                if fields["seq"] != completion_seq:
                    return real_ack(**fields)
                if completion_mode == "legacy":
                    assert _runner.close_dispatch(
                        claim=fields["claim"],
                        dispatch_id=fields["dispatch_id"],
                        outcome="completed",
                        evidence_ref=fields["evidence_ref"],
                    )
                    barrier(
                        "legacy",
                        {
                            "job": str(fields["claim"].job_id),
                            "dispatch": str(fields["dispatch_id"]),
                        },
                    )
                if completion_mode == "commit-loss":

                    def commit():
                        real_commit()  # physical commit first; observer reads on another connection
                        barrier(
                            "committed-ack-lost",
                            {
                                "job": str(fields["claim"].job_id),
                                "dispatch": str(fields["dispatch_id"]),
                            },
                        )

                    with patch.object(connection, "commit", commit):
                        return real_ack(**fields)
                return real_ack(**fields)

            stack.enter_context(
                patch.object(_runner, "_acknowledge_completed_dispatch", acknowledge)
            )
            if completion_mode == "skip-recovery":
                from apps.jobs.runner_selectors import CompletionRead

                stack.enter_context(
                    patch(
                        "apps.jobs.runner_selectors.completion_read",
                        return_value=CompletionRead("absent", None),
                    )
                )
                stack.enter_context(patch.object(_claim, "_complete_class_c", return_value=None))
            if completion_mode == "claim-commit-loss":
                original_projection = _claim._complete_class_c
                armed = False

                def projection(job):
                    nonlocal armed
                    original_projection(job)
                    # Only an actual C projection arms the runner connection's next commit.
                    from apps.jobs.models import JobStep

                    if JobStep.objects.filter(
                        job_id=job.id,
                        seq=completion_seq,
                        status="succeeded",
                        output_ref__isnull=False,
                    ).exists():
                        armed = True

                def claim_commit():
                    nonlocal armed
                    real_commit()
                    if armed:
                        armed = False
                        barrier("committed-claim-lost", {})

                stack.enter_context(patch.object(_claim, "_complete_class_c", projection))
                stack.enter_context(patch.object(connection, "commit", claim_commit))
        runner.serve(stop, poll_s=0.1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
