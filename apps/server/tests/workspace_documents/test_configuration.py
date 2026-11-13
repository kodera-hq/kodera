"""Application endpoint admission and unavailable document-worker refusals."""

import base64
import secrets

import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.docs.configuration import collaboration_settings, endpoint


def test_only_complete_application_configuration_is_admitted():
    assert collaboration_settings({}) == (None, None, None)
    key = secrets.token_bytes(32)
    environment = {
        "KODERA_COLLAB_TICKET_KEY": base64.urlsafe_b64encode(key).decode(),
        "KODERA_COLLAB_ENGINE_URL": "http://yjs-collab:8098/internal/transform",
        "KODERA_COLLAB_PUBLIC_URL": "wss://api.example.org/documents/collab",
    }
    assert collaboration_settings(environment) == (
        key,
        environment["KODERA_COLLAB_ENGINE_URL"],
        environment["KODERA_COLLAB_PUBLIC_URL"],
    )
    for missing in environment:
        changed = {name: value for name, value in environment.items() if name != missing}
        with pytest.raises(ImproperlyConfigured):
            collaboration_settings(changed)


@pytest.mark.parametrize(
    "value",
    [
        "wss://[broken",
        "wss://api.example.org:99999/documents/collab",
        "wss://user@api.example.org/documents/collab",
        "ws://api.example.org/documents/collab",
        "wss://api.example.org/documents/*",
        "wss://api.example.org/documents/collab?token=example",
        "wss://api.example.org/documents/collab#fragment",
        "wss://api.example.org/\ndocuments/collab",
    ],
)
def test_public_endpoint_never_admits_other_routes_credentials_or_controls(value):
    with pytest.raises(ImproperlyConfigured):
        endpoint(value, public=True)
