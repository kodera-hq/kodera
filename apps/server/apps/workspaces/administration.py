"""Structure administration and the administrative read: docs/specs/ESPACE_STRUCTURE.md §§2–4, 7, 9.

An organisation's `org_owner` and `org_admin` create, rename, move and delete its categories, and
create, rename, retopic, move, archive and unarchive its channels. `authorise` reads the caller
against current state in a snapshot of its own, before anything is written. Every write then runs
in its caller's transaction, whose first statement, under the request's lock timeout, is
`UPDATE workspaces_workspace SET structure_revision = structure_revision + 1 … RETURNING`
(`_revise`): the workspace row serialises the structural writes of one workspace, so a concurrent
one waits and applies to this one's result, and an expired wait is `WorkspaceBusyError` (§4). The
caller is read again under that lock, and must still administer an `active` organisation.

Positions are dense in each list, archived rows included: a create or a move shifts the siblings
in the same transaction, and the two position constraints are deferred to commit, so a shift may
pass through a duplicate. Every write increments its row's `version` with `F("version") + 1` in
the same `UPDATE`, shifted siblings included, and records one audit event that names no name or
topic. A request that would change nothing rolls back: no event, no revision.

The administrative read runs in its own REPEATABLE READ READ ONLY snapshot and returns every
category and every non-deleted channel, unfiltered by channel policy: the administrative
disclosure of AUTHZ.md §6 rule 8.
"""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db import OperationalError, connection, transaction
from django.db.models import F, Q, QuerySet
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_structure_event
from apps.engine_intents.channel_sets import MAX_CHANNELS, ChannelSetError
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    organisation_slug,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import Category, Channel, Workspace
from .structure import (
    INITIALISING_ROLES,
    READING_ROLES,
    WorkspaceCallerUnknownError,
    WorkspaceNotFoundError,
)

ADMINISTERING_ROLES = INITIALISING_ROLES
CREATE_SCOPE = "workspace:create"
UPDATE_SCOPE = "workspace:update"
DELETE_SCOPE = "workspace:delete"
ACT_SCOPE = "workspace:act"
READ_SCOPE = "workspace:read"
DENIAL_REASON = "role_missing"
# Bounded like initialiseWorkspace's wait; its expiry is `lock_not_available`, answered `503`.
LOCK_TIMEOUT = "SET LOCAL lock_timeout = '2s'"
LOCK_NOT_AVAILABLE = "55P03"
REVISE = (
    "UPDATE workspaces_workspace SET structure_revision = structure_revision + 1 "
    "WHERE organisation_id = %s RETURNING id, default_policy_id"
)
NAME_MAX = 100
TOPIC_MAX = 1024
DELETED = Channel.Lifecycle.DELETED
ACTIVE = Channel.Lifecycle.ACTIVE
ARCHIVED = Channel.Lifecycle.ARCHIVED


class AdministrationForbiddenError(Exception):
    """A reading role, or an organisation that is not `active`: `403`, recorded on a write."""

    def __init__(self, caller: TenantCaller) -> None:
        super().__init__("forbidden")
        self.caller = caller


class StructureRefusal(Exception):  # noqa: N818 - the base of the refusals, not itself raised
    """A refusal answered with a problem document; `kind` is its type, `extensions` its members."""

    kind = "internal-error"

    def extensions(self) -> dict[str, object]:
        return {}


class StructureMalformedError(StructureRefusal):
    """A body that is not a JSON object, or a wrong media type: `400`."""

    kind = "malformed-request"


class StructureInvalidError(StructureRefusal):
    """A body the schema or a rule of the spec refuses: `422`, each error a pointer and a code."""

    kind = "validation-error"

    def __init__(self, errors: list[tuple[str, str]]) -> None:
        super().__init__("invalid")
        self.errors = errors

    def extensions(self) -> dict[str, object]:
        return {"errors": [{"pointer": pointer, "code": code} for pointer, code in self.errors]}


class StructureConflictError(StructureRefusal):
    """The structure does not allow the change: `409 conflict` with its `reason`."""

    kind = "conflict"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason

    def extensions(self) -> dict[str, object]:
        return {"reason": self.reason}


class StructureStateError(StructureRefusal):
    """No workspace yet, or a lifecycle these operations do not write: `409`."""

    kind = "invalid-state-transition"

    def __init__(self, allowed_states: tuple[str, ...]) -> None:
        super().__init__("invalid state transition")
        self.allowed_states = allowed_states

    def extensions(self) -> dict[str, object]:
        return {"allowed_states": list(self.allowed_states)}


class PreconditionRequiredError(StructureRefusal):
    """A `PATCH` without `If-Match`: `428`."""

    kind = "precondition-required"


class PreconditionFailedError(StructureRefusal):
    """`If-Match` is not the current tag: `412`, carrying it."""

    kind = "precondition-failed"

    def __init__(self, current_etag: str) -> None:
        super().__init__("precondition failed")
        self.current_etag = current_etag

    def extensions(self) -> dict[str, object]:
        return {"current_etag": self.current_etag}


class WorkspaceBusyError(Exception):
    """Another structural write held the workspace past the lock timeout: `503`."""


def busy(error: BaseException) -> bool:
    """Whether `error` is the lock timeout's expiry."""
    return (
        isinstance(error, OperationalError)
        and getattr(error.__cause__, "sqlstate", None) == LOCK_NOT_AVAILABLE
    )


def tag(values: dict[str, object]) -> str:
    """A strong tag: SHA-256 of the canonical serialisation of `values` (CONVENTIONS.md §10)."""
    canonical = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return '"' + hashlib.sha256(canonical.encode()).hexdigest() + '"'


@dataclass(frozen=True, slots=True)
class CategoryRow:
    id: UUID
    name: str
    template_key: str | None
    position: int
    version: int
    updated_at: datetime

    @property
    def etag(self) -> str:
        """Over `(id, name, position, version, updated_at)`, §3."""
        return tag(
            {
                "id": str(self.id),
                "name": self.name,
                "position": self.position,
                "version": self.version,
                "updated_at": self.updated_at.isoformat(),
            }
        )


@dataclass(frozen=True, slots=True)
class ChannelRow:
    id: UUID
    category_id: UUID | None
    kind: str
    name: str
    template_key: str | None
    topic: str
    position: int
    lifecycle: str
    room_state: str
    policy_mode: str
    version: int
    updated_at: datetime

    @property
    def etag(self) -> str:
        """Over `(id, category_id, kind, name, topic, position, lifecycle, version, updated_at)`,
        §3; never the access, which has a tag of its own."""
        return tag(
            {
                "id": str(self.id),
                "category_id": None if self.category_id is None else str(self.category_id),
                "kind": self.kind,
                "name": self.name,
                "topic": self.topic,
                "position": self.position,
                "lifecycle": self.lifecycle,
                "version": self.version,
                "updated_at": self.updated_at.isoformat(),
            }
        )


@dataclass(frozen=True, slots=True)
class AdministeredCategory:
    category: CategoryRow
    channels: tuple[ChannelRow, ...]


@dataclass(frozen=True, slots=True)
class Administration:
    organisation_id: UUID
    workspace_id: UUID
    categories: tuple[AdministeredCategory, ...]
    uncategorised_channels: tuple[ChannelRow, ...]


@dataclass(frozen=True, slots=True)
class Write:
    """A structural write under way: the caller as read under the workspace lock, and the
    workspace it holds."""

    caller: TenantCaller
    workspace_id: UUID
    default_policy_id: UUID | None
    request_id: str


_CATEGORY_FIELDS = ("id", "name", "template_key", "position", "version", "updated_at")
_CHANNEL_FIELDS = (
    "id",
    "category_id",
    "kind",
    "name",
    "template_key",
    "topic",
    "position",
    "lifecycle",
    "room_state",
    "policy_mode",
    "version",
    "updated_at",
)


# --- the caller -------------------------------------------------------------------------------


def read_caller(verified: VerifiedAccessToken, organisation_id: UUID) -> TenantCaller:
    try:
        caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
        from .models import WorkspaceMemberRestriction

        if (
            WorkspaceMemberRestriction.objects.filter(
                workspace__organisation_id=organisation_id, membership_id=caller.membership_id
            )
            .filter(Q(banned=True) | Q(kicked=True))
            .exists()
        ):
            raise AdministrationForbiddenError(caller)
        return caller
    except TenantCallerUnknownError:
        raise WorkspaceCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise WorkspaceNotFoundError() from None


def require_administrator(caller: TenantCaller) -> None:
    if caller.role not in READING_ROLES:
        raise WorkspaceNotFoundError()
    if caller.role not in ADMINISTERING_ROLES:
        raise AdministrationForbiddenError(caller)


def authorise(*, verified: VerifiedAccessToken, organisation_id: UUID) -> TenantCaller:
    """An owner or admin of `organisation_id`, read against current state in a snapshot of its
    own, before any write or the replay store."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("authorisation requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        caller = read_caller(verified, organisation_id)
    require_administrator(caller)
    return caller


def record_tenant_denial(
    *, refused: AdministrationForbiddenError, scope: str, request_id: str
) -> None:
    """`authz.denied` for a refused tenant write, in a transaction of its own (AUTHZ.md §9)."""
    if connection.in_atomic_block:
        raise RuntimeError("a denial is recorded in a transaction of its own")
    caller = refused.caller
    with transaction.atomic():
        slug = organisation_slug(organisation_id=caller.organisation_id)
        record_authz_denied(
            actor_type="tenant",
            actor_id=caller.identity_id,
            organisation_id=None if slug is None else caller.organisation_id,
            target_urn=f"urn:kodera:organisation:{slug or 'unknown'}",
            request_id=request_id,
            required_scope=scope,
            reason=DENIAL_REASON,
        )


# --- bodies -----------------------------------------------------------------------------------


def parse(body: bytes) -> dict[str, Any]:
    """A JSON object, or `400`."""
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise StructureMalformedError() from None
    if not isinstance(value, dict):
        raise StructureMalformedError()
    return value


class Fields:
    """One body's members, checked against its schema; every error is collected, then `422`. A
    missing or unexpected member is reported once, by the constructor; an accessor of a missing
    member returns a neutral value and reports nothing more."""

    def __init__(
        self, value: dict[str, Any], *, required: tuple[str, ...], optional: tuple[str, ...]
    ) -> None:
        self.value = value
        self.errors: list[tuple[str, str]] = []
        self.errors += [
            (f"/{key}", "unexpected") for key in value if key not in required + optional
        ]
        self.errors += [(f"/{key}", "required") for key in required if key not in value]
        if not required and not value:
            self.errors.append(("", "required"))

    def __contains__(self, key: str) -> bool:
        return key in self.value

    def _fail(self, key: str, code: str) -> None:
        self.errors.append((f"/{key}", code))

    def name(self, key: str = "name") -> str:
        value = self.value.get(key)
        if key not in self.value:
            return ""
        if not isinstance(value, str):
            self._fail(key, "type")
            return ""
        if not 1 <= len(value) <= NAME_MAX:
            self._fail(key, "length")
        elif not value.strip(" \t\n\r"):
            # The database's blank rule (name_constraint): only SP, HT, LF and CR are blank.
            self._fail(key, "blank")
        return value

    def topic(self, key: str = "topic") -> str:
        value = self.value.get(key, "")
        if not isinstance(value, str):
            self._fail(key, "type")
            return ""
        if len(value) > TOPIC_MAX:
            self._fail(key, "length")
        return value

    def position(self, key: str = "position") -> int | None:
        value = self.value.get(key)
        if key not in self.value:
            return None
        if type(value) is not int:
            self._fail(key, "type")
            return None
        if value < 0:
            self._fail(key, "out_of_range")
            return None
        return value

    def uuid(self, key: str, *, nullable: bool) -> UUID | None:
        value = self.value.get(key)
        if key not in self.value or value is None and nullable:
            return None
        try:
            if not isinstance(value, str):
                raise ValueError(value)
            return UUID(value)
        except ValueError:
            self._fail(key, "type")
            return None

    def choice(self, key: str, choices: tuple[str, ...]) -> str:
        value = self.value.get(key)
        if key not in self.value:
            return choices[0]
        if value not in choices:
            self._fail(key, "enum")
            return choices[0]
        return str(value)

    def boolean(self, key: str) -> bool:
        value = self.value.get(key)
        if key not in self.value:
            return False
        if type(value) is not bool:
            self._fail(key, "type")
            return False
        return value

    def members(self, key: str) -> tuple[UUID, ...]:
        value = self.value.get(key)
        if key not in self.value:
            return ()
        if not isinstance(value, list) or len(value) > 1000:
            self._fail(key, "type")
            return ()
        found: list[UUID] = []
        for item in value:
            try:
                if not isinstance(item, str):
                    raise ValueError(item)
                found.append(UUID(item))
            except ValueError:
                self._fail(key, "type")
                return ()
        if len(set(found)) != len(found):
            self._fail(key, "duplicate")
        return tuple(found)

    def done(self) -> None:
        if self.errors:
            raise StructureInvalidError(self.errors)


# --- reads ------------------------------------------------------------------------------------


def _category_row(workspace_id: UUID, category_id: UUID) -> CategoryRow | None:
    row = (
        Category.objects.filter(id=category_id, workspace_id=workspace_id)
        .values_list(*_CATEGORY_FIELDS)
        .first()
    )
    return None if row is None else CategoryRow(*row)


def channel_row(workspace_id: UUID, channel_id: UUID) -> ChannelRow | None:
    """A channel of the workspace that is not deleted, or None."""
    row = (
        Channel.objects.filter(id=channel_id, workspace_id=workspace_id)
        .exclude(lifecycle=DELETED)
        .values_list(*_CHANNEL_FIELDS)
        .first()
    )
    return None if row is None else ChannelRow(*row)


def read_administration(*, verified: VerifiedAccessToken, organisation_id: UUID) -> Administration:
    """§7: every category and every non-deleted channel, in order, for an owner or admin."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("the administrative read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        require_administrator(read_caller(verified, organisation_id))
        workspace_id = (
            Workspace.objects.filter(organisation_id=organisation_id)
            .values_list("id", flat=True)
            .first()
        )
        if workspace_id is None:
            raise WorkspaceNotFoundError()
        channels: dict[UUID | None, list[ChannelRow]] = {}
        for row in (
            Channel.objects.filter(workspace_id=workspace_id)
            .exclude(lifecycle=DELETED)
            .order_by("position", "id")
            .values_list(*_CHANNEL_FIELDS)
        ):
            channel = ChannelRow(*row)
            channels.setdefault(channel.category_id, []).append(channel)
        categories = tuple(
            AdministeredCategory(category, tuple(channels.get(category.id, [])))
            for category in (
                CategoryRow(*row)
                for row in Category.objects.filter(workspace_id=workspace_id)
                .order_by("position", "id")
                .values_list(*_CATEGORY_FIELDS)
            )
        )
        return Administration(
            organisation_id, workspace_id, categories, tuple(channels.get(None, []))
        )


# --- the serialised write ---------------------------------------------------------------------


def _revise(organisation_id: UUID) -> tuple[UUID, UUID | None] | None:
    """The write's first statement: the workspace's next structure revision, under its row lock."""
    with connection.cursor() as cursor:
        cursor.execute(REVISE, [organisation_id])
        row = cursor.fetchone()
    return None if row is None else (row[0], row[1])


def begin(
    *, verified: VerifiedAccessToken, organisation_id: UUID, request_id: str, creating: bool = False
) -> Write:
    """Take the workspace, then read the caller again under its lock, in the caller's
    transaction. A lock wait past the timeout raises `WorkspaceBusyError`. Before the workspace
    exists, a create is `409` (it needs `initialised`) and an operation naming a row is `404`,
    since no row exists (§11)."""
    if not connection.in_atomic_block:
        raise RuntimeError("a structural write runs in its caller's transaction")
    try:
        with connection.cursor() as cursor:
            cursor.execute(LOCK_TIMEOUT)
        revised = _revise(organisation_id)
    except OperationalError as error:
        if busy(error):
            raise WorkspaceBusyError() from error
        raise
    caller = read_caller(verified, organisation_id)
    require_administrator(caller)
    if caller.organisation_state != "active":
        raise AdministrationForbiddenError(caller)
    if revised is None:
        if creating:
            raise StructureStateError(("initialised",))
        raise WorkspaceNotFoundError()
    return Write(caller, revised[0], revised[1], request_id)


def unchanged() -> None:
    """Allowed, but nothing to change: undo the revision, so nothing advances or is recorded."""
    transaction.set_rollback(True)


def precondition(if_match: str | None, current: str, *, required: bool) -> None:
    if if_match is None:
        if required:
            raise PreconditionRequiredError()
        return
    if if_match != current:
        raise PreconditionFailedError(current)


def _shift(rows: "QuerySet[Any]", by: int) -> None:
    """Move `rows` by one place, each a write of its own: version and `updated_at` too."""
    rows.update(position=F("position") + by, version=F("version") + 1, updated_at=timezone.now())


def _move_within(rows: "QuerySet[Any]", old: int, new: int) -> None:
    """Shift the siblings between `old` and `new`, the moving row excluded."""
    if new < old:
        _shift(rows.filter(position__gte=new, position__lt=old), 1)
    elif new > old:
        _shift(rows.filter(position__gt=old, position__lte=new), -1)


def _categories(workspace_id: UUID) -> "QuerySet[Category]":
    return Category.objects.filter(workspace_id=workspace_id)


def _channels(workspace_id: UUID, category_id: UUID | None) -> "QuerySet[Channel]":
    """One list of channels: a category's, or the uncategorised one; deleted rows hold no place."""
    rows = Channel.objects.filter(workspace_id=workspace_id).exclude(lifecycle=DELETED)
    if category_id is None:
        return rows.filter(category__isnull=True)
    return rows.filter(category_id=category_id)


def _insertion(fields: Fields, wanted: int | None, size: int) -> int:
    """Where a row enters a list of `size`: `wanted`, or the end; beyond the end is `422`."""
    if wanted is None:
        return size
    if wanted > size:
        fields.errors.append(("/position", "out_of_range"))
    return wanted


def emit(write: Write, reason: str) -> None:
    """The next channel set, last in the write's transaction, after every domain row it locks
    (ESPACE_STRUCTURE.md §13.2)."""
    # Imported here: the channel set's input reads this module and the access module.
    from . import channel_sets

    try:
        channel_sets.emit(write, reason)
    except ChannelSetError:
        # The set the change would leave is past the contract's bounds: the change is refused,
        # rolled back with everything it wrote (§13.5).
        raise StructureConflictError("channel_set_too_large") from None


def record(write: Write, action: str, target_id: UUID, metadata: dict[str, object]) -> None:
    record_structure_event(
        action=action,
        organisation_id=write.caller.organisation_id,
        target_id=target_id,
        actor_id=write.caller.identity_id,
        request_id=write.request_id,
        metadata={"workspace_id": str(write.workspace_id), **metadata},
    )


def _id(value: UUID | None) -> str | None:
    return None if value is None else str(value)


# --- categories -------------------------------------------------------------------------------


def create_category(*, write: Write, body: dict[str, Any]) -> CategoryRow:
    fields = Fields(body, required=("name",), optional=("position",))
    name = fields.name()
    wanted = fields.position()
    fields.done()
    siblings = _categories(write.workspace_id)
    position = _insertion(fields, wanted, siblings.count())
    fields.done()
    _shift(siblings.filter(position__gte=position), 1)
    category = Category.objects.create(
        workspace_id=write.workspace_id, name=name, template_key=None, position=position
    )
    record(
        write,
        "workspace.category_created",
        category.id,
        {"category_id": str(category.id), "position": position},
    )
    return found(_category_row(write.workspace_id, category.id))


def patch_category(
    *, write: Write, category_id: UUID, body: dict[str, Any], if_match: str | None
) -> CategoryRow:
    fields = Fields(body, required=(), optional=("name", "position"))
    name = fields.name() if "name" in fields else None
    wanted = fields.position()
    fields.done()
    row = found(_category_row(write.workspace_id, category_id))
    precondition(if_match, row.etag, required=True)
    changes: dict[str, object] = {}
    if name is not None and name != row.name:
        # A person's name replaces the catalogue's label (PILOT_WORKSPACE_ONBOARDING.md §2).
        changes.update(name=name, template_key=None)
    if wanted is not None and wanted != row.position:
        siblings = _categories(write.workspace_id)
        if wanted >= siblings.count():
            raise StructureInvalidError([("/position", "out_of_range")])
        _move_within(siblings, row.position, wanted)
        changes["position"] = wanted
    if not changes:
        unchanged()
        return row
    _categories(write.workspace_id).filter(id=row.id).update(
        **changes, version=F("version") + 1, updated_at=timezone.now()
    )
    record(
        write,
        "workspace.category_updated",
        row.id,
        {
            "category_id": str(row.id),
            "changed": sorted(key for key in changes if key != "template_key"),
            "position": changes.get("position", row.position),
        },
    )
    return found(_category_row(write.workspace_id, row.id))


def delete_category(*, write: Write, category_id: UUID, if_match: str | None) -> None:
    row = found(_category_row(write.workspace_id, category_id))
    precondition(if_match, row.etag, required=False)
    # Any channel row, archived or deleted included, keeps it: the database's RESTRICT says so too.
    if Channel.objects.filter(category_id=row.id).exists():
        raise StructureConflictError("category_not_empty")
    _categories(write.workspace_id).filter(id=row.id).delete()
    _shift(_categories(write.workspace_id).filter(position__gt=row.position), -1)
    record(
        write,
        "workspace.category_deleted",
        row.id,
        {"category_id": str(row.id), "position": row.position},
    )


# --- channels ---------------------------------------------------------------------------------


def _category_of(fields: Fields, write: Write, category_id: UUID | None) -> None:
    if (
        category_id is not None
        and not _categories(write.workspace_id).filter(id=category_id).exists()
    ):
        fields.errors.append(("/category_id", "not_found"))


def create_channel(*, write: Write, body: dict[str, Any]) -> ChannelRow:
    fields = Fields(body, required=("category_id", "kind", "name"), optional=("topic", "position"))
    category_id = fields.uuid("category_id", nullable=True)
    kind = fields.choice("kind", tuple(Channel.Kind.values))
    name = fields.name()
    topic = fields.topic()
    wanted = fields.position()
    fields.done()
    _category_of(fields, write, category_id)
    fields.done()
    # Refused before the channel set's emitter, which would refuse a 501st channel (§13.2).
    if (
        Channel.objects.filter(workspace_id=write.workspace_id).exclude(lifecycle=DELETED).count()
        >= MAX_CHANNELS
    ):
        raise StructureConflictError("channel_limit")
    siblings = _channels(write.workspace_id, category_id)
    position = _insertion(fields, wanted, siblings.count())
    fields.done()
    _shift(siblings.filter(position__gte=position), 1)
    # Active as soon as Core commits it, under its category's access (§5).
    channel = Channel.objects.create(
        workspace_id=write.workspace_id,
        category_id=category_id,
        kind=kind,
        name=name,
        template_key=None,
        topic=topic,
        position=position,
        policy_mode=Channel.PolicyMode.INHERIT,
        lifecycle=Channel.Lifecycle.ACTIVE,
    )
    record(
        write,
        "workspace.channel_created",
        channel.id,
        {
            "channel_id": str(channel.id),
            "kind": kind,
            "category_id": _id(category_id),
            "position": position,
        },
    )
    emit(write, "channel.created")
    return found(channel_row(write.workspace_id, channel.id))


def patch_channel(
    *, write: Write, channel_id: UUID, body: dict[str, Any], if_match: str | None
) -> ChannelRow:
    fields = Fields(body, required=(), optional=("name", "topic", "category_id", "position"))
    name = fields.name() if "name" in fields else None
    topic = fields.topic() if "topic" in fields else None
    moving = "category_id" in fields
    target = fields.uuid("category_id", nullable=True) if moving else None
    wanted = fields.position()
    fields.done()
    row = found(channel_row(write.workspace_id, channel_id))
    precondition(if_match, row.etag, required=True)
    changes: dict[str, object] = {}
    if name is not None and name != row.name:
        changes.update(name=name, template_key=None)
    if topic is not None and topic != row.topic:
        changes["topic"] = topic
    if moving and target != row.category_id:
        _category_of(fields, write, target)
        fields.done()
        destination = _channels(write.workspace_id, target)
        position = _insertion(fields, wanted, destination.count())
        fields.done()
        _shift(_channels(write.workspace_id, row.category_id).filter(position__gt=row.position), -1)
        _shift(destination.filter(position__gte=position), 1)
        changes.update(category_id=target, position=position)
    elif wanted is not None and wanted != row.position:
        siblings = _channels(write.workspace_id, row.category_id)
        if wanted >= siblings.count():
            raise StructureInvalidError([("/position", "out_of_range")])
        _move_within(siblings, row.position, wanted)
        changes["position"] = wanted
    if not changes:
        unchanged()
        return row
    # Imported here: the channel set's module reads this one.
    from .channel_sets import access_etag

    access_before = access_etag(row.id) if "category_id" in changes else None
    Channel.objects.filter(id=row.id).update(
        **changes, version=F("version") + 1, updated_at=timezone.now()
    )
    record(
        write,
        "workspace.channel_updated",
        row.id,
        {
            "channel_id": str(row.id),
            "kind": row.kind,
            "changed": sorted(key for key in changes if key != "template_key"),
            "category_id": _id(target if "category_id" in changes else row.category_id),
            "position": changes.get("position", row.position),
        },
    )
    # The set carries a name, a topic and the access, never a position (§13.2): a rename, a new
    # topic, or a move that changes the inherited access emits; any other move does not.
    if {"name", "topic"} & set(changes) or (
        access_before is not None and access_etag(row.id) != access_before
    ):
        emit(write, "channel.updated")
    return found(channel_row(write.workspace_id, row.id))


def set_lifecycle(*, write: Write, channel_id: UUID, lifecycle: str) -> ChannelRow:
    """archiveChannel and unarchiveChannel: idempotent, in place."""
    row = found(channel_row(write.workspace_id, channel_id))
    if row.lifecycle == lifecycle:
        unchanged()
        return row
    if row.lifecycle not in (Channel.Lifecycle.ACTIVE, Channel.Lifecycle.ARCHIVED):
        raise StructureStateError((Channel.Lifecycle.ACTIVE, Channel.Lifecycle.ARCHIVED))
    Channel.objects.filter(id=row.id).update(
        lifecycle=lifecycle, version=F("version") + 1, updated_at=timezone.now()
    )
    action = (
        "workspace.channel_archived"
        if lifecycle == Channel.Lifecycle.ARCHIVED
        else "workspace.channel_unarchived"
    )
    record(write, action, row.id, {"channel_id": str(row.id), "kind": row.kind})
    emit(
        write,
        "channel.archived" if lifecycle == Channel.Lifecycle.ARCHIVED else "channel.unarchived",
    )
    return found(channel_row(write.workspace_id, row.id))


def found[Row](row: Row | None) -> Row:
    if row is None:
        raise WorkspaceNotFoundError()
    return row
