"""Actual configured-volume absence receipts, after immutable export lifetimes expire."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from django.db import transaction

from .erasure_services import AbsenceProof, ErasureScope, database_now
from .privacy_archives import ArchiveRefusalError, require
from .privacy_models import PrivacyErasure
from .privacy_storage import MissingPrivateObjectError, PrivateVolume


class ReplicaAbsenceVerifier(Protocol):
    """Trusted bounded provider must freshly cover every snapshot/backup for these requests.

    Return a stable SHA-256 evidence digest bound to the exact scope and request inventory.
    Even an installation without replicas must supply an explicit qualified verifier.
    """

    def verify_absent(self, scope: ErasureScope, request_ids: tuple[str, ...]) -> str: ...


@dataclass(frozen=True)
class PrivateExportErasureAdapter:
    """Explicit POSIX volume only; snapshots/backups need independent provider evidence.

    A missing volume is an error, including for an empty authoritative export inventory.
    Cooperative archive writers must use PrivateVolume and the immutable Request expiry.
    No provider credentials or default volume are obtained here.
    """

    volume: PrivateVolume
    replicas: ReplicaAbsenceVerifier
    collection_limit: int = 1000
    domain = "private_exports"
    revision = "private-volume-erasure-v1"

    def _authoritative(self, scope: ErasureScope) -> tuple[tuple[str, ...], datetime]:
        row = PrivacyErasure.objects.select_for_update().get(pk=scope.request_id)
        now = database_now()
        require(
            row.organisation_reference == scope.organisation_id
            and row.cutoff_at == scope.cutoff_at
            and row.inventory == scope.inventory
            and row.inventory_sha256 == scope.inventory_sha256
            and row.status in {"cutoff", "core_purged", "complete"}
            and scope.cutoff_at <= row.purge_not_before <= now
            and self.domain in row.inventory.get("required_domains", []),
            "private export erasure authority binding",
            409,
        )
        identifiers = scope.inventory.get("private_exports")
        deadlines = scope.inventory.get("private_export_expiries")
        if not isinstance(identifiers, list) or not isinstance(deadlines, dict):
            raise ArchiveRefusalError("private export immutable deadline inventory", 409)
        require(
            len(identifiers) <= 10000
            and all(type(value) is str for value in identifiers)
            and set(deadlines) == set(identifiers)
            and len(set(identifiers)) == len(identifiers),
            "private export immutable deadline inventory",
            409,
        )
        for identifier in identifiers:
            try:
                valid = str(UUID(identifier)) == identifier
            except ValueError:
                valid = False
            require(valid, "private export inventory identifier", 409)
            deadline = deadlines[identifier]
            require(
                type(deadline) is int and deadline > 0,
                "private export original deadline",
                409,
            )
            require(
                now.timestamp() >= deadline and self.volume.clock() >= deadline,
                "private export original lifetime still live",
                409,
            )
        # Check the configured root afresh even when no request directory ever existed.
        descriptor = self.volume._root_fd()
        os.close(descriptor)
        require(
            type(self.collection_limit) is int and 1 <= self.collection_limit <= 1000,
            "private export collection bound",
        )
        return tuple(sorted(identifiers)), now

    def _empty(self, identifier: str) -> bool:
        try:
            page = self.volume.inventory_page(identifier, 1)
        except MissingPrivateObjectError:
            return True
        return page.complete and not page.keys

    def _evidence(self, scope: ErasureScope, identifiers: tuple[str, ...]) -> str:
        replica_evidence = self.replicas.verify_absent(scope, identifiers)
        require(
            isinstance(replica_evidence, str)
            and re.fullmatch(r"[0-9a-f]{64}", replica_evidence) is not None,
            "private export replica absence evidence",
            409,
        )
        return hashlib.sha256(
            json.dumps(
                {
                    "adapter_revision": self.revision,
                    "request_id": str(scope.request_id),
                    "organisation_id": str(scope.organisation_id),
                    "cutoff_at": scope.cutoff_at.isoformat(),
                    "inventory_sha256": scope.inventory_sha256,
                    "absent_private_exports": identifiers,
                    "replica_evidence_sha256": replica_evidence,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    @transaction.atomic
    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        identifiers, _ = self._authoritative(scope)
        evidence = self._evidence(scope, identifiers)
        remaining = self.collection_limit
        for identifier in identifiers:
            if self._empty(identifier):
                continue
            require(remaining > 0, "private export collection incomplete", 409)
            try:
                progress = self.volume.collect_expired_page(identifier, remaining)
            except MissingPrivateObjectError:
                continue
            remaining -= progress.inspected
            require(self._empty(identifier), "private export collection incomplete", 409)
        # Every request's original immutable deadline has passed. The shared request lock
        # waits for any earlier writer, and queued writers recheck that deadline under it.
        require(
            all(self._empty(value) for value in identifiers), "private export absence lost", 409
        )
        return AbsenceProof(
            scope.request_id,
            scope.organisation_id,
            scope.cutoff_at,
            self.domain,
            scope.inventory_sha256,
            evidence,
            self.revision,
            database_now(),
        )

    @transaction.atomic
    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
        try:
            identifiers, now = self._authoritative(scope)
            return (
                proof.request_id == scope.request_id
                and proof.organisation_id == scope.organisation_id
                and proof.cutoff_at == scope.cutoff_at
                and proof.domain == self.domain
                and proof.inventory_sha256 == scope.inventory_sha256
                and proof.adapter_revision == self.revision
                and proof.evidence_sha256 == self._evidence(scope, identifiers)
                and proof.verified_at.tzinfo is not None
                and scope.cutoff_at <= proof.verified_at <= now
                and all(self._empty(value) for value in identifiers)
            )
        except (ArchiveRefusalError, PrivacyErasure.DoesNotExist):
            return False
