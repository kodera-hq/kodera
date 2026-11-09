#!/usr/bin/env python3
"""Qualify the customer schema on one cached, owned disposable PostgreSQL."""

import argparse
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from accept_runtime import POSTGRES, docker

ROOT = Path(__file__).resolve().parents[1]
LABEL = "kodera.customer-persistence"


def main(*, mutations: bool = False) -> None:
    owner = "customer-persistence-" + uuid.uuid4().hex[:12]
    created = False
    try:
        if shutil.disk_usage(ROOT).free < 5 * 1024**3:
            raise RuntimeError("Five GiB local disk reserve is required")
        docker("image", "inspect", POSTGRES)  # Cached artifact only; no acquisition.
        docker(
            "run",
            "-d",
            "--pull=never",
            "--name",
            owner,
            "--label",
            f"{LABEL}={owner}",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--cpus",
            "1",
            "--log-driver",
            "json-file",
            "--log-opt",
            "max-size=10m",
            "--log-opt",
            "max-file=1",
            "--tmpfs",
            "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
            "-p",
            "127.0.0.1::5432",
            "-e",
            "POSTGRES_DB=kodera_server",
            "-e",
            "POSTGRES_USER=kodera",
            "-e",
            "POSTGRES_PASSWORD=kodera",
            POSTGRES,
        )
        created = True
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (
                docker(
                    "exec",
                    owner,
                    "pg_isready",
                    "-U",
                    "kodera",
                    "-d",
                    "kodera_server",
                    check=False,
                    timeout=3,
                ).returncode
                == 0
            ):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Owned PostgreSQL did not become ready")
        details = json.loads(docker("inspect", owner).stdout)[0]
        host = details["HostConfig"]
        ports = details["NetworkSettings"]["Ports"]
        bindings = ports.get("5432/tcp") or []
        if (
            host["Memory"] != 512 * 1024**2
            or host["MemorySwap"] != 512 * 1024**2
            or host["NanoCpus"] != 1000000000
            or len(bindings) != 1
            or bindings[0]["HostIp"] != "127.0.0.1"
            or any(mount["Type"] != "tmpfs" for mount in details["Mounts"])
        ):
            raise RuntimeError("Owned PostgreSQL resource bounds differ")
        port = int(bindings[0]["HostPort"])
        print(
            json.dumps(
                {
                    "owned_container": owner,
                    "image_id": details["Image"],
                    "memory": host["Memory"],
                    "memory_swap": host["MemorySwap"],
                    "nano_cpus": host["NanoCpus"],
                    "tmpfs": host["Tmpfs"],
                    "ports": ports,
                    "network_mode": host["NetworkMode"],
                    "mount_types": [mount["Type"] for mount in details["Mounts"]],
                },
                sort_keys=True,
            )
        )
        if shutil.disk_usage(ROOT).free < 5 * 1024**3:
            raise RuntimeError("Disk reserve fell below five GiB before tests")
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
            if key in os.environ
        }
        environment["DATABASE_URL"] = f"postgres://kodera:kodera@127.0.0.1:{port}/kodera_server"
        environment["DJANGO_SECRET_KEY"] = "synthetic-acceptance-key"  # noqa: S105
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        report = Path("/private/tmp") / (owner + ".xml")
        print("Owned test metadata: " + str(report), flush=True)
        result = subprocess.run(  # noqa: S603
            [
                str(ROOT / ".venv/bin/python"),
                "-m",
                "pytest",
                "-q",
                "-o",
                "junit_family=xunit1",
                "--junitxml",
                str(report),
            ],
            cwd=ROOT,
            env=environment,
            timeout=240,
            check=False,
        )
        if shutil.disk_usage(ROOT).free < 5 * 1024**3:
            raise RuntimeError("Disk reserve fell below five GiB after tests")
        if result.returncode:
            raise RuntimeError("Customer persistence qualification failed")
        print("PASS customer persistence and parent test suite")
        if mutations:
            from mutate_customer_persistence import run_mutations

            if shutil.disk_usage(ROOT).free < 5 * 1024**3:
                raise RuntimeError("Disk reserve below five GiB before mutations")
            run_mutations(environment, report.with_suffix(".mutations.json"))
    finally:
        # Query failure is not absence. Always inspect the exact label before removal.
        listed = docker("ps", "-aq", "--filter", f"name=^/{owner}$").stdout.split()
        if listed:
            details = json.loads(docker("inspect", owner).stdout)[0]
            if details["Config"].get("Labels", {}).get(LABEL) != owner:
                raise RuntimeError("Refusing to remove an unowned PostgreSQL resource")
            docker("rm", "-f", owner)
        elif created:
            print("Owned PostgreSQL was already absent")
        if docker("ps", "-aq", "--filter", f"label={LABEL}={owner}").stdout.strip():
            raise RuntimeError("Owned PostgreSQL cleanup was incomplete")
        print("PASS owned PostgreSQL absence verified")
        if created and shutil.disk_usage(ROOT).free < 5 * 1024**3:
            raise RuntimeError("Disk reserve below five GiB after cleanup")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mutations", action="store_true", help="Run four fixed isolated schema weakenings"
    )
    main(mutations=parser.parse_args().mutations)
