"""The workspace side of the channel set: docs/specs/ESPACE_STRUCTURE.md §13.

`apps/engine_intents` owns the set's storage, revision, delivery and acknowledgement; this module
owns what goes in (`channel_set_input`), when it is emitted (`emit`, from the transaction of every
change §13.2 lists) and what a result does to the workspace (`apply_result`).

**The lock order.** Domain rows before the engines' heads, never after: the structure operations
take the workspace row first (`administration.begin`) and emit last; a membership change locks the
workspace row (`lock_workspace`) before its member set takes the heads, then emits the channel
set. Two transactions therefore never hold a head while waiting for the workspace, and the later
of two concurrent changes computes its set after the earlier one committed, so it carries both.
"""

import logging
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.audit.services import record_channel_set_refused
from apps.engine_intents.channel_sets import (
    MAX_NOTICES,
    ChannelSetError as ChannelSetError,
    emit_channel_set,
)
from apps.engine_intents.services import lock_heads
from apps.identity.selectors import person_contacts, realm_subjects
from apps.orgs.actor_selectors import organisation_authority_revision
from apps.orgs.selectors import current_members

from .administration import Write, tag
from .channel_access import (
    LISTEN_ONLY,
    READ_ONLY,
    VIEW,
    Access,
    may_perform,
    may_view,
    resolve,
    resolve_all,
)
from .models import (
    POLICY_CAPABILITIES,
    Channel,
    ChannelNotice,
    ResourcePolicy,
    SingleChannelGuestGrant,
    Workspace,
    WorkspaceChannelRoleOverride,
    WorkspaceMemberRole,
    WorkspaceModerator,
)

log = logging.getLogger(__name__)

# The contract's subject shape: a subject outside it is left out, as the member set quarantines
# it, rather than refusing every set of the organisation.
SUBJECT = re.compile(r"[\x21-\x7e]{1,255}")
NOTICE = "{name} a rejoint ce salon en tant qu'administrateur"
ANONYMOUS = "Un administrateur"
# person_contacts reads at most this many people at once.
CONTACTS_PAGE = 200
DELETED = Channel.Lifecycle.DELETED
LOCK = "SELECT id FROM workspaces_workspace WHERE organisation_id = %s FOR UPDATE"


def lock_workspace(organisation_id: UUID) -> UUID | None:
    """The organisation's workspace row, locked in the caller's transaction, or None when it has
    no workspace. Taken before the engines' heads (see the module's lock order)."""
    with connection.cursor() as cursor:
        cursor.execute(LOCK, [organisation_id])
        row = cursor.fetchone()
    return None if row is None else row[0]


def _names(user_ids: set[UUID]) -> dict[UUID, str | None]:
    found: dict[UUID, str | None] = {}
    ordered = sorted(user_ids, key=str)
    for start in range(0, len(ordered), CONTACTS_PAGE):
        for person in person_contacts(user_ids=tuple(ordered[start : start + CONTACTS_PAGE])):
            found[person.id] = person.display_name
    return found


def _body(name: str | None) -> str:
    shown = (name or "").strip()
    return NOTICE.format(name=shown if shown else ANONYMOUS)


def channel_set_input(workspace_id: UUID) -> tuple[list[str], list[dict[str, Any]]]:
    """`(all_members, channels)` for `emit_channel_set`, computed in the caller's transaction,
    once per emission (§13.1)."""
    if not connection.in_atomic_block:
        raise RuntimeError("the channel set's input is computed in its change's transaction")
    organisation_id = Workspace.objects.values_list("organisation_id", flat=True).get(
        id=workspace_id
    )
    revision = organisation_authority_revision(organisation_id=organisation_id)
    members = current_members(organisation_id=organisation_id)
    from .models import WorkspaceMemberRestriction

    excluded = set(
        WorkspaceMemberRestriction.objects.filter(workspace_id=workspace_id)
        .filter(Q(banned=True) | Q(kicked=True))
        .values_list("membership_id", flat=True)
    )
    members = {key: value for key, value in members.items() if key not in excluded}
    usable: dict[UUID, set[str]] = {}
    for user_id, subject, is_usable in realm_subjects(organisation_id=organisation_id):
        if is_usable and SUBJECT.fullmatch(subject):
            usable.setdefault(user_id, set()).add(subject)
    subjects = {membership: usable.get(user, set()) for membership, (user, _) in members.items()}
    everyone = set().union(*subjects.values())

    def of(memberships: set[UUID]) -> list[str]:
        return sorted(set().union(*(subjects.get(m, set()) for m in memberships)))

    pending: dict[UUID, list[tuple[UUID, UUID]]] = {}
    for notice_id, channel_id, membership_id in (
        ChannelNotice.objects.filter(
            channel__workspace_id=workspace_id, acknowledged_at__isnull=True
        )
        .order_by("created_at", "id")
        .values_list("id", "channel_id", "membership_id")
    ):
        pending.setdefault(channel_id, []).append((notice_id, membership_id))
    names = _names({members[m][0] for items in pending.values() for _, m in items if m in members})

    member_roles: dict[UUID, list[str]] = {}
    member_perms: dict[UUID, set[str]] = {}
    for m_id, role_id, permissions in (
        WorkspaceMemberRole.objects.filter(workspace_id=workspace_id)
        .order_by("role_id")
        .values_list("membership_id", "role_id", "role__permissions")
    ):
        member_roles.setdefault(m_id, []).append(str(role_id))
        member_perms.setdefault(m_id, set()).update(
            p for p in permissions if p in POLICY_CAPABILITIES
        )
    role_ids_by_member = {m_id: tuple(sorted(set(r_ids))) for m_id, r_ids in member_roles.items()}
    perms_by_member = {m_id: frozenset(perms) for m_id, perms in member_perms.items()}
    moderators = set(
        WorkspaceModerator.objects.filter(workspace_id=workspace_id).values_list(
            "membership_id", flat=True
        )
    )
    overrides_by_channel: dict[UUID, list[tuple[str, tuple[str, ...], tuple[str, ...]]]] = {}
    for c_id, role_id, allow, deny in (
        WorkspaceChannelRoleOverride.objects.filter(workspace_id=workspace_id)
        .order_by("role_id")
        .values_list("channel_id", "role_id", "allow", "deny")
    ):
        overrides_by_channel.setdefault(c_id, []).append((str(role_id), tuple(allow), tuple(deny)))

    # Who views an un-overridden channel depends on its policy alone (the lifecycle is read as
    # active, §5), so un-overridden channels share cached viewer sets per (policy_id, revision, kind).
    viewing: dict[tuple[UUID, int, str], set[UUID]] = {}

    def viewers_of(
        access: Access,
        channel_overrides: list[tuple[str, tuple[str, ...], tuple[str, ...]]],
    ) -> set[UUID]:
        if not channel_overrides:
            key = (access.policy_id, access.revision, access.kind)
            if key not in viewing:
                viewing[key] = _viewers(
                    access,
                    members,
                    organisation_id,
                    revision,
                    role_ids_by_member=role_ids_by_member,
                    channel_overrides=[],
                )
            return viewing[key]
        return _viewers(
            access,
            members,
            organisation_id,
            revision,
            role_ids_by_member=role_ids_by_member,
            channel_overrides=channel_overrides,
        )

    channels = []
    confidential_ids = set(
        Channel.objects.filter(workspace_id=workspace_id, is_confidential=True)
        .exclude(lifecycle=DELETED)
        .values_list("id", flat=True)
    )
    guest_grants: dict[UUID, list[dict[str, str]]] = {}
    for grant in SingleChannelGuestGrant.objects.filter(
        single_channel__workspace_id=workspace_id,
        revoked_at__isnull=True,
        expires_at__gt=timezone.now(),
        guest_identity__enabled=True,
        guest_identity__deleted_at__isnull=True,
        guest_identity__user__enabled=True,
        guest_identity__user__deleted_at__isnull=True,
    ).order_by("matrix_user_id"):
        guest_grants.setdefault(grant.single_channel_id, []).append(
            {"user_id": grant.matrix_user_id, "room_id": grant.matrix_room_id}
        )

    for channel_id, (access, name, topic) in sorted(
        resolve_all(workspace_id).items(), key=lambda item: str(item[0])
    ):
        c_overrides = overrides_by_channel.get(channel_id, [])
        viewers = viewers_of(access, c_overrides)
        if (
            access.kind == Channel.Kind.AUDIO
            and revision is not None
            and (
                "media.connect" in access.denied
                or any(
                    "media.connect" in allow or "media.connect" in deny
                    for _, allow, deny in c_overrides
                )
            )
        ):
            admitted = {
                m
                for m in viewers
                if may_perform(
                    access,
                    action="media.connect",
                    organisation_id=organisation_id,
                    membership_id=m,
                    member_org_role=members[m][1],
                    authority_revision=revision,
                    is_moderator=m in moderators,
                    ignore_lifecycle=True,
                    member_role_ids=role_ids_by_member.get(m, ()),
                    member_role_permissions=perms_by_member.get(m, frozenset()),
                    channel_overrides=c_overrides,
                )
            }
        else:
            admitted = viewers

        everyone_sees = (
            access.visibility == ResourcePolicy.Visibility.ORGANISATION
            and VIEW not in access.denied
            and (access.kind != Channel.Kind.AUDIO or "media.connect" not in access.denied)
        )

        read_only = access.read_only
        listen_only = access.listen_only
        exempt_members: set[UUID] = set()
        speak_exempt_members: set[UUID] = set()
        if revision is not None:
            has_post_override = any(
                bool((set(allow) | set(deny)) & set(READ_ONLY)) for _, allow, deny in c_overrides
            )
            if read_only or has_post_override:
                posters = {
                    m
                    for m in admitted
                    if all(
                        may_perform(
                            access,
                            action=cap,
                            organisation_id=organisation_id,
                            membership_id=m,
                            member_org_role=members[m][1],
                            authority_revision=revision,
                            is_moderator=m in moderators,
                            ignore_lifecycle=True,
                            member_role_ids=role_ids_by_member.get(m, ()),
                            member_role_permissions=perms_by_member.get(m, frozenset()),
                            channel_overrides=c_overrides,
                        )
                        for cap in READ_ONLY
                    )
                }
                if read_only or posters != admitted:
                    read_only = True
                    exempt_members = posters
            if access.kind == Channel.Kind.AUDIO:
                has_speak_override = any(
                    bool((set(allow) | set(deny)) & set(LISTEN_ONLY))
                    for _, allow, deny in c_overrides
                )
                if listen_only or has_speak_override:
                    speakers = {
                        m
                        for m in admitted
                        if all(
                            may_perform(
                                access,
                                action=cap,
                                organisation_id=organisation_id,
                                membership_id=m,
                                member_org_role=members[m][1],
                                authority_revision=revision,
                                is_moderator=m in moderators,
                                ignore_lifecycle=True,
                                member_role_ids=role_ids_by_member.get(m, ()),
                                member_role_permissions=perms_by_member.get(m, frozenset()),
                                channel_overrides=c_overrides,
                            )
                            for cap in LISTEN_ONLY
                        )
                    }
                    if listen_only or speakers != admitted:
                        listen_only = True
                        speak_exempt_members = speakers

        effective_etag = (
            tag(
                {
                    "base_etag": access.etag,
                    "overrides": [
                        {
                            "role_id": r_id,
                            "allow": sorted(allow),
                            "deny": sorted(deny),
                        }
                        for r_id, allow, deny in c_overrides
                    ],
                }
            )
            if c_overrides
            else access.etag
        )
        notices = [
            {"notice_id": str(notice_id), "body": _body(names.get(members[membership][0]))}
            for notice_id, membership in pending.get(channel_id, [])
            if membership in admitted
        ][:MAX_NOTICES]
        entry: dict[str, Any] = {
            "channel_id": str(channel_id),
            "kind": access.kind,
            "name": name,
            "topic": topic,
            "access_etag": effective_etag,
            "archived": access.lifecycle == Channel.Lifecycle.ARCHIVED,
            "audience": "all" if everyone_sees else "listed",
            "members": [] if everyone_sees else of(admitted),
            "denied": sorted(set(of(set(members) - admitted)) & everyone) if everyone_sees else [],
            "read_only": read_only,
            "listen_only": listen_only,
            "exempt": of(exempt_members) if read_only else [],
            "notices": notices,
        }
        if access.kind == Channel.Kind.AUDIO and listen_only:
            entry["speak_exempt"] = of(speak_exempt_members)
        grants = guest_grants.get(channel_id, [])
        if grants:
            entry["guest_grants"] = grants
        if channel_id in confidential_ids:
            entry["confidential"] = "io.kodera.mls.v1"
        channels.append(entry)
    return sorted(everyone), channels


def _viewers(
    access: Access,
    members: dict[UUID, tuple[UUID, str]],
    organisation_id: UUID,
    revision: int | None,
    *,
    role_ids_by_member: dict[UUID, tuple[str, ...]] | None = None,
    channel_overrides: list[tuple[str, tuple[str, ...], tuple[str, ...]]] | None = None,
) -> set[UUID]:
    """The current memberships that pass `channel.view` on `access` and its role overrides."""
    if revision is None:
        return set()
    overrides = channel_overrides or []
    roles_map = role_ids_by_member or {}
    has_view_override = any(VIEW in allow or VIEW in deny for _, allow, deny in overrides)
    if not has_view_override:
        if VIEW in access.denied:
            return set()
        if access.visibility == ResourcePolicy.Visibility.ORGANISATION:
            return set(members) - set(access.deny_members)
        candidates = set(access.allow_members) & set(members)
    else:
        allow_role_set = {r_id for r_id, allow, _ in overrides if VIEW in allow}
        if VIEW in access.denied:
            candidates = {m for m in members if set(roles_map.get(m, ())) & allow_role_set}
        elif access.visibility == ResourcePolicy.Visibility.ORGANISATION:
            candidates = set(members) - set(access.deny_members)
        else:
            candidates = (set(access.allow_members) & set(members)) | {
                m for m in members if set(roles_map.get(m, ())) & allow_role_set
            }
    return {
        membership
        for membership in candidates
        if may_view(
            access,
            organisation_id=organisation_id,
            membership_id=membership,
            authority_revision=revision,
            member_role_ids=roles_map.get(membership, ()),
            channel_overrides=overrides,
        )
    }


Input = tuple[list[str], list[dict[str, Any]]]


def emit(write: Write, reason: str) -> None:
    """Record the next channel set, last in a structural write's transaction."""
    emit_for(
        organisation_id=write.caller.organisation_id, workspace_id=write.workspace_id, reason=reason
    )


def emit_for(
    *, organisation_id: UUID, workspace_id: UUID, reason: str, computed: Input | None = None
) -> None:
    """Record the organisation's next channel set in the caller's transaction, which already holds
    its domain rows. Without a `computed` input, the engines' heads are taken first and the input
    is read under them: a concurrent membership change that held the heads has committed by then,
    and the input sees it (§13.5). A set the emitter refuses raises `ChannelSetError`."""
    if computed is None:
        lock_heads(organisation_id)
        computed = channel_set_input(workspace_id)
    from .moderation import projection

    emit_channel_set(
        organisation_id=organisation_id,
        reason=reason,
        all_members=computed[0],
        channels=computed[1],
        moderation=projection(workspace_id),
    )


@dataclass(frozen=True, slots=True)
class Prepared:
    """A membership change's channel set, read under the workspace lock before the member set
    takes the heads."""

    organisation_id: UUID
    workspace_id: UUID
    computed: Input


def prepare(organisation_id: UUID) -> Prepared | None:
    """For the membership hooks, first: lock the workspace row, then read the input; None when
    the organisation has no workspace."""
    workspace_id = lock_workspace(organisation_id)
    if workspace_id is None:
        return None
    return Prepared(organisation_id, workspace_id, channel_set_input(workspace_id))


def emit_prepared(prepared: Prepared | None, *, reason: str) -> None:
    """For the membership hooks, last: the channel set, which never blocks the membership change.
    A set the emitter refuses is logged critical and audited, and the change commits (§13.5)."""
    if prepared is None:
        return
    try:
        with transaction.atomic():
            emit_for(
                organisation_id=prepared.organisation_id,
                workspace_id=prepared.workspace_id,
                reason=reason,
                computed=prepared.computed,
            )
    except ChannelSetError as refused:
        log.critical(
            "channel set of organisation %s refused after %s: %s",
            prepared.organisation_id,
            reason,
            refused,
        )
        record_channel_set_refused(
            organisation_id=prepared.organisation_id,
            workspace_id=prepared.workspace_id,
            reason=reason,
            problem=str(refused)[:200],
        )


def access_etag(channel_id: UUID) -> str:
    """A channel's current access tag, for a move that may change its inherited access."""
    return resolve(channel_id).etag


def _uuid(value: str) -> UUID | None:
    try:
        return UUID(value)
    except (TypeError, ValueError, AttributeError):
        return None


def apply_result(
    *,
    organisation_id: UUID,
    revision: int,
    ready: dict[str, str],
    failed: list[str],
    notices_posted: list[str],
) -> None:
    """§13.3, in the transaction that records the result. Each channel takes a result whose
    revision is at least the one that last set its room state; an id that is not a non-deleted
    channel of the organisation's workspace is ignored."""
    # The workspace row first, as every structural write takes it: the result path's order is
    # its command, then the workspace, then channels and notices, then (on a retry) the heads.
    workspace_id = lock_workspace(organisation_id)
    if workspace_id is None:
        return
    current = Channel.objects.filter(
        workspace_id=workspace_id, room_state_revision__lte=revision
    ).exclude(lifecycle=DELETED)
    for channel_id, etag in ready.items():
        found = _uuid(channel_id)
        if found is not None:
            current.filter(id=found).update(
                room_state=Channel.RoomState.READY,
                applied_access_etag=etag,
                room_state_revision=revision,
            )
    failing = [found for found in map(_uuid, failed) if found is not None]
    current.filter(id__in=failing).update(
        room_state=Channel.RoomState.FAILED, room_state_revision=revision
    )
    posted = [found for found in map(_uuid, notices_posted) if found is not None]
    ChannelNotice.objects.filter(
        id__in=posted, channel__workspace_id=workspace_id, acknowledged_at__isnull=True
    ).update(acknowledged_at=timezone.now())
