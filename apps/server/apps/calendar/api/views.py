"""Workspace calendar, CalDAV source, and public sovereign booking HTTP views."""

from __future__ import annotations

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from . import http, permissions

EVENT_CREATE_FIELDS = {
    "title",
    "description",
    "location",
    "startsAt",
    "endsAt",
    "timezone",
    "rrule",
    "visibility",
    "attendees",
    "alarmMinutesBefore",
    "visioUrl",
    "agendaDocUrl",
}
EVENT_PATCH_FIELDS = {
    "title",
    "description",
    "location",
    "startsAt",
    "endsAt",
    "status",
    "visibility",
    "rrule",
    "visioUrl",
    "agendaDocUrl",
}
SOURCE_CREATE_FIELDS = {
    "name",
    "provider",
    "calendarUrl",
    "username",
    "password",
}
BOOKING_PAGE_FIELDS = {
    "slug",
    "title",
    "description",
    "timezone",
    "durationMinutes",
    "bufferMinutes",
    "availabilityWindows",
    "visioUrl",
    "agendaDocUrl",
}
RESERVE_FIELDS = {
    "startsAt",
    "guestName",
    "guestEmail",
    "guestNotes",
}
CANCEL_FIELDS = {
    "cancellationToken",
}


@declares(permissions.LIST_EVENTS, permissions.CREATE_EVENT)
def events(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        return http.json_response(
            service.list_calendar_events(
                verified=verified,
                organisation_id=organisation_id,
                from_iso=request.GET.get("from"),
                to_iso=request.GET.get("to"),
            )
        )

    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, EVENT_CREATE_FIELDS, {"title", "startsAt", "endsAt"})
        payload, etag = service.create_calendar_event(
            verified=verified,
            organisation_id=organisation_id,
            body=data,
            request_id=request_id,
        )
        return http.json_response(payload, status=201, etag=etag)

    return http.serve(
        request,
        {"GET": get, "POST": post},
        organisation_id,
        operations=(permissions.LIST_EVENTS, permissions.CREATE_EVENT),
    )


@declares(permissions.UPDATE_EVENT, permissions.DELETE_EVENT)
def event_detail(request: HttpRequest, organisation_id: UUID, event_id: UUID) -> HttpResponse:
    def patch(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, EVENT_PATCH_FIELDS, set())
        payload, etag = service.update_calendar_event(
            verified=verified,
            organisation_id=organisation_id,
            event_id=event_id,
            if_match=request.headers.get("If-Match"),
            body=data,
            request_id=request_id,
        )
        return http.json_response(payload, status=200, etag=etag)

    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        service.delete_calendar_event(
            verified=verified,
            organisation_id=organisation_id,
            event_id=event_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(
        request,
        {"PATCH": patch, "DELETE": delete},
        organisation_id,
        operations=(permissions.UPDATE_EVENT, permissions.DELETE_EVENT),
    )


@declares(permissions.EXPORT_ICS)
def export_ics(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        exported = service.export_workspace_ics(
            verified=verified,
            organisation_id=organisation_id,
        )
        accept = request.headers.get("Accept", "")
        if "text/calendar" in accept and "application/json" not in accept:
            resp = HttpResponse(
                exported["ics"].encode("utf-8"),
                status=200,
                content_type="text/calendar; charset=utf-8",
            )
            resp["Content-Disposition"] = f'attachment; filename="{exported["filename"]}"'
            return resp
        return http.json_response(exported, status=200)

    return http.serve(
        request,
        {"GET": get},
        organisation_id,
        operations=(permissions.EXPORT_ICS,),
    )


@declares(permissions.LIST_SOURCES, permissions.CREATE_SOURCE)
def sources(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        return http.json_response(
            service.list_caldav_sources(
                verified=verified,
                organisation_id=organisation_id,
            )
        )

    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(
            request,
            SOURCE_CREATE_FIELDS,
            {"name", "calendarUrl", "username", "password"},
        )
        payload = service.create_caldav_source(
            verified=verified,
            organisation_id=organisation_id,
            body=data,
            request_id=request_id,
        )
        return http.json_response(payload, status=201)

    return http.serve(
        request,
        {"GET": get, "POST": post},
        organisation_id,
        operations=(permissions.LIST_SOURCES, permissions.CREATE_SOURCE),
    )


@declares(permissions.DELETE_SOURCE)
def source_detail(request: HttpRequest, organisation_id: UUID, source_id: UUID) -> HttpResponse:
    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        service.delete_caldav_source(
            verified=verified,
            organisation_id=organisation_id,
            source_id=source_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(
        request,
        {"DELETE": delete},
        organisation_id,
        operations=(permissions.DELETE_SOURCE,),
    )


@declares(permissions.SYNC_SOURCE)
def source_sync(request: HttpRequest, organisation_id: UUID, source_id: UUID) -> HttpResponse:
    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if request.body:
            http.body(request, set(), set())
        payload = service.sync_caldav_source(
            verified=verified,
            organisation_id=organisation_id,
            source_id=source_id,
            request_id=request_id,
        )
        return http.json_response(payload, status=200)

    return http.serve(
        request,
        {"POST": post},
        organisation_id,
        operations=(permissions.SYNC_SOURCE,),
    )


@declares(permissions.LIST_BOOKING_PAGES, permissions.CREATE_BOOKING_PAGE)
def booking_pages(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: VerifiedAccessToken, _request_id: str) -> HttpResponse:
        return http.json_response(
            service.list_booking_pages(
                verified=verified,
                organisation_id=organisation_id,
            )
        )

    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(
            request,
            BOOKING_PAGE_FIELDS,
            {"slug", "title", "availabilityWindows"},
        )
        payload = service.create_booking_page(
            verified=verified,
            organisation_id=organisation_id,
            body=data,
            request_id=request_id,
        )
        return http.json_response(payload, status=201)

    return http.serve(
        request,
        {"GET": get, "POST": post},
        organisation_id,
        operations=(permissions.LIST_BOOKING_PAGES, permissions.CREATE_BOOKING_PAGE),
    )


@declares(permissions.DELETE_BOOKING_PAGE)
def booking_page_detail(
    request: HttpRequest, organisation_id: UUID, booking_page_id: UUID
) -> HttpResponse:
    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        service.delete_booking_page(
            verified=verified,
            organisation_id=organisation_id,
            booking_page_id=booking_page_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return http.serve(
        request,
        {"DELETE": delete},
        organisation_id,
        operations=(permissions.DELETE_BOOKING_PAGE,),
    )


@declares(permissions.GET_PUBLIC_BOOKING)
def public_booking_page(request: HttpRequest, booking_slug: str) -> HttpResponse:
    def get(_request_id: str) -> HttpResponse:
        return http.json_response(
            service.get_public_booking_page(
                booking_slug=booking_slug,
                from_iso=request.GET.get("from"),
                to_iso=request.GET.get("to"),
            )
        )

    return http.serve_public(
        request,
        {"GET": get},
        booking_slug=booking_slug,
        operations=(permissions.GET_PUBLIC_BOOKING,),
    )


@declares(permissions.RESERVE_PUBLIC_BOOKING)
def public_booking_reservations(request: HttpRequest, booking_slug: str) -> HttpResponse:
    def post(_request_id: str) -> HttpResponse:
        data = http.body(request, RESERVE_FIELDS, {"startsAt", "guestName", "guestEmail"})
        return http.json_response(
            service.reserve_public_booking_slot(
                booking_slug=booking_slug,
                body=data,
            ),
            status=201,
        )

    return http.serve_public(
        request,
        {"POST": post},
        booking_slug=booking_slug,
        operations=(permissions.RESERVE_PUBLIC_BOOKING,),
    )


@declares(permissions.CANCEL_PUBLIC_BOOKING)
def public_booking_cancel(
    request: HttpRequest, booking_slug: str, reservation_id: UUID
) -> HttpResponse:
    def post(_request_id: str) -> HttpResponse:
        data = http.body(request, CANCEL_FIELDS, {"cancellationToken"})
        return http.json_response(
            service.cancel_public_booking_reservation(
                booking_slug=booking_slug,
                reservation_id=reservation_id,
                body=data,
            ),
            status=200,
        )

    return http.serve_public(
        request,
        {"POST": post},
        booking_slug=booking_slug,
        operations=(permissions.CANCEL_PUBLIC_BOOKING,),
    )
