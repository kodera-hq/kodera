# ruff: noqa: S101
"""Room token and active-call moderation uses current trusted policy and server time."""

from datetime import UTC, datetime, timedelta

import pytest
from test_room_access import AGENT, ALICE, AUDIO, FakeLiveKit, FakeMatrix

from room_access.rooms import identity, livekit_room
from room_access.service import RefusedError, Service


def test_ban_refuses_even_an_existing_matrix_member():
    matrix, livekit = FakeMatrix(), FakeLiveKit()
    matrix.policy(AUDIO, banned=[ALICE])
    service = Service(matrix, livekit, "wss://media.example.org", AGENT)
    with pytest.raises(RefusedError) as failure:
        service.grant("tok-alice", AUDIO)
    assert failure.value.status == 403
    assert service.grant("tok-bob", AUDIO).listen_only is False
    livekit.join(AUDIO, identity(ALICE, "DEV1"))
    service.refresh(livekit_room(AUDIO), AUDIO)
    assert identity(ALICE, "DEV1") in livekit.removed


def test_mute_expires_without_a_background_job_and_restricts_active_call():
    matrix, livekit = FakeMatrix(), FakeLiveKit()
    service = Service(matrix, livekit, "wss://media.example.org", AGENT)
    matrix.policy(
        AUDIO, muted_until={ALICE: (datetime.now(UTC) + timedelta(minutes=1)).isoformat()}
    )
    assert service.grant("tok-alice", AUDIO).listen_only is True
    livekit.join(AUDIO, identity(ALICE, "DEV1"))
    service.refresh(livekit_room(AUDIO), AUDIO)
    assert (identity(ALICE, "DEV1"), False) in livekit.updates
    matrix.policy(
        AUDIO, muted_until={ALICE: (datetime.now(UTC) - timedelta(seconds=1)).isoformat()}
    )
    assert service.grant("tok-alice", AUDIO).listen_only is False

    service.refresh(livekit_room(AUDIO), AUDIO)
    assert (identity(ALICE, "DEV1"), True) in livekit.updates
