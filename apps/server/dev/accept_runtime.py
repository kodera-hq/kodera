#!/usr/bin/env python3
"""Build and test only uniquely owned, disposable local runtime resources."""

import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
POSTGRES = "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94"
OWNER = f"core-bootstrap-{uuid.uuid4().hex[:12]}"
LABEL = "kodera.bootstrap"
DOCKER = shutil.which("docker")


def docker(*args: str, check: bool = True, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    if DOCKER is None:
        raise RuntimeError("Docker is required for isolated acceptance")
    # Fixed commands and separately passed arguments; never shell expansion.
    return subprocess.run(  # noqa: S603
        [DOCKER, *args], capture_output=True, text=True, check=check, timeout=timeout
    )


def owned_remove(kind: str, reference: str) -> None:
    result = docker(kind, "inspect", reference, check=False)
    if result.returncode:
        return
    details = json.loads(result.stdout)[0]
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    if (labels or {}).get(LABEL) != OWNER:
        raise RuntimeError(f"Refusing to remove an unowned {kind}")
    docker(kind, "rm", *(["-f"] if kind != "network" else []), reference)


def request(port: int, path: str) -> tuple[int, dict[str, str]]:
    # This harness constructs only numeric loopback URLs; no caller URL is read.
    try:
        response = urlopen(f"http://127.0.0.1:{port}{path}", timeout=7)  # noqa: S310
    except HTTPError as error:
        response = error
    with response:
        return response.code, json.load(response)


def wait_ready(port: int) -> None:
    for _ in range(40):
        try:
            if request(port, "/health/ready") == (
                200,
                {"status": "ready", "database": "reachable"},
            ):
                return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Disposable API did not become database-ready")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    containers: list[str] = []
    image = f"kodera-server-bootstrap:{OWNER}"
    network = OWNER
    built = network_created = False
    try:
        with tempfile.TemporaryDirectory(prefix="core-bootstrap-build-") as temporary:
            context = Path(temporary)
            for name in ("Dockerfile", ".dockerignore", "pyproject.toml", "uv.lock", "manage.py"):
                shutil.copyfile(ROOT / name, context / name)
            for name in ("config", "core", "apps", "services"):
                shutil.copytree(
                    ROOT / name,
                    context / name,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
            for name in (
                ".env",
                ".git/private",
                "worker/private",
                "config/private.env",
                "core/worker.py",
            ):
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("SYNTHETIC_BUILD_SENTINEL\n")
            result = docker(
                "build",
                "--label",
                f"{LABEL}={OWNER}",
                "-t",
                image,
                str(context),
                check=False,
                timeout=600,
            )
            require(result.returncode == 0, "Local image build failed:\n" + result.stderr[-6000:])
            built = True

        docker("network", "create", "--label", f"{LABEL}={OWNER}", network)
        network_created = True
        db = docker(
            "run",
            "-d",
            "--name",
            f"{OWNER}-db",
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            "--network-alias",
            "db",
            "-p",
            "127.0.0.1::5432",
            "--tmpfs",
            "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
            "-e",
            "POSTGRES_DB=kodera_server",
            "-e",
            "POSTGRES_USER=kodera",
            "-e",
            "POSTGRES_PASSWORD=kodera",
            POSTGRES,
        ).stdout.strip()
        containers.append(db)
        for _ in range(60):
            if (
                docker(
                    "exec", db, "pg_isready", "-U", "kodera", "-d", "kodera_server", check=False
                ).returncode
                == 0
            ):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Disposable PostgreSQL did not become ready")
        db_port = int(docker("port", db, "5432/tcp").stdout.strip().rsplit(":", 1)[1])
        api = docker(
            "run",
            "-d",
            "--name",
            f"{OWNER}-api",
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            "-p",
            "127.0.0.1::8000",
            "--read-only",
            "--tmpfs",
            "/tmp",  # noqa: S108 - container-local tmpfs, never a host path
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "-e",
            "DATABASE_URL=postgres://kodera:kodera@db:5432/kodera_server",
            image,
        ).stdout.strip()
        containers.append(api)
        api_port = int(docker("port", api, "8000/tcp").stdout.strip().rsplit(":", 1)[1])
        wait_ready(api_port)
        require(
            request(api_port, "/health/live") == (200, {"status": "alive"}),
            "Liveness contract failed",
        )
        sentinel = docker(
            "exec",
            api,
            "python",
            "-c",
            "from pathlib import Path; import sys; found = [p for p in ['/app/.env', '/app/.git', '/app/worker', '/app/config/private.env', '/app/core/worker.py'] if Path(p).exists()]; print(found); sys.exit(bool(found))",
            check=False,
        )
        require(
            sentinel.returncode == 0,
            "A forbidden build input entered the API image: " + sentinel.stdout,
        )

        # Host tests receive only noncredential process settings plus this
        # disposable database. Do not forward SSH agents or secrets-file refs.
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
            if key in os.environ
        }
        environment["DATABASE_URL"] = f"postgres://kodera:kodera@127.0.0.1:{db_port}/kodera_server"
        environment["DJANGO_SECRET_KEY"] = "synthetic-acceptance-key"  # noqa: S105 - synthetic local fixture
        result = subprocess.run(  # noqa: S603
            [str(ROOT / ".venv/bin/python"), "-m", "pytest", "--cov", "--cov-report=term-missing"],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
        )
        print(result.stdout)
        require(result.returncode == 0, "Runtime acceptance failed:\n" + result.stderr[-4000:])
        for arguments in (
            ["manage.py", "check"],
            ["manage.py", "makemigrations", "--check", "--dry-run"],
            ["-m", "mypy", "."],
        ):
            check = subprocess.run(  # noqa: S603
                [str(ROOT / ".venv/bin/python"), *arguments],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=60,
            )
            require(
                check.returncode == 0, "Runtime CLI check failed:\n" + check.stdout + check.stderr
            )
            print(check.stdout.strip())
        docker("stop", "--time", "1", db)
        require(
            request(api_port, "/health/ready")
            == (503, {"status": "not_ready", "database": "unavailable"}),
            "Real database outage was reported ready",
        )
        require(
            request(api_port, "/health/live") == (200, {"status": "alive"}),
            "Database outage broke process liveness",
        )
        docker("start", db)
        wait_ready(api_port)

        containers.append(f"{OWNER}-reject")
        rejected = docker(
            "run",
            "--rm",
            "--name",
            f"{OWNER}-reject",
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            "none",
            "-e",
            "SCW_SECRET_KEY=synthetic-private-value",
            image,
            "python",
            "manage.py",
            "check",
            check=False,
        )
        require(
            rejected.returncode != 0
            and "API refuses infrastructure configuration" in rejected.stderr,
            "Container accepted infrastructure configuration",
        )
        require(
            "synthetic-private-value" not in rejected.stderr,
            "Configuration refusal disclosed a value",
        )
        configuration = json.loads(
            docker(
                "compose",
                "-f",
                str(ROOT / "compose.yaml"),
                "--profile",
                "worker",
                "config",
                "--format",
                "json",
                "--no-env-resolution",
            ).stdout
        )
        containers.append(f"{OWNER}-worker")
        worker = docker(
            "run",
            "--rm",
            "--name",
            f"{OWNER}-worker",
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            "none",
            image,
            *configuration["services"]["worker"]["command"],
            check=False,
        )
        # The worker has its own image (Dockerfile.worker): the API image cannot start it.
        require(
            worker.returncode == 1 and "No module named worker" in worker.stderr,
            "The API image starts the worker",
        )
        details = json.loads(docker("image", "inspect", image).stdout)[0]
        print(
            json.dumps(
                {
                    "owner": OWNER,
                    "api_image_id": details["Id"],
                    "postgres_image": POSTGRES,
                    "database_port": db_port,
                    "api_port": api_port,
                    "result": "local runtime acceptance passed",
                }
            )
        )
    finally:
        for container in reversed(containers):
            owned_remove("container", container)
        if network_created:
            owned_remove("network", network)
        if built:
            owned_remove("image", image)


if __name__ == "__main__":
    main()
