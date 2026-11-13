"""Actual PostgreSQL cutoff and configured-volume payload absence, never provider simulation."""

import json
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from django.db import ProgrammingError, connection, connections, transaction
from test_core_erasure import begin
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity
from apps.orgs.erasure_services import ErasureScope, database_now, persist_absence
from apps.orgs.privacy_archives import ArchiveRefusalError, Request
from apps.orgs.privacy_models import ErasureReceipt, PrivacyExport
from apps.orgs.privacy_storage import PrivateVolume
from apps.orgs.private_export_erasure import PrivateExportErasureAdapter
from core.db.retention_worker_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


class ControlledReplicaVerifier:
    """Explicit completeness control for this synthetic local-only test world."""

    evidence = "a" * 64

    def verify_absent(self, scope, request_ids):
        assert request_ids == tuple(sorted(scope.inventory["private_exports"]))
        return self.evidence


def started(world, tmp_path, *, live=False, count=1):
    org, _, members, _ = world
    principal = Identity.objects.get(user=members[0].user, organisation=org)
    now = int(database_now().timestamp())
    deadline = now + 600 if live else now - 100
    request = Request(
        str(uuid4()),
        str(principal.id),
        str(principal.user_id),
        "workspace",
        str(org.id),
        True,
        deadline - 600,
        deadline,
    )
    # The expired row represents a real request admitted before this test's current clock.
    PrivacyExport.objects.create(
        id=request.id,
        identity=principal,
        user=principal.user,
        organisation=org,
        scope=request.scope,
        request_snapshot=asdict(request),
        checkpoint={},
        expires_at=datetime.fromtimestamp(deadline, UTC),
    )
    root = tmp_path.resolve() / "private"
    root.mkdir(mode=0o700)
    prior = PrivateVolume(root, clock=lambda: deadline - 1)
    for index in range(count):
        prior.put_immutable(f"privacy/{request.id}/sources/body-{index}.bin", b"private", deadline)
    row = begin(org)
    scope = ErasureScope(row.id, org.id, row.cutoff_at, row.inventory)
    adapter = PrivateExportErasureAdapter(
        PrivateVolume(root, clock=lambda: database_now().timestamp()), ControlledReplicaVerifier()
    )
    return request, scope, adapter


def test_actual_volume_cleanup_records_only_the_bound_private_export_receipt(world, tmp_path):
    request, scope, adapter = started(world, tmp_path)
    assert scope.inventory["private_export_expiries"] == {request.id: request.expires_at}
    proof = adapter.erase_and_verify(scope)
    assert adapter.verify_proof(scope, proof)
    assert adapter.volume.inventory(request.id) == ()
    persist_absence(scope, proof, adapter)
    assert list(ErasureReceipt.objects.values_list("domain", flat=True)) == ["private_exports"]
    assert adapter.erase_and_verify(scope).evidence_sha256 == proof.evidence_sha256


def test_original_live_lifetime_holds_even_after_durable_cutoff(world, tmp_path):
    request, scope, adapter = started(world, tmp_path, live=True)
    with pytest.raises(ArchiveRefusalError, match="original lifetime still live"):
        adapter.erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1
    assert not ErasureReceipt.objects.exists()


def test_lagging_volume_clock_preserves_original_lifetime_hold(world, tmp_path):
    request, scope, adapter = started(world, tmp_path)
    adapter = replace(
        adapter, volume=PrivateVolume(adapter.volume.root, clock=lambda: request.expires_at - 1)
    )
    with pytest.raises(ArchiveRefusalError, match="original lifetime still live"):
        adapter.erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1


def test_partial_cleanup_progress_never_issues_a_complete_receipt(world, tmp_path):
    request, scope, adapter = started(world, tmp_path, count=3)
    adapter = replace(adapter, collection_limit=2)
    with pytest.raises(ArchiveRefusalError, match="collection incomplete"):
        adapter.erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1
    assert not ErasureReceipt.objects.exists()
    proof = adapter.erase_and_verify(scope)
    assert adapter.verify_proof(scope, proof)


@pytest.mark.parametrize("mutation", ["organisation", "cutoff", "inventory", "future_recovery"])
def test_scope_and_recovery_mutations_cannot_delete_volume_payloads(world, tmp_path, mutation):
    request, scope, adapter = started(world, tmp_path)
    if mutation == "organisation":
        scope = replace(scope, organisation_id=uuid4())
    elif mutation == "cutoff":
        scope = replace(scope, cutoff_at=scope.cutoff_at - timedelta(seconds=1))
    elif mutation == "inventory":
        scope = replace(scope, inventory={**scope.inventory, "private_exports": []})
    else:
        # Deliberately violate the production journal guard only within a rolled-back mutation.
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "ALTER TABLE orgs_privacyerasure DISABLE TRIGGER erasure_journal_immutable"
                )
                cursor.execute(
                    "UPDATE orgs_privacyerasure SET purge_not_before=clock_timestamp()+interval '1 day' WHERE id=%s",
                    [scope.request_id],
                )
            with pytest.raises(ArchiveRefusalError, match="authority binding"):
                adapter.erase_and_verify(scope)
            transaction.set_rollback(True)
        assert len(adapter.volume.inventory(request.id)) == 1
        return
    with pytest.raises(ArchiveRefusalError, match="authority binding"):
        adapter.erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1


def test_replica_proof_and_fresh_absence_are_required_on_receipt_verification(world, tmp_path):
    request, scope, adapter = started(world, tmp_path)
    proof = adapter.erase_and_verify(scope)
    assert not adapter.verify_proof(scope, replace(proof, evidence_sha256="b" * 64))
    adapter.replicas.evidence = "c" * 64
    assert not adapter.verify_proof(scope, proof)
    adapter.replicas.evidence = "a" * 64
    # An out-of-protocol filesystem writer cannot forge an absence receipt.
    path = adapter.volume.root / "privacy" / request.id / "sources" / "rogue.bin"
    path.write_bytes(request.expires_at.to_bytes(8, "big") + b"unexpected")
    path.chmod(0o600)
    assert not adapter.verify_proof(scope, proof)
    assert not ErasureReceipt.objects.exists()


def test_replica_evidence_has_no_implicit_empty_success(world, tmp_path):
    request, scope, adapter = started(world, tmp_path)
    adapter.replicas.evidence = ""
    with pytest.raises(ArchiveRefusalError, match="replica absence evidence"):
        adapter.erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1


def test_missing_configured_root_does_not_certify_empty_inventory(world, tmp_path):
    org, _, _, _ = world
    row = begin(org)
    scope = ErasureScope(row.id, org.id, row.cutoff_at, row.inventory)
    root = tmp_path.resolve() / "private"
    root.mkdir(mode=0o700)
    adapter = PrivateExportErasureAdapter(PrivateVolume(root), ControlledReplicaVerifier())
    root.rmdir()
    with pytest.raises(ArchiveRefusalError, match="root unavailable"):
        adapter.erase_and_verify(scope)


@pytest.mark.parametrize(
    ("mutation", "diagnostic"),
    [
        ("missing_map", "immutable deadline inventory"),
        ("missing_deadline", "immutable deadline inventory"),
        ("duplicate", "immutable deadline inventory"),
        ("oversized", "immutable deadline inventory"),
        ("identifier", "inventory identifier"),
        ("zero_deadline", "original deadline"),
        ("boolean_deadline", "original deadline"),
    ],
)
def test_malformed_durable_deadline_inventory_never_deletes_payloads(
    world, tmp_path, mutation, diagnostic
):
    request, scope, adapter = started(world, tmp_path)
    inventory = {**scope.inventory, "private_export_expiries": {request.id: request.expires_at}}
    if mutation == "missing_map":
        inventory.pop("private_export_expiries")
    elif mutation == "missing_deadline":
        inventory["private_export_expiries"] = {}
    elif mutation == "duplicate":
        inventory["private_exports"] = [request.id, request.id]
    elif mutation == "oversized":
        identifiers = [str(uuid4()) for _ in range(10001)]
        inventory["private_exports"] = identifiers
        inventory["private_export_expiries"] = dict.fromkeys(identifiers, request.expires_at)
    elif mutation == "identifier":
        inventory["private_exports"] = ["invalid"]
        inventory["private_export_expiries"] = {"invalid": request.expires_at}
    else:
        inventory["private_export_expiries"] = {
            request.id: 0 if mutation == "zero_deadline" else True
        }
    mutated = replace(scope, inventory=inventory)
    # Bypass only the journal immutability trigger inside a rolled-back mutation, so the
    # adapter's own malformed-inventory guard is exercised against actual stored rows.
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("ALTER TABLE orgs_privacyerasure DISABLE TRIGGER erasure_journal_immutable")
        cursor.execute(
            "UPDATE orgs_privacyerasure SET inventory=%s::jsonb,inventory_sha256=%s WHERE id=%s",
            [json.dumps(inventory), mutated.inventory_sha256, scope.request_id],
        )
        with pytest.raises(ArchiveRefusalError, match=diagnostic):
            adapter.erase_and_verify(mutated)
        transaction.set_rollback(True)
    assert len(adapter.volume.inventory(request.id)) == 1


@pytest.mark.parametrize("limit", [0, 1001, True])
def test_invalid_collection_bound_never_deletes_payloads(world, tmp_path, limit):
    request, scope, adapter = started(world, tmp_path)
    with pytest.raises(ArchiveRefusalError, match="collection bound"):
        replace(adapter, collection_limit=limit).erase_and_verify(scope)
    assert len(adapter.volume.inventory(request.id)) == 1


def test_independent_processing_login_can_prove_volume_absence_without_export_table_access(
    world,
    tmp_path,
):
    from psycopg import sql

    request, scope, adapter = started(world, tmp_path)
    name = "kodera_retention_worker_" + uuid4().hex[:12]
    password = "synthetic-" + uuid4().hex
    original = connections["default"]
    with original.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(name), sql.Literal(password))
        )
        for statement in grant_statements(name):
            cursor.execute(statement)
    settings = {**original.settings_dict, "USER": name, "PASSWORD": password}
    worker = type(original)(settings, alias="default")
    try:
        connections["default"] = worker
        with worker.cursor() as cursor:
            cursor.execute("SELECT current_user,session_user")
            assert cursor.fetchone() == (name, name)
        with pytest.raises(ProgrammingError, match="permission denied"), transaction.atomic():
            with worker.cursor() as cursor:
                cursor.execute("SELECT * FROM public.orgs_privacyexport")
        proof = adapter.erase_and_verify(scope)
        persist_absence(scope, proof, adapter)
        assert adapter.volume.inventory(request.id) == ()
        assert ErasureReceipt.objects.filter(erasure_id=scope.request_id).count() == 1
    finally:
        worker.close()
        connections["default"] = original
        with original.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(name)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))
