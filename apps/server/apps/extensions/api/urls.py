"""Customer routes for workspace import simulation/execution and coexistence bridges."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "imports/preview", views.import_preview),
    path(ROOT + "imports/execute", views.import_execute),
    path(ROOT + "coexistence/bridges", views.coexistence_bridges),
    path(ROOT + "coexistence/bridges/<uuid:bridge_id>", views.coexistence_bridge),
    path("api/v1/coexistence/bridges/<uuid:bridge_id>/events", views.coexistence_webhook),
]
