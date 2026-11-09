"""Where a channel set's result goes back to the workspace: `ESPACE_STRUCTURE.md` §5 and §9.

Called once per terminal result of an `engine_set_channel_members` command, in the transaction that
records it. The workspace application stores each channel's `room_state` and applied access ETag,
and marks the posted notices as posted.

The workspace application applies it (`apps/workspaces/channel_sets.py`, ESPACE_STRUCTURE.md
§13.3): a channel takes a result whose revision is at least the one that last set its room state.
"""

from uuid import UUID


def channel_set_reported(
    *,
    organisation_id: UUID,
    revision: int,
    ready: dict[str, str],
    failed: list[str],
    notices_posted: list[str],
) -> None:
    """Called with the set's own `revision`, for a first, a retried or a late result. A late result
    of an older set can arrive after a newer one's (the agent reports the older set it ignored),
    so the workspace must leave alone a channel whose stored result revision is higher (§13.3).

    `ready`: channel id → the access ETag its room is now at. `failed`: channel ids whose room
    could not be converged. `notices_posted`: notice ids now posted, never to be sent again."""
    # Imported here: the workspace application reads this one's emitter.
    from apps.workspaces.channel_sets import apply_result

    apply_result(
        organisation_id=organisation_id,
        revision=revision,
        ready=ready,
        failed=failed,
        notices_posted=notices_posted,
    )
