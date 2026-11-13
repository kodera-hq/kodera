"""Customer-person erasure uses canonical membership/engine hooks, never workspace deletion."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from django.db import connection, transaction
from django.utils import timezone

from apps.identity.selectors import current_identity
from apps.outbox.realm_enqueue import ACCESS_OFF, enqueue_realm_access
from core.db.ids import new_uuid7
from services.identity.access_tokens import (
    RecentAuthenticationReason,
    VerifiedAccessToken,
    evaluate_recent_authentication,
)

from . import member_set_hooks
from .erasure_services import _json, database_now
from .models import Membership
from .privacy_models import AccountErasure, AccountErasureReceipt


def _recent(verified: VerifiedAccessToken) -> None:
    now = database_now()
    if evaluate_recent_authentication(
        verified=verified, database_now=now
    ) != RecentAuthenticationReason.RECENT or verified.expires_at <= int(now.timestamp()):
        raise ValueError("account erasure recent verified authentication required")


@transaction.atomic
def begin_account_erasure(
    *,
    verified: VerifiedAccessToken,
    confirmation: str,
    instruction_ref: str,
    instruction_sha256: str,
    purge_not_before: datetime,
    actor_identity_id: UUID,
) -> AccountErasure:
    """Operator/membership-lifecycle profile only; HTTP/processing roles cannot admit intent.

    `verified` must come from the real bearer verifier. No body person/identity ID is accepted.
    The separate current operator records the controller's validated instruction.
    """
    if confirmation != "delete" or purge_not_before.tzinfo is None:
        raise ValueError("explicit account deletion confirmation and aware deadline required")
    _recent(verified)
    current = current_identity(issuer=verified.issuer, subject=verified.subject)
    if current is None:
        raise ValueError("account erasure current person unavailable")
    person, identity = current
    request_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_begin_account_erasure(%s,%s,%s,%s,%s,%s)",
            [
                request_id,
                identity.id,
                instruction_ref,
                instruction_sha256,
                purge_not_before,
                actor_identity_id,
            ],
        )
    # Same transaction as cutoff: a set that fails closed rolls back every scope and the intent.
    for member in (
        Membership.objects.filter(user_id=person.id, deleted_at__isnull=True)
        .select_related("organisation")
        .order_by("organisation_id", "id")
    ):
        Membership.objects.filter(pk=member.id).update(state="removed", updated_at=timezone.now())
        member.state = "removed"
        if member.organisation.state != "closed":
            enqueue_realm_access(
                organisation_id=member.organisation_id,
                membership_id=member.id,
                user_id=person.id,
                operation=ACCESS_OFF,
            )
            member_set_hooks.member_erased(member)
    _recent(verified)
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_account_protocol_recorded(%s)", [request_id])
    return AccountErasure.objects.get(pk=request_id)


ACCOUNT_DOMAINS = frozenset(
    {
        "matrix_accounts",
        "identity_provider_accounts",
        "private_exports",
        "account_message_outbox",
        "account_extension_subjects",
    }
)


@dataclass(frozen=True)
class AccountErasureScope:
    request_id: UUID
    user_id: UUID
    cutoff_at: datetime
    inventory: dict[str, Any]

    @property
    def inventory_sha256(self) -> str:
        return hashlib.sha256(
            json.dumps(
                self.inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()


@dataclass(frozen=True)
class AccountAbsenceProof:
    request_id: UUID
    user_id: UUID
    cutoff_at: datetime
    domain: str
    inventory_sha256: str
    evidence_sha256: str
    adapter_revision: str
    verified_at: datetime


class AccountErasureAdapter(Protocol):
    """Trusted person-scoped absence implementation, including replicas and write fences.

    Workspace proofs cannot substitute for account proofs. In particular sealed mail lacks
    a Core person binding today: no default account_message_outbox adapter is configured.
    A real implementation must supply an authoritative complete person inventory and fence
    future sends, never infer ownership by matching an email address.
    """

    domain: str
    revision: str

    def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof: ...

    def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool: ...


@transaction.atomic
def persist_account_absence(
    scope: AccountErasureScope, proof: AccountAbsenceProof, adapter: AccountErasureAdapter
) -> None:
    if not isinstance(scope, AccountErasureScope) or not isinstance(proof, AccountAbsenceProof):
        raise ValueError("account erasure proof type refused")
    row = AccountErasure.objects.select_for_update().get(pk=scope.request_id)
    now = database_now()
    if (
        row.user_reference != scope.user_id
        or row.cutoff_at != scope.cutoff_at
        or row.inventory != scope.inventory
        or row.inventory_sha256 != scope.inventory_sha256
        or proof.domain not in ACCOUNT_DOMAINS
        or proof.domain not in row.inventory.get("required_domains", [])
        or proof.domain != adapter.domain
        or proof.adapter_revision != adapter.revision
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", proof.adapter_revision)
        or proof.request_id != scope.request_id
        or proof.user_id != scope.user_id
        or proof.cutoff_at != scope.cutoff_at
        or proof.inventory_sha256 != scope.inventory_sha256
        or not re.fullmatch(r"[0-9a-f]{64}", proof.evidence_sha256)
        or proof.verified_at.tzinfo is None
        or not max(scope.cutoff_at, row.purge_not_before) <= proof.verified_at <= now
        or not adapter.verify_proof(scope, proof)
    ):
        raise ValueError("account erasure proof refused")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_record_account_absence(%s,%s,%s,%s,%s,%s,%s,%s)",
            [
                scope.request_id,
                scope.user_id,
                scope.cutoff_at,
                scope.inventory_sha256,
                proof.domain,
                proof.evidence_sha256,
                proof.adapter_revision,
                proof.verified_at,
            ],
        )


def advance_account_erasure(
    request_id: UUID, adapters: dict[str, AccountErasureAdapter]
) -> dict[str, Any]:
    if set(adapters) - ACCOUNT_DOMAINS:
        raise ValueError("unknown account erasure adapter domain")
    row = AccountErasure.objects.get(pk=request_id)
    scope = AccountErasureScope(row.id, row.user_reference, row.cutoff_at, row.inventory)
    if row.inventory_sha256 != scope.inventory_sha256:
        raise ValueError("account erasure inventory digest mismatch")
    if database_now() < row.purge_not_before:
        raise ValueError("account erasure cutoff not due")
    required = frozenset(row.inventory["required_domains"])
    if not required or not required <= ACCOUNT_DOMAINS:
        raise ValueError("account erasure required domains invalid")
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_purge_account_core(%s)", [request_id])
        counts = _json(cursor.fetchone()[0])
    for domain in sorted(required):
        if (
            domain in adapters
            and not AccountErasureReceipt.objects.filter(erasure=row, domain=domain).exists()
        ):
            adapter = adapters[domain]
            persist_account_absence(scope, adapter.erase_and_verify(scope), adapter)
    held = sorted(
        required
        - set(AccountErasureReceipt.objects.filter(erasure=row).values_list("domain", flat=True))
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_complete_account_erasure(%s)", [request_id])
        complete = bool(cursor.fetchone()[0])
    return {
        "request_id": str(row.id),
        "scope": "account",
        "core_contacts_purged": True,
        "complete": complete,
        "counts": counts,
        "protocol_emitted": row.protocol_emitted_at is not None,
        "held_domains": held,
        "retained_policy": "ADR-0016 realm denylist and controller-owned workspace history; statutory records keep their individual legal deadlines",
        "completion_hold": "person-scoped remote, export and sealed-message absence requires explicitly configured adapters"
        if held
        else None,
    }


def purge_account_core(request_id: UUID) -> dict[str, Any]:
    """Resume concrete personal-data purge with all external account domains held."""
    return advance_account_erasure(request_id, {})
