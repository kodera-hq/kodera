"""Fixed deployable API profile; no local secret/database/issuer fallback."""

import os
from urllib.parse import urlsplit

import config.deploy_environment as _deploy_env
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
    ai_actor_subjects,
    ai_client_ids,
    ai_mistral_api_key,
    android_assetlinks_sha256,
    auth_trust,
    billing_enabled,
    console_client_id,
    edition,
    ee_audit_signing_seed,
    intake_admitted,
    ios_app_ids,
    legal_text_origin,
    matrix_replay_transport_factory,
    mutation_rate_per_minute,
    staff_admin_hosts,
    staff_issuer,
    staff_oidc_issuer,
    staff_oidc_jwks_url,
    staff_ops_hosts,
    synapse_admin_token,
    synapse_server_name,
    synapse_url,
    tenant_app_urls,
    trusted_edge,
)
from config.workspace_features import (
    ai_gateway_enabled,
    ai_seal_key,
    confidential_relay_enabled,
    media_gateway_socket,
    media_room_verifier_url,
    notification_settings,
)
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
    "core.staff_api",
    "apps.engine_intents",
    "apps.support",
    "apps.media",
    "apps.notifications",
    "apps.docs",
    "apps.e2ee",
]
KODERA_LOOPBACK_ISSUERS = False
KODERA_AUTH_TRUST = auth_trust(os.environ)
KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)
KODERA_STAFF_ISSUER = staff_issuer(os.environ)
KODERA_INTAKE_ADMITTED = intake_admitted(os.environ)
KODERA_CONTACT_SEAL_KEY = key_from_environment(os.environ, "KODERA_CONTACT_SEAL_KEY")
KODERA_OUTBOX_SEAL_KEY = key_from_environment(os.environ, "KODERA_OUTBOX_SEAL_KEY")
KODERA_PASSPORT_MAGIC_LINK = os.environ.get("KODERA_PASSPORT_MAGIC_LINK") or None
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
# Product edition: KODERA_EDITION (GOVERNANCE.md §1); `community` when unset.
KODERA_EDITION = edition(os.environ)
# Optional Enterprise audit-export signing seed; validated at startup when set.
KODERA_EE_AUDIT_SIGNING_SEED = ee_audit_signing_seed(os.environ)
# The edge proxies whose X-Forwarded-For names the client (docs/specs/TRUSTED_EDGE.md); unset, none.
KODERA_TRUSTED_EDGE = trusted_edge(os.environ)
# The legal entity that issues invoices, and the invoice number series (apps/billing/configuration.py).
KODERA_BILLING_ISSUER = billing_issuer(os.environ)
KODERA_INVOICE_SERIES = billing_series(os.environ)
KODERA_INVOICE_PAYMENT_TERMS_DAYS = PAYMENT_TERMS_DAYS
# Header trust and TLS termination belong to the operator's separately qualified proxy.
# Gunicorn trusts no forwarded source by default. Never infer https from arbitrary headers;
# external protocol metadata and callbacks derive https:// origins from validated settings below.
SECURE_PROXY_SSL_HEADER = None
USE_X_FORWARDED_HOST = False
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_CONTENT_TYPE_NOSNIFF = True


def _public_https_origin(raw: str | None, *, fallback: str | None = None) -> str | None:
    if raw is None or raw == "":
        return fallback
    if len(raw) > 255 or any(ch.isspace() for ch in raw):
        _deploy_env.refuse()
    parsed = urlsplit(raw)
    try:
        port = parsed.port
    except ValueError:
        _deploy_env.refuse()
        return None
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.hostname is None
        or parsed.netloc.lower() != parsed.netloc
        or not _deploy_env.HOST.fullmatch(parsed.hostname)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or (port is not None and not 1 <= port <= 65535)
    ):
        _deploy_env.refuse()
    port_suffix = "" if port in (None, 443) else f":{port}"
    return f"https://{parsed.hostname}{port_suffix}"


KODERA_PUBLIC_API_ORIGIN = _public_https_origin(
    os.environ.get("KODERA_PUBLIC_API_ORIGIN"),
    fallback=f"https://{ALLOWED_HOSTS[0]}" if len(ALLOWED_HOSTS) == 1 else None,
)
KODERA_SAML_SP_BASE_URL = _public_https_origin(
    os.environ.get("KODERA_SAML_SP_BASE_URL"),
    fallback=KODERA_PUBLIC_API_ORIGIN,
)

# The payment provider: Stripe when both of its keys are in the environment, none otherwise, so a
# payment link is refused rather than faked (apps/billing/configuration.py).
(
    KODERA_PAYMENT_PROVIDER,
    KODERA_STRIPE_SECRET_KEY,
    KODERA_STRIPE_WEBHOOK_SECRET,
) = stripe_from_environment(os.environ)

# Application keys only; the API never loads object-storage or VAPID private credentials.
KODERA_MEDIA_GATEWAY_SOCKET = media_gateway_socket(os.environ)
KODERA_MEDIA_ROOM_VERIFIER_URL = media_room_verifier_url(os.environ)
(KODERA_NOTIFICATION_SEAL_KEY, KODERA_PUSH_VAPID_PUBLIC_KEY) = notification_settings(os.environ)
(
    KODERA_COLLAB_TICKET_KEY,
    KODERA_COLLAB_ENGINE_URL,
    KODERA_COLLAB_PUBLIC_URL,
) = collaboration_settings(os.environ)

KODERA_STAFF_OIDC_ISSUER = staff_oidc_issuer(os.environ)
KODERA_STAFF_OIDC_JWKS_URL = staff_oidc_jwks_url(os.environ)
KODERA_STAFF_ADMIN_HOSTS = staff_admin_hosts(os.environ)
KODERA_STAFF_OPS_HOSTS = staff_ops_hosts(os.environ)
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

# Optional Matrix worker settings for dispatch_extension_coexistence; unset, the command refuses
# to run rather than silently draining nothing.
KODERA_SYNAPSE_URL = synapse_url(os.environ)
KODERA_SYNAPSE_ADMIN_TOKEN = synapse_admin_token(os.environ)
KODERA_SYNAPSE_SERVER_NAME = synapse_server_name(os.environ)
KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY = matrix_replay_transport_factory(os.environ)
