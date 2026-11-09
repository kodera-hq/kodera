"""The caller's rendered view and its strong tag (PILOT_WORKSPACE_ONBOARDING.md §5).

The body is the canonical serialisation of CONVENTIONS.md §10's `GET /me` exception: sorted keys,
compact separators, unescaped Unicode, lists in stored order. The tag is the SHA-256 of exactly
those bytes, so two callers with two views have two tags, and a change to a row the caller cannot
see changes neither. No stored position or revision is ever part of either.
"""

import hashlib
import json
from typing import Any

from apps.workspaces.structure import ChannelView, WorkspaceView


def _channel(channel: ChannelView) -> dict[str, Any]:
    return {
        "id": str(channel.id),
        "kind": channel.kind,
        "name": channel.name,
        "template_key": channel.template_key,
        "topic": channel.topic,
        "lifecycle": channel.lifecycle,
        "room_state": channel.room_state,
    }


def serialize_workspace(view: WorkspaceView) -> tuple[bytes, str]:
    projection = {
        "organisation_id": str(view.organisation_id),
        "state": "not_initialised" if view.workspace_id is None else "initialised",
        "setup": {"state": view.setup.state, "reason": view.setup.reason},
        "can_initialise": view.can_initialise,
        "id": None if view.workspace_id is None else str(view.workspace_id),
        "categories": [
            {
                "id": str(category.id),
                "name": category.name,
                "template_key": category.template_key,
                "channels": [_channel(channel) for channel in category.channels],
            }
            for category in view.categories
        ],
        "uncategorised_channels": [_channel(channel) for channel in view.uncategorised_channels],
    }
    content = json.dumps(
        projection, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return content, '"' + hashlib.sha256(content).hexdigest() + '"'
