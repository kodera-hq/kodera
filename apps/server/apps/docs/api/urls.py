"""Native document routes; no chat-thread promotion or bridge."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "documents", views.documents),
    path(ROOT + "documents/<uuid:document_id>", views.document),
    path(ROOT + "documents/<uuid:document_id>/backlinks", views.backlinks),
    path(ROOT + "documents/<uuid:document_id>/collab-session", views.session),
    path(ROOT + "search", views.search),
]
