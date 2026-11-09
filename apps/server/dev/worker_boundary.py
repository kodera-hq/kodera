"""The worker's boundary, as checks over what compose declares and what an image carries.

Each check returns the reasons a configuration breaks the boundary, one sentence each, or []. They
are shared by the database-free acceptance (tests/worker) and the built-image qualification CI runs
(dev/accept_worker_image.py), so both hold the worker to one definition.
"""

from __future__ import annotations

import importlib.util
import re
from collections.abc import Mapping
from typing import Any

NETWORK = "worker-db"


def runner_missing() -> bool:
    """True while the worker has no job runner (G1.5-B): no `worker.runner` the import system finds,
    module or package. The first-slice Worker facade and the WK gap probe both measure this."""
    return importlib.util.find_spec("worker.runner") is None


def _network_names(service: Mapping[str, Any]) -> list[str]:
    networks = service.get("networks") or []
    return sorted(networks) if isinstance(networks, Mapping) else sorted(networks)


def worker_network_refusals(compose: Mapping[str, Any]) -> list[str]:
    """Why compose's worker could reach more than its database, or [] (decision W2)."""
    services = compose.get("services") or {}
    worker = services.get("worker") or {}
    refusals = []
    if "network_mode" in worker:
        refusals.append("the worker sets a network mode instead of joining the worker-db network")
    if _network_names(worker) != [NETWORK]:
        refusals.append("the worker joins a network other than worker-db alone")
    if worker.get("ports") or worker.get("expose"):
        refusals.append("the worker publishes or exposes a port")
    network = (compose.get("networks") or {}).get(NETWORK) or {}
    if network.get("internal") is not True:
        refusals.append("the worker-db network is not internal")
    members = sorted(name for name, s in services.items() if NETWORK in _network_names(s))
    if members != ["db", "worker"]:
        refusals.append(f"the worker-db network holds {members}, not the database and the worker")
    # A service that shares another's namespace (`service:db`, `container:...`) or the host's joins
    # its networks without naming them, so no service may share one at all.
    for name, service in sorted(services.items()):
        mode = str(service.get("network_mode") or "")
        if name != "worker" and (mode == "host" or mode.startswith(("service:", "container:"))):
            refusals.append(f"{name} shares a network namespace through network_mode {mode}")
    return refusals


# What the worker image must never carry: an HTTP surface, or a settings profile but its own.
URL_OR_API = re.compile(
    r"(config/[^/]*(urls|wsgi|gunicorn)[^/]*\.py|apps/[^/]+/api/.*|core/api/.*|core/health\.py)\Z"
)
WORKER_IMAGE_SETTINGS = {
    "config/settings/__init__.py",
    "config/settings/base.py",
    "config/settings/deploy_worker.py",
}
# A test, a fixture (a W3 test key among them) or bytecode under worker/, at any depth.
TEST_OR_BYTECODE = re.compile(r"worker/(?:.*/)?(?:test[^/]*(?:/.*)?|__pycache__/.*|[^/]*\.pyc)\Z")
# Test-only code under worker/ that the image must not carry (worker/step.py refuses it besides).
WORKER_IMAGE_TEST_ONLY = ("worker/providers/synthetic.py",)
WORKER_IMAGE_NEEDS = ("worker/__main__.py", "worker/boot.py", "config/settings/deploy_worker.py")


def api_image_worker_refusals(files: list[str]) -> list[str]:
    """Why the API image carries some of the worker, or []."""
    return [
        f"the API image carries {path}, which belongs to the worker"
        for path in sorted(files)
        if path.startswith("worker/") or path == "config/settings/deploy_worker.py"
    ]


def worker_image_refusals(files: list[str]) -> list[str]:
    """Why the worker image carries an HTTP surface or another profile, or lacks itself, or []."""
    refusals = [
        f"the worker image carries {path}, a URL, WSGI or API module"
        for path in sorted(files)
        if URL_OR_API.match(path)
    ]
    refusals += [
        f"the worker image carries {path}, a settings profile other than deploy_worker"
        for path in sorted(files)
        if path.startswith("config/settings/") and path not in WORKER_IMAGE_SETTINGS
    ]
    refusals += [
        f"the worker image carries {path}, a test, fixture or bytecode file"
        for path in sorted(files)
        if TEST_OR_BYTECODE.match(path)
    ]
    refusals += [
        f"the worker image carries {path}, a test-only provider"
        for path in WORKER_IMAGE_TEST_ONLY
        if path in files
    ]
    refusals += [
        f"the worker image lacks {path}" for path in WORKER_IMAGE_NEEDS if path not in files
    ]
    return refusals


def listing_refusals(built: list[str], context: list[str]) -> list[str]:
    """Where the built image's files differ from what the build context admits."""
    return [
        f"the built worker image carries {path}, which its build context does not admit"
        for path in sorted(set(built) - set(context))
    ] + [
        f"the built worker image lacks {path}, which its build context admits"
        for path in sorted(set(context) - set(built))
    ]


WORKER_USER = "10001:10001"
WORKER_COMMAND = ["python", "-m", "worker", "run"]


def runtime_stage_refusals(dockerfile: str) -> list[str]:
    """Why the worker image's runtime stage would run as another user or another program, or []."""
    stage = [line.strip() for line in dockerfile.split("\nFROM ")[-1].splitlines()]
    users = [line.split(None, 1)[1] for line in stage if line.startswith("USER ")]
    commands = [line.split(None, 1)[1] for line in stage if line.startswith("CMD ")]
    refusals = []
    if users != [WORKER_USER]:
        refusals.append(f"the worker image does not run as {WORKER_USER}")
    if commands != ['["' + '", "'.join(WORKER_COMMAND) + '"]']:
        refusals.append("the worker image's command is not python -m worker run")
    if any(line.startswith("ENTRYPOINT") for line in stage):
        refusals.append("the worker image declares an entrypoint")
    return refusals


def configured_refusals(config: Mapping[str, Any]) -> list[str]:
    """The same, read from a built image's `docker image inspect` Config."""
    refusals = []
    if config.get("User") != WORKER_USER:
        refusals.append(f"the built worker image does not run as {WORKER_USER}")
    if config.get("Cmd") != WORKER_COMMAND:
        refusals.append("the built worker image's command is not python -m worker run")
    if config.get("Entrypoint"):
        refusals.append("the built worker image declares an entrypoint")
    return refusals


# A container on a Docker `internal: true` network can still reach the host through its bridge
# gateway: compose cannot close that, the host firewall must (drop worker-network -> host traffic
# except to the database). So a gateway the worker reaches is recorded, never failed, and never
# read as isolation either way.
GATEWAY_NOTE = "host firewall required"
PROBE_KINDS = ("public", "gateway")


def outside_probe_verdict(
    probes: list[tuple[str, str, str, bool]],
) -> tuple[list[str], dict[str, Any]]:
    """The failures and the record of the image's outside probes, each (host, port, kind, reached).

    Fails only for what compose controls, egress to a public address; records the gateway."""
    for _, _, kind, _ in probes:
        if kind not in PROBE_KINDS:
            raise ValueError(f"unknown probe kind {kind}")
    failures = [
        f"the worker's network reaches the public address {host}:{port}"
        for host, port, kind, reached in probes
        if kind == "public" and reached
    ]
    record = {
        "public_reachable": any(r for _, _, kind, r in probes if kind == "public"),
        "gateway_reachable": any(r for _, _, kind, r in probes if kind == "gateway"),
        "gateway_note": GATEWAY_NOTE,
    }
    return failures, record
