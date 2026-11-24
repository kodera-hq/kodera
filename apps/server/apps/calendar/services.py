"""Sovereign smart calendar, CalDAV synchronization, and atomic booking page services."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.db.models import Q

from apps.media.context import (
    RefusalError as MediaRefusalError,
    audit,
    caller,
    read_caller,
)
from apps.media.services import quota_replay_policy as quota_replay_policy
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.selectors import (
    active_organisation,
    collection_person_is_current,
    lock_erasure_cutoff_fences,
    membership_user_id,
)
from apps.workspaces.selectors import workspace_id_for
from core.db.ids import new_uuid7
from core.sealing import SealError
from services.identity.access_tokens import VerifiedAccessToken

from .booking import (
    MAX_HORIZON_DAYS,
    BookingValidationError,
    compute_available_slots,
    issue_cancellation_token,
    parse_availability_windows,
    slot_matches_availability,
    validate_booking_slug,
    validate_duration_and_buffer,
    validate_timezone,
    verify_cancellation_token,
)
from .caldav_sync import (
    CalDavAdapter,
    CalDavBlockedError,
    CalDavConflictError,
    CalDavError,
    build_adapter_factory,
)
from .errors import CalendarRefusalError
from .ics import (
    EMAIL_SAFE_RE,
    IcsAlarm,
    IcsAttendee,
    IcsEvent,
    IcsFormatError,
    canonicalize_rrule,
    expand_event_occurrences,
    serialize_calendar,
)
from .models import BookingPage, BookingSlotReservation, CalDavSource, CalendarEvent
from .sealing import (
    CalDavCredentialError,
    CalDavSecretConfig,
    seal_caldav_credentials,
    unseal_caldav_credentials,
)

ADMINS = frozenset({"org_owner", "org_admin"})
ALLOWED_VISIBILITIES = frozenset({"workspace", "private", "busy_only"})
MAX_ACTIVE_RESERVATIONS_PER_GUEST = 5
MAX_ACTIVE_RESERVATIONS_PER_PAGE = 200


def _visibility_from_ics_class(cls_val: str) -> str:
    upper = cls_val.strip().upper()
    if upper == "PUBLIC":
        return "workspace"
    if upper == "CONFIDENTIAL":
        return "busy_only"
    return "private"


def _ics_class_from_visibility(visibility: str) -> str:
    if visibility == "private":
        return "PRIVATE"
    if visibility == "busy_only":
        return "CONFIDENTIAL"
    return "PUBLIC"


def _translate_media_refusal(exc: MediaRefusalError) -> CalendarRefusalError:
    return CalendarRefusalError(exc.status, exc.reason, exc.kind)


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    try:
        read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None


def _require_workspace_id(organisation_id: UUID) -> UUID:
    ws_id = workspace_id_for(organisation_id=organisation_id)
    if ws_id is None:
        raise CalendarRefusalError(404, None, "not-found")
    return ws_id


def _calendar_seal_key() -> bytes:
    key = getattr(settings, "KODERA_CALENDAR_SEAL_KEY", None)
    if not isinstance(key, bytes) or len(key) != 32:
        raise CalendarRefusalError(503, "calendar_seal_key_unconfigured", "service-unavailable")
    return key


def _parse_iso_utc(raw: Any, field_name: str) -> datetime:
    if not isinstance(raw, str) or not 19 <= len(raw) <= 40:
        raise CalendarRefusalError(422, f"invalid_{field_name}", "validation-error")
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        raise CalendarRefusalError(422, f"invalid_{field_name}", "validation-error") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CalendarRefusalError(422, f"naive_{field_name}", "validation-error")
    return parsed.astimezone(UTC)


def _format_iso_utc(dt: datetime) -> str:
    return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _validate_optional_https(url: Any, field_name: str) -> str:
    if url is None or url == "":
        return ""
    if (
        not isinstance(url, str)
        or len(url) > 2048
        or any(ord(c) <= 32 or ord(c) == 127 for c in url)
    ):
        raise CalendarRefusalError(422, f"invalid_{field_name}", "validation-error")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise CalendarRefusalError(422, f"invalid_{field_name}", "validation-error")
    return url


def _validate_attendees(raw_attendees: Any) -> list[dict[str, str]]:
    if raw_attendees is None:
        return []
    if not isinstance(raw_attendees, list) or len(raw_attendees) > 100:
        raise CalendarRefusalError(422, "invalid_attendees", "validation-error")
    cleaned: list[dict[str, str]] = []
    seen_emails: set[str] = set()
    for entry in raw_attendees:
        if not isinstance(entry, dict) or not {"email"} <= set(entry) <= {
            "email",
            "name",
            "partstat",
            "role",
        }:
            raise CalendarRefusalError(422, "invalid_attendees", "validation-error")
        email = entry.get("email")
        if not isinstance(email, str) or len(email) > 254 or EMAIL_SAFE_RE.fullmatch(email) is None:
            raise CalendarRefusalError(422, "invalid_attendee_email", "validation-error")
        lower_email = email.lower()
        if lower_email in seen_emails:
            continue
        seen_emails.add(lower_email)
        name = entry.get("name", "")
        if (
            not isinstance(name, str)
            or len(name) > 128
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
        ):
            raise CalendarRefusalError(422, "invalid_attendee_name", "validation-error")
        partstat = str(entry.get("partstat", "NEEDS-ACTION")).upper()
        role = str(entry.get("role", "REQ-PARTICIPANT")).upper()
        if partstat not in {"NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE"} or role not in {
            "REQ-PARTICIPANT",
            "OPT-PARTICIPANT",
            "CHAIR",
            "NON-PARTICIPANT",
        }:
            raise CalendarRefusalError(422, "invalid_attendee_status", "validation-error")
        cleaned.append(
            {
                "email": lower_email,
                "name": name,
                "partstat": partstat,
                "role": role,
            }
        )
    return cleaned


def _etag_for_revision(revision: int) -> str:
    return f'"{revision}"'


def _parse_if_match(raw_if_match: str | None) -> int:
    if not raw_if_match:
        raise CalendarRefusalError(428, "missing_if_match", "precondition-required")
    cleaned = raw_if_match.strip()
    if cleaned.startswith('W/"'):
        raise CalendarRefusalError(412, "weak_etag_refused", "precondition-failed")
    if cleaned.startswith('"') and cleaned.endswith('"') and len(cleaned) >= 3:
        inner = cleaned[1:-1]
        if inner.isdigit() and int(inner) >= 1:
            return int(inner)
    raise CalendarRefusalError(412, "etag_mismatch", "precondition-failed")


def _serialize_event_row(
    row: CalendarEvent,
    *,
    viewer_membership_id: UUID | None = None,
) -> dict[str, Any]:
    redact_busy = (
        row.visibility == "busy_only"
        and viewer_membership_id is not None
        and viewer_membership_id != row.organizer_membership_id
    )
    return {
        "id": str(row.id),
        "uid": row.uid,
        "title": "Occupé" if redact_busy else row.title,
        "description": "" if redact_busy else row.description,
        "location": "" if redact_busy else row.location,
        "startsAt": _format_iso_utc(row.starts_at),
        "endsAt": _format_iso_utc(row.ends_at),
        "timezone": row.timezone,
        "rrule": row.rrule,
        "status": row.status,
        "visibility": row.visibility,
        "attendees": [] if redact_busy else list(row.attendees or []),
        "alarmMinutesBefore": None if redact_busy else row.alarm_minutes_before,
        "visioUrl": "" if redact_busy else row.visio_url,
        "agendaDocUrl": "" if redact_busy else row.agenda_doc_url,
        "sourceId": str(row.source_id) if row.source_id else None,
        "revision": int(row.revision),
        "updatedAt": _format_iso_utc(row.updated_at),
    }


def _to_ics_event(
    row: CalendarEvent,
    *,
    viewer_membership_id: UUID | None = None,
) -> IcsEvent:
    redact_busy = (
        row.visibility == "busy_only"
        and viewer_membership_id is not None
        and viewer_membership_id != row.organizer_membership_id
    )
    attendees = (
        ()
        if redact_busy
        else tuple(
            IcsAttendee(
                email=str(item.get("email", "")),
                name=str(item.get("name", "")),
                partstat=str(item.get("partstat", "NEEDS-ACTION")),
                role=str(item.get("role", "REQ-PARTICIPANT")),
            )
            for item in (row.attendees or [])
            if isinstance(item, dict) and item.get("email")
        )
    )
    alarms = (
        ()
        if redact_busy or row.alarm_minutes_before is None
        else (IcsAlarm(minutes_before=int(row.alarm_minutes_before), description=row.title[:120]),)
    )
    return IcsEvent(
        uid=row.uid,
        dtstamp=row.updated_at or datetime.now(tz=UTC),
        dtstart=row.starts_at,
        dtend=row.ends_at,
        summary="Occupé" if redact_busy else row.title,
        description="" if redact_busy else row.description,
        location="" if redact_busy else row.location,
        status=row.status.upper(),
        classification=_ics_class_from_visibility(row.visibility),
        sequence=row.sequence,
        timezone=row.timezone,
        rrule=row.rrule,
        attendees=attendees,
        alarms=alarms,
        visio_url="" if redact_busy else row.visio_url,
        agenda_doc_url="" if redact_busy else row.agenda_doc_url,
    )


def _serialize_source_row(row: CalDavSource) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "provider": row.provider,
        "calendarUrl": row.calendar_url,
        "principalUsername": row.principal_username,
        "enabled": bool(row.enabled),
        "hasSyncToken": bool(row.sync_token),
        "lastSyncedAt": _format_iso_utc(row.last_synced_at) if row.last_synced_at else None,
        "lastErrorCode": row.last_error_code or None,
        "createdAt": _format_iso_utc(row.created_at),
    }


def _serialize_booking_page_row(row: BookingPage) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "slug": row.slug,
        "title": row.title,
        "description": row.description,
        "timezone": row.timezone,
        "durationMinutes": int(row.duration_minutes),
        "bufferMinutes": int(row.buffer_minutes),
        "availabilityWindows": list(row.availability_windows or []),
        "visioUrl": row.visio_url,
        "agendaDocUrl": row.agenda_doc_url,
        "active": bool(row.active),
        "revision": int(row.revision),
        "createdAt": _format_iso_utc(row.created_at),
    }


def _visible_events_queryset(principal: TenantCaller, workspace_id: UUID) -> Any:
    return CalendarEvent.objects.filter(
        organisation_id=principal.organisation_id,
        workspace_id=workspace_id,
    ).filter(
        Q(visibility__in=["workspace", "busy_only"])
        | Q(organizer_membership_id=principal.membership_id)
    )


@transaction.atomic
def list_calendar_events(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    from_iso: str | None = None,
    to_iso: str | None = None,
) -> dict[str, Any]:
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    now = datetime.now(tz=UTC)
    win_start = _parse_iso_utc(from_iso, "from") if from_iso else (now - timedelta(days=30))
    win_end = _parse_iso_utc(to_iso, "to") if to_iso else (now + timedelta(days=90))
    if win_end <= win_start or (win_end - win_start) > timedelta(days=370):
        raise CalendarRefusalError(422, "invalid_query_window", "validation-error")

    qs = (
        _visible_events_queryset(principal, ws_id)
        .exclude(status="cancelled")
        .filter(Q(rrule__gt="") | Q(starts_at__lt=win_end, ends_at__gt=win_start))
        .order_by("starts_at", "id")[:250]
    )
    items: list[dict[str, Any]] = []
    for row in qs:
        if row.rrule:
            occs = expand_event_occurrences(
                starts_at=row.starts_at,
                ends_at=row.ends_at,
                rrule=row.rrule,
                timezone=row.timezone,
                window_start=win_start,
                window_end=win_end,
            )
            if occs:
                items.append(
                    _serialize_event_row(row, viewer_membership_id=principal.membership_id)
                )
        elif row.starts_at < win_end and row.ends_at > win_start:
            items.append(_serialize_event_row(row, viewer_membership_id=principal.membership_id))
    return {"data": items}


@transaction.atomic
def create_calendar_event(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> tuple[dict[str, Any], str]:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    title = body.get("title")
    if (
        not isinstance(title, str)
        or not 1 <= len(title.strip()) <= 255
        or any(ord(c) < 32 or ord(c) == 127 for c in title)
    ):
        raise CalendarRefusalError(422, "invalid_title", "validation-error")
    starts_at = _parse_iso_utc(body.get("startsAt"), "starts_at")
    ends_at = _parse_iso_utc(body.get("endsAt"), "ends_at")
    if ends_at <= starts_at or (ends_at - starts_at) > timedelta(days=30):
        raise CalendarRefusalError(422, "invalid_event_duration", "validation-error")

    tz_name = body.get("timezone", "Europe/Paris")
    try:
        validate_timezone(tz_name)
    except BookingValidationError:
        raise CalendarRefusalError(422, "invalid_timezone", "validation-error") from None

    description = body.get("description", "")
    if not isinstance(description, str) or len(description) > 8192:
        raise CalendarRefusalError(422, "invalid_description", "validation-error")
    location = body.get("location", "")
    if (
        not isinstance(location, str)
        or len(location) > 512
        or any(ord(c) < 32 or ord(c) == 127 for c in location)
    ):
        raise CalendarRefusalError(422, "invalid_location", "validation-error")

    raw_rrule = body.get("rrule", "")
    if not isinstance(raw_rrule, str):
        raise CalendarRefusalError(422, "invalid_rrule", "validation-error")
    try:
        rrule = canonicalize_rrule(raw_rrule) if raw_rrule.strip() else ""
    except IcsFormatError:
        raise CalendarRefusalError(422, "invalid_rrule", "validation-error") from None

    visibility = body.get("visibility", "workspace")
    if visibility not in ALLOWED_VISIBILITIES:
        raise CalendarRefusalError(422, "invalid_visibility", "validation-error")

    alarm_minutes = body.get("alarmMinutesBefore")
    if alarm_minutes is not None and (
        isinstance(alarm_minutes, bool)
        or not isinstance(alarm_minutes, int)
        or not 0 <= alarm_minutes <= 10_080
    ):
        raise CalendarRefusalError(422, "invalid_alarm", "validation-error")

    attendees = _validate_attendees(body.get("attendees"))
    visio_url = _validate_optional_https(body.get("visioUrl"), "visio_url")
    agenda_doc_url = _validate_optional_https(body.get("agendaDocUrl"), "agenda_doc_url")

    event_id = new_uuid7()
    uid = f"{event_id}@kodera.calendar"
    row = CalendarEvent.objects.create(
        id=event_id,
        organisation_id=principal.organisation_id,
        workspace_id=ws_id,
        organizer_membership_id=principal.membership_id,
        uid=uid,
        title=title.strip(),
        description=description,
        location=location,
        starts_at=starts_at,
        ends_at=ends_at,
        timezone=tz_name,
        rrule=rrule,
        status="confirmed",
        visibility=visibility,
        attendees=attendees,
        alarm_minutes_before=alarm_minutes,
        visio_url=visio_url,
        agenda_doc_url=agenda_doc_url,
        sequence=0,
        revision=1,
    )
    audit(principal, "workspace.calendar.event_created", row.id, request_id)
    return _serialize_event_row(row), _etag_for_revision(row.revision)


@transaction.atomic
def update_calendar_event(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    event_id: UUID,
    if_match: str | None,
    body: dict[str, Any],
    request_id: str,
) -> tuple[dict[str, Any], str]:
    expected_rev = _parse_if_match(if_match)
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    row = (
        CalendarEvent.objects.select_for_update()
        .filter(id=event_id, organisation_id=principal.organisation_id, workspace_id=ws_id)
        .first()
    )
    if row is None or (
        row.visibility == "private" and row.organizer_membership_id != principal.membership_id
    ):
        raise CalendarRefusalError(404, None, "not-found")
    if row.organizer_membership_id != principal.membership_id and principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")
    if row.revision != expected_rev:
        raise CalendarRefusalError(
            412,
            "etag_mismatch",
            "precondition-failed",
            current_etag=_etag_for_revision(row.revision),
        )
    if not body:
        raise CalendarRefusalError(422, "empty_patch", "validation-error")

    update_fields = ["revision", "sequence", "updated_at"]
    if "title" in body:
        title = body["title"]
        if (
            not isinstance(title, str)
            or not 1 <= len(title.strip()) <= 255
            or any(ord(c) < 32 or ord(c) == 127 for c in title)
        ):
            raise CalendarRefusalError(422, "invalid_title", "validation-error")
        row.title = title.strip()
        update_fields.append("title")
    if "description" in body:
        if not isinstance(body["description"], str) or len(body["description"]) > 8192:
            raise CalendarRefusalError(422, "invalid_description", "validation-error")
        row.description = body["description"]
        update_fields.append("description")
    if "location" in body:
        loc = body["location"]
        if (
            not isinstance(loc, str)
            or len(loc) > 512
            or any(ord(c) < 32 or ord(c) == 127 for c in loc)
        ):
            raise CalendarRefusalError(422, "invalid_location", "validation-error")
        row.location = loc
        update_fields.append("location")
    if "startsAt" in body:
        row.starts_at = _parse_iso_utc(body["startsAt"], "starts_at")
        update_fields.append("starts_at")
    if "endsAt" in body:
        row.ends_at = _parse_iso_utc(body["endsAt"], "ends_at")
        update_fields.append("ends_at")
    if row.ends_at <= row.starts_at or (row.ends_at - row.starts_at) > timedelta(days=30):
        raise CalendarRefusalError(422, "invalid_event_duration", "validation-error")
    if "status" in body:
        if body["status"] not in {"confirmed", "tentative", "cancelled"}:
            raise CalendarRefusalError(422, "invalid_status", "validation-error")
        row.status = body["status"]
        update_fields.append("status")
    if "visibility" in body:
        if body["visibility"] not in ALLOWED_VISIBILITIES:
            raise CalendarRefusalError(422, "invalid_visibility", "validation-error")
        row.visibility = body["visibility"]
        update_fields.append("visibility")
    if "rrule" in body:
        if not isinstance(body["rrule"], str):
            raise CalendarRefusalError(422, "invalid_rrule", "validation-error")
        try:
            row.rrule = canonicalize_rrule(body["rrule"]) if body["rrule"].strip() else ""
        except IcsFormatError:
            raise CalendarRefusalError(422, "invalid_rrule", "validation-error") from None
        update_fields.append("rrule")
    if "visioUrl" in body:
        row.visio_url = _validate_optional_https(body["visioUrl"], "visio_url")
        update_fields.append("visio_url")
    if "agendaDocUrl" in body:
        row.agenda_doc_url = _validate_optional_https(body["agendaDocUrl"], "agenda_doc_url")
        update_fields.append("agenda_doc_url")

    row.sequence += 1
    row.revision += 1
    row.save(update_fields=update_fields)
    audit(principal, "workspace.calendar.event_updated", row.id, request_id)
    return (
        _serialize_event_row(row, viewer_membership_id=principal.membership_id),
        _etag_for_revision(row.revision),
    )


@transaction.atomic
def delete_calendar_event(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    event_id: UUID,
    request_id: str,
) -> None:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    row = (
        CalendarEvent.objects.select_for_update()
        .filter(id=event_id, organisation_id=principal.organisation_id, workspace_id=ws_id)
        .first()
    )
    if row is None or (
        row.visibility == "private" and row.organizer_membership_id != principal.membership_id
    ):
        raise CalendarRefusalError(404, None, "not-found")
    if row.organizer_membership_id != principal.membership_id and principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")

    BookingSlotReservation.objects.filter(event_id=row.id).update(event_id=None)
    target_id = row.id
    row.delete()
    audit(principal, "workspace.calendar.event_deleted", target_id, request_id)


@transaction.atomic
def export_workspace_ics(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
) -> dict[str, str]:
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    rows = list(
        _visible_events_queryset(principal, ws_id)
        .exclude(status="cancelled")
        .order_by("starts_at", "id")[:250]
    )
    if rows:
        ics_events = tuple(
            _to_ics_event(r, viewer_membership_id=principal.membership_id) for r in rows
        )
        ics_text = serialize_calendar(events=ics_events, method="PUBLISH")
    else:
        now = datetime.now(tz=UTC)
        placeholder = IcsEvent(
            uid=f"empty-{ws_id}@kodera.calendar",
            dtstamp=now,
            dtstart=now,
            dtend=now + timedelta(minutes=15),
            summary="Kodera Sovereign Calendar",
            status="CANCELLED",
        )
        ics_text = serialize_calendar(events=(placeholder,), method="PUBLISH")

    return {
        "filename": "kodera-workspace-calendar.ics",
        "ics": ics_text,
    }


@transaction.atomic
def list_caldav_sources(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
) -> dict[str, Any]:
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    if principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")
    ws_id = _require_workspace_id(organisation_id)

    rows = CalDavSource.objects.filter(
        organisation_id=principal.organisation_id,
        workspace_id=ws_id,
    ).order_by("-created_at")[:50]
    return {"data": [_serialize_source_row(row) for row in rows]}


@transaction.atomic
def create_caldav_source(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    if principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")
    ws_id = _require_workspace_id(organisation_id)
    master_key = _calendar_seal_key()

    name = body.get("name")
    if (
        not isinstance(name, str)
        or not 1 <= len(name.strip()) <= 128
        or any(ord(c) < 32 or ord(c) == 127 for c in name)
    ):
        raise CalendarRefusalError(422, "invalid_source_name", "validation-error")

    provider = body.get("provider", "lasuite")
    try:
        secret_cfg = CalDavSecretConfig(
            calendar_url=body.get("calendarUrl", ""),
            username=body.get("username", ""),
            password=body.get("password", ""),
            provider=provider,
        )
    except CalDavCredentialError:
        raise CalendarRefusalError(422, "invalid_caldav_source", "validation-error") from None

    source_id = new_uuid7()
    sealed = seal_caldav_credentials(
        master_key,
        organisation_id=principal.organisation_id,
        workspace_id=ws_id,
        source_id=source_id,
        config=secret_cfg,
    )
    try:
        row = CalDavSource.objects.create(
            id=source_id,
            organisation_id=principal.organisation_id,
            workspace_id=ws_id,
            owner_membership_id=principal.membership_id,
            name=name.strip(),
            provider=secret_cfg.provider,
            calendar_url=secret_cfg.calendar_url,
            principal_username=secret_cfg.username,
            sealed_credentials=sealed,
            enabled=True,
        )
    except IntegrityError:
        raise CalendarRefusalError(409, "caldav_source_exists", "conflict") from None

    audit(principal, "workspace.calendar.source_created", row.id, request_id)
    return _serialize_source_row(row)


@transaction.atomic
def delete_caldav_source(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    source_id: UUID,
    request_id: str,
) -> None:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    if principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")
    ws_id = _require_workspace_id(organisation_id)

    row = (
        CalDavSource.objects.select_for_update()
        .filter(id=source_id, organisation_id=principal.organisation_id, workspace_id=ws_id)
        .first()
    )
    if row is None:
        raise CalendarRefusalError(404, None, "not-found")

    BookingSlotReservation.objects.filter(event__source_id=row.id).update(event_id=None)
    CalendarEvent.objects.filter(source_id=row.id).delete()
    row.delete()
    audit(principal, "workspace.calendar.source_deleted", source_id, request_id)


def sync_caldav_source(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    source_id: UUID,
    request_id: str,
    adapter_factory: Callable[[CalDavSecretConfig, str | None], CalDavAdapter] | None = None,
) -> dict[str, Any]:
    """Run incremental CalDAV sync outside long DB lock, then commit delta atomically."""
    with transaction.atomic():
        try:
            principal = read_caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        if principal.role not in ADMINS:
            raise CalendarRefusalError(403, None, "forbidden")
        ws_id = _require_workspace_id(organisation_id)
        master_key = _calendar_seal_key()

        row = CalDavSource.objects.filter(
            id=source_id,
            organisation_id=principal.organisation_id,
            workspace_id=ws_id,
        ).first()
        if row is None:
            raise CalendarRefusalError(404, None, "not-found")
        if not row.enabled:
            raise CalendarRefusalError(409, "caldav_source_disabled", "conflict")

        try:
            secret_cfg = unseal_caldav_credentials(
                master_key,
                organisation_id=principal.organisation_id,
                workspace_id=ws_id,
                source_id=row.id,
                sealed_value=bytes(row.sealed_credentials),
            )
        except SealError:
            raise CalendarRefusalError(
                503, "caldav_credentials_unreadable", "service-unavailable"
            ) from None
        prior_sync_token = row.sync_token

    factory = adapter_factory or build_adapter_factory()
    try:
        adapter = factory(secret_cfg, str(organisation_id))
        batch = adapter.sync_collection(sync_token=prior_sync_token)
    except CalDavBlockedError as exc:
        raise CalendarRefusalError(422, exc.code, "validation-error") from None
    except CalDavConflictError as exc:
        raise CalendarRefusalError(409, exc.code, "conflict") from None
    except CalDavError as exc:
        with transaction.atomic():
            CalDavSource.objects.filter(id=source_id, organisation_id=organisation_id).update(
                last_error_code=exc.code[:128],
                updated_at=datetime.now(tz=UTC),
            )
        raise CalendarRefusalError(503, exc.code, "service-unavailable") from None

    upserted = 0
    removed = 0
    now = datetime.now(tz=UTC)
    with transaction.atomic():
        try:
            principal = caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        locked_source = (
            CalDavSource.objects.select_for_update()
            .filter(id=source_id, organisation_id=principal.organisation_id, workspace_id=ws_id)
            .first()
        )
        if locked_source is None:
            raise CalendarRefusalError(404, None, "not-found")

        seen_remote_uids: set[str] = set()
        for delta in batch.deltas:
            if delta.deleted:
                deleted_rows = (
                    CalendarEvent.objects.filter(
                        workspace_id=ws_id,
                        source_id=locked_source.id,
                        remote_href=delta.href,
                    )
                    .exclude(status="cancelled")
                    .update(
                        status="cancelled",
                        updated_at=now,
                    )
                )
                removed += int(deleted_rows)
                continue
            for ev in delta.events:
                seen_remote_uids.add(ev.uid)
                existing = (
                    CalendarEvent.objects.select_for_update()
                    .filter(
                        workspace_id=ws_id,
                        source_id=locked_source.id,
                        uid=ev.uid,
                    )
                    .first()
                )
                status_lower = ev.status.lower()
                mapped_visibility = _visibility_from_ics_class(ev.classification)
                alarm_min = ev.alarms[0].minutes_before if ev.alarms else None
                attendees_json = [
                    {
                        "email": a.email,
                        "name": a.name,
                        "partstat": a.partstat,
                        "role": a.role,
                    }
                    for a in ev.attendees
                ]
                if existing is None:
                    CalendarEvent.objects.create(
                        organisation_id=principal.organisation_id,
                        workspace_id=ws_id,
                        organizer_membership_id=locked_source.owner_membership_id,
                        source_id=locked_source.id,
                        uid=ev.uid,
                        title=ev.summary[:255],
                        description=ev.description[:8192],
                        location=ev.location[:512],
                        starts_at=ev.dtstart,
                        ends_at=ev.dtend,
                        timezone=ev.timezone,
                        rrule=ev.rrule,
                        status=status_lower,
                        visibility=mapped_visibility,
                        attendees=attendees_json,
                        alarm_minutes_before=alarm_min,
                        visio_url=ev.visio_url,
                        agenda_doc_url=ev.agenda_doc_url,
                        remote_href=delta.href,
                        remote_etag=delta.etag,
                        sequence=ev.sequence,
                        revision=1,
                    )
                    upserted += 1
                else:
                    existing.title = ev.summary[:255]
                    existing.description = ev.description[:8192]
                    existing.location = ev.location[:512]
                    existing.starts_at = ev.dtstart
                    existing.ends_at = ev.dtend
                    existing.timezone = ev.timezone
                    existing.rrule = ev.rrule
                    existing.status = status_lower
                    existing.visibility = mapped_visibility
                    existing.attendees = attendees_json
                    existing.alarm_minutes_before = alarm_min
                    existing.visio_url = ev.visio_url
                    existing.agenda_doc_url = ev.agenda_doc_url
                    existing.remote_href = delta.href
                    existing.remote_etag = delta.etag
                    existing.sequence = ev.sequence
                    existing.revision += 1
                    existing.save(
                        update_fields=[
                            "title",
                            "description",
                            "location",
                            "starts_at",
                            "ends_at",
                            "timezone",
                            "rrule",
                            "status",
                            "visibility",
                            "attendees",
                            "alarm_minutes_before",
                            "visio_url",
                            "agenda_doc_url",
                            "remote_href",
                            "remote_etag",
                            "sequence",
                            "revision",
                            "updated_at",
                        ]
                    )
                    upserted += 1

        if batch.full_resync:
            orphan_qs = CalendarEvent.objects.filter(
                workspace_id=ws_id,
                source_id=locked_source.id,
            ).exclude(status="cancelled")
            if seen_remote_uids:
                orphan_qs = orphan_qs.exclude(uid__in=seen_remote_uids)
            removed += int(orphan_qs.update(status="cancelled", updated_at=now))

        locked_source.sync_token = batch.sync_token
        locked_source.last_synced_at = now
        locked_source.last_error_code = ""
        locked_source.save(
            update_fields=["sync_token", "last_synced_at", "last_error_code", "updated_at"]
        )
        audit(principal, "workspace.calendar.source_synced", locked_source.id, request_id)

    return {
        "sourceId": str(source_id),
        "upserted": upserted,
        "removed": removed,
        "fullResync": batch.full_resync,
        "syncedAt": _format_iso_utc(now),
    }


@transaction.atomic
def list_booking_pages(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
) -> dict[str, Any]:
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    rows = BookingPage.objects.filter(
        organisation_id=principal.organisation_id,
        workspace_id=ws_id,
    ).order_by("-created_at")[:50]
    return {"data": [_serialize_booking_page_row(row) for row in rows]}


@transaction.atomic
def create_booking_page(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    try:
        slug = validate_booking_slug(body.get("slug", ""))
        duration_minutes = cast(int, body.get("durationMinutes", 30))
        buffer_minutes = cast(int, body.get("bufferMinutes", 0))
        validate_duration_and_buffer(
            duration_minutes=duration_minutes,
            buffer_minutes=buffer_minutes,
        )
        tz_name = str(body.get("timezone", "Europe/Paris"))
        validate_timezone(tz_name)
        windows = parse_availability_windows(body.get("availabilityWindows"))
    except BookingValidationError:
        raise CalendarRefusalError(422, "invalid_booking_page", "validation-error") from None

    title = body.get("title")
    if (
        not isinstance(title, str)
        or not 1 <= len(title.strip()) <= 160
        or any(ord(c) < 32 or ord(c) == 127 for c in title)
    ):
        raise CalendarRefusalError(422, "invalid_title", "validation-error")

    description = body.get("description", "")
    if not isinstance(description, str) or len(description) > 2048:
        raise CalendarRefusalError(422, "invalid_description", "validation-error")

    visio_url = _validate_optional_https(body.get("visioUrl"), "visio_url")
    agenda_doc_url = _validate_optional_https(body.get("agendaDocUrl"), "agenda_doc_url")

    try:
        row = BookingPage.objects.create(
            organisation_id=principal.organisation_id,
            workspace_id=ws_id,
            host_membership_id=principal.membership_id,
            slug=slug,
            title=title.strip(),
            description=description,
            timezone=tz_name,
            duration_minutes=duration_minutes,
            buffer_minutes=buffer_minutes,
            availability_windows=[w.to_dict() for w in windows],
            visio_url=visio_url,
            agenda_doc_url=agenda_doc_url,
            active=True,
            revision=1,
        )
    except IntegrityError:
        raise CalendarRefusalError(409, "booking_slug_taken", "conflict") from None

    audit(principal, "workspace.calendar.booking_page_created", row.id, request_id)
    return _serialize_booking_page_row(row)


@transaction.atomic
def delete_booking_page(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    booking_page_id: UUID,
    request_id: str,
) -> None:
    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    ws_id = _require_workspace_id(organisation_id)

    row = (
        BookingPage.objects.select_for_update()
        .filter(id=booking_page_id, organisation_id=principal.organisation_id, workspace_id=ws_id)
        .first()
    )
    if row is None:
        raise CalendarRefusalError(404, None, "not-found")
    if row.host_membership_id != principal.membership_id and principal.role not in ADMINS:
        raise CalendarRefusalError(403, None, "forbidden")

    row.active = False
    row.revision += 1
    row.save(update_fields=["active", "revision", "updated_at"])
    audit(principal, "workspace.calendar.booking_page_deactivated", row.id, request_id)


def _ensure_public_host_active(page: BookingPage) -> None:
    if not active_organisation(organisation_id=page.organisation_id):
        raise CalendarRefusalError(404, None, "not-found")
    if not collection_person_is_current(
        membership_id=page.host_membership_id,
        organisation_id=page.organisation_id,
    ):
        raise CalendarRefusalError(404, None, "not-found")


def _collect_host_busy_intervals(
    page: BookingPage,
    *,
    range_start: datetime,
    range_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """Collect busy intervals for a booking page host without reading or exposing any PII."""
    padded_start = range_start - timedelta(days=1)
    padded_end = range_end + timedelta(days=1)
    busy: list[tuple[datetime, datetime]] = []

    host_events = (
        CalendarEvent.objects.filter(
            workspace_id=page.workspace_id,
            organizer_membership_id=page.host_membership_id,
        )
        .exclude(status="cancelled")
        .filter(Q(rrule__gt="") | Q(starts_at__lt=padded_end, ends_at__gt=padded_start))
        .order_by("starts_at", "id")
        .only("starts_at", "ends_at", "rrule", "timezone")[:500]
    )
    for ev in host_events:
        if ev.rrule:
            busy.extend(
                expand_event_occurrences(
                    starts_at=ev.starts_at,
                    ends_at=ev.ends_at,
                    rrule=ev.rrule,
                    timezone=ev.timezone,
                    window_start=padded_start,
                    window_end=padded_end,
                )
            )
        elif ev.starts_at < padded_end and ev.ends_at > padded_start:
            busy.append((ev.starts_at, ev.ends_at))

    page_buf = timedelta(minutes=page.buffer_minutes)
    reservations = BookingSlotReservation.objects.filter(
        workspace_id=page.workspace_id,
        booking_page__host_membership_id=page.host_membership_id,
        status="confirmed",
        buffered_starts_at__lt=padded_end,
        buffered_ends_at__gt=padded_start,
    ).values_list("starts_at", "ends_at", "buffered_starts_at", "buffered_ends_at")[:500]
    for r_start, r_end, r_buf_start, r_buf_end in reservations:
        effective_start = min(r_start, r_buf_start + page_buf)
        effective_end = max(r_end, r_buf_end - page_buf)
        busy.append((effective_start, effective_end))

    return busy


@transaction.atomic
def get_public_booking_page(
    *,
    booking_slug: str,
    from_iso: str | None = None,
    to_iso: str | None = None,
) -> dict[str, Any]:
    """Return zero-PII public booking page metadata and free availability slots."""
    try:
        slug = validate_booking_slug(booking_slug)
    except BookingValidationError:
        raise CalendarRefusalError(404, None, "not-found") from None

    page = BookingPage.objects.filter(slug=slug, active=True).first()
    if page is None:
        raise CalendarRefusalError(404, None, "not-found")
    _ensure_public_host_active(page)

    now = datetime.now(tz=UTC)
    range_start = _parse_iso_utc(from_iso, "from") if from_iso else now
    range_end = _parse_iso_utc(to_iso, "to") if to_iso else (range_start + timedelta(days=14))
    if range_end <= range_start or (range_end - range_start) > timedelta(days=MAX_HORIZON_DAYS):
        raise CalendarRefusalError(422, "invalid_availability_range", "validation-error")

    windows = parse_availability_windows(page.availability_windows)
    busy = _collect_host_busy_intervals(page, range_start=range_start, range_end=range_end)
    slots = compute_available_slots(
        availability_windows=windows,
        timezone=page.timezone,
        duration_minutes=page.duration_minutes,
        buffer_minutes=page.buffer_minutes,
        range_start=range_start,
        range_end=range_end,
        busy_intervals=busy,
        now=now,
    )

    return {
        "slug": page.slug,
        "title": page.title,
        "description": page.description,
        "timezone": page.timezone,
        "durationMinutes": int(page.duration_minutes),
        "visioAvailable": bool(page.visio_url),
        "slots": [
            {
                "startsAt": _format_iso_utc(s.starts_at),
                "endsAt": _format_iso_utc(s.ends_at),
            }
            for s in slots
        ],
    }


@transaction.atomic
def reserve_public_booking_slot(
    *,
    booking_slug: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """Atomically reserve a public slot using SELECT ... FOR UPDATE and SQL overlap guard."""
    try:
        slug = validate_booking_slug(booking_slug)
    except BookingValidationError:
        raise CalendarRefusalError(404, None, "not-found") from None

    unlocked_page = BookingPage.objects.filter(slug=slug, active=True).first()
    if unlocked_page is None:
        raise CalendarRefusalError(404, None, "not-found")

    host_user_id = membership_user_id(membership_id=unlocked_page.host_membership_id)
    lock_erasure_cutoff_fences(
        organisation_id=unlocked_page.organisation_id,
        user_id=host_user_id,
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM orgs_membership WHERE id = %s FOR UPDATE",
            [unlocked_page.host_membership_id],
        )

    page = BookingPage.objects.select_for_update().filter(id=unlocked_page.id, active=True).first()
    if page is None:
        raise CalendarRefusalError(404, None, "not-found")
    _ensure_public_host_active(page)

    guest_name = body.get("guestName")
    if (
        not isinstance(guest_name, str)
        or not 1 <= len(guest_name.strip()) <= 160
        or any(ord(c) < 32 or ord(c) == 127 for c in guest_name)
    ):
        raise CalendarRefusalError(422, "invalid_guest_name", "validation-error")

    guest_email = body.get("guestEmail")
    if (
        not isinstance(guest_email, str)
        or len(guest_email.strip()) > 254
        or EMAIL_SAFE_RE.fullmatch(guest_email.strip()) is None
    ):
        raise CalendarRefusalError(422, "invalid_guest_email", "validation-error")
    normalized_email = guest_email.strip().lower()

    guest_notes = body.get("guestNotes", "")
    if not isinstance(guest_notes, str) or len(guest_notes) > 1024:
        raise CalendarRefusalError(422, "invalid_guest_notes", "validation-error")

    starts_at = _parse_iso_utc(body.get("startsAt"), "starts_at")
    ends_at = starts_at + timedelta(minutes=page.duration_minutes)
    now = datetime.now(tz=UTC)

    if starts_at > now + timedelta(days=MAX_HORIZON_DAYS):
        raise CalendarRefusalError(422, "booking_horizon_exceeded", "validation-error")

    active_guest_count = BookingSlotReservation.objects.filter(
        booking_page_id=page.id,
        guest_email=normalized_email,
        status="confirmed",
        starts_at__gte=now,
    ).count()
    if active_guest_count >= MAX_ACTIVE_RESERVATIONS_PER_GUEST:
        raise CalendarRefusalError(429, "guest_reservation_limit_reached", "rate-limited")

    active_page_count = BookingSlotReservation.objects.filter(
        booking_page_id=page.id,
        status="confirmed",
        starts_at__gte=now,
    ).count()
    if active_page_count >= MAX_ACTIVE_RESERVATIONS_PER_PAGE:
        raise CalendarRefusalError(429, "booking_page_capacity_reached", "rate-limited")

    windows = parse_availability_windows(page.availability_windows)
    busy = _collect_host_busy_intervals(
        page,
        range_start=starts_at - timedelta(hours=4),
        range_end=ends_at + timedelta(hours=4),
    )
    if not slot_matches_availability(
        availability_windows=windows,
        timezone=page.timezone,
        duration_minutes=page.duration_minutes,
        buffer_minutes=page.buffer_minutes,
        starts_at=starts_at,
        ends_at=ends_at,
        busy_intervals=busy,
        now=now,
    ):
        raise CalendarRefusalError(409, "slot_unavailable", "conflict")

    token_plain, token_digest = issue_cancellation_token()
    reservation_id = new_uuid7()
    event_id = new_uuid7()
    uid = f"booking-{reservation_id}@kodera.calendar"
    buffer_delta = timedelta(minutes=page.buffer_minutes)
    buffered_starts_at = starts_at - buffer_delta
    buffered_ends_at = ends_at + buffer_delta
    bounded_event_title = f"{page.title} — {guest_name.strip()}"[:255]

    try:
        with transaction.atomic():
            event_row = CalendarEvent.objects.create(
                id=event_id,
                organisation_id=page.organisation_id,
                workspace_id=page.workspace_id,
                organizer_membership_id=page.host_membership_id,
                uid=uid,
                title=bounded_event_title,
                description=guest_notes,
                starts_at=starts_at,
                ends_at=ends_at,
                timezone=page.timezone,
                status="confirmed",
                visibility="private",
                attendees=[
                    {
                        "email": normalized_email,
                        "name": guest_name.strip()[:128],
                        "partstat": "ACCEPTED",
                        "role": "REQ-PARTICIPANT",
                    }
                ],
                alarm_minutes_before=15,
                visio_url=page.visio_url,
                agenda_doc_url=page.agenda_doc_url,
                sequence=0,
                revision=1,
            )

            reservation = BookingSlotReservation.objects.create(
                id=reservation_id,
                organisation_id=page.organisation_id,
                workspace_id=page.workspace_id,
                booking_page_id=page.id,
                event_id=event_row.id,
                uid=uid,
                guest_name=guest_name.strip(),
                guest_email=normalized_email,
                guest_notes=guest_notes,
                starts_at=starts_at,
                ends_at=ends_at,
                buffered_starts_at=buffered_starts_at,
                buffered_ends_at=buffered_ends_at,
                status="confirmed",
                cancellation_token_sha256=token_digest,
            )
    except IntegrityError:
        raise CalendarRefusalError(409, "slot_unavailable", "conflict") from None

    ics_invite = serialize_calendar(
        events=(_to_ics_event(event_row, viewer_membership_id=page.host_membership_id),),
        method="REQUEST",
    )
    return {
        "reservationId": str(reservation.id),
        "slug": page.slug,
        "title": page.title,
        "startsAt": _format_iso_utc(starts_at),
        "endsAt": _format_iso_utc(ends_at),
        "timezone": page.timezone,
        "visioUrl": page.visio_url,
        "agendaDocUrl": page.agenda_doc_url,
        "status": "confirmed",
        "cancellationToken": token_plain,
        "ics": ics_invite,
    }


@transaction.atomic
def cancel_public_booking_reservation(
    *,
    booking_slug: str,
    reservation_id: UUID,
    body: dict[str, Any],
) -> dict[str, Any]:
    """Cancel a booking reservation using constant-time SHA-256 verification of cancellationToken."""
    try:
        slug = validate_booking_slug(booking_slug)
    except BookingValidationError:
        raise CalendarRefusalError(404, None, "not-found") from None

    page = BookingPage.objects.select_for_update().filter(slug=slug).first()
    if page is None:
        raise CalendarRefusalError(404, None, "not-found")

    reservation = (
        BookingSlotReservation.objects.select_for_update()
        .filter(id=reservation_id, booking_page_id=page.id)
        .first()
    )
    if reservation is None:
        raise CalendarRefusalError(404, None, "not-found")

    supplied_token = body.get("cancellationToken", "")
    if not verify_cancellation_token(supplied_token, bytes(reservation.cancellation_token_sha256)):
        raise CalendarRefusalError(403, "invalid_cancellation_token", "forbidden")

    if reservation.status == "cancelled":
        raise CalendarRefusalError(409, "reservation_already_cancelled", "conflict")

    now = datetime.now(tz=UTC)
    reservation.status = "cancelled"
    reservation.cancelled_at = now
    reservation.save(update_fields=["status", "cancelled_at", "updated_at"])

    ics_cancel = ""
    if reservation.event_id:
        ev = CalendarEvent.objects.select_for_update().filter(id=reservation.event_id).first()
        if ev is not None:
            if ev.status != "cancelled":
                ev.status = "cancelled"
                ev.sequence += 1
                ev.revision += 1
                ev.save(update_fields=["status", "sequence", "revision", "updated_at"])
            ics_cancel = serialize_calendar(
                events=(_to_ics_event(ev, viewer_membership_id=page.host_membership_id),),
                method="CANCEL",
            )

    if not ics_cancel:
        fallback_ev = IcsEvent(
            uid=reservation.uid,
            dtstamp=now,
            dtstart=reservation.starts_at,
            dtend=reservation.ends_at,
            summary=page.title,
            status="CANCELLED",
            sequence=1,
            timezone=page.timezone,
        )
        ics_cancel = serialize_calendar(events=(fallback_ev,), method="CANCEL")

    return {
        "reservationId": str(reservation.id),
        "status": "cancelled",
        "cancelledAt": _format_iso_utc(reservation.cancelled_at or now),
        "ics": ics_cancel,
    }
