"""Fixed deployable API profile; no local secret/database/issuer fallback."""

import os

from django.core.exceptions import ImproperlyConfigured

from apps.billing.configuration import (
    PAYMENT_TERMS_DAYS,
    issuer_from_environment as billing_issuer,
    payment_return_origins,
    series_from_environment as billing_series,
    stripe_from_environment,
)
from apps.docs.configuration import collaboration_settings
from config.deploy_environment import deployment
from config.environment import (
    auth_trust,
    billing_enabled,
    console_client_id,
    intake_admitted,
    legal_text_origin,
    mutation_rate_per_minute,
    staff_issuer,
    tenant_app_urls,
    trusted_edge,
)
from config.workspace_features import media_gateway_socket, notification_settings
from core.sealing import key_from_environment

from .base import *

# Run before Django starts or imports application URLs.
_validated = deployment(os.environ)
SECRET_KEY = _validated["SECRET_KEY"]
ALLOWED_HOSTS = _validated["ALLOWED_HOSTS"]
DATABASES = _validated["DATABASES"]
DEBUG = False
ROOT_URLCONF = "config.customer_urls"
INSTALLED_APPS = [
    *INSTALLED_APPS,
    "apps.identity",
    "apps.orgs",
    "apps.jobs",
    "apps.audit",
    "apps.workspaces",
    "apps.billing",
    "apps.legal",
    "apps.tenancy",
    "core.idempotency",
    "apps.engine_intents",
    "apps.support",
    "apps.media",
    "apps.notifications",
    "apps.docs",
]
KODERA_LOOPBACK_ISSUERS = False
KODERA_AUTH_TRUST = auth_trust(os.environ)
KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)
KODERA_STAFF_ISSUER = staff_issuer(os.environ)
KODERA_INTAKE_ADMITTED = intake_admitted(os.environ)
KODERA_CONTACT_SEAL_KEY = key_from_environment(os.environ, "KODERA_CONTACT_SEAL_KEY")
KODERA_MEMBERSHIP_CURSOR_KEY = os.environ.get("KODERA_MEMBERSHIP_CURSOR_KEY")
# Discovery validates its own key only when called, without blocking other operations.
KODERA_DISCOVERY_HMAC_KEY = os.environ.get("KODERA_DISCOVERY_HMAC_KEY")
# The browser origins (the Console's), comma-separated: the ones discovery admits and the only
# ones CORS names (core/api/edge.py). A malformed value names none; validated where it is read.
KODERA_CONSOLE_ORIGINS = os.environ.get("KODERA_CONSOLE_ORIGINS")
# Where a support ticket is mailed (docs/specs/SUPPORT_TICKETS.md §5); validated by the route.
KODERA_SUPPORT_MAILBOX = os.environ.get("KODERA_SUPPORT_MAILBOX") or None
# createPaymentLink's `return_url` is held to the console's own origins, read by discovery's parser
# (apps/billing/configuration.py payment_return_origins).
KODERA_PAYMENT_RETURN_ORIGINS = payment_return_origins(KODERA_CONSOLE_ORIGINS)
KODERA_LEGAL_TEXT_ORIGIN = legal_text_origin(os.environ)
# One principal's writes per rolling minute (docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md §2); unset, 60.
KODERA_MUTATION_RATE_PER_MINUTE = mutation_rate_per_minute(os.environ)
KODERA_TENANT_APP_URLS = tenant_app_urls(os.environ)
# Whether Core bills: KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = billing_enabled(os.environ)
# The edge proxies whose X-Forwarded-For names the client (docs/specs/TRUSTED_EDGE.md); unset, none.
KODERA_TRUSTED_EDGE = trusted_edge(os.environ)
# The legal entity that issues invoices, and the invoice number series (apps/billing/configuration.py).
KODERA_BILLING_ISSUER = billing_issuer(os.environ)
KODERA_INVOICE_SERIES = billing_series(os.environ)
KODERA_INVOICE_PAYMENT_TERMS_DAYS = PAYMENT_TERMS_DAYS
# Header trust and TLS termination belong to the operator's separately qualified proxy.
# Gunicorn trusts no forwarded source by default. Never infer https from arbitrary headers.
SECURE_PROXY_SSL_HEADER = None
USE_X_FORWARDED_HOST = False
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_CONTENT_TYPE_NOSNIFF = True

# The payment provider: Stripe when both of its keys are in the environment, none otherwise, so a
# payment link is refused rather than faked (apps/billing/configuration.py).
(
    KODERA_PAYMENT_PROVIDER,
    KODERA_STRIPE_SECRET_KEY,
    KODERA_STRIPE_WEBHOOK_SECRET,
) = stripe_from_environment(os.environ)

# No routed signed webhook exists in customer_urls yet. Do not accept money that
# this deployment cannot reconcile; enabling it requires a route and replay tests.
if KODERA_PAYMENT_PROVIDER == "stripe":
    raise ImproperlyConfigured("Stripe payments require a routed reconciliation webhook")

# Application keys only; the API never loads object-storage or VAPID private credentials.
KODERA_MEDIA_GATEWAY_SOCKET = media_gateway_socket(os.environ)
(KODERA_NOTIFICATION_SEAL_KEY, KODERA_PUSH_VAPID_PUBLIC_KEY) = notification_settings(os.environ)
(
    KODERA_COLLAB_TICKET_KEY,
    KODERA_COLLAB_ENGINE_URL,
    KODERA_COLLAB_PUBLIC_URL,
) = collaboration_settings(os.environ)
