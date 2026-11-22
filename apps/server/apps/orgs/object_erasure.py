"""Authoritative object-storage erasure adapters for organisation (`objects`) and account scopes.

Delegates physical S3 `DELETE` + `HEAD 404` verification to `apps.media.storage_gateway` over the
private Unix-domain worker socket (never holding object-storage credentials in Core), failing closed
on any `StorageRefusedError`, missing or unverified upload-drain proof, or unverified object key.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction

from apps.media import storage_gateway
from apps.media.models import Attachment
from apps.media.storage import StorageRefusedError
from config.upload_limits import UPLOAD_STREAM_DRAIN_SECONDS

from .account_erasure_services import AccountErasureScope
from .erasure_services import AbsenceProof, ErasureScope, database_now
from .privacy_models import AccountErasure, PrivacyErasure


class ObjectUploadWindowOpenError(Exception):
    """Raised when a presigned PUT window or in-flight upload stream has not yet drained."""


def has_in_flight_uploads(object_keys: tuple[str, ...]) -> bool:
    """A ticket remains potentially in flight until 300s after its presigned PUT expiry.

    This is a conservative database fence, not proof that the provider's streams drained.
    The qualified provider/ingress inspector remains mandatory as well.
    """
    ids = [UUID(key.rsplit("/", 1)[-1]) for key in object_keys]
    return Attachment.objects.filter(
        id__in=ids,
        upload_expires_at__gt=database_now() - timedelta(seconds=UPLOAD_STREAM_DRAIN_SECONDS),
    ).exists()


class ObjectReplicaAbsenceVerifier(Protocol):
    """Optional replica/backup absence verifier returning a 64-hex SHA-256 digest."""

    def verify_absent(self, scope: ErasureScope, object_keys: tuple[str, ...]) -> str: ...


class ObjectUploadDrainVerifier(Protocol):
    """Trusted ingress/provider upload-drain verifier returning a 64-hex SHA-256 digest.

    Must prove both that `database_now() >= max_upload_expiry` and that every pre-expiry upload
    stream on the storage ingress/provider for `object_keys` has terminated or drained.
    """

    def verify_drained(
        self,
        scope: ErasureScope | AccountErasureScope,
        object_keys: tuple[str, ...],
        max_upload_expiry: datetime,
    ) -> str: ...


@dataclass(frozen=True)
class BoundedStreamUploadDrainVerifier:
    """Concrete upload-drain verifier backed by an enforced HTTP request-body duration ceiling
    and mandatory authoritative live in-flight upload stream inspection."""

    max_stream_duration: timedelta
    has_in_flight_uploads: Callable[[tuple[str, ...]], bool]

    def __post_init__(self) -> None:
        if not isinstance(
            self.max_stream_duration, timedelta
        ) or self.max_stream_duration <= timedelta(0):
            raise ValueError("max_stream_duration must be a positive timedelta")
        if not callable(self.has_in_flight_uploads):
            raise TypeError(
                "has_in_flight_uploads must be a callable active-upload stream inspector"
            )

    def verify_drained(
        self,
        scope: ErasureScope | AccountErasureScope,
        object_keys: tuple[str, ...],
        max_upload_expiry: datetime,
    ) -> str:
        if max_upload_expiry.tzinfo is None:
            raise ValueError("max_upload_expiry must be timezone-aware")
        now = database_now()
        if now < max_upload_expiry + max(
            self.max_stream_duration, timedelta(seconds=UPLOAD_STREAM_DRAIN_SECONDS)
        ):
            raise ObjectUploadWindowOpenError(
                "presigned upload or bounded stream drain window still open"
            )
        in_flight = self.has_in_flight_uploads(object_keys)
        if not isinstance(in_flight, bool):
            raise TypeError("has_in_flight_uploads must return a bool")
        if in_flight:
            raise ObjectUploadWindowOpenError("pre-expiry object upload stream still in flight")
        scope_binding = (
            {"organisation_id": str(scope.organisation_id)}
            if isinstance(scope, ErasureScope)
            else {"user_id": str(scope.user_id)}
        )
        return hashlib.sha256(
            json.dumps(
                {
                    **scope_binding,
                    "cutoff_at": scope.cutoff_at.isoformat(),
                    "in_flight_probed": True,
                    "inventory_sha256": scope.inventory_sha256,
                    "max_stream_duration_us": int(
                        self.max_stream_duration // timedelta(microseconds=1)
                    ),
                    "max_upload_expiry": max_upload_expiry.isoformat(),
                    "object_keys": list(object_keys),
                    "request_id": str(scope.request_id),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()


ObjectDeleter = Callable[[str], dict[str, Any]]


def attachment_object_key(*, organisation_id: UUID | str, attachment_id: UUID | str) -> str:
    return f"organisations/{UUID(str(organisation_id))}/attachments/{UUID(str(attachment_id))}"


def invoke_gateway_delete(
    target_key: str,
    *,
    socket_path: str | None = None,
    deleter: ObjectDeleter | None = None,
) -> dict[str, Any]:
    """Invoke `storage_gateway.delete_object` (or injected test deleter), failing closed."""
    if deleter is not None:
        result = deleter(target_key)
    else:
        resolved_socket = (
            socket_path
            if socket_path is not None
            else getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None)
        )
        result = storage_gateway.delete_object(target_key, socket_path=resolved_socket)
    if not isinstance(result, dict) or result.get("deleted") is not True:
        raise StorageRefusedError()
    return result


MAX_PREFIX_PAGES = 100_001


def sweep_attachment_prefix(organisation_id: UUID, *, socket_path: str | None = None) -> None:
    """Delete rowless objects too, then require a fresh empty prefix listing.

    Each private RPC reads one bounded S3 page. A failed/partial sweep never yields an
    absence proof; retrying is idempotent. Upload-drain checks still fence late PUTs.
    """
    continuation = None
    seen_tokens: set[str] = set()
    for _ in range(MAX_PREFIX_PAGES):
        page = storage_gateway.attachment_prefix(
            organisation_id, continuation=continuation, socket_path=socket_path
        )
        for key in page["keys"]:
            storage_gateway.attachment_prefix(organisation_id, key=key, socket_path=socket_path)
        continuation = page["continuation"]
        if continuation is None:
            break
        if continuation in seen_tokens:
            raise StorageRefusedError()
        seen_tokens.add(continuation)
    else:
        raise StorageRefusedError()
    page = storage_gateway.attachment_prefix(organisation_id, socket_path=socket_path)
    if page["keys"] or page["continuation"] is not None:
        raise StorageRefusedError()


def _parse_upload_expiry(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError("attachment upload_expires_at malformed")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("attachment upload_expires_at must be timezone-aware")
    return parsed


def _check_upload_drain(
    upload_drain: ObjectUploadDrainVerifier | None,
    scope: ErasureScope | AccountErasureScope,
    object_keys: tuple[str, ...],
    max_upload_expiry: datetime | None,
) -> str | None:
    if max_upload_expiry is None:
        return None
    if database_now() < max_upload_expiry + timedelta(
        seconds=UPLOAD_STREAM_DRAIN_SECONDS
    ) or has_in_flight_uploads(object_keys):
        raise ObjectUploadWindowOpenError("presigned upload window still open")
    if upload_drain is None:
        raise ObjectUploadWindowOpenError(
            "qualified upload drain verifier required for presigned attachment inventory"
        )
    digest = upload_drain.verify_drained(scope, object_keys, max_upload_expiry)
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("object upload drain evidence invalid")
    if database_now() < max_upload_expiry:
        raise ObjectUploadWindowOpenError("presigned upload window still open")
    return digest


@dataclass(frozen=True)
class ObjectWorkspaceErasureAdapter:
    """Concrete `objects` domain adapter for organisation-wide GDPR Art. 17 erasure."""

    socket_path: str | None = None
    deleter: ObjectDeleter | None = None
    replicas: ObjectReplicaAbsenceVerifier | None = None
    upload_drain: ObjectUploadDrainVerifier | None = None
    domain: str = "objects"
    revision: str = "storage-gateway-erasure-v2"

    def _authoritative(
        self, scope: ErasureScope
    ) -> tuple[tuple[str, ...], datetime, datetime | None]:
        row = PrivacyErasure.objects.select_for_update().get(pk=scope.request_id)
        now = database_now()
        if (
            row.organisation_reference != scope.organisation_id
            or row.cutoff_at != scope.cutoff_at
            or row.inventory != scope.inventory
            or row.inventory_sha256 != scope.inventory_sha256
            or row.status not in {"cutoff", "core_purged", "complete"}
            or not (scope.cutoff_at <= row.purge_not_before <= now)
            or self.domain not in row.inventory.get("required_domains", [])
        ):
            raise ValueError("object erasure authority binding mismatch")
        raw_attachments = scope.inventory.get("attachments")
        if not isinstance(raw_attachments, list) or len(raw_attachments) > 100_000:
            raise ValueError("object erasure attachment inventory malformed")
        max_upload_expiry = _parse_upload_expiry(
            scope.inventory.get("org_attachment_max_upload_expires_at")
        )
        keys: list[str] = []
        seen: set[str] = set()
        for item in raw_attachments:
            if not isinstance(item, str):
                raise ValueError("object erasure attachment identifier malformed")
            try:
                normalized = str(UUID(item))
            except ValueError as err:
                raise ValueError("object erasure attachment identifier invalid") from err
            if normalized in seen:
                raise ValueError("duplicate attachment identifier in inventory")
            seen.add(normalized)
            keys.append(
                attachment_object_key(
                    organisation_id=scope.organisation_id, attachment_id=normalized
                )
            )
        return tuple(sorted(keys)), now, max_upload_expiry

    def _evidence(
        self,
        scope: ErasureScope,
        object_keys: tuple[str, ...],
        *,
        drain_digest: str | None = None,
    ) -> str:
        replica_digest: str | None = None
        if self.replicas is not None:
            replica_digest = self.replicas.verify_absent(scope, object_keys)
            if not isinstance(replica_digest, str) or not re.fullmatch(
                r"[0-9a-f]{64}", replica_digest
            ):
                raise ValueError("object replica absence evidence invalid")
        payload: dict[str, Any] = {
            "absent_object_keys": list(object_keys),
            "empty_attachment_prefix": f"organisations/{scope.organisation_id}/attachments/",
            "adapter_revision": self.revision,
            "cutoff_at": scope.cutoff_at.isoformat(),
            "domain": self.domain,
            "inventory_sha256": scope.inventory_sha256,
            "organisation_id": str(scope.organisation_id),
            "request_id": str(scope.request_id),
        }
        if replica_digest is not None:
            payload["replica_evidence_sha256"] = replica_digest
        if drain_digest is not None:
            payload["upload_drain_evidence_sha256"] = drain_digest
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @transaction.atomic
    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        object_keys, _now, max_upload_expiry = self._authoritative(scope)
        pre_drain = _check_upload_drain(self.upload_drain, scope, object_keys, max_upload_expiry)
        for key in object_keys:
            invoke_gateway_delete(key, socket_path=self.socket_path, deleter=self.deleter)
        sweep_attachment_prefix(scope.organisation_id, socket_path=self.socket_path)
        post_drain = _check_upload_drain(self.upload_drain, scope, object_keys, max_upload_expiry)
        if pre_drain != post_drain:
            raise ValueError("object upload drain evidence changed across deletion")
        verified_at = database_now()
        evidence = self._evidence(scope, object_keys, drain_digest=post_drain)
        return AbsenceProof(
            request_id=scope.request_id,
            organisation_id=scope.organisation_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=evidence,
            adapter_revision=self.revision,
            verified_at=verified_at,
        )

    @transaction.atomic
    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
        try:
            object_keys, now, max_upload_expiry = self._authoritative(scope)
            if (
                proof.request_id != scope.request_id
                or proof.organisation_id != scope.organisation_id
                or proof.cutoff_at != scope.cutoff_at
                or proof.domain != self.domain
                or proof.inventory_sha256 != scope.inventory_sha256
                or proof.adapter_revision != self.revision
                or proof.verified_at.tzinfo is None
                or not (scope.cutoff_at <= proof.verified_at <= now)
                or (
                    max_upload_expiry is not None
                    and (now < max_upload_expiry or proof.verified_at < max_upload_expiry)
                )
            ):
                return False
            pre_drain = _check_upload_drain(
                self.upload_drain, scope, object_keys, max_upload_expiry
            )
            for key in object_keys:
                invoke_gateway_delete(key, socket_path=self.socket_path, deleter=self.deleter)
            sweep_attachment_prefix(scope.organisation_id, socket_path=self.socket_path)
            post_drain = _check_upload_drain(
                self.upload_drain, scope, object_keys, max_upload_expiry
            )
            if pre_drain != post_drain:
                return False
            return proof.evidence_sha256 == self._evidence(
                scope, object_keys, drain_digest=post_drain
            )
        except (
            ValueError,
            StorageRefusedError,
            ObjectUploadWindowOpenError,
            PrivacyErasure.DoesNotExist,
        ):
            return False


def erase_account_personal_attachments(
    scope: AccountErasureScope,
    *,
    socket_path: str | None = None,
    deleter: ObjectDeleter | None = None,
    upload_drain: ObjectUploadDrainVerifier | None = None,
) -> bool:
    """Verify presigned PUT stream drainage via `upload_drain` before and after physical S3
    `DELETE` + `HEAD 404`, remove `media_attachment` rows, and record verification in PostgreSQL.

    Fails closed (`False`, zero deletions, zero SQL confirmation) when any attachment carried an
    `upload_expires_at` window and either `upload_drain` is `None` or `verify_drained(...)` refuses.
    """
    raw_items = scope.inventory.get("account_personal_attachments", [])
    if not isinstance(raw_items, list):
        raise ValueError("account_personal_attachments inventory malformed")
    if not raw_items:
        return True

    keys: list[str] = []
    upload_expiries: list[datetime] = []
    for entry in raw_items:
        if not isinstance(entry, dict) or "id" not in entry or "organisation_id" not in entry:
            raise ValueError("account_personal_attachments entry malformed")
        att_id = str(UUID(str(entry["id"])))
        org_id = str(UUID(str(entry["organisation_id"])))
        expiry = _parse_upload_expiry(entry.get("upload_expires_at"))
        if expiry is not None:
            upload_expiries.append(expiry)
        keys.append(attachment_object_key(organisation_id=org_id, attachment_id=att_id))

    sorted_keys = tuple(sorted(set(keys)))
    max_upload_expiry = max(upload_expiries) if upload_expiries else None

    try:
        pre_drain = _check_upload_drain(upload_drain, scope, sorted_keys, max_upload_expiry)
    except ObjectUploadWindowOpenError:
        return False

    for key in sorted_keys:
        invoke_gateway_delete(key, socket_path=socket_path, deleter=deleter)

    try:
        post_drain = _check_upload_drain(upload_drain, scope, sorted_keys, max_upload_expiry)
    except ObjectUploadWindowOpenError:
        return False
    if pre_drain != post_drain:
        raise ValueError("account attachment upload drain evidence changed across deletion")

    evidence_payload: dict[str, Any] = {
        "absent_object_keys": list(sorted_keys),
        "cutoff_at": scope.cutoff_at.isoformat(),
        "inventory_sha256": scope.inventory_sha256,
        "request_id": str(scope.request_id),
        "user_id": str(scope.user_id),
    }
    if post_drain is not None:
        evidence_payload["upload_drain_evidence_sha256"] = post_drain

    evidence = hashlib.sha256(
        json.dumps(
            evidence_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with transaction.atomic(), connection.cursor() as cursor:
        row = AccountErasure.objects.select_for_update().get(pk=scope.request_id)
        if row.user_reference != scope.user_id or row.inventory_sha256 != scope.inventory_sha256:
            raise ValueError("account attachment erasure binding mismatch")
        cursor.execute(
            "SELECT public.privacy_confirm_account_attachments_erased(%s, %s)",
            [scope.request_id, evidence],
        )
    return True
