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


def test_digest_revocation_does_not_block_on_slow_smtp_and_closed_org_marks_obsolete(
    world, native_engine, settings, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections, connection
    from test_customer_persistence_concurrency import session

    from apps.outbox.mail.transport import SendResult

    org, workspace, members, tokens = world
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
    started, release, revoked = Event(), Event(), Event()
    in_tx_during_smtp = []

    def captured(*args, **kwargs):
        in_tx_during_smtp.append(connection.in_atomic_block)
        started.set()
        if not release.wait(5):
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
        try:
            digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=False)
            revoked.set()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        sending = pool.submit(send)
        assert started.wait(2)
        with session() as peer:
            peer.execute("BEGIN")
            peer.execute("SET LOCAL lock_timeout = '500ms'")
            assert peer.execute(
                "SELECT id FROM identity_user WHERE id = %s FOR UPDATE NOWAIT",
                [members[0].user_id],
            ).fetchone() == (members[0].user_id,)
            assert peer.execute(
                "SELECT id FROM orgs_organisation WHERE id = %s FOR UPDATE NOWAIT",
                [org.id],
            ).fetchone() == (org.id,)
            assert peer.execute(
                "SELECT id FROM workspaces_workspace WHERE id = %s FOR UPDATE NOWAIT",
                [workspace.id],
            ).fetchone() == (workspace.id,)
            peer.execute("ROLLBACK")
        withdrawing = pool.submit(revoke)
        assert revoked.wait(2), "consent revocation must not block on external SMTP I/O"
        release.set()
        result = sending.result(5)
        withdrawing.result(5)
    assert in_tx_during_smtp == [False]
    assert result.outcome == "accepted" and revoked.is_set()
    sender.record_outcome(claimed, result, sender.RunReport())

    # If the organisation is absent at send time, `send_guard` returns `allowed=False` cleanly
    # (recording permanent/obsolete) rather than raising `LookupError`.
    reenabled = digest.set_consent(verified=tokens[0], organisation_id=org.id, enabled=True)
    second_job = digest.enqueue_digest(
        consent_id=reenabled.id,
        period_start=now - timedelta(hours=2),
        period_end=timezone.now(),
    )
    second_claimed = sender.claim_next(nowhere(), KEY, sender.RunReport())
    assert second_claimed is not None
    monkeypatch.setattr(digest.organisations, "lock_organisation", lambda **_kw: False)
    absent_result = sender.send_claimed(nowhere(), second_claimed)
    assert absent_result.outcome == "permanent"
    second_job.refresh_from_db()
    assert second_job.state == "obsolete"


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


@pytest.mark.parametrize("change", ["removed", "changed_type"])
def test_paused_csv_resume_refuses_user_schema_changes_before_native_row_work(
    world, native_engine, monkeypatch, change
):
    from apps.docs import collections

    org, workspace, _, tokens = world
    raw = archive({"Tasks.csv": "Title,Estimate\nBuild,2\nReview,3\n"})
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=1)
    paused = imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)
    assert (
        not paused["complete"]
        and Document.objects.count() == 1
        and not CollectionRow.objects.exists()
    )
    table = ImportedObject.objects.get(external_key="notion:page:Tasks.csv")
    schema = collections.read(
        verified=tokens[0], organisation_id=org.id, collection_id=table.collection_id
    )
    properties = [dict(prop) for prop in schema["properties"]]
    properties = (
        properties[:1] if change == "removed" else [dict(prop, type="text") for prop in properties]
    )
    edited = collections.patch(
        verified=tokens[0],
        organisation_id=org.id,
        collection_id=table.collection_id,
        body={"properties": properties},
        if_match=documents.tag(schema),
        request_id="controlled-schema-edit",
    )
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=10)
    created = []
    create = documents.create

    def observed_create(**kwargs):
        created.append(kwargs["name"])
        return create(**kwargs)

    monkeypatch.setattr(documents, "create", observed_create)
    report = imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)
    assert not report["complete"] and report["objects"][0]["outcome"] == "reused"
    refused = report["objects"][1:]
    assert len(refused) == 2 and all(
        row["reason"] == "import_collection_schema_changed" and row["status"] == 409
        for row in refused
    )
    assert created == [] and Document.objects.count() == 1 and ImportedObject.objects.count() == 1
    assert not CollectionRow.objects.exists()
    current = collections.read(
        verified=tokens[0], organisation_id=org.id, collection_id=table.collection_id
    )
    assert current["properties"] == edited["properties"]
    # Restoring the original types explicitly admits the same frozen source on a later resume.
    collections.patch(
        verified=tokens[0],
        organisation_id=org.id,
        collection_id=table.collection_id,
        body={"properties": schema["properties"]},
        if_match=documents.tag(current),
        request_id="controlled-schema-restore",
    )
    resumed = imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)
    assert (
        resumed["complete"] and Document.objects.count() == 3 and CollectionRow.objects.count() == 2
    )
    assert list(CollectionRow.objects.order_by("document__title").values_list("values", flat=True))[
        0
    ]["c1"] == {"type": "number", "value": 2.0}
    assert imports.execute(verified=tokens[0], organisation_id=org.id, source="notion", raw=raw)[
        "complete"
    ]
    assert Document.objects.count() == 3 and created == ["Build", "Review"]


def test_webhook_dispatch_releases_locks_before_slow_http_and_retries_presend_errors(
    world, native_engine, monkeypatch
):
    import time
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections, connection
    from test_customer_persistence_concurrency import session

    from apps.media import outbound

    org, workspace, members, tokens = world
    _, first_job = queued(world)
    claimed = dispatcher.claim()
    assert claimed is not None

    started = Event()
    in_tx = []

    def slow_send(endpoint, signed, *, scope_key=None):
        in_tx.append(connection.in_atomic_block)
        started.set()
        time.sleep(3.5)
        return "delivered", 200

    monkeypatch.setattr(dispatcher, "send", slow_send)

    def run_dispatch():
        close_old_connections()
        try:
            dispatcher.dispatch_claim(claimed, Secrets())
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run_dispatch)
        assert started.wait(2)
        # While webhook HTTP I/O blocks for 3.5s (past 2s/3s lock_timeout budgets),
        # User, Organisation and Workspace rows are completely unlocked and document creation succeeds.
        with session() as peer:
            peer.execute("BEGIN")
            peer.execute("SET LOCAL lock_timeout = '500ms'")
            assert peer.execute(
                "SELECT id FROM identity_user WHERE id = %s FOR UPDATE NOWAIT",
                [members[0].user_id],
            ).fetchone() == (members[0].user_id,)
            assert peer.execute(
                "SELECT id FROM orgs_organisation WHERE id = %s FOR UPDATE NOWAIT",
                [org.id],
            ).fetchone() == (org.id,)
            assert peer.execute(
                "SELECT id FROM workspaces_workspace WHERE id = %s FOR UPDATE NOWAIT",
                [workspace.id],
            ).fetchone() == (workspace.id,)
            peer.execute("ROLLBACK")
        doc = documents.create(
            verified=tokens[0],
            organisation_id=org.id,
            name="Concurrent page during slow webhook",
            parent_id=None,
            template_key=None,
            request_id="concurrent-doc-under-slow-webhook",
        )
        assert doc["title"] == "Concurrent page during slow webhook"
        future.result(10)

    first_job.refresh_from_db()
    assert in_tx == [False]
    assert first_job.state == "delivered"

    # Pre-send network/DNS failures return `("retry", None)` (`pending`), while post-send
    # transport timeouts return `("uncertain", None)` (`needs_reconciliation`).
    monkeypatch.undo()
    installation = first_job.installation
    presend_job = services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        event_key="event-presend-fail",
        event_type="command.invoked",
        data={"text": "presend"},
    )
    monkeypatch.setattr(
        outbound, "target", lambda *_a, **_kw: ("hooks.example.org", 443, "/receive")
    )
    monkeypatch.setattr(
        outbound,
        "request",
        lambda *_a, **_kw: (_ for _ in ()).throw(outbound.PreSendFetchError("unavailable")),
    )
    assert dispatcher.dispatch_one(Secrets()) is True
    presend_job.refresh_from_db()
    assert presend_job.state == "pending" and presend_job.outcome == "retry"

    postsend_job = services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=installation.id,
        event_key="event-postsend-timeout",
        event_type="command.invoked",
        data={"text": "postsend"},
    )
    monkeypatch.setattr(
        outbound,
        "request",
        lambda *_a, **_kw: (_ for _ in ()).throw(outbound.FetchError("timeout")),
    )
    assert dispatcher.dispatch_one(Secrets()) is True
    postsend_job.refresh_from_db()
    assert postsend_job.state == "needs_reconciliation" and postsend_job.outcome == "uncertain"


def test_extension_admin_digest_and_dispatch_share_canonical_user_org_workspace_lock_order(
    world, monkeypatch
):
    import time
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections
    from test_customer_persistence_concurrency import session

    org, workspace, members, tokens = world
    installation, job = queued(world)
    monkeypatch.setattr(dispatcher, "send", lambda *_a, **_kw: ("delivered", 200))

    def run_rotate():
        close_old_connections()
        try:
            return services.rotate(
                verified=tokens[0],
                organisation_id=org.id,
                installation_id=installation.id,
                grace_expires_at=timezone.now() + timedelta(minutes=5),
            )
        finally:
            close_old_connections()

    def run_consent():
        close_old_connections()
        try:
            return digest.set_consent(
                verified=tokens[0],
                organisation_id=org.id,
                enabled=True,
                locale="en",
            )
        finally:
            close_old_connections()

    def run_dispatch():
        close_old_connections()
        try:
            return dispatcher.dispatch_one(Secrets())
        finally:
            close_old_connections()

    with session() as gate, ThreadPoolExecutor(max_workers=3) as pool:
        gate.execute("BEGIN")
        gate.execute("SET LOCAL lock_timeout = '5s'")
        gate.execute(
            "SELECT id FROM identity_user WHERE id = %s FOR UPDATE",
            [members[0].user_id],
        )

        futures = [
            pool.submit(run_rotate),
            pool.submit(run_consent),
            pool.submit(run_dispatch),
        ]

        deadline = time.monotonic() + 2.0
        waiting = 0
        while time.monotonic() < deadline:
            row = gate.execute("SELECT count(*) FROM pg_locks WHERE NOT granted").fetchone()
            waiting = int(row[0]) if row else 0
            if waiting >= 3:
                break
            time.sleep(0.02)
        assert waiting >= 3, f"expected all 3 writers waiting on identity_user first, got {waiting}"

        # Because every writer acquires `User -> Organisation -> Workspace`, neither Organisation
        # nor Workspace is held by any writer while queued behind `identity_user`.
        assert gate.execute(
            "SELECT id FROM orgs_organisation WHERE id = %s FOR UPDATE NOWAIT",
            [org.id],
        ).fetchone() == (org.id,)
        assert gate.execute(
            "SELECT id FROM workspaces_workspace WHERE id = %s FOR UPDATE NOWAIT",
            [workspace.id],
        ).fetchone() == (workspace.id,)
        gate.execute("ROLLBACK")

        rotated, consent_state, dispatched = [f.result(5) for f in futures]

    assert rotated.previous_generation is not None
    assert consent_state.enabled is True
    assert dispatched is True
    job.refresh_from_db()
    assert job.state == "delivered"


def test_import_parser_clean_linear_time_under_adversarial_markdown():
    import time

    from apps.extensions import import_parsers

    class TrackedStr(str):
        __slots__ = ("scans",)

        def __new__(cls, value: str):
            obj = super().__new__(cls, value)
            object.__setattr__(obj, "scans", 0)
            return obj

        def find(self, sub, start=0, end=None):
            n = len(self) if end is None else min(len(self), end)
            s = max(0, start)
            pos = super().find(sub, start, end)
            scanned = (pos - s + len(sub)) if pos != -1 else max(0, n - s)
            object.__setattr__(self, "scans", self.scans + scanned)
            return pos

    for payload in ("!" + "![" * 29999, "[" * 60000, "[]()" * 15000):
        t0 = time.perf_counter()
        result = import_parsers.clean(payload)
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.05, f"import_parsers.clean took {elapsed:.4f}s (>= 50ms)"
        assert len(result) <= len(payload)

    for repeats in (1000, 2000, 4000, 15000):
        tracked = TrackedStr("[]()" * repeats)
        cleaned = import_parsers.clean(tracked)
        assert cleaned == ""
        assert tracked.scans <= 4 * len(tracked)
