"""Workspace safety routes, included by the customer HTTP profile."""

from django.urls import path

from . import moderation as views

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "moderation", views.moderation),
    path(ROOT + "reports", views.reports),
    path(ROOT + "reports/<uuid:report_id>", views.report_detail),
    path(ROOT + "invite-links", views.links),
    path(ROOT + "invite-links/<uuid:invite_link_id>", views.link_detail),
    path("api/v1/workspace-invites/preview", views.preview),
    path("api/v1/workspace-invites/redeem", views.redeem),
]
