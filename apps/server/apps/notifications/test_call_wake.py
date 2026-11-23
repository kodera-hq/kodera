"""Synthetic internal call wake vectors and current-authority classification."""

# ruff: noqa: S101

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest

from apps.media.context import RefusalError

from . import call_wake

NOW = datetime.fromtimestamp(100, UTC)
ORG = "22222222-2222-4222-8222-222222222222"
CHANNEL = "33333333-3333-4333-8333-333333333333"
PAYLOAD: dict[str, str | int] = {
    "call_id": "11111111-1111-4111-8111-111111111111",
    "organisation_id": ORG,
    "channel_id": CHANNEL,
    "epoch": 1,
    "state": "ringing",
    "expires_at": 130,
}


@pytest.mark.parametrize(
    "change",
    [
        {"expires_at": 100},
        {"expires_at": 161},
        {"epoch": True},
        {"epoch": "1"},
        {"epoch": 0},
        {"epoch": 9_007_199_254_740_992},
        {"caller_name": "Private"},
        {"state": "connected"},
        {"call_id": "00000000-0000-0000-0000-000000000000"},
    ],
)
def test_call_wake_rejects_untrusted_fields_and_times(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        call_wake.decode(json.dumps({**PAYLOAD, **change}).encode(), now=NOW)


def test_call_wake_rejects_escaped_duplicate_fields() -> None:
    raw = json.dumps(PAYLOAD)[:-1] + ', "\\u0065poch": 2}'
    with pytest.raises(ValueError):
        call_wake.decode(raw.encode(), now=NOW)


@pytest.mark.django_db
@pytest.mark.parametrize("state", ["ringing", "answered_elsewhere", "ended"])
def test_cancellation_bypasses_foreground_suppression(
    monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    principal = SimpleNamespace(
        organisation_id=UUID(ORG),
        membership_id=UUID("44444444-4444-4444-8444-444444444444"),
        organisation_state="active",
        authority_revision=1,
    )
    monkeypatch.setattr(call_wake, "caller", Mock(return_value=principal))
    monkeypatch.setattr(call_wake, "workspace_id_for", Mock(return_value=UUID(ORG)))
    monkeypatch.setattr(
        call_wake,
        "channel_snapshot",
        Mock(
            return_value=SimpleNamespace(
                kind="audio", lifecycle="active", room_state="ready", is_confidential=False
            )
        ),
    )
    monkeypatch.setattr(call_wake, "resolve", Mock(return_value=object()))
    monkeypatch.setattr(call_wake, "may_view", Mock(return_value=True))
    monkeypatch.setattr(call_wake, "has_active_foreground_presence", Mock(return_value=True))
    raw = json.dumps({**PAYLOAD, "state": state}).encode()
    result = call_wake.classify(verified=Mock(), raw=raw, now=NOW)
    if state == "ringing":
        assert result is None
    else:
        assert result is not None and result.wire() == {**PAYLOAD, "state": state}
    monkeypatch.setattr(call_wake, "may_view", Mock(return_value=False))
    with pytest.raises(RefusalError):
        call_wake.classify(verified=Mock(), raw=raw, now=NOW)
    monkeypatch.setattr(call_wake, "may_view", Mock(return_value=True))
    monkeypatch.setattr(
        call_wake,
        "channel_snapshot",
        Mock(
            return_value=SimpleNamespace(
                kind="audio", lifecycle="active", room_state="ready", is_confidential=True
            )
        ),
    )
    with pytest.raises(RefusalError):
        call_wake.classify(verified=Mock(), raw=raw, now=NOW)
