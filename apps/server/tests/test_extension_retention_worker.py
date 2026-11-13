"""Actual independent processing LOGIN: approved Core scope only, no owner/raw-DML expansion."""

from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest
from django.apps import apps
from django.db import connection
from psycopg import sql
from workspace_documents.test_services import native_engine as native_engine
from workspace_safety.test_moderation import world as world

from apps.extensions import imports, retention, services
from apps.extensions.models import (
    ErasureAdmission,
    ImportedObject,
    Installation,
    WorkspaceCutoff,
)

try:
    apps.get_model("orgs", "PrivacyErasure")
except LookupError:
    HAS_CORE = False
else:
    HAS_CORE = True

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def processing_login():
    name = "kodera_retention_worker_ext_" + uuid4().hex[:12]
    password = "synthetic-" + uuid4().hex
    config = connection.settings_dict
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        if HAS_CORE:
            from core.db.retention_worker_role import grant_statements

            statements = grant_statements(name, include_extensions=True)
        else:
            statements = [
                f'GRANT USAGE ON SCHEMA public TO "{name}"',
                f'GRANT EXECUTE ON FUNCTION public.extension_erasure_step(uuid,uuid,timestamptz,text,integer) TO "{name}"',
            ]
        for statement in statements:
            cursor.execute(statement)

    def connect():
        return psycopg.connect(
            host=config["HOST"],
            port=config["PORT"],
            dbname=config["NAME"],
            user=name,
            password=password,
            autocommit=True,
        )

    try:
        yield name, connect
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))


def now():
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def begin_sql(org, not_before=None):
    from test_core_erasure import operator

    from apps.orgs.privacy_models import PrivacyErasure

    request_id = uuid4()
    actor = operator()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.privacy_begin_erasure(%s,%s,%s,%s,%s,%s)",
            [request_id, org.id, "DEL-200", "1" * 64, not_before or now(), actor.id],
        )
    return PrivacyErasure.objects.get(id=request_id)


def seed(world):
    org, workspace, _, tokens = world
    installation = services.install(
        verified=tokens[0],
        organisation_id=org.id,
        name="Controlled receiver",
        endpoint="https://hooks.example.org/controlled",
        events=["command.invoked"],
    )
    delivery = services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        event_key="owned-erasure-event",
        event_type="command.invoked",
        data={"text": "Synthetic private payload"},
    )
    return org, workspace, installation, delivery


def step(worker, row, *, limit=100, **changes):
    values = {
        "erasure": row.id,
        "org": row.organisation_reference,
        "cutoff": row.cutoff_at,
        "digest": row.inventory_sha256,
        "limit": limit,
        **changes,
    }
    return worker.execute(
        "SELECT public.extension_erasure_step(%s,%s,%s,%s,%s)",
        [values["erasure"], values["org"], values["cutoff"], values["digest"], values["limit"]],
    ).fetchone()[0]


def receipts(row, *, domains=None):
    for domain in row.inventory["required_domains"] if domains is None else domains:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.privacy_record_absence(%s,%s,%s,%s,%s,%s)",
                [row.id, domain, row.cutoff_at, "2" * 64, "owned-control-1", now()],
            )


def test_definer_is_private_fixed_path_and_missing_core_intent_never_creates_admission(
    processing_login,
):
    _, connect = processing_login
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT p.prosecdef,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') FROM pg_proc p WHERE p.oid='public.extension_erasure_step(uuid,uuid,timestamptz,text,integer)'::regprocedure"
        )
        definer, config, public = cursor.fetchone()
    assert definer and "search_path=pg_catalog, public" in config and not public
    assert "lock_timeout=2s" in config and "statement_timeout=5s" in config
    with connect() as worker:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            worker.execute("SELECT event FROM public.extensions_delivery")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            worker.execute("DELETE FROM public.extensions_installation")
        with pytest.raises(
            psycopg.errors.CheckViolation,
            match="Core intent unavailable|Core scope binding refused",
        ):
            worker.execute(
                "SELECT public.extension_erasure_step(%s,%s,%s,%s,%s)",
                [uuid4(), uuid4(), now(), "1" * 64, 10],
            )
    assert not ErasureAdmission.objects.exists() and not WorkspaceCutoff.objects.exists()


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_processing_login_cannot_admit_cutoff_or_insert_fiscal_authority(processing_login):
    _, connect = processing_login
    with connect() as worker:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            worker.execute(
                "SELECT public.privacy_begin_erasure(NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz,NULL::uuid)"
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            worker.execute("INSERT INTO public.billing_fiscalperiod DEFAULT VALUES")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            worker.execute("SELECT public.retention_inventory_digest('{}'::jsonb)")


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_real_restricted_step_preserves_metadata_until_every_bound_receipt_and_purges_native_fk(
    world, native_engine, processing_login
):
    import json

    from apps.docs.models import Document

    org, _, installation, delivery = seed(world)
    raw = json.dumps({"channel": {"id": "1", "name": "Synthetic channel"}, "messages": []}).encode()
    assert imports.execute(verified=world[3][0], organisation_id=org.id, source="discord", raw=raw)[
        "complete"
    ]
    row = begin_sql(org)
    assert len(row.inventory["extension_receivers"]) == 1
    _, connect = processing_login
    with connect() as worker:
        progress = step(worker, row, limit=1)
        assert progress["payloads_complete"] and not progress["metadata_complete"]
        assert progress["external_receipts_complete"] is False
        assert progress["native_documents_released"] is False
        delivery.refresh_from_db()
        assert bytes(delivery.event) == b"" and delivery.purged_at is not None
        assert (
            ImportedObject.objects.exists()
            and Installation.objects.filter(id=installation.id).exists()
        )
        receipts(row, domains=row.inventory["required_domains"][:-1])
        partial = step(worker, row, limit=1)
        assert not partial["external_receipts_complete"] and partial["metadata_purged"] == 0
        receipts(row, domains=row.inventory["required_domains"][-1:])
        total = 0
        for _ in range(20):
            progress = step(worker, row, limit=1)
            assert progress["payloads_purged"] + progress["metadata_purged"] <= 1
            total += progress["metadata_purged"]
            if progress["metadata_complete"]:
                break
        assert progress["metadata_complete"] and progress["native_documents_released"] and total > 0
        assert step(worker, row)["metadata_complete"]
        assert not ImportedObject.objects.exists() and Document.objects.exists()
        core = worker.execute("SELECT public.privacy_purge_core(%s)", [row.id]).fetchone()[0]
        assert core["documents"] > 0
    assert not ImportedObject.objects.exists() and not Document.objects.exists()
    assert WorkspaceCutoff.objects.filter(organisation_id=org.id).exists()
    assert ErasureAdmission.objects.filter(
        erasure_id=row.id, inventory_sha256=row.inventory_sha256
    ).exists()


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
@pytest.mark.parametrize("days", [2, 9])
def test_recovery_deadline_fences_now_without_early_erasure_or_ttl_extension(
    world, processing_login, days
):
    org, _, installation, delivery = seed(world)
    original_expiry = delivery.expires_at
    deadline = now() + timedelta(days=days)
    row = begin_sql(org, deadline)
    _, connect = processing_login
    receipts(row)
    with connect() as worker:
        held = step(worker, row)
        assert held["held"] and held["payloads_purged"] == 0 and held["metadata_purged"] == 0
    installation.refresh_from_db()
    delivery.refresh_from_db()
    assert installation.revoked_at == row.cutoff_at
    assert delivery.expires_at == min(original_expiry, row.purge_not_before)
    assert delivery.purged_at is None and bytes(delivery.event)
    assert WorkspaceCutoff.objects.get(organisation_id=org.id).cutoff_at == row.cutoff_at


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
@pytest.mark.parametrize("mutation", ["org", "cutoff", "digest", "limit", "erasure"])
def test_restricted_scope_and_replay_mutations_refuse_before_cutoff_write(
    world, processing_login, mutation
):
    org, _, _, delivery = seed(world)
    row = begin_sql(org)
    changes = (
        {"org": uuid4()}
        if mutation == "org"
        else {"cutoff": row.cutoff_at - timedelta(seconds=1)}
        if mutation == "cutoff"
        else {"digest": "f" * 64}
        if mutation == "digest"
        else {"limit": 0}
        if mutation == "limit"
        else {"erasure": uuid4()}
    )
    _, connect = processing_login
    with connect() as worker:
        with pytest.raises(psycopg.errors.CheckViolation):
            step(worker, row, **changes)
    assert not WorkspaceCutoff.objects.exists() and not ErasureAdmission.objects.exists()
    delivery.refresh_from_db()
    assert bytes(delivery.event)


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_temporary_shadow_journal_cannot_admit_missing_public_intent(world, processing_login):
    _, connect = processing_login
    with connect() as worker:
        worker.execute("CREATE TEMP TABLE orgs_privacyerasure (id uuid)")
        bogus = uuid4()
        worker.execute("INSERT INTO orgs_privacyerasure VALUES (%s)", [bogus])
        with pytest.raises(psycopg.errors.CheckViolation, match="Core scope binding refused"):
            worker.execute(
                "SELECT public.extension_erasure_step(%s,%s,%s,%s,%s)",
                [bogus, world[0].id, now(), "1" * 64, 10],
            )
    assert not WorkspaceCutoff.objects.exists()


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_bare_local_cutoff_cannot_substitute_for_exact_initial_inventory(world, processing_login):
    from django.db import transaction

    org, _, _, _ = seed(world)
    row = begin_sql(org)
    # Test-owned SQL setup is not Core admission. Even after it removes a receiver,
    # a processing login must refuse the changed inventory instead of trusting that marker.
    with transaction.atomic():
        WorkspaceCutoff.objects.create(organisation_id=org.id, cutoff_at=row.cutoff_at)
        Installation.objects.filter(workspace__organisation_id=org.id).update(
            revoked_at=row.cutoff_at
        )
        from apps.extensions.models import Delivery

        Delivery.objects.filter(installation__workspace__organisation_id=org.id).update(
            expires_at=row.cutoff_at
        )
        retention.purge_due(limit=100, organisation_id=org.id)
        Delivery.objects.all().delete()
        Installation.objects.all().delete()
    assert not Installation.objects.exists() and not ErasureAdmission.objects.exists()
    _, connect = processing_login
    with connect() as worker:
        with pytest.raises(
            psycopg.errors.CheckViolation, match="initial receiver inventory mismatch"
        ):
            step(worker, row)
    assert not ErasureAdmission.objects.exists()


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_admitted_binding_is_immutable_even_for_owner_and_survives_metadata_disposal(
    world, processing_login
):
    from django.db import IntegrityError, transaction

    org, _, _, _ = seed(world)
    row = begin_sql(org)
    _, connect = processing_login
    with connect() as worker:
        step(worker, row)
    for operation in (
        "UPDATE public.extensions_erasureadmission SET inventory_sha256='" + "f" * 64 + "'",
        "DELETE FROM public.extensions_erasureadmission",
    ):
        with (
            pytest.raises(IntegrityError, match="cutoff marker immutable"),
            transaction.atomic(),
            connection.cursor() as cursor,
        ):
            cursor.execute(operation)
    assert ErasureAdmission.objects.get(erasure_id=row.id).inventory_sha256 == row.inventory_sha256


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
@pytest.mark.parametrize("function", ["customer_check_owner", "customer_check_reservation"])
def test_restricted_worker_cannot_reuse_private_core_integrity_trigger(processing_login, function):
    _, connect = processing_login
    with connect() as worker:
        worker.execute("CREATE TEMP TABLE forged_integrity (id uuid, organisation_id uuid)")
        with pytest.raises(
            psycopg.errors.InsufficientPrivilege, match="permission denied for function"
        ):
            worker.execute(
                sql.SQL(
                    "CREATE CONSTRAINT TRIGGER forged_integrity AFTER INSERT ON forged_integrity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.{}()"
                ).format(sql.Identifier(function))
            )


@pytest.mark.skipif(not HAS_CORE, reason="requires the reviewed Core retention integration stack")
def test_no_import_links_release_actual_native_core_while_remote_receipts_stay_held(
    world, native_engine, processing_login
):
    from apps.docs import services as documents
    from apps.docs.models import Document

    org, _, _, tokens = world
    documents.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Synthetic native page",
        parent_id=None,
        template_key=None,
        request_id="controlled-native-erasure",
    )
    row = begin_sql(org)
    assert row.inventory["extension_receivers"] == []
    _, connect = processing_login
    with connect() as worker:
        progress = step(worker, row)
        assert progress["payloads_complete"] and progress["native_documents_released"]
        assert not progress["metadata_complete"] and not progress["external_receipts_complete"]
        assert (
            worker.execute("SELECT public.privacy_purge_core(%s)", [row.id]).fetchone()[0][
                "documents"
            ]
            == 1
        )
        assert (
            worker.execute("SELECT public.privacy_complete_erasure(%s)", [row.id]).fetchone()[0]
            is False
        )
    assert not Document.objects.exists()
