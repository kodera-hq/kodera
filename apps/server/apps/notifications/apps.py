"""Registration of the scoped notification inbox and push subscriptions."""

from django.apps import AppConfig


class NotificationsConfig(AppConfig):
    name = "apps.notifications"
    label = "notifications"
