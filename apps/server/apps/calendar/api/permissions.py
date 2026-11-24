"""Contract-bound operation declarations for workspace calendar and sovereign booking routes."""

from core.api.scopes import Operation

LIST_EVENTS = Operation("GET", "listCalendarEvents", "workspace_calendar:read")
CREATE_EVENT = Operation("POST", "createCalendarEvent", "workspace_calendar:create")
UPDATE_EVENT = Operation("PATCH", "updateCalendarEvent", "workspace_calendar:update")
DELETE_EVENT = Operation("DELETE", "deleteCalendarEvent", "workspace_calendar:delete")
EXPORT_ICS = Operation("GET", "exportCalendarIcs", "workspace_calendar:export")

LIST_SOURCES = Operation("GET", "listCaldavSources", "caldav_source:read")
CREATE_SOURCE = Operation("POST", "createCaldavSource", "caldav_source:create")
DELETE_SOURCE = Operation("DELETE", "deleteCaldavSource", "caldav_source:delete")
SYNC_SOURCE = Operation("POST", "syncCaldavSource", "caldav_source:act")

LIST_BOOKING_PAGES = Operation("GET", "listBookingPages", "booking_page:read")
CREATE_BOOKING_PAGE = Operation("POST", "createBookingPage", "booking_page:create")
DELETE_BOOKING_PAGE = Operation("DELETE", "deleteBookingPage", "booking_page:delete")

GET_PUBLIC_BOOKING = Operation("GET", "getPublicBookingPage", "booking_page:read")
RESERVE_PUBLIC_BOOKING = Operation("POST", "reservePublicBookingSlot", "booking_page:act")
CANCEL_PUBLIC_BOOKING = Operation("POST", "cancelPublicBookingReservation", "booking_page:act")
