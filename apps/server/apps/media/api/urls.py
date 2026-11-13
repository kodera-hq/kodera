"""Organisation-scoped attachment and public-preview routes."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "attachments/uploads", views.uploads),
    path(ROOT + "attachments/<uuid:attachment_id>/complete", views.complete),
    path(ROOT + "attachments/<uuid:attachment_id>", views.attachment),
    path(ROOT + "unfurl", views.unfurl),
]
