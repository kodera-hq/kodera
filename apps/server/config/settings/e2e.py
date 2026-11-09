"""The local end-to-end stack's API profile: config.settings.customer_http, trusting the loopback
issuers of the stack's identity provider (dev/e2e/compose.yaml), which the image qualification
(dev/accept_customer_http.py) selects too.

TEST ONLY. The stack's keys are derived from a public label (dev/e2e/make_trust.py), so a process
started on this profile trusts tokens anyone can sign. It admits loopback issuers only as the
selected settings module (config.environment.LOOPBACK_PROFILES); built on by another profile, it
refuses to load. The API image does not carry it (.dockerignore): the stack and the qualification
each add this one file to the image as an explicit test-only overlay.
"""

import os

from django.core.exceptions import ImproperlyConfigured

from apps.billing.configuration import payment_return_origins
from config.environment import console_client_id

from .customer_http import *

KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)

if KODERA_LOOPBACK_ISSUERS is not True:
    raise ImproperlyConfigured("config.settings.e2e loads only as the selected settings module")

# The stack's Console is served over plain http on the machine itself (http://localhost:<port>),
# so discovery admits an `http://localhost:<port>` entry of KODERA_CONSOLE_ORIGINS here, and in
# no other profile: everywhere else the setting is absent and only `https` origins are admitted
# (services.identity.discovery_input.allowed_origins).
KODERA_CONSOLE_LOOPBACK_ORIGINS = True
KODERA_PAYMENT_RETURN_ORIGINS = payment_return_origins(KODERA_CONSOLE_ORIGINS, loopback_http=True)
