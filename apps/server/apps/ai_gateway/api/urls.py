"""Organisation-scoped workspace AI policy, consent, translation, and live-caption routes."""

from django.urls import path

from . import views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"

H3_2_LIVE_TRANSLATION_URLS = [
    path(
        ROOT + "channels/<uuid:channel_id>/actions/translate-message",
        views.translate_message,
    ),
    path(
        ROOT + "channels/<uuid:channel_id>/call-captions/session",
        views.call_captions_session,
    ),
    path(
        ROOT + "channels/<uuid:channel_id>/call-captions/chunks",
        views.call_captions_chunks,
    ),
]

urlpatterns = [
    path(ROOT + "ai/policy", views.policy),
    path(ROOT + "channels/<uuid:channel_id>/ai", views.channel_policy),
    path(ROOT + "ai/consent", views.consent),
    path(ROOT + "attachments/<uuid:attachment_id>/actions/transcribe", views.transcribe),
    *H3_2_LIVE_TRANSLATION_URLS,
]

ALL_AI_GATEWAY_URLPATTERNS = list(urlpatterns)
