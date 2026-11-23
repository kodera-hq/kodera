"""Live channel authority fences tokens and evicts already connected media sessions."""

import pytest
from test_h2_3_governance import (
    bridged_guest as bridged_guest,
    governed as governed,
    world as world,
)
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
    with pytest.raises(ImproperlyConfigured, match="AUTHORITY_CONFIGURED"):
        channel_governance_enabled({"KODERA_CHANNEL_GOVERNANCE_ENABLED": "true"})
    assert (
        channel_governance_enabled(
            {
                "KODERA_CHANNEL_GOVERNANCE_ENABLED": "true",
                "KODERA_GOVERNANCE_AUTHORITY_CONFIGURED": "true",
            }
        )
        is True
    )


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


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("reason", ["suspended", "revoked", "guest-revoked", "guest-expired"])
def test_both_media_services_use_live_guest_and_agreement_authority(
    bridged_guest, monkeypatch, reason
):
    from urllib.parse import parse_qs, urlsplit

    from test_h2_3_governance import invalidate_bridge_guest

    from apps.engine_intents.services import channel_authority
    from room_access import clients
    from room_access.rooms import POLICY
    from room_access.service import CREATE

    grant = bridged_guest["grant"]
    room, user = grant.matrix_room_id, grant.matrix_user_id

    def core_request(url, method, headers, *args):
        query = parse_qs(urlsplit(url).query)
        result = channel_authority(
            token=headers["Authorization"].removeprefix("Bearer "),
            **{key: values[0] for key, values in query.items()},
        )
        return 200, result

    monkeypatch.setattr(clients, "_request", core_request)
    services = []
    for server, credential in zip(
        ["local.example.org", "peer.example.org"], bridged_guest["credentials"], strict=True
    ):
        matrix, livekit = FakeMatrix(), FakeLiveKit()
        matrix.rooms[room] = matrix.rooms.pop(AUDIO)
        matrix.rooms[room]["joined"].add(user)
        matrix.policy(room, audience="listed", members=[], local_only=False)
        matrix.rooms[room]["state"][CREATE] = {
            "m.federate": True,
            "io.kodera.room.federation": "partner",
        }
        host_agent = "@kodera-agent:local.example.org"
        matrix.senders[(room, POLICY)] = host_agent
        matrix.senders[(room, CREATE)] = host_agent
        monkeypatch.setattr(matrix, "whoami", lambda token: (user, "DEVICE"))
        authority = clients.CoreAuthority("https://core.example.org", credential)
        service = Service(
            matrix,
            livekit,
            "wss://media.example.org",
            "@kodera-agent:" + server,
            authority=authority,
        )
        assert service.grant("synthetic", room).token
        livekit.join(room, identity(user, "DEVICE"))
        services.append((service, livekit))
    invalidate_bridge_guest(bridged_guest, reason, monkeypatch)
    for service, livekit in services:
        with pytest.raises(RefusedError):
            service.grant("synthetic", room)
        service.refresh(livekit_room(room), room)
        assert livekit.removed == [identity(user, "DEVICE")]


@pytest.mark.parametrize(
    "extra", [{}, {"ROOM_ACCESS_CORE_AUTHORITY_ORIGIN": "https://core.example.org"}]
)
def test_media_governance_startup_requires_authority_and_credential(extra):
    from room_access.config import Config, ConfigError

    with pytest.raises(ConfigError, match="authority|AUTHORITY"):
        Config.from_env({"ROOM_ACCESS_CHANNEL_GOVERNANCE_ENABLED": "true", **extra})


@pytest.mark.parametrize("action", ["join", "event", "directory", "session", "call"])
def test_unit_foreign_grant_cannot_reclassify_victim_room(monkeypatch, action):
    from types import SimpleNamespace
    from uuid import uuid4

    from django.db.models import Q

    from apps.workspaces import bridges

    victim = uuid4()

    class Grants:
        def filter(self, scope, **kwargs):
            assert scope == Q(organisation_id=victim)
            assert kwargs == {"matrix_user_id": "@owner:victim.example.org"}
            return SimpleNamespace(first=lambda: None)

    class Agreements:
        def filter(self, *args, **kwargs):
            return self

        def first(self):
            return None

        def __iter__(self):
            return iter(())

    monkeypatch.setattr(bridges, "SingleChannelGuestGrant", SimpleNamespace(objects=Grants()))
    monkeypatch.setattr(bridges, "PartnerChannelAgreement", SimpleNamespace(objects=Agreements()))
    assert bridges.matrix_authority(
        organisation_id=victim,
        room_id="!own:victim.example.org",
        user_id="@owner:victim.example.org",
        action=action,
    ) == {"allowed": True, "role": "unmanaged", "revision": 0}


def test_media_authority_wiring_preserves_default_off_and_accepts_complete_activation():
    from room_access.config import Config

    env = {
        "ROOM_ACCESS_SYNAPSE_URL": "http://synapse:8008",
        "ROOM_ACCESS_MATRIX_TOKEN": "synthetic-matrix",
        "LIVEKIT_URL": "http://livekit:7880",
        "LIVEKIT_WS_URL": "wss://media.example.org",
        "LIVEKIT_API_KEY": "synthetic-key",
        "LIVEKIT_API_SECRET": "synthetic-secret",
        "ROOM_ACCESS_ALLOWED_ORIGINS": "https://chat.example.org",
        "ROOM_ACCESS_AGENT_USER": "@agent:chat.example.org",
        "ROOM_ACCESS_CORE_AUTHORITY_TOKEN": "synthetic-agent",
    }
    default = Config.from_env(env)
    assert default.core_authority_origin == default.core_authority_token == ""
    active = Config.from_env(
        {
            **env,
            "ROOM_ACCESS_CHANNEL_GOVERNANCE_ENABLED": "true",
            "ROOM_ACCESS_CORE_AUTHORITY_ORIGIN": "https://core.example.org",
        }
    )
    assert active.core_authority_origin == "https://core.example.org"
    assert active.core_authority_token == "synthetic-agent"
