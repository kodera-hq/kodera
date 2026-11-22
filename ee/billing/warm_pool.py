# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Multi-tenant Autopilot warm-pool controller.

Deterministic sizing, idempotent checkout claim, replenishment planning, and unhealthy slot
eviction for managed cloud tenants. Backed by PostgreSQL (`ee/billing/storage.py`) in
multi-worker environments, with optional in-memory storage for isolated unit tests.
Open-source request validation and instant-claim routing remain in
`apps/server/apps/workspaces/warm_pool.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .storage import CallerAuthority, StorageBackend, WarmPoolStore, build_warm_pool_store

SlotState = Literal["provisioning", "ready", "claimed", "unhealthy", "evicted"]

_IDENTIFIER_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")


class WarmPoolError(Exception):
    """Base error for warm-pool state machine violations."""

    code: str

    def __init__(self, message: str, *, code: str = "warm_pool_error") -> None:
        super().__init__(message)
        self.code = code


class WarmPoolValidationError(WarmPoolError):
    """Raised when watermarks, slot ids, or claim inputs are invalid."""

    def __init__(self, message: str, *, code: str = "warm_pool_validation_error") -> None:
        super().__init__(message, code=code)


class WarmPoolExhaustedError(WarmPoolError):
    """Raised when no `ready` slot is available for a checkout claim."""

    def __init__(self, *, region: str, profile_ref: str, replenish_count: int) -> None:
        super().__init__(
            f"no ready warm-pool slot for region={region} profile={profile_ref}; "
            f"replenish_count={replenish_count}",
            code="warm_pool_exhausted",
        )
        self.region = region
        self.profile_ref = profile_ref
        self.replenish_count = replenish_count


class WarmPoolIdempotencyConflictError(WarmPoolError):
    """Raised when an `idempotency_key` is reused with different checkout or org parameters."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="warm_pool_idempotency_conflict")


class WarmPoolTenantCapExceededError(WarmPoolError):
    """Raised when an organisation attempts to hold more than one active warm-pool slot."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="warm_pool_tenant_cap_exceeded")


class WarmPoolTransitionError(WarmPoolError):
    """Raised when an illegal slot state transition is attempted."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="warm_pool_invalid_transition")


@dataclass(frozen=True, slots=True)
class PoolWatermarks:
    """Capacity watermarks governing unattended Autopilot warm-pool sizing."""

    min_ready: int
    target_ready: int
    max_total: int

    def __post_init__(self) -> None:
        for name, val in (
            ("min_ready", self.min_ready),
            ("target_ready", self.target_ready),
            ("max_total", self.max_total),
        ):
            if type(val) is not int:
                raise TypeError(f"{name} must be int")
        if self.min_ready < 0:
            raise WarmPoolValidationError("min_ready must be >= 0", code="invalid_min_ready")
        if self.target_ready < self.min_ready:
            raise WarmPoolValidationError(
                "target_ready must be >= min_ready", code="invalid_target_ready"
            )
        if self.max_total < 1 or self.max_total < self.target_ready:
            raise WarmPoolValidationError(
                "max_total must be >= max(1, target_ready)", code="invalid_max_total"
            )


@dataclass(frozen=True, slots=True)
class WarmPoolSlot:
    slot_id: str
    sequence: int
    region: str
    profile_ref: str
    state: SlotState
    claimed_by_organisation_id: str | None = None
    checkout_id: str | None = None
    idempotency_key: str | None = None
    unhealthy_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PoolSizingSnapshot:
    region: str
    profile_ref: str
    provisioning_count: int
    ready_count: int
    claimed_count: int
    unhealthy_count: int
    evicted_count: int
    below_low_watermark: bool
    replenish_needed: int


@dataclass(frozen=True, slots=True)
class ClaimResult:
    slot: WarmPoolSlot
    replayed: bool
    replenish_needed: int
    below_low_watermark: bool


VALID_SLOT_TRANSITIONS: dict[SlotState, frozenset[SlotState]] = {
    "provisioning": frozenset({"ready", "unhealthy"}),
    "ready": frozenset({"claimed", "unhealthy"}),
    "claimed": frozenset({"unhealthy", "evicted"}),
    "unhealthy": frozenset({"evicted"}),
    "evicted": frozenset(),
}

_ALLOWED_SOURCES: dict[SlotState, frozenset[SlotState]] = {
    target: frozenset(
        src for src, allowed_targets in VALID_SLOT_TRANSITIONS.items() if target in allowed_targets
    )
    for target in ("provisioning", "ready", "claimed", "unhealthy", "evicted")
}


def _is_printable_ascii_key(value: str) -> bool:
    return 8 <= len(value) <= 255 and all(0x21 <= ord(ch) <= 0x7E for ch in value)


def _check_identifier(value: str, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 2 <= len(value) <= 128
        or any(ch not in _IDENTIFIER_CHARS for ch in value)
    ):
        raise WarmPoolValidationError(f"invalid {field}", code="invalid_identifier")
    return value


class WarmPoolController:
    """Deterministic, multi-worker safe warm-pool slot allocator and watermark controller."""

    def __init__(
        self,
        watermarks: PoolWatermarks,
        *,
        default_region: str = "fr-par",
        default_profile_ref: str = "espace-shared-v1",
        backend: StorageBackend = "auto",
        store: WarmPoolStore | None = None,
    ) -> None:
        if not isinstance(watermarks, PoolWatermarks):
            raise TypeError("watermarks must be a PoolWatermarks instance")
        self._watermarks = watermarks
        self._default_region = _check_identifier(default_region, "default_region")
        self._default_profile_ref = _check_identifier(default_profile_ref, "default_profile_ref")
        self._store: WarmPoolStore = store if store is not None else build_warm_pool_store(backend)

    @property
    def watermarks(self) -> PoolWatermarks:
        return self._watermarks

    def _snapshot_from_counts(
        self,
        *,
        region: str,
        profile_ref: str,
        counts: dict[SlotState, int],
    ) -> PoolSizingSnapshot:
        active_used = (
            counts["provisioning"] + counts["ready"] + counts["claimed"] + counts["unhealthy"]
        )
        warm_pipeline = counts["ready"] + counts["provisioning"]
        headroom = max(0, self._watermarks.max_total - active_used)
        desired = max(0, self._watermarks.target_ready - warm_pipeline)
        replenish_needed = min(desired, headroom)
        below_low = counts["ready"] < self._watermarks.min_ready
        return PoolSizingSnapshot(
            region=region,
            profile_ref=profile_ref,
            provisioning_count=counts["provisioning"],
            ready_count=counts["ready"],
            claimed_count=counts["claimed"],
            unhealthy_count=counts["unhealthy"],
            evicted_count=counts["evicted"],
            below_low_watermark=below_low,
            replenish_needed=replenish_needed,
        )

    def sizing_snapshot(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> PoolSizingSnapshot:
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")
        counts = self._store.counts_for_target(
            region=target_region,
            profile_ref=target_profile,
            authority=authority,
        )
        return self._snapshot_from_counts(
            region=target_region,
            profile_ref=target_profile,
            counts=counts,
        )

    def replenish(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        """Deterministically allocate `provisioning` slots up to `target_ready` within `max_total`."""
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")
        return self._store.replenish(
            region=target_region,
            profile_ref=target_profile,
            watermarks=self._watermarks,
            authority=authority,
        )

    def mark_ready(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        """Transition a `provisioning` slot to `ready`."""
        _check_identifier(slot_id, "slot_id")
        return self._store.transition_slot(
            slot_id,
            target_state="ready",
            allowed_from=_ALLOWED_SOURCES["ready"],
            authority=authority,
        )

    def mark_unhealthy(
        self,
        slot_id: str,
        *,
        reason: str,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        """Quarantine a `provisioning` or `ready` slot as `unhealthy` so checkout never claims it."""
        _check_identifier(slot_id, "slot_id")
        if not isinstance(reason, str) or not (1 <= len(reason.strip()) <= 200):
            raise WarmPoolValidationError(
                "unhealthy reason must be 1..200 chars", code="invalid_unhealthy_reason"
            )
        return self._store.transition_slot(
            slot_id,
            target_state="unhealthy",
            allowed_from=_ALLOWED_SOURCES["unhealthy"],
            unhealthy_reason=reason.strip(),
            authority=authority,
        )

    def evict_unhealthy(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        """Evict all `unhealthy` slots in deterministic sequence order, freeing pool ceiling."""
        target_region = None if region is None else _check_identifier(region, "region")
        target_profile = (
            None if profile_ref is None else _check_identifier(profile_ref, "profile_ref")
        )
        return self._store.evict_unhealthy(
            region=target_region,
            profile_ref=target_profile,
            authority=authority,
        )

    def release_slot(
        self,
        slot_id: str,
        *,
        reason: str = "claim_released",
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        """Release a `claimed` or `unhealthy` slot (`-> evicted`), freeing per-tenant and pool capacity."""
        _check_identifier(slot_id, "slot_id")
        if not isinstance(reason, str) or not (1 <= len(reason.strip()) <= 200):
            raise WarmPoolValidationError(
                "release reason must be 1..200 chars", code="invalid_release_reason"
            )
        return self._store.release_slot(
            slot_id,
            reason=reason.strip(),
            authority=authority,
        )

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str | None = None,
        profile_ref: str | None = None,
        authority: CallerAuthority | None = None,
    ) -> ClaimResult:
        """Atomically claim the oldest `ready` slot on checkout completion with idempotency."""
        if not isinstance(idempotency_key, str) or not _is_printable_ascii_key(idempotency_key):
            raise WarmPoolValidationError(
                "idempotency_key must be 8..255 printable ASCII chars",
                code="invalid_idempotency_key",
            )
        org_id = _check_identifier(organisation_id, "organisation_id")
        chk_id = _check_identifier(checkout_id, "checkout_id")
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")

        slot, replayed, counts = self._store.claim_slot(
            idempotency_key=idempotency_key,
            organisation_id=org_id,
            checkout_id=chk_id,
            region=target_region,
            profile_ref=target_profile,
            watermarks=self._watermarks,
            authority=authority,
        )
        snap = self._snapshot_from_counts(
            region=target_region,
            profile_ref=target_profile,
            counts=counts,
        )
        return ClaimResult(
            slot=slot,
            replayed=replayed,
            replenish_needed=snap.replenish_needed,
            below_low_watermark=snap.below_low_watermark,
        )

    def get_slot(
        self,
        slot_id: str,
        *,
        authority: CallerAuthority | None = None,
    ) -> WarmPoolSlot:
        _check_identifier(slot_id, "slot_id")
        return self._store.get_slot(slot_id, authority=authority)
