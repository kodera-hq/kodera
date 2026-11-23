"""Organisation-scoped workspace AI policy, consent, and transcription routes."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "ai/policy", views.policy),
    path(ROOT + "channels/<uuid:channel_id>/ai", views.channel_policy),
    path(ROOT + "ai/consent", views.consent),
    path(ROOT + "attachments/<uuid:attachment_id>/actions/transcribe", views.transcribe),
]
