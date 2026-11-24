"""Workspace smart calendar, CalDAV source, and public sovereign booking URL routes."""

from django.urls import path

from . import views

WS_ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/calendar/"
PUBLIC_ROOT = "api/v1/booking/<str:booking_slug>"

urlpatterns = [
    path(WS_ROOT + "events", views.events),
    path(WS_ROOT + "events/<uuid:event_id>", views.event_detail),
    path(WS_ROOT + "events.ics", views.export_ics),
    path(WS_ROOT + "sources", views.sources),
    path(WS_ROOT + "sources/<uuid:source_id>", views.source_detail),
    path(WS_ROOT + "sources/<uuid:source_id>/actions/sync", views.source_sync),
    path(WS_ROOT + "booking-pages", views.booking_pages),
    path(WS_ROOT + "booking-pages/<uuid:booking_page_id>", views.booking_page_detail),
    path(PUBLIC_ROOT, views.public_booking_page),
    path(PUBLIC_ROOT + "/reservations", views.public_booking_reservations),
    path(
        PUBLIC_ROOT + "/reservations/<uuid:reservation_id>/actions/cancel",
        views.public_booking_cancel,
    ),
]
