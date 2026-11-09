#!/usr/bin/env python3
"""Qualify one owned customer HTTP image; no deployment or first-owner authority."""

import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import quote

import psycopg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev.accept_runtime import docker  # noqa: E402

LABEL = "kodera.customer-http"
PG_OPTIONS = "-c lock_timeout=5000 -c statement_timeout=30000"
TABLES = {
    "identity_user",
    "identity_identity",
    "orgs_organisation",
    "orgs_membership",
    "orgs_slugreservation",
}


class ControllerError(Exception):
    """Closed diagnostic: never carries credentials, HTTP bodies or raw subprocess errors."""


PHASES = frozenset(
    {
        "preflight",
        "build",
        "image-sources",
        "network",
        "database-start",
        "database-readiness",
        "database-inspection",
        "database-login-setup",
        "provider-fixture",
        "provider-start",
        "provider-readiness",
        "provider-inspection",
        "provider-tokens",
        "seed",
        "reader-provision",
        "reader-privileges",
        "api-start",
        "api-inspection",
        "api-readiness",
        "image-tests",
        "outage",
        "recovery",
        "cleanup",
    }
)


def phase(name):
    if name not in PHASES:
        raise ControllerError("unknown controller phase")
    print(json.dumps({"phase": name}), flush=True)
    return name


def failure_details(stage, error):
    import subprocess

    details = {"phase": stage if stage in PHASES else "unknown"}
    if isinstance(error, psycopg.Error):
        details["category"] = (
            "database-operational-error"
            if isinstance(error, psycopg.OperationalError)
            else "database-error"
        )
        if isinstance(error.sqlstate, str) and re.fullmatch(r"[A-Z0-9]{5}", error.sqlstate):
            details["sqlstate"] = error.sqlstate
    elif isinstance(error, subprocess.CalledProcessError):
        details["category"] = "subprocess-failure"
        category = "other"
        command = error.cmd
        if (
            isinstance(command, (list, tuple))
            and len(command) > 1
            and isinstance(command[0], str)
            and Path(command[0]).name == "docker"
        ):
            if command[1] in {"run", "build", "exec", "inspect", "port", "pause", "unpause", "ps"}:
                category = command[1]
            elif (
                len(command) > 2
                and command[1] in {"container", "network", "image"}
                and command[2] in {"inspect", "rm", "create", "ls"}
            ):
                category = command[1] + "." + command[2]
        details["docker_subcommand"] = category
        if type(error.returncode) is int:
            details["returncode"] = error.returncode
    elif isinstance(error, subprocess.TimeoutExpired):
        details["category"] = "subprocess-timeout"
    elif isinstance(error, ControllerError):
        details["category"] = "controller-refusal"
    elif isinstance(error, ValueError):
        details["category"] = "value-error"
    elif isinstance(error, OSError):
        details["category"] = "os-error"
    else:
        details["category"] = "unexpected-error"
    return details


def report_failure(stage, error):
    print(json.dumps({"failure": failure_details(stage, error)}, sort_keys=True), flush=True)


def run_reader_probe(connection, statement, *, label=None):
    try:
        connection.execute("BEGIN READ WRITE")
        if connection.execute("SHOW transaction_read_only").fetchone() != ("off",):
            raise ControllerError("reader probe is not READ WRITE")
        try:
            connection.execute(statement)
        except psycopg.Error as error:
            if error.sqlstate == "42501":
                if label is not None:
                    print(
                        json.dumps(
                            {
                                "probe": label,
                                "transaction_read_only": "off",
                                "sqlstate": error.sqlstate,
                            },
                            sort_keys=True,
                        )
                    )
                return
        raise ControllerError("reader privilege refusal was not demonstrated")
    finally:
        connection.execute("ROLLBACK")


def require_reader_catalogue(facts):
    expected = {
        "rolcanlogin": True,
        "rolsuper": False,
        "rolcreatedb": False,
        "rolcreaterole": False,
        "rolreplication": False,
        "rolbypassrls": False,
        "rolinherit": False,
        "memberships": [],
        "owned_objects": [],
        "other_table_privileges": [],
        "other_column_privileges": [],
        "schema_create": False,
        "database_create": False,
        "table_select_grant_options": [],
        "column_select_grant_options": [],
        "database_temp": False,
        "application_execute": [],
        "identity_connect": False,
        "connectable_databases": ["kodera_server"],
        "provider_connectable_databases": ["identity"],
    }
    valid = isinstance(facts, dict) and set(facts) == set(expected) | {"select_tables"}
    if valid:
        valid = all(
            type(facts[key]) is type(value) and facts[key] == value
            for key, value in expected.items()
        )
        selected = facts["select_tables"]
        valid = valid and isinstance(selected, list) and len(selected) == len(TABLES)
        valid = (
            valid and all(isinstance(item, str) for item in selected) and set(selected) == TABLES
        )
    if not valid:
        raise ControllerError("reader catalogue is not least privilege")


def startup_connect_refusal(error, database):
    """Keep semantic startup denial distinct from a reported SQLSTATE."""
    if database not in ("identity", "postgres") or not isinstance(error, psycopg.Error):
        raise ControllerError("reader database CONNECT refusal was not demonstrated")
    explicit_code = error.sqlstate == "42501"
    measured_startup = (
        type(error) is psycopg.OperationalError
        and error.sqlstate is None
        and f'permission denied for database "{database}"' in str(error)
    )
    if not (explicit_code or measured_startup):
        raise ControllerError("reader database CONNECT refusal was not demonstrated")
    return {
        "probe": "CONNECT " + database,
        "semantic_denial": "startup-permission-denied",
        "exception_category": "database-error" if explicit_code else "operational-error",
        "sqlstate": error.sqlstate,
    }


def api_environment(reader_password, public_trust):
    return {
        "DATABASE_URL": "postgres://customer_api_reader:"
        + quote(reader_password, safe="")
        + "@db:5432/kodera_server",
        # customer_http, admitting the local provider's loopback issuer.
        "DJANGO_SETTINGS_MODULE": "config.settings.e2e",
        "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",
        "KODERA_AUTH_TRUST": public_trust,
    }


def api_runtime_arguments():
    return [
        "-p",
        "127.0.0.1::8000",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",  # noqa: S108 - container-local bounded tmpfs, never a host directory
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
    ]


def require_api_runtime(details, expected_environment, forbidden_values):
    host = details["HostConfig"]
    environment = dict(item.split("=", 1) for item in details["Config"]["Env"])
    forbidden_prefixes = (
        "SCW_",
        "AWS_",
        "ARM_",
        "AZURE_",
        "SSH_",
        "AGE_",
        "SOPS_",
        "KC_",
        "KEYCLOAK_",
        "POSTGRES_",
    )
    valid = (
        host["ReadonlyRootfs"] is True
        and host["CapDrop"] == ["ALL"]
        and host["SecurityOpt"] == ["no-new-privileges:true"]
        and host["Tmpfs"] == {"/tmp": "rw,noexec,nosuid,size=64m"}  # noqa: S108 - container-local bounded tmpfs, never a host directory
    )
    valid = valid and all(
        environment.get(key) == value for key, value in expected_environment.items()
    )
    valid = valid and not any(
        key.startswith(forbidden_prefixes) or key == "GOOGLE_APPLICATION_CREDENTIALS"
        for key in environment
    )
    valid = valid and not any(
        secret in value for value in environment.values() for secret in forbidden_values
    )
    if not valid:
        raise ControllerError("API runtime boundary refused")
    print(
        json.dumps(
            {
                "api_readonly_root": host["ReadonlyRootfs"],
                "api_cap_drop": host["CapDrop"],
                "api_security_opt": host["SecurityOpt"],
                "api_tmpfs": host["Tmpfs"],
                "api_environment_projection": "reader/public/synthetic cursor"
                if "KODERA_MEMBERSHIP_CURSOR_KEY" in expected_environment
                else "reader/public only",
            },
            sort_keys=True,
        )
    )


@contextmanager
def private_image_input(directory, payload):
    path = None
    try:
        fields = {
            "api_port",
            "access_token",
            "id_token",
            "refresh_token",
            "wrong_audience",
            "expected_me",
        }
        directory = Path(directory)
        info = directory.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o700
            or info.st_uid != os.getuid()
            or not isinstance(payload, dict)
            or set(payload) != fields
            or type(payload["api_port"]) is not int
            or not 0 < payload["api_port"] < 65536
            or not isinstance(payload["expected_me"], dict)
        ):
            raise ValueError
        for key in fields - {"api_port", "expected_me"}:
            if not isinstance(payload[key], str) or not 0 < len(payload[key]) <= 16384:
                raise ValueError
        raw = json.dumps(payload, allow_nan=False).encode()
        if len(raw) > 65536:
            raise ValueError
        target = directory / "image-input.json"
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        path = target
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
    except (OSError, ValueError, TypeError, KeyError):
        if path is not None:
            path.unlink()
        raise ControllerError("owned HTTP image input refused") from None
    try:
        yield path
    finally:
        path.unlink()


def http_request(port, path, token=None):
    client = None
    try:
        if (
            type(port) is not int
            or not 0 < port < 65536
            or path not in {"/api/v1/me", "/health/live", "/health/ready"}
        ):
            raise ValueError
        client = HTTPConnection("127.0.0.1", port, timeout=5)
        headers = {} if token is None else {"Authorization": "Bearer " + token}
        client.request("GET", path, headers=headers)
        response = client.getresponse()
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError
        return (
            response.status,
            json.loads(raw),
            {key.lower(): value for key, value in response.getheaders()},
        )
    except Exception:
        raise ControllerError("owned HTTP request failed") from None
    finally:
        if client is not None:
            client.close()


def require_outage_response(status, body, headers):
    permitted = {"status", "type", "title", "request_id"}
    valid = status == 500 and isinstance(body, dict) and set(body) == permitted
    valid = valid and body.get("status") == 500 and headers.get("cache-control") == "no-store"
    valid = valid and body.get("type") == "https://kodera.io/problems/internal-error"
    valid = valid and body.get("title") == "Internal error"
    request_id = body.get("request_id") if isinstance(body, dict) else None
    valid = (
        valid
        and isinstance(request_id, str)
        and re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id) is not None
    )
    valid = valid and headers.get("x-request-id") == request_id
    if not valid:
        raise ControllerError("database outage response refused")


def require_recovery(before, after, expected, actual):
    if (
        before["Id"] != after["Id"]
        or before["State"]["StartedAt"] != after["State"]["StartedAt"]
        or after["State"]["Running"] is not True
        or expected != actual
    ):
        raise ControllerError("same persisted API recovery refused")


def require_owned(kind, reference, owner):
    try:
        details = json.loads(docker(kind, "inspect", reference).stdout)[0]
        labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
        if (labels or {}).get(LABEL) != owner:
            raise ControllerError("unowned resource")
        return details
    except ControllerError:
        raise
    except Exception:
        raise ControllerError("owned resource inspection failed") from None


@contextmanager
def paused_database(reference, owner, *, expected_id=None):
    details = require_owned("container", reference, owner)
    if expected_id is not None and details["Id"] != expected_id:
        raise ControllerError("database resource identity differs")
    target = details["Id"] if expected_id is not None else reference
    docker("pause", target)
    try:
        yield
    finally:
        details = require_owned("container", target, owner)
        if expected_id is not None and details["Id"] != expected_id:
            raise ControllerError("database resource identity differs")
        docker("unpause", target)


def require_image_sources(facts):
    if (
        set(facts) != {"required_present", "forbidden_paths", "sentinel_found"}
        or facts["required_present"] is not True
        or facts["forbidden_paths"] != []
        or facts["sentinel_found"] is not False
    ):
        raise ControllerError("customer image source boundary refused")


def reader_catalogue(connection):
    """Effective privileges include inherited/PUBLIC and column-only grants."""
    role = "customer_api_reader"
    names = (
        "rolcanlogin",
        "rolsuper",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
        "rolbypassrls",
        "rolinherit",
    )
    row = connection.execute(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=%s",
        (role,),
    ).fetchone()
    if row is None:
        raise ControllerError("reader catalogue is not least privilege")
    facts = dict(zip(names, row, strict=True))
    facts["memberships"] = connection.execute(
        "SELECT rolname FROM pg_roles WHERE rolname<>%s AND pg_has_role(%s,oid,'MEMBER')",
        (role, role),
    ).fetchall()
    facts["owned_objects"] = connection.execute(
        "SELECT 'relation' FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=%s) "
        "UNION ALL SELECT 'schema' FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=%s) "
        "UNION ALL SELECT 'function' FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname=%s) "
        "UNION ALL SELECT 'database' FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=%s)",
        (role,) * 4,
    ).fetchall()
    relations = connection.execute(
        "SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')"
    ).fetchall()
    facts["select_tables"] = []
    facts["other_table_privileges"] = []
    facts["other_column_privileges"] = []
    facts["table_select_grant_options"] = []
    facts["column_select_grant_options"] = []
    for oid, name in relations:
        if connection.execute(
            "SELECT has_table_privilege(%s,%s,'SELECT WITH GRANT OPTION')", (role, oid)
        ).fetchone()[0]:
            facts["table_select_grant_options"].append(name)
        if connection.execute("SELECT has_table_privilege(%s,%s,'SELECT')", (role, oid)).fetchone()[
            0
        ]:
            facts["select_tables"].append(name)
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            if connection.execute(
                "SELECT has_table_privilege(%s,%s,%s)", (role, oid, privilege)
            ).fetchone()[0]:
                facts["other_table_privileges"].append((name, privilege))
        columns = connection.execute(
            "SELECT attnum FROM pg_attribute WHERE attrelid=%s AND attnum>0 AND NOT attisdropped",
            (oid,),
        ).fetchall()
        for (number,) in columns:
            if connection.execute(
                "SELECT has_column_privilege(%s,%s,%s,'SELECT WITH GRANT OPTION')",
                (role, oid, number),
            ).fetchone()[0]:
                facts["column_select_grant_options"].append((name, number))
            for privilege in ("SELECT", "INSERT", "UPDATE", "REFERENCES"):
                if privilege == "SELECT" and name in TABLES:
                    continue
                if connection.execute(
                    "SELECT has_column_privilege(%s,%s,%s,%s)", (role, oid, number, privilege)
                ).fetchone()[0]:
                    facts["other_column_privileges"].append((name, number, privilege))
    facts["schema_create"] = connection.execute(
        "SELECT has_schema_privilege(%s,'public','CREATE')", (role,)
    ).fetchone()[0]
    facts["database_temp"] = connection.execute(
        "SELECT has_database_privilege(%s,current_database(),'TEMP')", (role,)
    ).fetchone()[0]
    facts["database_create"] = connection.execute(
        "SELECT has_database_privilege(%s,current_database(),'CREATE')", (role,)
    ).fetchone()[0]
    facts["identity_connect"] = connection.execute(
        "SELECT has_database_privilege(%s,'identity','CONNECT')", (role,)
    ).fetchone()[0]
    facts["application_execute"] = connection.execute(
        "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid "
        "WHERE n.nspname='public' AND has_function_privilege(%s,p.oid,'EXECUTE')",
        (role,),
    ).fetchall()
    for login, key in (
        (role, "connectable_databases"),
        ("identity_provider", "provider_connectable_databases"),
    ):
        facts[key] = [
            row[0]
            for row in connection.execute(
                "SELECT datname FROM pg_database WHERE datallowconn "
                "AND has_database_privilege(%s,oid,'CONNECT') ORDER BY datname",
                (login,),
            ).fetchall()
        ]
    return facts


def provision_reader(owner_connection, reader_password):
    from psycopg import sql

    owner_connection.execute(
        sql.SQL(
            "CREATE ROLE customer_api_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}"
        ).format(sql.Literal(reader_password))
    )
    for statement in (
        "REVOKE CONNECT,TEMPORARY ON DATABASE kodera_server FROM PUBLIC",
        "REVOKE CONNECT,TEMPORARY ON DATABASE identity FROM PUBLIC",
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
        "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        "GRANT CONNECT ON DATABASE kodera_server TO customer_api_reader",
        "GRANT USAGE ON SCHEMA public TO customer_api_reader",
    ):
        owner_connection.execute(statement)
    for table in sorted(TABLES):
        owner_connection.execute(
            sql.SQL("GRANT SELECT ON {} TO customer_api_reader").format(sql.Identifier(table))
        )
    owner_connection.execute("CREATE TABLE reader_later_table (value integer)")
    owner_connection.execute(
        "CREATE FUNCTION reader_later_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'"
    )
    facts = reader_catalogue(owner_connection)
    require_reader_catalogue(facts)
    print(json.dumps({"actual_reader_catalogue": facts}, sort_keys=True))


def qualify_reader(port, reader_password, *, expected_counts=None):
    expected_counts = dict.fromkeys(TABLES, 1) if expected_counts is None else expected_counts
    if set(expected_counts) != TABLES or any(
        type(value) is not int or value < 1 for value in expected_counts.values()
    ):
        raise ControllerError("reader fixture counts refused")
    from psycopg import sql

    arguments = dict(
        host="127.0.0.1",
        port=port,
        user="customer_api_reader",
        password=reader_password,
        connect_timeout=2,
        options=PG_OPTIONS,
    )
    with psycopg.connect(**arguments, dbname="kodera_server", autocommit=True) as connection:
        for table in sorted(TABLES):
            if (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
                ).fetchone()[0]
                != expected_counts[table]
            ):
                raise ControllerError("reader positive persisted SELECT failed")
            for statement in (
                "INSERT INTO {} DEFAULT VALUES",
                "UPDATE {} SET id=id",
                "DELETE FROM {}",
                "TRUNCATE {}",
                "ALTER TABLE {} ADD COLUMN forbidden_probe integer",
                "ALTER TABLE {} DISABLE TRIGGER ALL",
            ):
                run_reader_probe(
                    connection,
                    sql.SQL(statement).format(sql.Identifier(table)),
                    label=statement.format(table),
                )
        for statement in (
            "CREATE SCHEMA forbidden_probe",
            "CREATE TABLE forbidden_probe (value integer)",
            "CREATE TEMP TABLE forbidden_probe (value integer)",
            "SET ROLE fixture_owner",
            "SET ROLE identity_provider",
            "SELECT * FROM reader_later_table",
            "SELECT reader_later_function()",
        ):
            run_reader_probe(connection, statement, label=statement)
    for database in ("identity", "postgres"):
        try:
            unexpected = psycopg.connect(**arguments, dbname=database)
        except psycopg.Error as error:
            print(json.dumps(startup_connect_refusal(error, database), sort_keys=True))
        else:
            unexpected.close()
            raise ControllerError("reader database CONNECT refusal was not demonstrated")
    print("PASS actual reader SELECT, 37 READ WRITE 42501 and 2 semantic startup refusals")


def cleanup(owner, containers, network, image, *, expected_ids=None):
    failures = []
    for kind, reference in [("container", item) for item in reversed(containers)] + [
        ("network", network),
        ("image", image),
    ]:
        try:
            if kind == "container":
                listed = docker("ps", "-aq", "--filter", f"name=^/{reference}$").stdout.strip()
            elif kind == "network":
                listed = docker(
                    "network", "ls", "-q", "--filter", f"name=^{reference}$"
                ).stdout.strip()
            else:
                listed = docker("image", "ls", "-q", reference).stdout.strip()
            if not listed:
                continue
            details = require_owned(kind, reference, owner)
            if expected_ids is not None and details["Id"] != expected_ids.get((kind, reference)):
                raise ControllerError("cleanup resource identity differs")
            target = details["Id"] if expected_ids is not None else reference
            if kind == "container" and details["State"]["Paused"]:
                docker("unpause", target)
            docker(kind, "rm", *(["-f"] if kind == "container" else []), target)
        except Exception:
            failures.append(kind)
    for kind, command in (
        ("container", ("ps", "-aq")),
        ("network", ("network", "ls", "-q")),
        ("image", ("image", "ls", "-q")),
    ):
        try:
            if docker(*command, "--filter", f"label={LABEL}={owner}").stdout.strip():
                failures.append(kind)
        except Exception:
            failures.append(kind)
    if failures:
        raise ControllerError("owned resource cleanup could not be verified")
    print("PASS owned containers, network and image absence verified")


SEED = """
import json,sys,django
from datetime import UTC
from django.core.management import call_command
from django.db import transaction
from django.utils import timezone
django.setup()
from apps.identity.models import User, Identity
from apps.orgs.models import Organisation, Membership, SlugReservation
value=json.load(sys.stdin)
call_command("migrate", verbosity=0, interactive=False)
with transaction.atomic():
    now=timezone.now()
    person=User.objects.create(email="qualification@localhost", display_name="Synthetic Qualification")
    organisation=Organisation.objects.create(slug=value["realm"], realm=value["realm"], issuer=value["issuer"], name="Synthetic Organisation", state="active")
    SlugReservation.objects.create(organisation=organisation,slug=organisation.slug,state="permanent",protected_at=now)
    identity=Identity.objects.create(user=person,organisation=organisation,issuer=value["issuer"],realm=value["realm"],subject=value["subject"],email=person.email)
    membership=Membership.objects.create(user=person,organisation=organisation,role="org_owner",state="active",accepted_at=now)
expected={"id":str(person.id),"email":person.email,"display_name":person.display_name,"staff":False,
 "identities":[{"id":str(identity.id),"issuer":identity.issuer,"realm":identity.realm,"subject":identity.subject,"email":identity.email}],
 "organisations":[{"organisation":{"id":str(organisation.id),"slug":organisation.slug,"name":organisation.name,"realm":organisation.realm},
 "membership_id":str(membership.id),"identity_id":str(identity.id),"role":"org_owner","state":"active","joined_at":now.astimezone(UTC).isoformat().replace("+00:00","Z")}]}
print(json.dumps(expected))
"""


def child_environment():
    return {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    } | {"PYTHONDONTWRITEBYTECODE": "1"}


# The floor of dev/accept_production_http.py, measured there: one application image build and the
# pinned PostgreSQL image, about 1 GB, so 5 GiB refuses only a disk that could not hold the run.
RESERVE = 5 * 1024**3


def disk_reserve():
    import shutil

    if shutil.disk_usage(ROOT).free < RESERVE:
        raise ControllerError("5 GiB disk reserve required")


def wait_until(check, seconds, label):
    import time

    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except Exception:  # noqa: S110 - retry only within the fixed readiness deadline; no secret diagnostics
            pass
        time.sleep(0.3)
    raise ControllerError("owned readiness deadline exceeded: " + label)


def database_tcp_ready(name):
    return (
        docker(
            "exec",
            name,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            "fixture_owner",
            "-d",
            "kodera_server",
            check=False,
            timeout=3,
        ).returncode
        == 0
    )


def container_port(name, internal, owner):
    details = require_owned("container", name, owner)
    bindings = details["NetworkSettings"]["Ports"].get(str(internal) + "/tcp")
    if not isinstance(bindings, list) or len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
        raise ControllerError("owned listener is not singular loopback")
    return int(bindings[0]["HostPort"])


def resource_evidence(name, memory, owner):
    details = require_owned("container", name, owner)
    host = details["HostConfig"]
    if host["Memory"] != memory or host["MemorySwap"] != memory or host["NanoCpus"] != 1000000000:
        raise ControllerError("owned resource limits differ")
    if any(mount["Type"] == "volume" for mount in details["Mounts"]):
        raise ControllerError("owned resources unexpectedly retain a volume")
    print(
        json.dumps(
            {
                "container": name,
                "image_id": details["Image"],
                "memory": host["Memory"],
                "memory_swap": host["MemorySwap"],
                "nano_cpus": host["NanoCpus"],
                "tmpfs": host.get("Tmpfs", {}),
                "ports": details["NetworkSettings"]["Ports"],
                "mount_types": [mount["Type"] for mount in details["Mounts"]],
            },
            sort_keys=True,
        )
    )


def run_container(name, owner, memory, image, arguments, command=()):
    disk_reserve()
    result = docker(
        "run",
        "-d",
        "--pull=never",
        "--name",
        name,
        "--label",
        f"{LABEL}={owner}",
        "--network",
        owner,
        "--memory",
        memory,
        "--memory-swap",
        memory,
        "--cpus",
        "1",
        "--log-driver",
        "json-file",
        "--log-opt",
        "max-size=5m",
        "--log-opt",
        "max-file=1",
        *arguments,
        image,
        *command,
    )

    return result.stdout.strip()


REQUIRED_IMAGE_FILES = (
    "manage.py",
    "core/__init__.py",
    "core/health.py",
    "core/api/__init__.py",
    "core/api/scopes.py",
    "core/api/problems.py",
    "core/api/lanes.py",
    "core/api/edge.py",
    "core/db/__init__.py",
    "core/db/ids.py",
    "core/db/models.py",
    "services/__init__.py",
    "services/identity/__init__.py",
    "services/identity/access_tokens.py",
    "services/identity/trusted_issuers.py",
    "apps/__init__.py",
    "apps/identity/__init__.py",
    "apps/identity/apps.py",
    "apps/identity/models.py",
    "apps/identity/selectors.py",
    "apps/identity/services.py",
    "apps/identity/api/__init__.py",
    "apps/identity/api/permissions.py",
    "apps/identity/api/serializers.py",
    "apps/identity/api/views.py",
    "apps/orgs/__init__.py",
    "apps/orgs/apps.py",
    "apps/orgs/models.py",
    "apps/orgs/selectors.py",
    "apps/orgs/detail_selectors.py",
    "apps/orgs/detail_services.py",
    "apps/orgs/api/__init__.py",
    "apps/orgs/api/detail.py",
    "apps/orgs/api/detail_permissions.py",
    "apps/orgs/api/detail_serializers.py",
    "apps/orgs/membership_selectors.py",
    "apps/orgs/membership_services.py",
    "apps/orgs/membership_pagination.py",
    "apps/orgs/api/memberships.py",
    "apps/orgs/api/membership_permissions.py",
    "apps/orgs/api/membership_serializers.py",
    "apps/orgs/membership_lifecycle.py",
    "apps/orgs/member_set_hooks.py",
    "apps/orgs/api/membership_detail.py",
    "apps/orgs/notice_contacts.py",
    "apps/orgs/api/notice_contacts.py",
    "apps/orgs/api/notice_contact_permissions.py",
    "config/__init__.py",
    "config/customer_urls.py",
    "config/environment.py",
    "config/urls.py",
    "config/wsgi.py",
    "config/settings/__init__.py",
    "config/settings/customer_http.py",
    "config/settings/e2e.py",
    "config/settings/dev.py",
    "config/settings/persistence.py",
)
FORBIDDEN_IMAGE_FILES = (
    ".env",
    ".git/private",
    "worker/private",
    "config/private.env",
    "core/worker.py",
    "apps/private.env",
    "apps/identity/private.py",
    "apps/identity/migrations/0001_initial.py",
    "services/private.py",
    "tests/private.py",
    "dev/private.py",
)
SENTINEL = "SYNTHETIC_CUSTOMER_HTTP_EXCLUDED_SOURCE"


COPY_SOURCE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_.-]+)*/?\Z")


def dockerfile_copy_sources(dockerfile):
    """Every build-context source the Dockerfile COPYs, read from the Dockerfile itself, so a root
    added to the image cannot be missing from the qualification context. A shape this reader does
    not understand (JSON form, continuation, glob, ADD, flag, parent path) is refused, never
    skipped."""
    sources = []
    for line in dockerfile.read_text().splitlines():
        words = line.split()
        if not words or words[0].upper() not in ("COPY", "ADD"):
            continue
        # A continuation, attached to the last word or not, would hide its next line's sources.
        if line.rstrip().endswith("\\"):
            raise ControllerError(f"Dockerfile source line not understood: {line.strip()}")
        if words[0] == "COPY" and len(words) >= 3 and words[1].startswith("--from="):
            continue  # From another stage, not from the build context.
        names = words[1:-1]
        if (
            words[0] != "COPY"
            or not names
            or not all(COPY_SOURCE.match(name) and ".." not in name for name in names)
        ):
            raise ControllerError(f"Dockerfile source line not understood: {line.strip()}")
        sources.extend(name.rstrip("/") for name in names)
    if not sources:
        raise ControllerError("Dockerfile source line not understood: no COPY from the context")
    return sources


def qualification_build_context(build):
    """Explicit test-only e2e overlay; the production context stays closed."""
    import shutil

    original = (ROOT / ".dockerignore").read_text()
    if "config/settings/e2e.py" not in original.splitlines():
        raise ControllerError("production e2e exclusion is missing")
    # The overlay below is the only place the e2e settings are admitted; a production context that
    # already admits them would make the closed image and the qualified one the same.
    if "!config/settings/e2e.py" in original.splitlines():
        raise ControllerError("production context already admits the e2e overlay")
    sources = dockerfile_copy_sources(ROOT / "Dockerfile")
    for name in ("Dockerfile", ".dockerignore"):
        shutil.copyfile(ROOT / name, build / name)
    for name in dict.fromkeys(sources):
        if (ROOT / name).is_dir():
            shutil.copytree(
                ROOT / name, build / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
            )
        else:
            (build / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, build / name)
    # Exactly one overlay path. No operator settings, migrations or fixture code enters the image.
    (build / ".dockerignore").write_text(original.rstrip("\n") + "\n!config/settings/e2e.py\n")


def install_source_sentinels(build):
    for name in FORBIDDEN_IMAGE_FILES:
        target = build / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(SENTINEL)


def qualify_image_sources(image, owner):
    import hashlib

    expected = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in REQUIRED_IMAGE_FILES
    }
    # Fixed program and current reviewed source hashes; no caller-selected image paths.
    script = (
        """
import hashlib,json,pathlib
root=pathlib.Path('/app')
expected="""
        + repr(expected)
        + """
forbidden="""
        + repr(FORBIDDEN_IMAGE_FILES)
        + """
sentinel="""
        + repr(SENTINEL.encode())
        + """
print(json.dumps({
'required_present':all((root/name).is_file() and hashlib.sha256((root/name).read_bytes()).hexdigest()==digest for name,digest in expected.items()),
'forbidden_paths':[name for name in forbidden if (root/name).exists()],
'sentinel_found':any(sentinel in path.read_bytes() for path in root.rglob('*') if path.is_file())}))
"""
    )
    result = docker(
        "run",
        "--rm",
        "--pull=never",
        "--name",
        owner + "-source-check",
        "--label",
        f"{LABEL}={owner}",
        "--network",
        "none",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "1",
        "--log-driver",
        "json-file",
        "--log-opt",
        "max-size=1m",
        "--log-opt",
        "max-file=1",
        image,
        "python",
        "-c",
        script,
        timeout=20,
    )
    require_image_sources(json.loads(result.stdout))
    print("PASS actual image required source hashes and excluded sentinels")


API_COMMAND = (
    "python",
    "-c",
    "from wsgiref.simple_server import make_server; from config.wsgi import application; make_server('0.0.0.0',8000,application).serve_forever()",
)


def main(scenario=None):
    if scenario is not None:
        from dev.membership_directory_image_acceptance import DirectoryScenario

        if type(scenario) is not DirectoryScenario:
            raise ControllerError("unknown customer image scenario")
    import secrets
    import subprocess
    import tempfile
    import time
    import uuid

    from psycopg import sql

    from dev.accept_runtime import POSTGRES
    from dev.identity_fixture import (
        CALLBACK,
        KEYCLOAK,
        REALM,
        LoopbackHTTP,
        code_flow,
        fixture_realm,
    )
    from services.identity.access_tokens import IssuerKeySnapshot, verify_access_token

    owner = "customer-http-" + uuid.uuid4().hex[:12]
    names = [owner + "-db", owner + "-idp", owner + "-api", owner + "-source-check"]
    image = "kodera-customer-http:" + owner
    owner_password, provider_password, reader_password, login_password = [
        secrets.token_urlsafe(32) for _ in range(4)
    ]
    stage = "preflight"
    try:
        stage = phase("preflight")
        disk_reserve()
        # No pull command. Every external image must exist before starting resources.
        for reference in (
            POSTGRES,
            KEYCLOAK,
            "ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500",
            "python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254",
        ):
            docker("image", "inspect", reference)
        if not (ROOT / "dev/customer_http_image_acceptance.py").is_file():
            raise ControllerError("reviewed HTTP image source is not integrated")
        with tempfile.TemporaryDirectory(prefix="customer-http-") as temporary:
            directory = Path(temporary)
            build = directory / "build"
            build.mkdir()
            qualification_build_context(build)
            install_source_sentinels(build)
            disk_reserve()
            stage = phase("build")
            docker(
                "build",
                "--pull=false",
                "--label",
                f"{LABEL}={owner}",
                "-t",
                image,
                str(build),
                timeout=600,
            )
            stage = phase("image-sources")
            if scenario is not None:
                scenario.owner = owner
                scenario.capture("image", image, owner)
            qualify_image_sources(image, owner)
            if scenario is not None:
                scenario.passed("image-source")
            stage = phase("network")
            network_id = docker(
                "network", "create", "--label", f"{LABEL}={owner}", owner
            ).stdout.strip()
            if scenario is not None:
                scenario.capture("network", owner, owner, network_id)
            stage = phase("database-start")
            database_id = run_container(
                names[0],
                owner,
                "512m",
                POSTGRES,
                (
                    "--network-alias",
                    "db",
                    "--tmpfs",
                    "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
                    "-p",
                    "127.0.0.1::5432",
                    "-e",
                    "POSTGRES_USER=fixture_owner",
                    "-e",
                    "POSTGRES_DB=kodera_server",
                    "-e",
                    "POSTGRES_PASSWORD=" + owner_password,
                ),
            )
            if scenario is not None:
                scenario.capture("container", names[0], owner, database_id)
            stage = phase("database-readiness")
            wait_until(lambda: database_tcp_ready(names[0]), 30, "database TCP")
            stage = phase("database-inspection")
            port = container_port(names[0], 5432, owner)
            resource_evidence(names[0], 512 * 1024**2, owner)
            owner_arguments = dict(
                host="127.0.0.1",
                port=port,
                user="fixture_owner",
                password=owner_password,
                dbname="kodera_server",
                autocommit=True,
                connect_timeout=2,
                options=PG_OPTIONS,
            )
            stage = phase("database-login-setup")
            with psycopg.connect(**owner_arguments) as connection:
                for database in ("postgres", "template1"):
                    connection.execute(
                        sql.SQL("REVOKE CONNECT,TEMPORARY ON DATABASE {} FROM PUBLIC").format(
                            sql.Identifier(database)
                        )
                    )
                connection.execute(
                    sql.SQL(
                        "CREATE ROLE identity_provider LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}"
                    ).format(sql.Literal(provider_password))
                )
                connection.execute("CREATE DATABASE identity OWNER identity_provider")
                connection.execute("REVOKE CONNECT,TEMPORARY ON DATABASE identity FROM PUBLIC")
                connection.execute("GRANT CONNECT ON DATABASE identity TO identity_provider")
                connection.execute("REVOKE CONNECT,TEMPORARY ON DATABASE kodera_server FROM PUBLIC")
            stage = phase("provider-fixture")
            imported = directory / "import"
            imported.mkdir(mode=0o755)
            if scenario is None:
                target = imported / "realm.json"
                target.write_text(json.dumps(fixture_realm(login_password, CALLBACK)))
                target.chmod(
                    0o644
                )  # Synthetic local import readable by the provider container user.
            else:
                scenario.imports(imported, login_password)
            stage = phase("provider-start")
            provider_id = run_container(
                names[1],
                owner,
                "1g",
                KEYCLOAK,
                (
                    "-p",
                    "127.0.0.1::8080",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges:true",
                    "-v",
                    str(imported) + ":/opt/keycloak/data/import:ro",
                    "-e",
                    "KC_DB=postgres",
                    "-e",
                    "KC_DB_URL=jdbc:postgresql://db/identity",
                    "-e",
                    "KC_DB_USERNAME=identity_provider",
                    "-e",
                    "KC_DB_PASSWORD=" + provider_password,
                ),
                ("start-dev", "--import-realm"),
            )
            if scenario is not None:
                scenario.capture("container", names[1], owner, provider_id)
            stage = phase("provider-readiness")
            transport = LoopbackHTTP(
                container_port(names[1], 8080, owner),
                realm=REALM if scenario is None else "directory-main",
            )
            wait_until(lambda: bool(transport.jwks()), 90, "provider")
            stage = phase("provider-inspection")
            resource_evidence(names[1], 1024**3, owner)
            disk_reserve()
            stage = phase("provider-tokens")
            if scenario is None:
                tokens = code_flow(transport, login_password)
                wrong = code_flow(transport, login_password, client_id="without-core-audience")
                issuer = transport.origin + "/realms/" + REALM
                jwks = transport.jwks()
                expiry = int(time.time()) + 600
                snapshot = IssuerKeySnapshot.from_jwks(
                    jwks, issuer=issuer, generation=owner, expires_at=expiry
                )
                verified = verify_access_token(tokens["access_token"], admitted=snapshot)
                trust = json.dumps(
                    [
                        dict(
                            lane="customer",
                            issuer=issuer,
                            generation=owner,
                            expires_at=expiry,
                            public_jwks=json.loads(jwks),
                        )
                    ]
                )
            else:
                tokens, verified, trust, fixture_name = scenario.provider(
                    transport.port, login_password, owner
                )
            environment = child_environment() | {
                "DATABASE_URL": f"postgres://fixture_owner:{owner_password}@127.0.0.1:{port}/kodera_server",
                "DJANGO_SETTINGS_MODULE": "config.settings.persistence",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            stage = phase("seed")
            seeded = subprocess.run(  # noqa: S603 - fixed owned Python program and projected environment
                [
                    sys.executable,
                    "-c",
                    SEED
                    if scenario is None
                    else "import json,sys; from dev.membership_directory_image_acceptance import run_seed_operation; print(json.dumps(run_seed_operation(json.load(sys.stdin))))",
                ],
                input=json.dumps(
                    dict(issuer=verified.issuer, subject=verified.subject, realm=REALM)
                    if scenario is None
                    else scenario.seed_payload()
                ),
                text=True,
                capture_output=True,
                env=environment,
                cwd=ROOT,
                timeout=45,
                check=False,
            )  # noqa: S603
            if seeded.returncode:
                raise ControllerError("owned migration and fixture seed failed")
            expected = json.loads(seeded.stdout)
            stage = phase("reader-provision")
            with psycopg.connect(**owner_arguments) as connection:
                provision_reader(connection, reader_password)
            stage = phase("reader-privileges")
            if scenario is None:
                qualify_reader(port, reader_password)
            else:
                qualify_reader(port, reader_password, expected_counts=expected["counts"])
                scenario.passed("reader")
            stage = phase("api-start")
            api_env = api_environment(reader_password, trust)
            if scenario is not None:
                api_env["KODERA_MEMBERSHIP_CURSOR_KEY"] = secrets.token_hex(32)
            args = api_runtime_arguments()
            for key, value in api_env.items():
                args.extend(("-e", key + "=" + value))
            api_id = run_container(
                names[2],
                owner,
                "256m",
                image,
                args,
                API_COMMAND,
            )
            if scenario is not None:
                scenario.capture("container", names[2], owner, api_id)
            stage = phase("api-inspection")
            api_port = container_port(names[2], 8000, owner)
            resource_evidence(names[2], 256 * 1024**2, owner)
            api_details = require_owned("container", names[2], owner)
            require_api_runtime(
                api_details, api_env, (owner_password, provider_password, login_password)
            )
            stage = phase("api-readiness")
            wait_until(lambda: http_request(api_port, "/health/ready")[0] == 200, 30, "API")
            if scenario is not None:
                scenario.bind(
                    names=names,
                    image=image,
                    api_port=api_port,
                    api_env=api_env,
                    environment=environment,
                )
                stage = phase("image-tests")
                scenario.qualify()
            else:
                private = directory / "input"
                private.mkdir(mode=0o700)
                payload = dict(
                    api_port=api_port,
                    access_token=tokens["access_token"],
                    id_token=tokens["id_token"],
                    refresh_token=tokens["refresh_token"],
                    wrong_audience=wrong["access_token"],
                    expected_me=expected,
                )
                stage = phase("image-tests")
                with private_image_input(private, payload) as source:
                    result = subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "pytest",
                            "-q",
                            "--tb=no",
                            "dev/customer_http_image_acceptance.py",
                        ],
                        cwd=ROOT,
                        env=child_environment() | {"KODERA_HTTP_ACCEPTANCE_INPUT": str(source)},
                        capture_output=True,
                        text=True,
                        timeout=60,
                        check=False,
                    )  # noqa: S603
                    if result.returncode:
                        raise ControllerError("actual provider image acceptance failed")
                print("PASS four actual provider/image acceptance cases")
                disk_reserve()
                stage = phase("outage")
                before = require_owned("container", names[2], owner)
                with paused_database(names[0], owner):
                    require_outage_response(
                        *http_request(api_port, "/api/v1/me", tokens["access_token"])
                    )
                    if (
                        http_request(api_port, "/health/ready")[0] != 503
                        or http_request(api_port, "/health/live")[0] != 200
                    ):
                        raise ControllerError("actual outage health responses refused")
                stage = phase("recovery")
                wait_until(
                    lambda: http_request(api_port, "/health/ready")[0] == 200,
                    20,
                    "database recovery",
                )
                status, actual, _ = http_request(api_port, "/api/v1/me", tokens["access_token"])
                if status != 200:
                    raise ControllerError("same persisted API recovery refused")
                require_recovery(
                    before, require_owned("container", names[2], owner), expected, actual
                )
                print("PASS actual database pause outage and same-process persisted recovery")
                disk_reserve()
    except ControllerError as error:
        report_failure(stage, error)
        raise
    except Exception as error:
        report_failure(stage, error)
        raise ControllerError("owned customer HTTP qualification failed") from None
    finally:
        try:
            phase("cleanup")
            if scenario is None:
                cleanup(owner, names, owner, image)
            else:
                restoration_failed = False
                try:
                    scenario.before_cleanup()
                except Exception:
                    restoration_failed = True
                cleanup(
                    owner,
                    names,
                    owner,
                    image,
                    expected_ids={key: value["id"] for key, value in scenario.resources.items()},
                )
                scenario.record(
                    "cleanup.json",
                    {"owned_resources_absent": True, "restoration_failed": restoration_failed},
                )
                if restoration_failed:
                    raise ControllerError("owned fixture restoration failed before cleanup")
        except Exception as error:
            report_failure("cleanup", error)
            raise
        finally:
            disk_reserve()


if __name__ == "__main__":
    try:
        main()
    except ControllerError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
