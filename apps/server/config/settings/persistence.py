"""Local customer schema profile; no business HTTP consumer."""

import os

from config.environment import loopback_profile, staff_issuer

from .dev import *

INSTALLED_APPS = [*INSTALLED_APPS, "apps.identity", "apps.orgs"]

# A plain-http or loopback issuer is refused at start (config.environment.auth_trust): False in
# this profile and in every profile built on it, customer_http and job_queue included, unless the
# selected settings module is config.settings.test, config.settings.e2e or
# config.settings.e2e_operator (config.environment.LOOPBACK_PROFILES). Never a value read from input.
KODERA_LOOPBACK_ISSUERS = loopback_profile(os.environ)

# The one staff issuer (docs/specs/STAFF_IDENTITY.md §1): every staff identity has it, and only a
# token of it resolves into a staff principal. None when unset: no staff role can be granted. Set,
# it must be on the staff lane of KODERA_AUTH_TRUST, or the process refuses to start.
KODERA_STAFF_ISSUER = staff_issuer(os.environ, loopback_issuers=KODERA_LOOPBACK_ISSUERS)
