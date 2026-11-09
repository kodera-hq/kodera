"""Registration of the replay store, a kernel application every POST route shares."""

from django.apps import AppConfig


class IdempotencyConfig(AppConfig):
    name = "core.idempotency"
    label = "idempotency"
