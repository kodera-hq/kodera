"""The naming rules room-access shares with the tenant agent."""

import hashlib

POLICY = "io.kodera.room.policy"
OCCUPANCY = "io.kodera.room.occupancy"


def livekit_room(room_id: str) -> str:
    """The LiveKit room of an audio channel's Matrix room: stable, and no Matrix id leaks into
    LiveKit. tenant_agent/synapse.py names rooms by the same rule; tests/test_room_access.py pins
    that both agree."""
    return "kodera-" + hashlib.sha256(room_id.encode()).hexdigest()[:32]


def identity(user_id: str, device_id: str) -> str:
    """One LiveKit identity per device, so that a member's second tab does not replace the first."""
    return f"{user_id}|{device_id}"


def user_of(identity_: str) -> str:
    return identity_.split("|", 1)[0]
