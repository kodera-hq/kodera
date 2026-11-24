"""Pure-Python RFC 5545 iCalendar (.ics) serializer, 75-octet folder, and strict bounded parser."""

from __future__ import annotations

import calendar as py_calendar
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_ICS_BYTES = 512 * 1024
MAX_ICS_LINES = 10_000
MAX_ICS_UNFOLDED_LINE_BYTES = 16_384
MAX_ICS_EVENTS = 500
MAX_OCCURRENCE_EXPANSIONS = 366
MAX_RRULE_ITERATIONS = 2_000
PRODID = "-//Kodera//Sovereign Smart Calendar//EN"

TOKEN_NAME_RE = re.compile(r"[A-Za-z0-9-]{1,64}\Z")
UID_SAFE_RE = re.compile(r"[\x21-\x7e]{1,255}\Z")
EMAIL_SAFE_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z")
ALLOWED_FREQS = frozenset({"DAILY", "WEEKLY", "MONTHLY"})
ALLOWED_WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
WEEKDAY_TO_INDEX = {code: idx for idx, code in enumerate(ALLOWED_WEEKDAYS)}
ALLOWED_METHODS = frozenset({"PUBLISH", "REQUEST", "CANCEL"})
ALLOWED_STATUSES = frozenset({"CONFIRMED", "TENTATIVE", "CANCELLED"})
ALLOWED_CLASSES = frozenset({"PUBLIC", "PRIVATE", "CONFIDENTIAL"})
ALLOWED_TRANSP = frozenset({"OPAQUE", "TRANSPARENT"})
ALLOWED_PARTSTATS = frozenset({"NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE"})
ALLOWED_ROLES = frozenset({"REQ-PARTICIPANT", "OPT-PARTICIPANT", "CHAIR", "NON-PARTICIPANT"})


class IcsFormatError(ValueError):
    """Input violates RFC 5545 framing, byte bounds, or injection safety."""


@dataclass(frozen=True)
class IcsAttendee:
    email: str
    name: str = ""
    partstat: str = "NEEDS-ACTION"
    role: str = "REQ-PARTICIPANT"


@dataclass(frozen=True)
class IcsAlarm:
    minutes_before: int
    description: str = "Reminder"


@dataclass(frozen=True)
class ParsedRRule:
    freq: str
    interval: int = 1
    count: int | None = None
    until: datetime | None = None
    byday: tuple[str, ...] = ()
    bymonthday: tuple[int, ...] = ()


@dataclass(frozen=True)
class IcsEvent:
    uid: str
    dtstamp: datetime
    dtstart: datetime
    dtend: datetime
    summary: str
    description: str = ""
    location: str = ""
    status: str = "CONFIRMED"
    classification: str = "PUBLIC"
    transp: str = "OPAQUE"
    sequence: int = 0
    timezone: str = "UTC"
    organizer_email: str = ""
    organizer_name: str = ""
    rrule: str = ""
    attendees: tuple[IcsAttendee, ...] = ()
    alarms: tuple[IcsAlarm, ...] = ()
    visio_url: str = ""
    agenda_doc_url: str = ""


@dataclass(frozen=True)
class IcsFreeBusyPeriod:
    starts_at: datetime
    ends_at: datetime


@dataclass(frozen=True)
class IcsFreeBusy:
    uid: str
    dtstamp: datetime
    dtstart: datetime
    dtend: datetime
    organizer_email: str = ""
    busy_periods: tuple[IcsFreeBusyPeriod, ...] = ()


@dataclass(frozen=True)
class ParsedCalendar:
    version: str
    prodid: str
    method: str
    events: tuple[IcsEvent, ...]
    freebusy: tuple[IcsFreeBusy, ...]


def _reject_control_chars(value: str, *, allow_lf: bool = False) -> None:
    if not isinstance(value, str):
        raise IcsFormatError("expected string value")
    for ch in value:
        code = ord(ch)
        if code == 0x7F or (code < 0x20 and not (allow_lf and ch == "\n")):
            raise IcsFormatError("control characters are forbidden in iCalendar values")


def _validate_https_url(url: str, *, field_name: str) -> str:
    if not url:
        return ""
    _reject_control_chars(url, allow_lf=False)
    if len(url) > 2048 or any(ch.isspace() for ch in url):
        raise IcsFormatError(f"{field_name} exceeds bounds or contains whitespace")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise IcsFormatError(f"{field_name} must be an HTTPS URL without credentials")
    return url


def _validate_email(email: str) -> str:
    _reject_control_chars(email, allow_lf=False)
    cleaned = email.strip()
    if len(cleaned) > 254 or EMAIL_SAFE_RE.fullmatch(cleaned) is None:
        raise IcsFormatError("invalid attendee or organizer email")
    return cleaned


def _validate_tzid(tzid: str) -> str:
    _reject_control_chars(tzid, allow_lf=False)
    if not tzid or len(tzid) > 64 or any(ch in tzid for ch in (";", ":", '"', ",", "\\", " ")):
        raise IcsFormatError("invalid timezone identifier")
    if tzid == "UTC":
        return "UTC"
    try:
        ZoneInfo(tzid)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise IcsFormatError("unknown IANA timezone identifier") from exc
    return tzid


def _ensure_utc(dt: datetime) -> datetime:
    if not isinstance(dt, datetime) or dt.tzinfo is None or dt.utcoffset() is None:
        raise IcsFormatError("timezone-aware datetime required")
    return dt.astimezone(UTC)


def format_utc_datetime(dt: datetime) -> str:
    utc = _ensure_utc(dt)
    return utc.strftime("%Y%m%dT%H%M%SZ")


def parse_ics_datetime(raw: str, tzid: str | None = None) -> datetime:
    _reject_control_chars(raw, allow_lf=False)
    text = raw.strip()
    if re.fullmatch(r"\d{8}T\d{6}Z", text):
        if tzid is not None:
            raise IcsFormatError("UTC Z suffix cannot be combined with TZID parameter")
        try:
            return datetime.strptime(text, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError as exc:
            raise IcsFormatError("invalid UTC datetime") from exc
    if re.fullmatch(r"\d{8}T\d{6}", text):
        zone = UTC if not tzid or tzid == "UTC" else ZoneInfo(_validate_tzid(tzid))
        try:
            naive = datetime.strptime(text, "%Y%m%dT%H%M%S")
        except ValueError as exc:
            raise IcsFormatError("invalid local datetime") from exc
        return naive.replace(tzinfo=zone).astimezone(UTC)
    if re.fullmatch(r"\d{8}", text):
        zone = UTC if not tzid or tzid == "UTC" else ZoneInfo(_validate_tzid(tzid))
        try:
            naive = datetime.strptime(text, "%Y%m%d")
        except ValueError as exc:
            raise IcsFormatError("invalid date value") from exc
        return naive.replace(tzinfo=zone).astimezone(UTC)
    raise IcsFormatError("unsupported iCalendar datetime representation")


def escape_ics_text(value: str) -> str:
    if not isinstance(value, str):
        raise IcsFormatError("expected text string")
    normalized = value.replace("\r\n", "\n")
    _reject_control_chars(normalized, allow_lf=True)
    return (
        normalized.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def unescape_ics_text(value: str) -> str:
    _reject_control_chars(value, allow_lf=False)
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        ch = value[i]
        if ch == "\\":
            if i + 1 >= n:
                raise IcsFormatError("dangling escape sequence in TEXT value")
            nxt = value[i + 1]
            if nxt in ("n", "N"):
                out.append("\n")
            elif nxt in ("\\", ";", ","):
                out.append(nxt)
            else:
                raise IcsFormatError("unsupported escape sequence in TEXT value")
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _format_param_value(raw: str) -> str:
    _reject_control_chars(raw, allow_lf=False)
    encoded = raw.replace("^", "^^").replace('"', "^'")
    if any(ch in encoded for ch in (";", ":", ",", "^")):
        return f'"{encoded}"'
    return encoded


def _decode_param_value(raw: str) -> str:
    out: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        ch = raw[i]
        if ch == "^" and i + 1 < n:
            nxt = raw[i + 1]
            if nxt == "^":
                out.append("^")
                i += 2
                continue
            if nxt == "'":
                out.append('"')
                i += 2
                continue
            if nxt in {"n", "N"}:
                out.append(" ")
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def fold_content_line(line: str) -> str:
    """Fold a single content line at <= 75 UTF-8 octets per physical line using CRLF + SPACE."""
    _reject_control_chars(line, allow_lf=False)
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line + "\r\n"
    chunks: list[str] = []
    current = bytearray()
    limit = 75
    for ch in line:
        encoded = ch.encode("utf-8")
        if len(current) + len(encoded) > limit:
            chunks.append(current.decode("utf-8"))
            current = bytearray(b" ")
            limit = 75
        current.extend(encoded)
    if current:
        chunks.append(current.decode("utf-8"))
    return "\r\n".join(chunks) + "\r\n"


def _property_line(
    name: str,
    value: str,
    params: Sequence[tuple[str, str]] = (),
    *,
    escape_text: bool = False,
) -> str:
    if TOKEN_NAME_RE.fullmatch(name) is None:
        raise IcsFormatError("invalid property name")
    param_suffix = ""
    for p_key, p_val in params:
        if TOKEN_NAME_RE.fullmatch(p_key) is None:
            raise IcsFormatError("invalid parameter name")
        param_suffix += f";{p_key.upper()}={_format_param_value(p_val)}"
    rendered_val = escape_ics_text(value) if escape_text else value
    if not escape_text:
        _reject_control_chars(rendered_val, allow_lf=False)
    return fold_content_line(f"{name.upper()}{param_suffix}:{rendered_val}")


def parse_rrule(rrule: str) -> ParsedRRule:
    _reject_control_chars(rrule, allow_lf=False)
    cleaned = rrule.strip()
    if cleaned.upper().startswith("RRULE:"):
        cleaned = cleaned[6:].strip()
    if not cleaned or len(cleaned) > 512:
        raise IcsFormatError("invalid RRULE length")
    parts: dict[str, str] = {}
    for segment in cleaned.split(";"):
        if "=" not in segment:
            raise IcsFormatError("malformed RRULE segment")
        key, val = segment.split("=", 1)
        upper_key = key.strip().upper()
        if not upper_key or upper_key in parts or not val.strip():
            raise IcsFormatError("duplicate or empty RRULE key")
        parts[upper_key] = val.strip().upper()

    allowed_keys = {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"}
    if not set(parts).issubset(allowed_keys):
        raise IcsFormatError("unsupported RRULE rule part")

    freq = parts.get("FREQ", "")
    if freq not in ALLOWED_FREQS:
        raise IcsFormatError("RRULE FREQ must be DAILY, WEEKLY, or MONTHLY")

    interval = 1
    if "INTERVAL" in parts:
        if not parts["INTERVAL"].isdigit():
            raise IcsFormatError("RRULE INTERVAL must be a positive integer")
        interval = int(parts["INTERVAL"])
        if not 1 <= interval <= 366:
            raise IcsFormatError("RRULE INTERVAL out of range")

    if "COUNT" in parts and "UNTIL" in parts:
        raise IcsFormatError("RRULE cannot specify both COUNT and UNTIL")

    count: int | None = None
    if "COUNT" in parts:
        if not parts["COUNT"].isdigit():
            raise IcsFormatError("RRULE COUNT must be a positive integer")
        count = int(parts["COUNT"])
        if not 1 <= count <= MAX_OCCURRENCE_EXPANSIONS:
            raise IcsFormatError("RRULE COUNT out of range")

    until: datetime | None = None
    if "UNTIL" in parts:
        until = parse_ics_datetime(parts["UNTIL"])

    byday: tuple[str, ...] = ()
    if "BYDAY" in parts:
        days = tuple(item.strip() for item in parts["BYDAY"].split(",") if item.strip())
        if (
            not days
            or any(day not in WEEKDAY_TO_INDEX for day in days)
            or len(set(days)) != len(days)
        ):
            raise IcsFormatError("RRULE BYDAY must list distinct MO..SU weekday codes")
        byday = days

    bymonthday: tuple[int, ...] = ()
    if "BYMONTHDAY" in parts:
        raw_days = [item.strip() for item in parts["BYMONTHDAY"].split(",") if item.strip()]
        if not raw_days or any(not item.isdigit() for item in raw_days):
            raise IcsFormatError("RRULE BYMONTHDAY must list positive month days")
        parsed_days = tuple(int(item) for item in raw_days)
        if any(not 1 <= d <= 31 for d in parsed_days) or len(set(parsed_days)) != len(parsed_days):
            raise IcsFormatError("RRULE BYMONTHDAY out of range")
        bymonthday = parsed_days

    if "WKST" in parts and parts["WKST"] not in WEEKDAY_TO_INDEX:
        raise IcsFormatError("invalid RRULE WKST")

    return ParsedRRule(
        freq=freq,
        interval=interval,
        count=count,
        until=until,
        byday=byday,
        bymonthday=bymonthday,
    )


def canonicalize_rrule(rrule: str) -> str:
    if not rrule.strip():
        return ""
    parsed = parse_rrule(rrule)
    segments = [f"FREQ={parsed.freq}"]
    if parsed.interval != 1:
        segments.append(f"INTERVAL={parsed.interval}")
    if parsed.count is not None:
        segments.append(f"COUNT={parsed.count}")
    if parsed.until is not None:
        segments.append(f"UNTIL={format_utc_datetime(parsed.until)}")
    if parsed.byday:
        segments.append(f"BYDAY={','.join(parsed.byday)}")
    if parsed.bymonthday:
        segments.append(f"BYMONTHDAY={','.join(str(d) for d in parsed.bymonthday)}")
    return ";".join(segments)


def expand_event_occurrences(
    *,
    starts_at: datetime,
    ends_at: datetime,
    rrule: str = "",
    timezone: str = "UTC",
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """Expand an event (and optional DAILY/WEEKLY/MONTHLY RRULE) within [window_start, window_end)."""
    start_utc = _ensure_utc(starts_at)
    end_utc = _ensure_utc(ends_at)
    win_start = _ensure_utc(window_start)
    win_end = _ensure_utc(window_end)
    if end_utc <= start_utc or win_end <= win_start:
        return []
    duration = end_utc - start_utc

    if not rrule.strip():
        if start_utc < win_end and end_utc > win_start:
            return [(start_utc, end_utc)]
        return []

    rule = parse_rrule(rrule)
    zone = UTC if timezone == "UTC" else ZoneInfo(_validate_tzid(timezone))
    local_anchor = start_utc.astimezone(zone)

    results: list[tuple[datetime, datetime]] = []
    emitted_total = 0
    iterations = 0

    def maybe_emit(local_dt: datetime) -> bool:
        nonlocal emitted_total
        occ_start = local_dt.astimezone(UTC)
        if occ_start < start_utc:
            return True
        if rule.until is not None and occ_start > rule.until:
            return False
        emitted_total += 1
        occ_end = occ_start + duration
        if occ_start < win_end and occ_end > win_start:
            results.append((occ_start, occ_end))
        if rule.count is not None and emitted_total >= rule.count:
            return False
        if occ_start >= win_end or len(results) >= MAX_OCCURRENCE_EXPANSIONS:
            return False
        return True

    if rule.freq == "DAILY":
        cursor_date = local_anchor.date()
        while iterations < MAX_RRULE_ITERATIONS:
            iterations += 1
            if rule.byday and ALLOWED_WEEKDAYS[cursor_date.weekday()] not in rule.byday:
                cursor_date += timedelta(days=rule.interval)
                continue
            cand = datetime.combine(cursor_date, local_anchor.timetz()).replace(tzinfo=zone)
            if not maybe_emit(cand):
                break
            cursor_date += timedelta(days=rule.interval)
    elif rule.freq == "WEEKLY":
        target_weekdays = (
            sorted(WEEKDAY_TO_INDEX[code] for code in rule.byday)
            if rule.byday
            else [local_anchor.weekday()]
        )
        week_monday = local_anchor.date() - timedelta(days=local_anchor.weekday())
        while iterations < MAX_RRULE_ITERATIONS:
            iterations += 1
            stop = False
            for wd in target_weekdays:
                day = week_monday + timedelta(days=wd)
                if day < local_anchor.date():
                    continue
                cand = datetime.combine(day, local_anchor.timetz()).replace(tzinfo=zone)
                if not maybe_emit(cand):
                    stop = True
                    break
            if stop:
                break
            week_monday += timedelta(days=7 * rule.interval)
    elif rule.freq == "MONTHLY":
        target_days = sorted(rule.bymonthday) if rule.bymonthday else [local_anchor.day]
        year = local_anchor.year
        month = local_anchor.month
        while iterations < MAX_RRULE_ITERATIONS:
            iterations += 1
            _, max_day = py_calendar.monthrange(year, month)
            stop = False
            for dom in target_days:
                if dom > max_day:
                    continue
                day = local_anchor.date().replace(year=year, month=month, day=dom)
                if day < local_anchor.date():
                    continue
                cand = datetime.combine(day, local_anchor.timetz()).replace(tzinfo=zone)
                if not maybe_emit(cand):
                    stop = True
                    break
            if stop:
                break
            month_index = (year * 12 + (month - 1)) + rule.interval
            year, month = divmod(month_index, 12)
            month += 1

    return results


def serialize_calendar(
    *,
    events: Sequence[IcsEvent] = (),
    freebusy: Sequence[IcsFreeBusy] = (),
    method: str = "PUBLISH",
) -> str:
    upper_method = method.strip().upper()
    if upper_method not in ALLOWED_METHODS:
        raise IcsFormatError("invalid VCALENDAR METHOD")
    if not events and not freebusy:
        raise IcsFormatError("VCALENDAR requires at least one VEVENT or VFREEBUSY component")

    lines: list[str] = [
        _property_line("BEGIN", "VCALENDAR"),
        _property_line("VERSION", "2.0"),
        _property_line("PRODID", PRODID),
        _property_line("CALSCALE", "GREGORIAN"),
        _property_line("METHOD", upper_method),
    ]

    for ev in events:
        _reject_control_chars(ev.uid, allow_lf=False)
        if UID_SAFE_RE.fullmatch(ev.uid) is None or ";" in ev.uid:
            raise IcsFormatError("invalid VEVENT UID")
        if ev.dtend <= ev.dtstart:
            raise IcsFormatError("VEVENT dtend must be strictly after dtstart")
        status = ev.status.strip().upper()
        if status not in ALLOWED_STATUSES:
            raise IcsFormatError("invalid VEVENT STATUS")
        classification = ev.classification.strip().upper()
        if classification not in ALLOWED_CLASSES:
            raise IcsFormatError("invalid VEVENT CLASS")
        transp = ev.transp.strip().upper()
        if transp not in ALLOWED_TRANSP:
            raise IcsFormatError("invalid VEVENT TRANSP")
        if not isinstance(ev.sequence, int) or ev.sequence < 0:
            raise IcsFormatError("invalid VEVENT SEQUENCE")
        if not ev.summary or len(ev.summary) > 255:
            raise IcsFormatError("VEVENT SUMMARY must be 1..255 characters")
        if len(ev.description) > 8192 or len(ev.location) > 512:
            raise IcsFormatError("VEVENT text field exceeds bounds")

        tzid = _validate_tzid(ev.timezone)
        visio = _validate_https_url(ev.visio_url, field_name="visio_url")
        agenda = _validate_https_url(ev.agenda_doc_url, field_name="agenda_doc_url")
        canonical_rule = canonicalize_rrule(ev.rrule) if ev.rrule else ""

        lines.append(_property_line("BEGIN", "VEVENT"))
        lines.append(_property_line("UID", ev.uid))
        lines.append(_property_line("DTSTAMP", format_utc_datetime(ev.dtstamp)))
        if tzid == "UTC":
            lines.append(_property_line("DTSTART", format_utc_datetime(ev.dtstart)))
            lines.append(_property_line("DTEND", format_utc_datetime(ev.dtend)))
        else:
            zone = ZoneInfo(tzid)
            start_local = _ensure_utc(ev.dtstart).astimezone(zone).strftime("%Y%m%dT%H%M%S")
            end_local = _ensure_utc(ev.dtend).astimezone(zone).strftime("%Y%m%dT%H%M%S")
            lines.append(_property_line("DTSTART", start_local, params=(("TZID", tzid),)))
            lines.append(_property_line("DTEND", end_local, params=(("TZID", tzid),)))

        lines.append(_property_line("SUMMARY", ev.summary, escape_text=True))
        if ev.description:
            lines.append(_property_line("DESCRIPTION", ev.description, escape_text=True))
        if ev.location:
            lines.append(_property_line("LOCATION", ev.location, escape_text=True))
        lines.append(_property_line("STATUS", status))
        lines.append(_property_line("CLASS", classification))
        lines.append(_property_line("TRANSP", transp))
        lines.append(_property_line("SEQUENCE", str(ev.sequence)))

        if canonical_rule:
            lines.append(_property_line("RRULE", canonical_rule))

        if ev.organizer_email:
            org_email = _validate_email(ev.organizer_email)
            org_params: list[tuple[str, str]] = []
            if ev.organizer_name:
                _reject_control_chars(ev.organizer_name, allow_lf=False)
                if len(ev.organizer_name) > 128:
                    raise IcsFormatError("organizer name exceeds bounds")
                org_params.append(("CN", ev.organizer_name))
            lines.append(_property_line("ORGANIZER", f"mailto:{org_email}", params=org_params))

        for att in ev.attendees:
            att_email = _validate_email(att.email)
            partstat = att.partstat.strip().upper()
            role = att.role.strip().upper()
            if partstat not in ALLOWED_PARTSTATS or role not in ALLOWED_ROLES:
                raise IcsFormatError("invalid ATTENDEE role or participation status")
            att_params: list[tuple[str, str]] = [("ROLE", role), ("PARTSTAT", partstat)]
            if att.name:
                _reject_control_chars(att.name, allow_lf=False)
                if len(att.name) > 128:
                    raise IcsFormatError("attendee name exceeds bounds")
                att_params.append(("CN", att.name))
            lines.append(_property_line("ATTENDEE", f"mailto:{att_email}", params=att_params))

        if visio:
            lines.append(_property_line("URL", visio))
            lines.append(_property_line("X-KODERA-VISIO-URL", visio))
        if agenda:
            lines.append(_property_line("ATTACH", agenda, params=(("FMTTYPE", "text/html"),)))
            lines.append(_property_line("X-KODERA-AGENDA-DOC", agenda))

        for alarm in ev.alarms:
            if not isinstance(alarm.minutes_before, int) or not 0 <= alarm.minutes_before <= 10_080:
                raise IcsFormatError("VALARM trigger minutes must be between 0 and 10080")
            if not alarm.description or len(alarm.description) > 255:
                raise IcsFormatError("VALARM description must be 1..255 characters")
            lines.append(_property_line("BEGIN", "VALARM"))
            lines.append(_property_line("ACTION", "DISPLAY"))
            lines.append(_property_line("TRIGGER", f"-PT{alarm.minutes_before}M"))
            lines.append(_property_line("DESCRIPTION", alarm.description, escape_text=True))
            lines.append(_property_line("END", "VALARM"))

        lines.append(_property_line("END", "VEVENT"))

    for fb in freebusy:
        _reject_control_chars(fb.uid, allow_lf=False)
        if UID_SAFE_RE.fullmatch(fb.uid) is None or ";" in fb.uid:
            raise IcsFormatError("invalid VFREEBUSY UID")
        if fb.dtend <= fb.dtstart:
            raise IcsFormatError("VFREEBUSY dtend must be strictly after dtstart")
        lines.append(_property_line("BEGIN", "VFREEBUSY"))
        lines.append(_property_line("UID", fb.uid))
        lines.append(_property_line("DTSTAMP", format_utc_datetime(fb.dtstamp)))
        lines.append(_property_line("DTSTART", format_utc_datetime(fb.dtstart)))
        lines.append(_property_line("DTEND", format_utc_datetime(fb.dtend)))
        if fb.organizer_email:
            org_email = _validate_email(fb.organizer_email)
            lines.append(_property_line("ORGANIZER", f"mailto:{org_email}"))
        for period in fb.busy_periods:
            p_start = _ensure_utc(period.starts_at)
            p_end = _ensure_utc(period.ends_at)
            if p_end <= p_start:
                raise IcsFormatError("VFREEBUSY period end must be after start")
            lines.append(
                _property_line(
                    "FREEBUSY",
                    f"{format_utc_datetime(p_start)}/{format_utc_datetime(p_end)}",
                    params=(("FBTYPE", "BUSY"),),
                )
            )
        lines.append(_property_line("END", "VFREEBUSY"))

    lines.append(_property_line("END", "VCALENDAR"))
    rendered = "".join(lines)
    if len(rendered.encode("utf-8")) > MAX_ICS_BYTES:
        raise IcsFormatError("serialized VCALENDAR exceeds 512 KiB limit")
    return rendered


def _unfold_ics_lines(payload: bytes | str) -> list[str]:
    if isinstance(payload, bytes):
        if len(payload) > MAX_ICS_BYTES:
            raise IcsFormatError("iCalendar input exceeds 512 KiB limit")
        if b"\x00" in payload:
            raise IcsFormatError("NUL byte forbidden in iCalendar payload")
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise IcsFormatError("iCalendar payload must be valid UTF-8") from exc
    elif isinstance(payload, str):
        if "\x00" in payload:
            raise IcsFormatError("NUL character forbidden in iCalendar payload")
        encoded = payload.encode("utf-8")
        if len(encoded) > MAX_ICS_BYTES:
            raise IcsFormatError("iCalendar input exceeds 512 KiB limit")
        text = payload
    else:
        raise IcsFormatError("iCalendar payload must be bytes or str")

    # Reject bare CR that is not part of CRLF (prevents CR header smuggling).
    idx = 0
    while True:
        cr_pos = text.find("\r", idx)
        if cr_pos == -1:
            break
        if cr_pos + 1 >= len(text) or text[cr_pos + 1] != "\n":
            raise IcsFormatError("bare CR line break forbidden in iCalendar payload")
        idx = cr_pos + 2

    normalized = text.replace("\r\n", "\n")
    raw_lines = normalized.split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()
    if not raw_lines or len(raw_lines) > MAX_ICS_LINES:
        raise IcsFormatError("iCalendar line count out of bounds")

    unfolded: list[str] = []
    for raw_line in raw_lines:
        for ch in raw_line:
            code = ord(ch)
            if code == 0x7F or (code < 0x20 and ch != "\t"):
                raise IcsFormatError("control character forbidden in iCalendar line")
        if raw_line.startswith((" ", "\t")):
            if not unfolded:
                raise IcsFormatError("leading continuation line without property")
            merged = unfolded[-1] + raw_line[1:]
            if len(merged.encode("utf-8")) > MAX_ICS_UNFOLDED_LINE_BYTES:
                raise IcsFormatError("unfolded iCalendar property exceeds byte bound")
            unfolded[-1] = merged
        else:
            if not raw_line:
                raise IcsFormatError("empty content line forbidden in iCalendar")
            if len(raw_line.encode("utf-8")) > MAX_ICS_UNFOLDED_LINE_BYTES:
                raise IcsFormatError("iCalendar property exceeds byte bound")
            unfolded.append(raw_line)
    return unfolded


def _parse_content_line(line: str) -> tuple[str, dict[str, str], str]:
    in_quotes = False
    colon_idx = -1
    for i, ch in enumerate(line):
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == ":" and not in_quotes:
            colon_idx = i
            break
    if in_quotes or colon_idx <= 0:
        raise IcsFormatError("malformed iCalendar content line")

    left = line[:colon_idx]
    value = line[colon_idx + 1 :]

    segments: list[str] = []
    buf: list[str] = []
    in_quotes = False
    for ch in left:
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif ch == ";" and not in_quotes:
            segments.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    segments.append("".join(buf))

    prop_name = segments[0].strip().upper()
    if TOKEN_NAME_RE.fullmatch(prop_name) is None:
        raise IcsFormatError("invalid iCalendar property name")

    params: dict[str, str] = {}
    for raw_param in segments[1:]:
        if "=" not in raw_param:
            raise IcsFormatError("malformed iCalendar parameter")
        p_name, p_val = raw_param.split("=", 1)
        p_key = p_name.strip().upper()
        if TOKEN_NAME_RE.fullmatch(p_key) is None or p_key in params:
            raise IcsFormatError("invalid or duplicate iCalendar parameter")
        if p_val.startswith('"') and p_val.endswith('"') and len(p_val) >= 2:
            unquoted = p_val[1:-1]
            if '"' in unquoted:
                raise IcsFormatError("nested quotes in iCalendar parameter")
            params[p_key] = _decode_param_value(unquoted)
        else:
            if '"' in p_val or ";" in p_val or ":" in p_val:
                raise IcsFormatError("unquoted special char in iCalendar parameter")
            params[p_key] = _decode_param_value(p_val)
    return prop_name, params, value


def _extract_mailto(value: str) -> str:
    cleaned = value.strip()
    if cleaned.lower().startswith("mailto:"):
        cleaned = cleaned[7:]
    return _validate_email(cleaned)


def _parse_ics_duration(raw: str) -> timedelta:
    _reject_control_chars(raw, allow_lf=False)
    cleaned = raw.strip().upper()
    if cleaned.startswith("+"):
        cleaned = cleaned[1:]
    match = re.fullmatch(
        r"P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)",
        cleaned,
    )
    if match is None or not any(match.groups()):
        raise IcsFormatError("invalid DURATION value")
    weeks = int(match.group(1) or "0")
    days = int(match.group(2) or "0")
    hours = int(match.group(3) or "0")
    minutes = int(match.group(4) or "0")
    seconds = int(match.group(5) or "0")
    delta = timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes, seconds=seconds)
    if delta <= timedelta(0) or delta > timedelta(days=366):
        raise IcsFormatError("DURATION out of bounds")
    return delta


def _parse_trigger_minutes(raw: str) -> int:
    cleaned = raw.strip().upper()
    if cleaned in {"PT0S", "-PT0S", "PT0M", "-PT0M"}:
        return 0
    day_match = re.fullmatch(r"-P(\d+)D", cleaned)
    if day_match is not None:
        total = int(day_match.group(1)) * 1440
        if not 0 <= total <= 10_080:
            raise IcsFormatError("VALARM TRIGGER duration out of bounds")
        return total
    match = re.fullmatch(r"-PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", cleaned)
    if match is None or (
        match.group(1) is None and match.group(2) is None and match.group(3) is None
    ):
        raise IcsFormatError("unsupported VALARM TRIGGER duration")
    hours = int(match.group(1) or "0")
    minutes = int(match.group(2) or "0")
    seconds = int(match.group(3) or "0")
    total = hours * 60 + minutes + (1 if seconds > 0 and hours == 0 and minutes == 0 else 0)
    if not 0 <= total <= 10_080:
        raise IcsFormatError("VALARM TRIGGER duration out of bounds")
    return total


def parse_calendar(payload: bytes | str, *, lenient_inbound: bool = False) -> ParsedCalendar:
    """Strictly parse and validate an RFC 5545 VCALENDAR stream (<= 512 KiB)."""
    lines = _unfold_ics_lines(payload)
    stack: list[str] = []
    version = ""
    prodid = ""
    method = "PUBLISH"
    saw_root = False

    events: list[IcsEvent] = []
    freebusy_items: list[IcsFreeBusy] = []

    current_event: dict[str, Any] | None = None
    current_alarm: dict[str, Any] | None = None
    current_fb: dict[str, Any] | None = None

    for line in lines:
        name, params, value = _parse_content_line(line)
        if name == "BEGIN":
            comp = value.strip().upper()
            if not stack:
                if saw_root or comp != "VCALENDAR":
                    raise IcsFormatError("root component must be a single VCALENDAR")
                saw_root = True
                stack.append(comp)
            elif stack == ["VCALENDAR"]:
                if comp == "VEVENT":
                    if len(events) >= MAX_ICS_EVENTS:
                        raise IcsFormatError("too many VEVENT components")
                    current_event = {
                        "attendees": [],
                        "alarms": [],
                        "status": "CONFIRMED",
                        "classification": "PUBLIC",
                        "transp": "OPAQUE",
                        "sequence": 0,
                        "timezone": "UTC",
                    }
                    stack.append(comp)
                elif comp == "VFREEBUSY":
                    current_fb = {"busy": []}
                    stack.append(comp)
                elif comp == "VTIMEZONE" or (lenient_inbound and comp in {"VTODO", "VJOURNAL"}):
                    stack.append(comp)
                else:
                    raise IcsFormatError(f"unsupported component {comp}")
            elif stack[-1] == "VTIMEZONE" and comp in {"STANDARD", "DAYLIGHT"}:
                stack.append(comp)
            elif lenient_inbound and stack[-1] in {"VTODO", "VJOURNAL"} and comp == "VALARM":
                stack.append(comp)
            elif stack == ["VCALENDAR", "VEVENT"] and comp == "VALARM":
                current_alarm = {"description": "Reminder", "skip": False}
                stack.append(comp)
            else:
                raise IcsFormatError("invalid nested component structure")
            continue

        if name == "END":
            comp = value.strip().upper()
            if not stack or stack[-1] != comp:
                raise IcsFormatError("mismatched END component")
            stack.pop()
            if comp == "VALARM" and current_alarm is not None and current_event is not None:
                if not current_alarm.get("skip") and "minutes_before" in current_alarm:
                    alarms = current_event["alarms"]
                    if isinstance(alarms, list) and len(alarms) < 8:
                        alarms.append(
                            IcsAlarm(
                                minutes_before=int(current_alarm["minutes_before"]),
                                description=str(current_alarm.get("description", "Reminder")),
                            )
                        )
                elif not lenient_inbound and not current_alarm.get("skip"):
                    raise IcsFormatError("VALARM missing TRIGGER")
                current_alarm = None
            elif comp == "VEVENT" and current_event is not None:
                uid = str(current_event.get("uid", ""))
                dtstart = current_event.get("dtstart")
                dtend = current_event.get("dtend")
                if dtend is None and isinstance(dtstart, datetime):
                    if isinstance(current_event.get("duration"), timedelta):
                        dtend = dtstart + current_event["duration"]
                    elif current_event.get("dtstart_is_date"):
                        dtend = dtstart + timedelta(days=1)
                    elif lenient_inbound:
                        dtend = dtstart + timedelta(hours=1)
                dtstamp = current_event.get("dtstamp") or dtstart
                summary = str(current_event.get("summary", "Untitled"))
                if not uid or not isinstance(dtstart, datetime) or not isinstance(dtend, datetime):
                    raise IcsFormatError("VEVENT requires UID, DTSTART, and DTEND")
                if not isinstance(dtstamp, datetime) or dtend <= dtstart:
                    raise IcsFormatError("VEVENT timestamps invalid")
                events.append(
                    IcsEvent(
                        uid=uid,
                        dtstamp=dtstamp,
                        dtstart=dtstart,
                        dtend=dtend,
                        summary=summary,
                        description=str(current_event.get("description", "")),
                        location=str(current_event.get("location", "")),
                        status=str(current_event.get("status", "CONFIRMED")),
                        classification=str(current_event.get("classification", "PUBLIC")),
                        transp=str(current_event.get("transp", "OPAQUE")),
                        sequence=int(current_event.get("sequence", 0)),
                        timezone=str(current_event.get("timezone", "UTC")),
                        organizer_email=str(current_event.get("organizer_email", "")),
                        organizer_name=str(current_event.get("organizer_name", "")),
                        rrule=str(current_event.get("rrule", "")),
                        attendees=tuple(current_event["attendees"]),
                        alarms=tuple(current_event["alarms"]),
                        visio_url=str(current_event.get("visio_url", "")),
                        agenda_doc_url=str(current_event.get("agenda_doc_url", "")),
                    )
                )
                current_event = None
            elif comp == "VFREEBUSY" and current_fb is not None:
                uid = str(current_fb.get("uid", ""))
                dtstart = current_fb.get("dtstart")
                dtend = current_fb.get("dtend")
                dtstamp = current_fb.get("dtstamp") or dtstart
                if not uid or not isinstance(dtstart, datetime) or not isinstance(dtend, datetime):
                    raise IcsFormatError("VFREEBUSY requires UID, DTSTART, and DTEND")
                if not isinstance(dtstamp, datetime) or dtend <= dtstart:
                    raise IcsFormatError("VFREEBUSY timestamps invalid")
                freebusy_items.append(
                    IcsFreeBusy(
                        uid=uid,
                        dtstamp=dtstamp,
                        dtstart=dtstart,
                        dtend=dtend,
                        organizer_email=str(current_fb.get("organizer_email", "")),
                        busy_periods=tuple(current_fb["busy"]),
                    )
                )
                current_fb = None
            continue

        if not stack:
            raise IcsFormatError("content line outside VCALENDAR")

        top = stack[-1]
        if top in {"VTIMEZONE", "STANDARD", "DAYLIGHT", "VTODO", "VJOURNAL"}:
            continue

        if top == "VCALENDAR":
            if name == "VERSION":
                version = value.strip()
                if version != "2.0":
                    raise IcsFormatError("unsupported iCalendar VERSION")
            elif name == "PRODID":
                prodid = unescape_ics_text(value).strip()
            elif name == "METHOD":
                m = value.strip().upper()
                if m not in ALLOWED_METHODS:
                    if not lenient_inbound:
                        raise IcsFormatError("invalid VCALENDAR METHOD")
                else:
                    method = m
        elif top == "VALARM":
            if current_alarm is None:
                continue
            if name == "TRIGGER":
                try:
                    current_alarm["minutes_before"] = _parse_trigger_minutes(value)
                except IcsFormatError:
                    if lenient_inbound:
                        current_alarm["skip"] = True
                    else:
                        raise
            elif name == "DESCRIPTION":
                desc = unescape_ics_text(value)
                if len(desc) > 255:
                    if lenient_inbound:
                        desc = desc[:255]
                    else:
                        raise IcsFormatError("VALARM DESCRIPTION exceeds bounds")
                current_alarm["description"] = desc
            elif name == "ACTION" and value.strip().upper() not in {"DISPLAY", "AUDIO"}:
                current_alarm["skip"] = True
        elif top == "VEVENT" and current_event is not None:
            if name == "UID":
                if UID_SAFE_RE.fullmatch(value.strip()) is None:
                    raise IcsFormatError("invalid VEVENT UID")
                current_event["uid"] = value.strip()
            elif name == "DTSTAMP":
                current_event["dtstamp"] = parse_ics_datetime(value, params.get("TZID"))
            elif name == "DTSTART":
                tzid = params.get("TZID")
                raw_stripped = value.strip()
                is_date = (
                    params.get("VALUE", "").upper() == "DATE"
                    or re.fullmatch(r"\d{8}", raw_stripped) is not None
                )
                current_event["dtstart"] = parse_ics_datetime(value, tzid)
                current_event["dtstart_is_date"] = is_date
                if tzid:
                    current_event["timezone"] = _validate_tzid(tzid)
            elif name == "DTEND":
                current_event["dtend"] = parse_ics_datetime(value, params.get("TZID"))
            elif name == "DURATION":
                current_event["duration"] = _parse_ics_duration(value)
            elif name == "SUMMARY":
                summary = unescape_ics_text(value).strip()
                if not summary:
                    if lenient_inbound:
                        summary = "Untitled"
                    else:
                        raise IcsFormatError("invalid VEVENT SUMMARY")
                if len(summary) > 255:
                    if lenient_inbound:
                        summary = summary[:255]
                    else:
                        raise IcsFormatError("invalid VEVENT SUMMARY")
                current_event["summary"] = summary
            elif name == "DESCRIPTION":
                desc = unescape_ics_text(value)
                if len(desc) > 8192:
                    if lenient_inbound:
                        desc = desc[:8192]
                    else:
                        raise IcsFormatError("VEVENT DESCRIPTION exceeds bounds")
                current_event["description"] = desc
            elif name == "LOCATION":
                loc = unescape_ics_text(value)
                if len(loc) > 512:
                    if lenient_inbound:
                        loc = loc[:512]
                    else:
                        raise IcsFormatError("VEVENT LOCATION exceeds bounds")
                current_event["location"] = loc
            elif name == "STATUS":
                st = value.strip().upper()
                if st not in ALLOWED_STATUSES:
                    if not lenient_inbound:
                        raise IcsFormatError("invalid VEVENT STATUS")
                else:
                    current_event["status"] = st
            elif name == "CLASS":
                cls_val = value.strip().upper()
                if cls_val in ALLOWED_CLASSES:
                    current_event["classification"] = cls_val
                else:
                    # RFC 5545 §3.8.1.3: unrecognized CLASS values MUST be treated as PRIVATE
                    current_event["classification"] = "PRIVATE"
            elif name == "TRANSP":
                tr_val = value.strip().upper()
                if tr_val in ALLOWED_TRANSP:
                    current_event["transp"] = tr_val
                elif not lenient_inbound:
                    raise IcsFormatError("invalid VEVENT TRANSP")
            elif name == "SEQUENCE":
                if not value.strip().isdigit():
                    if not lenient_inbound:
                        raise IcsFormatError("invalid VEVENT SEQUENCE")
                else:
                    current_event["sequence"] = int(value.strip())
            elif name == "RRULE":
                current_event["rrule"] = canonicalize_rrule(value)
            elif name == "ORGANIZER":
                try:
                    current_event["organizer_email"] = _extract_mailto(value)
                    if "CN" in params:
                        current_event["organizer_name"] = params["CN"][:128]
                except IcsFormatError:
                    if not lenient_inbound:
                        raise
            elif name == "ATTENDEE":
                attendees = current_event["attendees"]
                if not isinstance(attendees, list) or len(attendees) >= 200:
                    if lenient_inbound:
                        continue
                    raise IcsFormatError("too many ATTENDEE properties")
                partstat = params.get("PARTSTAT", "NEEDS-ACTION").upper()
                role = params.get("ROLE", "REQ-PARTICIPANT").upper()
                if partstat not in ALLOWED_PARTSTATS:
                    if lenient_inbound:
                        partstat = "NEEDS-ACTION"
                    else:
                        raise IcsFormatError("invalid ATTENDEE parameters")
                if role not in ALLOWED_ROLES:
                    if lenient_inbound:
                        role = "REQ-PARTICIPANT"
                    else:
                        raise IcsFormatError("invalid ATTENDEE parameters")
                try:
                    att_email = _extract_mailto(value)
                except IcsFormatError:
                    if lenient_inbound:
                        continue
                    raise
                attendees.append(
                    IcsAttendee(
                        email=att_email,
                        name=params.get("CN", "")[:128],
                        partstat=partstat,
                        role=role,
                    )
                )
            elif name == "X-KODERA-VISIO-URL":
                current_event["visio_url"] = _validate_https_url(value.strip(), field_name=name)
            elif name == "URL":
                try:
                    validated_url = _validate_https_url(value.strip(), field_name=name)
                except IcsFormatError:
                    validated_url = ""
                if validated_url and not current_event.get("visio_url"):
                    current_event["visio_url"] = validated_url
            elif name == "X-KODERA-AGENDA-DOC":
                current_event["agenda_doc_url"] = _validate_https_url(
                    value.strip(), field_name=name
                )
            elif name == "ATTACH":
                try:
                    validated_doc = _validate_https_url(value.strip(), field_name=name)
                except IcsFormatError:
                    validated_doc = ""
                if validated_doc and not current_event.get("agenda_doc_url"):
                    current_event["agenda_doc_url"] = validated_doc
        elif top == "VFREEBUSY" and current_fb is not None:
            if name == "UID":
                if UID_SAFE_RE.fullmatch(value.strip()) is None:
                    raise IcsFormatError("invalid VFREEBUSY UID")
                current_fb["uid"] = value.strip()
            elif name == "DTSTAMP":
                current_fb["dtstamp"] = parse_ics_datetime(value)
            elif name == "DTSTART":
                current_fb["dtstart"] = parse_ics_datetime(value)
            elif name == "DTEND":
                current_fb["dtend"] = parse_ics_datetime(value)
            elif name == "ORGANIZER":
                current_fb["organizer_email"] = _extract_mailto(value)
            elif name == "FREEBUSY":
                busy = current_fb["busy"]
                if not isinstance(busy, list):
                    raise IcsFormatError("invalid FREEBUSY state")
                for chunk in value.split(","):
                    if "/" not in chunk:
                        raise IcsFormatError("invalid FREEBUSY interval")
                    raw_s, raw_e = chunk.split("/", 1)
                    p_s = parse_ics_datetime(raw_s)
                    p_e = parse_ics_datetime(raw_e)
                    if p_e <= p_s:
                        raise IcsFormatError("FREEBUSY end must be after start")
                    busy.append(IcsFreeBusyPeriod(starts_at=p_s, ends_at=p_e))

    if stack or not saw_root or version != "2.0" or not prodid:
        raise IcsFormatError("incomplete VCALENDAR envelope (missing VERSION:2.0, PRODID, or END)")

    return ParsedCalendar(
        version=version,
        prodid=prodid,
        method=method,
        events=tuple(events),
        freebusy=tuple(freebusy_items),
    )
