from datetime import timedelta

from django.utils import timezone


def delivery_expiry():
    return timezone.now() + timedelta(days=7)
