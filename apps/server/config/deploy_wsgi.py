"""Select exactly the deployment profile before any application import."""

import os

from django.core.wsgi import get_wsgi_application

from config.body_guard import BodyGuard
from config.deploy_environment import deployment
from core.db.api_database_boundary import install

deployment(os.environ)
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.deploy"
install()
application = BodyGuard(get_wsgi_application())
