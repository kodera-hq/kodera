"""Authoritative object-storage erasure adapters for organisation (`objects`) and account scopes.

Delegates physical S3 `DELETE` + `HEAD 404` verification to `apps.media.storage_gateway.delete_object`
(never holding object-storage credentials in Core), failing closed on any `StorageRefusedError` or
unverified object key.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction

from apps.media.storage import StorageRefusedError

from .account_erasure_services import AccountErasureScope
from .erasure_services import AbsenceProof, ErasureScope, database_now
from .privacy_models import AccountErasure, PrivacyErasure


class ObjectUploadWindowOpenError(Exception):
    """Raised when one or more presigned PUT upload windows have not yet expired."""


class ObjectReplicaAbsenceVerifier(Protocol):
    """Optional replica/backup absence verifier returning a 64-hex SHA-256 digest."""

    def verify_absent(self, scope: ErasureScope, object_keys: tuple[str, ...]) -> str: ...


ObjectDeleter = Callable[[str], dict[str, Any]]


def attachment_object_key(*, organisation_id: UUID | str, attachment_id: UUID | str) -> str:
    return f"organisations/{UUID(str(organisation_id))}/attachments/{UUID(str(attachment_id))}"


def invoke_gateway_delete(
    target_key: str,
    *,
    socket_path: str | None = None,
    deleter: ObjectDeleter | None = None,
) -> dict[str, Any]:
    """Invoke `storage_gateway.delete_object` (`DELETE` + `HEAD 404`), failing closed."""
    if deleter is not None:
        result = deleter(target_key)
    else:
        from apps.media import storage_gateway

        delete_fn = getattr(storage_gateway, "delete_object", None)
        if delete_fn is None:
            raise StorageRefusedError()
        resolved_socket = (
            socket_path
            if socket_path is not None
            else getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None)
        )
        result = delete_fn(target_key, socket_path=resolved_socket)
    if not isinstance(result, dict) or result.get("deleted") is not True:
        raise StorageRefusedError()
    return result


def _parse_upload_expiry(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError("attachment upload_expires_at malformed")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("attachment upload_expires_at must be timezone-aware")
    return parsed


@dataclass(frozen=True)
class ObjectWorkspaceErasureAdapter:
    """Concrete `objects` domain adapter for organisation-wide GDPR Art. 17 erasure."""

    socket_path: str | None = None
    deleter: ObjectDeleter | None = None
    replicas: ObjectReplicaAbsenceVerifier | None = None
    domain: str = "objects"
    revision: str = "storage-gateway-erasure-v1"

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

    def _evidence(self, scope: ErasureScope, object_keys: tuple[str, ...]) -> str:
        replica_digest: str | None = None
        if self.replicas is not None:
            replica_digest = self.replicas.verify_absent(scope, object_keys)
            if not isinstance(replica_digest, str) or not re.fullmatch(
                r"[0-9a-f]{64}", replica_digest
            ):
                raise ValueError("object replica absence evidence invalid")
        payload: dict[str, Any] = {
            "absent_object_keys": list(object_keys),
            "adapter_revision": self.revision,
            "cutoff_at": scope.cutoff_at.isoformat(),
            "domain": self.domain,
            "inventory_sha256": scope.inventory_sha256,
            "organisation_id": str(scope.organisation_id),
            "request_id": str(scope.request_id),
        }
        if replica_digest is not None:
            payload["replica_evidence_sha256"] = replica_digest
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @transaction.atomic
    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        object_keys, _, max_upload_expiry = self._authoritative(scope)
        for key in object_keys:
            invoke_gateway_delete(key, socket_path=self.socket_path, deleter=self.deleter)
        verified_at = database_now()
        if max_upload_expiry is not None and verified_at < max_upload_expiry:
            raise ObjectUploadWindowOpenError("presigned upload window still open")
        evidence = self._evidence(scope, object_keys)
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
                or (max_upload_expiry is not None and proof.verified_at < max_upload_expiry)
            ):
                return False
            for key in object_keys:
                invoke_gateway_delete(key, socket_path=self.socket_path, deleter=self.deleter)
            return proof.evidence_sha256 == self._evidence(scope, object_keys)
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
) -> bool:
    """Delete S3 objects (`DELETE` + `HEAD 404`) for Community personal attachments, holding final
    confirmation until every presigned upload window (`upload_expires_at`) has elapsed, then remove
    their `media_attachment` rows and record cryptographic verification in PostgreSQL.
    """
    raw_items = scope.inventory.get("account_personal_attachments", [])
    if not isinstance(raw_items, list):
        raise ValueError("account_personal_attachments inventory malformed")
    if not raw_items:
        return True

    keys: list[str] = []
    upload_expiries: list[datetime] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            raise ValueError("account_personal_attachments entry malformed")
        att_id = str(UUID(str(entry["id"])))
        org_id = str(UUID(str(entry["organisation_id"])))
        expiry = _parse_upload_expiry(entry.get("upload_expires_at"))
        if expiry is not None:
            upload_expiries.append(expiry)
        keys.append(attachment_object_key(organisation_id=org_id, attachment_id=att_id))

    for key in sorted(set(keys)):
        invoke_gateway_delete(key, socket_path=socket_path, deleter=deleter)

    now = database_now()
    if any(now < exp for exp in upload_expiries):
        return False

    evidence = hashlib.sha256(
        json.dumps(
            {
                "absent_object_keys": sorted(set(keys)),
                "cutoff_at": scope.cutoff_at.isoformat(),
                "inventory_sha256": scope.inventory_sha256,
                "request_id": str(scope.request_id),
                "user_id": str(scope.user_id),
            },
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
