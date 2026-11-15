"""Explicit worker adapters for logical absence from the one RAM-only broker service."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from uuid import UUID

from django.db import transaction

from apps.orgs.account_erasure_services import AccountAbsenceProof, AccountErasureScope
from apps.orgs.erasure_services import AbsenceProof, ErasureScope, database_now
from apps.orgs.privacy_models import AccountErasure, PrivacyErasure

from .broker_rpc import BrokerGateway

DOMAIN = "proximity_ephemeral"
REVISION = "private-ram-broker-erasure-v1"
MAX_INVENTORY_IDS = 10000


def _identifiers(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list) or len(raw) > MAX_INVENTORY_IDS:
        raise ValueError("proximity immutable erasure inventory unavailable")
    result = []
    for value in raw:
        if not isinstance(value, str) or str(UUID(value)) != value or UUID(value).int == 0:
            raise ValueError("proximity immutable erasure identifier invalid")
        result.append(value)
    if len(set(result)) != len(result):
        raise ValueError("proximity immutable erasure identifiers duplicated")
    return tuple(sorted(result))


def _empty(result: dict) -> bool:
    return (
        set(result) == {"remaining_records", "remaining_replay_bindings"}
        and type(result["remaining_records"]) is int
        and result["remaining_records"] == 0
        and type(result["remaining_replay_bindings"]) is int
        and result["remaining_replay_bindings"] == 0
    )


def _live(broker: BrokerGateway) -> bool:
    result = broker.health()
    if set(result) != {"ready"} or result["ready"] is not True:
        raise ValueError("proximity broker health unavailable")
    return True


def _evidence(scope: ErasureScope | AccountErasureScope, identifiers: tuple[str, ...]) -> str:
    # Persist only this scope-bound aggregate evidence digest, never presence/peer text.
    value = [
        DOMAIN,
        REVISION,
        str(scope.request_id),
        scope.cutoff_at.isoformat(),
        scope.inventory_sha256,
        identifiers,
    ]
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


class ProximityWorkspaceErasureAdapter:
    """No default backend or missing-service-as-empty fallback. Covers exactly one shared socket.

    This proves logical absence from the live service, not forensic RAM zeroization,
    multi-container replicas or instantaneous revocation of an already issued offline epoch.
    """

    domain = DOMAIN
    revision = REVISION

    def __init__(self, broker: BrokerGateway) -> None:
        self.broker = broker

    def _authoritative(self, scope: ErasureScope) -> tuple[tuple[str, ...], datetime]:
        if not isinstance(scope, ErasureScope):
            raise ValueError("proximity workspace erasure scope required")
        row = PrivacyErasure.objects.select_for_update().get(pk=scope.request_id)
        now = database_now()
        if (
            row.organisation_reference != scope.organisation_id
            or row.cutoff_at != scope.cutoff_at
            or row.inventory != scope.inventory
            or row.inventory_sha256 != scope.inventory_sha256
            or row.inventory.get("proximity_inventory_version") != 1
            or self.domain not in row.inventory.get("required_domains", [])
            or row.status not in {"cutoff", "core_purged", "complete"}
            or not scope.cutoff_at <= row.purge_not_before <= now
        ):
            raise ValueError("proximity workspace erasure authority binding refused")
        return _identifiers(row.inventory.get("proximity_workspaces")), now

    @transaction.atomic
    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        identifiers, _ = self._authoritative(scope)
        _live(self.broker)
        for identifier in identifiers:
            self.broker.erase_workspace(workspace_id=UUID(identifier))
        if not all(
            _empty(self.broker.inspect_workspace(workspace_id=UUID(value))) for value in identifiers
        ):
            raise ValueError("proximity workspace absence incomplete")
        return AbsenceProof(
            scope.request_id,
            scope.organisation_id,
            scope.cutoff_at,
            self.domain,
            scope.inventory_sha256,
            _evidence(scope, identifiers),
            self.revision,
            database_now(),
        )

    @transaction.atomic
    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
        identifiers, now = self._authoritative(scope)
        return (
            isinstance(proof, AbsenceProof)
            and proof.request_id == scope.request_id
            and proof.organisation_id == scope.organisation_id
            and proof.cutoff_at == scope.cutoff_at
            and proof.domain == self.domain
            and proof.inventory_sha256 == scope.inventory_sha256
            and proof.adapter_revision == self.revision
            and proof.evidence_sha256 == _evidence(scope, identifiers)
            and proof.verified_at.tzinfo is not None
            and scope.cutoff_at <= proof.verified_at <= now
            and _live(self.broker)
            and all(
                _empty(self.broker.inspect_workspace(workspace_id=UUID(value)))
                for value in identifiers
            )
        )


class ProximityAccountErasureAdapter:
    """Person scope uses the cutoff's complete identity-ID inventory across all broker workspaces."""

    domain = DOMAIN
    revision = REVISION

    def __init__(self, broker: BrokerGateway) -> None:
        self.broker = broker

    def _authoritative(self, scope: AccountErasureScope) -> tuple[tuple[str, ...], datetime]:
        if not isinstance(scope, AccountErasureScope):
            raise ValueError("proximity account erasure scope required")
        row = AccountErasure.objects.select_for_update().get(pk=scope.request_id)
        now = database_now()
        if (
            row.user_reference != scope.user_id
            or row.cutoff_at != scope.cutoff_at
            or row.inventory != scope.inventory
            or row.inventory_sha256 != scope.inventory_sha256
            or row.inventory.get("proximity_inventory_version") != 1
            or self.domain not in row.inventory.get("required_domains", [])
            or row.status not in {"cutoff", "core_purged", "complete"}
            or not scope.cutoff_at <= row.purge_not_before <= now
        ):
            raise ValueError("proximity account erasure authority binding refused")
        return _identifiers(row.inventory.get("identities")), now

    @staticmethod
    def _batches(identifiers: tuple[str, ...]) -> tuple[list[str], ...]:
        return tuple(
            list(identifiers[offset : offset + 128]) for offset in range(0, len(identifiers), 128)
        )

    @transaction.atomic
    def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
        identifiers, _ = self._authoritative(scope)
        _live(self.broker)
        batches = self._batches(identifiers)
        for batch in batches:
            self.broker.erase_account(identity_ids=batch)
        if not all(_empty(self.broker.inspect_account(identity_ids=batch)) for batch in batches):
            raise ValueError("proximity account absence incomplete")
        return AccountAbsenceProof(
            scope.request_id,
            scope.user_id,
            scope.cutoff_at,
            self.domain,
            scope.inventory_sha256,
            _evidence(scope, identifiers),
            self.revision,
            database_now(),
        )

    @transaction.atomic
    def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
        identifiers, now = self._authoritative(scope)
        return (
            isinstance(proof, AccountAbsenceProof)
            and proof.request_id == scope.request_id
            and proof.user_id == scope.user_id
            and proof.cutoff_at == scope.cutoff_at
            and proof.domain == self.domain
            and proof.inventory_sha256 == scope.inventory_sha256
            and proof.adapter_revision == self.revision
            and proof.evidence_sha256 == _evidence(scope, identifiers)
            and proof.verified_at.tzinfo is not None
            and scope.cutoff_at <= proof.verified_at <= now
            and _live(self.broker)
            and all(
                _empty(self.broker.inspect_account(identity_ids=batch))
                for batch in self._batches(identifiers)
            )
        )
