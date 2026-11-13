"""Provider requests contain only an empty wakeup and validated VAPID credentials."""

import secrets
from datetime import UTC, datetime
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from apps.media import outbound
from apps.notifications import push


def key():
    return ec.generate_private_key(ec.SECP256R1())


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://push.example.org/",
        "https://push.example.org:8443/",
        "https://user:password@push.example.org/",
        "https://push.example.org/#fragment",
        "https://169.254.169.254/",
        "https://[::ffff:127.0.0.1]/",
        "https://100.64.0.1/",
    ],
)
def test_subscription_cannot_create_an_ssrf_endpoint(endpoint):
    with pytest.raises((push.SubscriptionRefusedError, outbound.BlockedTargetError)):
        push.subscription(endpoint, push.public_key(key()), push.encode(secrets.token_bytes(16)))


def test_malformed_keys_are_refused_before_dns(monkeypatch):
    monkeypatch.setattr(outbound, "addresses", lambda *a: pytest.fail("invalid keys reached DNS"))
    for point, auth in [
        (push.encode(b"\x04" + b"\0" * 64), push.encode(secrets.token_bytes(16))),
        (push.public_key(key()), push.encode(secrets.token_bytes(15))),
        (push.public_key(key()) + "=", push.encode(secrets.token_bytes(16))),
    ]:
        with pytest.raises(push.SubscriptionRefusedError):
            push.subscription("https://push.example.org/", point, auth)


@pytest.mark.parametrize(
    "status,outcome",
    [
        (201, "delivered"),
        (204, "delivered"),
        (404, "dead"),
        (410, "dead"),
        (429, "retry"),
        (503, "retry"),
        (302, "refused"),
    ],
)
def test_empty_wakeup_is_authenticated_and_never_follows_redirect(monkeypatch, status, outcome):
    private = key()
    calls = []
    closed = []

    def request(destination, **kwargs):
        calls.append((destination, kwargs))
        return SimpleNamespace(close=lambda: closed.append("connection")), SimpleNamespace(
            status=status,
            close=lambda: closed.append("response"),
            getheader=lambda name, default=None: "120" if name == "Retry-After" else default,
        )

    monkeypatch.setattr(outbound, "request", request)
    result = push.send(
        "https://push.example.org/wake?opaque=value", private, "mailto:operations@example.org"
    )
    assert result.outcome == outcome
    assert len(calls) == 1
    destination, sent = calls[0]
    assert sent["method"] == "POST"
    assert sent["body"] == b""
    assert sent["headers"]["Content-Length"] == "0"
    assert set(sent["headers"]) == {"Authorization", "TTL", "Content-Length"}
    authorization = sent["headers"]["Authorization"]
    encoded, public = authorization.removeprefix("vapid t=").split(", k=")
    claims = jwt.decode(
        encoded, private.public_key(), algorithms=["ES256"], audience="https://push.example.org"
    )
    assert set(claims) == {"aud", "exp", "sub"}
    assert claims["sub"] == "mailto:operations@example.org"
    assert 0 < claims["exp"] - datetime.now(UTC).timestamp() <= 300
    assert public == push.public_key(private)
    assert closed == ["response", "connection"]
    if outcome == "retry":
        assert result.retry_after == 120
