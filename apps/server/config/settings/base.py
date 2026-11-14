"""Nonsecret common HTTP defaults; each profile validates its own environment."""

import ipaddress
import os

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
INSTALLED_APPS = ["rest_framework"]
MIDDLEWARE = [
    # First: no view, and no other middleware, reads a caller's X-Request-Id before it is
    # namespaced (core/api/edge.py, docs/specs/TRUSTED_EDGE.md).
    "core.api.edge.CallerRequestIdMiddleware",
    # Next, and outside everything that can answer: which origin may read the answer
    # (docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md §3).
    "core.api.edge.ConsoleCorsMiddleware",
    # Before any view: one principal's writes per minute (§2).
    "core.api.edge.MutationRateLimitMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "core.api.edition.EnterpriseEditionMiddleware",
]
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "UNAUTHENTICATED_USER": None,
}
# The operator's edge proxies whose X-Forwarded-For Core believes (core/api/edge.py). Empty: none,
# the client is the direct peer. Only the deployed API profile reads it from its environment.
KODERA_TRUSTED_EDGE: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = ()
# One principal's writes per rolling minute on the customer API (core/api/edge.py): the
# documented default here; a serving profile reads KODERA_MUTATION_RATE_PER_MINUTE. Never off.
KODERA_MUTATION_RATE_PER_MINUTE = 60
# The Console's browser origins, the only ones CORS names (core/api/edge.py) and discovery admits.
# None: no browser origin. A serving profile reads KODERA_CONSOLE_ORIGINS.
KODERA_CONSOLE_ORIGINS: str | None = None
USE_TZ = True
TIME_ZONE = "UTC"
APPEND_SLASH = False
# Where an accepted legal text is read, permanently (apps/legal); each profile that serves or mails
# its URL reads it from KODERA_LEGAL_TEXT_ORIGIN. None: no URL is named.
KODERA_LEGAL_TEXT_ORIGIN: str | None = None
# Each application's default URL template, `https://{slug}.<host>`, from
# KODERA_TENANT_APP_URLS. Empty: no tenant application has a URL.
KODERA_TENANT_APP_URLS: dict[str, str] = {}
# Whether Core bills (docs/specs/QUICK_WORKSPACE.md §2). Each profile that serves, settles or runs
# jobs reads it from KODERA_BILLING_ENABLED; true, today's behaviour, everywhere else.
KODERA_BILLING_ENABLED = True
# Product edition (GOVERNANCE.md §1): open-source `community` by default; serving profiles read
# KODERA_EDITION (`community` or `enterprise`).
KODERA_EDITION = "community"
# Every record at WARNING and above, as one JSON line on stderr (core/logs.py says what a line may
# carry). Without it an uncaught exception answered 500 and wrote nothing: Django's own console
# handler logs only with DEBUG on, which no profile turns on. The handler's level is the filter, since
# `django` loggers log INFO to their parents. `django.request` logs at ERROR: a 4xx is the caller's
# error, answered to the caller, and an unmatched path is text the caller chose.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json_line": {"()": "core.logs.JsonLine"}},
    "handlers": {
        "stderr": {
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
            "formatter": "json_line",
            "level": "WARNING",
        }
    },
    "root": {"handlers": ["stderr"]},
    "loggers": {"django.request": {"level": "ERROR"}},
}

# Explicit opt-in; the canonical workspace is provisioned by an operator command.
KODERA_DEFAULT_COMMUNITY_ORG_SLUG = os.environ.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "")
KODERA_DEFAULT_COMMUNITY_ISSUER = os.environ.get("KODERA_DEFAULT_COMMUNITY_ISSUER", "")
KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID = os.environ.get(
    "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID", ""
)
