"""Emitting member sets and serving them, and channel sets, to tenant agents: ADR-0016, ADR-0018.

`emit_member_set` and `emit_member_left` are called by the membership lifecycle, inside the
transaction that changes a membership; `channel_sets.emit_channel_set` by the workspace changes.
The agent-facing functions implement the Agent API command loop
(`contracts/agent-api.openapi.yaml` 0.5.0) for the two kinds this application serves.

Lock order. An emission: the caller's domain rows (workspace, membership), then the member head,
then the channel head (`lock_heads`), then the credentials, then their pending commands. A pull, an
ack and a revocation: the credential, then its commands. A pull of the canonical community's agent
first records the sets its newcomers are owed, as an emission of its own that has committed before
the pull takes its credential. A result is the one exception: it locks its
own command row first, then, for a retry, both heads. It never waits on another command, and an
emission only touches pending commands, which a reported one never is.
"""

import hashlib
import hmac
import logging
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Max, Q
from django.utils import timezone

from apps.audit.services import record_engine_channel_set_event, record_engine_member_set_event
from apps.identity.selectors import realm_subjects
from apps.orgs.actor_selectors import organisation_authority_revision
from apps.orgs.membership_pagination import DirectoryQuery
from apps.orgs.membership_selectors import directory_memberships
from apps.orgs.selectors import organisation_slug

from . import channel_hooks
from .channel_sets import results as channel_results
from .models import (
    CHANNEL_KIND,
    COMMAND_KIND,
    TERMINAL_STATES,
    EngineAgentCredential,
    EngineChannelSet,
    EngineChannelSetHead,
    EngineCommand,
    EngineKnownSubject,
    EngineMemberSet,
    EngineMemberSetHead,
)

log = logging.getLogger(__name__)

MAX_SUBJECTS = 10_000
# The lag alert warns from here, well before a change is refused at the bound.
WARN_SUBJECTS = 8_000
VISIBILITY_TIMEOUT_S = 300
# ADR-0018: Core answers at once and never holds a connection; an agent polling every 3 s sees a
# removal within about 3 s.
POLL_AFTER_S = 3
REFRESH_AFTER = timedelta(hours=24)
EXPIRES_AFTER = timedelta(days=30)
LAG_ALERT_AFTER = timedelta(hours=1)
# How long a refused rebuild of a stale member set waits before the next poll tries it again.
REFRESH_RETRY_AFTER = timedelta(minutes=5)
DEADLINE_S = 600
# The contract's subject shape (MemberSubjects): a Keycloak subject is a UUID in practice.
_SUBJECT = re.compile(r"[\x21-\x7e]{1,255}")
_TOKEN = re.compile(
    r"eac1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})"
)
# Transient failures are reissued under a new command id, with backoff; the set converges.
RETRYABLE = frozenset(
    {
        "service_unhealthy",
        "network_unreachable",
        "timeout",
        "interrupted",
        "expired",
        "internal_error",
    }
)
ERROR_CODES = frozenset(
    {
        "unsupported_kind",
        "invalid_payload",
        "precondition_failed",
        "already_running",
        "maintenance_required",
        "config_fetch_failed",
        "config_invalid",
        "image_pull_failed",
        "digest_mismatch",
        "signature_invalid",
        "migration_failed",
        "preflight_failed",
        "snapshot_failed",
        "restore_failed",
        "backup_failed",
        "disk_full",
        "service_unhealthy",
        "network_unreachable",
        "permission_denied",
        "timeout",
        "expired",
        "cancelled",
        "interrupted",
        "internal_error",
    }
)  # the contract's CommandErrorCode, a closed enum
ARTEFACTS = frozenset(
    {
        "revision_applied",
        "users_deactivated",
        "users_reactivated",
        "documents_kicked",
        "participants_removed",
        "users_erased",
    }
)
CHANNEL_ARTEFACTS = frozenset({"revision_applied", "channels_applied", "notices_posted"})
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


@dataclass(frozen=True)
class _Kind:
    """One command kind this application serves: its head, its sets, and the command's column."""

    name: str
    head: Any
    sets: Any
    field: str


MEMBERS = _Kind(COMMAND_KIND, EngineMemberSetHead, EngineMemberSet, "member_set")
CHANNELS = _Kind(CHANNEL_KIND, EngineChannelSetHead, EngineChannelSet, "channel_set")
SERVED = (MEMBERS, CHANNELS)


def _kind_of(command: EngineCommand) -> _Kind:
    return CHANNELS if command.channel_set_id is not None else MEMBERS


def _channel_set(command: EngineCommand) -> EngineChannelSet:
    if command.channel_set is None:
        raise RuntimeError("a channel command delivers a channel set")
    return command.channel_set


def _member_set(command: EngineCommand) -> EngineMemberSet:
    if command.member_set is None:
        raise RuntimeError("a member command delivers a member set")
    return command.member_set


class MemberSetError(ValueError):
    """The member set could not be recorded, and the caller's transaction rolls back with it."""


class MemberSetRefusedError(MemberSetError):
    """Failing closed (ADR-0016): a leaver of this change has a subject outside the contract's
    shape, or the set exceeds the bound while an agent would receive it. The membership change rolls back;
    `record_member_set_refusal` then records it, after the rollback, for an operator."""

    def __init__(self, organisation_id: UUID, reason: str, problem: str, **counts: int) -> None:
        super().__init__(f"member set of organisation {organisation_id} refused: {problem}")
        self.organisation_id = organisation_id
        self.reason = reason
        self.problem = problem
        self.counts = counts


class CommandNotFoundError(LookupError):
    """No such command for this credential: answered 404, as for any other instance's command."""


class CommandConflictError(Exception):
    """Terminal already (on ack), not dispatched yet, or another terminal result: 409."""


class InvalidResultError(ValueError):
    """The reported result contradicts the contract: 400."""


# --- emission -------------------------------------------------------------------------------


def _realm_subjects(
    organisation_id: UUID,
) -> tuple[dict[UUID, set[str]], dict[UUID, set[str]], dict[UUID, set[str]], set[str]]:
    """This organisation's realm subjects, in two queries: each user's usable subjects, each
    user's recorded subjects, each user's subjects outside the contract's shape, and the recorded
    subjects of erased people. Erasure is only ever the explicit mark `mark_erased` writes: a
    soft-deleted or purged row is a leaver kept for retention, never an erasure.

    Usable is an enabled, not deleted identity. Recorded is every subject ever read in the realm:
    every identity row counts, disabled and soft-deleted ones included, since the row keeps its
    subject, and a newly read subject is recorded here so that it still resolves once the row is
    purged. A subject outside the contract's shape is never recorded (the table's check constraint
    refuses it); the caller decides what it means."""
    usable: dict[UUID, set[str]] = {}
    recorded: dict[UUID, set[str]] = {}
    malformed: dict[UUID, set[str]] = {}
    erased: set[str] = set()
    for user_id, subject, erased_at in EngineKnownSubject.objects.filter(
        organisation_id=organisation_id
    ).values_list("user_id", "subject", "erased_at"):
        recorded.setdefault(user_id, set()).add(subject)
        if erased_at is not None:
            erased.add(subject)
    new: list[EngineKnownSubject] = []
    for user_id, subject, is_usable in realm_subjects(organisation_id=organisation_id):
        if is_usable:
            usable.setdefault(user_id, set()).add(subject)
        if not _SUBJECT.fullmatch(subject):
            malformed.setdefault(user_id, set()).add(subject)
        elif subject not in recorded.setdefault(user_id, set()):
            recorded[user_id].add(subject)
            new.append(
                EngineKnownSubject(
                    organisation_id=organisation_id, user_id=user_id, subject=subject
                )
            )
    # Under the head lock, so no concurrent emission records the same row.
    EngineKnownSubject.objects.bulk_create(new)
    return usable, recorded, malformed, erased


def mark_erased(*, organisation_id: UUID, user_id: UUID) -> int:
    """Record that this person was erased (ADR-0011), in the erasure's own transaction: their
    recorded subjects are listed `erased_subjects` from the next member set on, and the agent
    erases their messaging account. The only way a subject becomes erased. Returns how many
    subjects it marked."""
    existing = set(
        EngineKnownSubject.objects.filter(
            organisation_id=organisation_id, user_id=user_id
        ).values_list("subject", flat=True)
    )
    new: list[EngineKnownSubject] = []
    for uid, subject, _usable in realm_subjects(organisation_id=organisation_id):
        if uid == user_id and _SUBJECT.fullmatch(subject) and subject not in existing:
            existing.add(subject)
            new.append(
                EngineKnownSubject(
                    organisation_id=organisation_id, user_id=user_id, subject=subject
                )
            )
    if new:
        EngineKnownSubject.objects.bulk_create(new, ignore_conflicts=True)
    marked: int = EngineKnownSubject.objects.filter(
        organisation_id=organisation_id, user_id=user_id, erased_at__isnull=True
    ).update(erased_at=timezone.now())
    return marked


def _members(organisation_id: UUID, state: str) -> set[UUID]:
    users: set[UUID] = set()
    continuation: tuple[UUID, UUID] | None = None
    query = DirectoryQuery(limit=500, role=None, state=state, cursor=None)
    while True:
        page, ceiling = directory_memberships(
            organisation_id=organisation_id, query=query, continuation=continuation
        )
        users.update(member.user_id for member in page[: query.limit])
        if len(page) <= query.limit or ceiling is None:
            return users
        continuation = (page[query.limit - 1].id, ceiling)


def lock_heads(organisation_id: UUID) -> tuple[EngineMemberSetHead, EngineChannelSetHead]:
    """Both of the organisation's heads, locked in one order: the member set's, then the channel
    set's, and only then any credential. Every emitter and every retry takes them so, because a
    membership change emits both kinds in one transaction (ESPACE_STRUCTURE.md §13.2): two
    orders would deadlock it against a workspace change or a reported failure."""
    with connection.cursor() as cursor:
        for table in ("engine_intents_head", "engine_intents_channel_head"):
            cursor.execute(
                f"INSERT INTO {table} (organisation_id, revision) VALUES (%s, 0) "  # noqa: S608
                "ON CONFLICT (organisation_id) DO NOTHING",
                [organisation_id],
            )
    member = EngineMemberSetHead.objects.select_for_update().get(organisation_id=organisation_id)
    channel = EngineChannelSetHead.objects.select_for_update().get(organisation_id=organisation_id)
    return member, channel


def _next_revision(current: int) -> int:
    """Strictly increasing, and ahead of the clock in microseconds: after a restore of Core's
    database, new revisions are still higher than any an agent has already applied."""
    return max(current + 1, int(time.time() * 1_000_000))


def emit_member_set(
    *, organisation_id: UUID, reason: str, left_user_ids: tuple[UUID, ...] = ()
) -> EngineMemberSet:
    """Record the organisation's next member set and one command per active agent credential.

    Called inside the transaction that changes a membership, after the change. The head row lock
    serialises two concurrent changes, so the later revision includes both.

    - active: the enabled identity subjects of the active members.
    - inactive: every other subject ever read in this organisation's realm (`_realm_subjects`),
      until it is active again. Each set rebuilds the full list.
    - released: whoever was listed inactive in the previous set and is active now, plus the
      previous released list until every active agent has applied the set that listed it.

    Fails closed (`MemberSetRefusedError`, the change rolls back) when a leaver of this change has
    a subject outside the contract's shape, or when the set exceeds the bound and an agent would
    receive it. Any other subject outside the shape is left out and counted: an active one grants
    less, and a legacy inactive one is quarantined rather than blocking every later change. A
    leaver with no subject at all is counted: there is nothing to deny (ADR-0016).
    """
    if not connection.in_atomic_block:
        raise MemberSetError("a member set is recorded in the transaction of its change")
    head, _ = lock_heads(organisation_id)
    # Before any member is read: a membership or identity write that commits after this read
    # advances the organisation's revision past the one this set records, and is then seen as
    # owed a rebuild (`member_set_refresh_due`); one this set already includes costs a rebuild
    # too many, never one too few.
    authority_revision = organisation_authority_revision(organisation_id=organisation_id)
    # Then the credentials, in id order: a pull locks its credential before its commands, so the
    # two never wait on each other's command rows.
    credential_ids = list(
        EngineAgentCredential.objects.select_for_update()
        .filter(organisation_id=organisation_id, state="active")
        .order_by("id")
        .values_list("id", flat=True)
    )
    previous = EngineMemberSet.objects.filter(
        organisation_id=organisation_id, revision=head.revision
    ).first()
    was_inactive = set(previous.inactive_subjects) if previous else set()
    usable, by_user, malformed_by_user, erased_people = _realm_subjects(organisation_id)
    leavers = set(left_user_ids)
    denied_now = set().union(*(malformed_by_user.get(user_id, set()) for user_id in leavers))
    if denied_now:
        log.critical(
            "member set of organisation %s refused: a leaver's subject is outside the contract's "
            "shape",
            organisation_id,
        )
        raise MemberSetRefusedError(
            organisation_id, reason, "malformed_subjects", malformed_subjects=len(denied_now)
        )
    unnamed = sum(1 for user_id in leavers if not by_user.get(user_id))
    if unnamed:
        log.error(
            "member set of organisation %s: %s leaver(s) with no realm subject, current or recorded",
            organisation_id,
            unnamed,
        )
    # Only an active member's enabled identity is active. Every other subject ever read in this
    # realm is inactive: a leaver's, a suspended or removed member's (removed before the hooks were
    # wired included), and an active member's disabled one.
    active = set().union(
        *(usable.get(user_id, set()) for user_id in _members(organisation_id, "active"))
    )
    # Any other subject outside the shape, an active member's or a legacy one, is quarantined.
    left_out = set().union(*malformed_by_user.values())
    if left_out:
        log.critical(
            "member set of organisation %s: %s subject(s) outside the contract's shape left out",
            organisation_id,
            len(left_out),
        )
    active -= left_out
    inactive = set().union(*by_user.values()) - active
    # An erased person's accounts are erased too (ADR-0018, Leaving and erasure); always inactive.
    erased = sorted((erased_people & inactive) - left_out)
    released = was_inactive & active
    if previous and previous.released_subjects and not _applied_by_all(previous):
        released |= set(previous.released_subjects) & active
    size = len(active) + len(inactive) + len(released) + len(erased)
    if size > MAX_SUBJECTS:
        if credential_ids:
            # Refused, never truncated: a set that drops a leaver would let them back in.
            log.critical(
                "member set of organisation %s refused: %s subjects exceed %s",
                organisation_id,
                size,
                MAX_SUBJECTS,
            )
            raise MemberSetRefusedError(
                organisation_id, reason, "over_bound", subjects=size, bound=MAX_SUBJECTS
            )
        # No agent would receive it: recorded, and reported by the lag alert.
        log.critical(
            "member set of organisation %s: %s subjects exceed %s, and no agent is enrolled",
            organisation_id,
            size,
            MAX_SUBJECTS,
        )
    head.revision = _next_revision(head.revision)
    head.refused_at = None
    head.refused_problem = ""
    head.save(update_fields=["revision", "refused_at", "refused_problem"])
    member_set = EngineMemberSet.objects.create(
        organisation_id=organisation_id,
        revision=head.revision,
        active_subjects=sorted(active),
        inactive_subjects=sorted(inactive),
        released_subjects=sorted(released),
        erased_subjects=erased,
        reason=reason,
        unnamed_leavers=unnamed,
        malformed_subjects=len(left_out),
        authority_revision=authority_revision,
    )
    record_engine_member_set_event(
        action="engine_member_set.issued",
        member_set_id=member_set.id,
        organisation_id=organisation_id,
        agent_id=None,
        metadata={
            "revision": member_set.revision,
            "reason": reason,
            "active": len(active),
            "inactive": len(inactive),
            "released": len(released),
            **({"erased": len(erased)} if erased else {}),
            **({"unnamed_leavers": unnamed} if unnamed else {}),
            **({"malformed_subjects": len(left_out)} if left_out else {}),
        },
    )
    now = timezone.now()
    for credential_id in credential_ids:
        _supersede(credential_id, now)
        _issue(member_set, credential_id, now, attempt=1)
    return member_set


def member_set_refresh_due(*, organisation_id: UUID, now: datetime | None = None) -> bool:
    """Whether the organisation's latest member set is behind its membership: recorded at an
    older authority revision than the organisation's, or not recorded at all. Two indexed reads,
    no lock, and never a list of members: cheap enough for every agent poll.

    Not due while the last attempt was refused less than `REFRESH_RETRY_AFTER` ago: a set that
    cannot be recorded (over the bound, say) is not rebuilt on every poll."""
    head = (
        EngineMemberSetHead.objects.filter(organisation_id=organisation_id)
        .values_list("revision", "refused_at")
        .first()
    )
    if head is not None and head[1] is not None:
        if (now or timezone.now()) - head[1] < REFRESH_RETRY_AFTER:
            return False
    recorded = (
        None
        if head is None or head[0] == 0
        else EngineMemberSet.objects.filter(organisation_id=organisation_id, revision=head[0])
        .values_list("authority_revision", flat=True)
        .first()
    )
    current = organisation_authority_revision(organisation_id=organisation_id)
    return current is not None and recorded != current


def record_member_set_refusal(refused: MemberSetRefusedError) -> None:
    """After the refused change rolled back, in a transaction of its own: mark the organisation's
    head refused, which the lag alert reports until a set is recorded again, and write the
    `engine_member_set.refused` audit row an operator acts on."""
    if connection.in_atomic_block:
        raise MemberSetError("a refusal is recorded after the refused change rolled back")
    organisation_id = refused.organisation_id
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO engine_intents_head (organisation_id, revision) VALUES (%s, 0) "
                "ON CONFLICT (organisation_id) DO NOTHING",
                [organisation_id],
            )
        EngineMemberSetHead.objects.filter(organisation_id=organisation_id).update(
            refused_at=timezone.now(), refused_problem=refused.problem
        )
        record_engine_member_set_event(
            action="engine_member_set.refused",
            member_set_id=None,
            organisation_id=organisation_id,
            organisation_slug=organisation_slug(organisation_id=organisation_id),
            agent_id=None,
            metadata={"reason": refused.reason, "problem": refused.problem, **refused.counts},
        )


def emit_member_left(membership: Any, *, reason: str = "member_left") -> EngineMemberSet:
    """The leave form: `membership` has just been removed or suspended in this transaction, and
    the leaver's realm identity is still enabled."""
    return emit_member_set(
        organisation_id=membership.organisation_id,
        reason=reason,
        left_user_ids=(membership.user_id,),
    )


def _applied_by_all(member_set: EngineMemberSet) -> bool:
    """Every active credential of the organisation has applied this set's revision or a later one."""
    credentials = EngineAgentCredential.objects.filter(
        organisation_id=member_set.organisation_id, state="active"
    ).values_list("id", flat=True)
    for credential_id in credentials:
        applied = EngineCommand.objects.filter(
            credential_id=credential_id, state="succeeded"
        ).aggregate(revision=Max("member_set__revision"))["revision"]
        if applied is None or applied < member_set.revision:
            return False
    return True


def _supersede(credential_id: UUID, now: datetime, *, channel: bool = False) -> None:
    """A credential's undelivered older commands of one kind are never delivered once a newer set
    of that kind exists. The other kind's commands are untouched."""
    EngineCommand.objects.filter(
        credential_id=credential_id, state="pending", channel_set__isnull=not channel
    ).update(state="superseded", finished_at=now)


def _issue(
    the_set: EngineMemberSet | EngineChannelSet,
    credential_id: UUID,
    now: datetime,
    *,
    attempt: int,
    not_before: datetime | None = None,
) -> EngineCommand:
    which = "channel_set" if isinstance(the_set, EngineChannelSet) else "member_set"
    return EngineCommand.objects.create(
        **{which: the_set},
        credential_id=credential_id,
        attempt=attempt,
        issued_at=now,
        not_before=not_before or now,
    )


# --- credentials ----------------------------------------------------------------------------


def _digest(secret: str) -> str:
    # The secret is 256 random bits: a plain SHA-256 is enough, and cheap on every pull.
    return hashlib.sha256(secret.encode()).hexdigest()


def issue_credential(*, organisation_id: UUID, tenant_ref: UUID | None = None) -> tuple[UUID, str]:
    """A new agent credential and its token `eac1_<id>_<secret>`, shown once. Only the secret's
    SHA-256 is stored."""
    secret = secrets.token_urlsafe(32)
    credential = EngineAgentCredential.objects.create(
        organisation_id=organisation_id, tenant_ref=tenant_ref, secret_hash=_digest(secret)
    )
    return credential.id, f"eac1_{credential.id}_{secret}"


def revoke_credential(*, credential_id: UUID) -> None:
    now = timezone.now()
    with transaction.atomic():
        EngineAgentCredential.objects.filter(id=credential_id, state="active").update(
            state="revoked", revoked_at=now
        )
        EngineCommand.objects.filter(
            credential_id=credential_id, state__in=("pending", "dispatched", "accepted")
        ).update(state="superseded", finished_at=now)


def authenticate(token: str) -> EngineAgentCredential | None:
    match = _TOKEN.fullmatch(token) if isinstance(token, str) else None
    if match is None:
        return None
    credential = EngineAgentCredential.objects.filter(id=match.group(1), state="active").first()
    # Compared even for an unknown id, so that the answer's timing does not tell ids apart.
    expected = credential.secret_hash if credential else _digest("")
    if not hmac.compare_digest(expected, _digest(match.group(2))) or credential is None:
        return None
    EngineAgentCredential.objects.filter(id=credential.id).update(last_seen_at=timezone.now())
    return credential


# --- the command loop -----------------------------------------------------------------------


@dataclass(frozen=True)
class Pulled:
    commands: list[dict[str, Any]]
    visibility_timeout_s: int = VISIBILITY_TIMEOUT_S
    poll_after_s: int = POLL_AFTER_S


def _as_command(command: EngineCommand) -> dict[str, Any]:
    if command.channel_set_id is not None:
        kind = CHANNEL_KIND
        channel_set = _channel_set(command)
        payload = {
            "revision": channel_set.revision,
            "all_members": channel_set.all_members,
            "channels": channel_set.channels,
            **channel_set.moderation,
        }
    else:
        member_set = _member_set(command)
        kind = COMMAND_KIND
        payload = {
            "revision": member_set.revision,
            "active_subjects": member_set.active_subjects,
            "inactive_subjects": member_set.inactive_subjects,
            "released_subjects": member_set.released_subjects,
            "erased_subjects": member_set.erased_subjects or [],
        }
    return {
        "command_id": str(command.id),
        "kind": kind,
        "payload": payload,
        "issued_at": command.issued_at.isoformat(),
        "expires_at": (command.issued_at + EXPIRES_AFTER).isoformat(),
        "deadline_s": DEADLINE_S,
        "attempt": command.attempt,
        "job_id": None,
        "priority": "high",
    }


def _ensure_latest(credential: EngineAgentCredential, now: datetime, kind: _Kind) -> None:
    """A credential that never received the latest set of a kind, or whose last command for it
    ended a day ago (applied, or failed beyond retry), gets it again."""
    head = kind.head.objects.filter(organisation_id=credential.organisation_id).first()
    if head is None or head.revision == 0:
        return
    # The id only: a poll every 3 s never loads a set's lists; the payload is read on delivery.
    the_set = kind.sets.objects.only("id", "revision", "organisation_id").get(
        organisation_id=credential.organisation_id, revision=head.revision
    )
    latest = (
        EngineCommand.objects.filter(credential_id=credential.id, **{kind.field: the_set})
        .exclude(state="superseded")
        .order_by("-issued_at")
        .first()
    )
    stale = (
        latest is not None
        and latest.state in ("succeeded", "failed")
        and latest.finished_at is not None
        and latest.finished_at <= now - REFRESH_AFTER
        and not EngineCommand.objects.filter(
            credential_id=credential.id, state="pending", **{kind.field: the_set}
        ).exists()
    )
    if latest is None or stale:
        _supersede(credential.id, now, channel=kind is CHANNELS)
        _issue(the_set, credential.id, now, attempt=1 if latest is None else latest.attempt + 1)


def pull(credential: EngineAgentCredential, *, kinds: tuple[str, ...] | None, limit: int) -> Pulled:
    served = [k for k in SERVED if kinds is None or k.name in kinds]
    if not served:
        return Pulled([])
    # The canonical community's people join on their first read, which records nothing for the
    # engines: the sets they are owed are rebuilt here, once for everyone who joined since the
    # last poll, in a transaction of its own that ends before this pull takes its credential
    # (docs/specs/DEFAULT_COMMUNITY.md). It never raises: a refresh that fails never fails a poll.
    from apps.orgs.community import refresh_community_member_set

    refresh_community_member_set(credential.organisation_id)
    now = timezone.now()
    with transaction.atomic():
        # One pull per credential at a time: two concurrent pulls never issue the set twice.
        EngineAgentCredential.objects.select_for_update().filter(id=credential.id).first()
        for kind in served:
            _ensure_latest(credential, now, kind)
        only = Q()
        if len(served) == 1:
            only = Q(channel_set__isnull=served[0] is MEMBERS)
        due = (
            # The command row only: the set it delivers is read, never locked.
            EngineCommand.objects.select_for_update(skip_locked=True, of=("self",))
            .select_related("member_set", "channel_set")
            .filter(only, credential_id=credential.id)
            .filter(
                Q(state="pending", not_before__lte=now)
                | Q(
                    state__in=("dispatched", "accepted"),
                    dispatched_at__lte=now - timedelta(seconds=VISIBILITY_TIMEOUT_S),
                )
            )
            .order_by("issued_at")[:limit]
        )
        commands = list(due)
        for command in commands:
            if command.state == "pending":
                command.state = "dispatched"
            command.dispatched_at = now
            command.save(update_fields=["state", "dispatched_at"])
    return Pulled([_as_command(command) for command in commands])


def _own(credential: EngineAgentCredential, command_id: UUID) -> EngineCommand:
    command = (
        EngineCommand.objects.select_for_update(of=("self",))
        .select_related("member_set", "channel_set")
        .filter(id=command_id, credential_id=credential.id)
        .first()
    )
    if command is None:
        raise CommandNotFoundError(str(command_id))
    return command


def acknowledge(
    credential: EngineAgentCredential, command_id: UUID, *, boot_id: str | None
) -> dict[str, Any]:
    now = timezone.now()
    with transaction.atomic():
        if boot_id:
            # The credential before its command row, as a pull and a revocation take them: the
            # other order deadlocks with `revoke_credential`. Rolled back with a refused ack.
            EngineAgentCredential.objects.filter(id=credential.id).update(last_boot_id=boot_id)
        command = _own(credential, command_id)
        if command.state in TERMINAL_STATES or command.state == "pending":
            raise CommandConflictError("terminal, or never dispatched")
        if command.state != "accepted":
            command.state = "accepted"
            command.accepted_at = now
            command.save(update_fields=["state", "accepted_at"])
    accepted_at = command.accepted_at or now
    return {
        "command_id": str(command.id),
        "status": "accepted",
        "deadline_at": (accepted_at + timedelta(seconds=DEADLINE_S)).isoformat(),
        "cancelled": False,
    }


def _backoff(attempt: int) -> timedelta:
    return timedelta(seconds=min(60 * 2 ** (attempt - 1), 3600))


def _valid_artefacts(artefacts: Any, kind: _Kind) -> bool:
    if artefacts is None:
        return True
    counts = ARTEFACTS if kind is MEMBERS else CHANNEL_ARTEFACTS
    if not isinstance(artefacts, dict):
        return False
    for key, value in artefacts.items():
        if kind is CHANNELS and key == "failed_channel_ids":
            if (
                not isinstance(value, list)
                or len(value) > 500
                or len(set(map(str, value))) != len(value)
                or not all(isinstance(v, str) and _UUID.fullmatch(v) for v in value)
            ):
                return False
            continue
        if key not in counts or not isinstance(value, int) or isinstance(value, bool):
            return False
        if value < (1 if key == "revision_applied" else 0):
            return False
    return True


def report(
    credential: EngineAgentCredential, command_id: UUID, body: dict[str, Any]
) -> tuple[bool, str]:
    """Record a progress or terminal result. Returns (recorded, the status it leaves)."""
    status = body.get("status")
    if status not in ("running", "succeeded", "failed"):
        raise InvalidResultError("status")
    error_code = body.get("error_code")
    if status == "failed" and error_code not in ERROR_CODES:
        raise InvalidResultError("error_code")
    if status != "failed" and error_code is not None:
        raise InvalidResultError("error_code")
    artefacts = body.get("artefacts")
    if artefacts is not None and not isinstance(artefacts, dict):
        raise InvalidResultError("artefacts")
    if artefacts and isinstance(artefacts.get("failed_channel_ids"), list):
        # UUIDs in either case: compared, stored and reported lower-case, as the set holds them.
        artefacts = {
            **artefacts,
            "failed_channel_ids": [
                v.lower() if isinstance(v, str) else v for v in artefacts["failed_channel_ids"]
            ],
        }
    now = timezone.now()
    with transaction.atomic():
        command = _own(credential, command_id)
        kind = _kind_of(command)
        if not _valid_artefacts(artefacts, kind):
            raise InvalidResultError("artefacts")
        if kind is CHANNELS and artefacts and "failed_channel_ids" in artefacts:
            listed = {c["channel_id"] for c in _channel_set(command).channels}
            # Only with a failure, and only channels of this set: an unknown id would otherwise
            # leave every channel reported ready and every notice posted.
            if status != "failed" or not set(artefacts["failed_channel_ids"]) <= listed:
                raise InvalidResultError("artefacts")
        if command.state == "pending":
            raise CommandConflictError("never dispatched")
        if command.state == "superseded":
            return False, status
        if command.state in ("succeeded", "failed"):
            if command.state != status:
                raise CommandConflictError("another terminal result is recorded")
            return False, command.state  # the same terminal result twice: the first is kept
        if status == "running":
            return True, "running"
        command.state = status
        command.error_code = error_code if status == "failed" else None
        command.artefacts = artefacts
        command.finished_at = now
        command.save(update_fields=["state", "error_code", "artefacts", "finished_at"])
        the_set: EngineMemberSet | EngineChannelSet = (
            _channel_set(command) if kind is CHANNELS else _member_set(command)
        )
        outcome = "applied" if status == "succeeded" else "failed"
        metadata: dict[str, Any] = {
            "revision": the_set.revision,
            "command_id": str(command.id),
            "attempt": command.attempt,
        }
        if status == "failed":
            metadata["error_code"] = error_code
        if status == "succeeded" or kind is CHANNELS:
            metadata.update(artefacts or {})
        if kind is CHANNELS:
            record_engine_channel_set_event(
                action=f"engine_channel_set.{outcome}",
                channel_set_id=the_set.id,
                organisation_id=credential.organisation_id,
                agent_id=credential.id,
                metadata=metadata,
            )
            ready, failed, posted = channel_results(
                _channel_set(command),
                succeeded=status == "succeeded",
                failed_ids=(artefacts or {}).get("failed_channel_ids"),
            )
            channel_hooks.channel_set_reported(
                organisation_id=credential.organisation_id,
                revision=the_set.revision,
                ready=ready,
                failed=failed,
                notices_posted=posted,
            )
        else:
            record_engine_member_set_event(
                action=f"engine_member_set.{outcome}",
                member_set_id=command.member_set_id,
                organisation_id=credential.organisation_id,
                agent_id=credential.id,
                metadata=metadata,
            )
        if status == "failed" and error_code in RETRYABLE:
            # Locked, so that a retry is never issued for a set an emission is superseding; both
            # heads, in the emitters' order, before _issue touches the credential.
            member_head, channel_head = lock_heads(credential.organisation_id)
            head: Any = channel_head if kind is CHANNELS else member_head
            if the_set.revision == head.revision:
                _issue(
                    the_set,
                    credential.id,
                    now,
                    attempt=command.attempt + 1,
                    not_before=now + _backoff(command.attempt),
                )
    return True, status


@dataclass(frozen=True)
class Lag:
    credential_id: UUID
    organisation_id: UUID
    head_revision: int
    applied_revision: int | None
    behind_since: datetime
    kind: str = COMMAND_KIND


def lagging(*, after: timedelta = LAG_ALERT_AFTER) -> list[Lag]:
    """Every active credential that has not applied its organisation's latest set within `after`
    of its issue, whatever happened to the commands meanwhile (retries, failures, superseding).
    What the lag alert reads: `manage.py engine_member_sets_lag`."""
    cutoff = timezone.now() - after
    found = []
    for credential in EngineAgentCredential.objects.filter(state="active").order_by("created_at"):
        for kind in SERVED:
            head = kind.head.objects.filter(organisation_id=credential.organisation_id).first()
            if head is None or head.revision == 0:
                continue
            latest = kind.sets.objects.only("id", "created_at").get(
                organisation_id=credential.organisation_id, revision=head.revision
            )
            applied = EngineCommand.objects.filter(
                credential_id=credential.id, state="succeeded"
            ).aggregate(revision=Max(f"{kind.field}__revision"))["revision"]
            behind_since = max(latest.created_at, credential.created_at)
            if (applied is None or applied < head.revision) and behind_since <= cutoff:
                found.append(
                    Lag(
                        credential.id,
                        credential.organisation_id,
                        head.revision,
                        applied,
                        behind_since,
                        kind.name,
                    )
                )
    return found


@dataclass(frozen=True)
class Anomaly:
    organisation_id: UUID
    revision: int
    problem: str


def anomalies(*, within: timedelta = REFRESH_AFTER) -> list[Anomaly]:
    """What the lag alert reports besides lag: an organisation whose last emission was refused
    (until a set is recorded again), a set of the last `within` that could not name a leaver, and,
    on each organisation's latest set, subjects left out for their shape or a size nearing the
    bound."""
    found = []
    for member_set in EngineMemberSet.objects.filter(
        created_at__gte=timezone.now() - within, unnamed_leavers__gt=0
    ).order_by("created_at"):
        found.append(
            Anomaly(
                member_set.organisation_id,
                member_set.revision,
                f"{member_set.unnamed_leavers} leaver(s) with no realm subject",
            )
        )
    for head in EngineMemberSetHead.objects.exclude(refused_at=None).order_by("organisation_id"):
        found.append(
            Anomaly(
                head.organisation_id, head.revision, f"last set refused: {head.refused_problem}"
            )
        )
    for head in EngineMemberSetHead.objects.filter(revision__gt=0).order_by("organisation_id"):
        latest = EngineMemberSet.objects.get(
            organisation_id=head.organisation_id, revision=head.revision
        )
        size = (
            len(latest.active_subjects)
            + len(latest.inactive_subjects)
            + len(latest.released_subjects)
        )
        if latest.malformed_subjects:
            found.append(
                Anomaly(
                    head.organisation_id,
                    head.revision,
                    f"{latest.malformed_subjects} subject(s) outside the contract's shape left out",
                )
            )
        if size >= WARN_SUBJECTS:
            found.append(
                Anomaly(head.organisation_id, head.revision, f"{size} of {MAX_SUBJECTS} subjects")
            )
    return found
