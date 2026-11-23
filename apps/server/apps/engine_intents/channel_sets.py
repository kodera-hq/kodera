"""Emitting channel sets (ADR-0018, contract agent-api 0.5.0 `engine_set_channel_members`).

`emit_channel_set` is called by the workspace application, inside the transaction that changes what
a channel's Matrix room must be (`ESPACE_STRUCTURE.md` §9), with every channel that is not deleted.
It records the set under the organisation's next channel-set revision and one command per active
agent credential, superseding that credential's undelivered older channel set. Member-set commands
are untouched: each kind has its own revision line.

The set is validated against the contract here. A set the contract refuses is a programming error
on the caller's side: it raises, and the caller's change rolls back, rather than a malformed command
reaching an agent.
"""

import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection
from django.utils import timezone

from apps.audit.services import record_engine_channel_set_event

from .models import EngineAgentCredential, EngineChannelSet

MAX_CHANNELS = 500
# all_members plus every channel's members, denied and exempt, as the contract bounds a set.
MAX_MEMBERS = 10_000
MAX_NOTICES = 20
_SUBJECT = re.compile(r"[\x21-\x7e]{1,255}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# The workspace's reasons name the change, such as `channel.access_changed` (§13.2).
_REASON = re.compile(r"[a-z][a-z0-9_.]{0,63}")
_OPTIONAL_FIELDS = {"confidential", "speak_exempt", "guest_grants"}
_CONFIDENTIAL_ALGORITHMS = frozenset({"io.kodera.mls.v1", "m.megolm.v1.aes-sha2"})
_FIELDS = {
    "channel_id",
    "kind",
    "name",
    "topic",
    "access_etag",
    "archived",
    "audience",
    "members",
    "denied",
    "read_only",
    "listen_only",
    "exempt",
    "notices",
}


class ChannelSetError(ValueError):
    """The set does not satisfy the contract, or is asked for outside its change's transaction."""


def _subjects(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(s, str) and _SUBJECT.fullmatch(s) for s in value
    ):
        raise ChannelSetError(f"{what} must be a list of subjects")
    if len(set(value)) != len(value):
        raise ChannelSetError(f"{what} lists a subject twice")
    return sorted(value)


def _bool(entry: dict[str, Any], name: str) -> bool:
    value = entry.get(name)
    if not isinstance(value, bool):
        raise ChannelSetError(f"{name} must be a boolean")
    return value


def normalise(
    all_members: list[str], channels: list[dict[str, Any]]
) -> tuple[list[str], list[dict[str, Any]]]:
    """The organisation's Espace members and the channels in the contract's shape, sorted, or
    `ChannelSetError`. A channel's room holds `all_members` less `denied` (`audience: all`) or
    its `members` (`audience: listed`)."""
    everyone = _subjects(all_members, "all_members")
    if not isinstance(channels, list) or len(channels) > MAX_CHANNELS:
        raise ChannelSetError(f"a channel set holds at most {MAX_CHANNELS} channels")
    out, seen, members_total = [], set(), len(everyone)
    notice_ids: set[str] = set()
    for entry in channels:
        if (
            not isinstance(entry, dict)
            or not _FIELDS <= set(entry)
            or not set(entry) <= (_FIELDS | _OPTIONAL_FIELDS)
        ):
            raise ChannelSetError("a channel carries exactly the contract's fields")
        channel_id = str(entry["channel_id"]).lower()
        if not _UUID.fullmatch(channel_id) or channel_id in seen:
            raise ChannelSetError("channel ids are distinct UUIDs")
        seen.add(channel_id)
        kind = entry["kind"]
        if kind not in ("text", "audio"):
            raise ChannelSetError("kind is text or audio")
        raw_confidential = entry.get("confidential")
        if raw_confidential is None or raw_confidential is False:
            confidential_algo: str | None = None
        elif raw_confidential is True:
            confidential_algo = "io.kodera.mls.v1"
        elif isinstance(raw_confidential, str) and raw_confidential in _CONFIDENTIAL_ALGORITHMS:
            confidential_algo = raw_confidential
        else:
            raise ChannelSetError("confidential must be false or a supported room algorithm")
        if confidential_algo is not None and kind != "text":
            raise ChannelSetError("confidential rooms are for text channels")
        name, topic, etag = entry["name"], entry["topic"], entry["access_etag"]
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or not name.strip():
            raise ChannelSetError("a name is 1-100 characters and not blank")
        if not isinstance(topic, str) or len(topic) > 1024:
            raise ChannelSetError("a topic is at most 1,024 characters")
        if not isinstance(etag, str) or not 1 <= len(etag) <= 200:
            raise ChannelSetError("access_etag is 1-200 characters")
        read_only, listen_only = _bool(entry, "read_only"), _bool(entry, "listen_only")
        if listen_only and kind != "audio":
            raise ChannelSetError("listen_only is for audio rooms")
        audience = entry["audience"]
        if audience not in ("all", "listed"):
            raise ChannelSetError("audience is all or listed")
        members = _subjects(entry["members"], "members")
        denied = _subjects(entry["denied"], "denied")
        exempt = _subjects(entry["exempt"], "exempt")
        has_speak_exempt = "speak_exempt" in entry
        speak_exempt: list[str] = []
        if has_speak_exempt:
            if kind != "audio":
                raise ChannelSetError("speak_exempt is for audio rooms")
            speak_exempt = _subjects(entry["speak_exempt"], "speak_exempt")
        if (audience == "all" and members) or (audience == "listed" and denied):
            raise ChannelSetError("audience all lists denied subjects, listed lists members")
        if not set(members) <= set(everyone) or not set(denied) <= set(everyone):
            raise ChannelSetError("members and denied are among all_members")
        effective = set(everyone) - set(denied) if audience == "all" else set(members)
        if not set(exempt) <= effective:
            raise ChannelSetError("an exempt subject is a member")
        if has_speak_exempt and not set(speak_exempt) <= effective:
            raise ChannelSetError("a speak_exempt subject is a member")
        members_total += len(members) + len(denied) + len(exempt) + len(speak_exempt)
        notices = entry["notices"]
        if not isinstance(notices, list) or len(notices) > MAX_NOTICES:
            raise ChannelSetError(f"a channel carries at most {MAX_NOTICES} notices")
        for notice in notices:
            if (
                not isinstance(notice, dict)
                or set(notice) != {"notice_id", "body"}
                or not _UUID.fullmatch(str(notice["notice_id"]).lower())
                or not isinstance(notice["body"], str)
                or not 1 <= len(notice["body"]) <= 500
            ):
                raise ChannelSetError("a notice is a notice_id and a 1-500 character body")
            if str(notice["notice_id"]).lower() in notice_ids:
                raise ChannelSetError("a notice_id appears once in a set")
            notice_ids.add(str(notice["notice_id"]).lower())
        normalised_entry: dict[str, Any] = {
            "channel_id": channel_id,
            "kind": kind,
            "name": name,
            "topic": topic,
            "access_etag": etag,
            "archived": _bool(entry, "archived"),
            "audience": audience,
            "members": members,
            "denied": denied,
            "read_only": read_only,
            "listen_only": listen_only,
            "exempt": exempt,
            "notices": [
                {"notice_id": str(n["notice_id"]).lower(), "body": n["body"]} for n in notices
            ],
        }
        if "guest_grants" in entry:
            grants = entry["guest_grants"]
            if (
                not isinstance(grants, list)
                or len(grants) > 200
                or any(
                    not isinstance(grant, dict)
                    or set(grant) != {"user_id", "room_id"}
                    or not isinstance(grant["user_id"], str)
                    or re.fullmatch(r"@[^\s:]{1,255}:[a-z0-9.-]{1,253}", grant["user_id"]) is None
                    or not isinstance(grant["room_id"], str)
                    or re.fullmatch(r"![^\s:]{1,128}:[a-z0-9.-]{1,253}", grant["room_id"]) is None
                    for grant in grants
                )
                or len({grant["user_id"] for grant in grants}) != len(grants)
            ):
                raise ChannelSetError(
                    "guest grants are bounded distinct exact Matrix users and rooms"
                )
            normalised_entry["guest_grants"] = sorted(grants, key=lambda grant: grant["user_id"])
            members_total += len(grants)
        if has_speak_exempt:
            normalised_entry["speak_exempt"] = speak_exempt
        if confidential_algo is not None:
            normalised_entry["confidential"] = confidential_algo
        out.append(normalised_entry)
    if members_total > MAX_MEMBERS:
        # Refused, never truncated: a set that drops a member's removal lets them stay.
        raise ChannelSetError(f"a channel set lists at most {MAX_MEMBERS} members in all")
    return everyone, sorted(out, key=lambda c: c["channel_id"])


def emit_channel_set(
    *,
    organisation_id: UUID,
    reason: str,
    all_members: list[str],
    channels: list[dict[str, Any]],
    moderation: dict[str, Any] | None = None,
) -> EngineChannelSet:
    """Record the organisation's next channel set and one command per active agent credential."""
    from .services import _issue, _next_revision, _supersede, lock_heads

    if not connection.in_atomic_block:
        raise ChannelSetError("a channel set is recorded in the transaction of its change")
    if not isinstance(reason, str) or not _REASON.fullmatch(reason):
        raise ChannelSetError("reason is a lower-case identifier")
    everyone, normalised = normalise(all_members, channels)
    if moderation:
        if set(moderation) != {"banned_subjects", "muted_subjects"}:
            raise ChannelSetError("moderation carries exactly bans and mutes")
        banned = _subjects(moderation["banned_subjects"], "banned_subjects")
        muted = moderation["muted_subjects"]
        if not isinstance(muted, list) or len(banned) + len(muted) > MAX_MEMBERS:
            raise ChannelSetError("moderation exceeds the subject bound")
        seen = set()
        for entry in muted:
            if not isinstance(entry, dict) or set(entry) != {"subject", "expires_at"}:
                raise ChannelSetError("a mute carries subject and expiration")
            subject = _subjects([entry["subject"]], "muted_subjects")[0]
            if subject in seen:
                raise ChannelSetError("duplicate muted subject")
            seen.add(subject)
            from datetime import datetime

            try:
                expiration = datetime.fromisoformat(entry["expires_at"].replace("Z", "+00:00"))
                if expiration.tzinfo is None:
                    raise ValueError
            except (ValueError, AttributeError, TypeError):
                raise ChannelSetError("mute expiration needs an explicit timezone") from None
    _, head = lock_heads(organisation_id)
    # The credentials next, in id order, as the member set's emitter takes them.
    credential_ids = list(
        EngineAgentCredential.objects.select_for_update()
        .filter(organisation_id=organisation_id, state="active")
        .order_by("id")
        .values_list("id", flat=True)
    )
    head.revision = _next_revision(head.revision)
    head.save(update_fields=["revision"])
    channel_set = EngineChannelSet.objects.create(
        organisation_id=organisation_id,
        revision=head.revision,
        all_members=everyone,
        channels=normalised,
        moderation=moderation or {},
        reason=reason,
    )
    record_engine_channel_set_event(
        action="engine_channel_set.issued",
        channel_set_id=channel_set.id,
        organisation_id=organisation_id,
        agent_id=None,
        metadata={
            "revision": channel_set.revision,
            "reason": reason,
            "channels": len(normalised),
            "members": len(everyone),
            "listed": sum(len(c["members"]) + len(c["denied"]) for c in normalised),
            "notices": sum(len(c["notices"]) for c in normalised),
        },
    )
    now = timezone.now()
    for credential_id in credential_ids:
        _supersede(credential_id, now, channel=True)
        _issue(channel_set, credential_id, now, attempt=1)
    return channel_set


def results(
    channel_set: EngineChannelSet, *, succeeded: bool, failed_ids: list[str] | None
) -> tuple[dict[str, str], list[str], list[str]]:
    """What a terminal result says of each channel: (ready id → ETag, failed ids, notices posted).
    A failure without `failed_channel_ids` failed every channel; one with the list failed those
    channels only, and an empty list says every channel of the set converged (the agent failed
    elsewhere, as when a deleted channel's room could not be emptied). A notice is posted when
    its channel's room is ready."""
    if succeeded:
        failed: set[str] = set()
    elif failed_ids is None:
        failed = {c["channel_id"] for c in channel_set.channels}
    else:
        failed = set(failed_ids)
    ready = {
        c["channel_id"]: c["access_etag"]
        for c in channel_set.channels
        if c["channel_id"] not in failed
    }
    posted = [
        n["notice_id"]
        for c in channel_set.channels
        if c["channel_id"] in ready
        for n in c["notices"]
    ]
    return ready, sorted(failed & {c["channel_id"] for c in channel_set.channels}), posted


@dataclass(frozen=True, slots=True)
class ChannelSetSnapshot:
    id: UUID
    revision: int
    all_members: list[str]
    channels: list[dict[str, Any]]
    moderation: dict[str, Any]
    reason: str

    def to_agent_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "revision": self.revision,
            "all_members": list(self.all_members),
            "channels": list(self.channels),
        }
        if self.moderation:
            payload["moderation"] = dict(self.moderation)
        return payload


def to_snapshot(channel_set: EngineChannelSet) -> ChannelSetSnapshot:
    return ChannelSetSnapshot(
        id=channel_set.id,
        revision=channel_set.revision,
        all_members=list(channel_set.all_members),
        channels=list(channel_set.channels),
        moderation=dict(channel_set.moderation or {}),
        reason=channel_set.reason,
    )


def read_channel_set_snapshot(
    *, organisation_id: UUID, channel_set_id: UUID | None = None
) -> ChannelSetSnapshot | None:
    qs = EngineChannelSet.objects.filter(organisation_id=organisation_id)
    row = (
        qs.filter(id=channel_set_id).first()
        if channel_set_id is not None
        else qs.order_by("-revision").first()
    )
    return None if row is None else to_snapshot(row)


def snapshot_results(
    snapshot: ChannelSetSnapshot, *, succeeded: bool, failed_ids: list[str] | None
) -> tuple[dict[str, str], list[str], list[str]]:
    if succeeded:
        failed: set[str] = set()
    elif failed_ids is None:
        failed = {c["channel_id"] for c in snapshot.channels}
    else:
        failed = set(failed_ids)
    ready = {
        c["channel_id"]: c["access_etag"]
        for c in snapshot.channels
        if c["channel_id"] not in failed
    }
    posted = [
        n["notice_id"] for c in snapshot.channels if c["channel_id"] in ready for n in c["notices"]
    ]
    return ready, sorted(failed & {c["channel_id"] for c in snapshot.channels}), posted
