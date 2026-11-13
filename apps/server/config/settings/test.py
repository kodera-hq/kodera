"""Local tests exercise the customer HTTP profile and the job queue/workspace schemas."""

import hashlib
import os

from apps.billing.configuration import PAYMENT_TERMS_DAYS, Issuer
from config.environment import console_client_id

from .customer_http import *
from .job_queue import QUEUE_APPS, REPLAY_APPS

KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)

# The queue, the audit record, the workspace schema and the replay store are installed by the
# customer HTTP profile (the intake and the workspace routes); the outbox is installed for tests,
# not for the API image's profiles (docs/specs/JOB_QUEUE.md §3.1,
# docs/specs/IDEMPOTENCY_REPLAY.md §2.1). Each application is installed once.
INSTALLED_APPS = [
    *INSTALLED_APPS,
    *(
        app
        for app in (
            *QUEUE_APPS,
            "apps.workspaces",
            "apps.billing",
            "apps.legal",
            "apps.tenancy",
            *REPLAY_APPS,
        )
        if app not in INSTALLED_APPS
    ),
]

# Test-only: one fixed synthetic staff issuer, whatever the environment says, so every test process
# and every job-queue actor process reads the same one (docs/specs/STAFF_IDENTITY.md §1).
# Assigned here, past config.environment.staff_issuer's start check: a test that needs the issuer
# on the staff lane sets KODERA_AUTH_TRUST itself.
KODERA_STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"

# Test-only: the tests bill, whatever the environment says, so a shell that turns billing off
# does not redden the billing suites; a test that needs billing off sets it (QUICK_WORKSPACE.md §2).
KODERA_BILLING_ENABLED = True

# Test-only: the test database is disposable, never a live one, so the intake is admitted
# (docs/specs/FIRST_OWNER_BOOTSTRAP.md §3.8), and its contact seal key is a fixed synthetic value
# derived from a public label. A test of the refusals overrides either.
KODERA_INTAKE_ADMITTED = True
KODERA_CONTACT_SEAL_KEY = hashlib.sha256(b"test-only intake contact seal key").digest()

# Test-only: no mail transport and no seal key, whatever the environment says. A test that sends
# builds its transport against an in-process SMTP server and passes it, or overrides these
# (docs/specs/OUTBOX_MAIL_SENDER.md §9).
KODERA_MAIL_TRANSPORT = None
KODERA_OUTBOX_SEAL_KEY = None
# The console origin the tests' links point at, and the one host name this profile lets a test
# reach in plaintext: the compose Mailpit's service name (docs/specs/OUTBOX_MAIL_SENDER.md §6).
KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.localhost"})
KODERA_MAIL_INSECURE_HOSTS = frozenset({"mailpit"})
# Test-only: the public origin the legal texts' permanent URLs name.
KODERA_LEGAL_TEXT_ORIGIN = "https://api.localhost"
KODERA_TENANT_APP_URLS = {
    "visio": "https://{slug}.visio.customer.test",
    "messaging": "https://{slug}.espace.customer.test",
}

# Test-only: the job-queue mutant flags (docs/specs/JOB_QUEUE.md §9.2). Never read from input.
JOB_QUEUE_MUTANTS_PERMITTED = True
JOB_QUEUE_MUTANTS: frozenset[str] = frozenset()

# Test-only: the first-slice harness may arm core/faults.py's named fault points. Never read from
# input; no other settings module may name it (tests/test_job_queue_flags_refused.py).
FAULT_POINTS_PERMITTED = True

# Test-only: a synthetic issuer and series, whatever the environment says (apps/billing).
KODERA_BILLING_ISSUER = Issuer(
    legal_name="Issuer of Test Invoices SAS",
    address="1 rue de l'Exemple, 75000 Paris",
    siren="000000000",
    vat_number="FR00000000000",
)
KODERA_INVOICE_SERIES = "TST"
KODERA_INVOICE_PAYMENT_TERMS_DAYS = PAYMENT_TERMS_DAYS

# Test-only: the fake payment provider and its signing secret, a fixed synthetic value derived from
# a public label (apps/billing/payments/fake.py). No profile the image starts names a provider.
KODERA_PAYMENT_PROVIDER = "fake"
KODERA_STRIPE_SECRET_KEY = None
KODERA_STRIPE_WEBHOOK_SECRET = None
KODERA_FAKE_PROVIDER_SECRET = hashlib.sha256(b"test-only fake payment provider secret").digest()

# Tests never inherit optional worker endpoints or application keys from the host.
KODERA_MEDIA_GATEWAY_SOCKET = None
KODERA_NOTIFICATION_SEAL_KEY = None
KODERA_PUSH_VAPID_PUBLIC_KEY = None
