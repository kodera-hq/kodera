# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Multi-tenant Autopilot warm-pool controller.

Deterministic sizing, idempotent checkout claim, replenishment planning, and unhealthy slot
eviction for managed cloud tenants. Open-source request validation and instant-claim routing
remain in `apps/server/apps/workspaces/warm_pool.py`.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Literal

SlotState = Literal["provisioning", "ready", "claimed", "unhealthy", "evicted"]

IDEMPOTENCY_KEY_RE = re.compile(r"^[!-~]{8,255}\Z")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_.:-]{2,128}\Z")


class WarmPoolError(Exception):
    """Base error for warm-pool state machine violations."""


class WarmPoolValidationError(WarmPoolError):
    """Raised when watermarks, slot ids, or claim inputs are invalid."""


class WarmPoolExhaustedError(WarmPoolError):
    """Raised when no `ready` slot is available for a checkout claim."""

    def __init__(self, *, region: str, profile_ref: str, replenish_count: int) -> None:
        super().__init__(
            f"no ready warm-pool slot for region={region} profile={profile_ref}; "
            f"replenish_count={replenish_count}"
        )
        self.region = region
        self.profile_ref = profile_ref
        self.replenish_count = replenish_count


class WarmPoolIdempotencyConflictError(WarmPoolError):
    """Raised when an `idempotency_key` is reused with different checkout or org parameters."""


class WarmPoolTransitionError(WarmPoolError):
    """Raised when an illegal slot state transition is attempted."""


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
            raise WarmPoolValidationError("min_ready must be >= 0")
        if self.target_ready < self.min_ready:
            raise WarmPoolValidationError("target_ready must be >= min_ready")
        if self.max_total < 1 or self.max_total < self.target_ready:
            raise WarmPoolValidationError("max_total must be >= max(1, target_ready)")


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
    "claimed": frozenset(),
    "unhealthy": frozenset({"evicted"}),
    "evicted": frozenset(),
}


def _check_identifier(value: str, field: str) -> str:
    if not isinstance(value, str) or IDENTIFIER_RE.fullmatch(value) is None:
        raise WarmPoolValidationError(f"invalid {field}")
    return value


class WarmPoolController:
    """Deterministic, thread-safe warm-pool slot allocator and watermark controller."""

    def __init__(
        self,
        watermarks: PoolWatermarks,
        *,
        default_region: str = "fr-par",
        default_profile_ref: str = "espace-shared-v1",
    ) -> None:
        if not isinstance(watermarks, PoolWatermarks):
            raise TypeError("watermarks must be a PoolWatermarks instance")
        self._watermarks = watermarks
        self._default_region = _check_identifier(default_region, "default_region")
        self._default_profile_ref = _check_identifier(default_profile_ref, "default_profile_ref")
        self._lock = threading.RLock()
        self._seq = 0
        self._slots: dict[str, WarmPoolSlot] = {}
        self._claims_by_key: dict[str, str] = {}

    @property
    def watermarks(self) -> PoolWatermarks:
        return self._watermarks

    def _active_capacity_used(self, region: str, profile_ref: str) -> int:
        """Slots occupying pool capacity (`provisioning`, `ready`, `claimed`, `unhealthy`).

        Evicted slots release their capacity ceiling; claimed slots occupy managed fleet capacity
        until decommissioned or expanded via `max_total`.
        """
        return sum(
            1
            for s in self._slots.values()
            if s.region == region and s.profile_ref == profile_ref and s.state != "evicted"
        )

    def sizing_snapshot(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
    ) -> PoolSizingSnapshot:
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")
        with self._lock:
            matching = [
                s
                for s in self._slots.values()
                if s.region == target_region and s.profile_ref == target_profile
            ]
            counts: dict[SlotState, int] = {
                "provisioning": 0,
                "ready": 0,
                "claimed": 0,
                "unhealthy": 0,
                "evicted": 0,
            }
            for slot in matching:
                counts[slot.state] += 1

            warm_pipeline = counts["ready"] + counts["provisioning"]
            headroom = max(
                0,
                self._watermarks.max_total
                - self._active_capacity_used(target_region, target_profile),
            )
            desired = max(0, self._watermarks.target_ready - warm_pipeline)
            replenish_needed = min(desired, headroom)
            below_low = counts["ready"] < self._watermarks.min_ready

            return PoolSizingSnapshot(
                region=target_region,
                profile_ref=target_profile,
                provisioning_count=counts["provisioning"],
                ready_count=counts["ready"],
                claimed_count=counts["claimed"],
                unhealthy_count=counts["unhealthy"],
                evicted_count=counts["evicted"],
                below_low_watermark=below_low,
                replenish_needed=replenish_needed,
            )

    def replenish(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        """Deterministically allocate `provisioning` slots up to `target_ready` within `max_total`."""
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")
        with self._lock:
            snap = self.sizing_snapshot(region=target_region, profile_ref=target_profile)
            created: list[WarmPoolSlot] = []
            for _ in range(snap.replenish_needed):
                self._seq += 1
                slot_id = f"wps-{target_region}-{self._seq:06d}"
                slot = WarmPoolSlot(
                    slot_id=slot_id,
                    sequence=self._seq,
                    region=target_region,
                    profile_ref=target_profile,
                    state="provisioning",
                )
                self._slots[slot_id] = slot
                created.append(slot)
            return tuple(created)

    def mark_ready(self, slot_id: str) -> WarmPoolSlot:
        """Transition a `provisioning` slot to `ready`."""
        _check_identifier(slot_id, "slot_id")
        with self._lock:
            current = self._get_slot(slot_id)
            self._require_transition(current.state, "ready")
            updated = WarmPoolSlot(
                slot_id=current.slot_id,
                sequence=current.sequence,
                region=current.region,
                profile_ref=current.profile_ref,
                state="ready",
            )
            self._slots[slot_id] = updated
            return updated

    def mark_unhealthy(self, slot_id: str, *, reason: str) -> WarmPoolSlot:
        """Quarantine a `provisioning` or `ready` slot as `unhealthy` so checkout never claims it."""
        _check_identifier(slot_id, "slot_id")
        if not isinstance(reason, str) or not (1 <= len(reason.strip()) <= 200):
            raise WarmPoolValidationError("unhealthy reason must be 1..200 chars")
        with self._lock:
            current = self._get_slot(slot_id)
            self._require_transition(current.state, "unhealthy")
            updated = WarmPoolSlot(
                slot_id=current.slot_id,
                sequence=current.sequence,
                region=current.region,
                profile_ref=current.profile_ref,
                state="unhealthy",
                unhealthy_reason=reason.strip(),
            )
            self._slots[slot_id] = updated
            return updated

    def evict_unhealthy(
        self,
        *,
        region: str | None = None,
        profile_ref: str | None = None,
    ) -> tuple[WarmPoolSlot, ...]:
        """Evict all `unhealthy` slots in deterministic sequence order, freeing pool ceiling."""
        target_region = None if region is None else _check_identifier(region, "region")
        target_profile = (
            None if profile_ref is None else _check_identifier(profile_ref, "profile_ref")
        )
        with self._lock:
            candidates = sorted(
                (
                    s
                    for s in self._slots.values()
                    if s.state == "unhealthy"
                    and (target_region is None or s.region == target_region)
                    and (target_profile is None or s.profile_ref == target_profile)
                ),
                key=lambda s: s.sequence,
            )
            evicted: list[WarmPoolSlot] = []
            for slot in candidates:
                self._require_transition(slot.state, "evicted")
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

    def claim_slot(
        self,
        *,
        idempotency_key: str,
        organisation_id: str,
        checkout_id: str,
        region: str | None = None,
        profile_ref: str | None = None,
    ) -> ClaimResult:
        """Atomically claim the oldest `ready` slot on checkout completion with idempotency."""
        if (
            not isinstance(idempotency_key, str)
            or IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key) is None
        ):
            raise WarmPoolValidationError("idempotency_key must be 8..255 printable ASCII chars")
        org_id = _check_identifier(organisation_id, "organisation_id")
        chk_id = _check_identifier(checkout_id, "checkout_id")
        target_region = _check_identifier(region or self._default_region, "region")
        target_profile = _check_identifier(profile_ref or self._default_profile_ref, "profile_ref")

        with self._lock:
            existing_slot_id = self._claims_by_key.get(idempotency_key)
            if existing_slot_id is not None:
                existing = self._slots[existing_slot_id]
                if (
                    existing.claimed_by_organisation_id != org_id
                    or existing.checkout_id != chk_id
                    or existing.region != target_region
                    or existing.profile_ref != target_profile
                ):
                    raise WarmPoolIdempotencyConflictError(
                        "idempotency_key already bound to a different warm-pool claim"
                    )
                snap = self.sizing_snapshot(region=target_region, profile_ref=target_profile)
                return ClaimResult(
                    slot=existing,
                    replayed=True,
                    replenish_needed=snap.replenish_needed,
                    below_low_watermark=snap.below_low_watermark,
                )

            ready_slots = sorted(
                (
                    s
                    for s in self._slots.values()
                    if s.state == "ready"
                    and s.region == target_region
                    and s.profile_ref == target_profile
                ),
                key=lambda s: s.sequence,
            )
            if not ready_slots:
                snap = self.sizing_snapshot(region=target_region, profile_ref=target_profile)
                raise WarmPoolExhaustedError(
                    region=target_region,
                    profile_ref=target_profile,
                    replenish_count=snap.replenish_needed,
                )

            chosen = ready_slots[0]
            self._require_transition(chosen.state, "claimed")
            claimed = WarmPoolSlot(
                slot_id=chosen.slot_id,
                sequence=chosen.sequence,
                region=chosen.region,
                profile_ref=chosen.profile_ref,
                state="claimed",
                claimed_by_organisation_id=org_id,
                checkout_id=chk_id,
                idempotency_key=idempotency_key,
            )
            self._slots[chosen.slot_id] = claimed
            self._claims_by_key[idempotency_key] = chosen.slot_id
            snap = self.sizing_snapshot(region=target_region, profile_ref=target_profile)
            return ClaimResult(
                slot=claimed,
                replayed=False,
                replenish_needed=snap.replenish_needed,
                below_low_watermark=snap.below_low_watermark,
            )

    def get_slot(self, slot_id: str) -> WarmPoolSlot:
        with self._lock:
            return self._get_slot(slot_id)

    def _get_slot(self, slot_id: str) -> WarmPoolSlot:
        slot = self._slots.get(slot_id)
        if slot is None:
            raise WarmPoolValidationError(f"unknown slot_id: {slot_id}")
        return slot

    @staticmethod
    def _require_transition(current: SlotState, target: SlotState) -> None:
        if target not in VALID_SLOT_TRANSITIONS[current]:
            raise WarmPoolTransitionError(f"invalid slot transition {current} -> {target}")
