"""Customer routes for confidential transport; each operation enforces its opt-in gate."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/confidential/"
ROOM = ROOT + "rooms/<uuid:room_id>/"
urlpatterns = [
    path(ROOT + "devices", views.devices),
    path(ROOT + "devices/revoke", views.revoke),
    path(ROOT + "key-packages", views.packages),
    path(ROOT + "rooms", views.rooms),
    path(ROOM + "key-packages/claims", views.claims),
    path(ROOM + "commits", views.commits),
    path(ROOM + "participants/retire", views.retire),
    path(ROOM + "envelopes", views.envelopes),
]
