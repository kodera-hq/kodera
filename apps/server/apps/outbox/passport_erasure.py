"""Person-scoped sealed-outbox absence adapter for `account_message_outbox`.

Verifies and enforces that every `passport_magic_link` outbox message bound to the
erased customer person (`identity_passportoutboxbinding`) has no in-flight sender,
no remaining `pending` delivery, and `outbox_message.sealed IS NULL`, while leaving
unrelated persons' and sibling tenants' pending mail untouched.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from django.db import connection, transaction

from apps.orgs.account_erasure_services import AccountAbsenceProof, AccountErasureScope
from apps.orgs.erasure_services import database_now


def _json_obj(value: object) -> dict[str, object]:
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return value if isinstance(value, dict) else {}


@dataclass
class PassportAccountOutboxErasureAdapter:
    """Authoritative `account_message_outbox` adapter backed by `identity_passportoutboxbinding`."""

    domain: str = "account_message_outbox"
    revision: str = "passport-outbox-v1"

    def _compute_evidence(
        self,
        scope: AccountErasureScope,
        delivery_ids: tuple[str, ...],
    ) -> str:
        payload = {
            "adapter_revision": self.revision,
            "cutoff_at": scope.cutoff_at.isoformat(),
            "delivery_ids": list(delivery_ids),
            "domain": self.domain,
            "inventory_sha256": scope.inventory_sha256,
            "request_id": str(scope.request_id),
            "user_id": str(scope.user_id),
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _bound_delivery_ids(
        self,
        cursor: Any,
        scope: AccountErasureScope,
    ) -> tuple[str, ...]:
        cursor.execute(
            "SELECT delivery_id::text FROM identity_passportoutboxbinding "
            "WHERE user_id = %s ORDER BY delivery_id",
            [scope.user_id],
        )
        live_ids = {str(row[0]) for row in cursor.fetchall()}
        raw_inv = scope.inventory.get("passport_delivery_ids", [])
        inv_ids = (
            {str(item) for item in raw_inv if isinstance(item, str) and item}
            if isinstance(raw_inv, list)
            else set()
        )
        return tuple(sorted(live_ids | inv_ids))

    def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
        if self.domain not in scope.inventory.get("required_domains", []):
            raise ValueError("account_message_outbox domain not required in scope")

        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT user_reference, cutoff_at, purge_not_before, status, "
                "inventory, inventory_sha256 "
                "FROM orgs_accounterasure WHERE id = %s FOR UPDATE",
                [scope.request_id],
            )
            row = cursor.fetchone()
            now = database_now()
            if row is None:
                raise ValueError("account erasure journal absent")
            (
                user_ref,
                cutoff_at,
                purge_not_before,
                status,
                raw_inventory,
                inventory_sha256,
            ) = row
            stored_inventory = _json_obj(raw_inventory)
            if (
                user_ref != scope.user_id
                or cutoff_at != scope.cutoff_at
                or stored_inventory != scope.inventory
                or inventory_sha256 != scope.inventory_sha256
                or status not in {"cutoff", "core_purged", "complete"}
                or purge_not_before > now
            ):
                raise ValueError("account erasure outbox authority binding mismatch")

            cursor.execute(
                "SELECT pg_advisory_xact_lock_shared("
                "hashtextextended('privacy_account_cutoff:' || %s, 0))",
                [str(scope.user_id)],
            )

            delivery_ids = self._bound_delivery_ids(cursor, scope)
            id_list = list(delivery_ids)

            if id_list:
                cursor.execute(
                    "SELECT 1 FROM outbox_outboxdelivery d "
                    "WHERE d.id::text = ANY(%s) AND d.status = 'in_flight' LIMIT 1",
                    [id_list],
                )
                if cursor.fetchone() is not None:
                    raise ValueError("passport outbox delivery still in flight")

                cursor.execute(
                    "UPDATE outbox_message m SET sealed = NULL "
                    "FROM outbox_outboxdelivery d "
                    "WHERE d.id::text = ANY(%s) AND m.delivery_id = d.id "
                    "AND m.sealed IS NOT NULL "
                    "AND NOT EXISTS ("
                    "  SELECT 1 FROM orgs_privacyerasure pe "
                    "  WHERE pe.organisation_reference = d.organisation_id"
                    ")",
                    [id_list],
                )
                cursor.execute(
                    "UPDATE outbox_outboxdelivery d "
                    "SET status = 'failed', "
                    "    finished_at = COALESCE(d.finished_at, clock_timestamp()), "
                    "    updated_at = clock_timestamp() "
                    "WHERE d.id::text = ANY(%s) AND d.status = 'pending' "
                    "AND NOT EXISTS ("
                    "  SELECT 1 FROM orgs_privacyerasure pe "
                    "  WHERE pe.organisation_reference = d.organisation_id"
                    ")",
                    [id_list],
                )

                cursor.execute(
                    "SELECT 1 FROM outbox_outboxdelivery d "
                    "LEFT JOIN outbox_message m ON m.delivery_id = d.id "
                    "WHERE d.id::text = ANY(%s) "
                    "AND ("
                    "  d.status = 'in_flight' "
                    "  OR m.sealed IS NOT NULL "
                    "  OR ("
                    "    d.status = 'pending' "
                    "    AND NOT EXISTS ("
                    "      SELECT 1 FROM orgs_privacyerasure pe "
                    "      WHERE pe.organisation_reference = d.organisation_id"
                    "    )"
                    "  )"
                    ") "
                    "LIMIT 1",
                    [id_list],
                )
                if cursor.fetchone() is not None:
                    raise ValueError(
                        "passport outbox sealed payload or active delivery still present"
                    )

            verified_at = database_now()
            evidence = self._compute_evidence(scope, delivery_ids)

        return AccountAbsenceProof(
            request_id=scope.request_id,
            user_id=scope.user_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=evidence,
            adapter_revision=self.revision,
            verified_at=verified_at,
        )

    def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
        if (
            proof.domain != self.domain
            or proof.adapter_revision != self.revision
            or proof.request_id != scope.request_id
            or proof.user_id != scope.user_id
            or proof.cutoff_at != scope.cutoff_at
            or proof.inventory_sha256 != scope.inventory_sha256
        ):
            return False
        with connection.cursor() as cursor:
            delivery_ids = self._bound_delivery_ids(cursor, scope)
            if delivery_ids:
                cursor.execute(
                    "SELECT 1 FROM outbox_outboxdelivery d "
                    "LEFT JOIN outbox_message m ON m.delivery_id = d.id "
                    "WHERE d.id::text = ANY(%s) "
                    "AND ("
                    "  d.status = 'in_flight' "
                    "  OR m.sealed IS NOT NULL "
                    "  OR ("
                    "    d.status = 'pending' "
                    "    AND NOT EXISTS ("
                    "      SELECT 1 FROM orgs_privacyerasure pe "
                    "      WHERE pe.organisation_reference = d.organisation_id"
                    "    )"
                    "  )"
                    ") "
                    "LIMIT 1",
                    [list(delivery_ids)],
                )
                if cursor.fetchone() is not None:
                    return False
        expected = self._compute_evidence(scope, delivery_ids)
        return proof.evidence_sha256 == expected
