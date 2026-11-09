"""Local-only settings. There is deliberately no production settings module."""

import os

from config.environment import local_database

from .base import *

DATABASES = {"default": local_database(os.environ)}
# No identity setting here. A plain-http or loopback issuer is admitted only when the selected
# settings module is config.settings.e2e or config.settings.e2e_operator (LOOPBACK_PROFILES in
# config/environment.py); every other profile refuses one at start.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "local-bootstrap-only-not-a-deployment-key")
DEBUG = False
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
