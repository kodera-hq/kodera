"""Anonymous discovery, admitted customer reads, the staff intake, membership administration and
invitations, the workspace operations,
the billing operations, the legal documents and the DPA, the agents' engine commands, and the
existing diagnostics."""

from django.urls import path

from apps.billing.api import tenants as tenancy, views as billing
from apps.billing.api.help_context import help_context
from apps.billing.api.membership_count import membership_count
from apps.billing.api.slug_availability import slug_availability
from apps.engine_intents.api.views import ack, commands, result
from apps.identity.api.discovery import discovery
from apps.identity.api.views import me
from apps.legal.api import views as legal
from apps.orgs.api.bootstrap import organisation_bootstrap
from apps.orgs.api.detail import organisation_detail
from apps.orgs.api.intake import organisations
from apps.orgs.api.invitations import (
    accept_invitation,
    invitation,
    organisation_invitations,
    preview_invitation,
    resend_invitation,
)
from apps.orgs.api.membership_detail import membership
from apps.orgs.api.memberships import membership_directory
from apps.orgs.api.notice_contacts import notice_contacts
from apps.orgs.api.owner_claims import consume_owner_claim
from apps.support.api.community import community_support_tickets
from apps.support.api.views import support_tickets
from apps.workspaces.api import administration as structure
from apps.workspaces.api.instant_claim import instant_claim
from apps.workspaces.api.views import initialise, workspace

from .urls import urlpatterns as diagnostics

urlpatterns = [
    *diagnostics,
    path("api/v1/me", me),
    path("api/v1/workspaces/instant-claim", instant_claim),
    path("api/v1/auth/discover", discovery),
    path("api/v1/organisations", organisations),
    path("api/v1/organisations/<uuid:organisation_id>", organisation_detail),
    path("api/v1/organisations/<uuid:organisation_id>/bootstrap", organisation_bootstrap),
    path("api/v1/organisations/<uuid:organisation_id>/notice-contacts", notice_contacts),
    path("api/v1/organisations/<str:organisation_id>/memberships", membership_directory),
    path(
        "api/v1/organisations/<uuid:organisation_id>/memberships/count",
        membership_count,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/memberships/<uuid:membership_id>",
        membership,
    ),
    path("api/v1/owner-claims/actions/consume", consume_owner_claim),
    # Support tickets (docs/specs/SUPPORT_TICKETS.md): createSupportTicket only.
    path("api/v1/support/tickets", support_tickets),
    path("api/v1/community/support/tickets", community_support_tickets),
    # Invitations (docs/specs/INVITATIONS.md).
    path(
        "api/v1/organisations/<uuid:organisation_id>/invitations",
        organisation_invitations,
    ),
    path("api/v1/invitations/accept", accept_invitation),
    path("api/v1/invitations/preview", preview_invitation),
    path("api/v1/invitations/<uuid:invitation_id>", invitation),
    path("api/v1/invitations/<uuid:invitation_id>/actions/resend", resend_invitation),
    path("api/v1/organisations/<uuid:organisation_id>/workspace", workspace),
    path("api/v1/organisations/<uuid:organisation_id>/workspace/actions/initialise", initialise),
    # The structure administration (docs/specs/ESPACE_STRUCTURE.md §3).
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/categories",
        structure.categories,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/categories/<uuid:category_id>",
        structure.category,
    ),
    path("api/v1/organisations/<uuid:organisation_id>/workspace/channels", structure.channels),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/channels/<uuid:channel_id>",
        structure.channel,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/channels/<uuid:channel_id>"
        "/actions/archive",
        structure.archive,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/channels/<uuid:channel_id>"
        "/actions/unarchive",
        structure.unarchive,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/channels/<uuid:channel_id>/access",
        structure.access,
    ),
    path(
        "api/v1/organisations/<uuid:organisation_id>/workspace/administration",
        structure.administration,
    ),
    path("api/v1/catalog/plans", billing.plans),
    path("api/v1/catalog/packs", billing.packs),
    path("api/v1/catalog/capacity-tiers", billing.capacity_tiers),
    path("api/v1/catalog/prices", billing.prices),
    path("api/v1/organisations/<uuid:organisation_id>/orders", billing.orders),
    path("api/v1/orders/<uuid:order_id>", billing.order),
    path("api/v1/orders/<uuid:order_id>/actions/cancel", billing.cancel_order),
    path("api/v1/organisations/<uuid:organisation_id>/subscriptions", billing.subscriptions),
    path("api/v1/slug-availability", slug_availability),
    path("api/v1/support/help-context", help_context),
    path("api/v1/organisations/<uuid:organisation_id>/tenants", tenancy.tenants),
    path("api/v1/tenants/<uuid:tenant_id>", tenancy.tenant),
    path("api/v1/tenants/<uuid:tenant_id>/status", tenancy.tenant_status),
    path("api/v1/organisations/<uuid:organisation_id>/status-summary", tenancy.status_summary),
    path("api/v1/subscriptions/<uuid:subscription_id>", billing.subscription),
    path("api/v1/organisations/<uuid:organisation_id>/invoices", billing.invoices),
    path("api/v1/invoices/<uuid:invoice_id>", billing.invoice),
    path("api/v1/organisations/<uuid:organisation_id>/credit-notes", billing.credit_notes),
    path("api/v1/credit-notes/<uuid:credit_note_id>", billing.credit_note),
    path("api/v1/invoices/<uuid:invoice_id>/payment-link", billing.payment_link),
    path("api/v1/invoices/<uuid:invoice_id>/download", billing.invoice_download),
    path("api/v1/organisations/<uuid:organisation_id>/dunning", billing.dunning),
    path("api/v1/legal-documents", legal.legal_documents),
    path(
        "api/v1/legal-documents/<str:code>/<str:version>/<str:locale>",
        legal.legal_document_text,
    ),
    path("api/v1/organisations/<uuid:organisation_id>/dpa", legal.dpa),
    path("api/v1/organisations/<uuid:organisation_id>/dpa/<uuid:dpa_id>", legal.dpa_detail),
    # The Agent API's command loop, for the engine member set only (ADR-0016).
    path("agent/v1/commands", commands),
    path("agent/v1/commands/<uuid:command_id>/ack", ack),
    path("agent/v1/commands/<uuid:command_id>/result", result),
]

handler404 = "core.api.errors.not_found"
handler500 = "core.api.errors.server_error"
