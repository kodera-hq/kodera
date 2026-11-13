"""Explicit application-only configuration for the native document boundary."""

from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from core.sealing import key_from_environment


def endpoint(value: object, *, public: bool) -> str:
    refused = ImproperlyConfigured(
        "collaboration endpoint must be an exact reviewed HTTP or WSS route"
    )
    if (
        not isinstance(value, str)
        or len(value) > 2048
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
    ):
        raise refused
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise refused from None
    if (
        parts.scheme != ("wss" if public else "http")
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or parts.path != ("/documents/collab" if public else "/internal/transform")
        or (port is not None and not 1 <= port <= 65535)
        or "\\" in parts.netloc
    ):
        raise refused
    return value


def collaboration_settings(
    environment: Mapping[str, str],
) -> tuple[bytes | None, str | None, str | None]:
    names = ("KODERA_COLLAB_TICKET_KEY", "KODERA_COLLAB_ENGINE_URL", "KODERA_COLLAB_PUBLIC_URL")
    if not any(environment.get(name) for name in names):
        return None, None, None
    key = key_from_environment(environment, names[0])
    if key is None:
        raise ImproperlyConfigured("collaboration endpoints require their application key")
    return (
        key,
        endpoint(environment.get(names[1]), public=False),
        endpoint(environment.get(names[2]), public=True),
    )
