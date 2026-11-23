"""Internal call-wake classification. No provider credential or public API is introduced."""

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db import transaction

from apps.media.context import RefusalError, caller
from apps.workspaces.channel_access import may_view, resolve
from apps.workspaces.selectors import channel_snapshot, workspace_id_for
from services.identity.access_tokens import VerifiedAccessToken

from .services import has_active_foreground_presence

_FIELDS = {"call_id", "organisation_id", "channel_id", "epoch", "state", "expires_at"}
_MAX_INTEGER = 9_007_199_254_740_991


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("call wake refused")
        result[key] = value
    return result


def _identifier(value: object) -> UUID:
    if not isinstance(value, str):
        raise ValueError("call wake refused")
    parsed = UUID(value)
    if parsed.int == 0 or str(parsed) != value:
        raise ValueError("call wake refused")
    return parsed


@dataclass(frozen=True, repr=False)
class CallWake:
    call_id: UUID
    organisation_id: UUID
    channel_id: UUID
    epoch: int
    state: str
    expires_at: int

    def wire(self) -> dict[str, str | int]:
        return {
            "call_id": str(self.call_id),
            "organisation_id": str(self.organisation_id),
            "channel_id": str(self.channel_id),
            "epoch": self.epoch,
            "state": self.state,
            "expires_at": self.expires_at,
        }


def decode(raw: bytes, *, now: datetime) -> CallWake:
    if not 0 < len(raw) <= 4096 or now.tzinfo is None:
        raise ValueError("call wake refused")
    try:
        obj = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("call wake refused") from None
    if not isinstance(obj, dict) or set(obj) != _FIELDS:
        raise ValueError("call wake refused")
    epoch, expiry, state = obj["epoch"], obj["expires_at"], obj["state"]
    timestamp = int(now.timestamp())
    if (
        type(epoch) is not int
        or not 1 <= epoch <= _MAX_INTEGER
        or type(expiry) is not int
        or not 0 < timestamp <= _MAX_INTEGER - 60
        or not timestamp < expiry <= timestamp + 60
        or not isinstance(state, str)
        or state not in {"ringing", "answered_elsewhere", "ended"}
    ):
        raise ValueError("call wake refused")
    return CallWake(
        _identifier(obj["call_id"]),
        _identifier(obj["organisation_id"]),
        _identifier(obj["channel_id"]),
        epoch,
        state,
        expiry,
    )


@transaction.atomic
def classify(*, verified: VerifiedAccessToken, raw: bytes, now: datetime) -> CallWake | None:
    """Recheck the recipient at use time; cancellation bypasses foreground ring suppression.

    Confidential calls fail closed until a device-bound MLS authority port is provisioned.
    Call state/epoch authenticity is the authenticated producer's responsibility; a relay hint
    never authorizes media. Invoke again at dispatch rather than retaining an admitted result.
    """
    wake = decode(raw, now=now)
    principal = caller(verified, wake.organisation_id)
    workspace = workspace_id_for(organisation_id=wake.organisation_id)
    channel = (
        channel_snapshot(workspace_id=workspace, channel_id=wake.channel_id)
        if workspace is not None
        else None
    )
    if (
        principal.organisation_state != "active"
        or channel is None
        or channel.lifecycle != "active"
        or channel.room_state != "ready"
        or channel.kind != "audio"
        or channel.is_confidential
        or not may_view(
            resolve(wake.channel_id),
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            authority_revision=principal.authority_revision,
        )
    ):
        raise RefusalError(404)
    if wake.state == "ringing" and has_active_foreground_presence(
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        now=now,
    ):
        return None
    return wake
