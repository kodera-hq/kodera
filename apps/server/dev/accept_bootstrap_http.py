#!/usr/bin/env python3
"""Hosted bootstrap image proof with a separate measured synthetic column role.

Operator preparation stays outside the image. This qualifies neither provider login
nor live database/IAM privileges. The retained production reader remains unchanged.
"""

import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Direct script execution has dev/ on sys.path, so load the fixed sibling helper explicitly.
_helper_spec = importlib.util.spec_from_file_location(
    "production_serving_helper", ROOT / "dev/accept_production_http.py"
)
if _helper_spec is None or _helper_spec.loader is None:
    raise RuntimeError("production helper unavailable")
serving = importlib.util.module_from_spec(_helper_spec)
_helper_spec.loader.exec_module(serving)
LABEL = "kodera.bootstrap-qualification"
OWNER = "bootstrap-http-" + uuid.uuid4().hex[:12]
STAFF_ISSUER = "https://identity.staff.synthetic.test/realms/kodera-staff"
PASSWORD = "synthetic-bootstrap-only"  # noqa: S105 - disposable fixture credential
PRIVATE = ("synthetic-unsealed-contact", "synthetic-sealed-payload", "synthetic-claim-secret")
PHASE = "admission"
BASELINE_SHA256 = "87ded33470693974d4ed71988f6d9c0b9677175976f539549abaff545d21876c"

BOOTSTRAP_SELECT_COLUMNS = {
    "identity_user": ("id", "enabled", "deleted_at"),
    "identity_identity": (
        "id",
        "user_id",
        "organisation_id",
        "issuer",
        "subject",
        "enabled",
        "deleted_at",
        "realm",
    ),
    "identity_staffrole": ("id", "identity_id", "role", "revoked_at"),
    "orgs_organisation": ("id", "slug", "state", "realm", "updated_at", "issuer", "deleted_at"),
    "orgs_organisationintake": (
        "id",
        "organisation_id",
        "instruction_ref",
        "created_at",
        "intended_owner_email_masked",
        "bootstrap_job_id",
    ),
    "orgs_ownerbinding": ("id", "organisation_id", "identity_id", "issuer", "recorded_at"),
    "orgs_ownerclaim": (
        "id",
        "organisation_id",
        "state",
        "issued_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "membership_id",
    ),
    "orgs_realmreadiness": ("organisation_id", "job_id", "issuer", "realm", "revoked_at"),
    "jobs_job": ("id", "status", "organisation_id", "kind", "created_at"),
    "audit_auditevent": ("occurred_at", "metadata"),
}
BOOTSTRAP_UPDATE_COLUMNS = {
    "identity_user": ("id",),
    "identity_identity": ("id",),
    "identity_staffrole": ("id",),
    "orgs_ownerclaim": ("state", "revoked_at"),
}
BOOTSTRAP_INSERT_COLUMNS = {
    "audit_auditevent": (
        "id",
        "occurred_at",
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
    )
}

# Independent reviewed catalog ledger: never derive it from mutable installer grants.
ROLE_POLICY_SELECT = {
    "identity_user": ("id", "enabled", "deleted_at"),
    "identity_identity": (
        "id",
        "user_id",
        "organisation_id",
        "issuer",
        "subject",
        "enabled",
        "deleted_at",
        "realm",
    ),
    "identity_staffrole": ("id", "identity_id", "role", "revoked_at"),
    "orgs_organisation": ("id", "slug", "state", "realm", "updated_at", "issuer", "deleted_at"),
    "orgs_organisationintake": (
        "id",
        "organisation_id",
        "instruction_ref",
        "created_at",
        "intended_owner_email_masked",
        "bootstrap_job_id",
    ),
    "orgs_ownerbinding": ("id", "organisation_id", "identity_id", "issuer", "recorded_at"),
    "orgs_ownerclaim": (
        "id",
        "organisation_id",
        "state",
        "issued_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "membership_id",
    ),
    "orgs_realmreadiness": ("organisation_id", "job_id", "issuer", "realm", "revoked_at"),
    "jobs_job": ("id", "status", "organisation_id", "kind", "created_at"),
    "audit_auditevent": ("occurred_at", "metadata"),
}
ROLE_POLICY_UPDATE = {
    "identity_user": ("id",),
    "identity_identity": ("id",),
    "identity_staffrole": ("id",),
    "orgs_ownerclaim": ("state", "revoked_at"),
}
ROLE_POLICY_INSERT = {
    "audit_auditevent": (
        "id",
        "occurred_at",
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
    )
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


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
    return result


def bootstrap_policy(details):
    expected = expected_policy()
    require(
        isinstance(details, dict) and set(details) == set(expected), "bootstrap role policy refused"
    )
    for name, value in expected.items():
        if type(value) is bool:
            require(
                type(details[name]) is bool and details[name] is True,
                "bootstrap role policy refused",
            )
        else:
            require(details[name] == value, "bootstrap role policy refused")


def install_bootstrap_role(cursor, role_name, database_name, password):
    from psycopg import sql

    require(
        re.fullmatch(r"synthetic_bootstrap_[a-z0-9]{1,24}", role_name) is not None,
        "bootstrap role name refused",
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
        ("SELECT", BOOTSTRAP_SELECT_COLUMNS),
        ("UPDATE", BOOTSTRAP_UPDATE_COLUMNS),
        ("INSERT", BOOTSTRAP_INSERT_COLUMNS),
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


def assert_bootstrap_role_policy(cursor, role_name, database_name):
    cursor.execute(
        "SELECT oid, NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=%s",
        [role_name],
    )
    row = cursor.fetchone()
    require(row is not None, "bootstrap role policy refused")
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
        "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(%s,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))",
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
    bootstrap_policy(proof)
    return proof


def claim_proof(before, after, events_before, events_after):
    require(before == after and events_before == events_after, "bootstrap claim proof refused")


def public_bytes(raw, secrets):
    require(
        all(secret.encode() not in raw for secret in secrets), "bootstrap private material refused"
    )


def private_material(world):
    import base64

    details = world.get("_privacy")
    require(
        isinstance(details, dict)
        and set(details) == {"raw_contacts", "sealed_contacts", "verifiers"},
        "bootstrap seed privacy refused",
    )
    values = list(PRIVATE)
    for name in ("raw_contacts", "sealed_contacts", "verifiers"):
        entries = details[name]
        require(
            isinstance(entries, list)
            and entries
            and all(isinstance(value, str) and value for value in entries),
            "bootstrap seed privacy refused",
        )
        values.extend(entries)
    for value in tuple(values):
        values.extend((value.encode().hex(), base64.b64encode(value.encode()).decode()))
    return tuple(set(values))


def seed_bootstrap_fixture():
    """One actual atomic operator seed; no provider, SMTP, intake or claim command invocation."""
    from datetime import timedelta

    from argon2 import PasswordHasher
    from argon2.profiles import RFC_9106_LOW_MEMORY
    from django.db import transaction
    from django.utils import timezone

    from apps.audit.services import record_owner_event
    from apps.identity.models import Identity, StaffRole, User
    from apps.jobs.models import Job
    from apps.orgs.models import (
        Membership,
        Organisation,
        OrganisationIntake,
        OwnerBinding,
        OwnerClaim,
        RealmReadiness,
        SlugReservation,
    )

    with transaction.atomic():
        now = timezone.now()
        staff = {}
        world = {}
        for name, role in (
            ("recorder", "staff_operator"),
            ("operator", "staff_operator"),
            ("support", "staff_support"),
            ("security", "staff_security"),
            ("revoked", "staff_operator"),
            ("disabled", "staff_operator"),
        ):
            user = User.objects.create(
                email=name + "@staff.synthetic.test", enabled=name != "disabled"
            )
            identity = Identity.objects.create(
                user=user,
                issuer=STAFF_ISSUER,
                realm="kodera-staff",
                subject="synthetic-" + name,
                email=user.email,
            )
            grant = StaffRole.objects.create(identity=identity, role=role)
            if name == "revoked":
                grant.revoked_at = timezone.now()
                grant.save(update_fields=["revoked_at"])
            staff[name] = identity
            world[name + "_identity_id"] = str(identity.id)
            world[name + "_grant_id"] = str(grant.id)
        verifier = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY).hash(PRIVATE[2]).encode()
        for state in ("future", "past", "expired", "revoked", "consumed"):
            slug = "boot-" + state
            issuer = "https://identity.synthetic.test/realms/" + slug
            org = Organisation.objects.create(
                slug=slug,
                realm=slug,
                issuer=issuer,
                name="Synthetic bootstrap",
                state="active" if state == "consumed" else "prospect",
            )
            SlugReservation.objects.create(
                organisation=org,
                slug=slug,
                state="permanent" if state == "consumed" else "provisional",
                protected_at=now if state == "consumed" else None,
            )
            user = User.objects.create(email="owner@" + slug + ".synthetic.test")
            identity = Identity.objects.create(
                user=user,
                organisation=org,
                issuer=issuer,
                realm=slug,
                subject="synthetic-owner",
                email=user.email,
            )
            job = Job.objects.create(
                organisation=org,
                kind="realm_create",
                idempotency_key=uuid.uuid4().hex * 2,
                desired_spec_hash="a" * 64,
                status="succeeded",
                max_attempts=1,
                actor_type="staff",
                actor_id=staff["recorder"].id,
                finished_at=now,
            )
            intake = OrganisationIntake.objects.create(
                organisation=org,
                recorded_by_identity=staff["recorder"],
                instruction_ref="SYN-100",
                sealed_contact=PRIVATE[1].encode(),
                intended_owner_email_masked="o***@synthetic.test",
                bootstrap_job_id=job.id,
            )
            OwnerBinding.objects.create(
                intake=intake,
                organisation=org,
                identity=identity,
                issuer=issuer,
                realm=slug,
                recorded_by_identity=staff["operator"],
            )
            RealmReadiness.objects.create(
                organisation=org,
                issuer=issuer,
                realm=slug,
                job_id=job.id,
                recorded_by_identity=staff["operator"],
            )
            old = state in {"past", "expired"}
            issued = now - timedelta(days=2) if old else now - timedelta(hours=1)
            expires = now - timedelta(days=1) if old else now + timedelta(days=1)
            claim = OwnerClaim.objects.create(
                organisation=org,
                intended_identity=identity,
                token_hash=verifier,
                issued_at=issued,
                expires_at=expires,
                delivery_id=uuid.uuid4(),
            )
            if state == "expired":
                claim.state = "expired"
                claim.revoked_at = now
                claim.save(update_fields=["state", "revoked_at"])
            elif state == "revoked":
                claim.state = "revoked"
                claim.revoked_at = now
                claim.revoked_by_identity = staff["operator"]
                claim.save(update_fields=["state", "revoked_at", "revoked_by_identity"])
            elif state == "consumed":
                member = Membership.objects.create(
                    user=user, organisation=org, role="org_owner", state="active", accepted_at=now
                )
                claim.state = "consumed"
                claim.consumed_at = now
                claim.consumed_by_identity = identity
                claim.membership = member
                claim.save(
                    update_fields=["state", "consumed_at", "consumed_by_identity", "membership"]
                )
            if state in {"expired", "revoked", "consumed"}:
                record_owner_event(
                    action="owner_claim.confirmed"
                    if state == "consumed"
                    else "owner_claim." + state,
                    organisation_id=org.id,
                    target_id=claim.id,
                    actor_id=None
                    if state == "expired"
                    else staff["recorder"].id
                    if state == "consumed"
                    else staff["operator"].id,
                    request_id="synthetic-terminal-" + state,
                    metadata={},
                )
            world[state] = {
                "organisation_id": str(org.id),
                "claim_id": str(claim.id),
                "customer_user_id": str(user.id),
                "customer_identity_id": str(identity.id),
                "issuer": issuer,
            }
        world["_privacy"] = {
            "raw_contacts": list(Identity.objects.values_list("email", flat=True)),
            "sealed_contacts": [
                bytes(value).decode()
                for value in OrganisationIntake.objects.values_list("sealed_contact", flat=True)
            ],
            "verifiers": [
                bytes(value).decode()
                for value in OwnerClaim.objects.values_list("token_hash", flat=True)
            ],
        }
    return world


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
        all(not (Path(root) / path).exists() for path in excluded)
        and (Path(root) / "apps/outbox").is_dir()
        and sorted(
            entry.name
            for entry in (Path(root) / "apps/outbox").iterdir()
            if entry.name != "__pycache__"
        )
        == ["__init__.py", "realm_enqueue.py"],
        "bootstrap image source boundary refused",
    )


def signatures():
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="synthetic-bootstrap-key", alg="RS256", use="sig", key_ops=["verify"])
    now = int(time.time())
    trust = []
    tokens = {}
    for name in (
        "future",
        "past",
        "expired",
        "revoked",
        "consumed",
        "operator",
        "support",
        "security",
        "revoked_staff",
        "disabled",
        "no_mfa",
        "unknown",
        "unknown_customer",
    ):
        customer = name in {"future", "past", "expired", "revoked", "consumed", "unknown_customer"}
        issuer = (
            "https://identity.synthetic.test/realms/boot-"
            + ("future" if name == "unknown_customer" else name)
            if customer
            else STAFF_ISSUER
        )
        if issuer not in {entry["issuer"] for entry in trust}:
            trust.append(
                {
                    "lane": "customer" if customer else "staff",
                    "issuer": issuer,
                    "generation": "synthetic-bootstrap-serving",
                    "expires_at": now + 1200,
                    "public_jwks": {"keys": [public]},
                }
            )
        subject = (
            "synthetic-unknown"
            if name == "unknown_customer"
            else "synthetic-owner"
            if customer
            else "synthetic-operator"
            if name == "no_mfa"
            else "synthetic-revoked"
            if name == "revoked_staff"
            else "synthetic-" + name
        )
        claims = {
            "iss": issuer,
            "sub": subject,
            "aud": "kodera-server",
            "iat": now,
            "exp": now + 900,
            "typ": "Bearer",
            # The web console's client: the customer lane admits only its allowed clients.
            "azp": "console",
        }
        if not customer and name != "no_mfa":
            claims["amr"] = ["pwd", "otp"]
        tokens[name] = jwt.encode(claims, key, algorithm="RS256", headers={"kid": public["kid"]})
    return json.dumps(trust), tokens


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


# Fixed names from current reviewed model/trigger constraints; arbitrary driver values stay private.
KNOWN_DIAGNOSTIC_CONSTRAINTS = frozenset(
    (
        "audit_auditevent_actor_type_valid",
        "audit_auditevent_immutable",
        "audit_auditevent_retention_class_valid",
        "category_binding_immutable",
        "category_id_workspace_unique",
        "category_name_valid",
        "category_position_unique",
        "category_position_valid",
        "category_template_key_unique",
        "category_template_key_valid",
        "category_version_valid",
        "channel_binding_immutable",
        "channel_delete_refused",
        "channel_kind_valid",
        "channel_lifecycle_valid",
        "channel_name_valid",
        "channel_policy_mode_valid",
        "channel_position_unique",
        "channel_position_valid",
        "channel_template_key_unique",
        "channel_template_key_valid",
        "channel_topic_valid",
        "channel_version_valid",
        "idempotency_record_body_bounded",
        "idempotency_record_digests_valid",
        "idempotency_record_method_post",
        "idempotency_record_scope_bounded",
        "idempotency_record_scope_unique",
        "idempotency_record_status_stored",
        "identity_delete_refused",
        "identity_deletion_valid",
        "identity_email_valid",
        "identity_immutable_binding",
        "identity_issuer_subject_unique",
        "identity_issuer_user_unique",
        "identity_realm_binding_unique",
        "identity_staff_issuer_valid",
        "identity_staff_realm_valid",
        "identity_subject_valid",
        "intake_bootstrap_job_unique",
        "intake_immutable",
        "intake_instruction_ref_valid",
        "intake_owner_masked_valid",
        "intake_recorder_staff_realm",
        "jobs_job_actor_type_valid",
        "jobs_job_delete_refused",
        "jobs_job_error_code_valid",
        "jobs_job_error_code_when_failed",
        "jobs_job_hashes_valid",
        "jobs_job_idempotency_key_unique",
        "jobs_job_kind_valid",
        "jobs_job_lease_while_claimed",
        "jobs_job_no_error_code_unless_failed",
        "jobs_job_no_lease_unless_claimed",
        "jobs_job_place_kept",
        "jobs_job_reconciliation_exit",
        "jobs_job_specification_immutable",
        "jobs_job_status_valid",
        "jobs_job_tenant_null_for_realm_kinds",
        "jobs_job_tenant_set_for_tenant_kinds",
        "jobs_job_unresolved_operation_when_reconciling",
        "jobs_job_unresolved_step_when_reconciling",
        "jobs_jobdispatch_close_once",
        "jobs_jobdispatch_terminal_outcome_valid",
        "jobs_joblockreservation_claim_unique",
        "jobs_joblockreservation_end_once",
        "jobs_joblockreservation_lock_class_valid",
        "jobs_joblockreservation_mode_valid",
        "jobs_jobreconciliationdecision_dispatch_outcome_valid",
        "jobs_jobreconciliationdecision_exit_valid",
        "jobs_jobreconciliationdecision_immutable",
        "jobs_jobreconciliationdecision_operation_outcome_valid",
        "jobs_jobreconciliationdecision_partial_only_fails",
        "jobs_jobreconciliationdecision_role_valid",
        "jobs_jobreconciliationdecision_valid",
        "jobs_jobstep_delete_refused",
        "jobs_jobstep_retry_class_valid",
        "jobs_jobstep_seq_unique",
        "jobs_jobstep_specification_immutable",
        "jobs_jobstep_status_valid",
        "membership_acceptance_valid",
        "membership_current_unique",
        "membership_deletion_valid",
        "membership_immutable_binding",
        "membership_role_valid",
        "membership_state_valid",
        "organisation_authority_revision_exhausted",
        "organisation_authority_revision_valid",
        "organisation_deletion_valid",
        "organisation_identity_binding_unique",
        "organisation_immutable_binding",
        "organisation_issuer_unique",
        "organisation_issuer_valid",
        "organisation_name_valid",
        "organisation_owner_required",
        "organisation_realm_not_staff",
        "organisation_realm_valid",
        "organisation_reservation_required",
        "organisation_slug_not_reserved",
        "organisation_slug_valid",
        "organisation_state_valid",
        "outbox_delivery_category_valid",
        "outbox_delivery_delete_refused",
        "outbox_delivery_frozen",
        "outbox_delivery_reconciliation_exit",
        "outbox_delivery_status_valid",
        "outbox_deliveryattempt_finished_with_outcome",
        "outbox_deliveryattempt_one_open",
        "outbox_deliveryattempt_outcome_once",
        "outbox_deliveryattempt_outcome_valid",
        "outbox_deliveryattempt_retained",
        "outbox_deliveryattempt_seq_unique",
        "outbox_deliverydecision_exit_valid",
        "outbox_deliverydecision_immutable",
        "outbox_deliverydecision_operation_outcome_valid",
        "outbox_deliverydecision_partial_only_fails",
        "outbox_deliverydecision_role_valid",
        "outbox_deliverydecision_valid",
        "outbox_message_link_valid",
        "outbox_message_locale_valid",
        "outbox_message_template_id_valid",
        "owner_binding_claim_key",
        "owner_binding_immutable",
        "owner_binding_recorder_staff_realm",
        "owner_binding_two_person",
        "owner_claim_consumed_membership_valid",
        "owner_claim_immutable",
        "owner_claim_initial_issued",
        "owner_claim_lifetime_valid",
        "owner_claim_one_issued",
        "owner_claim_revoker_staff_realm",
        "owner_claim_terminal_fields_valid",
        "owner_claim_transition_valid",
        "policy_binding_immutable",
        "policy_delete_refused",
        "policy_revision_exhausted",
        "policy_revision_valid",
        "policy_rule_binding_immutable",
        "policy_rule_capability_unique",
        "policy_rule_member_unique",
        "policy_rule_scope_valid",
        "policy_rule_shape_valid",
        "policy_visibility_valid",
        "realm_readiness_immutable",
        "realm_readiness_job_unique",
        "realm_readiness_recorder_staff_realm",
        "realm_readiness_revocation_valid",
        "reservation_delete_refused",
        "reservation_immutable_binding",
        "reservation_namespace_slug_unique",
        "reservation_namespace_valid",
        "reservation_protection_immutable",
        "reservation_protection_valid",
        "reservation_state_valid",
        "reservation_transition_valid",
        "staffrole_delete_refused",
        "staffrole_immutable_grant",
        "staffrole_one_current_grant",
        "staffrole_realm_valid",
        "staffrole_revocation_final",
        "staffrole_revocation_valid",
        "staffrole_role_valid",
        "user_deletion_valid",
        "user_display_name_valid",
        "user_email_valid",
        "workspace_binding_immutable",
        "workspace_organisation_unique",
        "workspace_revision_valid",
    )
)


SCOPED_CASES = {
    "test_actual_scoped_role_expiry_trigger_permission_experiment": "expiry-trigger",
    "test_actual_granted_lock_id_changes_refuse": "lock-id",
    "test_actual_semantic_authority_columns_deny": "semantic-columns",
    "test_actual_broad_grant_mutation_refuses": "broad-grant",
    "test_actual_audit_insert_denial_rolls_back_expiry": "audit-rollback",
    "test_actual_scoped_terminal_and_future_history_preserved": "terminal-history",
    "test_actual_executable_security_definer_mutation_refuses": "security-definer",
    "test_actual_scoped_staff_customer_authority": "current-authority",
    "test_actual_column_lock_permission_omission_refuses": "missing-lock",
    "test_actual_private_select_mutation_refuses": "private-select",
    "test_actual_seed_consumed_confirmation_names_staff_recorder": "confirmation-actor",
    "test_actual_paired_manifest_and_catalog_grant_widening_refuses": "paired-ledger",
}


def closed_postgresql_failure(nodeid, stage, error):
    name = nodeid.split("::")[-1].split("[")[0]
    result = {
        "case": SCOPED_CASES.get(name, "unknown"),
        "stage": stage if stage in {"setup", "call", "teardown"} else "unknown",
        "category": "unexpected",
        "sqlstate": "unknown",
        "constraint": "unknown",
    }
    for _ in range(8):
        if error is None:
            break
        state = getattr(error, "sqlstate", None)
        if isinstance(state, str) and state in {
            "23514",
            "23505",
            "23503",
            "42501",
            "55P03",
            "40P01",
            "40001",
        }:
            result["category"] = "database"
            result["sqlstate"] = state
            constraint = getattr(getattr(error, "diag", None), "constraint_name", None)
            if isinstance(constraint, str) and constraint in KNOWN_DIAGNOSTIC_CONSTRAINTS:
                result["constraint"] = constraint
            break
        if isinstance(error, AssertionError):
            result["category"] = "assertion"
        error = error.__cause__
    return result


def closed_diagnostics(rows):
    require(isinstance(rows, list) and 0 < len(rows) <= 93, "bootstrap diagnostic bounds refused")
    choices = {
        "case": set(SCOPED_CASES.values()) | {"unknown"},
        "stage": {"setup", "call", "teardown", "unknown"},
        "category": {"unexpected", "assertion", "database"},
        "sqlstate": {"23514", "23505", "23503", "42501", "55P03", "40P01", "40001", "unknown"},
        "constraint": KNOWN_DIAGNOSTIC_CONSTRAINTS | {"unknown"},
    }
    for row in rows:
        require(
            isinstance(row, dict)
            and set(row) == set(choices)
            and all(
                isinstance(row[key], str) and row[key] in values for key, values in choices.items()
            ),
            "bootstrap diagnostic fields refused",
        )
    return rows


def postgresql_plugin():
    import pytest

    class ClosedPostgresqlProof:
        def __init__(self):
            self.failures = []

        @pytest.hookimpl(tryfirst=True)
        def pytest_runtest_makereport(self, item, call):
            if call.excinfo is not None:
                self.failures.append(
                    closed_postgresql_failure(item.nodeid, call.when, call.excinfo.value)
                )

    return ClosedPostgresqlProof()


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
    # Execute real scoped permission tests before an expensive image build. No skip on failure.
    testing = {**environment, "DJANGO_SETTINGS_MODULE": "config.settings.test"}
    program = """
import json,pytest
from dev.accept_bootstrap_http import postgresql_plugin
proof=postgresql_plugin()
status=pytest.main(['tests/test_bootstrap_http_fixture.py','--override-ini','addopts=','-p','no:randomly','-q'],plugins=[proof])
if proof.failures:
 print('KODERA_BOOTSTRAP_DIAGNOSTIC '+json.dumps(proof.failures))
raise SystemExit(status)
"""
    result = serving.command(
        [sys.executable, "-c", program], check=False, environment=testing, timeout=180
    )
    if result.returncode:
        lines = [
            line
            for line in result.stdout.splitlines()
            if line.startswith("KODERA_BOOTSTRAP_DIAGNOSTIC ")
        ]
        require(len(lines) <= 1, "bootstrap diagnostic bounds refused")
        if lines:
            require(len(lines[0]) <= 32768, "bootstrap diagnostic bounds refused")
            try:
                facts = closed_diagnostics(
                    json.loads(lines[0].removeprefix("KODERA_BOOTSTRAP_DIAGNOSTIC "))
                )
            except (ValueError, TypeError) as error:
                raise AssertionError("bootstrap diagnostic fields refused") from error
            print(json.dumps({"scoped_postgresql_failures": facts}), flush=True)
        # Captured test output may contain SQL; expose only a fixed experiment outcome.
        print(
            json.dumps(
                {
                    "scoped_postgresql_cases": "refused",
                    "membership_permission_phrase": "permission denied for table orgs_membership"
                    in result.stdout + result.stderr,
                }
            ),
            flush=True,
        )
        raise AssertionError("actual scoped PostgreSQL cases refused")
    print(json.dumps({"scoped_postgresql_cases": "passed"}), flush=True)
    program = "import django,json; django.setup(); from dev.accept_bootstrap_http import seed_bootstrap_fixture; print(json.dumps(seed_bootstrap_fixture()))"
    return json.loads(
        serving.command([sys.executable, "-c", program], environment=environment, timeout=60).stdout
    )


def stored_claim(cursor, record):
    cursor.execute(
        "SELECT state,consumed_at,revoked_at,membership_id FROM orgs_ownerclaim WHERE id=%s",
        [record["claim_id"]],
    )
    row = cursor.fetchone()
    cursor.execute(
        "SELECT id FROM audit_auditevent WHERE organisation_id=%s ORDER BY id",
        [record["organisation_id"]],
    )
    return row, tuple(str(row[0]) for row in cursor.fetchall())


def request_proof(port, path, status, token=None, *, secrets=PRIVATE, kind=None):
    actual, body = serving.request(port, path, token=token)
    public_bytes(body, secrets)
    require(actual == status, "bootstrap HTTP predicate refused")
    if kind is not None:
        require(
            json.loads(body).get("type") == "https://kodera.io/problems/" + kind,
            "bootstrap HTTP problem type refused",
        )
    return json.loads(body) if actual == 200 else None


def authority_race(
    admin,
    cursor,
    port,
    path,
    token,
    statement,
    target,
    *,
    commit,
    expected,
    secrets=PRIVATE,
    kind=None,
):
    # The contender is a real HTTP request; prove PostgreSQL blocking before release.
    import psycopg

    with psycopg.connect(admin.info.dsn, password=admin.info.password) as blocker:
        blocker.execute(statement, [target])
        blocker_pid = blocker.info.backend_pid
        with ThreadPoolExecutor(max_workers=1) as executor:
            contender = executor.submit(serving.request, port, path, token=token)
            until = time.monotonic() + 3
            observed = False
            while time.monotonic() < until:
                cursor.execute(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE %s=ANY(pg_blocking_pids(a.pid)))",
                    [blocker_pid],
                )
                if cursor.fetchone()[0]:
                    observed = True
                    break
                time.sleep(0.01)
            if commit:
                blocker.commit()
            else:
                blocker.rollback()
            status, body = contender.result(timeout=6)
        require(observed, "bootstrap held authority was not observed")
        public_bytes(body, secrets)
        require(status == expected, "bootstrap held authority result refused")
        if kind is not None:
            require(
                json.loads(body).get("type") == "https://kodera.io/problems/" + kind,
                "bootstrap held authority problem type refused",
            )


def qualify_bootstrap_http():
    global PHASE
    from functools import partial

    import psycopg
    from psycopg import sql

    require(os.environ.get("GITHUB_ACTIONS") == "true", "hosted-only bootstrap qualification")
    PHASE = "hosted-reserve"
    serving.require_disk_reserve()
    require(
        hashlib.sha256((ROOT / "dev/accept_production_http.py").read_bytes()).hexdigest()
        == BASELINE_SHA256,
        "production baseline changed",
    )
    frozen = serving.source_hashes()
    network, database, api, image = (OWNER + suffix for suffix in ("-net", "-db", "-api", ":image"))
    proof = {}
    try:
        PHASE = "owned-network"
        docker("network", "create", "--label", f"{LABEL}={OWNER}", network)
        info = json.loads(docker("network", "inspect", network).stdout)[0]
        owned(info, "network")
        require(info.get("Internal") is False, "bootstrap topology refused")
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
            raise AssertionError("bootstrap PostgreSQL readiness refused")
        db = inspect(database)
        owned(db, "container")
        serving.resources(db, 768 * 1024**2)
        db_port = serving.published_port(db, "5432/tcp")
        PHASE = "actual-scoped-postgresql-fixture"
        world = operator_fixture(db_port)
        privacy = private_material(world)
        qualified_request = partial(request_proof, secrets=privacy)
        qualified_race = partial(authority_race, secrets=privacy)
        trust, tokens = signatures()
        with psycopg.connect(
            host="127.0.0.1",
            port=db_port,
            dbname="kodera_server",
            user="kodera",
            password="kodera",  # noqa: S106 - disposable synthetic database
            autocommit=True,
        ) as admin:
            with admin.cursor() as cursor:
                role = "synthetic_bootstrap_http"
                install_bootstrap_role(cursor, role, "kodera_server", PASSWORD)
                role_proof = assert_bootstrap_role_policy(cursor, role, "kodera_server")
                proof["column_role_policy"] = True
                print(
                    json.dumps(
                        {
                            "bootstrap_column_role": "passed",
                            "inherited_public_trigger_execute": role_proof[
                                "public_trigger_execute"
                            ],
                            "identity_grant_id_update_for_locks": True,
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
                    image,
                )  # noqa: S108 - bounded owned container tmpfs
                details = inspect(api)
                owned(details, "container")
                serving.resources(details, 512 * 1024**2)
                require(
                    details["Config"]["User"] == "10001:10001"
                    and details["HostConfig"]["ReadonlyRootfs"],
                    "bootstrap process boundary refused",
                )
                serving.production_command(details["Config"]["Cmd"])
                port = serving.published_port(details, "8000/tcp")
                PHASE = "actual-image-readiness"
                serving.wait_ready(port)
                PHASE = "actual-image-boundary"
                import inspect as source_inspection

                probe = (
                    source_inspection.getsource(require)
                    + source_inspection.getsource(image_source_boundary)
                    + "\nimport pathlib,os; assert os.getuid()==10001; assert len(pathlib.Path('/proc/1/task/1/children').read_text().split())==2; assert b'gunicorn' in pathlib.Path('/proc/1/cmdline').read_bytes(); image_source_boundary('/app')"
                )
                docker("exec", api, "python", "-c", probe)
                proof["actual_image_boundary"] = True

                def path(state):
                    return f"/api/v1/organisations/{world[state]['organisation_id']}/bootstrap"

                PHASE = "bootstrap-anonymous"
                qualified_request(port, path("future"), 401)
                PHASE = "bootstrap-customer-without-membership"
                cursor.execute(
                    "SELECT count(*) FROM orgs_membership WHERE organisation_id=%s",
                    [world["future"]["organisation_id"]],
                )
                require(cursor.fetchone()[0] == 0, "bootstrap customer unexpectedly has membership")
                body = qualified_request(port, path("future"), 200, tokens["future"])
                require(
                    body["claim"]["state"] == "issued"
                    and body["realm"]["state"] == "ready"
                    and body["identity_mapping"]["state"] == "ready",
                    "bootstrap public facts refused",
                )
                proof["customer_without_membership"] = True
                PHASE = "bootstrap-staff-current-mfa"
                for name in ("operator", "support"):
                    qualified_request(port, path("future"), 200, tokens[name])
                for name in ("no_mfa", "security", "revoked_staff", "disabled"):
                    qualified_request(port, path("future"), 403, tokens[name])
                qualified_request(port, path("future"), 403, tokens["unknown"])
                qualified_request(
                    port, path("future"), 403, tokens["unknown_customer"], kind="identity-unknown"
                )
                qualified_request(port, path("past"), 404, tokens["future"])
                proof["staff_mfa_current_grants_cross_org"] = True
                PHASE = "bootstrap-terminal-history"
                for state in ("future", "expired", "revoked", "consumed"):
                    before, events = stored_claim(cursor, world[state])
                    body = qualified_request(port, path(state), 200, tokens[state])
                    after, later = stored_claim(cursor, world[state])
                    claim_proof(before, after, events, later)
                    require(
                        body["claim"]["state"] == before[0], "bootstrap terminal wire state refused"
                    )
                proof["terminal_and_future_history"] = True
                PHASE = "bootstrap-audit-rollback"
                cols = sql.SQL(",").join(
                    map(sql.Identifier, BOOTSTRAP_INSERT_COLUMNS["audit_auditevent"])
                )
                cursor.execute(
                    sql.SQL("REVOKE INSERT ({}) ON audit_auditevent FROM {}").format(
                        cols, sql.Identifier(role)
                    )
                )
                qualified_request(port, path("past"), 500, tokens["past"])
                require(
                    stored_claim(cursor, world["past"])[0][0] == "issued",
                    "bootstrap failed audit did not roll back",
                )
                cursor.execute(
                    sql.SQL("GRANT INSERT ({}) ON audit_auditevent TO {}").format(
                        cols, sql.Identifier(role)
                    )
                )
                proof["audit_denial_rollback"] = True
                PHASE = "bootstrap-database-clock-concurrent-expiry"
                with ThreadPoolExecutor(max_workers=4) as executor:
                    responses = list(
                        executor.map(
                            lambda _: serving.request(port, path("past"), token=tokens["past"]),
                            range(4),
                        )
                    )
                for status, raw in responses:
                    public_bytes(raw, privacy)
                    require(
                        status == 200 and json.loads(raw)["claim"]["state"] == "expired",
                        "bootstrap concurrent expiry refused",
                    )
                cursor.execute(
                    "SELECT count(*) FROM audit_auditevent WHERE organisation_id=%s AND action='owner_claim.expired' AND actor_type='system' AND actor_id IS NULL",
                    [world["past"]["organisation_id"]],
                )
                require(cursor.fetchone()[0] == 1, "bootstrap expiry audit duplicated or missing")
                row, _ = stored_claim(cursor, world["past"])
                require(row[0] == "expired", "bootstrap expiry not stored")
                qualified_request(port, path("past"), 200, tokens["past"])
                cursor.execute(
                    "SELECT count(*) FROM audit_auditevent WHERE organisation_id=%s AND action='owner_claim.expired'",
                    [world["past"]["organisation_id"]],
                )
                require(cursor.fetchone()[0] == 1, "bootstrap repeat expiry duplicated")
                proof["actual_clock_single_concurrent_expiry"] = True
                PHASE = "bootstrap-held-customer-rollback"
                qualified_race(
                    admin,
                    cursor,
                    port,
                    path("future"),
                    tokens["future"],
                    "UPDATE identity_user SET enabled=false WHERE id=%s",
                    world["future"]["customer_user_id"],
                    commit=False,
                    expected=200,
                )
                PHASE = "bootstrap-held-staff-rollback"
                qualified_race(
                    admin,
                    cursor,
                    port,
                    path("future"),
                    tokens["support"],
                    "UPDATE identity_staffrole SET revoked_at=clock_timestamp() WHERE id=%s",
                    world["support_grant_id"],
                    commit=False,
                    expected=200,
                )
                PHASE = "bootstrap-held-staff-commit"
                qualified_race(
                    admin,
                    cursor,
                    port,
                    path("future"),
                    tokens["operator"],
                    "UPDATE identity_staffrole SET revoked_at=clock_timestamp() WHERE id=%s",
                    world["operator_grant_id"],
                    commit=True,
                    expected=403,
                )
                PHASE = "bootstrap-held-customer-commit"
                qualified_race(
                    admin,
                    cursor,
                    port,
                    path("future"),
                    tokens["future"],
                    "UPDATE identity_user SET enabled=false WHERE id=%s",
                    world["future"]["customer_user_id"],
                    commit=True,
                    expected=403,
                    kind="identity-unknown",
                )
                proof["actual_held_authority_commit_rollback"] = True
                PHASE = "bootstrap-no-new-onboarding-writes"
                cursor.execute("SELECT count(*) FROM orgs_ownerclaim")
                require(cursor.fetchone()[0] == 5, "bootstrap created another claim")
                cursor.execute("SELECT count(*) FROM orgs_membership")
                require(cursor.fetchone()[0] == 1, "bootstrap created membership")
                cursor.execute("SELECT count(*) FROM orgs_organisation WHERE state='active'")
                require(cursor.fetchone()[0] == 1, "bootstrap activated an organisation")
                cursor.execute("SELECT count(*) FROM outbox_message")
                require(cursor.fetchone()[0] == 0, "bootstrap enqueued delivery")
                proof["no_onboarding_or_delivery_writes"] = True
                PHASE = "bootstrap-log-privacy"
                owned(inspect(api), "container")
                logs = docker("logs", "--tail", "1000", api)
                require(
                    len((logs.stdout + logs.stderr).splitlines()) < 1000,
                    "bootstrap log privacy capture truncated",
                )
                public_bytes(
                    (logs.stdout + logs.stderr).encode(),
                    (*privacy, PASSWORD, serving.SECRET, *tokens.values()),
                )
                cursor.execute("SELECT row_to_json(a)::text FROM audit_auditevent a")
                public_bytes(json.dumps(cursor.fetchall(), default=str).encode(), privacy)
                proof["public_and_log_privacy"] = True
                PHASE = "bootstrap-shutdown"
                docker("stop", "--time", "15", api)
                info = inspect(api)
                owned(info, "container")
                require(
                    not info["State"]["Running"] and info["State"]["ExitCode"] == 0,
                    "bootstrap shutdown refused",
                )
                proof["bounded_shutdown"] = True
    finally:
        failure_phase = PHASE
        PHASE = "owned-cleanup"
        for reference in (api, database):
            remove("container", reference)
        remove("image", image)
        remove("network", network)
        require(serving.source_hashes() == frozen, "bootstrap tracked source changed")
        print(json.dumps({"bootstrap_owned_cleanup": "passed"}), flush=True)
        PHASE = failure_phase
    require(len(proof) == 11 and all(proof.values()), "bootstrap qualification incomplete")
    print(
        json.dumps(
            {
                "bootstrap_http": "passed",
                "proof": proof,
                "provider_login_qualified": False,
                "live_iam_qualified": False,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        qualify_bootstrap_http()
    except Exception:
        print("Bootstrap qualification refused during " + PHASE, file=sys.stderr)
        raise SystemExit(1) from None
