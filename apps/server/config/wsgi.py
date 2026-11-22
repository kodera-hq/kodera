"""WSGI entry point for the local runtime."""

import os

from django.core.wsgi import get_wsgi_application

from config.body_guard import BodyGuard

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
application = BodyGuard(get_wsgi_application())
