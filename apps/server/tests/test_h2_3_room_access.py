"""Live channel authority fences tokens and evicts already connected media sessions."""

import pytest
from test_room_access import AGENT, ALICE, AUDIO, FakeLiveKit, FakeMatrix

from room_access.rooms import identity, livekit_room
from room_access.service import RefusedError, Service


class Authority:
    active = True

    def allows(self, user, room):
        return self.active and user == ALICE and room == AUDIO


def test_guest_or_partner_revocation_refuses_token_and_evicts_active_session():
    matrix, livekit, authority = FakeMatrix(), FakeLiveKit(), Authority()
    service = Service(matrix, livekit, "wss://media.example.org", AGENT, authority=authority)
    assert service.grant("tok-alice", AUDIO).token
    with pytest.raises(RefusedError):
        service.grant("tok-alice", "!other:remote.example.org")
    livekit.join(AUDIO, identity(ALICE, "DEV1"))
    authority.active = False
    with pytest.raises(RefusedError):
        service.grant("tok-alice", AUDIO)
    service.refresh(livekit_room(AUDIO), AUDIO)
    assert livekit.removed == [identity(ALICE, "DEV1")]


@pytest.mark.parametrize("value", ["", "yes", "1", "TRUE"])
def test_operator_activation_requires_an_explicit_boolean(value):
    from django.core.exceptions import ImproperlyConfigured

    from config.workspace_features import channel_governance_enabled

    with pytest.raises(ImproperlyConfigured):
        channel_governance_enabled({"KODERA_CHANNEL_GOVERNANCE_ENABLED": value})
    assert channel_governance_enabled({}) is False
    assert channel_governance_enabled({"KODERA_CHANNEL_GOVERNANCE_ENABLED": "true"}) is True


def test_revocation_evicts_before_an_unavailable_matrix_policy(monkeypatch):
    from room_access.clients import UpstreamError

    matrix, livekit, authority = FakeMatrix(), FakeLiveKit(), Authority()
    service = Service(matrix, livekit, "wss://media.example.org", AGENT, authority=authority)
    livekit.join(AUDIO, identity(ALICE, "DEV1"))
    authority.active = False

    def unavailable(*args):
        raise UpstreamError("policy unavailable")

    monkeypatch.setattr(matrix, "state_event", unavailable)
    with pytest.raises(UpstreamError):
        service.refresh(livekit_room(AUDIO), AUDIO)
    assert livekit.removed == [identity(ALICE, "DEV1")]
