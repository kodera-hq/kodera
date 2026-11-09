"""Explicit local customer HTTP profile: the customer reads, the staff intake and the workspace.

The intake (`createOrganisation`, docs/specs/ORGANISATION_INTAKE.md) is the first route that
enqueues a job and the first that answers a POST, so this profile installs the job queue and the
audit record it writes, and the replay store (docs/specs/JOB_QUEUE.md §3.1,
docs/specs/IDEMPOTENCY_REPLAY.md §2.1). `getWorkspace` and `initialiseWorkspace`
(docs/specs/PILOT_WORKSPACE_ONBOARDING.md) read the realm job and the audit record, write the
workspace and its audit event, and use the replay store, so it installs the workspace schema too.
It does not install `apps.outbox`, whose deliveries neither writes, and it reads no mail
transport: the image sends no mail.
"""

import os

from apps.billing.configuration import (
    PAYMENT_TERMS_DAYS,
    issuer_from_environment as billing_issuer,
    payment_return_origins,
    series_from_environment as billing_series,
    stripe_from_environment,
)
from config.environment import (
    auth_trust,
    billing_enabled,
    console_client_id,
    intake_admitted,
    legal_text_origin,
    tenant_app_urls,
)
from core.sealing import key_from_environment

from .persistence import *

ROOT_URLCONF = "config.customer_urls"
CUSTOMER_HTTP_APPS = (
    "apps.jobs",
    "apps.audit",
    "apps.workspaces",
    "apps.billing",
    "apps.legal",
    "apps.tenancy",
    "core.idempotency",
    "apps.engine_intents",
    "apps.support",
)
INSTALLED_APPS = [*INSTALLED_APPS, *CUSTOMER_HTTP_APPS]
# The deployable API profile: KODERA_LOOPBACK_ISSUERS, from config.settings.persistence, is False
# here unless config.settings.test, config.settings.e2e or config.settings.e2e_operator is selected.
# Every other selected profile refuses a loopback issuer.
KODERA_AUTH_TRUST = auth_trust(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)

# Validate only inside the directory operation; no fallback or live key provisioning.
KODERA_MEMBERSHIP_CURSOR_KEY = os.environ.get("KODERA_MEMBERSHIP_CURSOR_KEY")

# Route-local validation: an absent/malformed discovery key must not stop existing operations.
KODERA_DISCOVERY_HMAC_KEY = os.environ.get("KODERA_DISCOVERY_HMAC_KEY")
# The browser origins (the Console's) discovery admits, comma-separated. Unset admits no browser
# origin; a malformed value fails discovery alone, route-locally, never the other operations.
KODERA_CONSOLE_ORIGINS = os.environ.get("KODERA_CONSOLE_ORIGINS")
# Where a support ticket is mailed (docs/specs/SUPPORT_TICKETS.md §5). Unset or malformed,
# createSupportTicket answers 503 and stores nothing; the other operations are unaffected.
KODERA_SUPPORT_MAILBOX = os.environ.get("KODERA_SUPPORT_MAILBOX") or None
# createPaymentLink's `return_url` is held to the console's own origins, read by discovery's parser
# (apps/billing/configuration.py payment_return_origins).
KODERA_PAYMENT_RETURN_ORIGINS = payment_return_origins(KODERA_CONSOLE_ORIGINS)

# FIRST_OWNER_BOOTSTRAP.md §3.8: the intake is refused until this database's ADR-0015 cutover is
# declared final. Off unless KODERA_INTAKE_ADMITTED is `1`.
KODERA_INTAKE_ADMITTED = intake_admitted(os.environ)
# The key the intake seals the intended owner's contact with. Unset, the intake is refused; a
# malformed value stops the process.
KODERA_CONTACT_SEAL_KEY = key_from_environment(os.environ, "KODERA_CONTACT_SEAL_KEY")

# The legal entity that issues invoices, and the invoice number series (apps/billing/configuration.py).
KODERA_BILLING_ISSUER = billing_issuer(os.environ)
KODERA_INVOICE_SERIES = billing_series(os.environ)
KODERA_INVOICE_PAYMENT_TERMS_DAYS = PAYMENT_TERMS_DAYS

# The payment provider: Stripe when both of its keys are in the environment, none otherwise, so a
# payment link is refused rather than faked (apps/billing/configuration.py).
(
    KODERA_PAYMENT_PROVIDER,
    KODERA_STRIPE_SECRET_KEY,
    KODERA_STRIPE_WEBHOOK_SECRET,
) = stripe_from_environment(os.environ)

# Where an accepted legal text is read, permanently (apps/legal): unset, no URL is given.
KODERA_LEGAL_TEXT_ORIGIN = legal_text_origin(os.environ)
KODERA_TENANT_APP_URLS = tenant_app_urls(os.environ)
# Whether Core bills: KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = billing_enabled(os.environ)
