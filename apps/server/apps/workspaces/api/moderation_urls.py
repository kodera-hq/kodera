"""Workspace safety routes, included by the customer HTTP profile."""

from django.urls import path

from . import iam, moderation as views, security_posture

ROOT = "api/v1/organisations/<uuid:organisation_id>/workspace/"
urlpatterns = [
    path(ROOT + "security-posture", security_posture.posture),
    path(ROOT + "security-posture/actions/remediate", security_posture.remediate),
    path(ROOT + "roles", iam.roles),
    path(ROOT + "roles/<uuid:role_id>", iam.role),
    path(ROOT + "members/<uuid:membership_id>/roles", iam.member_roles),
    path(ROOT + "channels/<uuid:channel_id>/overrides", iam.overrides),
    path(ROOT + "profile", iam.profile),
    path(ROOT + "bans", iam.bans),
    path(ROOT + "audit-logs", iam.audit_logs),
    path(ROOT + "moderation", views.moderation),
    path(ROOT + "moderators/<uuid:membership_id>", views.moderator_detail),
    path(ROOT + "reports", views.reports),
    path(ROOT + "reports/<uuid:report_id>", views.report_detail),
    path(ROOT + "invite-links", views.links),
    path(ROOT + "invite-links/<uuid:invite_link_id>", views.link_detail),
    path("api/v1/workspace-invites/preview", views.preview),
    path("api/v1/workspace-invites/redeem", views.redeem),
]
