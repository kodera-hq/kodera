"""Local schema profile: customer, queue, workspace and replay-store applications.

Loaded by config.settings.test, and named by schema commands that must see the queue
(`--settings=config.settings.job_queue`). QUEUE_APPS remains the queue-only inventory. The profiles the API image is started with
do not load it: config.settings.customer_http installs the queue and the replay store itself, for
the staff intake (docs/specs/ORGANISATION_INTAKE.md §4), without the workspace schema or the mail
transport, and config.settings.dev installs neither.

The mail sender's transport and seal key are read here, once, and a malformed value stops the
process (docs/specs/OUTBOX_MAIL_SENDER.md §6). Unset, each is None: no message can be enqueued
without the key, and run_deliveries refuses to run without both.

It is also the operator profile the invited pilot's commands run under
(docs/specs/FIRST_OWNER_BOOTSTRAP.md §§3.7, 3.8), so it reads what the API's profile,
config.settings.customer_http, reads for them, from the same variables and with the same values as
the API's deployment: KODERA_INTAKE_ADMITTED, the gate every one of those commands refuses behind;
KODERA_CONTACT_SEAL_KEY, the key the intake sealed the intended owner's contact with; and
KODERA_AUTH_TRUST, whose pinned keys and customer lane the realm's verify reads (§5.5).
"""

import os

from apps.billing.configuration import (
    PAYMENT_TERMS_DAYS,
    issuer_from_environment as billing_issuer,
    series_from_environment as billing_series,
)
from apps.docs.configuration import collaboration_settings
from apps.outbox.mail.links import origins_from_environment, setup_redirect_from_environment
from apps.outbox.mail.seal import key_from_environment
from apps.outbox.mail.transport import transport_from_environment
from apps.outbox.realm.keycloak import origins_from_environment as realm_origins_from_environment
from config.environment import auth_trust, billing_enabled, intake_admitted, legal_text_origin
from config.workspace_features import media_gateway_socket, notification_settings
from core.sealing import key_from_environment as sealing_key_from_environment

from .persistence import *

# KODERA_LOOPBACK_ISSUERS, from config.settings.persistence, which read the staff issuer with it,
# is False here unless config.settings.e2e_operator is the selected module.
QUEUE_APPS = ("apps.jobs", "apps.outbox", "apps.audit")
REPLAY_APPS = ("core.idempotency",)
INSTALLED_APPS = [
    *INSTALLED_APPS,
    *QUEUE_APPS,
    "apps.workspaces",
    "apps.billing",
    "apps.legal",
    "apps.tenancy",
    *REPLAY_APPS,
    "apps.engine_intents",
    "apps.support",
    "apps.media",
    "apps.notifications",
    "apps.docs",
]

# Plaintext SMTP only to a loopback address or `localhost` here; no deployed name is exempt.
KODERA_MAIL_TRANSPORT = transport_from_environment(os.environ, insecure_hosts=frozenset())
KODERA_MAIL_LINK_ORIGINS = origins_from_environment(os.environ)
# The legal texts' public origin, for the URLs the order confirmation names (apps/legal).
KODERA_LEGAL_TEXT_ORIGIN = legal_text_origin(os.environ)
KODERA_OUTBOX_SEAL_KEY = key_from_environment(os.environ)
# The directory of the realm worker clients' secrets, one file per realm, read per realm access
# delivery (docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.5). A path, never a secret; unset, the
# run_realm_deliveries command refuses to run.
KODERA_REALM_WORKER_SECRET_DIR = os.environ.get("KODERA_REALM_WORKER_SECRET_DIR") or None
# The pinned Keycloak origins the realm access delivery talks to (§6.1.5): the public host for the
# token endpoint and the admin host for the Admin REST API (the public host answers 403 on /admin).
# Never derived from a delivery row; a malformed value stops the process.
KODERA_REALM_ORIGINS = realm_origins_from_environment(os.environ)

# FIRST_OWNER_BOOTSTRAP.md §3.8: every operator command is refused until this database's cutover is
# declared final. Off unless KODERA_INTAKE_ADMITTED is `1`.
KODERA_INTAKE_ADMITTED = intake_admitted(os.environ)
# The intake's contact seal key, the API's own value; a malformed value stops the process.
KODERA_CONTACT_SEAL_KEY = sealing_key_from_environment(os.environ, "KODERA_CONTACT_SEAL_KEY")
# The trust list the API verifies with, read here to verify a pilot realm's published keys against
# it (§5.5 step 3.3). A loopback issuer is refused unless this profile is selected as
# config.settings.e2e_operator.
KODERA_AUTH_TRUST = auth_trust(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)

# Required only when issuing or reissuing, never at existing command/profile startup.
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

# The legal entity that issues invoices, and the invoice number series (apps/billing/configuration.py).
KODERA_BILLING_ISSUER = billing_issuer(os.environ)
KODERA_INVOICE_SERIES = billing_series(os.environ)
KODERA_INVOICE_PAYMENT_TERMS_DAYS = PAYMENT_TERMS_DAYS

# BILLING_MODEL.md §4.1: `cancel_unpaid_orders` ends unpaid orders and credits their invoices. Off
# until the legal lane rules on that lapse; `1` enables it.
KODERA_UNPAID_LAPSE_ENABLED = os.environ.get("KODERA_UNPAID_LAPSE_ENABLED") == "1"
# Whether Core bills: KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = billing_enabled(os.environ)
KODERA_MEDIA_GATEWAY_SOCKET = media_gateway_socket(os.environ)
(KODERA_NOTIFICATION_SEAL_KEY, KODERA_PUSH_VAPID_PUBLIC_KEY) = notification_settings(os.environ)
(
    KODERA_COLLAB_TICKET_KEY,
    KODERA_COLLAB_ENGINE_URL,
    KODERA_COLLAB_PUBLIC_URL,
) = collaboration_settings(os.environ)
