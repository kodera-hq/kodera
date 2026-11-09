"""`python -m worker.step`: one provider call, in the child process worker/child.py starts.

It enters the worker's accident guard (worker/boot.py) before anything else, as the worker itself
does: the guard does not cross `exec`, so a Python step child enters it again. It is an accident
guard, not a sandbox. It opens no database connection.

It serves the synthetic provider alone until G1.5-C, and only past core/faults.py's test-profile
gate: the runner hands the child its DJANGO_SETTINGS_MODULE (worker/child.py), the child loads that
profile to ask the gate, and any other profile, or one it cannot load, refuses before the provider is
imported or the request's directory, instructions or key are used. The deployed image carries no
synthetic provider at all (Dockerfile.worker.dockerignore), so there the import would fail too.

It reads one request line on stdin, answers with one line on stdout, `{"answer": <proof or null>}`,
and exits. stdin stays open while the call runs, and end of file on it means the worker is gone: the
child then kills its own process group, so nothing a step started *in that group* outlives the
worker that started it. A descendant that leaves the group (`setsid()`, `setpgid()`) escapes this
kill and the runner's alike until G1.5-C kills every descendant (worker/child.py).
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
from pathlib import Path

from worker import boot

SYNTHETIC_REFUSED = "worker.step refuses the synthetic provider outside the test profile"


def _require_test_profile() -> None:
    from core import faults

    try:
        faults.require_permitted()
    except Exception:  # noqa: BLE001 - refused, or a profile this process cannot load: both refuse
        raise SystemExit(SYNTHETIC_REFUSED) from None


def _die_with_the_worker() -> None:
    # The raw descriptor, not sys.stdin: a daemon thread blocked in a buffered read holds its lock
    # at interpreter shutdown, and the child would abort instead of exiting.
    while os.read(0, 4096):
        pass
    if os.getpgrp() == os.getpid():
        os.killpg(os.getpid(), signal.SIGKILL)
    os._exit(1)


def main() -> int:
    boot.enter()
    request = json.loads(sys.stdin.buffer.readline())
    threading.Thread(target=_die_with_the_worker, daemon=True).start()
    if request.get("provider") != "synthetic":
        raise SystemExit("worker.step serves the synthetic provider alone until G1.5-C")
    _require_test_profile()
    from worker.providers import synthetic

    handed = request.get("credential")
    if handed is not None:
        # The step's credential, read for this call and dropped with it. The synthetic provider
        # holds none and records only that one was handed.
        secret = (Path.cwd() / str(handed)).read_text(encoding="ascii")
        del secret
    answer = synthetic.perform(
        request, credential_handed=handed is not None, guarded=boot.entered()
    )
    sys.stdout.write(json.dumps({"answer": answer}) + "\n")
    sys.stdout.flush()
    # Answered: exit now, so the end of file the runner sends next is not read as its death.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
