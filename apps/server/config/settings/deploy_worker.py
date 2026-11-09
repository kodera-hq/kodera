"""Fixed profile of the provisioning worker (`python -m worker`): no URLconf, WSGI or middleware.

It loads only in the worker process. `worker.boot.enter()` installs the accident guard against
inbound sockets before Django starts, and this module refuses a process that has not entered it: a
gunicorn, manage.py or shell started with this selector stops here. The API image carries neither
this module nor the `worker` package. The environment is refused whole if it names an
infrastructure credential (ADR-0003 rejects credentials in the worker's environment; a job loads
its own through worker/credentials/). The worker signs nothing, so no signing key is provisioned:
each process draws its own, which nothing reads back.
"""

import os
import secrets

from django.core.exceptions import ImproperlyConfigured

from config.deploy_environment import worker_deployment

from .base import APPEND_SLASH as APPEND_SLASH, TIME_ZONE as TIME_ZONE, USE_TZ as USE_TZ

try:
    from worker import boot
except ImportError:
    boot = None  # type: ignore[assignment]
if boot is None or not boot.entered():
    raise ImproperlyConfigured(
        "config.settings.deploy_worker loads only in the worker process: python -m worker"
    )

_validated = worker_deployment(os.environ)
SECRET_KEY = secrets.token_urlsafe(64)
ALLOWED_HOSTS: list[str] = []
DATABASES = _validated["DATABASES"]
DEBUG = False
ROOT_URLCONF: str | None = None
WSGI_APPLICATION: str | None = None
MIDDLEWARE: list[str] = []
# The job queue's tables and the records its jobs read and write; never an application's API.
INSTALLED_APPS = ["apps.identity", "apps.orgs", "apps.jobs", "apps.audit", "apps.outbox"]
KODERA_LOOPBACK_ISSUERS = False
