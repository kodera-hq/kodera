"""Pure quota policy, without Django, a database or a provider."""

import base64
from datetime import UTC, datetime, timedelta

import pytest

from services.identity.discovery_policy import (
    DiscoveryUnavailableError,
    bucket_digest,
    configured_key,
    evaluate,
    normalized_peer,
    validate_value,
    value_bucket,
)

KEY = bytes(range(32))
NOW = datetime(2020, 1, 1, tzinfo=UTC)


def test_exact_key_bytes_or_canonical_base64():
    assert len(KEY) == 32
    assert configured_key(KEY) == configured_key(base64.b64encode(KEY).decode()) == KEY


@pytest.mark.parametrize("value", [None, "", True, b"x" * 31, b"x" * 33, "?" * 44])
def test_configuration_has_no_fallback_or_echo(value):
    with pytest.raises(DiscoveryUnavailableError) as error:
        configured_key(value)
    assert str(error.value) == "discovery dependency unavailable"
    assert error.value.reason == "configuration"


def test_peer_normalization_and_digest_labels():
    assert normalized_peer("::ffff:192.0.2.1") == normalized_peer("192.0.2.1")
    assert normalized_peer("2001:0db8:0:0::1") == "2001:db8::/64"
    assert bucket_digest(KEY, "ip", "alpha") != bucket_digest(KEY, "slug", "alpha")
    assert bucket_digest(KEY, "domain", "alpha") != bucket_digest(KEY, "slug", "alpha")
    assert len(bucket_digest(KEY, "ip", "192.0.2.1")) == 64


def test_ipv6_peers_share_one_bucket_per_64():
    one = normalized_peer("2001:db8:1:2::1")
    assert one == normalized_peer("2001:db8:1:2:ffff:ffff:ffff:ffff") == "2001:db8:1:2::/64"
    assert one != normalized_peer("2001:db8:1:3::1")
    assert normalized_peer("192.0.2.1") == "192.0.2.1"


def test_value_buckets_are_per_client():
    alpha_here = bucket_digest(KEY, "slug", value_bucket(normalized_peer("192.0.2.1"), "alpha"))
    alpha_there = bucket_digest(KEY, "slug", value_bucket(normalized_peer("192.0.2.2"), "alpha"))
    assert alpha_here != alpha_there
    assert alpha_here != bucket_digest(KEY, "slug", "alpha")


@pytest.mark.parametrize("peer", ["", "unknown", "192.0.2.1,192.0.2.2", "fe80::1%en0"])
def test_invalid_peer_does_not_become_shared_or_forwarded_fallback(peer):
    with pytest.raises(DiscoveryUnavailableError):
        normalized_peer(peer)


@pytest.mark.parametrize("kind,value", [("slug", "alpha"), ("domain", "sub.example.test")])
def test_only_canonical_typed_values_enter_the_limiter(kind, value):
    validate_value(kind, value)


@pytest.mark.parametrize(
    "kind,value",
    [
        ("email", "a@example.test"),
        ("domain", "a@example.test"),
        ("slug", "Alpha"),
        ("domain", "EXAMPLE.test"),
        ("domain", "example.test."),
        ("domain", "localhost"),
    ],
)
def test_noncanonical_or_personal_values_refuse(kind, value):
    with pytest.raises(DiscoveryUnavailableError):
        validate_value(kind, value)


def test_admission_reports_the_tightest_post_charge_bucket():
    decision = evaluate({"global": [], "ip": []}, NOW)
    assert (decision.admitted, decision.scope, decision.limit, decision.remaining) == (
        True,
        "ip",
        30,
        29,
    )
    assert decision.reset_s == 60 and decision.retry_after_s is None


def test_controlling_exhaustion_uses_actual_expiry_ceiling():
    times = [NOW - timedelta(seconds=59.2)] * 30
    peer = evaluate({"global": [], "ip": times}, NOW)
    assert not peer.admitted and peer.retry_after_s == peer.reset_s == 1
    global_times = [NOW - timedelta(seconds=40)] * 600
    both = evaluate({"global": global_times, "ip": times}, NOW)
    assert both.scope == "global" and both.retry_after_s == 20


def test_events_at_exact_window_boundary_are_not_live():
    decision = evaluate({"slug": [NOW - timedelta(seconds=60)] * 60}, NOW)
    assert decision.admitted and decision.remaining == 59


def test_overfull_bucket_waits_until_sufficient_events_expire():
    times = [NOW - timedelta(seconds=59)] * 5 + [NOW - timedelta(seconds=30)] * 60
    decision = evaluate({"slug": times}, NOW)
    assert not decision.admitted and decision.retry_after_s == 30
