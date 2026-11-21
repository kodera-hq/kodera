"""Person-scoped sealed-outbox absence adapter for `account_message_outbox`.

Verifies and enforces that every personal outbox message bound to the erased customer
person (`identity_passportoutboxbinding`, `orgs_invitationoutboxbinding`, support ticket
deliveries, and workspace digest deliveries) has no in-flight sender, no remaining
`pending` delivery, and `outbox_message.sealed IS NULL`, and refuses to certify the
domain if any unbound personal-template delivery exists.
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


def _str_set(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item) for item in value if isinstance(item, str) and item}


@dataclass
class PassportAccountOutboxErasureAdapter:
    """Authoritative `account_message_outbox` adapter covering Passport, invitations, and personal mail."""

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

    def _email_sha256s(self, cursor: Any, scope: AccountErasureScope) -> list[str]:
        digests = _str_set(scope.inventory.get("person_email_sha256s")) | _str_set(
            scope.inventory.get("passport_email_sha256s")
        )
        cursor.execute(
            "SELECT DISTINCT encode(sha256(convert_to(em, 'UTF8')), 'hex') FROM ("
            "  SELECT lower(btrim(email)) AS em FROM identity_user WHERE id = %s "
            "  UNION "
            "  SELECT lower(btrim(email)) AS em FROM identity_identity WHERE user_id = %s"
            ") raw WHERE em IS NOT NULL AND em <> '' AND em NOT LIKE 'erased:%%'",
            [scope.user_id, scope.user_id],
        )
        digests.update(str(row[0]) for row in cursor.fetchall())
        return sorted(digests)

    def _assert_no_unbound_personal_mail(self, cursor: Any) -> None:
        cursor.execute("SELECT to_regclass('public.orgs_invitationoutboxbinding') IS NOT NULL")
        has_inv_binding = bool(cursor.fetchone()[0])
        if not has_inv_binding:
            cursor.execute(
                "SELECT 1 FROM outbox_outboxdelivery d "
                "JOIN outbox_message m ON m.delivery_id = d.id "
                "WHERE m.template_id IN ('invitation', 'invitation_account_ready') "
                "  AND (d.status IN ('pending', 'in_flight') OR m.sealed IS NOT NULL) "
                "LIMIT 1"
            )
            if cursor.fetchone() is not None:
                raise ValueError("invitation outbox binding schema absent for active mail")
            return
        cursor.execute(
            "SELECT 1 FROM outbox_outboxdelivery d "
            "JOIN outbox_message m ON m.delivery_id = d.id "
            "WHERE ("
            "  (m.template_id = 'passport_magic_link' "
            "   AND NOT EXISTS (SELECT 1 FROM identity_passportoutboxbinding b WHERE b.delivery_id = d.id)) "
            "  OR (m.template_id IN ('invitation', 'invitation_account_ready') "
            "   AND NOT EXISTS (SELECT 1 FROM orgs_invitationoutboxbinding ib WHERE ib.delivery_id = d.id))"
            ") AND (d.status IN ('pending', 'in_flight') OR m.sealed IS NOT NULL) "
            "LIMIT 1"
        )
        if cursor.fetchone() is not None:
            raise ValueError("unbound personal outbox message prevents absence certification")

    def _bound_delivery_ids(
        self,
        cursor: Any,
        scope: AccountErasureScope,
    ) -> tuple[str, ...]:
        found = _str_set(scope.inventory.get("passport_delivery_ids")) | _str_set(
            scope.inventory.get("invitation_delivery_ids")
        )
        cursor.execute(
            "SELECT delivery_id::text FROM identity_passportoutboxbinding "
            "WHERE user_id = %s ORDER BY delivery_id",
            [scope.user_id],
        )
        found.update(str(row[0]) for row in cursor.fetchall())

        email_shas = self._email_sha256s(cursor, scope)
        cursor.execute("SELECT to_regclass('public.orgs_invitationoutboxbinding') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute(
                "SELECT ib.delivery_id::text FROM orgs_invitationoutboxbinding ib "
                "LEFT JOIN orgs_invitation inv ON inv.id = ib.invitation_id "
                "LEFT JOIN orgs_membership m ON m.id = inv.membership_id "
                "WHERE m.user_id = %s "
                "   OR ib.recipient_email_sha256 = ANY(%s) "
                "   OR ib.invitation_id::text = ANY(%s)",
                [
                    scope.user_id,
                    email_shas,
                    sorted(_str_set(scope.inventory.get("non_accepted_invitation_ids"))),
                ],
            )
            found.update(str(row[0]) for row in cursor.fetchall())

        cursor.execute("SELECT to_regclass('public.support_supportticket') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute(
                "SELECT t.mail_delivery_id::text FROM support_supportticket t "
                "JOIN identity_identity i ON i.id = t.created_by_id "
                "WHERE i.user_id = %s AND t.mail_delivery_id IS NOT NULL",
                [scope.user_id],
            )
            found.update(str(row[0]) for row in cursor.fetchall())

        cursor.execute("SELECT to_regclass('public.extensions_digestjob') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute(
                "SELECT j.delivery_id::text FROM extensions_digestjob j "
                "JOIN extensions_digestconsent c ON c.id = j.consent_id "
                "JOIN orgs_membership m ON m.id = c.membership_id "
                "WHERE m.user_id = %s AND j.delivery_id IS NOT NULL",
                [scope.user_id],
            )
            found.update(str(row[0]) for row in cursor.fetchall())

        return tuple(sorted(found))

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

            self._assert_no_unbound_personal_mail(cursor)
            delivery_ids = self._bound_delivery_ids(cursor, scope)
            id_list = list(delivery_ids)

            if id_list:
                cursor.execute(
                    "SELECT 1 FROM outbox_outboxdelivery d "
                    "WHERE d.id::text = ANY(%s) AND d.status = 'in_flight' LIMIT 1",
                    [id_list],
                )
                if cursor.fetchone() is not None:
                    raise ValueError("personal outbox delivery still in flight")

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
                        "personal outbox sealed payload or active delivery still present"
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
            try:
                self._assert_no_unbound_personal_mail(cursor)
            except ValueError:
                return False
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


AccountMessageOutboxErasureAdapter = PassportAccountOutboxErasureAdapter
