"""Zero-PII sovereign booking availability calculator and SHA-256 cancellation tokens."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time as dt_time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ALLOWED_BOOKING_DURATIONS = frozenset({15, 30, 45, 60})
MAX_BUFFER_MINUTES = 120
MAX_WINDOWS = 28
MAX_HORIZON_DAYS = 31
MAX_SLOTS_RETURNED = 400
SLUG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])\Z")
HHMM_RE = re.compile(r"([01]\d|2[0-3]):([0-5]\d)\Z")


class BookingValidationError(ValueError):
    """Booking page configuration or slot reservation input is invalid."""


@dataclass(frozen=True)
class AvailabilityWindow:
    weekday: int  # 0 = Monday .. 6 = Sunday
    start_minute: int  # minutes since 00:00 local
    end_minute: int  # minutes since 00:00 local (1..1440)

    def to_dict(self) -> dict[str, object]:
        sh, sm = divmod(self.start_minute, 60)
        eh, em = divmod(self.end_minute, 60)
        end_str = "24:00" if self.end_minute == 1440 else f"{eh:02d}:{em:02d}"
        return {
            "weekday": self.weekday,
            "start": f"{sh:02d}:{sm:02d}",
            "end": end_str,
        }


@dataclass(frozen=True)
class PublicAvailableSlot:
    starts_at: datetime
    ends_at: datetime


def _parse_hhmm(raw: str, *, allow_2400: bool = False) -> int:
    if allow_2400 and raw == "24:00":
        return 1440
    match = HHMM_RE.fullmatch(raw)
    if match is None:
        raise BookingValidationError("availability window times must use HH:MM (24-hour)")
    return int(match.group(1)) * 60 + int(match.group(2))


def validate_booking_slug(slug: str) -> str:
    if not isinstance(slug, str) or SLUG_RE.fullmatch(slug) is None:
        raise BookingValidationError(
            "booking slug must be 3..80 lowercase alphanumeric or hyphen characters"
        )
    return slug


def validate_duration_and_buffer(*, duration_minutes: int, buffer_minutes: int) -> None:
    if (
        isinstance(duration_minutes, bool)
        or not isinstance(duration_minutes, int)
        or duration_minutes not in ALLOWED_BOOKING_DURATIONS
    ):
        raise BookingValidationError("duration_minutes must be one of 15, 30, 45, or 60")
    if (
        isinstance(buffer_minutes, bool)
        or not isinstance(buffer_minutes, int)
        or not 0 <= buffer_minutes <= MAX_BUFFER_MINUTES
    ):
        raise BookingValidationError("buffer_minutes must be between 0 and 120")


def parse_availability_windows(raw_windows: Any) -> tuple[AvailabilityWindow, ...]:
    if not isinstance(raw_windows, list) or not 1 <= len(raw_windows) <= MAX_WINDOWS:
        raise BookingValidationError("availability_windows must be a non-empty list (max 28)")
    parsed: list[AvailabilityWindow] = []
    by_day: dict[int, list[tuple[int, int]]] = {}
    for item in raw_windows:
        if not isinstance(item, dict) or set(item) != {"weekday", "start", "end"}:
            raise BookingValidationError(
                "each availability window must contain exact keys weekday, start, end"
            )
        wd = item["weekday"]
        if isinstance(wd, bool) or not isinstance(wd, int) or not 0 <= wd <= 6:
            raise BookingValidationError("weekday must be an integer 0 (Monday) through 6 (Sunday)")
        if not isinstance(item["start"], str) or not isinstance(item["end"], str):
            raise BookingValidationError("window start and end must be HH:MM strings")
        start_min = _parse_hhmm(item["start"], allow_2400=False)
        end_min = _parse_hhmm(item["end"], allow_2400=True)
        if end_min <= start_min:
            raise BookingValidationError("window end must be strictly after start")
        for prev_s, prev_e in by_day.get(wd, ()):
            if start_min < prev_e and end_min > prev_s:
                raise BookingValidationError("overlapping availability windows on same weekday")
        by_day.setdefault(wd, []).append((start_min, end_min))
        parsed.append(AvailabilityWindow(weekday=wd, start_minute=start_min, end_minute=end_min))
    parsed.sort(key=lambda w: (w.weekday, w.start_minute))
    return tuple(parsed)


def validate_timezone(tz_name: str) -> ZoneInfo:
    if not isinstance(tz_name, str) or not 1 <= len(tz_name) <= 64:
        raise BookingValidationError("invalid timezone")
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise BookingValidationError("unknown IANA timezone") from exc


def _merge_intervals(
    intervals: Sequence[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    cleaned = sorted((s.astimezone(UTC), e.astimezone(UTC)) for s, e in intervals if e > s)
    if not cleaned:
        return []
    merged: list[tuple[datetime, datetime]] = [cleaned[0]]
    for start, end in cleaned[1:]:
        last_s, last_e = merged[-1]
        if start <= last_e:
            merged[-1] = (last_s, max(last_e, end))
        else:
            merged.append((start, end))
    return merged


def compute_available_slots(
    *,
    availability_windows: Sequence[AvailabilityWindow],
    timezone: str,
    duration_minutes: int,
    buffer_minutes: int,
    range_start: datetime,
    range_end: datetime,
    busy_intervals: Sequence[tuple[datetime, datetime]],
    now: datetime | None = None,
) -> tuple[PublicAvailableSlot, ...]:
    """Compute public bookable slots while subtracting busy intervals + buffers without leaking PII."""
    validate_duration_and_buffer(
        duration_minutes=duration_minutes,
        buffer_minutes=buffer_minutes,
    )
    zone = validate_timezone(timezone)
    if range_start.tzinfo is None or range_end.tzinfo is None:
        raise BookingValidationError("range_start and range_end must be timezone-aware")

    start_utc = range_start.astimezone(UTC)
    end_utc = range_end.astimezone(UTC)
    if end_utc <= start_utc or (end_utc - start_utc) > timedelta(days=MAX_HORIZON_DAYS):
        raise BookingValidationError(
            f"availability query range must be > 0 and <= {MAX_HORIZON_DAYS} days"
        )

    effective_now = now.astimezone(UTC) if now is not None else datetime.now(tz=UTC)
    earliest_allowed = max(start_utc, effective_now)

    duration_delta = timedelta(minutes=duration_minutes)
    buffer_delta = timedelta(minutes=buffer_minutes)
    # Expand each busy interval by buffer_delta on both sides: any candidate slot [s, s + D]
    # overlaps [b_s - B, b_e + B] iff s < b_e + B and s + D > b_s - B.
    expanded_busy = _merge_intervals(
        [
            (b_s.astimezone(UTC) - buffer_delta, b_e.astimezone(UTC) + buffer_delta)
            for b_s, b_e in busy_intervals
            if b_e > b_s
        ]
    )

    windows_by_day: dict[int, list[AvailabilityWindow]] = {}
    for win in availability_windows:
        windows_by_day.setdefault(win.weekday, []).append(win)

    local_day = start_utc.astimezone(zone).date() - timedelta(days=1)
    local_last_day = end_utc.astimezone(zone).date() + timedelta(days=1)

    slots: list[PublicAvailableSlot] = []
    step_minutes = duration_minutes

    while local_day <= local_last_day and len(slots) < MAX_SLOTS_RETURNED:
        day_windows = windows_by_day.get(local_day.weekday(), ())
        for win in day_windows:
            cursor_min = win.start_minute
            while cursor_min + duration_minutes <= win.end_minute:
                sh, sm = divmod(cursor_min, 60)
                local_slot_start = datetime.combine(local_day, dt_time(sh, sm), tzinfo=zone)
                slot_start_utc = local_slot_start.astimezone(UTC)
                slot_end_utc = slot_start_utc + duration_delta

                if slot_start_utc >= earliest_allowed and slot_end_utc <= end_utc:
                    conflict = any(
                        slot_start_utc < busy_e and slot_end_utc > busy_s
                        for busy_s, busy_e in expanded_busy
                    )
                    if not conflict:
                        slots.append(
                            PublicAvailableSlot(
                                starts_at=slot_start_utc,
                                ends_at=slot_end_utc,
                            )
                        )
                        if len(slots) >= MAX_SLOTS_RETURNED:
                            break
                cursor_min += step_minutes
            if len(slots) >= MAX_SLOTS_RETURNED:
                break
        local_day += timedelta(days=1)

    return tuple(slots)


def slot_matches_availability(
    *,
    availability_windows: Sequence[AvailabilityWindow],
    timezone: str,
    duration_minutes: int,
    buffer_minutes: int,
    starts_at: datetime,
    ends_at: datetime,
    busy_intervals: Sequence[tuple[datetime, datetime]],
    now: datetime,
) -> bool:
    """Verify that an exact requested [starts_at, ends_at] is an admissible free slot."""
    start_utc = starts_at.astimezone(UTC)
    end_utc = ends_at.astimezone(UTC)
    if end_utc - start_utc != timedelta(minutes=duration_minutes):
        return False
    if start_utc < now.astimezone(UTC):
        return False
    available = compute_available_slots(
        availability_windows=availability_windows,
        timezone=timezone,
        duration_minutes=duration_minutes,
        buffer_minutes=buffer_minutes,
        range_start=start_utc - timedelta(minutes=1),
        range_end=end_utc + timedelta(minutes=1),
        busy_intervals=busy_intervals,
        now=now,
    )
    return any(s.starts_at == start_utc and s.ends_at == end_utc for s in available)


def issue_cancellation_token() -> tuple[str, bytes]:
    """Generate a high-entropy single-disclosure cancellation token and its SHA-256 digest."""
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode("ascii")).digest()
    return token, digest


def verify_cancellation_token(token: str, stored_sha256: bytes) -> bool:
    if (
        not isinstance(token, str)
        or not 16 <= len(token) <= 128
        or any(ord(c) <= 32 or ord(c) >= 127 for c in token)
        or not isinstance(stored_sha256, bytes | memoryview)
        or len(stored_sha256) != 32
    ):
        return False
    candidate = hashlib.sha256(token.encode("ascii")).digest()
    return hmac.compare_digest(candidate, bytes(stored_sha256))
