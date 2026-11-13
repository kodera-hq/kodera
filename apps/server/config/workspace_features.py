"""Application configuration for optional attachment and empty-wakeup workers."""

from collections.abc import Mapping
from pathlib import PurePosixPath

from django.core.exceptions import ImproperlyConfigured

from core.sealing import key_from_environment


def media_gateway_socket(environment: Mapping[str, str]) -> str | None:
    value = environment.get("KODERA_MEDIA_GATEWAY_SOCKET", "")
    if not value:
        return None
    path = PurePosixPath(value)
    if (
        len(value.encode()) > 100
        or not path.is_absolute()
        or str(path) != value
        or ".." in path.parts
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ImproperlyConfigured("media gateway requires a normalized absolute Unix socket path")
    return value


def notification_settings(environment: Mapping[str, str]) -> tuple[bytes | None, str | None]:
    key = key_from_environment(environment, "KODERA_NOTIFICATION_SEAL_KEY")
    public = environment.get("KODERA_PUSH_VAPID_PUBLIC_KEY") or None
    if public is not None:
        from apps.notifications.push import point

        try:
            point(public)
        except (ValueError, TypeError):
            raise ImproperlyConfigured(
                "push discovery requires an uncompressed P-256 public key"
            ) from None
    return key, public
