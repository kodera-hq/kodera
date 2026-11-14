"""URL patterns for `/staff/v1/{read,triage,ops}/*`."""

from django.urls import path

from . import views

urlpatterns = [
    # Read plane
    path("read/overview", views.overview_view),
    path("read/organisations", views.organisations_view),
    path("read/pipeline", views.pipeline_view),
    path("read/feedback", views.feedback_view),
    path("read/engineering", views.engineering_view),
    path("read/finops", views.finops_view),
    path("read/sre", views.sre_view),
    path("read/security", views.security_view),
    # Triage plane
    path("triage/feedback/<uuid:feedback_id>", views.triage_feedback_view),
    path("triage/feedback/<uuid:feedback_id>/github-draft", views.feedback_github_draft_view),
    path("triage/deals", views.triage_deals_view),
    path("triage/waitlist/open-cohort", views.waitlist_open_cohort_view),
    path("triage/sar", views.create_sar_view),
    path("triage/sar/<uuid:sar_id>/complete", views.complete_sar_view),
    # Ops plane (WebAuthn hwk <= 320s + ops-admin Host)
    path("ops/reconcile/jobs/<uuid:job_id>", views.reconcile_job_view),
    path("ops/reconcile/deliveries/<uuid:delivery_id>", views.reconcile_delivery_view),
    path("ops/staff-roles/grant", views.grant_staff_role_view),
    path("ops/staff-roles/revoke", views.revoke_staff_role_view),
    path("ops/issuer-snapshots", views.register_issuer_snapshot_view),
    path("ops/finops/snapshots", views.record_finops_snapshot_view),
    path("ops/audit-chain/verify", views.verify_audit_chain_view),
]
