"""Native document routes; no chat-thread promotion or bridge."""

from django.urls import path

from . import collections, views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "collections", collections.collections),
    path(ROOT + "collections/<uuid:collection_id>", collections.collection),
    path(ROOT + "collections/<uuid:collection_id>/query", collections.query),
    path(ROOT + "collections/<uuid:collection_id>/rows/<uuid:document_id>", collections.row),
    path(ROOT + "documents", views.documents),
    path(ROOT + "documents/<uuid:document_id>", views.document),
    path(ROOT + "documents/<uuid:document_id>/backlinks", views.backlinks),
    path(ROOT + "documents/<uuid:document_id>/collab-session", views.session),
    path(ROOT + "search", views.search),
]
