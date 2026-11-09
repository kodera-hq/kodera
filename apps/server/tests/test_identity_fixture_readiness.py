"""Bounded fixture scheduling only; never launch a provider or accept Core proof."""

import inspect
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from dev import identity_fixture as fixture


def helper():
    assert hasattr(fixture, "wait_for_jwks"), "specified monotonic readiness helper missing"
    return fixture.wait_for_jwks


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        assert 0 < seconds <= 0.5
        self.sleeps.append(seconds)
        self.now += seconds


def run(transport, clock):
    wait = helper()
    with patch.object(fixture, "time", clock):
        return wait(transport)


def test_immediate_jwks_requires_no_sleep():
    transport = MagicMock()
    clock = Clock()
    run(transport, clock)
    transport.jwks.assert_called_once_with()
    assert clock.now == 0 and clock.sleeps == []


def test_transient_startup_after_nominal_old_window_can_complete():
    clock = Clock()

    def jwks():
        if clock.now < 90:
            raise fixture.FixtureError("synthetic transient refusal")
        return b"synthetic key document"

    transport = MagicMock(jwks=MagicMock(side_effect=jwks))
    run(transport, clock)
    assert clock.now == 90
    assert transport.jwks.call_count == 181


def test_permanent_unavailable_has_exact_deadline_no_late_request():
    clock = Clock()
    started = []

    def jwks():
        started.append(clock.now)
        raise fixture.FixtureError("synthetic unavailable")

    with pytest.raises(fixture.FixtureError, match="^local identity provider not ready$"):
        run(SimpleNamespace(jwks=jwks), clock)
    assert clock.now == 180
    assert len(started) == 360 and max(started) < 180


@pytest.mark.parametrize("succeeds", [False, True])
def test_last_request_can_finish_once_beyond_budget_without_another(succeeds):
    clock = Clock()
    started = []

    def jwks():
        started.append(clock.now)
        if clock.now >= 179.5:
            clock.now += 5
            if succeeds:
                return b"synthetic key document"
        raise fixture.FixtureError("synthetic unavailable")

    if succeeds:
        run(SimpleNamespace(jwks=jwks), clock)
    else:
        with pytest.raises(fixture.FixtureError, match="^local identity provider not ready$"):
            run(SimpleNamespace(jwks=jwks), clock)
    assert clock.now == 184.5
    assert len(started) == 360 and max(started) < 180
    assert clock.sleeps[-1] == 0.5


def test_sleep_is_capped_to_remaining_budget():
    clock = Clock()
    calls = []

    def jwks():
        calls.append(clock.now)
        clock.now += 0.3
        raise fixture.FixtureError("synthetic unavailable")

    with pytest.raises(fixture.FixtureError, match="^local identity provider not ready$"):
        run(SimpleNamespace(jwks=jwks), clock)
    assert max(calls) < 180 and clock.now <= 180.3
    assert all(sleep <= 0.5 for sleep in clock.sleeps)


def test_unexpected_error_remains_failure_without_retry():
    clock = Clock()
    transport = MagicMock(jwks=MagicMock(side_effect=RuntimeError("synthetic refusal")))
    with pytest.raises(RuntimeError, match="^synthetic refusal$"):
        run(transport, clock)
    transport.jwks.assert_called_once_with()
    assert clock.now == 0 and clock.sleeps == []


def test_owned_provider_keeps_finally_cleanup_on_readiness_refusal():
    helper()
    with (
        patch.object(
            fixture, "docker", return_value=SimpleNamespace(returncode=0, stdout="127.0.0.1:12345")
        ),
        patch.object(
            fixture,
            "wait_for_jwks",
            side_effect=fixture.FixtureError("local identity provider not ready"),
        ),
        patch.object(fixture, "remove_owned") as cleanup,
        pytest.raises(fixture.FixtureError, match="^local identity provider not ready$"),
        fixture.owned_provider(),
    ):
        pytest.fail("failed readiness must never yield a provider")
    assert cleanup.call_count == 3
    owner = cleanup.call_args_list[-1].args[1]
    assert [call.args for call in cleanup.call_args_list] == [
        ("container", owner + "-provider", owner),
        ("container", owner + "-db", owner),
        ("network", owner, owner),
    ]


def test_original_jwks_predicate_and_per_request_deadline_are_unchanged():
    helper()
    http = fixture.LoopbackHTTP(12345)
    assert http.deadline == 5.0
    with patch.object(http, "request", return_value=(503, [], b"synthetic unavailable")):
        with pytest.raises(fixture.FixtureError, match="^public key response refused$"):
            http.jwks()
    body = b"synthetic public key document"
    with patch.object(http, "request", return_value=(200, [], body)) as request:
        assert http.jwks() == body
    request.assert_called_once_with(
        "GET", "/realms/token-qualification/protocol/openid-connect/certs"
    )


@pytest.mark.parametrize(
    "old,new", [("+ 180", "+ 60"), ("time.monotonic() < deadline", "time.monotonic() <= deadline")]
)
def test_deadline_weakenings_lose_required_success_or_refusal(old, new):
    wait = helper()
    source = inspect.getsource(wait)
    assert source.count(old) == 1
    scope = vars(fixture)
    exec(compile(source.replace(old, new, 1), "readiness-scheduling-mutant", "exec"), scope)  # noqa: S102 - fixed scheduling mutation, fake clock/provider only
    mutant = scope["wait_for_jwks"]
    fixture.wait_for_jwks = wait
    with patch.object(fixture, "wait_for_jwks", mutant):
        if new == "+ 60":
            with pytest.raises(fixture.FixtureError, match="^local identity provider not ready$"):
                test_transient_startup_after_nominal_old_window_can_complete()
        else:
            with pytest.raises(AssertionError):
                test_permanent_unavailable_has_exact_deadline_no_late_request()
