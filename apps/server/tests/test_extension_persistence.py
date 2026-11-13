"""Durable dispatch/native-import/consent integration against isolated PostgreSQL and Yjs."""

import json
from datetime import timedelta
from uuid import UUID

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.utils import timezone
from smtp_stub import smtp_stub
from test_extension_import_parsers import archive
from test_outbox_mail_sender import KEY, local
from workspace_documents.test_services import native_engine as native_engine
from workspace_safety.test_moderation import world as world

from apps.docs import services as documents
from apps.docs.models import CollectionRow, Document, DocumentSnapshot
from apps.extensions import digest, dispatcher, imports, services
from apps.extensions.models import (
    Delivery,
    DeliveryAttempt,
    DigestConsent,
    ImportedObject,
)
from apps.extensions.wire import ExtensionRefusedError
from apps.outbox import sender
from apps.workspaces.models import WorkspaceQuota

pytestmark = pytest.mark.django_db(transaction=True)


class Secrets:
    def get(self, **kwargs):
        return "synthetic-test-installation-key-" + str(kwargs["generation"])


def queued(world):
    org, _, _, tokens = world
    installation = services.install(
        verified=tokens[0],
        organisation_id=org.id,
        name="Owned test",
        endpoint="https://hooks.example.org/receive",
        events=["command.invoked"],
    )
    job = services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        event_key="event-1",
        event_type="command.invoked",
        data={"text": "synthetic"},
    )
    return installation, job


def test_owner_admin_authority_queue_replay_and_revoked_installation(world, monkeypatch):
    org, _, _, tokens = world
    with pytest.raises(ExtensionRefusedError, match="owner_or_admin"):
        services.install(
            verified=tokens[3],
            organisation_id=org.id,
            name="Denied",
            endpoint="https://example.org",
            events=["command.invoked"],
        )
    installation, job = queued(world)
    assert (
        services.enqueue(
            verified=tokens[0],
            organisation_id=org.id,
            installation_id=installation.id,
            event_key="event-1",
            event_type="command.invoked",
            data={"text": "synthetic"},
        ).id
        == job.id
    )
    with pytest.raises(ExtensionRefusedError, match="key_reused"):
        services.enqueue(
            verified=tokens[0],
            organisation_id=org.id,
            installation_id=installation.id,
            event_key="event-1",
            event_type="command.invoked",
            data={"text": "changed"},
        )
    claim = dispatcher.claim()
    services.revoke(verified=tokens[0], organisation_id=org.id, installation_id=installation.id)
    monkeypatch.setattr(
        dispatcher, "send", lambda *args: pytest.fail("revoked install contacted receiver")
    )
    dispatcher.dispatch_claim(claim, Secrets())
    job.refresh_from_db()
    assert job.state == "obsolete"
    assert (
        services.inspect(
            verified=tokens[1], organisation_id=org.id, installation_id=installation.id
        )[0]["state"]
        == "obsolete"
    )


def test_crashed_lease_is_reconciled_and_stale_result_cannot_send(world, monkeypatch):
    _, job = queued(world)
    claim = dispatcher.claim()
    Delivery.objects.filter(id=job.id).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert dispatcher.claim() is None
    monkeypatch.setattr(dispatcher, "send", lambda *a: pytest.fail("expired attempt resent"))
    dispatcher.dispatch_claim(claim, Secrets())
    job.refresh_from_db()
    assert job.state == "needs_reconciliation"
    assert DeliveryAttempt.objects.get(delivery=job).outcome == "uncertain"


@pytest.mark.parametrize(
    "outcome,status,state",
    [
        ("delivered", 200, "delivered"),
        ("retry", 503, "pending"),
        ("refused", 302, "dead_letter"),
        ("uncertain", None, "needs_reconciliation"),
    ],
)
def test_durable_outcome_and_key_generation(world, monkeypatch, outcome, status, state):
    org, _, _, tokens = world
    installation, job = queued(world)
    old = installation.generation
    installation = services.rotate(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        grace_expires_at=timezone.now() + timedelta(hours=1),
    )
    sent = []
    monkeypatch.setattr(
        dispatcher, "send", lambda endpoint, signed: sent.append(signed) or (outcome, status)
    )
    dispatcher.dispatch_claim(dispatcher.claim(), Secrets())
    job.refresh_from_db()
    assert job.state == state
    body = json.loads(sent[0].body)
    assert body["previous_key_generation"] == str(old)
    assert body["key_generation"] == str(installation.generation)
    assert body["delivery_id"] == str(job.id)


def test_unexpected_transport_exception_does_not_blindly_retry(world, monkeypatch):
    _, job = queued(world)

    def lost(*args):
        raise RuntimeError("test-owned lost result")

    monkeypatch.setattr(dispatcher, "send", lost)
    dispatcher.dispatch_claim(dispatcher.claim(), Secrets())
    job.refresh_from_db()
    assert job.state == "needs_reconciliation"


def test_actual_native_slack_import_reuses_ids_and_preserves_user_edits(world, native_engine):
    org, _, _, tokens = world
    raw = archive(
        {
            "channels.json": json.dumps([{"id": "C1", "name": "general"}]),
            "users.json": json.dumps([{"id": "U1", "name": "Synthetic Author"}]),
            "general/2026-11-13.json": json.dumps(
                [{"ts": "1.000001", "user": "U1", "text": "Original message"}]
            ),
        }
    )
    report = imports.execute(verified=tokens[0], organisation_id=org.id, source="slack", raw=raw)
    assert report["complete"]
    item = ImportedObject.objects.get(external_key="slack:message:C1:1.000001")
    row = Document.objects.get(id=item.document_id)
    assert "Synthetic Author" in row.markdown
    assert row.creator_id != UUID(int=0)
    assert DocumentSnapshot.objects.get(document=row).state
    current = documents.read(verified=tokens[0], organisation_id=org.id, document_id=row.id)
    documents.patch(
        verified=tokens[0],
        organisation_id=org.id,
        document_id=row.id,
        changes={"markdown": "A local edit"},
        if_match=documents.tag(current),
        request_id="synthetic-import-edit",
    )
    replay = imports.execute(verified=tokens[0], organisation_id=org.id, source="slack", raw=raw)
    assert replay["complete"] and all(value["outcome"] == "reused" for value in replay["objects"])
    row.refresh_from_db()
    assert row.markdown == "A local edit"


def test_notion_csv_real_native_collection_types_hierarchy_and_quota_rollback(world, native_engine):
    org, workspace, _, tokens = world
    raw = archive(
        {
            "Studio.md": "# Studio\nSynthetic",
            "Studio/Tasks.csv": "Title,Estimate,Done,Due\nBuild,2,true,2026-11-13\nReview,3,false,2026-11-14\n",
        }
    )
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=2)
    report = imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)
    assert not report["complete"]
    assert Document.objects.count() == 2
    assert not CollectionRow.objects.exists()
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=10)
    report = imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)
    assert report["complete"]
    table = ImportedObject.objects.get(external_key="notion:page:Studio/Tasks.csv")
    rows = list(
        CollectionRow.objects.filter(collection_id=table.collection_id).order_by("document__title")
    )
    assert len(rows) == 2 and rows[0].values["c1"] == {"type": "number", "value": 2.0}
    assert rows[0].document.parent_id == table.document_id
    assert imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)[
        "complete"
    ]


def test_digest_defaults_off_and_revocation_between_claim_and_actual_send_wins(
    world, native_engine, settings
):
    org, _, members, tokens = world
    assert not DigestConsent.objects.exists()
    consent = digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=True)
    documents.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Visible update",
        parent_id=None,
        template_key=None,
        request_id="synthetic-digest",
    )
    settings.KODERA_OUTBOX_SEAL_KEY = KEY
    now = timezone.now()
    job = digest.enqueue_digest(
        consent_id=consent.id, period_start=now - timedelta(days=1), period_end=now
    )
    assert (
        digest.enqueue_digest(
            consent_id=consent.id, period_start=job.period_start, period_end=job.period_end
        ).id
        == job.id
    )
    with smtp_stub() as stub:
        claimed = sender.claim_next(local(stub), KEY, sender.RunReport())
        assert claimed is not None
        digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=False)
        result = sender.send_claimed(local(stub), claimed)
        sender.record_outcome(claimed, result, sender.RunReport())
        assert stub.record.connections == 0
    job.refresh_from_db()
    assert job.state == "obsolete"


def test_digest_actual_local_capture_sends_counts_without_document_plaintext(
    world, native_engine, settings
):
    org, _, _, tokens = world
    consent = digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=True)
    documents.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Private title must not be emailed",
        parent_id=None,
        template_key=None,
        request_id="synthetic-digest",
    )
    settings.KODERA_OUTBOX_SEAL_KEY = KEY
    now = timezone.now()
    digest.enqueue_digest(
        consent_id=consent.id, period_start=now - timedelta(hours=1), period_end=now
    )
    with smtp_stub() as stub:
        report = sender.run_deliveries(local(stub), key=KEY, limit=1)
        captured = list(stub.record.messages)
    assert report.sent == 1 and len(captured) == 1
    assert b"Private title" not in captured[0]
    assert b"Updated pages: 1" in captured[0]


def test_actual_native_discord_import_and_changed_source_refusal(world, native_engine):
    org, _, _, tokens = world
    data = {
        "channel": {"id": "123", "name": "studio"},
        "messages": [
            {
                "id": "456",
                "timestamp": "2026-11-13T12:00:00Z",
                "content": "Synthetic Discord content",
                "author": {"id": "789", "name": "Synthetic Author"},
            }
        ],
    }
    raw = json.dumps(data).encode()
    first = imports.execute(verified=tokens[0], organisation_id=org.id, source="discord", raw=raw)
    assert first["complete"]
    original = ImportedObject.objects.get(external_key="discord:message:123:456")
    data["messages"][0]["content"] = "Changed external source"
    second = imports.execute(
        verified=tokens[0], organisation_id=org.id, source="discord", raw=json.dumps(data).encode()
    )
    assert not second["complete"]
    assert second["objects"][1]["reason"] == "import_source_changed"
    assert "Synthetic Discord content" in Document.objects.get(id=original.document_id).markdown


def test_ambiguous_delivery_requires_explicit_bound_observation_before_retry(world, monkeypatch):
    from uuid import uuid4

    from django.db import IntegrityError, transaction

    from apps.extensions.models import DeliveryDecision

    org, _, _, tokens = world
    installation, job = queued(world)
    monkeypatch.setattr(dispatcher, "send", lambda *a: ("uncertain", None))
    dispatcher.dispatch_claim(dispatcher.claim(), Secrets())
    evidence = "urn:kodera:evidence:" + str(uuid4())
    with pytest.raises(ExtensionRefusedError, match="owner_or_admin"):
        services.reconcile(
            verified=tokens[3],
            organisation_id=org.id,
            installation_id=installation.id,
            delivery_id=job.id,
            observed="not_applied",
            evidence_ref=evidence,
        )
    decision = services.reconcile(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        delivery_id=job.id,
        observed="not_applied",
        evidence_ref=evidence,
    )
    job.refresh_from_db()
    assert job.state == "pending"
    assert (
        services.reconcile(
            verified=tokens[0],
            organisation_id=org.id,
            installation_id=installation.id,
            delivery_id=job.id,
            observed="not_applied",
            evidence_ref=evidence,
        ).id
        == decision.id
    )
    with pytest.raises(IntegrityError, match="immutable"), transaction.atomic():
        DeliveryDecision.objects.filter(id=decision.id).update(observed="applied")
    with pytest.raises(ExtensionRefusedError, match="decision_reuse"):
        services.reconcile(
            verified=tokens[0],
            organisation_id=org.id,
            installation_id=installation.id,
            delivery_id=job.id,
            observed="applied",
            evidence_ref=evidence,
        )


def test_database_refuses_delivery_payload_rewrite_and_cross_workspace_creator(world):
    from django.db import IntegrityError, transaction

    from apps.extensions.models import Installation

    org, workspace, members, tokens = world
    installation, job = queued(world)
    with pytest.raises(IntegrityError, match="digest invalid"), transaction.atomic():
        Delivery.objects.filter(id=job.id).update(event=b"forged")
    # Binding is immutable even when a second membership belongs to the same workspace.
    with pytest.raises(IntegrityError, match="binding immutable"), transaction.atomic():
        Installation.objects.filter(id=installation.id).update(creator_id=members[1].id)


def test_expired_payload_is_cut_off_purged_and_retains_only_idempotency_hash(world, monkeypatch):
    from django.db import IntegrityError, transaction

    from apps.extensions.retention import purge_due

    org, _, _, tokens = world
    installation, job = queued(world)
    claim = dispatcher.claim()
    Delivery.objects.filter(id=job.id).update(expires_at=timezone.now() - timedelta(seconds=1))
    monkeypatch.setattr(dispatcher, "send", lambda *a: pytest.fail("expired event was sent"))
    dispatcher.dispatch_claim(claim, Secrets())
    assert purge_due(limit=1) == 1
    job.refresh_from_db()
    assert job.state == "obsolete" and bytes(job.event) == b"" and job.purged_at is not None
    assert len(job.event_key) == 64 and "event-1" != job.event_key
    replay = services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        event_key="event-1",
        event_type="command.invoked",
        data={"text": "synthetic"},
    )
    assert replay.id == job.id and replay.state == "obsolete"
    with (
        pytest.raises(IntegrityError, match="purge fence invalid|evidence immutable"),
        transaction.atomic(),
    ):
        Delivery.objects.filter(id=job.id).update(expires_at=timezone.now() + timedelta(days=1))


def test_local_cutoff_fences_stale_worker_without_shortening_recovery_or_claiming_absence(
    world, monkeypatch
):
    from apps.extensions.models import WorkspaceCutoff
    from apps.extensions.retention import database_now, local_payloads_absent

    org, _, _, _ = world
    _, job = queued(world)
    original_expiry = job.expires_at
    claim = dispatcher.claim()
    WorkspaceCutoff.objects.create(organisation_id=org.id, cutoff_at=database_now())
    monkeypatch.setattr(dispatcher, "send", lambda *a: pytest.fail("cut-off worker sent"))
    dispatcher.dispatch_claim(claim, Secrets())
    job.refresh_from_db()
    assert job.state == "obsolete" and job.expires_at == original_expiry
    assert bytes(job.event) and not local_payloads_absent(organisation_id=org.id)


def test_scoped_import_metadata_refuses_erasure_without_approved_request(world, native_engine):
    from uuid import uuid4

    from django.db import IntegrityError, transaction

    from apps.extensions import retention
    from apps.extensions.models import WorkspaceCutoff

    org, _, _, tokens = world
    installation, _ = queued(world)
    raw = json.dumps({"channel": {"id": "1", "name": "studio"}, "messages": []}).encode()
    assert imports.execute(verified=tokens[0], organisation_id=org.id, source="discord", raw=raw)[
        "complete"
    ]
    assert retention.receiver_inventory(organisation_id=org.id)[0].startswith(
        "urn:kodera:extension-installation:" + str(installation.id)
    )
    with pytest.raises(IntegrityError, match="Core"), transaction.atomic():
        retention.worker_step(
            erasure_id=uuid4(),
            organisation_id=org.id,
            cutoff_at=retention.database_now(),
            inventory_sha256="1" * 64,
        )
    with pytest.raises(IntegrityError, match="retained"), transaction.atomic():
        ImportedObject.objects.all().delete()
    assert ImportedObject.objects.exists() and Document.objects.count() == 1
    assert not hasattr(retention, "cutoff_workspace") and not hasattr(
        retention, "purge_workspace_metadata"
    )
    WorkspaceCutoff.objects.create(organisation_id=org.id, cutoff_at=retention.database_now())
    with pytest.raises(ExtensionRefusedError, match="cut_off"):
        services.install(
            verified=tokens[0],
            organisation_id=org.id,
            name="Resurrection",
            endpoint="https://example.org/",
            events=["command.invoked"],
        )
    with pytest.raises(IntegrityError, match="marker immutable"), transaction.atomic():
        WorkspaceCutoff.objects.filter(organisation_id=org.id).delete()


def test_digest_revocation_serializes_through_actual_send_fence(
    world, native_engine, settings, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections

    from apps.outbox.mail.transport import SendResult

    org, _, _, tokens = world
    consent = digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=True)
    documents.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Visible metadata",
        parent_id=None,
        template_key=None,
        request_id="synthetic-concurrent-digest",
    )
    settings.KODERA_OUTBOX_SEAL_KEY = KEY
    now = timezone.now()
    digest.enqueue_digest(
        consent_id=consent.id, period_start=now - timedelta(hours=1), period_end=now
    )
    from test_outbox_mail_sender import nowhere

    claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    started, release, revoking, revoked = Event(), Event(), Event(), Event()

    def captured(*args, **kwargs):
        started.set()
        if not release.wait(1):
            raise RuntimeError("owned send fence not released")
        return SendResult(outcome="accepted", smtp_code=250)

    monkeypatch.setattr(sender.smtp, "send", captured)

    def send():
        close_old_connections()
        try:
            return sender.send_claimed(nowhere(), claimed)
        finally:
            close_old_connections()

    def revoke():
        close_old_connections()
        revoking.set()
        try:
            digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=False)
            revoked.set()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        sending = pool.submit(send)
        assert started.wait(2)
        withdrawing = pool.submit(revoke)
        assert revoking.wait(1) and not revoked.wait(0.05)
        release.set()
        result = sending.result(5)
        withdrawing.result(5)
    assert result.outcome == "accepted" and revoked.is_set()
    sender.record_outcome(claimed, result, sender.RunReport())


def test_import_operator_command_admits_real_signed_owner_stdin_and_refuses_member(
    world, native_engine, http_signer, settings, tmp_path, monkeypatch
):
    import io
    import time

    from django.core.management import call_command
    from django.core.management.base import CommandError

    org, _, _, tokens = world
    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    raw = json.dumps({"channel": {"id": "1", "name": "studio"}, "messages": []}).encode()
    archive_path = tmp_path / "synthetic-discord.json"
    archive_path.write_bytes(raw)

    def credential(index):
        return token(
            http_signer,
            org.issuer,
            subject=tokens[index].subject,
            email_verified=True,
            iat=now,
            exp=now + 300,
        )

    owner = credential(0)
    monkeypatch.setattr("sys.stdin", io.StringIO(owner + "\n"))
    output = io.StringIO()
    call_command(
        "import_workspace",
        organisation=org.id,
        source="discord",
        archive=archive_path,
        max_objects=25,
        stdout=output,
    )
    assert json.loads(output.getvalue())["complete"] and owner not in output.getvalue()
    monkeypatch.setattr("sys.stdin", io.StringIO(credential(3) + "\n"))
    with pytest.raises(CommandError, match="workspace import refused"):
        call_command(
            "import_workspace",
            organisation=org.id,
            source="discord",
            archive=archive_path,
            max_objects=25,
            stdout=io.StringIO(),
        )
