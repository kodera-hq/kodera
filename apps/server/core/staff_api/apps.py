"""Django application config for the C1 `/staff/v1/*` staff plane."""

from django.apps import AppConfig


class StaffApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core.staff_api"
    label = "staff_api"
