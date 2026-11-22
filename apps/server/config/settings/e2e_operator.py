"""The local end-to-end stack's operator profile: config.settings.job_queue, for its schema and
operator commands (dev/e2e/compose.yaml), trusting the loopback staff issuer of the stack's identity
provider.

TEST ONLY, as config.settings.e2e: it admits loopback issuers only as the selected settings module
(config.environment.LOOPBACK_PROFILES); built on by another profile, it refuses to load.
"""

import os

from django.core.exceptions import ImproperlyConfigured

from config.environment import ee_audit_signing_seed

from .job_queue import *

if KODERA_LOOPBACK_ISSUERS is not True:
    raise ImproperlyConfigured(
        "config.settings.e2e_operator loads only as the selected settings module"
    )

KODERA_EE_AUDIT_SIGNING_SEED = ee_audit_signing_seed(os.environ)
