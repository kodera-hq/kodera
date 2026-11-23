"""Application configuration for optional attachment and empty-wakeup workers."""

from collections.abc import Mapping
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from config.environment import (
    ai_actor_subjects as ai_actor_subjects,
    ai_client_ids as ai_client_ids,
    ai_mistral_api_key as ai_mistral_api_key,
)
from core.sealing import key_from_environment


def confidential_relay_enabled(environment: Mapping[str, str]) -> bool:
    value = environment.get("KODERA_E2EE_RELAY_ENABLED", "false")
    if value not in {"true", "false"}:
        raise ImproperlyConfigured("KODERA_E2EE_RELAY_ENABLED must be true or false")
    return value == "true"


def ai_gateway_enabled(environment: Mapping[str, str]) -> bool:
    value = environment.get("KODERA_AI_GATEWAY_ENABLED", "false")
    if value not in {"true", "false"}:
        raise ImproperlyConfigured("KODERA_AI_GATEWAY_ENABLED must be true or false")
    return value == "true"


def ai_seal_key(environment: Mapping[str, str]) -> bytes | None:
    return key_from_environment(environment, "KODERA_AI_SEAL_KEY")


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


def media_room_verifier_url(environment: Mapping[str, str]) -> str | None:
    value = environment.get("KODERA_MEDIA_ROOM_VERIFIER_URL", "")
    if not value:
        return None
    refused = ImproperlyConfigured(
        "media room verifier must be an exact reviewed internal HTTP(S) /internal/room-member route"
    )
    if len(value) > 2048 or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise refused
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise refused from None
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or parts.path != "/internal/room-member"
        or (port is not None and not 1 <= port <= 65535)
        or "\\" in parts.netloc
    ):
        raise refused
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
