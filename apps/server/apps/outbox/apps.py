"""Registration of the outbox delivery record and its reconciliation decision."""

from django.apps import AppConfig


class OutboxConfig(AppConfig):
    name = "apps.outbox"
    label = "outbox"
