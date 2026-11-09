#!/usr/bin/env python3
"""Qualify the built worker image (G1.5-A), in CI's `images` job: the half tests/worker cannot see.

It builds Dockerfile.worker, then proves on the image itself, with uniquely owned and disposable
Docker resources removed at the end:

1. its files are exactly what its build context admits (dev/image_context.py), so BuildKit read
   Dockerfile.worker.dockerignore and the database-free checks (WK-09, WK-10) read the real image;
   and they hold no URL, WSGI or API module and no profile but deploy_worker;
2. `python -m worker check` holds the boundary inside the read-only, capability-free container;
3. on an internal network shaped like compose's `worker-db`, holding a throwaway PostgreSQL and the
   worker alone, `python -m worker run` reaches the database and stops, saying it serves no job
   kind before G1.5-C binds its steps, and a plain connection to the database opens.

What it does not prove: isolation. The database-only topology is proven by what compose declares
(tests/worker, WK-07: an internal network, the database and the worker alone on it, no port, no
other network), and in production by Fleet's network policy (lane decision W2). The failed
connections this script tries from the worker's network are a smoke test: nothing here shows those
destinations would have answered otherwise. A public address reached fails the run, since the
internal network must stop it. The network's gateway, the host's side of the bridge, is only
recorded (`gateway_reachable`, `gateway_note`): a container on an internal network can still reach
the host through its bridge gateway, and the host firewall, not compose, must drop worker-network
to host traffic except to the database. A live proof that forbidden peers are isolated is out
of scope: Fleet's production network policy is the SRE's evidence.

Exit 0 and one JSON summary line on success; otherwise a RuntimeError naming the first failure.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dev.image_context import image_files  # noqa: E402
from dev.worker_boundary import (  # noqa: E402
    configured_refusals,
    listing_refusals,
    outside_probe_verdict,
    worker_image_refusals,
)

POSTGRES = "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94"
OWNER = f"core-worker-{uuid.uuid4().hex[:12]}"
LABEL = "kodera.worker-image"
DOCKER = shutil.which("docker")
DATABASE_URL = "postgres://kodera:kodera@db:5432/kodera_server"
# worker/runner.py NO_KIND_SERVED; tests/worker pins the two to one text.
NO_KIND_SERVED = "this worker serves no job kind: no step is bound to a provider before G1.5-C, so it claims no job"
# As compose runs the worker: read-only, a tmpfs /tmp inside the container, no capability.
HARDENED = ("--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL")  # noqa: S108
LISTING = (
    "import json, pathlib; root = pathlib.Path('/app'); "
    "print(json.dumps(sorted(p.relative_to(root).as_posix() for p in root.rglob('*') "
    "if p.is_file())))"
)
CONNECT = (
    "import socket, sys; host, port = sys.argv[1], int(sys.argv[2]); "
    "socket.create_connection((host, port), timeout=4).close(); print('connected')"
)


def docker(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    if DOCKER is None:
        raise RuntimeError("Docker is required for the worker image qualification")
    # Fixed commands and separately passed arguments; never shell expansion.
    return subprocess.run(  # noqa: S603
        [DOCKER, *args], capture_output=True, text=True, check=check, timeout=timeout
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def owned_remove(kind: str, reference: str) -> None:
    found = docker(kind, "inspect", reference, check=False)
    if found.returncode:
        return
    details = json.loads(found.stdout)[0]
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    if (labels or {}).get(LABEL) != OWNER:
        raise RuntimeError(f"refusing to remove an unowned {kind}")
    docker(kind, "rm", *(["-f"] if kind != "network" else []), reference)


def run(
    image: str, *args: str, network: str = "none", entrypoint: str | None = None
) -> subprocess.CompletedProcess[str]:
    return docker(
        "run",
        "--rm",
        "--label",
        f"{LABEL}={OWNER}",
        "--network",
        network,
        *HARDENED,
        *(("--entrypoint", entrypoint) if entrypoint else ()),
        "-e",
        f"DATABASE_URL={DATABASE_URL}",
        image,
        *args,
        check=False,
    )


def main() -> None:
    image = f"kodera-core-worker:{OWNER}"
    network = OWNER
    database = f"{OWNER}-db"
    try:
        docker(
            "build",
            "--file",
            str(ROOT / "Dockerfile.worker"),
            "--label",
            f"{LABEL}={OWNER}",
            "--tag",
            image,
            str(ROOT),
            timeout=1200,
        )

        configured = json.loads(docker("image", "inspect", image).stdout)[0]["Config"]
        refusals = configured_refusals(configured)
        require(not refusals, "; ".join(refusals))

        listed = run(image, "-c", LISTING, entrypoint="python")
        require(
            listed.returncode == 0, f"the worker image's files could not be listed: {listed.stderr}"
        )
        built = json.loads(listed.stdout.strip().splitlines()[-1])
        refusals = listing_refusals(built, image_files(ROOT, "Dockerfile.worker"))
        refusals += worker_image_refusals(built)
        require(not refusals, "; ".join(refusals))

        checked = run(image, "python", "-m", "worker", "check")
        require(
            checked.returncode == 0, f"the worker image's boundary check failed: {checked.stderr}"
        )
        report = json.loads(checked.stdout.strip().splitlines()[-1])
        require(
            report["bind"] == "refused" and report["listen"] == "refused",
            "the worker image's process can bind or listen",
        )

        docker("network", "create", "--internal", "--label", f"{LABEL}={OWNER}", network)
        docker(
            "run",
            "--detach",
            "--name",
            database,
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            "--network-alias",
            "db",
            "-e",
            "POSTGRES_DB=kodera_server",
            "-e",
            "POSTGRES_USER=kodera",
            "-e",
            "POSTGRES_PASSWORD=kodera",
            POSTGRES,
            timeout=300,
        )
        for _ in range(60):
            ready = docker(
                "exec", database, "pg_isready", "-U", "kodera", "-d", "kodera_server", check=False
            )
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("the throwaway PostgreSQL never became ready")

        started = run(image, network=network)
        lines = started.stderr.strip().splitlines()
        require(
            started.returncode == 1
            and '{"worker": "started", "database": "reachable"}' in lines
            and lines[-1:] == [NO_KIND_SERVED],
            f"the worker did not reach its database and stop: {started.stderr[-2000:]}",
        )
        inside = run(image, "-c", CONNECT, "db", "5432", network=network, entrypoint="python")
        require(
            inside.returncode == 0 and inside.stdout.strip() == "connected",
            f"the network probe cannot reach the database: {inside.stderr[-2000:]}",
        )
        inspected = json.loads(docker("network", "inspect", network).stdout)[0]
        gateways = [c["Gateway"] for c in inspected["IPAM"]["Config"] or [] if c.get("Gateway")]
        targets = [("1.1.1.1", "443", "public"), ("8.8.8.8", "53", "public")]
        targets += [(gateway, port, "gateway") for gateway in gateways for port in ("22", "5432")]
        probes = []
        for host, port, kind in targets:
            outside = run(image, "-c", CONNECT, host, port, network=network, entrypoint="python")
            reached = outside.returncode == 0 and outside.stdout.strip() == "connected"
            probes.append((host, port, kind, reached))
        failures, record = outside_probe_verdict(probes)
        require(not failures, "; ".join(failures))
        print(
            json.dumps(
                {
                    "files": len(built),
                    "boundary": "held",
                    "database": "reachable",
                    **record,
                    "runner": "absent",
                }
            )
        )
    finally:
        owned_remove("container", database)
        owned_remove("network", network)
        found = docker("image", "inspect", image, check=False)
        if found.returncode == 0:
            labels = json.loads(found.stdout)[0]["Config"].get("Labels") or {}
            if labels.get(LABEL) != OWNER:
                raise RuntimeError("refusing to remove an unowned image")
            docker("image", "rm", "-f", image, check=False)


if __name__ == "__main__":
    main()
