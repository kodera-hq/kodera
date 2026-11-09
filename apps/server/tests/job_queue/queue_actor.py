"""A job-queue runner in its own process, driven over stdin and stdout one JSON line at a time.

`queue_harness.ProcessActor` starts it so that a test can kill a real process with `SIGKILL` while
its database session is mid-transaction or holds live advisory locks. Each reply carries its
request's identifier. It speaks to the test database pytest-django created, and to nothing else.
"""

import json
import os
import sys


def main() -> int:
    from django.conf import settings

    database = os.environ["JOB_QUEUE_TEST_DATABASE"]
    if not database.startswith("test_"):
        raise SystemExit(f"the job-queue actor refuses database {database!r}")
    settings.DATABASES["default"]["NAME"] = database

    import django

    django.setup()

    from queue_harness import ActorCore, binding_for

    core = ActorCore(
        binding_for(os.environ["JOB_QUEUE_BINDING"]), os.environ["JOB_QUEUE_RUNNER_ID"]
    )
    for line in sys.stdin:
        request = json.loads(line)
        reply = core.dispatch(request["method"], request["arguments"])
        reply["request"] = request["request"]
        print(json.dumps(reply), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
