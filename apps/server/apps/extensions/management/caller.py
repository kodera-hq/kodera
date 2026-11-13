"""Bounded customer token admission on stdin; tokens never enter argv, logs or persistence."""

import sys

from django.conf import settings
from django.core.management.base import CommandError

from core.api import lanes
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token


def caller():
    raw = sys.stdin.read(16385).strip()
    if not raw or len(raw) > 16384:
        raise CommandError("one bounded customer access token is required on stdin")
    try:
        verified, lane = verify_configured_token(raw, trusted=settings.KODERA_AUTH_TRUST)
        verified, lane = lanes.admit(verified, lane)
        if lane != "customer":
            raise CommandError("a customer token is required")
        return verified
    except TokenVerificationError:
        raise CommandError("customer token refused") from None
    finally:
        del raw
