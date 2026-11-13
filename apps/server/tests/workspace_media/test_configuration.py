"""Optional worker configuration fails closed without admitting storage credentials."""

import base64
import secrets

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.exceptions import ImproperlyConfigured

from apps.notifications.push import public_key
from config.workspace_features import media_gateway_socket, notification_settings


def test_optional_workers_are_disabled_by_default():
    assert media_gateway_socket({}) is None
    assert notification_settings({}) == (None, None)


@pytest.mark.parametrize(
    "value",
    [
        "relative.sock",
        "/run/../outside.sock",
        "/run//media.sock",
        "/run/./media.sock",
        "/run/media\n.sock",
        "/" + "a" * 101,
    ],
)
def test_unsafe_socket_path_refuses(value):
    with pytest.raises(ImproperlyConfigured):
        media_gateway_socket({"KODERA_MEDIA_GATEWAY_SOCKET": value})


def test_application_key_and_public_point_are_explicit():
    key = secrets.token_bytes(32)
    point = public_key(ec.generate_private_key(ec.SECP256R1()))
    assert notification_settings(
        {
            "KODERA_NOTIFICATION_SEAL_KEY": base64.urlsafe_b64encode(key).decode(),
            "KODERA_PUSH_VAPID_PUBLIC_KEY": point,
        }
    ) == (key, point)
    assert (
        media_gateway_socket({"KODERA_MEDIA_GATEWAY_SOCKET": "/run/kodera/media.sock"})
        == "/run/kodera/media.sock"
    )
    with pytest.raises(ImproperlyConfigured):
        notification_settings({"KODERA_PUSH_VAPID_PUBLIC_KEY": "invalid"})
    with pytest.raises(ImproperlyConfigured):
        notification_settings({"KODERA_NOTIFICATION_SEAL_KEY": "invalid"})
