"""Offline unit, boundary, and fail-closed refusal suite for restore rehearsal guards."""

from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock
from uuid import UUID, uuid4

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings

from apps.billing import services as billing_services
from apps.e2ee import services as e2ee_services
from apps.extensions import services as extension_services
from apps.identity import services as identity_services
from apps.media import services as media_services
from apps.notifications import services as notification_services
from apps.orgs.account_erasure_services import AccountErasureScope
from apps.orgs.object_erasure import ObjectUploadWindowOpenError
from apps.orgs.restore_rehearsal import (
    DjangoRestoreRehearsalBackend,
    ErasureLedger,
    ErasureReplaySummary,
    OutboundDisarmSummary,
    RehearsalIsolatedUploadDrainVerifier,
    RehearsalManifestObjectDeleter,
    RestoreRehearsalError,
    S3InventoryManifest,
    execute_restore_guards,
    parse_erasure_ledger,
    parse_s3_manifest,
    read_json_file_nofollow,
    reconcile_attachments_with_s3_manifest,
)
from apps.outbox import services as outbox_services
from apps.support import services as support_services


@dataclass
class _InMemoryRehearsalBackend:
    """Deterministic in-memory backend exercising full restore-rehearsal state transitions."""

    now: datetime = field(default_factory=lambda: datetime(2026, 11, 23, 12, 0, tzinfo=UTC))
    call_order: list[str] = field(default_factory=list)
    active_installations: int = 3
    pending_deliveries: int = 4
    in_flight_deliveries: int = 2
    active_coexistence_bridges: int = 2
    sealed_bridge_secrets: list[bytes] = field(
        default_factory=lambda: [b"sealed-secret-1", b"sealed-secret-2"]
    )
    outbound_replay_guards: int = 5
    pending_digest_jobs: int = 1
    pending_push_outbox: int = 6
    active_push_subscriptions: int = 3
    pending_outbox_deliveries: int = 4
    sealed_outbox_messages: int = 4
    open_outbox_attempts: int = 1
    pending_bug_reports: int = 2
    pending_support_tickets: int = 1
    active_or_cancelled_payment_links: int = 3

    organisations: set[UUID] = field(default_factory=set)
    users: set[UUID] = field(default_factory=set)
    workspace_cutoffs: set[UUID] = field(default_factory=set)
    erased_orgs: set[UUID] = field(default_factory=set)
    erased_users: set[UUID] = field(default_factory=set)
    erased_attachments: set[UUID] = field(default_factory=set)
    attachments: list[media_services.CompletedAttachmentSnapshot] = field(default_factory=list)
    inject_residual_org_pii: bool = False
    inject_residual_user_pii: bool = False

    def replay_erasure_ledger(
        self,
        ledger: ErasureLedger,
        *,
        actor_identity_id: UUID | None = None,
        s3_manifest: S3InventoryManifest | None = None,
    ) -> ErasureReplaySummary:
        del actor_identity_id, s3_manifest
        self.call_order.append("replay_erasure_ledger")
        if ledger.backup_created_at > self.now:
            raise RestoreRehearsalError(
                "backup_created_at is in the future",
                code="backup_created_at_in_future",
            )
        for org_entry in ledger.organisation_entries:
            oid = org_entry.organisation_id
            self.organisations.discard(oid)
            self.erased_orgs.add(oid)
            self.workspace_cutoffs.add(oid)
            if not self.inject_residual_org_pii:
                self.attachments = [a for a in self.attachments if a.organisation_id != oid]
            else:
                raise RestoreRehearsalError(
                    "residual organisation PII detected",
                    code="residual_organisation_pii",
                    unresolved_domains=("support_tickets",),
                )

        for user_entry in ledger.user_entries:
            uid = user_entry.user_id
            self.users.discard(uid)
            self.erased_users.add(uid)
            self.erased_attachments.update(user_entry.erased_attachment_ids)
            if not self.inject_residual_user_pii:
                self.attachments = [
                    a for a in self.attachments if a.id not in user_entry.erased_attachment_ids
                ]
            else:
                raise RestoreRehearsalError(
                    "residual user PII detected",
                    code="residual_user_pii",
                    unresolved_domains=("support_tickets", "workspace_invitations"),
                )
            # Replaying account erasure enqueues a realm access_off outbox delivery, which
            # subsequent disarm_outbound() must neutralize!
            self.pending_outbox_deliveries += 1

        return ErasureReplaySummary(
            backup_created_at=ledger.backup_created_at.isoformat().replace("+00:00", "Z"),
            organisations_replayed=len(ledger.organisation_entries),
            users_replayed=len(ledger.user_entries),
            workspace_cutoffs_verified=len(ledger.organisation_entries),
            zero_residual_pii_verified=True,
        )

    def disarm_outbound(self) -> OutboundDisarmSummary:
        self.call_order.append("disarm_outbound")
        inst_revoked = self.active_installations
        self.active_installations = 0

        deliv_obs = self.pending_deliveries + self.in_flight_deliveries
        self.pending_deliveries = 0
        self.in_flight_deliveries = 0

        bridges_revoked = self.active_coexistence_bridges
        self.active_coexistence_bridges = 0
        secrets_zeroized = sum(1 for s in self.sealed_bridge_secrets if s != b"")
        self.sealed_bridge_secrets = [b"" for _ in self.sealed_bridge_secrets]

        replay_obs = self.outbound_replay_guards
        self.outbound_replay_guards = 0

        digest_obs = self.pending_digest_jobs
        self.pending_digest_jobs = 0

        push_obs = self.pending_push_outbox
        self.pending_push_outbox = 0
        push_rev = self.active_push_subscriptions
        self.active_push_subscriptions = 0

        outbox_canc = self.pending_outbox_deliveries
        self.pending_outbox_deliveries = 0
        outbox_msg = self.sealed_outbox_messages
        self.sealed_outbox_messages = 0
        outbox_att = self.open_outbox_attempts
        self.open_outbox_attempts = 0

        bugs_disarmed = self.pending_bug_reports
        self.pending_bug_reports = 0
        tickets_disarmed = self.pending_support_tickets
        self.pending_support_tickets = 0
        paylinks_disarmed = self.active_or_cancelled_payment_links
        self.active_or_cancelled_payment_links = 0

        return OutboundDisarmSummary(
            installations_revoked=inst_revoked,
            deliveries_obsoleted=deliv_obs,
            coexistence_bridges_revoked=bridges_revoked,
            coexistence_secrets_zeroized=secrets_zeroized,
            coexistence_outbound_obsoleted=replay_obs,
            digest_jobs_obsoleted=digest_obs,
            push_outbox_disarmed=push_obs,
            push_subscriptions_revoked=push_rev,
            outbox_deliveries_cancelled=outbox_canc,
            outbox_messages_cleared=outbox_msg,
            outbox_attempts_abandoned=outbox_att,
            bug_reports_disarmed=bugs_disarmed,
            support_tickets_disarmed=tickets_disarmed,
            payment_links_disarmed=paylinks_disarmed,
        )

    def collect_s3_reconciliation_state(
        self,
        *,
        extra_erased_org_ids: set[UUID],
        extra_erased_user_ids: set[UUID],
        extra_erased_attachment_ids: set[UUID],
    ) -> tuple[
        tuple[media_services.CompletedAttachmentSnapshot, ...],
        set[UUID],
        set[UUID],
        set[UUID],
    ]:
        self.call_order.append("collect_s3_reconciliation_state")
        return (
            tuple(self.attachments),
            set(self.erased_orgs) | set(self.workspace_cutoffs) | extra_erased_org_ids,
            set(self.erased_users) | extra_erased_user_ids,
            set(self.erased_attachments) | extra_erased_attachment_ids,
        )


def _make_attachment(
    org_id: UUID,
    att_id: UUID | None = None,
    *,
    size_bytes: int = 4096,
    sha256: str | None = None,
) -> media_services.CompletedAttachmentSnapshot:
    resolved_id = att_id or uuid4()
    digest = sha256 or hashlib.sha256(f"{org_id}:{resolved_id}".encode()).hexdigest()
    return media_services.CompletedAttachmentSnapshot(
        id=resolved_id,
        organisation_id=org_id,
        uploader_id=uuid4(),
        channel_id=None,
        room_id=None,
        filename="report.pdf",
        content_type="application/pdf",
        size_bytes=size_bytes,
        sha256=digest,
    )


class TestFileAndSchemaValidation:
    def test_read_json_file_nofollow_refuses_leaf_and_ancestor_symlinks_traversal_and_dup_keys(
        self, tmp_path: Path
    ) -> None:
        real_dir = tmp_path / "real-dir"
        real_dir.mkdir()
        real_file = real_dir / "ledger.json"
        real_file.write_text('{"backup_created_at":"2026-11-23T00:00:00Z"}', encoding="utf-8")

        # Leaf symlink refused via O_NOFOLLOW.
        link_file = tmp_path / "ledger-link.json"
        link_file.symlink_to(real_file)
        with pytest.raises(RestoreRehearsalError) as exc_link:
            read_json_file_nofollow(link_file, label="erasure ledger")
        assert exc_link.value.code == "symlink_input_refused"

        # Ancestor directory symlink refused via retained dir_fd O_DIRECTORY | O_NOFOLLOW!
        link_dir = tmp_path / "linked-dir"
        link_dir.symlink_to(real_dir)
        with pytest.raises(RestoreRehearsalError) as exc_anc:
            read_json_file_nofollow(link_dir / "ledger.json", label="erasure ledger")
        assert exc_anc.value.code == "symlink_input_refused"

        # Parent-directory `..` traversal refused before lexical collapse.
        with pytest.raises(RestoreRehearsalError) as exc_dotdot:
            read_json_file_nofollow(real_dir / ".." / "real-dir" / "ledger.json", label="ledger")
        assert exc_dotdot.value.code == "symlink_input_refused"

        sub_dir = tmp_path / "a-dir"
        sub_dir.mkdir()
        with pytest.raises(RestoreRehearsalError) as exc_dir:
            read_json_file_nofollow(sub_dir, label="erasure ledger")
        assert exc_dir.value.code in ("non_regular_file_refused", "unreadable_input_file")

        dup_file = tmp_path / "dup.json"
        dup_file.write_text('{"a": 1, "a": 2}', encoding="utf-8")
        with pytest.raises(RestoreRehearsalError) as exc_dup:
            read_json_file_nofollow(dup_file, label="S3 manifest")
        assert exc_dup.value.code == "duplicate_json_key"

        nan_file = tmp_path / "nan.json"
        nan_file.write_text('{"a": NaN}', encoding="utf-8")
        with pytest.raises(RestoreRehearsalError) as exc_nan:
            read_json_file_nofollow(nan_file, label="S3 manifest")
        assert exc_nan.value.code == "invalid_json"

    def test_parse_erasure_ledger_validates_timestamps_uuids_and_duplicates(self) -> None:
        org_a = uuid4()
        user_a = uuid4()
        att_a = uuid4()
        ledger = parse_erasure_ledger(
            {
                "backup_created_at": "2026-11-23T01:00:00Z",
                "organisation_references": [str(org_a)],
                "user_references": [
                    {
                        "user_id": str(user_a),
                        "instruction_ref": "DEL-42",
                        "instruction_sha256": "a" * 64,
                        "erased_at": "2026-11-23T02:00:00+00:00",
                        "erased_attachment_ids": [str(att_a)],
                    }
                ],
            }
        )
        assert ledger.organisation_ids == (org_a,)
        assert ledger.user_ids == (user_a,)
        assert ledger.erased_attachment_ids == (att_a,)

        with pytest.raises(RestoreRehearsalError) as exc_naive:
            parse_erasure_ledger({"backup_created_at": "2026-11-23T01:00:00"})
        assert exc_naive.value.code == "naive_timestamp_refused"

        with pytest.raises(RestoreRehearsalError) as exc_dup:
            parse_erasure_ledger(
                {
                    "backup_created_at": "2026-11-23T01:00:00Z",
                    "organisation_references": [str(org_a), str(org_a)],
                }
            )
        assert exc_dup.value.code == "duplicate_erasure_subject"

        with pytest.raises(RestoreRehearsalError) as exc_ref:
            parse_erasure_ledger(
                {
                    "backup_created_at": "2026-11-23T01:00:00Z",
                    "organisation_references": [
                        {"organisation_id": str(org_a), "instruction_ref": "bad ref!"}
                    ],
                }
            )
        assert exc_ref.value.code == "invalid_instruction_ref"

    @pytest.mark.parametrize("bad_size", [True, False, 1024.0, 0, -5, "1024"])
    def test_parse_s3_manifest_rejects_non_strict_positive_int_sizes(
        self, bad_size: object
    ) -> None:
        org_id = uuid4()
        att_id = uuid4()
        with pytest.raises(RestoreRehearsalError) as exc_size:
            parse_s3_manifest(
                {
                    "objects": [
                        {
                            "organisation_id": str(org_id),
                            "id": str(att_id),
                            "size_bytes": bad_size,
                            "sha256": "b" * 64,
                        }
                    ]
                }
            )
        assert exc_size.value.code == "invalid_s3_object_size"

    def test_parse_s3_manifest_rejects_scope_mismatch_duplicate_and_unclassified_keys(self) -> None:
        org_1, org_2 = uuid4(), uuid4()
        att_1 = uuid4()
        key = f"organisations/{org_1}/attachments/{att_1}"
        with pytest.raises(RestoreRehearsalError) as exc_mismatch:
            parse_s3_manifest(
                {
                    "objects": [
                        {
                            "key": key,
                            "organisation_id": str(org_2),
                            "size_bytes": 128,
                            "sha256": "c" * 64,
                        }
                    ]
                }
            )
        assert exc_mismatch.value.code == "s3_key_scope_mismatch"

        with pytest.raises(RestoreRehearsalError) as exc_dup:
            parse_s3_manifest(
                {
                    "objects": [
                        {"key": key, "size_bytes": 128, "sha256": "c" * 64},
                        {
                            "organisation_id": str(org_1),
                            "id": str(att_1),
                            "size_bytes": 128,
                            "sha256": "c" * 64,
                        },
                    ]
                }
            )
        assert exc_dup.value.code == "duplicate_s3_object_key"

        # Non-canonical / unclassified bucket object key fails closed (`P2-7`).
        with pytest.raises(RestoreRehearsalError) as exc_unclass_key:
            parse_s3_manifest(
                {
                    "objects": [
                        {
                            "key": "orphans/unclassified-archive.tar",
                            "size_bytes": 256,
                            "sha256": "d" * 64,
                        }
                    ]
                }
            )
        assert exc_unclass_key.value.code == "unclassified_s3_objects"


class TestS3AttachmentReconciliation:
    def test_reconciles_exact_inventory_and_fails_closed_on_missing_mismatch_or_unclassified(
        self,
    ) -> None:
        org_live = uuid4()
        att_ok = _make_attachment(org_live, size_bytes=2048, sha256="1" * 64)
        untracked_att_id = uuid4()

        manifest_ok = parse_s3_manifest(
            {
                "objects": [
                    {
                        "key": f"organisations/{org_live}/attachments/{att_ok.id}",
                        "size_bytes": 2048,
                        "sha256": "1" * 64,
                    }
                ]
            }
        )
        summary = reconcile_attachments_with_s3_manifest(
            completed_attachments=[att_ok],
            manifest=manifest_ok,
            erased_organisation_ids=set(),
            erased_user_ids=set(),
            erased_attachment_ids=set(),
        )
        assert summary.reconciled is True
        assert summary.completed_attachments_checked == 1
        assert summary.manifest_objects_inspected == 1
        assert summary.untracked_s3_objects == 0

        # Unclassified / unmatched S3 object without completed DB attachment -> fails closed (`P2-7`)!
        manifest_with_untracked = parse_s3_manifest(
            {
                "objects": [
                    {
                        "key": f"organisations/{org_live}/attachments/{att_ok.id}",
                        "size_bytes": 2048,
                        "sha256": "1" * 64,
                    },
                    {
                        "key": f"organisations/{org_live}/attachments/{untracked_att_id}",
                        "size_bytes": 512,
                        "sha256": "2" * 64,
                    },
                ]
            }
        )
        with pytest.raises(RestoreRehearsalError) as exc_untracked:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[att_ok],
                manifest=manifest_with_untracked,
                erased_organisation_ids=set(),
                erased_user_ids=set(),
                erased_attachment_ids=set(),
            )
        assert exc_untracked.value.code == "unclassified_s3_objects"

        # Missing S3 object -> fails closed!
        with pytest.raises(RestoreRehearsalError) as exc_missing:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[att_ok],
                manifest=parse_s3_manifest({"objects": []}),
                erased_organisation_ids=set(),
                erased_user_ids=set(),
                erased_attachment_ids=set(),
            )
        assert exc_missing.value.code == "missing_s3_objects"

        # Size mismatch -> fails closed!
        with pytest.raises(RestoreRehearsalError) as exc_size:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[att_ok],
                manifest=parse_s3_manifest(
                    {
                        "objects": [
                            {
                                "organisation_id": str(org_live),
                                "id": str(att_ok.id),
                                "size_bytes": 2049,
                                "sha256": "1" * 64,
                            }
                        ]
                    }
                ),
                erased_organisation_ids=set(),
                erased_user_ids=set(),
                erased_attachment_ids=set(),
            )
        assert exc_size.value.code == "mismatched_s3_objects"

        # SHA-256 mismatch -> fails closed!
        with pytest.raises(RestoreRehearsalError) as exc_sha:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[att_ok],
                manifest=parse_s3_manifest(
                    {
                        "objects": [
                            {
                                "organisation_id": str(org_live),
                                "id": str(att_ok.id),
                                "size_bytes": 2048,
                                "sha256": "f" * 64,
                            }
                        ]
                    }
                ),
                erased_organisation_ids=set(),
                erased_user_ids=set(),
                erased_attachment_ids=set(),
            )
        assert exc_sha.value.code == "mismatched_s3_objects"

    def test_fails_closed_on_unpurged_s3_objects_for_erased_org_or_account(self) -> None:
        erased_org = uuid4()
        live_org = uuid4()
        erased_user = uuid4()
        erased_personal_att = uuid4()

        with pytest.raises(RestoreRehearsalError) as exc_org_s3:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[],
                manifest=parse_s3_manifest(
                    {
                        "objects": [
                            {
                                "organisation_id": str(erased_org),
                                "id": str(uuid4()),
                                "size_bytes": 100,
                                "sha256": "a" * 64,
                            }
                        ]
                    }
                ),
                erased_organisation_ids={erased_org},
                erased_user_ids=set(),
                erased_attachment_ids=set(),
            )
        assert exc_org_s3.value.code == "unpurged_erased_s3_objects"

        with pytest.raises(RestoreRehearsalError) as exc_acct_att:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[],
                manifest=parse_s3_manifest(
                    {
                        "objects": [
                            {
                                "organisation_id": str(live_org),
                                "id": str(erased_personal_att),
                                "size_bytes": 100,
                                "sha256": "b" * 64,
                            }
                        ]
                    }
                ),
                erased_organisation_ids=set(),
                erased_user_ids=set(),
                erased_attachment_ids={erased_personal_att},
            )
        assert exc_acct_att.value.code == "unpurged_erased_s3_objects"

        with pytest.raises(RestoreRehearsalError) as exc_user_tag:
            reconcile_attachments_with_s3_manifest(
                completed_attachments=[],
                manifest=parse_s3_manifest(
                    {
                        "objects": [
                            {
                                "organisation_id": str(live_org),
                                "id": str(uuid4()),
                                "user_id": str(erased_user),
                                "size_bytes": 100,
                                "sha256": "c" * 64,
                            }
                        ]
                    }
                ),
                erased_organisation_ids=set(),
                erased_user_ids={erased_user},
                erased_attachment_ids=set(),
            )
        assert exc_user_tag.value.code == "unpurged_erased_s3_objects"


class TestRestoreGuardsOrchestrationAndCli:
    def test_cross_app_disarm_helpers_require_enclosing_atomic_transaction(self) -> None:
        now = datetime.now(UTC)
        with mock.patch("django.db.connection.in_atomic_block", False):
            with pytest.raises(RuntimeError, match="atomic transaction"):
                extension_services.disarm_rehearsal_outbound(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                notification_services.disarm_rehearsal_outbound(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                outbox_services.disarm_rehearsal_outbound(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                support_services.disarm_rehearsal_outbound(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                billing_services.disarm_rehearsal_outbound(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                notification_services.drain_snapshot_in_flight_leases(now=now)
            with pytest.raises(RuntimeError, match="atomic transaction"):
                outbox_services.drain_snapshot_in_flight_leases(now=now)

    def test_rehearsal_object_deleter_and_upload_drain_adapters(self) -> None:
        org_id = uuid4()
        att_id = uuid4()
        user_id = uuid4()
        key = f"organisations/{org_id}/attachments/{att_id}"

        # Absent from S3 manifest -> deleted=True without live gateway socket (`P1-4`).
        deleter_ok = RehearsalManifestObjectDeleter(manifest_keys=frozenset())
        assert deleter_ok(key) == {"deleted": True}
        assert deleter_ok.verified_absent_keys == [key]

        # Still present in S3 manifest -> fails closed (`unpurged_erased_s3_objects`)!
        deleter_present = RehearsalManifestObjectDeleter(manifest_keys=frozenset({key}))
        with pytest.raises(RestoreRehearsalError) as exc_unpurged:
            deleter_present(key)
        assert exc_unpurged.value.code == "unpurged_erased_s3_objects"

        # Upload drain verifier enforces 300s drain window and returns 64-hex sha256 when drained.
        now = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)
        scope = AccountErasureScope(
            request_id=uuid4(),
            user_id=user_id,
            cutoff_at=now,
            inventory={"account_personal_attachments": []},
        )
        verifier = RehearsalIsolatedUploadDrainVerifier(in_flight_inspector=lambda _keys: False)
        with mock.patch("apps.orgs.object_erasure.database_now", return_value=now):
            digest = verifier.verify_drained(scope, (key,), now - timedelta(seconds=600))
            assert len(digest) == 64
            with pytest.raises(ObjectUploadWindowOpenError):
                verifier.verify_drained(scope, (key,), now - timedelta(seconds=60))

    def test_end_to_end_guards_replay_erasures_before_disarm_and_reconcile_s3(
        self, tmp_path: Path
    ) -> None:
        org_keep = uuid4()
        org_erased = uuid4()
        user_erased = uuid4()
        att_keep = _make_attachment(org_keep, size_bytes=8192, sha256="9" * 64)
        att_erased_org = _make_attachment(org_erased, size_bytes=1024, sha256="8" * 64)
        att_erased_user = _make_attachment(org_keep, size_bytes=512, sha256="7" * 64)

        backend = _InMemoryRehearsalBackend(
            organisations={org_keep, org_erased},
            users={user_erased},
            attachments=[att_keep, att_erased_org, att_erased_user],
        )

        ledger_path = tmp_path / "erasure-ledger.json"
        ledger_path.write_text(
            json.dumps(
                {
                    "backup_created_at": "2026-11-23T10:00:00Z",
                    "organisation_references": [str(org_erased)],
                    "user_references": [
                        {
                            "user_id": str(user_erased),
                            "erased_attachment_ids": [str(att_erased_user.id)],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        s3_path = tmp_path / "s3-manifest.json"
        s3_path.write_text(
            json.dumps(
                {
                    "objects": [
                        {
                            "key": f"organisations/{org_keep}/attachments/{att_keep.id}",
                            "size_bytes": 8192,
                            "sha256": "9" * 64,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        out = io.StringIO()
        call_command(
            "rehearse_restore_guards",
            disarm_outbound=True,
            erasure_ledger=ledger_path,
            s3_manifest=s3_path,
            _backend_factory=lambda: backend,
            stdout=out,
        )
        report = json.loads(out.getvalue())

        assert backend.call_order == [
            "replay_erasure_ledger",
            "disarm_outbound",
            "collect_s3_reconciliation_state",
        ]
        assert report["status"] == "ok"
        assert report["outbound_disarmed"] is True
        assert backend.active_installations == 0
        assert backend.pending_deliveries == 0
        assert backend.in_flight_deliveries == 0
        assert backend.active_coexistence_bridges == 0
        assert backend.sealed_bridge_secrets == [b"", b""]
        assert backend.outbound_replay_guards == 0
        assert backend.pending_push_outbox == 0
        assert backend.pending_outbox_deliveries == 0
        assert backend.pending_bug_reports == 0
        assert backend.active_or_cancelled_payment_links == 0
        assert org_erased in backend.workspace_cutoffs
        assert report["disarm_summary"]["outbox_deliveries_cancelled"] == 5
        assert report["disarm_summary"]["bug_reports_disarmed"] == 2
        assert report["disarm_summary"]["payment_links_disarmed"] == 3
        assert report["erasure_replay"]["organisations_replayed"] == 1
        assert report["erasure_replay"]["users_replayed"] == 1
        assert report["erasure_replay"]["zero_residual_pii_verified"] is True
        assert report["s3_reconciliation"]["reconciled"] is True

    def test_command_fails_closed_on_residual_pii_future_backup_or_no_flags(
        self, tmp_path: Path
    ) -> None:
        with pytest.raises(CommandError, match="no_guards_selected"):
            call_command(
                "rehearse_restore_guards",
                _backend_factory=_InMemoryRehearsalBackend,
            )

        future_ledger = tmp_path / "future.json"
        future_ts = (datetime(2026, 11, 23, 12, 0, tzinfo=UTC) + timedelta(hours=2)).isoformat()
        future_ledger.write_text(
            json.dumps({"backup_created_at": future_ts, "organisation_references": []}),
            encoding="utf-8",
        )
        with pytest.raises(CommandError, match="backup_created_at_in_future"):
            call_command(
                "rehearse_restore_guards",
                erasure_ledger=future_ledger,
                _backend_factory=_InMemoryRehearsalBackend,
            )

        org_residual = uuid4()
        residual_ledger = tmp_path / "residual.json"
        residual_ledger.write_text(
            json.dumps(
                {
                    "backup_created_at": "2026-11-23T09:00:00Z",
                    "organisation_references": [str(org_residual)],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(
            CommandError, match=r"residual_organisation_pii.*unresolved_domains=support_tickets"
        ):
            call_command(
                "rehearse_restore_guards",
                disarm_outbound=True,
                erasure_ledger=residual_ledger,
                _backend_factory=lambda: _InMemoryRehearsalBackend(inject_residual_org_pii=True),
            )

        with (
            override_settings(INSTALLED_APPS=["apps.orgs", "apps.identity"]),
            pytest.raises(CommandError, match="config.settings.deploy_operator"),
        ):
            call_command("rehearse_restore_guards", disarm_outbound=True)

    def test_partially_cleared_person_still_verifies_and_scrubs_all_local_pii_domains(self) -> None:
        """Even when `is_user_pii_purged` is True, residual PII in other local domains fails closed (`P1-5`)."""
        backend = DjangoRestoreRehearsalBackend()
        org_id = uuid4()
        user_id = uuid4()

        with mock.patch.object(extension_services, "has_workspace_cutoff", return_value=False):
            with pytest.raises(RestoreRehearsalError) as exc_cutoff:
                backend._verify_zero_residual_organisation(org_id)
            assert exc_cutoff.value.code == "missing_workspace_cutoff"
            assert exc_cutoff.value.unresolved_domains == ("workspace_cutoff",)

        # Even if `is_user_pii_purged` returns True (contact fields already cleared), residual
        # Passport records, support tickets, workspace invitations, private exports, sealed outbox
        # mail, E2EE devices, EE SCIM/SAML/audit rows, and un-pseudonymized retained identity
        # subjects are ALL detected and reported!
        with (
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.is_user_pii_purged",
                return_value=True,
            ),
            mock.patch("apps.orgs.restore_rehearsal.Membership.objects.filter") as mock_mem_filter,
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.count_unerased_identities_for_user",
                return_value=0,
            ),
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.count_unscrubbed_identity_subjects_for_user",
                return_value=1,
            ),
            mock.patch.object(backend, "_count_user_idempotency_records", return_value=0),
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.count_residual_passport_for_user",
                return_value=1,
            ),
            mock.patch.object(
                support_services, "count_unscrubbed_tickets_for_user", return_value=2
            ),
            mock.patch.object(backend, "_count_user_unscrubbed_invitations", return_value=1),
            mock.patch(
                "apps.orgs.restore_rehearsal.PrivacyExport.objects.filter"
            ) as mock_exp_filter,
            mock.patch.object(
                outbox_services, "count_residual_personal_outbox_for_user", return_value=1
            ),
            mock.patch.object(
                notification_services, "count_residual_rows_for_user", return_value=0
            ),
            mock.patch(
                "apps.orgs.restore_rehearsal.workspace_services.count_residual_experience_rows_for_user",
                return_value=0,
            ),
            mock.patch.object(media_services, "count_residual_user_attachment_pii", return_value=0),
            mock.patch.object(e2ee_services, "count_residual_e2ee_for_user", return_value=1),
            mock.patch.object(backend, "_count_user_residual_ee", return_value=1),
        ):
            mock_mem_filter.return_value.exclude.return_value.exclude.return_value.count.return_value = 0
            mock_exp_filter.return_value.exclude.return_value.count.return_value = 1
            with pytest.raises(RestoreRehearsalError) as exc_partial:
                backend._verify_zero_residual_user(user_id, personal_attachment_ids=())
            assert exc_partial.value.code == "residual_user_pii"
            assert exc_partial.value.unresolved_domains == (
                "retained_identity_subjects",
                "passport_records",
                "support_tickets",
                "workspace_invitations",
                "private_exports",
                "sealed_outbox_mail",
                "e2ee_resources",
                "enterprise_identity_and_audit",
            )

        # Verify `replay_erasure_ledger` drains frozen snapshot `in_flight` leases FIRST and then
        # invokes `_scrub_partially_cleared_person_domains` when `User` exists with `enabled=False`!
        ledger = parse_erasure_ledger(
            {
                "backup_created_at": "2026-11-23T09:00:00Z",
                "organisation_references": [],
                "user_references": [str(user_id)],
            }
        )
        events: list[str] = []

        def _fake_drain() -> dict[str, int]:
            events.append("drain_in_flight_leases")
            return {}

        def _fake_scrub_partial(
            *_a: object, **_kw: object
        ) -> tuple[tuple[str, ...], tuple[str, ...]]:
            events.append("scrub_partial")
            return ((), ())

        def _fake_verify_user(*_a: object, **_kw: object) -> None:
            events.append("verify_user")

        with (
            mock.patch(
                "apps.orgs.restore_rehearsal.database_now",
                return_value=datetime(2026, 11, 23, 12, 0, tzinfo=UTC),
            ),
            mock.patch.object(
                identity_services, "ensure_rehearsal_operator_identity", return_value=uuid4()
            ),
            mock.patch.object(
                backend,
                "drain_in_flight_leases",
                side_effect=_fake_drain,
            ) as mock_drain_in_flight,
            mock.patch("apps.orgs.restore_rehearsal.AccountErasure.objects.filter") as mock_ae,
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.user_exists", return_value=True
            ),
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.enabled_user", return_value=False
            ),
            mock.patch.object(
                backend,
                "_scrub_partially_cleared_person_domains",
                side_effect=_fake_scrub_partial,
            ) as mock_scrub_partial,
            mock.patch.object(
                backend,
                "_verify_zero_residual_user",
                side_effect=_fake_verify_user,
            ) as mock_verify_user,
        ):
            mock_ae.return_value.first.return_value = None
            summary = backend.replay_erasure_ledger(ledger)
            assert summary.users_replayed == 1
            assert summary.zero_residual_pii_verified is True
            mock_drain_in_flight.assert_called_once()
            mock_scrub_partial.assert_called_once()
            mock_verify_user.assert_called_once()
            assert events == ["drain_in_flight_leases", "scrub_partial", "verify_user"]

    def test_partially_cleared_scrub_orders_ee_and_passport_before_identity_email_wipe(
        self,
    ) -> None:
        """Prove EE SCIM/SAML & Passport/outbox scrubs run BEFORE `identity_identity.email` is overwritten."""
        backend = DjangoRestoreRehearsalBackend()
        uid = uuid4()
        step_order: list[str] = []

        def _record_none(step: str) -> Callable[..., None]:
            def _inner(*_a: object, **_kw: object) -> None:
                step_order.append(step)

            return _inner

        def _record_int(step: str) -> Callable[..., int]:
            def _inner(*_a: object, **_kw: object) -> int:
                step_order.append(step)
                return 0

            return _inner

        fake_cursor = mock.MagicMock()
        fake_cursor.fetchone.return_value = (False,)
        cursor_cm = mock.MagicMock()
        cursor_cm.__enter__.return_value = fake_cursor
        cursor_cm.__exit__.return_value = False

        with (
            mock.patch(
                "apps.orgs.restore_rehearsal.database_now",
                return_value=datetime(2026, 11, 23, 12, 0, tzinfo=UTC),
            ),
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.person_email_sha256s",
                return_value=("a" * 64,),
            ),
            mock.patch(
                "apps.orgs.restore_rehearsal.identity_selectors.person_principal_sha256s",
                return_value=("b" * 64,),
            ),
            mock.patch.object(
                media_services, "list_personal_attachments_for_user", return_value=()
            ),
            mock.patch("apps.orgs.restore_rehearsal.transaction.atomic", mock.MagicMock()),
            mock.patch("apps.orgs.restore_rehearsal.Membership.objects.filter") as mock_mem,
            mock.patch("apps.orgs.restore_rehearsal.connection.cursor", return_value=cursor_cm),
            mock.patch.object(notification_services, "purge_rows_for_user", return_value=0),
            mock.patch.object(
                backend,
                "_scrub_ee_tables_for_user_in_account_context",
                side_effect=_record_none("ee_scrub"),
            ),
            mock.patch.object(support_services, "scrub_tickets_for_user", return_value=0),
            mock.patch.object(
                outbox_services,
                "scrub_personal_outbox_for_user",
                side_effect=_record_int("outbox_scrub"),
            ),
            mock.patch.object(
                identity_services,
                "scrub_passport_records_for_user",
                side_effect=_record_int("passport_scrub"),
            ),
            mock.patch.object(
                media_services,
                "scrub_and_delete_user_attachments_in_account_context",
                return_value=0,
            ),
            mock.patch.object(
                e2ee_services,
                "purge_account_e2ee_in_account_context",
                side_effect=_record_none("e2ee_purge"),
            ),
            mock.patch.object(
                identity_services,
                "scrub_person_contacts_and_subjects_in_account_context",
                side_effect=_record_none("identity_email_and_subject_scrub"),
            ),
        ):
            mock_mem.return_value.select_related.return_value.order_by.return_value = []
            backend._scrub_partially_cleared_person_domains(
                uid,
                personal_attachment_ids=set(),
                manifest_keys=None,
                upload_drain=RehearsalIsolatedUploadDrainVerifier(),
            )

        assert step_order == [
            "ee_scrub",
            "outbox_scrub",
            "passport_scrub",
            "e2ee_purge",
            "identity_email_and_subject_scrub",
        ]

    def test_drain_snapshot_in_flight_leases_preserves_started_at_and_fences_cutoff_orgs(
        self,
    ) -> None:
        """Verify `drain_snapshot_in_flight_leases` enters `erase` worker context and leaves `started_at` intact."""
        now = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)
        org_cutoff = uuid4()
        executed_sql: list[str] = []
        fake_cursor = mock.MagicMock()
        fake_cursor.rowcount = 1
        fake_cursor.fetchall.return_value = [(org_cutoff,)]
        cursor_cm = mock.MagicMock()
        cursor_cm.__enter__.return_value = fake_cursor
        cursor_cm.__exit__.return_value = False

        def record_exec(sql: str, params: object = None) -> None:
            del params
            executed_sql.append(sql)

        fake_cursor.execute.side_effect = record_exec

        with (
            mock.patch("django.db.connection.in_atomic_block", True),
            mock.patch("apps.outbox.services.connection.cursor", return_value=cursor_cm),
        ):
            res = outbox_services.drain_snapshot_in_flight_leases(now=now)
        assert res["outbox_in_flight_drained"] == 1
        assert any("INSERT INTO public.retention_worker_context" in s for s in executed_sql)
        update_delivery_sql = next(s for s in executed_sql if "UPDATE outbox_outboxdelivery" in s)
        assert "started_at" not in update_delivery_sql
        assert "WHERE status = 'in_flight'" in update_delivery_sql
        assert any("DELETE FROM public.retention_worker_context" in s for s in executed_sql)

        report = execute_restore_guards(
            disarm_outbound=True,
            backend_factory=_InMemoryRehearsalBackend,
        )
        assert report.outbound_disarmed is True
        assert report.disarm_summary is not None

    def test_ee_partial_scrub_seals_audit_erasure_commitment_and_scrubs_purchase_order_signatories(
        self,
    ) -> None:
        """Verify partial person scrub seals `ee_audit_ledger.erasure_commitment` (`ingest`), scrubs `target_urn`, and scrubs `ee_billing_purchase_orders` signatories."""
        backend = DjangoRestoreRehearsalBackend()
        uid = uuid4()
        email_sha = hashlib.sha256(b"alice@example.test").hexdigest()
        executed: list[tuple[str, list[object] | None]] = []

        fake_cursor = mock.MagicMock()

        def _exec(sql: str, params: Sequence[object] | None = None) -> None:
            param_list = list(params) if params is not None else None
            if param_list is not None:
                assert sql.replace("%%", "").count("%s") == len(param_list)
            executed.append((sql, param_list))

        fake_cursor.execute.side_effect = _exec
        # 1) ee_audit_ledger exists -> True
        # 2) ee_audit_build_erasure_seal exists -> True
        # 3) set_config('kodera.ee_audit_erasure_key_hex') -> no fetchone
        # 4) ee_billing_purchase_orders exists -> True
        fake_cursor.fetchone.side_effect = [(True,), (True,), (True,)]

        with mock.patch(
            "apps.orgs.restore_rehearsal.derive_server_ee_audit_erasure_key_hex",
            return_value="ab" * 32,
        ):
            backend._scrub_ee_tables_for_user_in_account_context(
                fake_cursor,
                uid,
                (email_sha,),
            )

        sql_texts = [sql for sql, _ in executed]
        assert any("kodera.ee_audit_erasure_key_hex" in s for s in sql_texts)
        audit_update = next(s for s in sql_texts if "UPDATE public.ee_audit_ledger l" in s)
        assert "public.ee_audit_build_erasure_seal(" in audit_update
        assert "'ingest'" in audit_update
        assert "public.ee_audit_scrub_target_urn(" in audit_update
        assert "public.ee_audit_hmac_sha256_hex(" in audit_update
        assert "public.ee_audit_target_urn_matches_digests(" in audit_update
        assert "WHERE l.id = c.id AND l.user_id = %s" in audit_update

        po_update = next(s for s in sql_texts if "UPDATE public.ee_billing_purchase_orders po" in s)
        assert "countersigned_by_user_id = NULL" in po_update
        assert "ELSE 'erased:' || %s::text" in po_update
        assert "pii_scrubbed_at = COALESCE(po.pii_scrubbed_at, clock_timestamp())" in po_update

    def test_residual_ee_checks_erasure_commitment_and_enterprise_billing_tables(self) -> None:
        """Verify `_count_user_residual_ee` and `_count_org_residual_ee` check `erasure_commitment IS NULL` and `ee_billing_*` tables."""
        backend = DjangoRestoreRehearsalBackend()
        org_id = uuid4()
        uid = uuid4()
        email_sha = hashlib.sha256(b"alice@example.test").hexdigest()
        executed_sql: list[str] = []

        fake_cursor = mock.MagicMock()

        def _exec(sql: str, params: Sequence[object] | None = None) -> None:
            if params is not None:
                assert sql.replace("%%", "").count("%s") == len(list(params))
            executed_sql.append(sql)

        fake_cursor.execute.side_effect = _exec
        # Org sequence:
        # 1) to_regclass(ee_audit_ledger) -> True
        # 2) org SCIM/SAML/signing_key count -> (1,)
        # 3) information_schema erasure_commitment -> True
        # 4) org ee_audit_ledger count -> (1,)
        # 5) to_regclass(ee_billing_warm_pool_slots) -> True
        # 6) warm_pool count -> (2,)
        # 7) to_regclass(ee_billing_purchase_orders) -> True
        # 8) purchase_orders count -> (3,)
        # User sequence:
        # 9) to_regclass(ee_audit_ledger) -> True
        # 10) user SCIM/SAML count -> (1,)
        # 11) information_schema erasure_commitment -> True
        # 12) to_regprocedure(ee_audit_target_urn_matches_digests) -> True
        # 13) user ee_audit_ledger count -> (1,)
        # 14) to_regclass(ee_billing_purchase_orders) -> True
        # 15) user purchase_orders count -> (4,)
        fake_cursor.fetchone.side_effect = [
            (True,),
            (1,),
            (True,),
            (1,),
            (True,),
            (2,),
            (True,),
            (3,),
            (True,),
            (1,),
            (True,),
            (True,),
            (1,),
            (True,),
            (4,),
        ]
        cursor_cm = mock.MagicMock()
        cursor_cm.__enter__.return_value = fake_cursor
        cursor_cm.__exit__.return_value = False

        with mock.patch("apps.orgs.restore_rehearsal.connection.cursor", return_value=cursor_cm):
            assert backend._count_org_residual_ee(org_id) == 7
            assert backend._count_user_residual_ee(uid, email_sha256s=(email_sha,)) == 6

        assert any(
            "FROM ee_audit_ledger WHERE organisation_id = %s" in s
            and "erasure_commitment IS NULL" in s
            for s in executed_sql
        )
        assert any("FROM public.ee_billing_warm_pool_slots" in s for s in executed_sql)
        assert any(
            "FROM public.ee_billing_purchase_orders WHERE organisation_id = %s::text" in s
            for s in executed_sql
        )
        assert any(
            "FROM ee_audit_ledger WHERE user_id = %s" in s
            and "erasure_commitment IS NULL" in s
            and "ee_audit_target_urn_matches_digests" in s
            for s in executed_sql
        )
        assert any(
            "FROM public.ee_billing_purchase_orders WHERE countersigned_by_user_id = %s" in s
            for s in executed_sql
        )
