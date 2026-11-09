#!/usr/bin/env python3
"""Hosted synthetic consume HTTP qualification; separate exact column role, no live IAM."""

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "consume_bootstrap_helper", ROOT / "dev/accept_bootstrap_http.py"
)
if _spec is None or _spec.loader is None:
    raise RuntimeError("bootstrap helper unavailable")
bootstrap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bootstrap)
serving = bootstrap.serving
require = serving.require
LABEL = "kodera.consume-qualification"
OWNER = "consume-http-" + uuid.uuid4().hex[:12]
PASSWORD = "synthetic-consume-only"  # noqa: S105 - disposable synthetic database
PHASE = "admission"
FAILURE_PHASES = frozenset(
    {
        "admission",
        "hosted-reserve",
        "source-baseline",
        "source-inventory",
        "owned-network",
        "owned-postgresql-start",
        "owned-postgresql-ready",
        "actual-scoped-postgresql-fixture",
        "actual-image-build",
        "actual-image-start",
        "actual-image-readiness",
        "actual-image-boundary",
        "consume-live-and-host",
        "consume-atomic-success",
        "consume-profile",
        "consume-replay-and-current-withdrawal",
        "consume-contact-mfa-and-new-key",
        "consume-ordered-signature-and-token-refusals",
        "consume-verified-claim-nowait",
        "consume-required-audit-rollback",
        "consume-actual-clock-expiry",
        "consume-no-new-operator-effects-and-privacy",
        "consume-shutdown",
        "owned-cleanup",
    }
)
PATH = "/api/v1/owner-claims/actions/consume"
STAFF_ISSUER = bootstrap.STAFF_ISSUER
BASELINES = {
    "dev/accept_production_http.py": "87ded33470693974d4ed71988f6d9c0b9677175976f539549abaff545d21876c",
    "dev/accept_bootstrap_http.py": "79ade062798b64e4914b2eba7e3c0f56f1636dcd98f53aca406a872fa509633f",
}


CONSUME_SELECT_COLUMNS = {
    "identity_user": ("id", "email", "display_name", "enabled", "deleted_at"),
    "identity_identity": (
        "id",
        "user_id",
        "organisation_id",
        "issuer",
        "subject",
        "realm",
        "enabled",
        "deleted_at",
    ),
    "orgs_organisation": (
        "id",
        "state",
        "slug",
        "realm",
        "name",
        "created_at",
        "updated_at",
        "deleted_at",
        "owner_guard_revision",
        "authority_revision",
    ),
    "orgs_membership": (
        "id",
        "user_id",
        "organisation_id",
        "role",
        "state",
        "accepted_at",
        "deleted_at",
    ),
    "orgs_ownerbinding": ("identity_id", "organisation_id", "issuer"),
    "orgs_ownerclaim": (
        "id",
        "organisation_id",
        "token_hash",
        "intended_identity_id",
        "state",
        "expires_at",
        "consumed_at",
        "membership_id",
    ),
    "orgs_slugreservation": ("organisation_id", "state", "slug"),
    "audit_auditevent": ("occurred_at", "metadata"),
    "idempotency_record": (
        "id",
        "issuer",
        "subject",
        "method",
        "path",
        "key_sha256",
        "body_sha256",
        "status",
        "content_type",
        "body",
        "location",
        "etag",
        "job_id",
        "created_at",
    ),
}


CONSUME_UPDATE_COLUMNS = {
    "identity_user": ("enabled", "display_name", "updated_at"),
    "identity_identity": ("id",),
    "orgs_organisation": ("state", "updated_at", "owner_guard_revision", "authority_revision"),
    "orgs_membership": ("id",),
    "orgs_ownerbinding": ("id",),
    "orgs_ownerclaim": (
        "state",
        "revoked_at",
        "consumed_at",
        "consumed_by_identity_id",
        "membership_id",
    ),
    "orgs_slugreservation": ("state", "protected_at", "updated_at"),
}


CONSUME_INSERT_COLUMNS = {
    "orgs_membership": (
        "id",
        "created_at",
        "updated_at",
        "deleted_at",
        "purge_after",
        "user_id",
        "organisation_id",
        "role",
        "state",
        "accepted_at",
    ),
    "audit_auditevent": (
        "id",
        "actor_type",
        "actor_id",
        "actor_label",
        "organisation_id",
        "action",
        "target_urn",
        "before",
        "after",
        "request_id",
        "job_id",
        "source_ip_trunc",
        "retention_class",
        "metadata",
    ),
    "idempotency_record": (
        "id",
        "issuer",
        "subject",
        "method",
        "path",
        "key_sha256",
        "body_sha256",
        "status",
        "content_type",
        "body",
        "location",
        "etag",
        "job_id",
    ),
}


ROLE_POLICY_SELECT = {
    "identity_user": ("id", "email", "display_name", "enabled", "deleted_at"),
    "identity_identity": (
        "id",
        "user_id",
        "organisation_id",
        "issuer",
        "subject",
        "realm",
        "enabled",
        "deleted_at",
    ),
    "orgs_organisation": (
        "id",
        "state",
        "slug",
        "realm",
        "name",
        "created_at",
        "updated_at",
        "deleted_at",
        "owner_guard_revision",
        "authority_revision",
    ),
    "orgs_membership": (
        "id",
        "user_id",
        "organisation_id",
        "role",
        "state",
        "accepted_at",
        "deleted_at",
    ),
    "orgs_ownerbinding": ("identity_id", "organisation_id", "issuer"),
    "orgs_ownerclaim": (
        "id",
        "organisation_id",
        "token_hash",
        "intended_identity_id",
        "state",
        "expires_at",
        "consumed_at",
        "membership_id",
    ),
    "orgs_slugreservation": ("organisation_id", "state", "slug"),
    "audit_auditevent": ("occurred_at", "metadata"),
    "idempotency_record": (
        "id",
        "issuer",
        "subject",
        "method",
        "path",
        "key_sha256",
        "body_sha256",
        "status",
        "content_type",
        "body",
        "location",
        "etag",
        "job_id",
        "created_at",
    ),
}


ROLE_POLICY_UPDATE = {
    "identity_user": ("enabled", "display_name", "updated_at"),
    "identity_identity": ("id",),
    "orgs_organisation": ("state", "updated_at", "owner_guard_revision", "authority_revision"),
    "orgs_membership": ("id",),
    "orgs_ownerbinding": ("id",),
    "orgs_ownerclaim": (
        "state",
        "revoked_at",
        "consumed_at",
        "consumed_by_identity_id",
        "membership_id",
    ),
    "orgs_slugreservation": ("state", "protected_at", "updated_at"),
}


ROLE_POLICY_INSERT = {
    "orgs_membership": (
        "id",
        "created_at",
        "updated_at",
        "deleted_at",
        "purge_after",
        "user_id",
        "organisation_id",
        "role",
        "state",
        "accepted_at",
    ),
    "audit_auditevent": (
        "id",
        "actor_type",
        "actor_id",
        "actor_label",
        "organisation_id",
        "action",
        "target_urn",
        "before",
        "after",
        "request_id",
        "job_id",
        "source_ip_trunc",
        "retention_class",
        "metadata",
    ),
    "idempotency_record": (
        "id",
        "issuer",
        "subject",
        "method",
        "path",
        "key_sha256",
        "body_sha256",
        "status",
        "content_type",
        "body",
        "location",
        "etag",
        "job_id",
    ),
}


CONSUME_DELETE_TABLES = ("idempotency_record",)
ROLE_POLICY_DELETE = ("idempotency_record",)


def expected_policy():
    result = dict.fromkeys(
        (
            "attributes_safe",
            "owns_nothing",
            "database_safe",
            "schema_safe",
            "functions_safe",
            "sequences_safe",
            "no_table_grants",
            "public_trigger_execute",
        ),
        True,
    )
    for name, matrix in (
        ("select", ROLE_POLICY_SELECT),
        ("update", ROLE_POLICY_UPDATE),
        ("insert", ROLE_POLICY_INSERT),
    ):
        result[name] = sorted(
            [[table, column] for table, columns in matrix.items() for column in columns]
        )
    result["delete"] = list(ROLE_POLICY_DELETE)
    return result


def consume_policy(details):
    expected = expected_policy()
    require(
        isinstance(details, dict) and set(details) == set(expected), "consume role policy refused"
    )
    for name, value in expected.items():
        if type(value) is bool:
            require(
                type(details[name]) is bool and details[name] is True,
                "consume role policy refused",
            )
        else:
            require(details[name] == value, "consume role policy refused")


def install_consume_role(cursor, role_name, database_name, password):
    from psycopg import sql

    require(
        re.fullmatch(r"synthetic_consume_[a-z0-9]{1,24}", role_name) is not None,
        "consume role name refused",
    )
    cursor.execute(
        sql.SQL(
            "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD {}"
        ).format(sql.Identifier(role_name), sql.Literal(password))
    )
    cursor.execute(
        sql.SQL("REVOKE CREATE, TEMP ON DATABASE {} FROM PUBLIC").format(
            sql.Identifier(database_name)
        )
    )
    cursor.execute(
        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
            sql.Identifier(database_name), sql.Identifier(role_name)
        )
    )
    cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role_name)))
    for privilege, matrix in (
        ("SELECT", CONSUME_SELECT_COLUMNS),
        ("UPDATE", CONSUME_UPDATE_COLUMNS),
        ("INSERT", CONSUME_INSERT_COLUMNS),
    ):
        for table, columns in matrix.items():
            cursor.execute(
                sql.SQL("GRANT {} ({}) ON {} TO {}").format(
                    sql.SQL(privilege),
                    sql.SQL(",").join(map(sql.Identifier, columns)),
                    sql.Identifier(table),
                    sql.Identifier(role_name),
                )
            )
    for table in CONSUME_DELETE_TABLES:
        cursor.execute(
            sql.SQL("GRANT DELETE ON {} TO {}").format(
                sql.Identifier(table), sql.Identifier(role_name)
            )
        )


def assert_consume_role_policy(cursor, role_name, database_name):
    cursor.execute(
        "SELECT oid, NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=%s",
        [role_name],
    )
    row = cursor.fetchone()
    require(row is not None, "consume role policy refused")
    oid, safe = row
    proof = {"attributes_safe": safe}
    cursor.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=%s) AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=%s) AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=%s) AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=%s) AND NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=%s AND deptype='o')",
        [oid] * 5,
    )
    proof["owns_nothing"] = cursor.fetchone()[0]
    cursor.execute("SELECT NOT has_database_privilege(%s,%s,'CREATE,TEMP')", [oid, database_name])
    proof["database_safe"] = cursor.fetchone()[0]
    cursor.execute(
        "SELECT has_schema_privilege(%s,'public','USAGE') AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname!='information_schema' AND (has_schema_privilege(%s,oid,'CREATE') OR (nspname!='public' AND has_schema_privilege(%s,oid,'USAGE'))))",
        [oid] * 3,
    )
    proof["schema_safe"] = cursor.fetchone()[0]
    # PUBLIC trigger EXECUTE is inherited, measured and accepted only for invoker triggers.
    cursor.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND ((has_function_privilege(%s,p.oid,'EXECUTE') AND (p.prosecdef OR p.prorettype!='trigger'::regtype)) OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=%s)))",
        [oid, oid],
    )
    proof["functions_safe"] = cursor.fetchone()[0]
    cursor.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='public' AND p.prorettype='trigger'::regtype AND NOT p.prosecdef AND a.grantee=0 AND a.privilege_type='EXECUTE')"
    )
    proof["public_trigger_execute"] = cursor.fetchone()[0]
    cursor.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)",
        [oid],
    )
    proof["sequences_safe"] = cursor.fetchone()[0]
    cursor.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(%s,c.oid,'SELECT,INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER'))",
        [oid],
    )
    proof["no_table_grants"] = cursor.fetchone()[0]
    for privilege in ("SELECT", "UPDATE", "INSERT"):
        cursor.execute(
            "SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(%s,c.oid,a.attnum,%s) ORDER BY c.relname,a.attname",
            [oid, privilege],
        )
        proof[privilege.lower()] = [list(row) for row in cursor.fetchall()]
    # REFERENCES is also column-grantable, unlike DELETE/TRUNCATE/TRIGGER.
    cursor.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND has_column_privilege(%s,c.oid,a.attnum,'REFERENCES'))",
        [oid],
    )
    proof["no_table_grants"] = proof["no_table_grants"] and cursor.fetchone()[0]
    cursor.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(%s,c.oid,'DELETE') ORDER BY c.relname",
        [oid],
    )
    proof["delete"] = [row[0] for row in cursor.fetchall()]
    consume_policy(proof)
    return proof


def baseline_sources():
    for name, expected in BASELINES.items():
        require(
            hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected,
            "consume baseline changed",
        )


def public_bytes(raw, secrets):
    require(
        all((value.encode() if isinstance(value, str) else value) not in raw for value in secrets),
        "consume private material refused",
    )


ROLE_RETURNING = {
    "orgs_membership": (),
    "audit_auditevent": ("occurred_at", "metadata"),
    "idempotency_record": ("created_at",),
}


IMAGE_REQUIRED = (
    "apps/orgs/claim_consumption.py",
    "apps/orgs/claim_tokens.py",
    "apps/orgs/api/owner_claims.py",
    "apps/orgs/api/owner_claim_permissions.py",
    "apps/orgs/api/owner_claim_serializers.py",
)


def image_source_boundary(root):
    from pathlib import Path

    excluded = (
        "dev",
        "tests",
        "apps/identity/owner_binding.py",
        "apps/orgs/owner_claims.py",
        "apps/orgs/claim_contact.py",
        "apps/orgs/claim_configuration.py",
        "apps/orgs/claim_delivery.py",
        "apps/orgs/claim_confirmation.py",
        "apps/orgs/management",
        "config/settings/e2e.py",
        "config/settings/e2e_operator.py",
        "config/settings/job_queue.py",
    )
    # The image's outbox is exactly the realm access enqueue (MEMBERSHIP_LIFECYCLE.md §6.1.1).
    require(
        all(not (Path(root) / name).exists() for name in excluded)
        and all((Path(root) / name).is_file() for name in IMAGE_REQUIRED)
        and (Path(root) / "apps/outbox").is_dir()
        and sorted(
            entry.name
            for entry in (Path(root) / "apps/outbox").iterdir()
            if entry.name != "__pycache__"
        )
        == ["__init__.py", "realm_enqueue.py"],
        "consume image source boundary refused",
    )


def insert_shape_capture(records):
    """Only three source-derived INSERT shapes, after actual driver success; never parameters."""

    def capture(execute, statement, parameters, many, context):
        result = execute(statement, parameters, many, context)
        if not statement.startswith("INSERT INTO "):
            return result
        match = re.fullmatch(
            r'INSERT INTO "([a-z_]+)" \(([^)]+)\) VALUES (.+?)(?: RETURNING (.+))?', statement
        )
        require(match is not None and not many, "consume INSERT shape refused")
        table, fields, _, returning = match.groups()
        require(table in ROLE_POLICY_INSERT, "consume INSERT shape refused")
        columns = re.findall(r'"([a-z_][a-z_0-9]*)"', fields)
        require(
            fields == ", ".join('"' + column + '"' for column in columns)
            or fields == ",".join('"' + column + '"' for column in columns),
            "consume INSERT shape refused",
        )
        returned = (
            []
            if returning is None
            else re.findall(r'"' + table + r'"\."([a-z_][a-z_0-9]*)"', returning)
        )
        expected_returning = ", ".join('"' + table + '"."' + column + '"' for column in returned)
        require(
            returning is None or returning == expected_returning, "consume INSERT shape refused"
        )
        require(
            tuple(columns) == ROLE_POLICY_INSERT[table]
            and tuple(returned) == ROLE_RETURNING[table]
            and "DEFAULT" not in statement,
            "consume INSERT shape refused",
        )
        records.append(
            {
                "table": table,
                "insert_columns": columns,
                "returning_columns": returned,
                "compiled_default_keyword": False,
            }
        )
        return result

    return capture


def assert_insert_shapes(records):
    require(len(records) == 5, "consume INSERT inventory refused")
    expected = {"orgs_membership": 1, "audit_auditevent": 3, "idempotency_record": 1}
    require(
        {table: sum(row.get("table") == table for row in records) for table in expected}
        == expected,
        "consume INSERT inventory refused",
    )
    for row in records:
        table = row["table"]
        require(
            row
            == {
                "table": table,
                "insert_columns": list(ROLE_POLICY_INSERT[table]),
                "returning_columns": list(ROLE_RETURNING[table]),
                "compiled_default_keyword": False,
            },
            "consume INSERT shape refused",
        )


def secret_material(world):
    import base64

    values = []
    for record in world["cases"].values():
        values.extend(
            (
                record["token"],
                record["token"][-43:],
                record["verifier"],
                record["sealed_contact"],
                record["sealed_delivery"],
            )
        )
    values.extend(value.encode().hex() for value in tuple(values))
    values.extend(base64.b64encode(value.encode()).decode() for value in tuple(values))
    for record in world["cases"].values():
        for field in ("sealed_contact", "sealed_delivery"):
            binary = bytes.fromhex(record[field])
            values.extend((binary, binary.hex(), base64.b64encode(binary).decode()))
    return tuple(set(values))


def post(port, payload, credential, key, *, host="api.synthetic.test"):
    require(type(port) is int and 1 <= port <= 65535, "consume port refused")
    headers = {"Host": host, "Content-Type": "application/json", "Idempotency-Key": key}
    if credential is not None:
        headers["Authorization"] = "Bearer " + credential
    request = Request(
        f"http://127.0.0.1:{port}{PATH}",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        response = urlopen(request, timeout=5)  # noqa: S310 - constructed numeric loopback only
    except HTTPError as error:
        response = error
    with response:
        body = response.read(65537)
        require(len(body) <= 65536, "consume response capture truncated")
        return response.code, body, dict(response.headers)


def seed_consume_fixture(
    cases=("success", "profile", "contact", "mfa", "past", "rollback", "busy"),
):
    """Disposable operator seed invokes the actual binding/issuance and sealed delivery path."""
    import jwt
    from argon2 import extract_parameters
    from cryptography.hazmat.primitives.asymmetric import rsa
    from django.conf import settings
    from django.db import transaction
    from django.utils import timezone

    from apps.identity.command_principal import staff_principal_for_command
    from apps.identity.models import Identity, StaffRole, User
    from apps.jobs.models import Job
    from apps.orgs.models import (
        Organisation,
        OrganisationIntake,
        OwnerBinding,
        OwnerClaim,
        RealmReadiness,
        SlugReservation,
    )
    from apps.orgs.owner_claims import AccountCreationRecord, bind_intended_owner
    from apps.outbox.mail.seal import unseal
    from apps.outbox.models import OutboxMessage
    from config.environment import allowed_oidc_client_ids
    from core.db.ids import new_uuid7
    from core.sealing import seal
    from services.identity.trusted_issuers import load_trust

    settings.KODERA_STAFF_ISSUER = STAFF_ISSUER
    settings.KODERA_INTAKE_ADMITTED = True
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.KODERA_CONTACT_SEAL_KEY = hashlib.sha256(b"synthetic consume contact key").digest()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"synthetic consume delivery key").digest()
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.synthetic.test"})
    settings.KODERA_OWNER_CLAIM_LINK = "https://app.synthetic.test/claim"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="synthetic-consume-key", alg="RS256", use="sig", key_ops=["verify"])
    now = int(time.time())
    entries = [
        {
            "lane": "staff",
            "issuer": STAFF_ISSUER,
            "generation": "synthetic-consume",
            "expires_at": now + 1200,
            "public_jwks": {"keys": [jwk]},
        }
    ]
    for case in cases:
        entries.append(
            {
                "lane": "customer",
                "issuer": "https://identity.synthetic.test/realms/consume-" + case,
                "generation": "synthetic-consume",
                "expires_at": now + 1200,
                "public_jwks": {"keys": [jwk]},
            }
        )
    trust = json.dumps(entries)
    # As the served image resolves it from KODERA_CONSOLE_CLIENT_ID=synthetic-console below.
    settings.KODERA_AUTH_TRUST = load_trust(
        trust,
        allowed_azp=allowed_oidc_client_ids({"KODERA_CONSOLE_CLIENT_ID": "synthetic-console"}),
    )

    def signed(issuer, subject, **facts):
        claims = {
            "iss": issuer,
            "sub": subject,
            "aud": "kodera-server",
            "iat": now,
            "exp": now + 900,
            "typ": "Bearer",
            "auth_time": now,
            "amr": ["pwd", "otp"],
            "email_verified": True,
            "azp": "synthetic-console",
            "kodera_mfa_enrolled": True,
        }
        claims.update(facts)
        return jwt.encode(claims, key, algorithm="RS256", headers={"kid": jwk["kid"]})

    staff = {}
    with transaction.atomic():
        for name in ("recorder", "operator"):
            user = User.objects.create(email=name + "@consume.staff.synthetic.test")
            identity = Identity.objects.create(
                user=user,
                issuer=STAFF_ISSUER,
                realm="kodera-staff",
                subject="consume-" + name,
                email=user.email,
            )
            StaffRole.objects.create(identity=identity, role="staff_operator")
            staff[name] = identity
    result = {"cases": {}, "trust": trust, "staff_token": signed(STAFF_ISSUER, "consume-operator")}
    for case in cases:
        slug = "consume-" + case
        issuer = "https://identity.synthetic.test/realms/" + slug
        with transaction.atomic():
            organisation = Organisation.objects.create(
                slug=slug, name="Synthetic consumption", realm=slug, issuer=issuer, state="prospect"
            )
            SlugReservation.objects.create(
                organisation=organisation, slug=slug, state="provisional"
            )
            job = Job.objects.create(
                organisation=organisation,
                kind="realm_create",
                idempotency_key=uuid.uuid4().hex * 2,
                desired_spec_hash="c" * 64,
                status="succeeded",
                max_attempts=1,
                actor_type="staff",
                actor_id=staff["recorder"].id,
                finished_at=timezone.now(),
            )
            intake_id = new_uuid7()
            contact = "owner@" + slug + ".synthetic.test"
            sealed = seal(
                settings.KODERA_CONTACT_SEAL_KEY,
                b"kodera-organisation-intake:" + intake_id.bytes,
                json.dumps(
                    {"intended_owner": {"email": contact}, "profile": {"locale": "en"}}
                ).encode(),
            )
            OrganisationIntake.objects.create(
                id=intake_id,
                organisation=organisation,
                recorded_by_identity=staff["recorder"],
                instruction_ref="SYN-200",
                sealed_contact=sealed,
                intended_owner_email_masked="o***@synthetic.test",
                bootstrap_job_id=job.id,
            )
            RealmReadiness.objects.create(
                organisation=organisation,
                job_id=job.id,
                issuer=issuer,
                realm=slug,
                recorded_by_identity=staff["operator"],
            )
        settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1" if case == "past" else "259200"
        outcome = bind_intended_owner(
            principal=staff_principal_for_command(staff["operator"].id),
            organisation_id=organisation.id,
            subject="consume-owner",
            account_record=AccountCreationRecord(
                issuer, "consume-owner", False, "synthetic-existing-account"
            ),
            contact=contact,
            request_id="synthetic-consume-bind",
        )
        claim = OwnerClaim.objects.get(id=outcome.claim_id)
        message = OutboxMessage.objects.get(delivery_id=outcome.delivery_id)
        delivered = unseal(
            settings.KODERA_OUTBOX_SEAL_KEY, outcome.delivery_id, bytes(message.sealed)
        )
        binding = OwnerBinding.objects.get(id=outcome.binding_id)
        require(
            extract_parameters(bytes(claim.token_hash).decode()).memory_cost == 65536,
            "consume actual verifier profile refused",
        )
        result["cases"][case] = {
            "organisation_id": str(organisation.id),
            "claim_id": str(claim.id),
            "identity_id": str(binding.identity_id),
            "user_id": str(binding.identity.user_id),
            "token": delivered.secret,
            "verifier": bytes(claim.token_hash).decode(),
            "sealed_contact": sealed.hex(),
            "sealed_delivery": bytes(message.sealed).hex(),
            "credential": signed(issuer, "consume-owner"),
            "contact_credential": signed(issuer, "consume-owner", email_verified=False),
            "mfa_credential": signed(issuer, "consume-owner", amr=["pwd"]),
            "unknown_credential": signed(issuer, "consume-unknown"),
        }
    return result


def docker(*args, **kwargs):
    return serving.docker(*args, **kwargs)


def owned(details, kind):
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    require((labels or {}).get(LABEL) == OWNER, "bootstrap resource owner mismatch")


def inspect(reference):
    return json.loads(docker("inspect", reference).stdout)[0]


def absent(kind, reference):
    if kind == "image":
        require(
            not docker("image", "ls", "-q", "--filter", f"label={LABEL}={OWNER}").stdout.strip(),
            "bootstrap owned image remains",
        )
        return
    result = docker(kind, "ls", *(["-a"] if kind == "container" else []), "--format", "{{json .}}")
    key = "Names" if kind == "container" else "Name"
    require(
        reference not in [json.loads(line)[key] for line in result.stdout.splitlines() if line],
        "bootstrap owned resource remains",
    )


def remove(kind, reference):
    result = docker(kind, "inspect", reference, check=False)
    if result.returncode == 0:
        owned(json.loads(result.stdout)[0], kind)
        docker(kind, "rm", *([] if kind == "network" else ["-f"]), reference)
    absent(kind, reference)


def qualify_consume_http():
    global PHASE
    import psycopg
    from psycopg import sql

    require(os.environ.get("GITHUB_ACTIONS") == "true", "hosted-only consume qualification")
    PHASE = "hosted-reserve"
    serving.require_disk_reserve()
    PHASE = "source-baseline"
    baseline_sources()
    PHASE = "source-inventory"
    frozen = serving.source_hashes()
    network, database, api, image = (OWNER + suffix for suffix in ("-net", "-db", "-api", ":image"))
    proof = {}
    try:
        PHASE = "owned-network"
        docker("network", "create", "--label", f"{LABEL}={OWNER}", network)
        info = json.loads(docker("network", "inspect", network).stdout)[0]
        owned(info, "network")
        require(info.get("Internal") is False, "consume topology refused")
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
            *serving.caps(768 * 1024**2),
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
            serving.POSTGRES,
            "-c",
            "fsync=off",
        )
        PHASE = "owned-postgresql-ready"
        for _ in range(60):
            if (
                docker(
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
                ).returncode
                == 0
            ):
                break
            time.sleep(0.5)
        else:
            raise AssertionError("consume PostgreSQL readiness refused")
        db = inspect(database)
        owned(db, "container")
        serving.resources(db, 768 * 1024**2)
        db_port = serving.published_port(db, "5432/tcp")
        PHASE = "actual-scoped-postgresql-fixture"
        world = operator_fixture(db_port)
        privacy = secret_material(world)
        trust = world["trust"]
        with psycopg.connect(
            host="127.0.0.1",
            port=db_port,
            dbname="kodera_server",
            user="kodera",
            password="kodera",  # noqa: S106 - disposable synthetic database
            autocommit=True,
        ) as admin:
            with admin.cursor() as cursor:
                role = "synthetic_consume_http"
                install_consume_role(cursor, role, "kodera_server", PASSWORD)
                role_proof = assert_consume_role_policy(cursor, role, "kodera_server")
                proof["column_role_policy"] = True
                print(
                    json.dumps(
                        {
                            "consume_column_role": "passed",
                            "inherited_public_trigger_execute": role_proof[
                                "public_trigger_execute"
                            ],
                            "identity_membership_binding_id_lock_columns": True,
                        }
                    ),
                    flush=True,
                )
                PHASE = "actual-image-build"
                docker("build", "--label", f"{LABEL}={OWNER}", "-t", image, ".", timeout=600)
                PHASE = "actual-image-start"
                docker(
                    "run",
                    "-d",
                    "--name",
                    api,
                    "--label",
                    f"{LABEL}={OWNER}",
                    "--network",
                    network,
                    *serving.caps(512 * 1024**2),
                    "--read-only",
                    "--tmpfs",
                    "/tmp:rw,size=16777216,uid=10001,gid=10001",  # noqa: S108 - bounded owned container tmpfs
                    "-p",
                    "127.0.0.1::8000",
                    "-e",
                    f"DJANGO_SECRET_KEY={serving.SECRET}",
                    "-e",
                    "DJANGO_ALLOWED_HOSTS=api.synthetic.test",
                    "-e",
                    f"DATABASE_URL=postgresql://{role}:{PASSWORD}@db/kodera_server",
                    "-e",
                    f"KODERA_AUTH_TRUST={trust}",
                    "-e",
                    f"KODERA_STAFF_ISSUER={STAFF_ISSUER}",
                    "-e",
                    "KODERA_CONSOLE_CLIENT_ID=synthetic-console",
                    image,
                )  # noqa: S108 - bounded owned container tmpfs
                details = inspect(api)
                owned(details, "container")
                serving.resources(details, 512 * 1024**2)
                require(
                    details["Config"]["User"] == "10001:10001"
                    and details["HostConfig"]["ReadonlyRootfs"],
                    "consume process boundary refused",
                )
                serving.production_command(details["Config"]["Cmd"])
                port = serving.published_port(details, "8000/tcp")
                PHASE = "actual-image-readiness"
                serving.wait_ready(port)
                PHASE = "actual-image-boundary"
                import inspect as source_inspection

                probe = (
                    source_inspection.getsource(require)
                    + "\nIMAGE_REQUIRED="
                    + repr(IMAGE_REQUIRED)
                    + "\n"
                    + source_inspection.getsource(image_source_boundary)
                    + "\nimport pathlib,os; assert os.getuid()==10001; assert len(pathlib.Path('/proc/1/task/1/children').read_text().split())==2; assert b'gunicorn' in pathlib.Path('/proc/1/cmdline').read_bytes(); image_source_boundary('/app')"
                )
                docker("exec", api, "python", "-c", probe)
                proof["actual_image_boundary"] = True
                PHASE = "consume-live-and-host"
                require(
                    serving.request(port, "/health/live")[0] == 200
                    and serving.request(port, "/health/live", host="unknown.synthetic.test")[0]
                    == 400,
                    "consume HTTP profile refused",
                )

                def checked(
                    case, status, *, key="consume-image-key-001", facts="credential", payload=None
                ):
                    record = world["cases"][case]
                    result, raw, headers = post(
                        port,
                        {"token": record["token"]} if payload is None else payload,
                        record[facts],
                        key,
                    )
                    public_bytes(raw, privacy)
                    require(
                        result == status and headers.get("Cache-Control") == "no-store",
                        "consume HTTP predicate refused",
                    )
                    return raw, headers

                def effects(case):
                    record = world["cases"][case]
                    cursor.execute(
                        "SELECT c.state,c.consumed_at,c.consumed_by_identity_id,c.membership_id,m.role,m.state,m.accepted_at,o.state,r.state,r.protected_at FROM orgs_ownerclaim c JOIN orgs_membership m ON m.id=c.membership_id JOIN orgs_organisation o ON o.id=c.organisation_id JOIN orgs_slugreservation r ON r.organisation_id=o.id WHERE c.id=%s",
                        [record["claim_id"]],
                    )
                    row = cursor.fetchone()
                    require(
                        row is not None
                        and row[0] == "consumed"
                        and row[1] is not None
                        and str(row[2]) == record["identity_id"]
                        and row[4:6] == ("org_owner", "active")
                        and row[6] is not None
                        and row[7:9] == ("active", "permanent")
                        and row[9] is not None,
                        "consume atomic effects refused",
                    )
                    for action in (
                        "owner_claim.consumed",
                        "membership.created",
                        "organisation.activated",
                    ):
                        cursor.execute(
                            "SELECT count(*) FROM audit_auditevent WHERE organisation_id=%s AND action=%s",
                            [record["organisation_id"], action],
                        )
                        require(cursor.fetchone()[0] == 1, "consume ratified audit missing")

                PHASE = "consume-atomic-success"
                cursor.execute(
                    "SELECT (SELECT count(*) FROM identity_user),(SELECT count(*) FROM identity_identity),(SELECT count(*) FROM jobs_job),(SELECT count(*) FROM outbox_message),(SELECT count(*) FROM orgs_ownerbinding)"
                )
                unchanged_counts = cursor.fetchone()
                body, _ = checked("success", 200)
                effects("success")
                record = world["cases"]["success"]
                cursor.execute(
                    "SELECT body FROM idempotency_record WHERE issuer=%s AND path=%s",
                    ["https://identity.synthetic.test/realms/consume-success", PATH],
                )
                require(bytes(cursor.fetchone()[0]) == body, "consume receipt body refused")
                proof["atomic_success"] = True
                PHASE = "consume-profile"
                profile = world["cases"]["profile"]
                checked(
                    "profile",
                    200,
                    payload={
                        "token": profile["token"],
                        "display_name": "  Synthetic own profile  ",
                    },
                )
                cursor.execute(
                    "SELECT display_name FROM identity_user WHERE id=%s", [profile["user_id"]]
                )
                require(
                    cursor.fetchone() == ("  Synthetic own profile  ",),
                    "consume own profile refused",
                )
                effects("profile")

                PHASE = "consume-replay-and-current-withdrawal"
                replay, _ = checked("success", 200)
                require(replay == body, "consume cached body changed")
                cursor.execute(
                    "SELECT body,created_at,body_sha256 FROM idempotency_record WHERE issuer=%s AND path=%s",
                    ["https://identity.synthetic.test/realms/consume-success", PATH],
                )
                receipt = cursor.fetchone()
                cursor.execute(
                    "UPDATE identity_user SET enabled=false WHERE id=%s", [record["user_id"]]
                )
                checked("success", 403)
                cursor.execute(
                    "SELECT body,created_at,body_sha256 FROM idempotency_record WHERE issuer=%s AND path=%s",
                    ["https://identity.synthetic.test/realms/consume-success", PATH],
                )
                require(cursor.fetchone() == receipt, "consume denial mutated old receipt")
                cursor.execute(
                    "UPDATE identity_user SET enabled=true WHERE id=%s", [record["user_id"]]
                )
                require(checked("success", 200)[0] == body, "consume receipt recovery refused")
                checked("success", 409, key="consume-new-consumed-key")
                proof["replay_and_withdrawal"] = True

                PHASE = "consume-contact-mfa-and-new-key"
                for case, fact in (("contact", "contact_credential"), ("mfa", "mfa_credential")):
                    denied, _ = checked(case, 403, facts=fact)
                    require(
                        checked(case, 403)[0] == denied, "consume eligible negative replay changed"
                    )
                    checked(case, 200, key="consume-new-approved-key")
                    effects(case)
                proof["denials_and_new_key"] = True
                PHASE = "consume-ordered-signature-and-token-refusals"
                wrong = world["cases"]["busy"]
                payload = {
                    "token": wrong["token"][:-2]
                    + ("A" if wrong["token"][-2] != "A" else "B")
                    + wrong["token"][-1]
                }
                checked("busy", 404, facts="contact_credential", payload=payload)
                checked(
                    "busy", 404, key="consume-cross-org-key", payload={"token": record["token"]}
                )
                status, raw, _ = post(port, {"unexpected": "synthetic"}, None, "!")
                public_bytes(raw, privacy)
                require(status == 401, "consume anonymous precedence refused")
                status, raw, headers = post(port, {}, wrong["unknown_credential"], "!")
                public_bytes(raw, privacy)
                require(
                    status == 403
                    and json.loads(raw).get("type") == "https://kodera.io/problems/identity-unknown"
                    and not any(name.lower() == "www-authenticate" for name in headers),
                    "consume unknown-principal precedence refused",
                )
                status, raw, _ = post(
                    port,
                    {"token": wrong["token"]},
                    world["staff_token"],
                    "consume-staff-refused-key",
                )
                public_bytes(raw, privacy)
                require(status == 403, "consume staff refusal failed")
                proof["ordered_refusals"] = True

                PHASE = "consume-verified-claim-nowait"
                busy = world["cases"]["busy"]
                with psycopg.connect(admin.info.dsn, password=admin.info.password) as holder:
                    with holder.cursor() as lock_cursor:
                        lock_cursor.execute(
                            "SELECT id FROM orgs_ownerclaim WHERE id=%s FOR UPDATE",
                            [busy["claim_id"]],
                        )
                        require(lock_cursor.fetchone() is not None, "consume held claim absent")
                        incorrect = (
                            busy["token"][:-2]
                            + ("A" if busy["token"][-2] != "A" else "B")
                            + busy["token"][-1]
                        )
                        checked(
                            "busy",
                            404,
                            key="consume-unverified-busy-key",
                            payload={"token": incorrect},
                        )
                        _, headers = checked("busy", 503, key="consume-verified-busy-key")
                        require(
                            headers.get("Retry-After") == "1", "consume transient retry refused"
                        )
                        cursor.execute(
                            "SELECT count(*) FROM idempotency_record WHERE issuer=%s AND status=503",
                            ["https://identity.synthetic.test/realms/consume-busy"],
                        )
                        require(cursor.fetchone() == (0,), "consume transient receipt stored")
                    holder.rollback()
                checked("busy", 200, key="consume-verified-busy-key")
                effects("busy")
                proof["claim_nowait"] = True

                PHASE = "consume-required-audit-rollback"
                columns = sql.SQL(",").join(
                    map(sql.Identifier, CONSUME_INSERT_COLUMNS["audit_auditevent"])
                )
                cursor.execute(
                    sql.SQL("REVOKE INSERT ({}) ON audit_auditevent FROM {}").format(
                        columns, sql.Identifier(role)
                    )
                )
                try:
                    rollback = world["cases"]["rollback"]
                    checked(
                        "rollback",
                        500,
                        payload={"token": rollback["token"], "display_name": "must-roll-back"},
                    )
                    cursor.execute(
                        "SELECT c.state,u.display_name FROM orgs_ownerclaim c JOIN identity_identity i ON i.id=c.intended_identity_id JOIN identity_user u ON u.id=i.user_id WHERE c.id=%s",
                        [rollback["claim_id"]],
                    )
                    require(
                        cursor.fetchone() == ("issued", None),
                        "consume required audit failed rollback",
                    )
                    cursor.execute(
                        "SELECT count(*) FROM idempotency_record WHERE issuer=%s",
                        ["https://identity.synthetic.test/realms/consume-rollback"],
                    )
                    require(cursor.fetchone() == (0,), "consume failed audit receipt persisted")
                finally:
                    cursor.execute(
                        sql.SQL("GRANT INSERT ({}) ON audit_auditevent TO {}").format(
                            columns, sql.Identifier(role)
                        )
                    )
                assert_consume_role_policy(cursor, role, "kodera_server")
                checked("rollback", 200, key="consume-image-key-001")
                effects("rollback")
                proof["audit_rollback"] = True
                PHASE = "consume-actual-clock-expiry"
                checked("past", 410)
                cursor.execute(
                    "SELECT state,revoked_at IS NOT NULL FROM orgs_ownerclaim WHERE id=%s",
                    [world["cases"]["past"]["claim_id"]],
                )
                require(cursor.fetchone() == ("expired", True), "consume database expiry refused")
                cursor.execute(
                    "SELECT count(*) FROM audit_auditevent WHERE organisation_id=%s AND action='owner_claim.expired' AND actor_type='system' AND actor_id IS NULL",
                    [world["cases"]["past"]["organisation_id"]],
                )
                require(cursor.fetchone() == (1,), "consume expiry audit refused")
                proof["clock_expiry"] = True
                PHASE = "consume-no-new-operator-effects-and-privacy"
                cursor.execute(
                    "SELECT (SELECT count(*) FROM identity_user),(SELECT count(*) FROM identity_identity),(SELECT count(*) FROM jobs_job),(SELECT count(*) FROM outbox_message),(SELECT count(*) FROM orgs_ownerbinding)"
                )
                require(cursor.fetchone() == unchanged_counts, "consume added operator effects")
                cursor.execute("SELECT row_to_json(a)::text FROM audit_auditevent a")
                public_bytes(json.dumps(cursor.fetchall(), default=str).encode(), privacy)
                cursor.execute("SELECT row_to_json(r)::text FROM idempotency_record r")
                public_bytes(json.dumps(cursor.fetchall(), default=str).encode(), privacy)
                owned(inspect(api), "container")
                logs = docker("logs", "--tail", "1000", api)
                require(
                    len((logs.stdout + logs.stderr).splitlines()) < 1000,
                    "consume log capture truncated",
                )
                public_bytes(
                    (logs.stdout + logs.stderr).encode(),
                    (
                        *privacy,
                        PASSWORD,
                        serving.SECRET,
                        world["staff_token"],
                        *(
                            value
                            for case in world["cases"].values()
                            for name, value in case.items()
                            if name.endswith("credential")
                        ),
                    ),
                )
                proof["privacy"] = True
                PHASE = "consume-shutdown"
                docker("stop", "--time", "15", api)
                state = inspect(api)
                owned(state, "container")
                require(
                    not state["State"]["Running"] and state["State"]["ExitCode"] == 0,
                    "consume shutdown refused",
                )
                proof["bounded_shutdown"] = True
    finally:
        failure_phase = PHASE
        PHASE = "owned-cleanup"
        for reference in (api, database):
            remove("container", reference)
        remove("image", image)
        remove("network", network)
        require(serving.source_hashes() == frozen, "consume tracked source changed")
        baseline_sources()
        print(json.dumps({"consume_owned_cleanup": "passed"}), flush=True)
        PHASE = failure_phase
    required = {
        "column_role_policy",
        "actual_image_boundary",
        "atomic_success",
        "replay_and_withdrawal",
        "denials_and_new_key",
        "ordered_refusals",
        "claim_nowait",
        "audit_rollback",
        "clock_expiry",
        "privacy",
        "bounded_shutdown",
    }
    require(set(proof) == required and all(proof.values()), "consume qualification incomplete")
    print(
        json.dumps(
            {
                "consume_http": "passed",
                "proof": proof,
                "user_enabled_update_value_unrestricted": True,
                "cross_organisation_revision_fanout": True,
                "provider_login_qualified": False,
                "live_iam_qualified": False,
            }
        ),
        flush=True,
    )


SCOPED_CASES = {
    "test_actual_scoped_role_success_and_executed_insert_shapes": "atomic-effects",
    "test_actual_scoped_denial_receipt_requires_new_key": "negative-replay",
    "test_actual_scoped_replay_withdrawal_preserves_receipt": "current-authority",
    "test_actual_sequence_kind_policy_and_privilege_refusal": "sequence-policy",
    "test_actual_nonadmitted_column_write_refuses": "semantic-columns",
    "test_actual_granted_lock_id_storage_refusal": "lock-id",
    "test_actual_enabled_privilege_is_value_unrestricted": "enabled-privilege",
    "test_actual_column_grant_omission_rolls_back_without_widening": "missing-grant",
    "test_actual_catalog_paired_column_widening_refuses": "paired-ledger",
    "test_actual_delete_table_and_security_definer_widening_refuse": "delete-function-policy",
    "test_actual_retained_organisation_fanout_and_rollback": "retained-fanout",
    "test_actual_scoped_replay_holds_through_cached_materialization": "held-replay",
    "test_actual_scoped_database_clock_expiry_is_single_and_audited": "clock-expiry",
    "test_actual_scoped_staff_and_unknown_customer_have_no_consume_capability": "principal-refusal",
    "test_actual_replay_guard_omission_mutation_releases_forbidden_cached_bytes": "guard-omission",
}
SCOPED_CASE_COUNTS = {
    "test_actual_scoped_role_success_and_executed_insert_shapes": 1,
    "test_actual_scoped_denial_receipt_requires_new_key": 2,
    "test_actual_scoped_replay_withdrawal_preserves_receipt": 1,
    "test_actual_sequence_kind_policy_and_privilege_refusal": 6,
    "test_actual_nonadmitted_column_write_refuses": 5,
    "test_actual_granted_lock_id_storage_refusal": 3,
    "test_actual_enabled_privilege_is_value_unrestricted": 1,
    "test_actual_column_grant_omission_rolls_back_without_widening": 1,
    "test_actual_catalog_paired_column_widening_refuses": 3,
    "test_actual_delete_table_and_security_definer_widening_refuse": 1,
    "test_actual_retained_organisation_fanout_and_rollback": 1,
    "test_actual_scoped_replay_holds_through_cached_materialization": 3,
    "test_actual_scoped_database_clock_expiry_is_single_and_audited": 1,
    "test_actual_scoped_staff_and_unknown_customer_have_no_consume_capability": 1,
    "test_actual_replay_guard_omission_mutation_releases_forbidden_cached_bytes": 1,
}
SQLSTATES = frozenset(
    {"23514", "23505", "23503", "23502", "42501", "42809", "55P03", "40P01", "40001", "unknown"}
)


def closed_diagnostics(rows):
    require(isinstance(rows, list) and 0 < len(rows) <= 128, "consume diagnostic bounds refused")
    choices = {
        "case": set(SCOPED_CASES.values()) | {"unknown"},
        "stage": {"setup", "call", "teardown", "unknown"},
        "category": {"unexpected", "assertion", "database"},
        "sqlstate": SQLSTATES,
        "constraint": bootstrap.KNOWN_DIAGNOSTIC_CONSTRAINTS | {"unknown"},
    }
    for row in rows:
        require(
            isinstance(row, dict)
            and set(row) == set(choices)
            and all(
                type(row[name]) is str and row[name] in allowed for name, allowed in choices.items()
            ),
            "consume diagnostic fields refused",
        )
    return rows


def postgresql_plugin():
    import pytest

    class ClosedProof:
        def __init__(self):
            self.failures = []
            self.collected = set()
            self.passed = set()

        def pytest_collection_modifyitems(self, items):
            counts = {}
            for item in items:
                name = item.nodeid.split("::")[-1].split("[")[0]
                counts[name] = counts.get(name, 0) + 1
            require(counts == SCOPED_CASE_COUNTS, "consume scoped case inventory refused")
            self.collected = {item.nodeid for item in items}

        def complete(self):
            return bool(self.collected) and self.passed == self.collected and not self.failures

        @pytest.hookimpl(tryfirst=True)
        def pytest_runtest_makereport(self, item, call):
            if call.excinfo is None:
                if call.when == "call":
                    self.passed.add(item.nodeid)
                return
            name = item.nodeid.split("::")[-1].split("[")[0]
            fact = {
                "case": SCOPED_CASES.get(name, "unknown"),
                "stage": call.when if call.when in {"setup", "call", "teardown"} else "unknown",
                "category": "unexpected",
                "sqlstate": "unknown",
                "constraint": "unknown",
            }
            error = call.excinfo.value
            for _ in range(8):
                if error is None:
                    break
                state = getattr(error, "sqlstate", None)
                if state in SQLSTATES - {"unknown"}:
                    fact["category"], fact["sqlstate"] = "database", state
                    constraint = getattr(getattr(error, "diag", None), "constraint_name", None)
                    if (
                        type(constraint) is str
                        and constraint in bootstrap.KNOWN_DIAGNOSTIC_CONSTRAINTS
                    ):
                        fact["constraint"] = constraint
                    break
                if isinstance(error, AssertionError):
                    fact["category"] = "assertion"
                error = error.__cause__
            self.failures.append(fact)

    return ClosedProof()


def operator_fixture(port):
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.job_queue",
        "DATABASE_URL": f"postgresql://kodera:kodera@127.0.0.1:{port}/kodera_server",
    }
    serving.command(
        [sys.executable, "manage.py", "migrate", "--noinput"], environment=environment, timeout=120
    )
    program = """
import json,pytest
from dev.accept_owner_claim_consume_http import postgresql_plugin
proof=postgresql_plugin()
status=pytest.main(['tests/test_owner_claim_consume_fixture.py','--override-ini','addopts=','-p','no:randomly','-q'],plugins=[proof])
if not proof.complete():
 status=1
if proof.failures:
 print('KODERA_CONSUME_DIAGNOSTIC '+json.dumps(proof.failures))
raise SystemExit(status)
"""
    result = serving.command(
        [sys.executable, "-c", program],
        check=False,
        environment={**environment, "DJANGO_SETTINGS_MODULE": "config.settings.test"},
        timeout=180,
    )
    if result.returncode:
        lines = [
            line
            for line in result.stdout.splitlines()
            if line.startswith("KODERA_CONSUME_DIAGNOSTIC ")
        ]
        require(len(lines) <= 1, "consume diagnostic bounds refused")
        if lines:
            require(len(lines[0]) <= 32768, "consume diagnostic bounds refused")
            try:
                facts = closed_diagnostics(
                    json.loads(lines[0].removeprefix("KODERA_CONSUME_DIAGNOSTIC "))
                )
            except (ValueError, TypeError) as error:
                raise AssertionError("consume diagnostic fields refused") from error
            print(json.dumps({"consume_scoped_postgresql_failures": facts}), flush=True)
        raise AssertionError("actual scoped consume PostgreSQL refused")
    print(json.dumps({"consume_scoped_postgresql_cases": "passed"}), flush=True)
    program = "import django,json; django.setup(); from dev.accept_owner_claim_consume_http import seed_consume_fixture; print(json.dumps(seed_consume_fixture()))"
    return json.loads(
        serving.command([sys.executable, "-c", program], environment=environment, timeout=60).stdout
    )


def failure_category(error):
    for error_type, category in (
        (subprocess.TimeoutExpired, "timeout"),
        (subprocess.CalledProcessError, "command"),
        (AssertionError, "predicate"),
        (OSError, "os"),
    ):
        if issubclass(type(error), error_type):
            return category
    return "unclassified"


def safe_failure_phase(value):
    return value if type(value) is str and value in FAILURE_PHASES else "unclassified"


def main():
    try:
        qualify_consume_http()
    except Exception as error:
        print(
            f"Consume qualification refused during {safe_failure_phase(PHASE)} "
            f"({failure_category(error)}); no captured values emitted",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
