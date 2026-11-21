#!/usr/bin/env python3
"""Hosted-only bounded Community + Enterprise container boot proof (`BUG-0072`).

Builds and boots both `apps/server/Dockerfile` runtime variants against an isolated,
owned synthetic PostgreSQL container:
1. Community variant (default `FROM scratch AS ee_src` without `--build-context ee_src=...`):
   - Proves `/app/ee` contains zero EE Python modules.
   - Proves `GET /api/v1/ee/status` remains disabled (`403`, `enterprise_edition_required`).
2. Enterprise variant (`docker buildx build --load --build-context ee_src=../../ee`):
   - Proves `/app/ee/__init__.py` is present while `ee/.dockerignore` excludes test suites.
   - Boots under `KODERA_EDITION=enterprise` and proves `GET /api/v1/ee/status` returns
     HTTP `200` (`edition == "enterprise"`, `enterprise_enabled == True`) and cold-start
     `GET /api/v1/ee/billing/plans` returns HTTP `200` (`BUG-0036`).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev.accept_production_http import (  # noqa: E402
    PASSWORD,
    POSTGRES,
    SECRET,
    caps,
    docker,
    fixture,
    inspect,
    owned_runtime_diagnostics,
    production_command,
    published_port,
    request as http_request,
    require,
    require_disk_reserve,
    resources,
    signature,
    source_hashes,
    wait_ready,
)

LABEL = "kodera.enterprise-qualification"
OWNER = "enterprise-http-" + uuid.uuid4().hex[:12]
PHASE = "admission"


def owned(details: dict, kind: str) -> None:
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    require((labels or {}).get(LABEL) == OWNER, "resource owner mismatch")


def absent(kind: str, reference: str | None = None) -> None:
    if kind == "image":
        result = docker("image", "ls", "-q", "--filter", f"label={LABEL}={OWNER}")
        require(not result.stdout.strip(), "owned image remains")
        return
    result = docker(kind, "ls", *(["-a"] if kind == "container" else []), "--format", "{{json .}}")
    key = "Names" if kind == "container" else "Name"
    names = [json.loads(line)[key] for line in result.stdout.splitlines() if line]
    require(reference not in names, "owned resource remains")


def remove_resource(kind: str, reference: str) -> None:
    result = docker(kind, "inspect", reference, check=False)
    if result.returncode == 0:
        owned(json.loads(result.stdout)[0], kind)
        docker(kind, "rm", *([] if kind == "network" else ["-f"]), reference)
    absent(kind, reference)


def run() -> None:
    global PHASE
    require(os.environ.get("GITHUB_ACTIONS") == "true", "hosted-only qualification")
    PHASE = "disk-admission"
    require_disk_reserve()
    PHASE = "tracked-source-inventory"
    frozen = source_hashes()

    network = f"{OWNER}-net"
    database = f"{OWNER}-db"
    community_api = f"{OWNER}-community-api"
    enterprise_api = f"{OWNER}-enterprise-api"
    community_image = f"{OWNER}:community"
    enterprise_image = f"{OWNER}:enterprise"
    containers = [database, community_api, enterprise_api]
    images = [community_image, enterprise_image]
    trust, _token = signature()

    try:
        PHASE = "owned-network-create"
        docker("network", "create", "--label", f"{LABEL}={OWNER}", network)
        network_info = json.loads(docker("network", "inspect", network).stdout)[0]
        owned(network_info, "network")

        PHASE = "owned-postgresql-start"
        docker(
            "run",
            "-d",
            "--name",
            database,
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            "--network-alias",
            "db",
            "--user",
            "999:999",
            *caps(768 * 1024**2),
            "--tmpfs",
            "/var/lib/postgresql/data:rw,size=268435456,uid=999,gid=999",
            "-e",
            "POSTGRES_DB=kodera_server",
            "-e",
            "POSTGRES_USER=kodera",
            "-e",
            "POSTGRES_PASSWORD=kodera",
            "-p",
            "127.0.0.1::5432",
            POSTGRES,
            "-c",
            "listen_addresses=*",
        )
        db_details = inspect(database)
        owned(db_details, "container")
        db_port = published_port(db_details, "5432/tcp")

        PHASE = "postgresql-readiness"
        for _ in range(60):
            ready = docker(
                "exec",
                database,
                "pg_isready",
                "-U",
                "kodera",
                "-d",
                "kodera_server",
                check=False,
            )
            if ready.returncode == 0:
                break
            import time

            time.sleep(0.5)
        else:
            raise AssertionError("owned PostgreSQL did not become ready")

        PHASE = "operator-migrations"
        fixture(db_port)
        reader_sql = "\n".join(
            [
                f"CREATE ROLE synthetic_reader LOGIN PASSWORD '{PASSWORD}'"
                " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;",
                "ALTER ROLE synthetic_reader SET default_transaction_read_only = on;",
                "REVOKE ALL ON DATABASE kodera_server FROM PUBLIC;",
                "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
                "GRANT CONNECT ON DATABASE kodera_server TO synthetic_reader;",
                "GRANT USAGE ON SCHEMA public TO synthetic_reader;",
                "GRANT SELECT ON TABLE identity_user, identity_identity, identity_staffrole,"
                " orgs_organisation, orgs_membership TO synthetic_reader;",
            ]
        )
        docker(
            "exec",
            database,
            "psql",
            "-U",
            "kodera",
            "-d",
            "kodera_server",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            reader_sql,
        )

        # --- Variant 1: Community image (no ee_src override) -----------------
        PHASE = "community-image-build"
        docker(
            "buildx",
            "build",
            "--load",
            "--label",
            f"{LABEL}={OWNER}",
            "-t",
            community_image,
            ".",
            timeout=600,
        )

        PHASE = "community-image-start"
        docker(
            "run",
            "-d",
            "--name",
            community_api,
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            *caps(512 * 1024**2),
            "--read-only",
            "--tmpfs",
            "/tmp:rw,size=16777216,uid=10001,gid=10001",  # noqa: S108 - bounded owned container tmpfs
            "-p",
            "127.0.0.1::8000",
            "-e",
            f"DJANGO_SECRET_KEY={SECRET}",
            "-e",
            "DJANGO_ALLOWED_HOSTS=api.synthetic.test",
            "-e",
            f"DATABASE_URL=postgresql://synthetic_reader:{PASSWORD}@db/kodera_server",
            "-e",
            f"KODERA_AUTH_TRUST={trust}",
            community_image,
        )
        comm_details = inspect(community_api)
        owned(comm_details, "container")
        resources(comm_details, 512 * 1024**2)
        production_command(comm_details["Config"]["Cmd"])
        comm_port = published_port(comm_details, "8000/tcp")

        PHASE = "community-http-readiness"
        try:
            wait_ready(comm_port)
        except AssertionError:
            owned_runtime_diagnostics(community_api)
            raise

        PHASE = "community-ee-absence-probe"
        comm_fs_probe = (
            "import json, pathlib; p = pathlib.Path('/app/ee');"
            " files = sorted(str(x.relative_to(p)) for x in p.rglob('*') if x.is_file()) if p.exists() else [];"
            " print(json.dumps({'files': files}))"
        )
        comm_fs = json.loads(docker("exec", community_api, "python", "-c", comm_fs_probe).stdout)
        require(comm_fs["files"] == [], "Community image unexpectedly carries ee/ files")
        comm_status, comm_raw = http_request(comm_port, "/api/v1/ee/status")
        comm_body = json.loads(comm_raw)
        require(
            comm_status == 403 and comm_body.get("code") == "enterprise_edition_required",
            "Community image must keep /api/v1/ee/status disabled",
        )
        remove_resource("container", community_api)

        # --- Variant 2: Enterprise image (--build-context ee_src=../../ee) ---
        PHASE = "enterprise-image-build"
        docker(
            "buildx",
            "build",
            "--load",
            "--build-context",
            "ee_src=../../ee",
            "--label",
            f"{LABEL}={OWNER}",
            "-t",
            enterprise_image,
            ".",
            timeout=600,
        )

        PHASE = "enterprise-image-start"
        docker(
            "run",
            "-d",
            "--name",
            enterprise_api,
            "--label",
            f"{LABEL}={OWNER}",
            "--network",
            network,
            *caps(512 * 1024**2),
            "--read-only",
            "--tmpfs",
            "/tmp:rw,size=16777216,uid=10001,gid=10001",  # noqa: S108 - bounded owned container tmpfs
            "-p",
            "127.0.0.1::8000",
            "-e",
            f"DJANGO_SECRET_KEY={SECRET}",
            "-e",
            "DJANGO_ALLOWED_HOSTS=api.synthetic.test",
            "-e",
            f"DATABASE_URL=postgresql://synthetic_reader:{PASSWORD}@db/kodera_server",
            "-e",
            f"KODERA_AUTH_TRUST={trust}",
            "-e",
            "KODERA_EDITION=enterprise",
            enterprise_image,
        )
        ent_details = inspect(enterprise_api)
        owned(ent_details, "container")
        resources(ent_details, 512 * 1024**2)
        production_command(ent_details["Config"]["Cmd"])
        ent_port = published_port(ent_details, "8000/tcp")

        PHASE = "enterprise-http-readiness"
        try:
            wait_ready(ent_port)
        except AssertionError:
            owned_runtime_diagnostics(enterprise_api)
            raise

        PHASE = "enterprise-ee-status-probe"
        ent_fs_probe = (
            "import json, pathlib;"
            " p = pathlib.Path('/app/ee');"
            " assert (p / '__init__.py').is_file();"
            " assert (p / 'urls.py').is_file();"
            " assert (p / 'billing' / 'urls.py').is_file();"
            " assert not (p / 'tests').exists();"
            " assert not (p / 'billing' / 'tests').exists();"
            " print(json.dumps({'ee_packaged': True}))"
        )
        ent_fs = json.loads(docker("exec", enterprise_api, "python", "-c", ent_fs_probe).stdout)
        require(ent_fs["ee_packaged"] is True, "Enterprise image missing /app/ee modules")

        # Cold-start billing probe first (`BUG-0036`) followed by `/api/v1/ee/status` (`BUG-0072`).
        plans_status, plans_raw = http_request(ent_port, "/api/v1/ee/billing/plans")
        plans_body = json.loads(plans_raw)
        require(
            plans_status == 200 and isinstance(plans_body.get("plans"), list),
            "Enterprise cold-start /api/v1/ee/billing/plans did not return 200",
        )

        ee_status, ee_raw = http_request(ent_port, "/api/v1/ee/status")
        ee_body = json.loads(ee_raw)
        require(
            ee_status == 200
            and ee_body.get("edition") == "enterprise"
            and ee_body.get("enterprise_enabled") is True,
            "Enterprise image /api/v1/ee/status did not return 200 enabled",
        )

        require(source_hashes() == frozen, "tracked source changed during qualification")
    finally:
        prior_phase = PHASE
        PHASE = "owned-cleanup"
        for container in containers:
            remove_resource("container", container)
        remove_resource("network", network)
        for img in images:
            result = docker("image", "inspect", img, check=False)
            if result.returncode == 0:
                labels = json.loads(result.stdout)[0]["Config"].get("Labels") or {}
                require(labels.get(LABEL) == OWNER, "enterprise qualification owner mismatch")
                docker("image", "rm", img)
        absent("image")
        print(json.dumps({"owned_cleanup": "passed"}), flush=True)
        PHASE = prior_phase

    print(
        json.dumps(
            {
                "status": "passed",
                "community_ee_absent": True,
                "community_status_code": 403,
                "enterprise_ee_packaged": True,
                "enterprise_billing_coldstart": 200,
                "enterprise_status_code": 200,
                "owned_cleanup": "passed",
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        category = next(
            (
                name
                for cls, name in (
                    (subprocess.CalledProcessError, "command-refused"),
                    (subprocess.TimeoutExpired, "command-timeout"),
                    (AssertionError, "predicate-refused"),
                )
                if isinstance(error, cls)
            ),
            "unclassified-refusal",
        )
        print(
            f"Enterprise HTTP image qualification failed during {PHASE} ({category}); no captured values emitted",
            file=sys.stderr,
        )
        sys.exit(1)
