"""Actual PostgreSQL Core deletion, cutoff mutation proofs and explicit external holds."""

from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.docs.models import Collection, CollectionRow, Document, DocumentSnapshot, DocumentUpdate
from apps.identity.models import Identity, StaffRole, User
from apps.media.models import Attachment
from apps.notifications.models import Notification, PushOutbox, PushSubscription
from apps.orgs.erasure_services import (
    AbsenceProof,
    ErasureScope,
    advance_erasure,
    begin_erasure,
    database_now,
    persist_absence,
    purge_core,
)
from apps.orgs.privacy_models import ErasureReceipt, PrivacyErasure

pytestmark = pytest.mark.django_db(transaction=True)


def operator():
    user = User.objects.create(email=f"{uuid4()}@staff.test")
    principal = Identity.objects.create(
        user=user,
        realm="kodera-staff",
        issuer="https://identity.staff.test/realms/kodera-staff",
        subject=str(uuid4()),
        email=user.email,
    )
    StaffRole.objects.create(identity=principal, realm="kodera-staff", role="staff_operator")
    return principal


def begin(org, *, not_before=None):
    return begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-100",
        instruction_sha256="1" * 64,
        purge_not_before=not_before or database_now(),
        actor_identity_id=operator().id,
    )


def seed(world):
    org, workspace, members, _ = world
    principal = Identity.objects.get(organisation=org, user=members[0].user)
    doc = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Synthetic private document",
        markdown="Synthetic private body",
    )
    Document.objects.create(
        workspace=workspace, creator=members[0], parent=doc, title="Synthetic child"
    )
    DocumentSnapshot.objects.create(document=doc, state=b"synthetic snapshot")
    DocumentUpdate.objects.create(
        document=doc, sequence=1, actor=principal, state=b"synthetic update"
    )
    collection = Collection.objects.create(
        workspace=workspace, creator=members[0], title="Synthetic collection"
    )
    CollectionRow.objects.create(collection=collection, document=doc, values={})
    attachment = Attachment.objects.create(
        organisation=org,
        uploader=members[0],
        filename="synthetic.txt",
        content_type="text/plain",
        size_bytes=12,
        sha256="2" * 64,
        upload_expires_at=timezone.now() + timedelta(minutes=5),
    )
    push = PushSubscription.objects.create(
        organisation=org,
        membership=members[0],
        device_id=uuid4(),
        version=uuid4(),
        endpoint_digest="3" * 64,
        sealed_subscription=b"synthetic sealed subscription",
    )
    PushOutbox.objects.create(
        subscription=push, subscription_version=push.version, available_at=timezone.now()
    )
    Notification.objects.create(
        organisation=org, membership=members[0], kind="document", resource_id=doc.id
    )
    return doc, attachment, principal


def test_real_core_payloads_are_deleted_while_missing_remote_adapters_hold_completion(world):
    org, workspace, _, _ = world
    _, attachment, principal = seed(world)
    row = begin(org)
    assert row.inventory["attachments"] == [str(attachment.id)]
    assert (
        row.inventory_sha256
        == ErasureScope(row.id, org.id, row.cutoff_at, row.inventory).inventory_sha256
    )
    result = advance_erasure(row.id, {})
    assert result["core_purged"] and not result["complete"]
    assert result["held_domains"] == ["identity_provider", "matrix", "objects", "private_exports"]
    assert result["counts"]["documents"] == 2
    for model in [
        Document,
        DocumentSnapshot,
        DocumentUpdate,
        Collection,
        CollectionRow,
        Attachment,
        PushSubscription,
        PushOutbox,
        Notification,
    ]:
        assert not model.objects.exists(), model.__name__
    principal.refresh_from_db()
    assert not principal.enabled and principal.email == f"erased:{principal.id}"
    assert (
        principal.subject.startswith("erased:") is False
    )  # Needed for absent provider adapter to resume.
    assert purge_core(row.id) == result["counts"]
    assert not ErasureReceipt.objects.exists()


def test_cutoff_refuses_new_payload_and_reactivation_and_recovery_clock_is_enforced(world):
    org, workspace, members, _ = world
    doc, _, principal = seed(world)
    row = begin(org, not_before=timezone.now() + timedelta(hours=1))
    with pytest.raises(IntegrityError, match="not due"), transaction.atomic():
        purge_core(row.id)
    for mutation in [
        lambda: Document.objects.filter(pk=doc.id).update(markdown="after cutoff"),
        lambda: Identity.objects.filter(pk=principal.id).update(enabled=True),
        lambda: Document.objects.create(
            workspace=workspace, creator=members[0], title="After cutoff"
        ),
    ]:
        with pytest.raises(IntegrityError, match="durable erasure cutoff"), transaction.atomic():
            mutation()
    assert Document.objects.filter(pk=doc.id).exists()
    with pytest.raises(IntegrityError, match="worker authority"), transaction.atomic():
        PrivacyErasure.objects.filter(pk=row.id).update(purge_not_before=timezone.now())


class ControlledAdapter:
    """Synthetic proof control only; never a configured production implementation."""

    revision = "control-v1"

    def __init__(self, domain):
        self.domain = domain

    def erase_and_verify(self, scope):
        return AbsenceProof(
            scope.request_id,
            scope.organisation_id,
            scope.cutoff_at,
            self.domain,
            scope.inventory_sha256,
            "4" * 64,
            self.revision,
            database_now(),
        )

    def verify_proof(self, scope, proof):
        return proof.evidence_sha256 == "4" * 64


def test_all_bound_adapter_controls_allow_actual_subject_history_finalization(world):
    org, _, _, _ = world
    _, _, principal = seed(world)
    row = begin(org)
    adapters = {
        domain: ControlledAdapter(domain)
        for domain in ["matrix", "objects", "identity_provider", "private_exports"]
    }
    result = advance_erasure(row.id, adapters)
    assert result["complete"] and not result["held_domains"]
    row.refresh_from_db()
    principal.refresh_from_db()
    assert row.status == "complete" and row.completed_at is not None
    assert principal.subject == f"erased:{principal.id}"
    assert ErasureReceipt.objects.filter(erasure=row).count() == 4
    assert advance_erasure(row.id, adapters)["complete"]


@pytest.mark.parametrize(
    "mutation",
    [
        "request",
        "organisation",
        "cutoff",
        "inventory",
        "domain",
        "revision",
        "digest",
        "future",
        "unverified",
    ],
)
def test_external_proof_mutations_never_complete_or_enter_journal(world, mutation):
    org, _, _, _ = world
    row = begin(org)
    purge_core(row.id)
    scope = ErasureScope(row.id, org.id, row.cutoff_at, row.inventory)
    adapter = ControlledAdapter("objects")
    proof = adapter.erase_and_verify(scope)
    values = {
        "request": {"request_id": uuid4()},
        "organisation": {"organisation_id": uuid4()},
        "cutoff": {"cutoff_at": row.cutoff_at - timedelta(seconds=1)},
        "inventory": {"inventory_sha256": "5" * 64},
        "domain": {"domain": "matrix"},
        "revision": {"adapter_revision": "other"},
        "digest": {"evidence_sha256": "bad"},
        "future": {"verified_at": timezone.now() + timedelta(hours=1)},
        "unverified": {"evidence_sha256": "6" * 64},
    }
    with pytest.raises(ValueError, match="external erasure proof refused"):
        persist_absence(scope, replace(proof, **values[mutation]), adapter)
    assert not ErasureReceipt.objects.exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_complete_erasure(%s)", [row.id])
        assert cursor.fetchone()[0] is False


def test_all_privileged_worker_and_trigger_functions_refuse_public_execution_and_temp_trigger_reuse():
    from django.db import ProgrammingError

    from core.db.retention_worker_role import FUNCTIONS, grant_statements

    assert all("DELETE ON" not in item for item in grant_statements("retention_worker_control"))
    for name in ["kodera_api", "public", "evil;drop table"]:
        with pytest.raises(ValueError, match="separate statutory erasure worker"):
            grant_statements(name)
    role = "retention_control_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN')
    try:
        for signature in [
            *FUNCTIONS,
            "retention_context(text,text,uuid)",
            "retention_current_operator(uuid)",
            "billing_retention_clock_guard()",
            "billing_statutory_capture()",
            "privacy_cutoff_guard()",
        ]:
            with connection.cursor() as cursor:
                cursor.execute("SELECT has_function_privilege(%s,%s,'EXECUTE')", [role, signature])
                assert cursor.fetchone()[0] is False, signature
        with (
            pytest.raises(ProgrammingError, match="permission denied for function"),
            transaction.atomic(),
            connection.cursor() as cursor,
        ):
            cursor.execute(f'SET LOCAL ROLE "{role}"')
            cursor.execute("CREATE TEMP TABLE billing_invoice (id uuid)")
            cursor.execute(
                "CREATE TRIGGER hostile_capture AFTER INSERT ON billing_invoice FOR EACH ROW EXECUTE FUNCTION public.billing_statutory_capture()"
            )
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f'DROP ROLE "{role}"')


def test_an_existing_optional_extension_store_cannot_be_silently_omitted(world):
    org, _, _, _ = world
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "CREATE TABLE public.extensions_installation (id uuid,workspace_id uuid,endpoint text)"
        )
        with pytest.raises(ValueError, match="extension erasure integration unavailable"):
            begin(org)
        org.refresh_from_db()
        assert org.state == "active" and not PrivacyErasure.objects.exists()
        transaction.set_rollback(True)


def test_workspace_erasure_preserves_shared_persons_other_active_scope_and_authority_fanout(world):
    from workspace_safety.test_moderation import world as make_world

    from apps.orgs.models import Membership

    org, _, members, _ = world
    other, _, _, _ = make_world.__wrapped__()
    user = members[0].user
    other_identity = Identity.objects.create(
        user=user,
        organisation=other,
        issuer=other.issuer,
        realm=other.realm,
        subject=str(uuid4()),
        email=user.email,
    )
    other_member = Membership.objects.create(
        user=user, organisation=other, role="org_member", state="active", accepted_at=timezone.now()
    )
    row = begin(org)
    advance_erasure(row.id, {})
    user.refresh_from_db()
    other_identity.refresh_from_db()
    assert user.enabled and not user.email.startswith("erased:")
    assert other_identity.enabled and other_identity.email == user.email
    # The ordinary shared-user authority fan-out touches the erased organisation too.
    # Only counters may change there; the other active scope must remain usable.
    Membership.objects.filter(pk=other_member.id).update(role="org_admin")
    assert Membership.objects.get(pk=other_member.id).role == "org_admin"


def test_current_operator_authority_is_locked_until_the_decision_commits():
    import psycopg

    actor = operator()
    settings = connection.settings_dict
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT retention_current_operator(%s)", [actor.id])
        assert cursor.fetchone()[0] is True
        with psycopg.connect(
            host=settings["HOST"],
            port=settings["PORT"],
            dbname=settings["NAME"],
            user=settings["USER"],
            password=settings["PASSWORD"],
            autocommit=True,
        ) as other:
            other.execute("SET lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                other.execute(
                    "UPDATE identity_staffrole SET revoked_at=clock_timestamp() WHERE identity_id=%s",
                    [actor.id],
                )
    StaffRole.objects.filter(identity=actor).update(revoked_at=database_now())
    with connection.cursor() as cursor:
        cursor.execute("SELECT retention_current_operator(%s)", [actor.id])
        assert cursor.fetchone()[0] is False


@pytest.mark.parametrize(
    "inventory",
    [
        {"required_domains": ["matrix", "objects"], "attachments": []},
        {
            "z": "éclair",
            "a": {"integer": 2, "boolean": True, "empty": None},
            "array": ["line\nbreak", 'quote"', "slash/"],
        },
    ],
)
def test_inventory_digest_matches_independent_canonical_utf8_runtime(inventory):
    import hashlib
    import json

    expected = hashlib.sha256(
        json.dumps(inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    with connection.cursor() as cursor:
        cursor.execute("SELECT retention_inventory_digest(%s::jsonb)", [json.dumps(inventory)])
        assert cursor.fetchone()[0] == expected


def test_inventory_fractional_numbers_refuse_instead_of_ambiguous_digest_serialization():
    with (
        pytest.raises(IntegrityError, match="inventory fractional number refused"),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute("SELECT retention_inventory_digest('{\"fraction\":1.25}'::jsonb)")
