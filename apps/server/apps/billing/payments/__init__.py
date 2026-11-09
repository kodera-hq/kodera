"""The configured payment provider, by name: `KODERA_PAYMENT_PROVIDER`.

`stripe` with its two keys from the environment (apps/billing/configuration.py), or `fake`, the
adapter the development and test profiles use. Unset, there is no provider, and creating a payment
link is refused as an unavailable upstream rather than faked.
"""

from functools import cache

from django.conf import settings

from .fake import FakeProvider
from .port import PaymentProvider, ProviderNotConfiguredError
from .stripe import StripeProvider


@cache
def _fake(secret: bytes) -> FakeProvider:
    return FakeProvider(secret=secret)


@cache
def _stripe(secret_key: str, webhook_secret: str) -> StripeProvider:
    return StripeProvider(secret_key=secret_key, webhook_secret=webhook_secret)


def configured_provider() -> PaymentProvider:
    name: str | None = getattr(settings, "KODERA_PAYMENT_PROVIDER", None)
    if name == "fake":
        return _fake(settings.KODERA_FAKE_PROVIDER_SECRET)
    if name == "stripe":
        return _stripe(settings.KODERA_STRIPE_SECRET_KEY, settings.KODERA_STRIPE_WEBHOOK_SECRET)
    raise ProviderNotConfiguredError(f"no payment provider is configured ({name!r})")


def provider_named(name: str) -> PaymentProvider:
    """The adapter for events a provider delivered: only the configured one is accepted."""
    provider = configured_provider()
    if provider.name != name:
        raise ProviderNotConfiguredError(f"{name!r} is not the configured payment provider")
    return provider
