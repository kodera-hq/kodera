"""Select exactly the deployment profile before any application import."""

import os

from django.core.wsgi import get_wsgi_application

from config.deploy_environment import deployment

deployment(os.environ)
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.deploy"
application = get_wsgi_application()
