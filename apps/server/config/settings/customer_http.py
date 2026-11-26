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
from apps.docs.configuration import collaboration_settings
from config.environment import (
    ai_actor_subjects,
    ai_client_ids,
    ai_mistral_api_key,
    android_assetlinks_sha256,
    app_origin,
    auth_trust,
    billing_enabled,
    console_client_id,
    edition,
    ee_audit_signing_seed,
    intake_admitted,
    ios_app_ids,
    legal_text_origin,
    livekit_room_service_config,
    matrix_domain_suffix,
    matrix_replay_transport_factory,
    mutation_rate_per_minute,
    self_serve_disposable_domains,
    staff_admin_hosts,
    staff_oidc_issuer,
    staff_oidc_jwks_url,
    staff_ops_hosts,
    synapse_admin_token,
    synapse_server_name,
    synapse_url,
    tenant_app_urls,
)
from config.workspace_features import (
    ai_gateway_enabled,
    ai_seal_key,
    calendar_seal_key,
    channel_governance_enabled,
    confidential_relay_enabled,
    media_gateway_socket,
    media_room_verifier_url,
    notification_settings,
)
from core.sealing import key_from_environment

from .persistence import *

ROOT_URLCONF = "config.customer_urls"
MIDDLEWARE = [*MIDDLEWARE, "apps.workspaces.quota_http.QuotaRefusalMiddleware"]
CUSTOMER_HTTP_APPS = (
    "apps.jobs",
    "apps.audit",
    "apps.workspaces",
    "apps.billing",
    "apps.legal",
    "apps.tenancy",
    "core.idempotency",
    "core.staff_api",
    "apps.engine_intents",
    "apps.support",
    "apps.media",
    "apps.notifications",
    "apps.docs",
    "apps.extensions",
    "apps.e2ee",
    "apps.confidential",
    "apps.ai_gateway",
    "apps.calendar",
)
INSTALLED_APPS = [*INSTALLED_APPS, *CUSTOMER_HTTP_APPS]
# The deployable API profile: KODERA_LOOPBACK_ISSUERS, from config.settings.persistence, is False
# here unless config.settings.test, config.settings.e2e or config.settings.e2e_operator is selected.
# Every other selected profile refuses a loopback issuer.
KODERA_SELF_SERVE_DISPOSABLE_DOMAINS = self_serve_disposable_domains(os.environ)
KODERA_APP_ORIGIN = app_origin(os.environ)
KODERA_AUTH_TRUST = auth_trust(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)

# Validate only inside the directory operation; no fallback or live key provisioning.
KODERA_MEMBERSHIP_CURSOR_KEY = os.environ.get("KODERA_MEMBERSHIP_CURSOR_KEY")

# Route-local validation: an absent/malformed discovery key must not stop existing operations.
KODERA_DISCOVERY_HMAC_KEY = os.environ.get("KODERA_DISCOVERY_HMAC_KEY")
# The browser origins (the Console's), comma-separated: the ones discovery admits and the only
# ones CORS names (core/api/edge.py). Unset admits no browser origin; a malformed value names
# none to CORS and fails discovery alone, route-locally, never the other operations.
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
KODERA_OUTBOX_SEAL_KEY = key_from_environment(os.environ, "KODERA_OUTBOX_SEAL_KEY")
KODERA_PASSPORT_MAGIC_LINK = os.environ.get("KODERA_PASSPORT_MAGIC_LINK") or None

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
# One principal's writes per rolling minute (docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md §2); unset, 60.
KODERA_MUTATION_RATE_PER_MINUTE = mutation_rate_per_minute(os.environ)
KODERA_TENANT_APP_URLS = tenant_app_urls(os.environ)
# Whether Core bills: KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = billing_enabled(os.environ)
# Product edition: KODERA_EDITION (GOVERNANCE.md §1); `community` when unset.
KODERA_EDITION = edition(os.environ)
# Optional Enterprise audit-export signing seed; validated at startup when set.
KODERA_EE_AUDIT_SIGNING_SEED = ee_audit_signing_seed(os.environ)

# Application keys only; the API never loads object-storage or VAPID private credentials.
KODERA_MEDIA_GATEWAY_SOCKET = media_gateway_socket(os.environ)
KODERA_MEDIA_ROOM_VERIFIER_URL = media_room_verifier_url(os.environ)
(KODERA_NOTIFICATION_SEAL_KEY, KODERA_PUSH_VAPID_PUBLIC_KEY) = notification_settings(os.environ)
(
    KODERA_COLLAB_TICKET_KEY,
    KODERA_COLLAB_ENGINE_URL,
    KODERA_COLLAB_PUBLIC_URL,
) = collaboration_settings(os.environ)

KODERA_STAFF_OIDC_ISSUER = staff_oidc_issuer(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
KODERA_STAFF_OIDC_JWKS_URL = staff_oidc_jwks_url(
    os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS
)
KODERA_STAFF_ADMIN_HOSTS = staff_admin_hosts(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
KODERA_STAFF_OPS_HOSTS = staff_ops_hosts(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
KODERA_STAFF_ADMIN_ORIGINS = os.environ.get("KODERA_STAFF_ADMIN_ORIGINS")
KODERA_IOS_APP_IDS = ios_app_ids(os.environ)
KODERA_ANDROID_ASSETLINKS_SHA256 = android_assetlinks_sha256(os.environ)

# Disabled until the canonical confidential transport contract and client acceptance are released.
KODERA_E2EE_RELAY_ENABLED = confidential_relay_enabled(os.environ)
# Optional sovereign AI gateway: off by default, and gated again at org, channel and member tiers.
KODERA_AI_GATEWAY_ENABLED = ai_gateway_enabled(os.environ)
KODERA_AI_SEAL_KEY = ai_seal_key(os.environ)
KODERA_AI_MISTRAL_API_KEY = ai_mistral_api_key(os.environ)
KODERA_AI_ACTOR_SUBJECTS = ai_actor_subjects(os.environ)
KODERA_AI_CLIENT_IDS = ai_client_ids(os.environ)
KODERA_CALENDAR_SEAL_KEY = calendar_seal_key(os.environ)

# Optional Matrix worker settings for dispatch_extension_coexistence; unset, the command refuses
# to run rather than silently draining nothing.
KODERA_SYNAPSE_URL = synapse_url(os.environ)
KODERA_SYNAPSE_ADMIN_TOKEN = synapse_admin_token(os.environ)
KODERA_SYNAPSE_SERVER_NAME = synapse_server_name(os.environ)
KODERA_MATRIX_DOMAIN_SUFFIX = matrix_domain_suffix(os.environ)
KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY = matrix_replay_transport_factory(os.environ)
(
    KODERA_LIVEKIT_ROOM_SERVICE_URL,
    KODERA_LIVEKIT_API_KEY,
    KODERA_LIVEKIT_API_SECRET,
) = livekit_room_service_config(os.environ)
KODERA_LIVEKIT_ALLOW_INTERNAL_URL = os.environ.get("KODERA_LIVEKIT_ALLOW_INTERNAL_URL") == "true"

# Operator attests live authority and edge request-scope configuration before sharing.

KODERA_CHANNEL_GOVERNANCE_ENABLED = channel_governance_enabled(os.environ)
KODERA_GOVERNANCE_AUTHORITY_CONFIGURED = (
    os.environ.get("KODERA_GOVERNANCE_AUTHORITY_CONFIGURED") == "true"
)
