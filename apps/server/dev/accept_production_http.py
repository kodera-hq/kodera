#!/usr/bin/env python3
"""Hosted-only bounded production-image proof on synthetic, uniquely owned resources.

This qualifies WSGI serving and existing signature/customer reads. It does not qualify
provider login, proxy/TLS operation, migrations authority, an onboarding claim or deployment.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
POSTGRES = "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94"
LABEL = "kodera.production-qualification"
OWNER = "production-http-" + uuid.uuid4().hex[:12]
ISSUER = "https://identity.synthetic.test/realms/alpha"
SECRET = "synthetic-deployment-only-" + "abc0123456789" * 5
PHASE = "admission"
PASSWORD = "synthetic-reader-pass"  # noqa: S105 - disposable synthetic role only

# What these qualifications write to disk is the image they build (0.32 GB, measured) and the
# pinned PostgreSQL image (0.66 GB); PostgreSQL itself runs on a tmpfs. A GitHub-hosted Ubuntu runner
# starts these jobs with 11.9 to 12.8 GiB free (measured over 33 runs). The former 15 GiB floor sat
# above that, so every job first deleted preinstalled SDKs under a 180 s deadline, and that
# deletion's 29 to 172 s decided whether the job passed. The floor only refuses a runner that could
# not hold the build; nothing the qualification proves depends on it.
RESERVE = 5 * 1024**3


def require_disk_reserve():
    free = shutil.disk_usage(ROOT).free
    print(json.dumps({"free_bytes": free, "required_free_bytes": RESERVE}), flush=True)
    require(free >= RESERVE, "5 GiB disk reserve required")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def command(arguments, *, check=True, timeout=60, environment=None):
    return subprocess.run(  # noqa: S603 - fixed commands; synthetic data only
        arguments,
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=check,
        timeout=timeout,
    )


def docker(*args, **kwargs):
    return command(["docker", *args], **kwargs)


def owned(details, kind):
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    require((labels or {}).get(LABEL) == OWNER, "resource owner mismatch")


def inspect(reference):
    return json.loads(docker("inspect", reference).stdout)[0]


def absent(kind, reference):
    # A failed inspect is ambiguous; only a successful daemon inventory proves absence.
    if kind == "image":
        result = docker("image", "ls", "-q", "--filter", f"label={LABEL}={OWNER}")
        require(not result.stdout.strip(), "owned image remains")
        return
    result = docker(kind, "ls", *(["-a"] if kind == "container" else []), "--format", "{{json .}}")
    key = "Names" if kind == "container" else "Name"
    names = [json.loads(line)[key] for line in result.stdout.splitlines() if line]
    require(reference not in names, "owned resource remains")


def remove(kind, reference):
    result = docker(kind, "inspect", reference, check=False)
    if result.returncode == 0:
        owned(json.loads(result.stdout)[0], kind)
        docker(kind, "rm", *([] if kind == "network" else ["-f"]), reference)
    absent(kind, reference)


def source_hashes():
    files = command(["git", "ls-files", "-z"]).stdout.split("\x00")
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files if name}


def request(port, path, *, token=None, host="api.synthetic.test"):
    headers = {"Host": host}
    if token:
        headers["Authorization"] = "Bearer " + token
    call = Request(f"http://127.0.0.1:{port}{path}", headers=headers)
    try:
        response = urlopen(call, timeout=5)  # noqa: S310 - constructed numeric loopback only
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(65536)
        return response.code, raw


def wait_ready(port):
    codes = dict.fromkeys(
        (
            "ready",
            "bad_host",
            "unauthenticated",
            "unavailable",
            "server_error",
            "other_status",
            "connection_refused",
        ),
        False,
    )
    statuses = {
        200: "ready",
        400: "bad_host",
        401: "unauthenticated",
        503: "unavailable",
        500: "server_error",
    }
    for _ in range(60):
        try:
            status = request(port, "/health/ready")[0]
            codes[statuses.get(status, "other_status")] = True
            if status == 200:
                return
        except (URLError, TimeoutError, ConnectionError):
            codes["connection_refused"] = True
        time.sleep(0.5)
    print(json.dumps({"http_readiness_codes": codes}), flush=True)
    raise AssertionError("owned API readiness did not become true")


def owned_runtime_diagnostics(reference):
    info = inspect(reference)
    owned(info, "container")
    result = docker("logs", "--tail", "100", reference, check=False)
    messages = result.stdout + result.stderr
    codes = {
        code: phrase in messages
        for code, phrase in {
            "configuration_refused": "Deployment configuration refused",
            "missing_module": "ModuleNotFoundError",
            "import_error": "ImportError",
            "permission": "Permission denied",
            "bounded_storage": "No space left on device",
            "worker_boot_failure": "Worker failed to boot",
            "bind_failure": "Connection in use",
            "database_password_failure": "password authentication failed",
        }.items()
    }
    print(
        json.dumps(
            {
                "runtime_running": info["State"]["Running"] is True,
                "runtime_exited": info["State"]["Status"] == "exited",
                "runtime_oom": info["State"].get("OOMKilled") is True,
                "runtime_startup_codes": codes,
            }
        ),
        flush=True,
    )


def production_command(command):
    require(
        command == ["gunicorn", "--config", "config/gunicorn.py", "config.deploy_wsgi:application"],
        "production command is not fixed Gunicorn",
    )


def same_process(master_before, master_after, workers_before, workers_after):
    require(master_after == master_before, "master was replaced during recovery")
    require(workers_after == workers_before, "workers were replaced during recovery")


def resources(details, memory):
    config = details["HostConfig"]
    require(
        config["Memory"] == memory and config["MemorySwap"] == memory,
        "production qualification predicate refused",
    )
    require(config["NanoCpus"] == 1_000_000_000, "production qualification predicate refused")
    require(not config["Privileged"], "production qualification predicate refused")
    require(config["CapDrop"] == ["ALL"], "production qualification predicate refused")
    require(
        "no-new-privileges" in " ".join(config["SecurityOpt"]),
        "production qualification predicate refused",
    )
    require(
        all(mount["Type"] == "tmpfs" for mount in details["Mounts"]),
        "production qualification predicate refused",
    )


def caps(memory):
    return [
        "--memory",
        str(memory),
        "--memory-swap",
        str(memory),
        "--cpus",
        "1",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
    ]


def seed_fixture():
    """Actual operator-side fixture obeying retained deferred owner/name invariants."""
    from django.db import transaction
    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation

    with transaction.atomic():
        now = timezone.now()
        org = Organisation.objects.create(
            slug="alpha", realm="alpha", issuer=ISSUER, name="Synthetic", state="active"
        )
        SlugReservation.objects.create(
            organisation=org, slug=org.slug, state="permanent", protected_at=now
        )
        user = User.objects.create(email="synthetic@customer.test", display_name="Synthetic")
        Identity.objects.create(
            user=user,
            organisation=org,
            issuer=org.issuer,
            realm=org.realm,
            subject="synthetic-subject",
            email=user.email,
        )
        Membership.objects.create(
            user=user, organisation=org, role="org_owner", state="active", accepted_at=now
        )


def published_port(details, internal):
    bindings = (details.get("NetworkSettings") or {}).get("Ports") or {}
    entries = bindings.get(internal)
    require(
        isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict),
        "owned loopback published port refused",
    )
    entry = entries[0]
    value = entry.get("HostPort", "")
    require(
        entry.get("HostIp") == "127.0.0.1"
        and isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and 0 < int(value) <= 65535,
        "owned loopback published port refused",
    )
    return int(value)


def reader_policy(details):
    required = {
        "attributes_safe",
        "owns_nothing",
        "database_readonly",
        "schema_readonly",
        "exact_select_tables",
        "no_table_writes",
        "default_readonly",
    }
    require(
        isinstance(details, dict)
        and set(details) == required
        and all(type(value) is bool and value for value in details.values()),
        "synthetic reader authority refused",
    )


def fixture(port):
    # Operator-side migrations and fixture insertion never run in the API image.
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.job_queue",
        "DATABASE_URL": f"postgresql://kodera:kodera@127.0.0.1:{port}/kodera_server",
    }
    command(
        [sys.executable, "manage.py", "migrate", "--noinput"], environment=environment, timeout=120
    )
    program = """
import django
django.setup()
from dev.accept_production_http import seed_fixture
seed_fixture()
"""
    command([sys.executable, "-c", program], environment=environment)


def signature():
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="owned-production-key", alg="RS256", use="sig", key_ops=["verify"])
    now = int(time.time())
    trust = json.dumps(
        [
            {
                "lane": "customer",
                "issuer": ISSUER,
                "generation": "synthetic-production-serving",
                "expires_at": now + 900,
                "public_jwks": {"keys": [public]},
            }
        ]
    )
    token = jwt.encode(
        {
            "iss": ISSUER,
            "sub": "synthetic-subject",
            "aud": "kodera-server",
            "iat": now,
            "exp": now + 600,
            "typ": "Bearer",
            # The web console's client: the customer lane admits only its allowed clients.
            "azp": "console",
        },
        key,
        algorithm="RS256",
        headers={"kid": public["kid"]},
    )
    return trust, token


def run():
    global PHASE
    require(os.environ.get("GITHUB_ACTIONS") == "true", "hosted-only qualification")
    PHASE = "disk-admission"
    require_disk_reserve()
    PHASE = "tracked-source-inventory"
    frozen = source_hashes()
    network, database, api, image = (OWNER + suffix for suffix in ("-net", "-db", "-api", ":image"))
    containers = [database, api]
    trust, token = signature()
    try:
        PHASE = "owned-network-create"
        docker("network", "create", "--label", f"{LABEL}={OWNER}", network)
        network_info = json.loads(docker("network", "inspect", network).stdout)[0]
        owned(network_info, "network")
        require(network_info.get("Internal") is False, "qualification topology refused")
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
            "fsync=off",
        )
        PHASE = "owned-postgresql-ready"
        for _ in range(60):
            result = docker(
                "exec",
                database,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                "kodera",
                "-d",
                "kodera_server",
                check=False,
            )
            if result.returncode == 0:
                break
            time.sleep(0.5)
        else:
            info = inspect(database)
            owned(info, "container")
            result = docker("logs", database, check=False)
            messages = result.stdout + result.stderr
            codes = {
                code: phrase in messages
                for code, phrase in {
                    "permission": "Permission denied",
                    "not_permitted": "Operation not permitted",
                    "bounded_storage": "No space left on device",
                    "init_error": "initdb: error",
                    "reported_ready": "database system is ready to accept connections",
                }.items()
            }
            print(
                json.dumps(
                    {
                        "postgres_running": info["State"]["Running"],
                        "postgres_exit_code": info["State"]["ExitCode"],
                        "postgres_startup_codes": codes,
                    }
                ),
                flush=True,
            )
            raise AssertionError("owned PostgreSQL never became ready")
        PHASE = "owned-postgresql-policy"
        db_info = inspect(database)
        owned(db_info, "container")
        config = db_info.get("HostConfig") or {}
        bindings = (db_info.get("NetworkSettings") or {}).get("Ports") or {}
        entries = bindings.get("5432/tcp")
        print(
            json.dumps(
                {
                    "postgres_policy": {
                        "owned": (db_info.get("Config", {}).get("Labels") or {}).get(LABEL)
                        == OWNER,
                        "memory": config.get("Memory") == 768 * 1024**2,
                        "swap": config.get("MemorySwap") == 768 * 1024**2,
                        "cpu": config.get("NanoCpus") == 1_000_000_000,
                        "unprivileged": config.get("Privileged") is False,
                        "drop_all": config.get("CapDrop") == ["ALL"],
                        "no_new_privileges": "no-new-privileges"
                        in " ".join(config.get("SecurityOpt") or []),
                        "tmpfs_only": all(
                            m.get("Type") == "tmpfs" for m in db_info.get("Mounts", [])
                        ),
                        "port_entries_present": bool(entries),
                        "port_entries_list": isinstance(entries, list),
                        "port_binding_shape": isinstance(entries, list)
                        and len(entries) == 1
                        and isinstance(entries[0], dict)
                        and "HostPort" in entries[0],
                    }
                }
            ),
            flush=True,
        )
        resources(db_info, 768 * 1024**2)
        port = published_port(db_info, "5432/tcp")
        PHASE = "operator-migrations-fixture"
        fixture(port)
        statement = "CREATE ROLE synthetic_reader LOGIN NOINHERIT PASSWORD 'synthetic-reader-pass'; REVOKE CREATE, TEMP ON DATABASE kodera_server FROM PUBLIC; GRANT CONNECT ON DATABASE kodera_server TO synthetic_reader; GRANT USAGE ON SCHEMA public TO synthetic_reader; GRANT SELECT ON identity_user, identity_identity, identity_staffrole, orgs_organisation, orgs_membership TO synthetic_reader; ALTER ROLE synthetic_reader SET default_transaction_read_only=on;"
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
            statement,
        )
        role_query = """
SELECT json_build_object(
 'attributes_safe', NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid),
 'owns_nothing', NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid),
 'database_readonly', NOT has_database_privilege(r.oid,current_database(),'CREATE,TEMP'),
 'schema_readonly', NOT has_schema_privilege(r.oid,'public','CREATE'),
 'exact_select_tables', (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public'
    AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(r.oid,c.oid,'SELECT'))
    =ARRAY['identity_identity','identity_staffrole','identity_user','orgs_membership','orgs_organisation'],
 'no_table_writes', NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'default_readonly', 'default_transaction_read_only=on'=ANY(r.rolconfig)
) FROM pg_roles r WHERE r.rolname='synthetic_reader'
"""
        result = docker(
            "exec",
            database,
            "psql",
            "-U",
            "kodera",
            "-d",
            "kodera_server",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            role_query,
        )
        reader_policy(json.loads(result.stdout))
        print(json.dumps({"synthetic_reader_policy": "passed"}), flush=True)
        PHASE = "runtime-image-build"
        docker("build", "--label", f"{LABEL}={OWNER}", "-t", image, ".", timeout=600)
        PHASE = "runtime-image-start"
        docker(
            "run",
            "-d",
            "--name",
            api,
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
            image,
        )
        details = inspect(api)
        owned(details, "container")
        resources(details, 512 * 1024**2)
        require(
            details["Config"]["User"] == "10001:10001" and details["HostConfig"]["ReadonlyRootfs"],
            "production qualification predicate refused",
        )
        production_command(details["Config"]["Cmd"])
        port = published_port(details, "8000/tcp")
        PHASE = "http-readiness"
        try:
            wait_ready(port)
        except AssertionError:
            owned_runtime_diagnostics(api)
            raise
        PHASE = "http-process-boundary"
        process_probe = """
import json,os,pathlib
assert os.getuid()==10001
cmd=pathlib.Path('/proc/1/cmdline').read_bytes()
assert b'gunicorn' in cmd
children=pathlib.Path('/proc/1/task/1/children').read_text().split()
assert len(children)==2
for name in ('test','e2e','e2e_operator','job_queue'):
 assert not pathlib.Path('/app/config/settings/'+name+'.py').exists()
assert not pathlib.Path('/app/apps/identity/management').exists()
OUTBOX_IN_IMAGE = ['__init__.py', 'realm_enqueue.py']
assert sorted(p.name for p in pathlib.Path('/app/apps/outbox').iterdir() if p.name != '__pycache__') == OUTBOX_IN_IMAGE
assert not pathlib.Path('/app/dev').exists()
print(json.dumps({'workers':len(children),'uid':os.getuid(),'worker_ids':sorted(children)}))
"""
        facts = json.loads(docker("exec", api, "python", "-c", process_probe).stdout)
        require(
            facts["workers"] == 2 and facts["uid"] == 10001,
            "production qualification predicate refused",
        )
        PHASE = "http-live"
        require(
            request(port, "/health/live")[0] == 200, "production qualification predicate refused"
        )
        PHASE = "http-anonymous"
        require(request(port, "/api/v1/me")[0] == 401, "production qualification predicate refused")
        PHASE = "http-signed-customer-read"
        status, body = request(port, "/api/v1/me", token=token)
        require(
            status == 200 and json.loads(body)["email"] == "synthetic@customer.test",
            "production qualification predicate refused",
        )
        PHASE = "http-unknown-host"
        require(
            request(port, "/health/live", host="unknown.synthetic.test")[0] == 400,
            "production qualification predicate refused",
        )
        pid = details["State"]["Pid"]
        PHASE = "http-database-outage-ready"
        docker("pause", database)
        try:
            require(
                request(port, "/health/ready")[0] == 503,
                "production qualification predicate refused",
            )
            PHASE = "http-database-outage-live"
            require(
                request(port, "/health/live")[0] == 200,
                "production qualification predicate refused",
            )
        finally:
            docker("unpause", database)
        PHASE = "http-database-recovery-ready"
        wait_ready(port)
        PHASE = "http-database-recovery-process"
        recovered = json.loads(docker("exec", api, "python", "-c", process_probe).stdout)
        same_process(pid, inspect(api)["State"]["Pid"], facts, recovered)
        PHASE = "http-database-recovery-customer-read"
        require(
            request(port, "/api/v1/me", token=token)[0] == 200,
            "production qualification predicate refused",
        )
        PHASE = "http-log-secrecy"
        logs = docker("logs", api).stdout + docker("logs", api).stderr
        require(
            all(secret not in logs for secret in (SECRET, PASSWORD, token)),
            "synthetic secret entered logs",
        )
        PHASE = "graceful-shutdown"
        started = time.monotonic()
        docker("stop", "--time", "35", api, timeout=40)
        require(time.monotonic() - started < 35, "production qualification predicate refused")
        require(inspect(api)["State"]["ExitCode"] == 0, "Gunicorn shutdown did not exit cleanly")
        require(source_hashes() == frozen, "tracked source changed during qualification")
    finally:
        prior_phase = PHASE
        PHASE = "owned-cleanup"
        for container in containers:
            result = docker("inspect", container, check=False)
            if result.returncode == 0 and json.loads(result.stdout)[0]["State"].get("Paused"):
                owned(json.loads(result.stdout)[0], "container")
                docker("unpause", container)
            remove("container", container)
        remove("network", network)
        result = docker("image", "inspect", image, check=False)
        if result.returncode == 0:
            labels = json.loads(result.stdout)[0]["Config"].get("Labels") or {}
            require(labels.get(LABEL) == OWNER, "production qualification predicate refused")
            docker("image", "rm", image)
        absent("image", image)
        print(json.dumps({"owned_cleanup": "passed"}))
        PHASE = prior_phase
    print(
        json.dumps(
            {
                "status": "passed",
                "workers": 2,
                "uid": 10001,
                "signature_customer_read": True,
                "provider_login_qualified": False,
                "same_master_and_worker_database_recovery": True,
                "owned_cleanup": "passed",
            }
        )
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
            f"Production HTTP image qualification failed during {PHASE} ({category}); no captured values emitted",
            file=sys.stderr,
        )
        sys.exit(1)
