"""Deterministic owned-session cancellation controls; no database or native command."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from django.db import DatabaseError
from psycopg import capabilities, pq

from apps.identity import discovery_db as db
from services.identity.discovery_policy import DiscoveryUnavailableError


def setup_watchdog(monkeypatch, *, failure=False, live=False):
    calls, timers = [], []
    first = SimpleNamespace(
        cancel_safe=Mock(side_effect=RuntimeError("private-sentinel") if failure else None),
        close=Mock(),
    )
    replacement = SimpleNamespace(cancel_safe=Mock(), close=Mock())
    wrapper = SimpleNamespace(connection=first)

    def close():
        first.close()
        wrapper.connection = None

    wrapper.close = close

    class Timer:
        def __init__(self, interval, callback):
            self.callback = callback
            timers.append(self)

        def start(self):
            calls.append("start")

        def cancel(self):
            calls.append("cancel")

        def join(self, timeout):
            calls.append("join")

        def is_alive(self):
            return live

    monkeypatch.setattr(db.threading, "Timer", Timer)
    monkeypatch.setattr(db, "connection", wrapper)
    monkeypatch.setattr(db, "capabilities", SimpleNamespace(has_cancel_safe=lambda: True))
    return first, replacement, wrapper, timers, calls


@pytest.mark.parametrize("failure,live", [(False, False), (True, False), (False, True)])
def test_callback_targets_held_session_and_never_replacement(monkeypatch, failure, live):
    first, replacement, wrapper, timers, calls = setup_watchdog(
        monkeypatch, failure=failure, live=live
    )
    with pytest.raises(DiscoveryUnavailableError) as error:
        with db._cancel_at_deadline(db.Deadline()):
            wrapper.connection = replacement
            timers[0].callback()
            raise DatabaseError("private-sentinel")
    first.cancel_safe.assert_called_once_with(timeout=0.5)
    first.close.assert_called_once()
    replacement.cancel_safe.assert_not_called()
    replacement.close.assert_not_called()
    assert calls == ["start", "cancel", "join"]
    assert error.value.__context__ is None and error.value.__cause__ is None
    assert "private-sentinel" not in repr(vars(error.value))
    assert error.value.reason == (
        "database-cancellation-incomplete"
        if live
        else "database-cancellation"
        if failure
        else "database"
    )


def test_success_joins_without_disposing_healthy_session(monkeypatch):
    first, _, _, _, calls = setup_watchdog(monkeypatch)
    with db._cancel_at_deadline(db.Deadline()):
        pass
    assert calls == ["start", "cancel", "join"]
    first.cancel_safe.assert_not_called()
    first.close.assert_not_called()


def test_fired_watchdog_cannot_return_success_and_disposes_current_session(monkeypatch):
    first, _, wrapper, timers, calls = setup_watchdog(monkeypatch)
    with pytest.raises(DiscoveryUnavailableError):
        with db._cancel_at_deadline(db.Deadline()):
            timers[0].callback()
    first.close.assert_called_once()
    assert wrapper.connection is None and calls[-1] == "join"


def test_new_runtime_with_old_binding_build_refuses_bounded_cancel(monkeypatch):
    _, _, _, timers, _ = setup_watchdog(monkeypatch)
    monkeypatch.setattr(pq, "version", lambda: 180000)
    monkeypatch.setattr(pq, "__build_version__", 160000)
    monkeypatch.setattr(db, "capabilities", type(capabilities)())
    with pytest.raises(DiscoveryUnavailableError) as error:
        with db._cancel_at_deadline(db.Deadline()):
            pytest.fail("unsupported bounded cancellation entered operation")
    assert error.value.reason == "database-cancellation" and not timers
