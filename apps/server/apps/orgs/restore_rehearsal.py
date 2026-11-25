"""Isolated backup/restore rehearsal guards: outbound disarm, Art. 17 replay, and S3 reconciliation.

Enforces three fail-closed invariants before a restored rehearsal stack opens internal readiness:
1. Outbound side-effect neutralization (`--disarm-outbound`) inside `transaction.atomic()` across
   `extensions`, `notifications`, `outbox`, `support`, and `billing` so zero live HTTP, WebPush,
   GitHub triage, payment-provider, or SMTP calls can fire.
2. Post-backup GDPR Art. 17 erasure replay (`--erasure-ledger`) across organisation and person
   scopes (`erasure_services`, `account_erasure_services`, and `WorkspaceCutoff`), verifying zero
   residual PII rows remain across all local domains even when contact fields were already
   partially cleared in the backup snapshot.
3. S3 object inventory reconciliation (`--s3-manifest`) against completed non-erased
   `media.Attachment` records, failing closed on missing objects, size/SHA-256 mismatches,
   unclassified/unmatched S3 objects, or unpurged S3 objects belonging to erased tenants/accounts.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import hmac
import json
import os
import re
import stat
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

from django.db import DatabaseError, connection, transaction

from apps.billing import services as billing_services
from apps.e2ee import services as e2ee_services
from apps.extensions import services as extension_services
from apps.identity import selectors as identity_selectors, services as identity_services
from apps.media import services as media_services
from apps.media.storage import ObjectKey, StorageRefusedError, parse_object_key
from apps.notifications import services as notification_services
from apps.outbox import services as outbox_services
from apps.outbox.realm_enqueue import ACCESS_OFF, enqueue_realm_access
from apps.support import services as support_services
from apps.workspaces import services as workspace_services
from config.upload_limits import UPLOAD_STREAM_DRAIN_SECONDS
from core.db.ee_erasure import derive_server_ee_audit_erasure_key_hex
from services.identity.access_tokens import AUDIENCE, VerifiedAccessToken

from . import member_set_hooks
from .account_erasure_services import (
    AccountAbsenceProof,
    AccountErasureAdapter,
    AccountErasureScope,
    advance_account_erasure,
    begin_account_erasure,
)
from .erasure_services import (
    AbsenceProof,
    ErasureAdapter,
    ErasureScope,
    advance_erasure,
    begin_erasure,
    database_now,
)
from .models import Membership, Organisation
from .object_erasure import (
    BoundedStreamUploadDrainVerifier,
    ObjectUploadWindowOpenError,
    _check_upload_drain,
    _parse_upload_expiry,
    attachment_object_key,
    has_in_flight_uploads,
)
from .privacy_models import AccountErasure, PrivacyErasure, PrivacyExport

MAX_REHEARSAL_JSON_BYTES = 16 * 1024 * 1024
INSTRUCTION_REF_RE = re.compile(r"^[A-Z]{2,8}-[0-9]{1,8}$")
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
_DARWIN_ROOT_ALIASES: dict[str, tuple[str, ...]] = {
    "var": ("private", "var"),
    "tmp": ("private", "tmp"),
    "etc": ("private", "etc"),
}


class RestoreRehearsalError(ValueError):
    """Fail-closed refusal raised during backup/restore rehearsal guard execution."""

    code: str
    unresolved_domains: tuple[str, ...]

    def __init__(
        self,
        message: str,
        *,
        code: str = "restore_rehearsal_refused",
        unresolved_domains: Sequence[str] = (),
    ) -> None:
        super().__init__(message)
        self.code = code
        self.unresolved_domains = tuple(unresolved_domains)


def _parse_aware_utc_timestamp(value: object, *, field_name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise RestoreRehearsalError(
            f"{field_name} must be a non-empty ISO-8601 timestamp string",
            code="invalid_timestamp",
        )
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise RestoreRehearsalError(
            f"{field_name} is not a valid ISO-8601 timestamp",
            code="invalid_timestamp",
        ) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RestoreRehearsalError(
            f"{field_name} must be timezone-aware",
            code="naive_timestamp_refused",
        )
    return parsed.astimezone(UTC)


def _parse_uuid(value: object, *, field_name: str) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str) or not value.strip():
        raise RestoreRehearsalError(
            f"{field_name} must be a valid UUID string",
            code="invalid_uuid",
        )
    try:
        return UUID(value.strip())
    except ValueError:
        raise RestoreRehearsalError(
            f"{field_name} is not a valid UUID",
            code="invalid_uuid",
        ) from None


def open_regular_file_nofollow_fd(path: Path, *, label: str) -> int:
    """Walk path components from `/` via retained directory FDs (`O_DIRECTORY | O_NOFOLLOW`)."""
    raw_str = os.fspath(path)
    if not raw_str or any(part == ".." for part in Path(raw_str).parts):
        raise RestoreRehearsalError(
            f"{label} path refuses parent-directory traversal",
            code="symlink_input_refused",
        )
    abs_path = Path(raw_str) if os.path.isabs(raw_str) else Path(os.getcwd()) / raw_str
    parts = [part for part in str(abs_path).split(os.sep) if part and part != "."]
    if not parts:
        raise RestoreRehearsalError(
            f"{label} path must be a regular file",
            code="non_regular_file_refused",
        )

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | nofollow
    try:
        dir_fd = os.open(os.sep, dir_flags)
    except OSError:
        raise RestoreRehearsalError(
            f"{label} root directory could not be opened",
            code="unreadable_input_file",
        ) from None

    try:
        if sys.platform == "darwin" and parts[0] in _DARWIN_ROOT_ALIASES:
            alias_target = _DARWIN_ROOT_ALIASES[parts[0]]
            try:
                link_val = os.readlink(parts[0], dir_fd=dir_fd).rstrip("/")
            except OSError:
                link_val = ""
            if link_val == "/".join(alias_target):
                parts = [*alias_target, *parts[1:]]

        for comp in parts[:-1]:
            try:
                next_fd = os.open(comp, dir_flags, dir_fd=dir_fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                    raise RestoreRehearsalError(
                        f"{label} path refuses symbolic links",
                        code="symlink_input_refused",
                    ) from None
                with contextlib.suppress(OSError):
                    if stat.S_ISLNK(os.stat(comp, dir_fd=dir_fd, follow_symlinks=False).st_mode):
                        raise RestoreRehearsalError(
                            f"{label} path refuses symbolic links",
                            code="symlink_input_refused",
                        ) from None
                raise RestoreRehearsalError(
                    f"{label} file is missing or unreadable",
                    code="unreadable_input_file",
                ) from None
            os.close(dir_fd)
            dir_fd = next_fd

        leaf = parts[-1]
        try:
            file_fd = os.open(leaf, os.O_RDONLY | nofollow, dir_fd=dir_fd)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                raise RestoreRehearsalError(
                    f"{label} path refuses symbolic links",
                    code="symlink_input_refused",
                ) from None
            with contextlib.suppress(OSError):
                if stat.S_ISLNK(os.stat(leaf, dir_fd=dir_fd, follow_symlinks=False).st_mode):
                    raise RestoreRehearsalError(
                        f"{label} path refuses symbolic links",
                        code="symlink_input_refused",
                    ) from None
            raise RestoreRehearsalError(
                f"{label} file is missing or unreadable",
                code="unreadable_input_file",
            ) from None
        return file_fd
    finally:
        with contextlib.suppress(OSError):
            os.close(dir_fd)


def read_json_file_nofollow(path: Path, *, label: str) -> dict[str, Any]:
    """Read a regular JSON object file via retained `dir_fd` walk and `O_NOFOLLOW`."""
    fd = open_regular_file_nofollow_fd(path, label=label)
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise RestoreRehearsalError(
                f"{label} path must be a regular file",
                code="non_regular_file_refused",
            )
        if fst.st_size > MAX_REHEARSAL_JSON_BYTES:
            raise RestoreRehearsalError(
                f"{label} file exceeds 16 MiB safety ceiling",
                code="input_file_too_large",
            )
        chunks: list[bytes] = []
        remaining = MAX_REHEARSAL_JSON_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw_bytes = b"".join(chunks)
        if len(raw_bytes) > MAX_REHEARSAL_JSON_BYTES:
            raise RestoreRehearsalError(
                f"{label} file exceeds 16 MiB safety ceiling",
                code="input_file_too_large",
            )
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)

    def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, val in pairs:
            if key in out:
                raise RestoreRehearsalError(
                    f"duplicate JSON key '{key}' in {label}",
                    code="duplicate_json_key",
                )
            out[key] = val
        return out

    def _reject_constant(_token: str) -> Any:
        raise RestoreRehearsalError(
            f"non-standard numeric constant refused in {label}",
            code="invalid_json",
        )

    try:
        parsed = json.loads(
            raw_bytes.decode("utf-8"),
            object_pairs_hook=_unique_pairs,
            parse_constant=_reject_constant,
        )
    except RestoreRehearsalError:
        raise
    except (UnicodeDecodeError, ValueError):
        raise RestoreRehearsalError(
            f"{label} does not contain valid UTF-8 JSON",
            code="invalid_json",
        ) from None

    if not isinstance(parsed, dict):
        raise RestoreRehearsalError(
            f"{label} must contain a top-level JSON object",
            code="invalid_json_root",
        )
    return parsed


@dataclass(frozen=True, slots=True)
class OrganisationErasureEntry:
    organisation_id: UUID
    instruction_ref: str
    instruction_sha256: str
    erased_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UserErasureEntry:
    user_id: UUID
    instruction_ref: str
    instruction_sha256: str
    erased_at: datetime | None = None
    erased_attachment_ids: tuple[UUID, ...] = ()


@dataclass(frozen=True, slots=True)
class ErasureLedger:
    backup_created_at: datetime
    organisation_entries: tuple[OrganisationErasureEntry, ...]
    user_entries: tuple[UserErasureEntry, ...]

    @property
    def organisation_ids(self) -> tuple[UUID, ...]:
        return tuple(entry.organisation_id for entry in self.organisation_entries)

    @property
    def user_ids(self) -> tuple[UUID, ...]:
        return tuple(entry.user_id for entry in self.user_entries)

    @property
    def erased_attachment_ids(self) -> tuple[UUID, ...]:
        out: set[UUID] = set()
        for entry in self.user_entries:
            out.update(entry.erased_attachment_ids)
        return tuple(sorted(out, key=str))


@dataclass(frozen=True, slots=True)
class S3ManifestObject:
    key: str
    organisation_id: UUID
    attachment_id: UUID
    size_bytes: int
    sha256: str
    user_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class S3InventoryManifest:
    objects: tuple[S3ManifestObject, ...]


@dataclass(frozen=True, slots=True)
class OutboundDisarmSummary:
    installations_revoked: int
    deliveries_obsoleted: int
    coexistence_bridges_revoked: int
    coexistence_secrets_zeroized: int
    coexistence_outbound_obsoleted: int
    digest_jobs_obsoleted: int
    push_outbox_disarmed: int
    push_subscriptions_revoked: int
    outbox_deliveries_cancelled: int
    outbox_messages_cleared: int
    outbox_attempts_abandoned: int
    bug_reports_disarmed: int = 0
    support_tickets_disarmed: int = 0
    payment_links_disarmed: int = 0
    scheduled_messages_disarmed: int = 0
    personal_reminders_disarmed: int = 0


@dataclass(frozen=True, slots=True)
class ErasureReplaySummary:
    backup_created_at: str
    organisations_replayed: int
    users_replayed: int
    workspace_cutoffs_verified: int
    zero_residual_pii_verified: bool


@dataclass(frozen=True, slots=True)
class S3ReconciliationSummary:
    completed_attachments_checked: int
    manifest_objects_inspected: int
    untracked_s3_objects: int
    reconciled: bool


@dataclass(frozen=True, slots=True)
class RestoreGuardsReport:
    status: str
    outbound_disarmed: bool
    disarm_summary: OutboundDisarmSummary | None
    erasure_replay: ErasureReplaySummary | None
    s3_reconciliation: S3ReconciliationSummary | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "outbound_disarmed": self.outbound_disarmed,
            "disarm_summary": (
                asdict(self.disarm_summary) if self.disarm_summary is not None else None
            ),
            "erasure_replay": (
                asdict(self.erasure_replay) if self.erasure_replay is not None else None
            ),
            "s3_reconciliation": (
                asdict(self.s3_reconciliation) if self.s3_reconciliation is not None else None
            ),
        }


def parse_erasure_ledger(data: Mapping[str, Any]) -> ErasureLedger:
    """Parse and validate a post-backup GDPR Art. 17 erasure ledger JSON mapping."""
    if not isinstance(data, Mapping):
        raise RestoreRehearsalError(
            "erasure ledger must be a JSON object",
            code="invalid_erasure_ledger",
        )
    backup_ts = _parse_aware_utc_timestamp(
        data.get("backup_created_at"), field_name="backup_created_at"
    )
    raw_orgs = data.get("organisation_references", [])
    raw_users = data.get("user_references", [])
    if isinstance(raw_orgs, (str, bytes, Mapping)) or not isinstance(raw_orgs, Sequence):
        raise RestoreRehearsalError(
            "organisation_references must be a JSON array",
            code="invalid_erasure_ledger",
        )
    if isinstance(raw_users, (str, bytes, Mapping)) or not isinstance(raw_users, Sequence):
        raise RestoreRehearsalError(
            "user_references must be a JSON array",
            code="invalid_erasure_ledger",
        )

    org_map: dict[UUID, OrganisationErasureEntry] = {}
    for idx, item in enumerate(raw_orgs, start=1):
        if isinstance(item, (str, UUID)):
            org_uuid = _parse_uuid(item, field_name="organisation_references[]")
            inst_ref = f"RHR-{idx}"
            inst_sha = hashlib.sha256(
                f"rehearsal-org:{org_uuid}:{backup_ts.isoformat()}".encode()
            ).hexdigest()
            erased_at = None
        elif isinstance(item, Mapping):
            org_uuid = _parse_uuid(
                item.get("organisation_id") or item.get("organisation_reference"),
                field_name="organisation_references[].organisation_id",
            )
            raw_ref = item.get("instruction_ref")
            inst_ref = str(raw_ref) if raw_ref is not None else f"RHR-{idx}"
            if not INSTRUCTION_REF_RE.fullmatch(inst_ref):
                raise RestoreRehearsalError(
                    "invalid instruction_ref in organisation_references",
                    code="invalid_instruction_ref",
                )
            raw_sha = item.get("instruction_sha256")
            inst_sha = (
                str(raw_sha)
                if raw_sha is not None
                else hashlib.sha256(
                    f"rehearsal-org:{org_uuid}:{backup_ts.isoformat()}".encode()
                ).hexdigest()
            )
            if not SHA256_HEX_RE.fullmatch(inst_sha):
                raise RestoreRehearsalError(
                    "invalid instruction_sha256 in organisation_references",
                    code="invalid_instruction_sha256",
                )
            erased_at = (
                _parse_aware_utc_timestamp(item["erased_at"], field_name="erased_at")
                if item.get("erased_at") is not None
                else None
            )
        else:
            raise RestoreRehearsalError(
                "organisation_references entries must be UUID strings or objects",
                code="invalid_erasure_ledger",
            )
        if org_uuid in org_map:
            raise RestoreRehearsalError(
                f"duplicate organisation_reference in erasure ledger: {org_uuid}",
                code="duplicate_erasure_subject",
            )
        org_map[org_uuid] = OrganisationErasureEntry(
            organisation_id=org_uuid,
            instruction_ref=inst_ref,
            instruction_sha256=inst_sha,
            erased_at=erased_at,
        )

    user_map: dict[UUID, UserErasureEntry] = {}
    for idx, item in enumerate(raw_users, start=1):
        if isinstance(item, (str, UUID)):
            user_uuid = _parse_uuid(item, field_name="user_references[]")
            inst_ref = f"RHRA-{idx}"
            inst_sha = hashlib.sha256(
                f"rehearsal-user:{user_uuid}:{backup_ts.isoformat()}".encode()
            ).hexdigest()
            erased_at = None
            att_ids: tuple[UUID, ...] = ()
        elif isinstance(item, Mapping):
            user_uuid = _parse_uuid(
                item.get("user_id") or item.get("user_reference"),
                field_name="user_references[].user_id",
            )
            raw_ref = item.get("instruction_ref")
            inst_ref = str(raw_ref) if raw_ref is not None else f"RHRA-{idx}"
            if not INSTRUCTION_REF_RE.fullmatch(inst_ref):
                raise RestoreRehearsalError(
                    "invalid instruction_ref in user_references",
                    code="invalid_instruction_ref",
                )
            raw_sha = item.get("instruction_sha256")
            inst_sha = (
                str(raw_sha)
                if raw_sha is not None
                else hashlib.sha256(
                    f"rehearsal-user:{user_uuid}:{backup_ts.isoformat()}".encode()
                ).hexdigest()
            )
            if not SHA256_HEX_RE.fullmatch(inst_sha):
                raise RestoreRehearsalError(
                    "invalid instruction_sha256 in user_references",
                    code="invalid_instruction_sha256",
                )
            erased_at = (
                _parse_aware_utc_timestamp(item["erased_at"], field_name="erased_at")
                if item.get("erased_at") is not None
                else None
            )
            raw_atts = item.get("erased_attachment_ids", [])
            if isinstance(raw_atts, (str, bytes, Mapping)) or not isinstance(raw_atts, Sequence):
                raise RestoreRehearsalError(
                    "erased_attachment_ids must be an array of UUIDs",
                    code="invalid_erasure_ledger",
                )
            att_ids = tuple(
                sorted(
                    {_parse_uuid(a, field_name="erased_attachment_ids[]") for a in raw_atts},
                    key=str,
                )
            )
        else:
            raise RestoreRehearsalError(
                "user_references entries must be UUID strings or objects",
                code="invalid_erasure_ledger",
            )
        if user_uuid in user_map:
            raise RestoreRehearsalError(
                f"duplicate user_reference in erasure ledger: {user_uuid}",
                code="duplicate_erasure_subject",
            )
        user_map[user_uuid] = UserErasureEntry(
            user_id=user_uuid,
            instruction_ref=inst_ref,
            instruction_sha256=inst_sha,
            erased_at=erased_at,
            erased_attachment_ids=att_ids,
        )

    return ErasureLedger(
        backup_created_at=backup_ts,
        organisation_entries=tuple(org_map[k] for k in sorted(org_map, key=lambda uid: str(uid))),
        user_entries=tuple(user_map[k] for k in sorted(user_map, key=lambda uid: str(uid))),
    )


def parse_s3_manifest(data: Mapping[str, Any]) -> S3InventoryManifest:
    """Parse and validate a backup S3 object inventory manifest."""
    if not isinstance(data, Mapping):
        raise RestoreRehearsalError(
            "S3 manifest must be a JSON object",
            code="invalid_s3_manifest",
        )
    raw_objects = data.get("objects")
    if isinstance(raw_objects, (str, bytes, Mapping)) or not isinstance(raw_objects, Sequence):
        raise RestoreRehearsalError(
            "S3 manifest 'objects' must be a JSON array",
            code="invalid_s3_manifest",
        )

    seen_keys: set[str] = set()
    objects: list[S3ManifestObject] = []
    for entry in raw_objects:
        if not isinstance(entry, Mapping):
            raise RestoreRehearsalError(
                "each S3 manifest object must be a JSON object",
                code="invalid_s3_manifest",
            )
        raw_size = entry.get("size_bytes")
        if type(raw_size) is not int or raw_size < 1:
            raise RestoreRehearsalError(
                "S3 object size_bytes must be a positive integer",
                code="invalid_s3_object_size",
            )
        raw_sha = entry.get("sha256")
        if not isinstance(raw_sha, str) or not SHA256_HEX_RE.fullmatch(raw_sha):
            raise RestoreRehearsalError(
                "S3 object sha256 must be a 64-character lowercase hex digest",
                code="invalid_s3_object_digest",
            )

        raw_key = entry.get("key")
        raw_org = entry.get("organisation_id")
        raw_att = entry.get("id") if entry.get("id") is not None else entry.get("attachment_id")

        if raw_key is not None:
            if not isinstance(raw_key, str) or not raw_key.strip():
                raise RestoreRehearsalError(
                    "S3 object key must be a non-empty string",
                    code="invalid_s3_object_key",
                )
            try:
                parsed_key = parse_object_key(raw_key)
            except StorageRefusedError:
                raise RestoreRehearsalError(
                    f"unclassified or non-canonical S3 object key refused: {raw_key}",
                    code="unclassified_s3_objects",
                ) from None
            org_uuid = parsed_key.organisation_id
            att_uuid = parsed_key.attachment_id
            if (
                raw_org is not None
                and _parse_uuid(raw_org, field_name="organisation_id") != org_uuid
            ):
                raise RestoreRehearsalError(
                    "S3 manifest key organisation_id disagrees with explicit organisation_id",
                    code="s3_key_scope_mismatch",
                )
            if raw_att is not None and _parse_uuid(raw_att, field_name="attachment_id") != att_uuid:
                raise RestoreRehearsalError(
                    "S3 manifest key attachment_id disagrees with explicit id",
                    code="s3_key_scope_mismatch",
                )
            canonical_key = parsed_key.key
        else:
            org_uuid = _parse_uuid(raw_org, field_name="organisation_id")
            att_uuid = _parse_uuid(raw_att, field_name="id")
            canonical_key = ObjectKey(organisation_id=org_uuid, attachment_id=att_uuid).key

        if canonical_key in seen_keys:
            raise RestoreRehearsalError(
                f"duplicate S3 object key in manifest: {canonical_key}",
                code="duplicate_s3_object_key",
            )
        seen_keys.add(canonical_key)

        raw_user = (
            entry.get("user_id")
            if entry.get("user_id") is not None
            else entry.get("uploader_user_id")
        )
        user_uuid = _parse_uuid(raw_user, field_name="user_id") if raw_user is not None else None
        objects.append(
            S3ManifestObject(
                key=canonical_key,
                organisation_id=org_uuid,
                attachment_id=att_uuid,
                size_bytes=raw_size,
                sha256=raw_sha,
                user_id=user_uuid,
            )
        )

    objects.sort(key=lambda item: item.key)
    return S3InventoryManifest(objects=tuple(objects))


def reconcile_attachments_with_s3_manifest(
    *,
    completed_attachments: Sequence[media_services.CompletedAttachmentSnapshot],
    manifest: S3InventoryManifest,
    erased_organisation_ids: set[UUID],
    erased_user_ids: set[UUID],
    erased_attachment_ids: set[UUID],
) -> S3ReconciliationSummary:
    """Pure fail-closed reconciliation between completed DB attachments and S3 object manifest."""
    unpurged_keys: list[str] = []
    manifest_by_key: dict[str, S3ManifestObject] = {}
    for obj in manifest.objects:
        if (
            obj.organisation_id in erased_organisation_ids
            or obj.attachment_id in erased_attachment_ids
            or (obj.user_id is not None and obj.user_id in erased_user_ids)
        ):
            unpurged_keys.append(obj.key)
        manifest_by_key[obj.key] = obj

    if unpurged_keys:
        raise RestoreRehearsalError(
            f"unpurged S3 objects remain for erased tenants or accounts ({len(unpurged_keys)} objects)",
            code="unpurged_erased_s3_objects",
        )

    missing_keys: list[str] = []
    mismatched_keys: list[str] = []
    matched_keys: set[str] = set()

    for att in completed_attachments:
        if att.organisation_id in erased_organisation_ids or att.id in erased_attachment_ids:
            raise RestoreRehearsalError(
                "completed attachment row still present for an erased tenant or account",
                code="residual_erased_attachment_row",
            )
        expected_key = ObjectKey(organisation_id=att.organisation_id, attachment_id=att.id).key
        s3_obj = manifest_by_key.get(expected_key)
        if s3_obj is None:
            missing_keys.append(expected_key)
            continue
        matched_keys.add(expected_key)
        if s3_obj.size_bytes != att.size_bytes or not hmac.compare_digest(
            s3_obj.sha256, att.sha256
        ):
            mismatched_keys.append(expected_key)

    if missing_keys:
        raise RestoreRehearsalError(
            f"missing S3 objects for completed attachments ({len(missing_keys)} missing)",
            code="missing_s3_objects",
        )
    if mismatched_keys:
        raise RestoreRehearsalError(
            f"S3 size_bytes or sha256 mismatch on completed attachments ({len(mismatched_keys)} mismatched)",
            code="mismatched_s3_objects",
        )

    unmatched_keys = sorted(set(manifest_by_key) - matched_keys)
    if unmatched_keys:
        raise RestoreRehearsalError(
            f"unclassified or unmatched S3 objects present without completed DB attachment ({len(unmatched_keys)} objects)",
            code="unclassified_s3_objects",
        )

    return S3ReconciliationSummary(
        completed_attachments_checked=len(completed_attachments),
        manifest_objects_inspected=len(manifest.objects),
        untracked_s3_objects=0,
        reconciled=True,
    )


@dataclass(frozen=True)
class RehearsalIsolatedUploadDrainVerifier:
    """Isolated rehearsal upload-drain verifier delegating to `BoundedStreamUploadDrainVerifier`."""

    max_stream_duration: timedelta = timedelta(seconds=UPLOAD_STREAM_DRAIN_SECONDS)
    in_flight_inspector: Callable[[tuple[str, ...]], bool] = has_in_flight_uploads

    def verify_drained(
        self,
        scope: ErasureScope | AccountErasureScope,
        object_keys: tuple[str, ...],
        max_upload_expiry: datetime,
    ) -> str:
        delegate = BoundedStreamUploadDrainVerifier(
            max_stream_duration=self.max_stream_duration,
            has_in_flight_uploads=self.in_flight_inspector,
        )
        return delegate.verify_drained(scope, object_keys, max_upload_expiry)


class RehearsalManifestObjectDeleter:
    """S3-manifest-backed rehearsal object-erasure adapter requiring zero live S3 egress."""

    def __init__(self, *, manifest_keys: frozenset[str] | None = None) -> None:
        self._manifest_keys = manifest_keys
        self.verified_absent_keys: list[str] = []

    def __call__(self, target_key: str) -> dict[str, Any]:
        parsed = parse_object_key(target_key)
        if self._manifest_keys is not None and parsed.key in self._manifest_keys:
            raise RestoreRehearsalError(
                f"unpurged S3 object remains in backup manifest for erased attachment: {parsed.key}",
                code="unpurged_erased_s3_objects",
            )
        self.verified_absent_keys.append(parsed.key)
        return {"deleted": True}


@dataclass
class _RehearsalOrgDomainAdapter:
    """Isolated rehearsal adapter certifying local absence for external organisation domains."""

    domain: str
    manifest_keys: frozenset[str] | None = None
    upload_drain: RehearsalIsolatedUploadDrainVerifier | None = None
    revision: str = "rehearsal-isolated-v1"

    def _evidence(self, scope: ErasureScope) -> str:
        if self.domain == "objects":
            raw_atts = scope.inventory.get("attachments", [])
            if not isinstance(raw_atts, list):
                raise ValueError("organisation attachment inventory malformed")
            keys = tuple(
                sorted(
                    attachment_object_key(
                        organisation_id=scope.organisation_id,
                        attachment_id=str(UUID(str(att_id))),
                    )
                    for att_id in raw_atts
                )
            )
            max_exp = _parse_upload_expiry(
                scope.inventory.get("org_attachment_max_upload_expires_at")
            )
            _check_upload_drain(self.upload_drain, scope, keys, max_exp)
            if self.manifest_keys is not None:
                org_prefix = f"organisations/{scope.organisation_id}/attachments/"
                remaining = [
                    k for k in self.manifest_keys if k in set(keys) or k.startswith(org_prefix)
                ]
                if remaining:
                    raise RestoreRehearsalError(
                        f"unpurged S3 objects remain in manifest for erased organisation ({len(remaining)} objects)",
                        code="unpurged_erased_s3_objects",
                    )
        elif self.domain == "private_exports":
            unexpired = (
                PrivacyExport.objects.filter(organisation_id=scope.organisation_id)
                .exclude(status="expired", checkpoint={})
                .count()
            )
            if unexpired > 0:
                raise ValueError("organisation private exports not expired")

        payload = {
            "adapter_revision": self.revision,
            "cutoff_at": scope.cutoff_at.isoformat(),
            "domain": self.domain,
            "inventory_sha256": scope.inventory_sha256,
            "organisation_id": str(scope.organisation_id),
            "request_id": str(scope.request_id),
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode()).hexdigest()

    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        evidence = self._evidence(scope)
        return AbsenceProof(
            request_id=scope.request_id,
            organisation_id=scope.organisation_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=evidence,
            adapter_revision=self.revision,
            verified_at=database_now(),
        )

    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
        try:
            expected = self._evidence(scope)
        except (ValueError, ObjectUploadWindowOpenError):
            return False
        return (
            proof.request_id == scope.request_id
            and proof.organisation_id == scope.organisation_id
            and proof.cutoff_at == scope.cutoff_at
            and proof.domain == self.domain
            and proof.inventory_sha256 == scope.inventory_sha256
            and proof.adapter_revision == self.revision
            and hmac.compare_digest(proof.evidence_sha256, expected)
        )


@dataclass
class _RehearsalAccountDomainAdapter:
    """Isolated rehearsal adapter certifying local absence for external account domains."""

    domain: str
    revision: str = "rehearsal-isolated-v1"

    def _evidence(self, scope: AccountErasureScope) -> str:
        if self.domain == "private_exports":
            unexpired = (
                PrivacyExport.objects.filter(user_id=scope.user_id)
                .exclude(status="expired", checkpoint={})
                .count()
            )
            if unexpired > 0:
                raise ValueError("account private exports not expired")
        payload = {
            "adapter_revision": self.revision,
            "cutoff_at": scope.cutoff_at.isoformat(),
            "domain": self.domain,
            "inventory_sha256": scope.inventory_sha256,
            "request_id": str(scope.request_id),
            "user_id": str(scope.user_id),
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode()).hexdigest()

    def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
        evidence = self._evidence(scope)
        return AccountAbsenceProof(
            request_id=scope.request_id,
            user_id=scope.user_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=evidence,
            adapter_revision=self.revision,
            verified_at=database_now(),
        )

    def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
        try:
            expected = self._evidence(scope)
        except ValueError:
            return False
        return (
            proof.request_id == scope.request_id
            and proof.user_id == scope.user_id
            and proof.cutoff_at == scope.cutoff_at
            and proof.domain == self.domain
            and proof.inventory_sha256 == scope.inventory_sha256
            and proof.adapter_revision == self.revision
            and hmac.compare_digest(proof.evidence_sha256, expected)
        )


class RestoreRehearsalBackend(Protocol):
    """Execution port enabling both real PostgreSQL execution and offline unit/refusal testing."""

    def replay_erasure_ledger(
        self,
        ledger: ErasureLedger,
        *,
        actor_identity_id: UUID | None = None,
        s3_manifest: S3InventoryManifest | None = None,
    ) -> ErasureReplaySummary: ...

    def disarm_outbound(self) -> OutboundDisarmSummary: ...

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
    ]: ...


class DjangoRestoreRehearsalBackend:
    """PostgreSQL restore-rehearsal backend delegating strictly through application service ports."""

    def _count_org_unscrubbed_invitations(self, organisation_id: UUID) -> int:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM orgs_invitation "
                "WHERE organisation_id = %s "
                "  AND (email <> 'erased+' || id::text || '@invalid.test' "
                "       OR display_name IS NOT NULL "
                "       OR octet_length(token_digest) <> 0 "
                "       OR octet_length(token_sealed) <> 0)",
                [organisation_id],
            )
            row = cursor.fetchone()
        return int(row[0]) if row is not None else 0

    def _count_org_unscrubbed_intake(self, organisation_id: UUID) -> int:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM orgs_organisationintake "
                "WHERE organisation_id = %s "
                "  AND (octet_length(sealed_contact) <> 0 "
                "       OR intended_owner_email_masked <> 'erased')",
                [organisation_id],
            )
            row = cursor.fetchone()
        return int(row[0]) if row is not None else 0

    def _count_org_unexpired_exports(self, organisation_id: UUID) -> int:
        return int(
            PrivacyExport.objects.filter(organisation_id=organisation_id)
            .exclude(status="expired", checkpoint={})
            .count()
        )

    def _count_user_unscrubbed_invitations(
        self,
        user_id: UUID,
        *,
        email_sha256s: Sequence[str],
        non_accepted_invitation_ids: Sequence[str],
    ) -> int:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM orgs_invitation inv "
                "LEFT JOIN orgs_membership m ON m.id = inv.membership_id "
                "WHERE ("
                "  m.user_id = %s "
                "  OR (inv.state <> 'accepted' AND ("
                "    inv.id::text = ANY(%s) "
                "    OR encode(sha256(convert_to(lower(btrim(inv.email)), 'UTF8')), 'hex') = ANY(%s)"
                "  ))"
                ") AND ("
                "  inv.email <> 'erased+' || inv.id::text || '@invalid.test' "
                "  OR inv.display_name IS NOT NULL "
                "  OR octet_length(inv.token_digest) <> 0 "
                "  OR octet_length(inv.token_sealed) <> 0 "
                "  OR (inv.membership_id IS NULL AND inv.state = 'pending')"
                ")",
                [user_id, list(non_accepted_invitation_ids), list(email_sha256s)],
            )
            row = cursor.fetchone()
        return int(row[0]) if row is not None else 0

    def _count_user_idempotency_records(
        self,
        user_id: UUID,
        *,
        principal_sha256s: Sequence[str],
    ) -> int:
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.idempotency_record') IS NOT NULL")
            if not cursor.fetchone()[0]:
                return 0
            cursor.execute(
                "SELECT count(*) FROM idempotency_record r "
                "WHERE EXISTS ("
                "  SELECT 1 FROM identity_identity i "
                "  WHERE i.user_id = %s AND r.issuer = i.issuer AND r.subject = i.subject"
                ") OR encode("
                "  sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), "
                "  'hex'"
                ") = ANY(%s)",
                [user_id, list(principal_shas := list(principal_sha256s))],
            )
            row = cursor.fetchone()
            del principal_shas
        return int(row[0]) if row is not None else 0

    def _count_org_residual_ee(self, organisation_id: UUID) -> int:
        total = 0
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.ee_audit_ledger') IS NOT NULL")
            has_audit = bool((cursor.fetchone() or (False,))[0])
            if has_audit:
                cursor.execute(
                    "SELECT ("
                    "  SELECT count(*) FROM ee_saml_pending_request WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_saml_replay_assertion WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_saml_principal WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_saml_idp WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_session WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_group_member WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_group WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_deprovision WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_user WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_token WHERE organisation_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_audit_signing_key WHERE organisation_id = %s"
                    ")",
                    [organisation_id] * 11,
                )
                row = cursor.fetchone()
                total += int(row[0]) if row is not None else 0

                cursor.execute(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.columns "
                    "  WHERE table_schema = 'public' "
                    "    AND table_name = 'ee_audit_ledger' "
                    "    AND column_name = 'erasure_commitment'"
                    ")"
                )
                if bool((cursor.fetchone() or (False,))[0]):
                    cursor.execute(
                        "SELECT count(*) FROM ee_audit_ledger "
                        "WHERE organisation_id = %s "
                        "  AND ("
                        "    pii_scrubbed_at IS NULL "
                        "    OR erasure_commitment IS NULL "
                        "    OR source_ip <> '' "
                        "    OR metadata_json <> '{}' "
                        "    OR (actor_label <> 'erased' AND actor_label NOT LIKE 'erased:%%') "
                        "    OR ("
                        "      target_urn IS NOT NULL "
                        "      AND target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' "
                        "      AND ("
                        "        strpos(target_urn, '@') > 0 "
                        "        OR target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$'"
                        "      )"
                        "    )"
                        "  )",
                        [organisation_id],
                    )
                else:
                    cursor.execute(
                        "SELECT count(*) FROM ee_audit_ledger "
                        "WHERE organisation_id = %s AND pii_scrubbed_at IS NULL",
                        [organisation_id],
                    )
                audit_row = cursor.fetchone()
                total += int(audit_row[0]) if audit_row is not None else 0

            cursor.execute("SELECT to_regclass('public.ee_billing_warm_pool_slots') IS NOT NULL")
            if bool((cursor.fetchone() or (False,))[0]):
                cursor.execute(
                    "SELECT count(*) FROM public.ee_billing_warm_pool_slots "
                    "WHERE claimed_by_organisation_id = %s::text",
                    [str(organisation_id)],
                )
                wp_row = cursor.fetchone()
                total += int(wp_row[0]) if wp_row is not None else 0

            cursor.execute("SELECT to_regclass('public.ee_billing_purchase_orders') IS NOT NULL")
            if bool((cursor.fetchone() or (False,))[0]):
                cursor.execute(
                    "SELECT count(*) FROM public.ee_billing_purchase_orders "
                    "WHERE organisation_id = %s::text "
                    "  AND ("
                    "    ("
                    "      state IN ('draft', 'issued', 'expired') "
                    "      AND invoice_ref IS NULL "
                    "      AND payment_ref IS NULL"
                    "    ) OR ("
                    "      ("
                    "        state IN ('countersigned', 'invoiced', 'paid') "
                    "        OR invoice_ref IS NOT NULL "
                    "        OR payment_ref IS NOT NULL"
                    "      ) AND ("
                    "        pii_scrubbed_at IS NULL "
                    "        OR countersigned_by_user_id IS NOT NULL "
                    "        OR ("
                    "          countersigned_by IS NOT NULL "
                    "          AND countersigned_by <> 'erased' "
                    "          AND countersigned_by NOT LIKE 'erased:%%'"
                    "        ) "
                    "        OR customer_po_reference <> ('REDACTED-' || po_number)"
                    "      )"
                    "    )"
                    "  )",
                    [str(organisation_id)],
                )
                po_row = cursor.fetchone()
                total += int(po_row[0]) if po_row is not None else 0
        return total

    def _count_user_residual_ee(
        self,
        user_id: UUID,
        *,
        email_sha256s: Sequence[str] = (),
    ) -> int:
        email_list = list(email_sha256s)
        subject_digests = list(
            dict.fromkeys(
                [
                    *email_list,
                    hashlib.sha256(str(user_id).lower().encode("utf-8")).hexdigest(),
                ]
            )
        )
        total = 0
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.ee_audit_ledger') IS NOT NULL")
            if bool((cursor.fetchone() or (False,))[0]):
                cursor.execute(
                    "SELECT ("
                    "  SELECT count(*) FROM ee_saml_principal sp "
                    "  WHERE sp.user_id = %s "
                    "     OR encode(sha256(convert_to(sp.email_lower, 'UTF8')), 'hex') = ANY(%s)"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_session WHERE user_id = %s"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_deprovision d "
                    "  WHERE d.user_id = %s "
                    "     OR encode(sha256(convert_to(lower(btrim(d.user_name)), 'UTF8')), 'hex') = ANY(%s)"
                    ") + ("
                    "  SELECT count(*) FROM ee_scim_user su "
                    "  WHERE su.user_id = %s "
                    "     OR encode(sha256(convert_to(su.user_name_lower, 'UTF8')), 'hex') = ANY(%s)"
                    ")",
                    [
                        user_id,
                        email_list,
                        user_id,
                        user_id,
                        email_list,
                        user_id,
                        email_list,
                    ],
                )
                row = cursor.fetchone()
                total += int(row[0]) if row is not None else 0

                cursor.execute(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.columns "
                    "  WHERE table_schema = 'public' "
                    "    AND table_name = 'ee_audit_ledger' "
                    "    AND column_name = 'erasure_commitment'"
                    ")"
                )
                has_commitment = bool((cursor.fetchone() or (False,))[0])
                has_target_digest_fn = False
                if has_commitment:
                    cursor.execute(
                        "SELECT to_regprocedure("
                        "  'public.ee_audit_target_urn_matches_digests(text,jsonb)'"
                        ") IS NOT NULL"
                    )
                    has_target_digest_fn = bool((cursor.fetchone() or (False,))[0])
                if has_commitment and has_target_digest_fn:
                    cursor.execute(
                        "SELECT count(*) FROM ee_audit_ledger "
                        "WHERE user_id = %s "
                        "  AND ("
                        "    pii_scrubbed_at IS NULL "
                        "    OR erasure_commitment IS NULL "
                        "    OR source_ip <> '' "
                        "    OR metadata_json <> '{}' "
                        "    OR (actor_label <> 'erased' AND actor_label <> ('erased:' || %s::text)) "
                        "    OR ("
                        "      target_urn IS NOT NULL "
                        "      AND target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' "
                        "      AND ("
                        "        strpos(target_urn, '@') > 0 "
                        "        OR target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$' "
                        "        OR public.ee_audit_target_urn_matches_digests("
                        "          target_urn, to_jsonb(%s::text[])"
                        "        )"
                        "      )"
                        "    )"
                        "  )",
                        [user_id, user_id, subject_digests],
                    )
                elif has_commitment:
                    cursor.execute(
                        "SELECT count(*) FROM ee_audit_ledger "
                        "WHERE user_id = %s AND (pii_scrubbed_at IS NULL OR erasure_commitment IS NULL)",
                        [user_id],
                    )
                else:
                    cursor.execute(
                        "SELECT count(*) FROM ee_audit_ledger "
                        "WHERE user_id = %s AND pii_scrubbed_at IS NULL",
                        [user_id],
                    )
                audit_row = cursor.fetchone()
                total += int(audit_row[0]) if audit_row is not None else 0

            cursor.execute("SELECT to_regclass('public.ee_billing_purchase_orders') IS NOT NULL")
            if bool((cursor.fetchone() or (False,))[0]):
                cursor.execute(
                    "SELECT count(*) FROM public.ee_billing_purchase_orders "
                    "WHERE countersigned_by_user_id = %s "
                    "   OR ("
                    "     countersigned_by_user_id IS NULL "
                    "     AND countersigned_by IS NOT NULL "
                    "     AND countersigned_by <> 'erased' "
                    "     AND countersigned_by NOT LIKE 'erased:%%' "
                    "     AND encode(sha256(convert_to(lower(btrim(countersigned_by)), 'UTF8')), 'hex') = ANY(%s)"
                    "   )",
                    [user_id, subject_digests],
                )
                po_row = cursor.fetchone()
                total += int(po_row[0]) if po_row is not None else 0
        return total

    def _scrub_ee_tables_for_user_in_account_context(
        self,
        cursor: Any,
        uid: UUID,
        email_shas: Sequence[str],
    ) -> None:
        """Scrub `ee_*` SCIM/SAML/audit/billing rows inside account context BEFORE `identity_identity.email` changes."""
        email_list = list(email_shas)
        cursor.execute("SELECT to_regclass('public.ee_audit_ledger') IS NOT NULL")
        if bool((cursor.fetchone() or (False,))[0]):
            cursor.execute(
                "DELETE FROM public.ee_scim_session "
                "WHERE user_id = %s "
                "   OR scim_user_id IN ("
                "     SELECT su.id FROM public.ee_scim_user su "
                "     WHERE su.user_id = %s "
                "        OR encode(sha256(convert_to(su.user_name_lower, 'UTF8')), 'hex') = ANY(%s) "
                "        OR EXISTS ("
                "          SELECT 1 FROM public.identity_identity i "
                "          WHERE i.user_id = %s AND i.organisation_id = su.organisation_id "
                "            AND lower(i.email) = su.user_name_lower"
                "        )"
                "   )",
                [uid, uid, email_list, uid],
            )
            cursor.execute(
                "DELETE FROM public.ee_scim_group_member "
                "WHERE scim_user_id IN ("
                "  SELECT su.id FROM public.ee_scim_user su "
                "  WHERE su.user_id = %s "
                "     OR encode(sha256(convert_to(su.user_name_lower, 'UTF8')), 'hex') = ANY(%s) "
                "     OR EXISTS ("
                "       SELECT 1 FROM public.identity_identity i "
                "       WHERE i.user_id = %s AND i.organisation_id = su.organisation_id "
                "         AND lower(i.email) = su.user_name_lower"
                "     )"
                ")",
                [uid, email_list, uid],
            )
            cursor.execute(
                "DELETE FROM public.ee_scim_deprovision "
                "WHERE user_id = %s "
                "   OR encode(sha256(convert_to(lower(btrim(user_name)), 'UTF8')), 'hex') = ANY(%s) "
                "   OR EXISTS ("
                "     SELECT 1 FROM public.identity_identity i "
                "     WHERE i.user_id = %s AND i.organisation_id = ee_scim_deprovision.organisation_id "
                "       AND lower(i.email) = lower(ee_scim_deprovision.user_name)"
                "   )",
                [uid, email_list, uid],
            )
            cursor.execute(
                "DELETE FROM public.ee_scim_user su "
                "WHERE su.user_id = %s "
                "   OR encode(sha256(convert_to(su.user_name_lower, 'UTF8')), 'hex') = ANY(%s) "
                "   OR EXISTS ("
                "     SELECT 1 FROM public.identity_identity i "
                "     WHERE i.user_id = %s AND i.organisation_id = su.organisation_id "
                "       AND lower(i.email) = su.user_name_lower"
                "   )",
                [uid, email_list, uid],
            )
            cursor.execute(
                "DELETE FROM public.ee_saml_principal sp "
                "WHERE sp.user_id = %s "
                "   OR encode(sha256(convert_to(sp.email_lower, 'UTF8')), 'hex') = ANY(%s) "
                "   OR EXISTS ("
                "     SELECT 1 FROM public.identity_identity i "
                "     WHERE i.user_id = %s AND i.organisation_id = sp.organisation_id "
                "       AND lower(i.email) = sp.email_lower"
                "   )",
                [uid, email_list, uid],
            )
            cursor.execute(
                "SELECT to_regprocedure("
                "  'public.ee_audit_build_erasure_seal("
                "bytea,text,uuid,text,text,uuid,bigint,text,text,text,text,text,text,text,text,text,text"
                ")'"
                ") IS NOT NULL"
            )
            if bool((cursor.fetchone() or (False,))[0]):
                erasure_key_hex = derive_server_ee_audit_erasure_key_hex()
                if erasure_key_hex:
                    cursor.execute(
                        "SELECT set_config('kodera.ee_audit_erasure_key_hex', %s, true)",
                        [erasure_key_hex],
                    )
                cursor.execute(
                    "WITH subject_digests AS ("
                    "  SELECT COALESCE(jsonb_agg(DISTINCT sha), '[]'::jsonb) AS digests "
                    "  FROM ("
                    "    SELECT unnest(%s::text[]) AS sha "
                    "    UNION "
                    "    SELECT encode(sha256(convert_to(tok, 'UTF8')), 'hex') AS sha "
                    "    FROM ("
                    "      SELECT lower(btrim(u.email)) AS tok FROM public.identity_user u WHERE u.id = %s "
                    "      UNION "
                    "      SELECT lower(btrim(u.display_name)) AS tok FROM public.identity_user u "
                    "      WHERE u.id = %s AND u.display_name IS NOT NULL "
                    "      UNION "
                    "      SELECT lower(btrim(i.email)) AS tok FROM public.identity_identity i WHERE i.user_id = %s "
                    "      UNION "
                    "      SELECT lower(%s::text) AS tok "
                    "      UNION "
                    "      SELECT lower(i.id::text) AS tok FROM public.identity_identity i WHERE i.user_id = %s "
                    "      UNION "
                    "      SELECT lower(btrim(i.subject)) AS tok FROM public.identity_identity i WHERE i.user_id = %s"
                    "    ) tokens "
                    "    WHERE tok IS NOT NULL AND tok <> '' AND tok NOT LIKE 'erased:%%'"
                    "  ) d "
                    "  WHERE sha IS NOT NULL AND sha <> ''"
                    "), "
                    "candidates AS ("
                    "  SELECT s.id, "
                    "         CASE "
                    "           WHEN s.target_urn IS NOT NULL "
                    "                AND s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' "
                    "                AND ("
                    "                  strpos(s.target_urn, '@') > 0 "
                    "                  OR s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$' "
                    "                  OR public.ee_audit_target_urn_matches_digests(s.target_urn, sd.digests)"
                    "                ) "
                    "           THEN public.ee_audit_scrub_target_urn("
                    "             s.target_urn, "
                    "             decode("
                    "               public.ee_audit_hmac_sha256_hex("
                    "                 public.ee_audit_resolve_erasure_master_key(), "
                    "                 convert_to("
                    "                   'kodera-ee-audit-target-urn-v2:ingest:' || %s::text || ':' || s.organisation_id::text, "
                    "                   'UTF8'"
                    "                 )"
                    "               ), "
                    "               'hex'"
                    "             )"
                    "           ) "
                    "           ELSE s.target_urn "
                    "         END AS next_target_urn "
                    "  FROM public.ee_audit_ledger s "
                    "  CROSS JOIN subject_digests sd "
                    "  WHERE s.user_id = %s "
                    "    AND ("
                    "      s.pii_scrubbed_at IS NULL "
                    "      OR s.erasure_commitment IS NULL "
                    "      OR s.source_ip <> '' "
                    "      OR s.metadata_json <> '{}' "
                    "      OR (s.actor_label <> 'erased' AND s.actor_label IS DISTINCT FROM ('erased:' || %s::text)) "
                    "      OR ("
                    "        s.target_urn IS NOT NULL "
                    "        AND s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' "
                    "        AND ("
                    "          strpos(s.target_urn, '@') > 0 "
                    "          OR s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$' "
                    "          OR public.ee_audit_target_urn_matches_digests(s.target_urn, sd.digests)"
                    "        )"
                    "      )"
                    "    )"
                    ") "
                    "UPDATE public.ee_audit_ledger l "
                    "SET actor_label = 'erased:' || %s::text, "
                    "    target_urn = c.next_target_urn, "
                    "    source_ip = '', "
                    "    metadata_json = '{}', "
                    "    pii_scrubbed_at = COALESCE(l.pii_scrubbed_at, clock_timestamp()), "
                    "    erasure_commitment = public.ee_audit_build_erasure_seal("
                    "      public.ee_audit_resolve_erasure_master_key(), "
                    "      'ingest', "
                    "      %s, "
                    "      repeat('0', 64), "
                    "      repeat('0', 64), "
                    "      l.organisation_id, "
                    "      l.seq, "
                    "      l.event_id, "
                    "      l.occurred_at, "
                    "      l.tenant_slug, "
                    "      l.actor_type, "
                    "      l.actor_id, "
                    "      'erased:' || %s::text, "
                    "      l.action, "
                    "      c.next_target_urn, "
                    "      l.prev_hash, "
                    "      l.entry_hash"
                    "    ) "
                    "FROM candidates c "
                    "WHERE l.id = c.id AND l.user_id = %s",
                    [email_list, *([uid] * 13)],
                )
            else:
                cursor.execute(
                    "UPDATE public.ee_audit_ledger "
                    "SET actor_label = 'erased:' || %s::text, "
                    "    source_ip = '', "
                    "    metadata_json = '{}', "
                    "    pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp()) "
                    "WHERE user_id = %s AND pii_scrubbed_at IS NULL",
                    [uid, uid],
                )

        cursor.execute("SELECT to_regclass('public.ee_billing_purchase_orders') IS NOT NULL")
        if bool((cursor.fetchone() or (False,))[0]):
            cursor.execute(
                "WITH target_orgs AS ("
                "  SELECT DISTINCT m.organisation_id::text AS org_txt "
                "  FROM public.orgs_membership m WHERE m.user_id = %s "
                "  UNION "
                "  SELECT DISTINCT i.organisation_id::text AS org_txt "
                "  FROM public.identity_identity i WHERE i.user_id = %s AND i.organisation_id IS NOT NULL"
                "), "
                "signatory_digests AS ("
                "  SELECT DISTINCT sha "
                "  FROM ("
                "    SELECT unnest(%s::text[]) AS sha "
                "    UNION "
                "    SELECT encode(sha256(convert_to(tok, 'UTF8')), 'hex') AS sha "
                "    FROM ("
                "      SELECT lower(btrim(u.email)) AS tok FROM public.identity_user u WHERE u.id = %s "
                "      UNION "
                "      SELECT lower(btrim(i.email)) AS tok FROM public.identity_identity i WHERE i.user_id = %s "
                "      UNION "
                "      SELECT lower(%s::text) AS tok "
                "      UNION "
                "      SELECT lower(i.id::text) AS tok FROM public.identity_identity i WHERE i.user_id = %s "
                "      UNION "
                "      SELECT lower(btrim(i.subject)) AS tok FROM public.identity_identity i WHERE i.user_id = %s"
                "    ) tokens "
                "    WHERE tok IS NOT NULL AND tok <> '' AND tok NOT LIKE 'erased:%%'"
                "  ) d "
                "  WHERE sha IS NOT NULL AND sha <> ''"
                ") "
                "UPDATE public.ee_billing_purchase_orders po "
                "SET countersigned_by = CASE "
                "      WHEN po.countersigned_by IS NULL THEN NULL "
                "      ELSE 'erased:' || %s::text "
                "    END, "
                "    countersigned_by_user_id = NULL, "
                "    pii_scrubbed_at = COALESCE(po.pii_scrubbed_at, clock_timestamp()) "
                "WHERE ("
                "  po.countersigned_by_user_id = %s "
                "  OR ("
                "    po.countersigned_by_user_id IS NULL "
                "    AND po.countersigned_by IS NOT NULL "
                "    AND ("
                "      encode(sha256(convert_to(lower(btrim(po.countersigned_by)), 'UTF8')), 'hex') = ANY(%s::text[]) "
                "      OR ("
                "        po.organisation_id IN (SELECT org_txt FROM target_orgs) "
                "        AND ("
                "          encode(sha256(convert_to(lower(btrim(po.countersigned_by)), 'UTF8')), 'hex') "
                "            IN (SELECT sha FROM signatory_digests) "
                "          OR EXISTS ("
                "            SELECT 1 "
                "            FROM ("
                "              SELECT lower(btrim(u.email)) AS em FROM public.identity_user u WHERE u.id = %s "
                "              UNION "
                "              SELECT lower(btrim(i.email)) AS em FROM public.identity_identity i WHERE i.user_id = %s"
                "            ) addr "
                "            WHERE addr.em IS NOT NULL "
                "              AND addr.em <> '' "
                "              AND addr.em NOT LIKE 'erased:%%' "
                "              AND strpos(lower(po.countersigned_by), addr.em) > 0"
                "          )"
                "        )"
                "      )"
                "    )"
                "  )"
                ") "
                "AND ("
                "  po.countersigned_by_user_id IS NOT NULL "
                "  OR ("
                "    po.countersigned_by IS DISTINCT FROM ('erased:' || %s::text) "
                "    AND po.countersigned_by IS DISTINCT FROM 'erased'"
                "  )"
                ")",
                [
                    uid,
                    uid,
                    email_list,
                    uid,
                    uid,
                    uid,
                    uid,
                    uid,
                    uid,
                    uid,
                    email_list,
                    uid,
                    uid,
                    uid,
                ],
            )

    @transaction.atomic
    def drain_in_flight_leases(self) -> dict[str, int]:
        """Drain frozen snapshot `in_flight` push/outbox leases before replaying Art. 17 erasures."""
        now = database_now()
        push_drained = notification_services.drain_snapshot_in_flight_leases(now=now)
        sched_drained = workspace_services.drain_snapshot_in_flight_leases(now=now)
        outbox_counts = outbox_services.drain_snapshot_in_flight_leases(now=now)
        return {
            "push_in_flight_drained": push_drained,
            "scheduled_messages_in_flight_drained": sched_drained,
            **outbox_counts,
        }

    def _verify_zero_residual_organisation(
        self,
        organisation_id: UUID,
        *,
        unshared_user_ids: Sequence[str] = (),
        unshared_email_sha256s: Sequence[str] = (),
    ) -> None:
        if not extension_services.has_workspace_cutoff(organisation_id=organisation_id):
            raise RestoreRehearsalError(
                f"WorkspaceCutoff missing for erased organisation {organisation_id}",
                code="missing_workspace_cutoff",
                unresolved_domains=("workspace_cutoff",),
            )
        unresolved: list[str] = []
        org_row = Organisation.objects.filter(id=organisation_id).first()
        if org_row is not None and (
            org_row.state != "closed"
            or org_row.name != "Erased organisation"
            or org_row.security_contact_email is not None
            or org_row.privacy_contact_email is not None
            or org_row.subprocessor_notice_email is not None
        ):
            unresolved.append("organisation_contacts")
        if self._count_org_unscrubbed_intake(organisation_id) > 0:
            unresolved.append("organisation_intake")
        if (
            identity_selectors.count_unerased_identities_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("identity_contacts")
        if (
            identity_selectors.count_unscrubbed_identity_subjects_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("retained_identity_subjects")
        if (
            identity_selectors.count_residual_passport_for_organisation(
                organisation_id=organisation_id,
                unshared_user_ids=tuple(unshared_user_ids),
                unshared_email_sha256s=tuple(unshared_email_sha256s),
            )
            > 0
        ):
            unresolved.append("passport_records")
        if (
            support_services.count_unscrubbed_tickets_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("support_tickets")
        if self._count_org_unscrubbed_invitations(organisation_id) > 0:
            unresolved.append("workspace_invitations")
        if self._count_org_unexpired_exports(organisation_id) > 0:
            unresolved.append("private_exports")
        if (
            outbox_services.count_sealed_messages_for_organisation(organisation_id=organisation_id)
            + outbox_services.count_active_deliveries_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("sealed_outbox_mail")
        if (
            notification_services.count_residual_rows_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("notifications")
        if (
            extension_services.count_residual_extension_rows_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("extensions")
        if (
            workspace_services.count_residual_experience_rows_for_organisation(
                organisation_id=organisation_id
            )
            > 0
        ):
            unresolved.append("workspace_experience")
        if media_services.count_attachments_for_organisation(organisation_id=organisation_id) > 0:
            unresolved.append("media_attachments")
        if e2ee_services.count_residual_e2ee_for_organisation(organisation_id=organisation_id) > 0:
            unresolved.append("e2ee_resources")
        if self._count_org_residual_ee(organisation_id) > 0:
            unresolved.append("enterprise_identity_and_audit")

        if unresolved:
            raise RestoreRehearsalError(
                f"erased organisation retains PII in unresolved domains: {', '.join(unresolved)}",
                code="residual_organisation_pii",
                unresolved_domains=unresolved,
            )

    def _verify_zero_residual_user(
        self,
        user_id: UUID,
        *,
        personal_attachment_ids: tuple[UUID, ...],
        email_sha256s: Sequence[str] = (),
        principal_sha256s: Sequence[str] = (),
        non_accepted_invitation_ids: Sequence[str] = (),
    ) -> None:
        unresolved: list[str] = []
        if not identity_selectors.is_user_pii_purged(user_id=user_id):
            unresolved.append("user_contacts")
        active_memberships = (
            Membership.objects.filter(user_id=user_id, deleted_at__isnull=True)
            .exclude(state="removed")
            .exclude(organisation__state="closed")
            .count()
        )
        if active_memberships > 0:
            unresolved.append("memberships")
        if identity_selectors.count_unerased_identities_for_user(user_id=user_id) > 0:
            unresolved.append("identity_contacts")
        if (
            identity_selectors.count_unscrubbed_identity_subjects_for_user(user_id=user_id) > 0
            or self._count_user_idempotency_records(user_id, principal_sha256s=principal_sha256s)
            > 0
        ):
            unresolved.append("retained_identity_subjects")
        if (
            identity_selectors.count_residual_passport_for_user(
                user_id=user_id,
                email_sha256s=tuple(email_sha256s),
            )
            > 0
        ):
            unresolved.append("passport_records")
        if support_services.count_unscrubbed_tickets_for_user(user_id=user_id) > 0:
            unresolved.append("support_tickets")
        if (
            self._count_user_unscrubbed_invitations(
                user_id,
                email_sha256s=email_sha256s,
                non_accepted_invitation_ids=non_accepted_invitation_ids,
            )
            > 0
        ):
            unresolved.append("workspace_invitations")
        unexpired_exports = (
            PrivacyExport.objects.filter(user_id=user_id)
            .exclude(status="expired", checkpoint={})
            .count()
        )
        if unexpired_exports > 0:
            unresolved.append("private_exports")
        if (
            outbox_services.count_residual_personal_outbox_for_user(
                user_id=user_id,
                email_sha256s=tuple(email_sha256s),
            )
            > 0
        ):
            unresolved.append("sealed_outbox_mail")
        if notification_services.count_residual_rows_for_user(user_id=user_id) > 0:
            unresolved.append("notifications")
        if workspace_services.count_residual_experience_rows_for_user(user_id=user_id) > 0:
            unresolved.append("workspace_experience")
        if (
            media_services.count_residual_user_attachment_pii(
                user_id=user_id,
                extra_personal_attachment_ids=personal_attachment_ids,
            )
            > 0
        ):
            unresolved.append("media_attachments")
        if e2ee_services.count_residual_e2ee_for_user(user_id=user_id) > 0:
            unresolved.append("e2ee_resources")
        if self._count_user_residual_ee(user_id, email_sha256s=email_sha256s) > 0:
            unresolved.append("enterprise_identity_and_audit")

        if unresolved:
            raise RestoreRehearsalError(
                f"erased person retains PII in unresolved domains: {', '.join(unresolved)}",
                code="residual_user_pii",
                unresolved_domains=unresolved,
            )

    def _ensure_account_protocol_emitted(self, erasure: AccountErasure) -> None:
        if erasure.protocol_emitted_at is not None:
            return
        from .account_erasure_services import emit_account_erasure_engine_sets

        uid = erasure.user_reference
        with transaction.atomic():
            emit_account_erasure_engine_sets(user_id=uid, lock_organisations=True)
            with connection.cursor() as cursor:
                cursor.execute("SELECT privacy_account_protocol_recorded(%s)", [erasure.id])

    def _scrub_partially_cleared_person_domains(
        self,
        uid: UUID,
        *,
        personal_attachment_ids: set[UUID],
        manifest_keys: frozenset[str] | None,
        upload_drain: RehearsalIsolatedUploadDrainVerifier,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """Complete local-domain scrubbing when `identity_user.enabled` was already cleared pre-cutoff."""
        email_shas = identity_selectors.person_email_sha256s(user_id=uid)
        principal_shas = identity_selectors.person_principal_sha256s(user_id=uid)
        personal_atts = media_services.list_personal_attachments_for_user(user_id=uid)
        keys_to_check: list[str] = []
        expiries: list[datetime] = []
        for entry in personal_atts:
            att_uuid = _parse_uuid(entry["id"], field_name="personal_attachment.id")
            org_uuid = _parse_uuid(
                entry["organisation_id"], field_name="personal_attachment.organisation_id"
            )
            personal_attachment_ids.add(att_uuid)
            keys_to_check.append(
                attachment_object_key(organisation_id=org_uuid, attachment_id=att_uuid)
            )
            exp = _parse_upload_expiry(entry.get("upload_expires_at"))
            if exp is not None:
                expiries.append(exp)

        if keys_to_check:
            sorted_keys = tuple(sorted(set(keys_to_check)))
            max_exp = max(expiries) if expiries else None
            synthetic_scope = AccountErasureScope(
                request_id=uid,
                user_id=uid,
                cutoff_at=database_now(),
                inventory={},
            )
            try:
                _check_upload_drain(upload_drain, synthetic_scope, sorted_keys, max_exp)
            except ObjectUploadWindowOpenError:
                raise RestoreRehearsalError(
                    "account personal attachment erasure held (presigned upload drain window open)",
                    code="account_personal_objects_held",
                    unresolved_domains=("account_personal_objects",),
                ) from None
            deleter = RehearsalManifestObjectDeleter(manifest_keys=manifest_keys)
            for key in sorted_keys:
                deleter(key)

        with transaction.atomic():
            now = database_now()
            memberships = list(
                Membership.objects.filter(user_id=uid, deleted_at__isnull=True)
                .select_related("organisation")
                .order_by("organisation_id", "id")
            )
            for member in memberships:
                if member.state != "removed":
                    Membership.objects.filter(pk=member.id).update(state="removed", updated_at=now)
                    member.state = "removed"
            for member in memberships:
                if member.organisation.state != "closed":
                    enqueue_realm_access(
                        organisation_id=member.organisation_id,
                        membership_id=member.id,
                        user_id=uid,
                        operation=ACCESS_OFF,
                    )
                    member_set_hooks.member_erased(member)

            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO public.retention_worker_context "
                    "VALUES (pg_backend_pid(), txid_current(), 'account', 'identity_user', %s, '{}')",
                    [uid],
                )
                try:
                    notification_services.purge_rows_for_user(user_id=uid)
                    workspace_services.purge_experience_rows_for_user(user_id=uid)
                    # Scrub EE SCIM/SAML/audit tables BEFORE overwriting `identity_identity.email`
                    # so `lower(i.email)` joins still resolve!
                    self._scrub_ee_tables_for_user_in_account_context(cursor, uid, email_shas)
                    support_services.scrub_tickets_for_user(user_id=uid, now=now)
                    outbox_services.scrub_personal_outbox_for_user(
                        user_id=uid,
                        email_sha256s=email_shas,
                        now=now,
                    )
                    identity_services.scrub_passport_records_for_user(
                        user_id=uid,
                        email_sha256s=email_shas,
                    )
                    cursor.execute(
                        "SELECT to_regclass('public.orgs_invitationoutboxbinding') IS NOT NULL"
                    )
                    if cursor.fetchone()[0]:
                        cursor.execute(
                            "DELETE FROM orgs_invitationoutboxbinding ib "
                            "WHERE ib.recipient_email_sha256 = ANY(%s) "
                            "   OR EXISTS ("
                            "     SELECT 1 FROM orgs_invitation inv "
                            "     JOIN orgs_membership m ON m.id = inv.membership_id "
                            "     WHERE inv.id = ib.invitation_id AND m.user_id = %s"
                            "   )",
                            [list(email_shas), uid],
                        )
                    cursor.execute(
                        "UPDATE orgs_privacyexport "
                        "SET status = 'expired', checkpoint = '{}'::jsonb, "
                        "    revision = revision + 1, updated_at = %s "
                        "WHERE user_id = %s AND (status <> 'expired' OR checkpoint <> '{}'::jsonb)",
                        [now, uid],
                    )
                    cursor.execute(
                        "UPDATE orgs_invitation "
                        "SET email = 'erased+' || id::text || '@invalid.test', "
                        "    display_name = NULL, "
                        "    token_digest = decode('', 'hex'), "
                        "    token_sealed = decode('', 'hex'), "
                        "    updated_at = %s "
                        "WHERE membership_id IN (SELECT id FROM orgs_membership WHERE user_id = %s) "
                        "  AND (email <> 'erased+' || id::text || '@invalid.test' "
                        "       OR display_name IS NOT NULL "
                        "       OR octet_length(token_digest) <> 0 "
                        "       OR octet_length(token_sealed) <> 0)",
                        [now, uid],
                    )
                    if email_shas:
                        cursor.execute(
                            "UPDATE orgs_invitation "
                            "SET email = 'erased+' || id::text || '@invalid.test', "
                            "    display_name = NULL, "
                            "    token_digest = decode('', 'hex'), "
                            "    token_sealed = decode('', 'hex'), "
                            "    state = CASE WHEN state = 'pending' THEN 'revoked' ELSE state END, "
                            "    revoked_at = CASE WHEN state = 'pending' "
                            "                 THEN COALESCE(revoked_at, %s) ELSE revoked_at END, "
                            "    updated_at = %s "
                            "WHERE membership_id IS NULL "
                            "  AND state <> 'accepted' "
                            "  AND encode(sha256(convert_to(lower(btrim(email)), 'UTF8')), 'hex') = ANY(%s)",
                            [now, now, list(email_shas)],
                        )
                    cursor.execute("SELECT to_regclass('public.idempotency_record') IS NOT NULL")
                    if cursor.fetchone()[0]:
                        cursor.execute(
                            "DELETE FROM idempotency_record r "
                            "WHERE EXISTS ("
                            "  SELECT 1 FROM identity_identity i "
                            "  WHERE i.user_id = %s AND r.issuer = i.issuer AND r.subject = i.subject"
                            ") OR encode("
                            "  sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), "
                            "  'hex'"
                            ") = ANY(%s)",
                            [uid, list(principal_shas)],
                        )
                    media_services.scrub_and_delete_user_attachments_in_account_context(
                        user_id=uid,
                        extra_personal_attachment_ids=tuple(
                            sorted(personal_attachment_ids, key=str)
                        ),
                        now=now,
                    )
                    e2ee_services.purge_account_e2ee_in_account_context(user_id=uid)
                    identity_services.scrub_person_contacts_and_subjects_in_account_context(
                        user_id=uid,
                        now=now,
                    )
                finally:
                    cursor.execute(
                        "DELETE FROM public.retention_worker_context "
                        "WHERE backend = pg_backend_pid() "
                        "  AND transaction = txid_current() "
                        "  AND purpose = 'account' "
                        "  AND source_table = 'identity_user' "
                        "  AND source_id = %s",
                        [uid],
                    )
        return email_shas, principal_shas

    def replay_erasure_ledger(
        self,
        ledger: ErasureLedger,
        *,
        actor_identity_id: UUID | None = None,
        s3_manifest: S3InventoryManifest | None = None,
    ) -> ErasureReplaySummary:
        now = database_now()
        if ledger.backup_created_at > now:
            raise RestoreRehearsalError(
                "erasure ledger backup_created_at cannot be in the future",
                code="backup_created_at_in_future",
            )

        manifest_keys: frozenset[str] | None = (
            frozenset(obj.key for obj in s3_manifest.objects) if s3_manifest is not None else None
        )
        rehearsal_drain = RehearsalIsolatedUploadDrainVerifier()

        operator_id: UUID | None = actor_identity_id
        if ledger.organisation_entries or ledger.user_entries:
            if operator_id is None:
                operator_id = identity_services.ensure_rehearsal_operator_identity()

        org_adapters: dict[str, ErasureAdapter] = {
            domain: _RehearsalOrgDomainAdapter(
                domain=domain,
                manifest_keys=manifest_keys if domain == "objects" else None,
                upload_drain=rehearsal_drain if domain == "objects" else None,
            )
            for domain in (
                "matrix",
                "objects",
                "identity_provider",
                "private_exports",
                "external_extension_receivers",
                "proximity_ephemeral",
            )
        }

        try:
            # Drain any frozen point-in-time snapshot `in_flight` push/outbox leases BEFORE
            # `begin_erasure` / `begin_account_erasure` / `PassportAccountOutboxErasureAdapter`
            # check for live in-flight workers.
            self.drain_in_flight_leases()

            for org_entry in ledger.organisation_entries:
                org_id = org_entry.organisation_id
                existing_org_erasure = PrivacyErasure.objects.filter(
                    organisation_reference=org_id
                ).first()
                if existing_org_erasure is None:
                    if Organisation.objects.filter(id=org_id).exists():
                        if operator_id is None:
                            raise RestoreRehearsalError(
                                "rehearsal staff_operator identity unavailable",
                                code="erasure_operator_unavailable",
                            )
                        existing_org_erasure = begin_erasure(
                            organisation_id=org_id,
                            instruction_ref=org_entry.instruction_ref,
                            instruction_sha256=org_entry.instruction_sha256,
                            purge_not_before=database_now(),
                            actor_identity_id=operator_id,
                        )
                    else:
                        extension_services.record_workspace_cutoff(
                            organisation_id=org_id,
                            cutoff_at=database_now(),
                        )

                if existing_org_erasure is not None:
                    req_org_domains = existing_org_erasure.inventory.get("required_domains", [])
                    selected_org_adapters = {
                        d: org_adapters[d]
                        for d in req_org_domains
                        if isinstance(d, str) and d in org_adapters
                    }
                    for _ in range(64):
                        progress = advance_erasure(existing_org_erasure.id, selected_org_adapters)
                        if progress.get("core_purged") is True:
                            held_org = progress.get("held_domains", [])
                            if isinstance(held_org, list) and "objects" in held_org:
                                raise RestoreRehearsalError(
                                    "organisation object erasure held (presigned upload drain window open)",
                                    code="organisation_objects_held",
                                    unresolved_domains=("objects",),
                                )
                            break
                    else:
                        raise RestoreRehearsalError(
                            "organisation Core erasure did not converge within bounded steps",
                            code="organisation_erasure_incomplete",
                        )
                    extension_services.record_workspace_cutoff(
                        organisation_id=org_id,
                        cutoff_at=existing_org_erasure.cutoff_at,
                    )

                org_unshared_uids: tuple[str, ...] = ()
                org_unshared_shas: tuple[str, ...] = ()
                if existing_org_erasure is not None:
                    raw_uids = existing_org_erasure.inventory.get("passport_unshared_user_ids")
                    if isinstance(raw_uids, list):
                        org_unshared_uids = tuple(str(u) for u in raw_uids if isinstance(u, str))
                    raw_ushas = existing_org_erasure.inventory.get(
                        "passport_unshared_email_sha256s"
                    )
                    if isinstance(raw_ushas, list):
                        org_unshared_shas = tuple(str(s) for s in raw_ushas if isinstance(s, str))

                self._verify_zero_residual_organisation(
                    org_id,
                    unshared_user_ids=org_unshared_uids,
                    unshared_email_sha256s=org_unshared_shas,
                )

            outbox_adapter = outbox_services.default_account_outbox_erasure_adapter()
            base_acct_adapters: dict[str, AccountErasureAdapter] = {
                "account_message_outbox": outbox_adapter,
                "matrix_accounts": _RehearsalAccountDomainAdapter(domain="matrix_accounts"),
                "identity_provider_accounts": _RehearsalAccountDomainAdapter(
                    domain="identity_provider_accounts"
                ),
                "private_exports": _RehearsalAccountDomainAdapter(domain="private_exports"),
                "account_extension_subjects": _RehearsalAccountDomainAdapter(
                    domain="account_extension_subjects"
                ),
                "proximity_ephemeral": _RehearsalAccountDomainAdapter(domain="proximity_ephemeral"),
            }

            for user_entry in ledger.user_entries:
                uid = user_entry.user_id
                personal_att_ids = set(user_entry.erased_attachment_ids)
                email_shas: tuple[str, ...] = ()
                principal_shas: tuple[str, ...] = ()
                non_accepted_inv_ids: tuple[str, ...] = ()

                existing_acct = AccountErasure.objects.filter(user_reference=uid).first()
                if existing_acct is None and identity_selectors.user_exists(user_id=uid):
                    if identity_selectors.enabled_user(user_id=uid):
                        identities = identity_selectors.person_identities(user_id=uid)
                        if not identities:
                            raise RestoreRehearsalError(
                                "enabled person in erasure ledger has no active customer identity to admit cutoff",
                                code="account_erasure_identity_unavailable",
                            )
                        chosen = identities[0]
                        now_epoch = int(database_now().timestamp())
                        rehearsal_token = VerifiedAccessToken(
                            issuer=chosen.issuer,
                            subject=chosen.subject,
                            audience=(AUDIENCE,),
                            issued_at=now_epoch,
                            expires_at=now_epoch + 300,
                            not_before=now_epoch,
                            amr=("pwd", "otp"),
                            acr=None,
                            auth_time=now_epoch,
                            email_verified=True,
                            email=chosen.email,
                        )
                        if operator_id is None:
                            raise RestoreRehearsalError(
                                "rehearsal staff_operator identity unavailable",
                                code="erasure_operator_unavailable",
                            )
                        existing_acct = begin_account_erasure(
                            verified=rehearsal_token,
                            confirmation="delete",
                            instruction_ref=user_entry.instruction_ref,
                            instruction_sha256=user_entry.instruction_sha256,
                            purge_not_before=database_now(),
                            actor_identity_id=operator_id,
                        )
                    else:
                        email_shas, principal_shas = self._scrub_partially_cleared_person_domains(
                            uid,
                            personal_attachment_ids=personal_att_ids,
                            manifest_keys=manifest_keys,
                            upload_drain=rehearsal_drain,
                        )

                if existing_acct is not None:
                    self._ensure_account_protocol_emitted(existing_acct)
                    inv_atts = existing_acct.inventory.get("account_personal_attachments", [])
                    if isinstance(inv_atts, list):
                        for item in inv_atts:
                            if isinstance(item, Mapping) and item.get("id"):
                                personal_att_ids.add(
                                    _parse_uuid(
                                        item["id"], field_name="account_personal_attachments"
                                    )
                                )
                    raw_email_shas = existing_acct.inventory.get(
                        "person_email_sha256s"
                    ) or existing_acct.inventory.get("passport_email_sha256s")
                    if isinstance(raw_email_shas, list):
                        email_shas = tuple(str(s) for s in raw_email_shas if isinstance(s, str))
                    raw_prin_shas = existing_acct.inventory.get("identity_principal_sha256s")
                    if isinstance(raw_prin_shas, list):
                        principal_shas = tuple(str(s) for s in raw_prin_shas if isinstance(s, str))
                    raw_inv_ids = existing_acct.inventory.get("non_accepted_invitation_ids")
                    if isinstance(raw_inv_ids, list):
                        non_accepted_inv_ids = tuple(
                            str(s) for s in raw_inv_ids if isinstance(s, str)
                        )

                    required_domains = existing_acct.inventory.get("required_domains", [])
                    selected_acct_adapters = (
                        {
                            d: base_acct_adapters[d]
                            for d in required_domains
                            if isinstance(d, str) and d in base_acct_adapters
                        }
                        if isinstance(required_domains, list)
                        else {}
                    )
                    rehearsal_deleter = RehearsalManifestObjectDeleter(manifest_keys=manifest_keys)
                    acct_progress = advance_account_erasure(
                        existing_acct.id,
                        selected_acct_adapters,
                        object_deleter=rehearsal_deleter,
                        upload_drain=rehearsal_drain,
                    )
                    if acct_progress.get("core_contacts_purged") is not True:
                        raise RestoreRehearsalError(
                            "account Core erasure failed to purge personal contacts",
                            code="account_erasure_incomplete",
                        )
                    held_acct = acct_progress.get("held_domains", [])
                    if isinstance(held_acct, list) and "account_personal_objects" in held_acct:
                        raise RestoreRehearsalError(
                            "account personal attachment erasure held (presigned upload drain window open)",
                            code="account_personal_objects_held",
                            unresolved_domains=("account_personal_objects",),
                        )
                    if acct_progress.get("complete") is not True:
                        unresolved_held = (
                            tuple(str(h) for h in held_acct) if isinstance(held_acct, list) else ()
                        )
                        raise RestoreRehearsalError(
                            "account erasure did not reach complete state across all required domains",
                            code="account_erasure_incomplete",
                            unresolved_domains=unresolved_held,
                        )

                self._verify_zero_residual_user(
                    uid,
                    personal_attachment_ids=tuple(sorted(personal_att_ids, key=str)),
                    email_sha256s=email_shas,
                    principal_sha256s=principal_shas,
                    non_accepted_invitation_ids=non_accepted_inv_ids,
                )
        except RestoreRehearsalError:
            raise
        except (DatabaseError, ValueError) as err:
            raise RestoreRehearsalError(
                f"erasure replay failed closed: {type(err).__name__}",
                code="erasure_replay_failed",
            ) from None

        return ErasureReplaySummary(
            backup_created_at=ledger.backup_created_at.isoformat().replace("+00:00", "Z"),
            organisations_replayed=len(ledger.organisation_entries),
            users_replayed=len(ledger.user_entries),
            workspace_cutoffs_verified=len(ledger.organisation_entries),
            zero_residual_pii_verified=True,
        )

    @transaction.atomic
    def disarm_outbound(self) -> OutboundDisarmSummary:
        now = database_now()
        cutoff_orgs = tuple(
            PrivacyErasure.objects.order_by("organisation_reference").values_list(
                "organisation_reference", flat=True
            )
        )
        cutoff_users = tuple(
            AccountErasure.objects.order_by("user_reference").values_list(
                "user_reference", flat=True
            )
        )
        ext_counts = extension_services.disarm_rehearsal_outbound(now=now)
        notif_counts = notification_services.disarm_rehearsal_outbound(
            now=now,
            excluded_organisation_ids=cutoff_orgs,
            excluded_user_ids=cutoff_users,
        )
        outbox_counts = outbox_services.disarm_rehearsal_outbound(
            now=now,
            excluded_organisation_ids=cutoff_orgs,
        )
        support_counts = support_services.disarm_rehearsal_outbound(
            now=now,
            excluded_organisation_ids=cutoff_orgs,
        )
        billing_counts = billing_services.disarm_rehearsal_outbound(now=now)
        ws_counts = workspace_services.disarm_rehearsal_outbound(
            now=now,
            excluded_organisation_ids=cutoff_orgs,
            excluded_user_ids=cutoff_users,
        )
        return OutboundDisarmSummary(
            installations_revoked=ext_counts["installations_revoked"],
            deliveries_obsoleted=ext_counts["deliveries_obsoleted"],
            coexistence_bridges_revoked=ext_counts["coexistence_bridges_revoked"],
            coexistence_secrets_zeroized=ext_counts["coexistence_secrets_zeroized"],
            coexistence_outbound_obsoleted=ext_counts["coexistence_outbound_obsoleted"],
            digest_jobs_obsoleted=ext_counts["digest_jobs_obsoleted"],
            push_outbox_disarmed=notif_counts["push_outbox_disarmed"],
            push_subscriptions_revoked=notif_counts["push_subscriptions_revoked"],
            outbox_deliveries_cancelled=outbox_counts["outbox_deliveries_cancelled"],
            outbox_messages_cleared=outbox_counts["outbox_messages_cleared"],
            outbox_attempts_abandoned=outbox_counts["outbox_attempts_abandoned"],
            bug_reports_disarmed=support_counts["bug_reports_disarmed"],
            support_tickets_disarmed=support_counts["support_tickets_disarmed"],
            payment_links_disarmed=billing_counts["payment_links_disarmed"],
            scheduled_messages_disarmed=ws_counts.get("scheduled_messages_disarmed", 0),
            personal_reminders_disarmed=notif_counts.get("personal_reminders_disarmed", 0),
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
        erased_orgs = set(extra_erased_org_ids) | extension_services.list_workspace_cutoff_ids()
        erased_atts = set(extra_erased_attachment_ids)
        erased_users = set(extra_erased_user_ids)

        for org_ref, inv in PrivacyErasure.objects.values_list(
            "organisation_reference", "inventory"
        ):
            erased_orgs.add(org_ref)
            if isinstance(inv, Mapping):
                raw_list = inv.get("attachments", [])
                if isinstance(raw_list, list):
                    for att_str in raw_list:
                        if isinstance(att_str, str):
                            with contextlib.suppress(ValueError):
                                erased_atts.add(UUID(att_str))

        for user_ref, inv in AccountErasure.objects.values_list("user_reference", "inventory"):
            erased_users.add(user_ref)
            if isinstance(inv, Mapping):
                raw_personal = inv.get("account_personal_attachments", [])
                if isinstance(raw_personal, list):
                    for item in raw_personal:
                        if isinstance(item, Mapping) and isinstance(item.get("id"), str):
                            with contextlib.suppress(ValueError):
                                erased_atts.add(UUID(item["id"]))

        completed = media_services.list_completed_attachments()
        return completed, erased_orgs, erased_users, erased_atts


def execute_restore_guards(
    *,
    disarm_outbound: bool = False,
    erasure_ledger_path: Path | None = None,
    s3_manifest_path: Path | None = None,
    actor_identity_id: UUID | None = None,
    backend_factory: Callable[[], RestoreRehearsalBackend] = DjangoRestoreRehearsalBackend,
) -> RestoreGuardsReport:
    """Execute requested restore rehearsal guards in safe order: erasure -> disarm -> S3 check."""
    if not disarm_outbound and erasure_ledger_path is None and s3_manifest_path is None:
        raise RestoreRehearsalError(
            "at least one guard flag (--disarm-outbound, --erasure-ledger, --s3-manifest) is required",
            code="no_guards_selected",
        )

    ledger: ErasureLedger | None = None
    if erasure_ledger_path is not None:
        ledger = parse_erasure_ledger(
            read_json_file_nofollow(erasure_ledger_path, label="erasure ledger")
        )

    s3_manifest: S3InventoryManifest | None = None
    if s3_manifest_path is not None:
        s3_manifest = parse_s3_manifest(
            read_json_file_nofollow(s3_manifest_path, label="S3 manifest")
        )

    backend = backend_factory()
    erasure_summary: ErasureReplaySummary | None = None
    if ledger is not None:
        erasure_summary = backend.replay_erasure_ledger(
            ledger,
            actor_identity_id=actor_identity_id,
            s3_manifest=s3_manifest,
        )

    disarm_summary: OutboundDisarmSummary | None = None
    if disarm_outbound:
        disarm_summary = backend.disarm_outbound()

    s3_summary: S3ReconciliationSummary | None = None
    if s3_manifest is not None:
        completed, erased_orgs, erased_users, erased_atts = backend.collect_s3_reconciliation_state(
            extra_erased_org_ids=set(ledger.organisation_ids) if ledger else set(),
            extra_erased_user_ids=set(ledger.user_ids) if ledger else set(),
            extra_erased_attachment_ids=(set(ledger.erased_attachment_ids) if ledger else set()),
        )
        s3_summary = reconcile_attachments_with_s3_manifest(
            completed_attachments=completed,
            manifest=s3_manifest,
            erased_organisation_ids=erased_orgs,
            erased_user_ids=erased_users,
            erased_attachment_ids=erased_atts,
        )

    return RestoreGuardsReport(
        status="ok",
        outbound_disarmed=bool(disarm_outbound and disarm_summary is not None),
        disarm_summary=disarm_summary,
        erasure_replay=erasure_summary,
        s3_reconciliation=s3_summary,
    )
