"""Fixed command-only profile for the existing shared Core database.

No local settings, HTTP entrypoint or infrastructure credentials. This graph adds
the outbox to the shared Core database and installs the schemas required by explicit billing,
erasure and tenant-agent operator commands. Fiscal/cutoff admission remains distinct from the
periodic retention processing role. Notification schema is required by the erasure migration
graph; its existing dispatch command still needs an explicitly supplied worker-only application
key. Loading command help never reads such a key. This profile routes nothing.
"""

import os

from apps.billing.configuration import series_from_environment as billing_series
from apps.outbox.mail.links import origins_from_environment, setup_redirect_from_environment
from apps.outbox.mail.seal import key_from_environment
from apps.outbox.mail.transport import transport_from_environment
from apps.outbox.realm.keycloak import origins_from_environment as realm_origins_from_environment
from config.deploy_environment import operator_deployment
from config.environment import (
    auth_trust,
    billing_enabled,
    intake_admitted,
    staff_issuer,
    tenant_app_urls,
)
from core.sealing import key_from_environment as contact_key_from_environment

from .base import APPEND_SLASH as APPEND_SLASH, TIME_ZONE as TIME_ZONE, USE_TZ as USE_TZ

_validated = operator_deployment(os.environ)
SECRET_KEY = _validated["SECRET_KEY"]
ALLOWED_HOSTS = _validated["ALLOWED_HOSTS"]
DATABASES = _validated["DATABASES"]
DEBUG = False
ROOT_URLCONF: str | None = None
WSGI_APPLICATION: str | None = None
MIDDLEWARE: list[str] = []
# Support for send_support_tickets (SUPPORT_TICKETS.md §6), and billing for its staff commands
# (settle_complimentary_order, BILLING_MODEL.md §4.2), with the two
# applications its schema depends on. Engine intents for the tenant agent's staff commands
# (enrol_tenant_agent, revoke_tenant_agent: ADR-0016); every application it imports is already
# here. Workspaces supports canonical community provisioning; its HTTP routes stay excluded.
INSTALLED_APPS = [
    "apps.identity",
    "apps.orgs",
    "apps.jobs",
    "apps.audit",
    "apps.outbox",
    "apps.legal",
    "apps.tenancy",
    "apps.billing",
    "apps.support",
    "apps.engine_intents",
    "apps.workspaces",
    # Quota and erasure migrations share native content/notification schema without routing HTTP.
    "apps.docs",
    "apps.extensions",
    "apps.media",
    "apps.notifications",
]

KODERA_LOOPBACK_ISSUERS = False
KODERA_AUTH_TRUST = auth_trust(os.environ)
KODERA_STAFF_ISSUER = staff_issuer(os.environ)
KODERA_INTAKE_ADMITTED = intake_admitted(os.environ)
# Billing's staff command numbers its credit note in `AV-` and the invoices' series, which must be
# the API's own: one counter per series, gapless. So the series is read only when given, through
# the API's validator, and never defaulted; unset, settle_complimentary_order refuses before it
# reads anything. The tenant line it prints reads the API's application URL templates.
KODERA_INVOICE_SERIES = (
    billing_series(os.environ) if os.environ.get("KODERA_INVOICE_SERIES") else None
)
KODERA_TENANT_APP_URLS = tenant_app_urls(os.environ)
# Whether Core bills: KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = billing_enabled(os.environ)
KODERA_CONTACT_SEAL_KEY = contact_key_from_environment(os.environ, "KODERA_CONTACT_SEAL_KEY")
KODERA_OUTBOX_SEAL_KEY = key_from_environment(os.environ)
KODERA_MAIL_LINK_ORIGINS = origins_from_environment(os.environ)
# Existing transport policy: STARTTLS remotely; plaintext only on loopback.
KODERA_MAIL_TRANSPORT = transport_from_environment(os.environ, insecure_hosts=frozenset())

# Existing issuance validation remains at the operation boundary, not migration/help.
KODERA_OWNER_CLAIM_LIFETIME_SECONDS = os.environ.get(
    "KODERA_OWNER_CLAIM_LIFETIME_SECONDS", "259200"
)
KODERA_OWNER_CLAIM_LINK = os.environ.get("KODERA_OWNER_CLAIM_LINK")
# The Console's invitation acceptance page (docs/specs/INVITATIONS.md §4), read by send_invitations.
KODERA_INVITATION_LINK = os.environ.get("KODERA_INVITATION_LINK")
# The support mailbox send_support_tickets mails each ticket to (docs/specs/SUPPORT_TICKETS.md §6).
KODERA_SUPPORT_MAILBOX = os.environ.get("KODERA_SUPPORT_MAILBOX") or None
# Where the realm's account set-up mail returns the invitee (docs/specs/INVITATIONS.md §4): a
# console URL its realm client lists. Unset, Keycloak ends on its own page; malformed, the process
# stops.
KODERA_REALM_SETUP_REDIRECT = setup_redirect_from_environment(os.environ, KODERA_MAIL_LINK_ORIGINS)

# Realm access delivery (docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.5), as in job_queue: a path to the
# worker clients' secrets, never a secret, and the pinned Keycloak origins. Unset, the
# run_realm_deliveries command refuses to run; a malformed origin stops the process.
KODERA_REALM_WORKER_SECRET_DIR = os.environ.get("KODERA_REALM_WORKER_SECRET_DIR") or None
KODERA_REALM_ORIGINS = realm_origins_from_environment(os.environ)

# Canonical provisioning is opt-in and needs the same exact binding as the API process.
KODERA_DEFAULT_COMMUNITY_ORG_SLUG = os.environ.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "")
KODERA_DEFAULT_COMMUNITY_ISSUER = os.environ.get("KODERA_DEFAULT_COMMUNITY_ISSUER", "")
KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID = os.environ.get(
    "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID", ""
)
