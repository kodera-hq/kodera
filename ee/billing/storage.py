# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Durable PostgreSQL and deterministic in-memory stores for Enterprise billing.

When running against PostgreSQL (`backend="auto"` or `backend="postgres"`), all warm-pool
slots, idempotent claims, and purchase orders are persisted in dedicated `ee_billing_*`
tables using `transaction.atomic()` and row/advisory locks (`SELECT ... FOR UPDATE`,
`pg_advisory_xact_lock`) so state is shared safely across multiple Gunicorn workers.
Pure unit tests without a database may explicitly request `backend="memory"`.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast
from uuid import UUID

if TYPE_CHECKING:
    from .purchase_orders import PurchaseOrder, PurchaseOrderState
    from .warm_pool import PoolWatermarks, SlotState, WarmPoolSlot

StorageBackend = Literal["auto", "postgres", "memory"]

_WARM_POOL_LOCK_KEY = "ee_billing_warm_pool_v1"
_PO_SEQUENCE_NAME = "purchase_order_seq"
_WARM_POOL_SEQUENCE_NAME = "warm_pool_slot_seq"
_STAFF_REALM = "kodera-staff"
_LOCK_CONFLICT_SQLSTATES = frozenset({"55P03", "40P01", "40001", "23514"})


class BillingAuthorityForbiddenError(Exception):
    """Raised when live in-transaction caller reauthorization fails (`403 forbidden`)."""

    code: str = "authority_forbidden"


class BillingAuthorityConflictError(Exception):
    """Raised when a concurrent authority or privacy lock/cutoff conflicts (`409 conflict`)."""

    code: str = "authority_conflict"


@dataclass(frozen=True, slots=True)
class CallerAuthority:
    """Caller identity and role requirements re-verified inside the store's DB transaction."""

    lane: Literal["staff", "internal", "customer"]
    identity_id: str
    user_id: str | None = None
    issuer: str | None = None
    subject: str | None = None
    allowed_org_roles: frozenset[str] = frozenset()
    static_org_roles: Mapping[str, str] = field(default_factory=dict)
    org_identities: Mapping[str, str] = field(default_factory=dict)
    allowed_staff_roles: frozenset[str] = frozenset()
    static_staff_roles: frozenset[str] = frozenset()
    live_authority: bool = False


def _try_uuid(value: str | None) -> UUID | None:
    if not isinstance(value, str) or len(value) != 36:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _pg_sqlstate(err: BaseException) -> str | None:
    direct = getattr(err, "sqlstate", None)
    if isinstance(direct, str) and direct:
        return direct
    cause = getattr(err, "__cause__", None)
    if cause is not None:
        nested = getattr(cause, "sqlstate", None)
        if isinstance(nested, str) and nested:
            return nested
    context = getattr(err, "__context__", None)
    if context is not None:
        ctx_code = getattr(context, "sqlstate", None)
        if isinstance(ctx_code, str) and ctx_code:
            return ctx_code
    return None


def _check_static_caller_authority(
    authority: CallerAuthority | None,
    *,
    target_organisation_id: str | None = None,
) -> None:
    if authority is None:
        return
    if authority.lane == "internal":
        return
    if authority.lane == "staff":
        if not authority.allowed_staff_roles or not (
            authority.static_staff_roles & authority.allowed_staff_roles
        ):
            raise BillingAuthorityForbiddenError("insufficient staff role")
        return
    if authority.lane != "customer":
        raise BillingAuthorityForbiddenError("unsupported authority lane")
    if not target_organisation_id:
        raise BillingAuthorityForbiddenError("missing target organisation")
    role = authority.static_org_roles.get(target_organisation_id)
    if role is None or role not in authority.allowed_org_roles:
        raise BillingAuthorityForbiddenError("insufficient organisation role")


def _acquire_ee_caller_fence(
    cursor: Any,
    authority: CallerAuthority | None,
    *,
    target_organisation_id: str | None = None,
) -> None:
    """Re-verify live caller authority and acquire shared privacy/row fences (`FOR SHARE NOWAIT`)."""
    if authority is None:
        return
    if not authority.live_authority:
        _check_static_caller_authority(authority, target_organisation_id=target_organisation_id)
        return

    if authority.lane == "internal":
        target_org_uuid = _try_uuid(target_organisation_id)
        if target_org_uuid is not None:
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock_shared("
                "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                [str(target_org_uuid)],
            )
            lock_row = cursor.fetchone()
            if not lock_row or not bool(lock_row[0]):
                raise BillingAuthorityConflictError("organisation privacy cutoff in progress")
            cursor.execute(
                """
                SELECT state, deleted_at
                FROM orgs_organisation
                WHERE id = %s
                FOR SHARE NOWAIT
                """,
                [target_org_uuid],
            )
            org_row = cursor.fetchone()
            if org_row is not None and (str(org_row[0]) != "active" or org_row[1] is not None):
                raise BillingAuthorityConflictError("organisation inactive or erased")
        return

    if authority.lane == "staff":
        identity_uuid = _try_uuid(authority.identity_id)
        if identity_uuid is None:
            raise BillingAuthorityForbiddenError("invalid staff identity")
        user_uuid = _try_uuid(authority.user_id)
        if user_uuid is None:
            cursor.execute(
                "SELECT user_id FROM identity_identity WHERE id = %s",
                [identity_uuid],
            )
            uid_row = cursor.fetchone()
            if uid_row is None or uid_row[0] is None:
                raise BillingAuthorityForbiddenError("staff identity absent")
            user_uuid = _try_uuid(str(uid_row[0]))
            if user_uuid is None:
                raise BillingAuthorityForbiddenError("staff user invalid")

        target_org_uuid = _try_uuid(target_organisation_id)
        cursor.execute(
            "SELECT pg_try_advisory_xact_lock_shared("
            "hashtextextended('privacy_account_cutoff:' || %s, 0))",
            [str(user_uuid)],
        )
        u_lock = cursor.fetchone()
        if not u_lock or not bool(u_lock[0]):
            raise BillingAuthorityConflictError("staff account cutoff in progress")

        if target_org_uuid is not None:
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock_shared("
                "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                [str(target_org_uuid)],
            )
            o_lock = cursor.fetchone()
            if not o_lock or not bool(o_lock[0]):
                raise BillingAuthorityConflictError("organisation privacy cutoff in progress")

        cursor.execute(
            """
            SELECT enabled, deleted_at
            FROM identity_user
            WHERE id = %s
            FOR SHARE NOWAIT
            """,
            [user_uuid],
        )
        u_row = cursor.fetchone()
        if u_row is None or not bool(u_row[0]) or u_row[1] is not None:
            raise BillingAuthorityForbiddenError("staff user disabled")

        if target_org_uuid is not None:
            cursor.execute(
                """
                SELECT state, deleted_at
                FROM orgs_organisation
                WHERE id = %s
                FOR SHARE NOWAIT
                """,
                [target_org_uuid],
            )
            o_row = cursor.fetchone()
            if o_row is not None and (str(o_row[0]) != "active" or o_row[1] is not None):
                raise BillingAuthorityConflictError("target organisation closed or erased")

        cursor.execute(
            """
            SELECT user_id, organisation_id, realm, issuer, subject, enabled, deleted_at
            FROM identity_identity
            WHERE id = %s
            FOR SHARE NOWAIT
            """,
            [identity_uuid],
        )
        i_row = cursor.fetchone()
        if (
            i_row is None
            or str(i_row[0]) != str(user_uuid)
            or i_row[1] is not None
            or str(i_row[2]) != _STAFF_REALM
            or not bool(i_row[5])
            or i_row[6] is not None
            or (authority.issuer is not None and str(i_row[3]) != authority.issuer)
            or (authority.subject is not None and str(i_row[4]) != authority.subject)
        ):
            raise BillingAuthorityForbiddenError("staff identity revoked or mismatched")

        if not authority.allowed_staff_roles:
            raise BillingAuthorityForbiddenError("staff operation allows no staff role")

        cursor.execute(
            """
            SELECT role
            FROM identity_staffrole
            WHERE identity_id = %s
              AND revoked_at IS NULL
              AND role = ANY(%s)
            ORDER BY id ASC
            LIMIT 1
            FOR SHARE NOWAIT
            """,
            [identity_uuid, sorted(authority.allowed_staff_roles)],
        )
        if cursor.fetchone() is None:
            raise BillingAuthorityForbiddenError("required staff role absent or revoked")
        return

    if authority.lane == "customer":
        user_uuid = _try_uuid(authority.user_id)
        target_org_uuid = _try_uuid(target_organisation_id)
        effective_identity_raw = (
            authority.org_identities.get(str(target_org_uuid), authority.identity_id)
            if target_org_uuid is not None
            else authority.identity_id
        )
        identity_uuid = _try_uuid(effective_identity_raw)
        if user_uuid is None or identity_uuid is None or target_org_uuid is None:
            raise BillingAuthorityForbiddenError("customer authority scope invalid")

        cursor.execute(
            "SELECT pg_try_advisory_xact_lock_shared("
            "hashtextextended('privacy_account_cutoff:' || %s, 0))",
            [str(user_uuid)],
        )
        u_lock = cursor.fetchone()
        if not u_lock or not bool(u_lock[0]):
            raise BillingAuthorityConflictError("customer account cutoff in progress")

        cursor.execute(
            "SELECT pg_try_advisory_xact_lock_shared("
            "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
            [str(target_org_uuid)],
        )
        o_lock = cursor.fetchone()
        if not o_lock or not bool(o_lock[0]):
            raise BillingAuthorityConflictError("organisation privacy cutoff in progress")

        cursor.execute(
            """
            SELECT enabled, deleted_at
            FROM identity_user
            WHERE id = %s
            FOR SHARE NOWAIT
            """,
            [user_uuid],
        )
        u_row = cursor.fetchone()
        if u_row is None or not bool(u_row[0]) or u_row[1] is not None:
            raise BillingAuthorityForbiddenError("customer user disabled")

        cursor.execute(
            """
            SELECT realm, issuer, state, deleted_at
            FROM orgs_organisation
            WHERE id = %s
            FOR SHARE NOWAIT
            """,
            [target_org_uuid],
        )
        o_row = cursor.fetchone()
        if (
            o_row is None
            or str(o_row[2]) != "active"
            or o_row[3] is not None
            or str(o_row[0]) == _STAFF_REALM
        ):
            raise BillingAuthorityForbiddenError("target organisation unavailable")
        org_realm = str(o_row[0])
        org_issuer = str(o_row[1])

        cursor.execute(
            """
            SELECT role, state, accepted_at, deleted_at
            FROM orgs_membership
            WHERE organisation_id = %s AND user_id = %s
            ORDER BY id ASC
            FOR SHARE NOWAIT
            """,
            [target_org_uuid, user_uuid],
        )
        m_rows = cursor.fetchall()
        has_allowed_role = any(
            str(m_state) == "active"
            and m_accepted is not None
            and m_deleted is None
            and str(m_role) in authority.allowed_org_roles
            for m_role, m_state, m_accepted, m_deleted in m_rows
        )
        if not has_allowed_role:
            raise BillingAuthorityForbiddenError("customer membership role revoked")

        cursor.execute(
            """
            SELECT organisation_id, user_id, realm, issuer, subject, enabled, deleted_at
            FROM identity_identity
            WHERE id = %s
            FOR SHARE NOWAIT
            """,
            [identity_uuid],
        )
        i_row = cursor.fetchone()
        if (
            i_row is None
            or i_row[0] is None
            or str(i_row[0]) != str(target_org_uuid)
            or str(i_row[1]) != str(user_uuid)
            or str(i_row[2]) != org_realm
            or str(i_row[3]) != org_issuer
            or not bool(i_row[5])
            or i_row[6] is not None
            or (authority.subject is not None and str(i_row[4]) != authority.subject)
        ):
            raise BillingAuthorityForbiddenError("customer identity disabled or mismatched")
        return

    raise BillingAuthorityForbiddenError("unsupported authority lane")


def verify_caller_authority(
    authority: CallerAuthority | None,
    *,
    target_organisation_id: str | None = None,
) -> None:
    """Verify caller authority inside a fenced PostgreSQL transaction for stateless EE routes."""
    if authority is None:
        return
    if not authority.live_authority or not _postgres_configured():
        _check_static_caller_authority(authority, target_organisation_id=target_organisation_id)
        return

    from django.db import DatabaseError, connection, transaction

    try:
        with transaction.atomic(), connection.cursor() as cursor:
            _acquire_ee_caller_fence(
                cursor, authority, target_organisation_id=target_organisation_id
            )
    except DatabaseError as exc:
        if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
            raise BillingAuthorityConflictError(
                "concurrent authority or privacy cutoff conflict"
            ) from exc
        raise


def _postgres_configured() -> bool:
    try:
        from django.apps import apps
        from django.conf import settings
        from django.db import connection
    except ImportError:
        return False
    if not settings.configured or not apps.ready:
        return False
    return str(getattr(connection, "vendor", "")) == "postgresql"


def _next_sequence(cursor: Any, name: str) -> int:
    cursor.execute(
        """
        INSERT INTO ee_billing_sequences (name, last_value)
        VALUES (%s, 1)
        ON CONFLICT (name)
        DO UPDATE SET last_value = ee_billing_sequences.last_value + 1
        RETURNING last_value
        """,
        [name],
    )
    row = cursor.fetchone()
    if row is None:
        raise RuntimeError("sequence increment returned no row")
    return int(row[0])


def _new_opaque_po_id() -> str:
    """Mint an opaque RFC 9562 UUIDv7-prefixed identifier (`po_<uuid7>`)."""
    unix_ms = int(time.time_ns() // 1_000_000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    rand_a = (rand >> 62) & 0x0FFF
    rand_b = rand & ((1 << 62) - 1)
    value = (unix_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0x2 << 62) | rand_b
    return f"po_{UUID(int=value)}"


def _encode_scoped_idempotency_key(organisation_id: str, idempotency_key: str) -> str:
    org_hash = hashlib.sha256(organisation_id.encode("utf-8")).hexdigest()[:24]
    prefix = f"org1:{org_hash}:"
    if len(prefix) + len(idempotency_key) <= 255:
        return f"{prefix}{idempotency_key}"
    key_hash = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    return f"org1h:{org_hash}:{key_hash}"


def _decode_scoped_idempotency_key(
    stored_key: str | None, organisation_id: str | None
) -> str | None:
    if stored_key is None:
        return None
    if organisation_id is not None:
        org_hash = hashlib.sha256(organisation_id.encode("utf-8")).hexdigest()[:24]
        prefix = f"org1:{org_hash}:"
        if stored_key.startswith(prefix):
            return stored_key[len(prefix) :]
    return stored_key


def _authorized_customer_org_ids(authority: CallerAuthority) -> tuple[str, ...]:
    return tuple(
        org_id
        for org_id, role in authority.static_org_roles.items()
        if org_id and role in authority.allowed_org_roles
    )


def _has_postgres_paid_enterprise_entitlement(
    cursor: Any, *, organisation_id: str, checkout_id: str
) -> bool:
    """Verify a settled (`state = 'paid'`) Enterprise PO or paid Sovereign Core entitlement."""
    cursor.execute(
        """
        SELECT 1
        FROM ee_billing_purchase_orders
        WHERE organisation_id = %s
          AND state = 'paid'
          AND plan_code = 'sovereign'
          AND (
              po_id = %s
              OR po_number = %s
              OR customer_po_reference = %s
              OR invoice_ref = %s
              OR payment_ref = %s
          )
        LIMIT 1
        FOR SHARE
        """,
        [organisation_id, checkout_id, checkout_id, checkout_id, checkout_id, checkout_id],
    )
    if cursor.fetchone() is not None:
        return True

    org_uuid = _try_uuid(organisation_id)
    if org_uuid is None:
        return False

    bare_inv = checkout_id[4:] if checkout_id.startswith("INV-") else checkout_id
    cursor.execute(
        """
        SELECT 1
        FROM billing_invoice i
        WHERE i.organisation_id = %s
          AND i.state = 'paid'
          AND i.total_incl_vat_minor > 0
          AND i.amount_paid_minor >= i.total_incl_vat_minor
          AND (
              (
                  i.order_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM billing_order o
                      WHERE o.id = i.order_id
                        AND o.organisation_id = %s
                        AND o.state = 'paid'
                        AND o.plan_code = 'sovereign'
                  )
              )
              OR (
                  i.subscription_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM billing_subscription s
                      WHERE s.id = i.subscription_id
                        AND s.organisation_id = %s
                        AND s.state = 'active'
                        AND s.plan_code = 'sovereign'
                  )
              )
              OR EXISTS (
                  SELECT 1
                  FROM ee_billing_purchase_orders po
                  WHERE po.organisation_id = %s
                    AND po.state = 'paid'
                    AND po.plan_code = 'sovereign'
                    AND i.number IS NOT NULL
                    AND po.invoice_ref IN (i.number, 'INV-' || i.number)
              )
          )
          AND (
              i.number IN (%s, %s)
              OR i.external_ref = %s
              OR i.id::text = %s
              OR EXISTS (
                  SELECT 1
                  FROM billing_payment p
                  WHERE p.invoice_id = i.id
                    AND p.organisation_id = %s
                    AND p.state = 'succeeded'
                    AND p.allocated = true
                    AND (p.provider_ref = %s OR p.id::text = %s)
              )
              OR EXISTS (
                  SELECT 1
                  FROM billing_paymentlink pl
                  WHERE pl.invoice_id = i.id
                    AND pl.organisation_id = %s
                    AND pl.state = 'used'
                    AND pl.provider_ref = %s
              )
          )
        LIMIT 1
        """,
        [
            org_uuid,
            org_uuid,
            org_uuid,
            organisation_id,
            checkout_id,
            bare_inv,
            checkout_id,
            checkout_id,
            org_uuid,
            checkout_id,
            checkout_id,
            org_uuid,
            checkout_id,
        ],
    )
    if cursor.fetchone() is not None:
        return True

    cursor.execute(
        """
        SELECT 1
        FROM billing_order o
        WHERE o.organisation_id = %s
          AND o.state = 'paid'
          AND o.plan_code = 'sovereign'
          AND (o.id::text = %s OR o.purchase_order_ref = %s)
        LIMIT 1
        """,
        [org_uuid, checkout_id, checkout_id],
    )
    if cursor.fetchone() is not None:
        return True

    cursor.execute(
        """
        SELECT 1
        FROM billing_subscription s
        WHERE s.organisation_id = %s
          AND s.state = 'active'
          AND s.plan_code = 'sovereign'
          AND s.id::text = %s
        LIMIT 1
        """,
        [org_uuid, checkout_id],
    )
    return cursor.fetchone() is not None


class WarmPoolStore(Protocol):
    def counts_for_target(
        self,
        *,
        region: str,
        profile_ref: str,
        authority: CallerAuthority | None = None,
    ) -> dict[SlotState, int]: ...

    def replenish(
        self,
        *,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]: ...

    def transition_slot(
        self,
        slot_id: str,
        *,
        target_state: SlotState,
        allowed_from: frozenset[SlotState],
        unhealthy_reason: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot: ...

    def evict_unhealthy(
        self,
        *,
        region: str | None,
        profile_ref: str | None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]: ...

    def release_slot(
        self,
        slot_id: str,
        *,
        reason: str = "claim_released",
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot: ...

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, bool, dict[SlotState, int]]: ...

    def get_slot(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot: ...

    def list_slots(
        self,
        *,
        state: SlotState | None = None,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]: ...


class MemoryWarmPoolStore:
    """Thread-safe in-memory store for isolated unit tests (`backend="memory"`)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._seq = 0
        self._slots: dict[str, WarmPoolSlot] = {}
        self._claims_by_key: dict[tuple[str, str], str] = {}
        self._verified_entitlements: set[tuple[str, str]] = set()
        self._po_store: MemoryPurchaseOrderStore | None = None

    def bind_purchase_order_store(self, po_store: MemoryPurchaseOrderStore) -> None:
        with self._lock:
            self._po_store = po_store

    def register_paid_entitlement(self, organisation_id: str, checkout_id: str) -> None:
        with self._lock:
            self._verified_entitlements.add((organisation_id, checkout_id))

    def counts_for_target(
        self,
        *,
        region: str,
        profile_ref: str,
        authority: CallerAuthority | None = None,
    ) -> dict[SlotState, int]:
        _check_static_caller_authority(authority)
        with self._lock:
            return self._counts_unlocked(region=region, profile_ref=profile_ref)

    def _counts_unlocked(self, *, region: str, profile_ref: str) -> dict[SlotState, int]:
        counts: dict[SlotState, int] = {
            "provisioning": 0,
            "ready": 0,
            "claimed": 0,
            "unhealthy": 0,
            "evicted": 0,
        }
        for slot in self._slots.values():
            if slot.region == region and slot.profile_ref == profile_ref:
                counts[slot.state] += 1
        return counts

    def replenish(
        self,
        *,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        from .warm_pool import WarmPoolSlot

        _check_static_caller_authority(authority)
        with self._lock:
            counts = self._counts_unlocked(region=region, profile_ref=profile_ref)
            active_used = counts["provisioning"] + counts["ready"] + counts["unhealthy"]
            warm_pipeline = counts["ready"] + counts["provisioning"]
            headroom = max(0, watermarks.max_total - active_used)
            desired = max(0, watermarks.target_ready - warm_pipeline)
            needed = min(desired, headroom)
            created: list[WarmPoolSlot] = []
            for _ in range(needed):
                self._seq += 1
                slot_id = f"wps-{region}-{self._seq:06d}"
                slot = WarmPoolSlot(
                    slot_id=slot_id,
                    sequence=self._seq,
                    region=region,
                    profile_ref=profile_ref,
                    state="provisioning",
                )
                self._slots[slot_id] = slot
                created.append(slot)
            return tuple(created)

    def transition_slot(
        self,
        slot_id: str,
        *,
        target_state: SlotState,
        allowed_from: frozenset[SlotState],
        unhealthy_reason: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from .warm_pool import WarmPoolSlot, WarmPoolTransitionError, WarmPoolValidationError

        _check_static_caller_authority(authority)
        with self._lock:
            current = self._slots.get(slot_id)
            if current is None:
                raise WarmPoolValidationError(
                    "unknown warm-pool slot identifier", code="unknown_slot_id"
                )
            if current.state not in allowed_from:
                raise WarmPoolTransitionError(
                    f"invalid slot transition {current.state} -> {target_state}"
                )
            updated = WarmPoolSlot(
                slot_id=current.slot_id,
                sequence=current.sequence,
                region=current.region,
                profile_ref=current.profile_ref,
                state=target_state,
                claimed_by_organisation_id=current.claimed_by_organisation_id,
                checkout_id=current.checkout_id,
                idempotency_key=current.idempotency_key,
                unhealthy_reason=(
                    unhealthy_reason if target_state == "unhealthy" else current.unhealthy_reason
                ),
            )
            self._slots[slot_id] = updated
            return updated

    def evict_unhealthy(
        self,
        *,
        region: str | None,
        profile_ref: str | None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        from .warm_pool import WarmPoolSlot

        _check_static_caller_authority(authority)
        with self._lock:
            candidates = sorted(
                (
                    s
                    for s in self._slots.values()
                    if s.state == "unhealthy"
                    and (region is None or s.region == region)
                    and (profile_ref is None or s.profile_ref == profile_ref)
                ),
                key=lambda s: s.sequence,
            )
            evicted: list[WarmPoolSlot] = []
            for slot in candidates:
                updated = WarmPoolSlot(
                    slot_id=slot.slot_id,
                    sequence=slot.sequence,
                    region=slot.region,
                    profile_ref=slot.profile_ref,
                    state="evicted",
                    unhealthy_reason=slot.unhealthy_reason,
                )
                self._slots[slot.slot_id] = updated
                evicted.append(updated)
            return tuple(evicted)

    def release_slot(
        self,
        slot_id: str,
        *,
        reason: str = "claim_released",
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from .warm_pool import WarmPoolSlot, WarmPoolTransitionError, WarmPoolValidationError

        _check_static_caller_authority(authority)
        with self._lock:
            current = self._slots.get(slot_id)
            if current is None:
                raise WarmPoolValidationError(
                    "unknown warm-pool slot identifier", code="unknown_slot_id"
                )
            if current.state not in ("claimed", "unhealthy"):
                raise WarmPoolTransitionError(f"invalid slot transition {current.state} -> evicted")
            if (
                current.claimed_by_organisation_id is not None
                and current.idempotency_key is not None
            ):
                self._claims_by_key.pop(
                    (current.claimed_by_organisation_id, current.idempotency_key), None
                )
            updated = WarmPoolSlot(
                slot_id=current.slot_id,
                sequence=current.sequence,
                region=current.region,
                profile_ref=current.profile_ref,
                state="evicted",
                claimed_by_organisation_id=None,
                checkout_id=None,
                idempotency_key=None,
                unhealthy_reason=reason,
            )
            self._slots[slot_id] = updated
            return updated

    def _has_memory_paid_entitlement_unlocked(
        self, *, organisation_id: str, checkout_id: str
    ) -> bool:
        if (organisation_id, checkout_id) in self._verified_entitlements:
            return True
        if self._po_store is not None:
            return self._po_store.has_paid_enterprise_entitlement(
                organisation_id=organisation_id,
                checkout_id=checkout_id,
            )
        return False

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, bool, dict[SlotState, int]]:
        from .warm_pool import (
            WarmPoolExhaustedError,
            WarmPoolIdempotencyConflictError,
            WarmPoolSlot,
            WarmPoolTenantCapExceededError,
        )

        _check_static_caller_authority(authority, target_organisation_id=organisation_id)
        with self._lock:
            if (
                authority is not None
                and authority.lane == "customer"
                and not self._has_memory_paid_entitlement_unlocked(
                    organisation_id=organisation_id, checkout_id=checkout_id
                )
            ):
                raise BillingAuthorityForbiddenError(
                    "warm-pool claim requires verified paid enterprise entitlement"
                )

            scoped_pair = (organisation_id, idempotency_key)
            existing_slot_id = self._claims_by_key.get(scoped_pair)
            if existing_slot_id is not None:
                existing = self._slots[existing_slot_id]
                if (
                    existing.claimed_by_organisation_id != organisation_id
                    or existing.checkout_id != checkout_id
                    or existing.region != region
                    or existing.profile_ref != profile_ref
                ):
                    raise WarmPoolIdempotencyConflictError(
                        "idempotency_key already bound to a different warm-pool claim"
                    )
                return existing, True, self._counts_unlocked(region=region, profile_ref=profile_ref)

            for active_slot in self._slots.values():
                if active_slot.state == "claimed":
                    if active_slot.claimed_by_organisation_id == organisation_id:
                        raise WarmPoolTenantCapExceededError(
                            "organisation already holds an active warm-pool slot"
                        )
                    if active_slot.checkout_id == checkout_id:
                        raise WarmPoolIdempotencyConflictError(
                            "checkout_id already bound to an active warm-pool claim"
                        )

            ready_slots = sorted(
                (
                    s
                    for s in self._slots.values()
                    if s.state == "ready" and s.region == region and s.profile_ref == profile_ref
                ),
                key=lambda s: s.sequence,
            )
            if not ready_slots:
                counts = self._counts_unlocked(region=region, profile_ref=profile_ref)
                active_used = counts["provisioning"] + counts["ready"] + counts["unhealthy"]
                warm_pipeline = counts["ready"] + counts["provisioning"]
                headroom = max(0, watermarks.max_total - active_used)
                desired = max(0, watermarks.target_ready - warm_pipeline)
                raise WarmPoolExhaustedError(
                    region=region,
                    profile_ref=profile_ref,
                    replenish_count=min(desired, headroom),
                )

            chosen = ready_slots[0]
            claimed = WarmPoolSlot(
                slot_id=chosen.slot_id,
                sequence=chosen.sequence,
                region=chosen.region,
                profile_ref=chosen.profile_ref,
                state="claimed",
                claimed_by_organisation_id=organisation_id,
                checkout_id=checkout_id,
                idempotency_key=idempotency_key,
            )
            self._slots[chosen.slot_id] = claimed
            self._claims_by_key[scoped_pair] = chosen.slot_id
            return claimed, False, self._counts_unlocked(region=region, profile_ref=profile_ref)

    def get_slot(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from .warm_pool import WarmPoolValidationError

        _check_static_caller_authority(authority)
        with self._lock:
            slot = self._slots.get(slot_id)
            if slot is None:
                raise WarmPoolValidationError(
                    "unknown warm-pool slot identifier", code="unknown_slot_id"
                )
            return slot

    def list_slots(
        self,
        *,
        state: SlotState | None = None,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        _check_static_caller_authority(authority)
        with self._lock:
            matched = [
                slot
                for slot in self._slots.values()
                if (state is None or slot.state == state)
                and (region is None or slot.region == region)
                and (profile_ref is None or slot.profile_ref == profile_ref)
            ]
            matched.sort(key=lambda item: item.sequence)
            return tuple(matched)


def _as_slot_state(value: str) -> SlotState | None:
    if value == "provisioning":
        return "provisioning"
    if value == "ready":
        return "ready"
    if value == "claimed":
        return "claimed"
    if value == "unhealthy":
        return "unhealthy"
    if value == "evicted":
        return "evicted"
    return None


def _row_to_slot(row: tuple[Any, ...]) -> WarmPoolSlot:
    from .warm_pool import WarmPoolSlot

    state = _as_slot_state(str(row[4]))
    if state is None:
        raise RuntimeError(f"unexpected warm-pool slot state: {row[4]!r}")
    claimed_org = None if row[5] is None else str(row[5])
    raw_idem = None if row[7] is None else str(row[7])
    return WarmPoolSlot(
        slot_id=str(row[0]),
        sequence=int(row[1]),
        region=str(row[2]),
        profile_ref=str(row[3]),
        state=state,
        claimed_by_organisation_id=claimed_org,
        checkout_id=None if row[6] is None else str(row[6]),
        idempotency_key=_decode_scoped_idempotency_key(raw_idem, claimed_org),
        unhealthy_reason=None if row[8] is None else str(row[8]),
    )


class PostgresWarmPoolStore:
    """Multi-worker PostgreSQL warm-pool store serialized via advisory + row locks."""

    @staticmethod
    def _fetch_counts(cursor: Any, *, region: str, profile_ref: str) -> dict[SlotState, int]:
        counts: dict[SlotState, int] = {
            "provisioning": 0,
            "ready": 0,
            "claimed": 0,
            "unhealthy": 0,
            "evicted": 0,
        }
        cursor.execute(
            """
            SELECT state, COUNT(*)
            FROM ee_billing_warm_pool_slots
            WHERE region = %s AND profile_ref = %s
            GROUP BY state
            """,
            [region, profile_ref],
        )
        for state_raw, count_raw in cursor.fetchall():
            parsed_state = _as_slot_state(str(state_raw))
            if parsed_state is not None:
                counts[parsed_state] = int(count_raw)
        return counts

    def counts_for_target(
        self,
        *,
        region: str,
        profile_ref: str,
        authority: CallerAuthority | None = None,
    ) -> dict[SlotState, int]:
        from django.db import DatabaseError, connection, transaction

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                return self._fetch_counts(cursor, region=region, profile_ref=profile_ref)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def replenish(
        self,
        *,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        from django.db import DatabaseError, connection, transaction

        from .warm_pool import WarmPoolSlot

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [_WARM_POOL_LOCK_KEY])
                counts = self._fetch_counts(cursor, region=region, profile_ref=profile_ref)
                active_used = counts["provisioning"] + counts["ready"] + counts["unhealthy"]
                warm_pipeline = counts["ready"] + counts["provisioning"]
                headroom = max(0, watermarks.max_total - active_used)
                desired = max(0, watermarks.target_ready - warm_pipeline)
                needed = min(desired, headroom)
                created: list[WarmPoolSlot] = []
                for _ in range(needed):
                    seq = _next_sequence(cursor, _WARM_POOL_SEQUENCE_NAME)
                    slot_id = f"wps-{region}-{seq:06d}"
                    cursor.execute(
                        """
                        INSERT INTO ee_billing_warm_pool_slots (
                            slot_id, sequence, region, profile_ref, state,
                            claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                        )
                        VALUES (%s, %s, %s, %s, 'provisioning', NULL, NULL, NULL, NULL)
                        """,
                        [slot_id, seq, region, profile_ref],
                    )
                    created.append(
                        WarmPoolSlot(
                            slot_id=slot_id,
                            sequence=seq,
                            region=region,
                            profile_ref=profile_ref,
                            state="provisioning",
                        )
                    )
                return tuple(created)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def transition_slot(
        self,
        slot_id: str,
        *,
        target_state: SlotState,
        allowed_from: frozenset[SlotState],
        unhealthy_reason: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from django.db import DatabaseError, connection, transaction

        from .warm_pool import WarmPoolTransitionError, WarmPoolValidationError

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [_WARM_POOL_LOCK_KEY])
                cursor.execute(
                    """
                    SELECT slot_id, sequence, region, profile_ref, state,
                           claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    FROM ee_billing_warm_pool_slots
                    WHERE slot_id = %s
                    FOR UPDATE
                    """,
                    [slot_id],
                )
                row = cursor.fetchone()
                if row is None:
                    raise WarmPoolValidationError(
                        "unknown warm-pool slot identifier", code="unknown_slot_id"
                    )
                current = _row_to_slot(row)
                if current.state not in allowed_from:
                    raise WarmPoolTransitionError(
                        f"invalid slot transition {current.state} -> {target_state}"
                    )
                next_reason = (
                    unhealthy_reason if target_state == "unhealthy" else current.unhealthy_reason
                )
                cursor.execute(
                    """
                    UPDATE ee_billing_warm_pool_slots
                    SET state = %s, unhealthy_reason = %s
                    WHERE slot_id = %s
                    RETURNING slot_id, sequence, region, profile_ref, state,
                              claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    """,
                    [target_state, next_reason, slot_id],
                )
                updated_row = cursor.fetchone()
                if updated_row is None:
                    raise RuntimeError("warm-pool slot update returned no row")
                return _row_to_slot(updated_row)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def evict_unhealthy(
        self,
        *,
        region: str | None,
        profile_ref: str | None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        from django.db import DatabaseError, connection, transaction

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [_WARM_POOL_LOCK_KEY])
                cursor.execute(
                    """
                    SELECT slot_id
                    FROM ee_billing_warm_pool_slots
                    WHERE state = 'unhealthy'
                      AND (%s IS NULL OR region = %s)
                      AND (%s IS NULL OR profile_ref = %s)
                    ORDER BY sequence ASC
                    FOR UPDATE
                    """,
                    [region, region, profile_ref, profile_ref],
                )
                slot_ids = [str(r[0]) for r in cursor.fetchall()]
                evicted: list[WarmPoolSlot] = []
                for slot_id in slot_ids:
                    cursor.execute(
                        """
                        UPDATE ee_billing_warm_pool_slots
                        SET state = 'evicted'
                        WHERE slot_id = %s
                        RETURNING slot_id, sequence, region, profile_ref, state,
                                  claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                        """,
                        [slot_id],
                    )
                    row = cursor.fetchone()
                    if row is not None:
                        evicted.append(_row_to_slot(row))
                return tuple(evicted)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def release_slot(
        self,
        slot_id: str,
        *,
        reason: str = "claim_released",
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from django.db import DatabaseError, connection, transaction

        from .warm_pool import WarmPoolTransitionError, WarmPoolValidationError

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [_WARM_POOL_LOCK_KEY])
                cursor.execute(
                    """
                    SELECT slot_id, sequence, region, profile_ref, state,
                           claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    FROM ee_billing_warm_pool_slots
                    WHERE slot_id = %s
                    FOR UPDATE
                    """,
                    [slot_id],
                )
                row = cursor.fetchone()
                if row is None:
                    raise WarmPoolValidationError(
                        "unknown warm-pool slot identifier", code="unknown_slot_id"
                    )
                current = _row_to_slot(row)
                if current.state not in ("claimed", "unhealthy"):
                    raise WarmPoolTransitionError(
                        f"invalid slot transition {current.state} -> evicted"
                    )
                cursor.execute(
                    """
                    UPDATE ee_billing_warm_pool_slots
                    SET state = 'evicted',
                        claimed_by_organisation_id = NULL,
                        checkout_id = NULL,
                        idempotency_key = NULL,
                        unhealthy_reason = %s
                    WHERE slot_id = %s
                    RETURNING slot_id, sequence, region, profile_ref, state,
                              claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    """,
                    [reason, slot_id],
                )
                updated_row = cursor.fetchone()
                if updated_row is None:
                    raise RuntimeError("warm-pool slot release returned no row")
                return _row_to_slot(updated_row)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, bool, dict[SlotState, int]]:
        from django.db import DatabaseError, connection, transaction

        from .warm_pool import (
            WarmPoolExhaustedError,
            WarmPoolIdempotencyConflictError,
            WarmPoolTenantCapExceededError,
        )

        scoped_key = _encode_scoped_idempotency_key(organisation_id, idempotency_key)
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority, target_organisation_id=organisation_id)
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [_WARM_POOL_LOCK_KEY])
                if authority is not None and authority.lane == "customer":
                    if not _has_postgres_paid_enterprise_entitlement(
                        cursor,
                        organisation_id=organisation_id,
                        checkout_id=checkout_id,
                    ):
                        raise BillingAuthorityForbiddenError(
                            "warm-pool claim requires verified paid enterprise entitlement"
                        )
                cursor.execute(
                    """
                    SELECT slot_id, sequence, region, profile_ref, state,
                           claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    FROM ee_billing_warm_pool_slots
                    WHERE claimed_by_organisation_id = %s
                      AND idempotency_key IN (%s, %s)
                    FOR UPDATE
                    """,
                    [organisation_id, scoped_key, idempotency_key],
                )
                existing_row = cursor.fetchone()
                if existing_row is not None:
                    existing = _row_to_slot(existing_row)
                    if (
                        existing.claimed_by_organisation_id != organisation_id
                        or existing.checkout_id != checkout_id
                        or existing.region != region
                        or existing.profile_ref != profile_ref
                    ):
                        raise WarmPoolIdempotencyConflictError(
                            "idempotency_key already bound to a different warm-pool claim"
                        )
                    counts = self._fetch_counts(cursor, region=region, profile_ref=profile_ref)
                    return existing, True, counts

                cursor.execute(
                    """
                    SELECT slot_id
                    FROM ee_billing_warm_pool_slots
                    WHERE state = 'claimed' AND claimed_by_organisation_id = %s
                    LIMIT 1
                    FOR UPDATE
                    """,
                    [organisation_id],
                )
                if cursor.fetchone() is not None:
                    raise WarmPoolTenantCapExceededError(
                        "organisation already holds an active warm-pool slot"
                    )

                cursor.execute(
                    """
                    SELECT slot_id
                    FROM ee_billing_warm_pool_slots
                    WHERE state = 'claimed' AND checkout_id = %s
                    LIMIT 1
                    FOR UPDATE
                    """,
                    [checkout_id],
                )
                if cursor.fetchone() is not None:
                    raise WarmPoolIdempotencyConflictError(
                        "checkout_id already bound to an active warm-pool claim"
                    )

                cursor.execute(
                    """
                    SELECT slot_id
                    FROM ee_billing_warm_pool_slots
                    WHERE state = 'ready' AND region = %s AND profile_ref = %s
                    ORDER BY sequence ASC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    [region, profile_ref],
                )
                chosen_row = cursor.fetchone()
                if chosen_row is None:
                    counts = self._fetch_counts(cursor, region=region, profile_ref=profile_ref)
                    active_used = counts["provisioning"] + counts["ready"] + counts["unhealthy"]
                    warm_pipeline = counts["ready"] + counts["provisioning"]
                    headroom = max(0, watermarks.max_total - active_used)
                    desired = max(0, watermarks.target_ready - warm_pipeline)
                    raise WarmPoolExhaustedError(
                        region=region,
                        profile_ref=profile_ref,
                        replenish_count=min(desired, headroom),
                    )

                chosen_id = str(chosen_row[0])
                cursor.execute(
                    """
                    UPDATE ee_billing_warm_pool_slots
                    SET state = 'claimed',
                        claimed_by_organisation_id = %s,
                        checkout_id = %s,
                        idempotency_key = %s
                    WHERE slot_id = %s
                    RETURNING slot_id, sequence, region, profile_ref, state,
                              claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    """,
                    [organisation_id, checkout_id, scoped_key, chosen_id],
                )
                claimed_row = cursor.fetchone()
                if claimed_row is None:
                    raise RuntimeError("warm-pool slot claim returned no row")
                counts = self._fetch_counts(cursor, region=region, profile_ref=profile_ref)
                return _row_to_slot(claimed_row), False, counts
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def get_slot(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        from django.db import DatabaseError, connection, transaction

        from .warm_pool import WarmPoolValidationError

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute(
                    """
                    SELECT slot_id, sequence, region, profile_ref, state,
                           claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    FROM ee_billing_warm_pool_slots
                    WHERE slot_id = %s
                    """,
                    [slot_id],
                )
                row = cursor.fetchone()
                if row is None:
                    raise WarmPoolValidationError(
                        "unknown warm-pool slot identifier", code="unknown_slot_id"
                    )
                return _row_to_slot(row)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def list_slots(
        self,
        *,
        state: SlotState | None = None,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        from django.db import DatabaseError, connection, transaction

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                _acquire_ee_caller_fence(cursor, authority)
                cursor.execute(
                    """
                    SELECT slot_id, sequence, region, profile_ref, state,
                           claimed_by_organisation_id, checkout_id, idempotency_key, unhealthy_reason
                    FROM ee_billing_warm_pool_slots
                    WHERE (%s IS NULL OR state = %s)
                      AND (%s IS NULL OR region = %s)
                      AND (%s IS NULL OR profile_ref = %s)
                    ORDER BY sequence ASC
                    """,
                    [state, state, region, region, profile_ref, profile_ref],
                )
                return tuple(_row_to_slot(r) for r in cursor.fetchall())
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise


class PurchaseOrderStore(Protocol):
    def create_draft(
        self,
        *,
        year: int,
        draft_builder: Any,
        organisation_id: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder: ...

    def get(
        self,
        po_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder: ...

    def mutate(
        self,
        po_id: str,
        mutator: Any,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder: ...

    def verify_core_invoice(self, *, po: PurchaseOrder, invoice_ref: str) -> None: ...

    def verify_core_payment(
        self,
        *,
        po: PurchaseOrder,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
    ) -> None: ...


class MemoryPurchaseOrderStore:
    """Thread-safe in-memory PO store for isolated unit tests (`backend="memory"`)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._seq = 0
        self._orders: dict[str, PurchaseOrder] = {}
        self._invoice_refs: dict[str, str] = {}
        self._core_invoices: dict[str, dict[str, Any]] = {}
        self._core_payments: dict[tuple[str, str], dict[str, Any]] = {}

    def register_core_invoice(
        self,
        number: str,
        *,
        organisation_id: str,
        total_incl_vat_minor: int,
        currency: str = "EUR",
        state: str = "issued",
        plan_code: str = "sovereign",
    ) -> None:
        """Seed a synthetic Core `billing_invoice` record for isolated memory-backend tests."""
        with self._lock:
            self._core_invoices[number] = {
                "number": number,
                "organisation_id": organisation_id,
                "total_incl_vat_minor": int(total_incl_vat_minor),
                "amount_paid_minor": int(total_incl_vat_minor) if state == "paid" else 0,
                "currency": currency.upper(),
                "state": state,
                "plan_code": plan_code.strip().lower(),
            }

    def register_core_payment(
        self,
        invoice_number: str,
        payment_ref: str,
        *,
        organisation_id: str,
        amount_minor: int,
        currency: str = "EUR",
        state: str = "succeeded",
        allocated: bool = True,
        mark_invoice_paid: bool = True,
    ) -> None:
        """Seed a synthetic Core `billing_payment` record for isolated memory-backend tests."""
        with self._lock:
            self._core_payments[(invoice_number, payment_ref)] = {
                "invoice_number": invoice_number,
                "payment_ref": payment_ref,
                "organisation_id": organisation_id,
                "amount_minor": int(amount_minor),
                "currency": currency.upper(),
                "state": state,
                "allocated": bool(allocated),
            }
            if mark_invoice_paid and invoice_number in self._core_invoices:
                inv = self._core_invoices[invoice_number]
                if inv["organisation_id"] == organisation_id and state == "succeeded" and allocated:
                    inv["state"] = "paid"
                    inv["amount_paid_minor"] = int(amount_minor)

    def verify_core_invoice(self, *, po: PurchaseOrder, invoice_ref: str) -> None:
        from .purchase_orders import PurchaseOrderValidationError

        with self._lock:
            inv = self._core_invoices.get(invoice_ref)
            if (
                inv is None
                or inv["organisation_id"] != po.organisation_id
                or int(inv["total_incl_vat_minor"]) != po.total_incl_vat_minor
                or str(inv["currency"]).upper() != po.currency.upper()
                or str(inv["state"]) not in ("issued", "overdue", "paid")
            ):
                raise PurchaseOrderValidationError(
                    "invoice_ref does not match a persisted Core invoice for this purchase order",
                    code="unverified_core_invoice",
                )

    def verify_core_payment(
        self,
        *,
        po: PurchaseOrder,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
    ) -> None:
        from .purchase_orders import PurchaseOrderValidationError

        with self._lock:
            inv = self._core_invoices.get(invoice_ref)
            pay = self._core_payments.get((invoice_ref, payment_ref))
            if (
                inv is None
                or inv["organisation_id"] != po.organisation_id
                or int(inv["total_incl_vat_minor"]) != po.total_incl_vat_minor
                or int(inv["amount_paid_minor"]) < po.total_incl_vat_minor
                or str(inv["currency"]).upper() != po.currency.upper()
                or str(inv["state"]) != "paid"
                or pay is None
                or pay["organisation_id"] != po.organisation_id
                or str(pay["state"]) != "succeeded"
                or not bool(pay["allocated"])
                or int(pay["amount_minor"]) != amount_paid_minor
                or int(pay["amount_minor"]) != po.total_incl_vat_minor
                or str(pay["currency"]).upper() != po.currency.upper()
            ):
                raise PurchaseOrderValidationError(
                    "payment_ref does not match a settled Core payment for the bound invoice",
                    code="unverified_core_payment",
                )

    def has_paid_enterprise_entitlement(self, *, organisation_id: str, checkout_id: str) -> bool:
        with self._lock:
            for po in self._orders.values():
                if (
                    po.organisation_id == organisation_id
                    and po.plan_code == "sovereign"
                    and po.state == "paid"
                    and checkout_id
                    in (
                        po.po_id,
                        po.po_number,
                        po.customer_po_reference,
                        po.invoice_ref,
                        po.payment_ref,
                    )
                ):
                    return True
            for inv in self._core_invoices.values():
                if (
                    inv["organisation_id"] == organisation_id
                    and inv["state"] == "paid"
                    and inv.get("plan_code") == "sovereign"
                    and int(inv["total_incl_vat_minor"]) > 0
                    and int(inv["amount_paid_minor"]) >= int(inv["total_incl_vat_minor"])
                    and inv["number"] == checkout_id
                ):
                    return True
            for (inv_num, pay_ref), pay in self._core_payments.items():
                bound_inv = self._core_invoices.get(inv_num)
                if (
                    pay["organisation_id"] == organisation_id
                    and pay["state"] == "succeeded"
                    and pay["allocated"]
                    and bound_inv is not None
                    and bound_inv["organisation_id"] == organisation_id
                    and bound_inv["state"] == "paid"
                    and bound_inv.get("plan_code") == "sovereign"
                    and pay_ref == checkout_id
                ):
                    return True
            return False

    def create_draft(
        self,
        *,
        year: int,
        draft_builder: Any,
        organisation_id: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        _check_static_caller_authority(authority, target_organisation_id=organisation_id)
        with self._lock:
            self._seq += 1
            po_id = _new_opaque_po_id()
            po_number = f"PO-{year}-{self._seq:05d}"
            po: PurchaseOrder = draft_builder(po_id, po_number)
            if organisation_id is None:
                _check_static_caller_authority(authority, target_organisation_id=po.organisation_id)
            self._orders[po_id] = po
            return po

    def get(
        self,
        po_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        from .purchase_orders import PurchaseOrderNotFoundError

        if authority is not None and authority.lane == "customer":
            allowed_orgs = _authorized_customer_org_ids(authority)
            if not allowed_orgs:
                raise BillingAuthorityForbiddenError("insufficient organisation role")
            with self._lock:
                po = self._orders.get(po_id)
                if po is None or po.organisation_id not in allowed_orgs:
                    raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
                return po

        _check_static_caller_authority(authority)
        with self._lock:
            po = self._orders.get(po_id)
            if po is None:
                raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
            return po

    def mutate(
        self,
        po_id: str,
        mutator: Any,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        from .purchase_orders import PurchaseOrderNotFoundError, PurchaseOrderValidationError

        if authority is not None and authority.lane == "customer":
            allowed_orgs = _authorized_customer_org_ids(authority)
            if not allowed_orgs:
                raise BillingAuthorityForbiddenError("insufficient organisation role")
        else:
            allowed_orgs = ()
            _check_static_caller_authority(authority)

        with self._lock:
            current = self._orders.get(po_id)
            if current is None or (allowed_orgs and current.organisation_id not in allowed_orgs):
                raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
            updated, auto_expired = mutator(current)
            if auto_expired is not None:
                expired_po, expired_exc = auto_expired
                self._orders[po_id] = expired_po
                raise expired_exc
            if updated is None:
                raise RuntimeError("mutator returned neither updated nor auto_expired")
            if updated.invoice_ref is not None:
                owner = self._invoice_refs.get(updated.invoice_ref)
                if owner is not None and owner != po_id:
                    raise PurchaseOrderValidationError(
                        "invoice_ref is already bound to another purchase order",
                        code="duplicate_invoice_ref",
                    )
                self._invoice_refs[updated.invoice_ref] = po_id
            self._orders[po_id] = updated
            return updated


def _as_utc(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.astimezone(UTC) if val.tzinfo is not None else val.replace(tzinfo=UTC)
    raise TypeError("expected datetime column")


def _row_to_po(row: tuple[Any, ...]) -> PurchaseOrder:
    from .pricing import PlanCode
    from .purchase_orders import PurchaseOrder

    created_at = _as_utc(row[16])
    expires_at = _as_utc(row[17])
    if created_at is None or expires_at is None:
        raise RuntimeError("purchase order row missing mandatory timestamps")
    return PurchaseOrder(
        po_id=str(row[0]),
        po_number=str(row[1]),
        organisation_id=str(row[2]),
        customer_po_reference=str(row[3]),
        plan_code=cast("PlanCode", str(row[4])),
        billing_months=int(row[5]),
        committed_seats=int(row[6]),
        committed_storage_gb=int(row[7]),
        subtotal_excl_vat_minor=int(row[8]),
        vat_rate_bps=int(row[9]),
        vat_amount_minor=int(row[10]),
        total_incl_vat_minor=int(row[11]),
        estimated_cogs_minor=int(row[12]),
        gross_margin_bps=int(row[13]),
        currency=str(row[14]),
        state=cast("PurchaseOrderState", str(row[15])),
        created_at=created_at,
        expires_at=expires_at,
        issued_at=_as_utc(row[18]),
        countersigned_at=_as_utc(row[19]),
        countersigned_by=None if row[20] is None else str(row[20]),
        countersigned_by_user_id=None if row[21] is None else str(row[21]),
        invoice_ref=None if row[22] is None else str(row[22]),
        invoiced_at=_as_utc(row[23]),
        payment_ref=None if row[24] is None else str(row[24]),
        paid_at=_as_utc(row[25]),
        expired_at=_as_utc(row[26]),
    )


class PostgresPurchaseOrderStore:
    """Multi-worker PostgreSQL Purchase Order store with `SELECT ... FOR UPDATE` row locks."""

    def verify_core_invoice(self, *, po: PurchaseOrder, invoice_ref: str) -> None:
        from django.db import connection

        from .purchase_orders import PurchaseOrderValidationError

        try:
            org_uuid = UUID(po.organisation_id)
        except ValueError as exc:
            raise PurchaseOrderValidationError(
                "invoice_ref does not match a persisted Core invoice for this purchase order",
                code="unverified_core_invoice",
            ) from exc

        bare_number = invoice_ref[4:] if invoice_ref.startswith("INV-") else invoice_ref
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, organisation_id, total_incl_vat_minor, currency, state
                FROM billing_invoice
                WHERE number IN (%s, %s)
                """,
                [invoice_ref, bare_number],
            )
            row = cursor.fetchone()
        if (
            row is None
            or str(row[1]) != str(org_uuid)
            or int(row[2]) != po.total_incl_vat_minor
            or str(row[3]).upper() != po.currency.upper()
            or str(row[4]) not in ("issued", "overdue", "paid")
        ):
            raise PurchaseOrderValidationError(
                "invoice_ref does not match a persisted Core invoice for this purchase order",
                code="unverified_core_invoice",
            )

    def verify_core_payment(
        self,
        *,
        po: PurchaseOrder,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
    ) -> None:
        from django.db import connection

        from .purchase_orders import PurchaseOrderValidationError

        try:
            org_uuid = UUID(po.organisation_id)
        except ValueError as exc:
            raise PurchaseOrderValidationError(
                "payment_ref does not match a settled Core payment for the bound invoice",
                code="unverified_core_payment",
            ) from exc

        bare_number = invoice_ref[4:] if invoice_ref.startswith("INV-") else invoice_ref
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, organisation_id, total_incl_vat_minor, amount_paid_minor, currency, state
                FROM billing_invoice
                WHERE number IN (%s, %s)
                """,
                [invoice_ref, bare_number],
            )
            inv_row = cursor.fetchone()
            if (
                inv_row is None
                or str(inv_row[1]) != str(org_uuid)
                or int(inv_row[2]) != po.total_incl_vat_minor
                or int(inv_row[3]) < po.total_incl_vat_minor
                or str(inv_row[4]).upper() != po.currency.upper()
                or str(inv_row[5]) != "paid"
            ):
                raise PurchaseOrderValidationError(
                    "payment_ref does not match a settled Core payment for the bound invoice",
                    code="unverified_core_payment",
                )
            invoice_id = inv_row[0]
            cursor.execute(
                """
                SELECT id, amount_minor, currency, state, allocated
                FROM billing_payment
                WHERE invoice_id = %s
                  AND organisation_id = %s
                  AND (provider_ref = %s OR id::text = %s)
                """,
                [invoice_id, org_uuid, payment_ref, payment_ref],
            )
            pay_row = cursor.fetchone()

        if (
            pay_row is None
            or str(pay_row[3]) != "succeeded"
            or not bool(pay_row[4])
            or int(pay_row[1]) != amount_paid_minor
            or int(pay_row[1]) != po.total_incl_vat_minor
            or str(pay_row[2]).upper() != po.currency.upper()
        ):
            raise PurchaseOrderValidationError(
                "payment_ref does not match a settled Core payment for the bound invoice",
                code="unverified_core_payment",
            )

    def create_draft(
        self,
        *,
        year: int,
        draft_builder: Any,
        organisation_id: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        from django.db import DatabaseError, connection, transaction

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                if organisation_id is not None:
                    _acquire_ee_caller_fence(
                        cursor, authority, target_organisation_id=organisation_id
                    )
                seq = _next_sequence(cursor, _PO_SEQUENCE_NAME)
                po_id = _new_opaque_po_id()
                po_number = f"PO-{year}-{seq:05d}"
                po: PurchaseOrder = draft_builder(po_id, po_number)
                if organisation_id is None:
                    _acquire_ee_caller_fence(
                        cursor, authority, target_organisation_id=po.organisation_id
                    )
                cursor.execute(
                    """
                    INSERT INTO ee_billing_purchase_orders (
                        po_id, po_number, organisation_id, customer_po_reference, plan_code,
                        billing_months, committed_seats, committed_storage_gb,
                        subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                        estimated_cogs_minor, gross_margin_bps, currency, state,
                        created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                        countersigned_by_user_id,
                        invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s,
                        %s, %s, %s, %s, %s
                    )
                    """,
                    [
                        po.po_id,
                        po.po_number,
                        po.organisation_id,
                        po.customer_po_reference,
                        po.plan_code,
                        po.billing_months,
                        po.committed_seats,
                        po.committed_storage_gb,
                        po.subtotal_excl_vat_minor,
                        po.vat_rate_bps,
                        po.vat_amount_minor,
                        po.total_incl_vat_minor,
                        po.estimated_cogs_minor,
                        po.gross_margin_bps,
                        po.currency,
                        po.state,
                        po.created_at,
                        po.expires_at,
                        po.issued_at,
                        po.countersigned_at,
                        po.countersigned_by,
                        _try_uuid(po.countersigned_by_user_id),
                        po.invoice_ref,
                        po.invoiced_at,
                        po.payment_ref,
                        po.paid_at,
                        po.expired_at,
                    ],
                )
                return po
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def get(
        self,
        po_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        from django.db import DatabaseError, connection, transaction

        from .purchase_orders import PurchaseOrderNotFoundError

        try:
            with transaction.atomic(), connection.cursor() as cursor:
                if authority is not None and authority.lane == "customer":
                    allowed_orgs = _authorized_customer_org_ids(authority)
                    if not allowed_orgs:
                        raise BillingAuthorityForbiddenError("insufficient organisation role")
                    for caller_org_id in allowed_orgs:
                        _acquire_ee_caller_fence(
                            cursor, authority, target_organisation_id=caller_org_id
                        )
                    cursor.execute(
                        """
                        SELECT po_id, po_number, organisation_id, customer_po_reference, plan_code,
                               billing_months, committed_seats, committed_storage_gb,
                               subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                               estimated_cogs_minor, gross_margin_bps, currency, state,
                               created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                               countersigned_by_user_id,
                               invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                        FROM ee_billing_purchase_orders
                        WHERE po_id = %s
                          AND organisation_id = ANY(%s)
                        """,
                        [po_id, list(allowed_orgs)],
                    )
                    row = cursor.fetchone()
                    if row is None:
                        raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
                    return _row_to_po(row)

                _acquire_ee_caller_fence(cursor, authority, target_organisation_id=None)
                cursor.execute(
                    """
                    SELECT po_id, po_number, organisation_id, customer_po_reference, plan_code,
                           billing_months, committed_seats, committed_storage_gb,
                           subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                           estimated_cogs_minor, gross_margin_bps, currency, state,
                           created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                           countersigned_by_user_id,
                           invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                    FROM ee_billing_purchase_orders
                    WHERE po_id = %s
                    """,
                    [po_id],
                )
                row = cursor.fetchone()
                if row is None:
                    raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
                return _row_to_po(row)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

    def mutate(
        self,
        po_id: str,
        mutator: Any,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        from django.db import DatabaseError, IntegrityError, connection, transaction

        from .purchase_orders import PurchaseOrderNotFoundError, PurchaseOrderValidationError

        expired_error: Exception | None = None
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                if authority is not None and authority.lane == "customer":
                    allowed_orgs = _authorized_customer_org_ids(authority)
                    if not allowed_orgs:
                        raise BillingAuthorityForbiddenError("insufficient organisation role")
                    for caller_org_id in allowed_orgs:
                        _acquire_ee_caller_fence(
                            cursor, authority, target_organisation_id=caller_org_id
                        )
                    cursor.execute(
                        """
                        SELECT po_id, po_number, organisation_id, customer_po_reference, plan_code,
                               billing_months, committed_seats, committed_storage_gb,
                               subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                               estimated_cogs_minor, gross_margin_bps, currency, state,
                               created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                               countersigned_by_user_id,
                               invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                        FROM ee_billing_purchase_orders
                        WHERE po_id = %s
                          AND organisation_id = ANY(%s)
                        FOR UPDATE
                        """,
                        [po_id, list(allowed_orgs)],
                    )
                    row = cursor.fetchone()
                    if row is None:
                        raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
                    current = _row_to_po(row)
                else:
                    _acquire_ee_caller_fence(cursor, authority, target_organisation_id=None)
                    cursor.execute(
                        """
                        SELECT po_id, po_number, organisation_id, customer_po_reference, plan_code,
                               billing_months, committed_seats, committed_storage_gb,
                               subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                               estimated_cogs_minor, gross_margin_bps, currency, state,
                               created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                               countersigned_by_user_id,
                               invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                        FROM ee_billing_purchase_orders
                        WHERE po_id = %s
                        FOR UPDATE
                        """,
                        [po_id],
                    )
                    row = cursor.fetchone()
                    if row is None:
                        raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
                    current = _row_to_po(row)
                    if authority is not None:
                        _acquire_ee_caller_fence(
                            cursor, authority, target_organisation_id=current.organisation_id
                        )
                updated, auto_expired = mutator(current)
                if auto_expired is not None:
                    expired_po, expired_error = auto_expired
                    cursor.execute(
                        """
                        UPDATE ee_billing_purchase_orders
                        SET state = %s, expired_at = %s
                        WHERE po_id = %s
                        """,
                        [expired_po.state, expired_po.expired_at, po_id],
                    )
                else:
                    if updated is None:
                        raise RuntimeError("mutator returned neither updated nor auto_expired")
                    if updated.invoice_ref is not None:
                        cursor.execute(
                            """
                            SELECT po_id
                            FROM ee_billing_purchase_orders
                            WHERE invoice_ref = %s
                            FOR UPDATE
                            """,
                            [updated.invoice_ref],
                        )
                        existing_owner = cursor.fetchone()
                        if existing_owner is not None and str(existing_owner[0]) != po_id:
                            raise PurchaseOrderValidationError(
                                "invoice_ref is already bound to another purchase order",
                                code="duplicate_invoice_ref",
                            )
                    try:
                        cursor.execute(
                            """
                            UPDATE ee_billing_purchase_orders
                            SET state = %s,
                                issued_at = %s,
                                countersigned_at = %s,
                                countersigned_by = %s,
                                countersigned_by_user_id = %s,
                                invoice_ref = %s,
                                invoiced_at = %s,
                                payment_ref = %s,
                                paid_at = %s,
                                expired_at = %s
                            WHERE po_id = %s
                            RETURNING
                                po_id, po_number, organisation_id, customer_po_reference, plan_code,
                                billing_months, committed_seats, committed_storage_gb,
                                subtotal_excl_vat_minor, vat_rate_bps, vat_amount_minor, total_incl_vat_minor,
                                estimated_cogs_minor, gross_margin_bps, currency, state,
                                created_at, expires_at, issued_at, countersigned_at, countersigned_by,
                                countersigned_by_user_id,
                                invoice_ref, invoiced_at, payment_ref, paid_at, expired_at
                            """,
                            [
                                updated.state,
                                updated.issued_at,
                                updated.countersigned_at,
                                updated.countersigned_by,
                                _try_uuid(updated.countersigned_by_user_id),
                                updated.invoice_ref,
                                updated.invoiced_at,
                                updated.payment_ref,
                                updated.paid_at,
                                updated.expired_at,
                                po_id,
                            ],
                        )
                    except IntegrityError as exc:
                        if _pg_sqlstate(exc) == "23505":
                            raise PurchaseOrderValidationError(
                                "invoice_ref is already bound to another purchase order",
                                code="duplicate_invoice_ref",
                            ) from exc
                        raise
                    updated_row = cursor.fetchone()
                    if updated_row is None:
                        raise RuntimeError("purchase order update returned no row")
                    result = _row_to_po(updated_row)
        except DatabaseError as exc:
            if _pg_sqlstate(exc) in _LOCK_CONFLICT_SQLSTATES:
                raise BillingAuthorityConflictError(
                    "concurrent authority or privacy cutoff conflict"
                ) from exc
            raise

        if expired_error is not None:
            raise expired_error
        return result


class _AutoWarmPoolStore:
    """Dispatches dynamically to PostgreSQL when configured, else deterministic memory."""

    def __init__(self) -> None:
        self._pg = PostgresWarmPoolStore()
        self._mem = MemoryWarmPoolStore()

    def _active(self) -> WarmPoolStore:
        return self._pg if _postgres_configured() else self._mem

    def counts_for_target(
        self,
        *,
        region: str,
        profile_ref: str,
        authority: CallerAuthority | None = None,
    ) -> dict[SlotState, int]:
        return self._active().counts_for_target(
            region=region, profile_ref=profile_ref, authority=authority
        )

    def replenish(
        self,
        *,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        return self._active().replenish(
            region=region,
            profile_ref=profile_ref,
            watermarks=watermarks,
            authority=authority,
        )

    def transition_slot(
        self,
        slot_id: str,
        *,
        target_state: SlotState,
        allowed_from: frozenset[SlotState],
        unhealthy_reason: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        return self._active().transition_slot(
            slot_id,
            target_state=target_state,
            allowed_from=allowed_from,
            unhealthy_reason=unhealthy_reason,
            authority=authority,
        )

    def evict_unhealthy(
        self,
        *,
        region: str | None,
        profile_ref: str | None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        return self._active().evict_unhealthy(
            region=region, profile_ref=profile_ref, authority=authority
        )

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str,
        profile_ref: str,
        watermarks: PoolWatermarks,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, bool, dict[SlotState, int]]:
        return self._active().claim_slot(
            idempotency_key=idempotency_key,
            organisation_id=organisation_id,
            checkout_id=checkout_id,
            region=region,
            profile_ref=profile_ref,
            watermarks=watermarks,
            authority=authority,
        )

    def get_slot(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        return self._active().get_slot(slot_id, authority=authority)

    def release_slot(
        self,
        slot_id: str,
        *,
        reason: str = "operator_released",
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        return self._active().release_slot(
            slot_id,
            reason=reason,
            authority=authority,
        )

    def list_slots(
        self,
        *,
        state: SlotState | None = None,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        return self._active().list_slots(
            state=state,
            region=region,
            profile_ref=profile_ref,
            authority=authority,
        )


class _AutoPurchaseOrderStore:
    """Dispatches dynamically to PostgreSQL when configured, else deterministic memory."""

    def __init__(self) -> None:
        self._pg = PostgresPurchaseOrderStore()
        self._mem = MemoryPurchaseOrderStore()

    def _active(self) -> PurchaseOrderStore:
        return self._pg if _postgres_configured() else self._mem

    def create_draft(
        self,
        *,
        year: int,
        draft_builder: Any,
        organisation_id: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        return self._active().create_draft(
            year=year,
            draft_builder=draft_builder,
            organisation_id=organisation_id,
            authority=authority,
        )

    def get(
        self,
        po_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        return self._active().get(po_id, authority=authority)

    def mutate(
        self,
        po_id: str,
        mutator: Any,
        *,
        authority: CallerAuthority | None = None,
    ) -> PurchaseOrder:
        return self._active().mutate(po_id, mutator, authority=authority)

    def verify_core_invoice(self, *, po: PurchaseOrder, invoice_ref: str) -> None:
        self._active().verify_core_invoice(po=po, invoice_ref=invoice_ref)

    def verify_core_payment(
        self,
        *,
        po: PurchaseOrder,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
    ) -> None:
        self._active().verify_core_payment(
            po=po,
            invoice_ref=invoice_ref,
            payment_ref=payment_ref,
            amount_paid_minor=amount_paid_minor,
        )

    def register_core_invoice(self, number: str, **kwargs: Any) -> None:
        if _postgres_configured():
            raise RuntimeError("seed real billing_invoice rows when running on PostgreSQL")
        self._mem.register_core_invoice(number, **kwargs)

    def register_core_payment(self, invoice_number: str, payment_ref: str, **kwargs: Any) -> None:
        if _postgres_configured():
            raise RuntimeError("seed real billing_payment rows when running on PostgreSQL")
        self._mem.register_core_payment(invoice_number, payment_ref, **kwargs)


def build_warm_pool_store(backend: StorageBackend = "auto") -> WarmPoolStore:
    if backend == "memory":
        return MemoryWarmPoolStore()
    if backend == "postgres":
        return PostgresWarmPoolStore()
    if backend == "auto":
        return _AutoWarmPoolStore()
    raise ValueError("backend must be 'auto', 'postgres', or 'memory'")


def build_purchase_order_store(backend: StorageBackend = "auto") -> PurchaseOrderStore:
    if backend == "memory":
        return MemoryPurchaseOrderStore()
    if backend == "postgres":
        return PostgresPurchaseOrderStore()
    if backend == "auto":
        return _AutoPurchaseOrderStore()
    raise ValueError("backend must be 'auto', 'postgres', or 'memory'")


__all__ = [
    "BillingAuthorityConflictError",
    "BillingAuthorityForbiddenError",
    "CallerAuthority",
    "MemoryPurchaseOrderStore",
    "MemoryWarmPoolStore",
    "PostgresPurchaseOrderStore",
    "PostgresWarmPoolStore",
    "PurchaseOrderStore",
    "StorageBackend",
    "WarmPoolStore",
    "build_purchase_order_store",
    "build_warm_pool_store",
    "verify_caller_authority",
]
