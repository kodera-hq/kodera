"""initialiseWorkspace: the starter workspace, created once per organisation.

docs/specs/PILOT_WORKSPACE_ONBOARDING.md §§2 and 6. `authorise_initialise` reads the caller against
current state in its own snapshot, before the replay store. `initialise_workspace` is the step the
replay store runs once per key, inside the store's transaction: under the organisation lock it
checks the organisation's state, then its setup, then whether the workspace exists, and only then
writes the §2 rows and their one audit event. Every effect is a row of this database, so a failure
rolls the whole step back and a retry runs it again.
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_authz_denied, record_workspace_initialised
from apps.identity.selectors import current_staff_identity
from apps.jobs.kinds import Lock
from apps.jobs.locks import lock_for_transaction
from apps.legal.services import has_accepted_agreements
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    organisation_slug,
    organisation_state,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken

from . import channel_sets
from .models import Category, Channel, ResourcePolicy, Workspace
from .setup import read_setup
from .structure import (
    INITIALISING_ROLES,
    READING_ROLES,
    WorkspaceCallerUnknownError,
    WorkspaceNotFoundError,
)

# Version 2 adds the audio room `lounge` in `team` (docs/specs/ESPACE_STRUCTURE.md §8).
TEMPLATE_VERSION = 2
# The wait for the organisation lock is bounded at 2 seconds, which is also every connection's
# statement_timeout (config/environment.py), stated here so the bound does not rest on that alone.
# Its expiry raises and the step rolls back, so the client retries with the same key, as after any
# 5xx (PILOT_WORKSPACE_ONBOARDING.md §6 step 3).
LOCK_TIMEOUT = "SET LOCAL lock_timeout = '2s'"
REQUIRED_SCOPE = "workspace:act"
READ_SCOPE = "workspace:read"
DENIAL_REASON = "role_missing"
CATEGORIES = (("general", "General"), ("team", "Team"))
# (category, template key, name, kind), in order within each category.
CHANNELS = (
    ("general", "welcome", "welcome", Channel.Kind.TEXT),
    ("general", "general", "general", Channel.Kind.TEXT),
    ("team", "lounge", "lounge", Channel.Kind.AUDIO),
)


class InitialiseForbiddenError(Exception):
    """A reading role that may not initialise: `403`, recorded as `authz.denied`."""

    def __init__(self, caller: TenantCaller) -> None:
        super().__init__("forbidden")
        self.caller = caller


class InitialiseStateError(Exception):
    """The organisation or its setup is not in a state that allows the step: `409`."""

    def __init__(self, allowed_states: tuple[str, ...]) -> None:
        super().__init__("invalid state transition")
        self.allowed_states = allowed_states


@dataclass(frozen=True, slots=True)
class Initialiser:
    organisation_id: UUID
    issuer: str
    identity_id: UUID


def authorise_initialise(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    roles: frozenset[str] = INITIALISING_ROLES,
) -> Initialiser:
    """Authentication and authorisation against current state, before the replay store: a member
    whose role is not in `roles` is refused, and anyone else answered `404`."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("authorisation requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return _judge(verified=verified, organisation_id=organisation_id, roles=roles)


def reauthorise_initialise(
    *, verified: VerifiedAccessToken, organisation_id: UUID, roles: frozenset[str]
) -> Initialiser:
    """The same judgement again, in the caller's transaction once it holds the organisation lock,
    for a step that writes on the caller's authority (createTenant signs the agreements): a role
    changed since `authorise_initialise` is refused like a first request, and nothing is kept."""
    if not connection.in_atomic_block:
        raise RuntimeError("the caller is re-read in the step's transaction")
    return _judge(verified=verified, organisation_id=organisation_id, roles=roles)


def _judge(
    *, verified: VerifiedAccessToken, organisation_id: UUID, roles: frozenset[str]
) -> Initialiser:
    try:
        caller: TenantCaller = read_tenant_caller(
            verified=verified, organisation_id=organisation_id
        )
    except TenantCallerUnknownError:
        raise WorkspaceCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise WorkspaceNotFoundError() from None
    if caller.role not in READING_ROLES:
        raise WorkspaceNotFoundError()
    if caller.role not in roles:
        raise InitialiseForbiddenError(caller)
    return Initialiser(caller.organisation_id, caller.issuer, caller.identity_id)


def record_tenant_denial(
    *, refused: InitialiseForbiddenError, request_id: str, required_scope: str = REQUIRED_SCOPE
) -> None:
    """`authz.denied` for a tenant role that may not take the step, in a transaction of its own."""
    caller = refused.caller
    _record_denial(
        actor_type="tenant",
        actor_id=caller.identity_id,
        organisation_id=caller.organisation_id,
        request_id=request_id,
        required_scope=required_scope,
    )


def record_staff_denial(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    request_id: str,
    required_scope: str = REQUIRED_SCOPE,
) -> None:
    """`authz.denied` for a staff token, which holds no cell of the Workspace row (AUTHZ.md §5), on
    either operation (§9: a staff read refused is recorded too). The actor is the stored staff
    identity of the token, or `unknown`."""
    staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
    _record_denial(
        actor_type="staff",
        actor_id=None if staff is None else staff.id,
        organisation_id=organisation_id,
        request_id=request_id,
        required_scope=required_scope,
    )


def _record_denial(
    *,
    actor_type: str,
    actor_id: UUID | None,
    organisation_id: UUID,
    request_id: str,
    required_scope: str,
) -> None:
    if connection.in_atomic_block:
        raise RuntimeError("a denial is recorded in a transaction of its own")
    with transaction.atomic():
        slug = organisation_slug(organisation_id=organisation_id)
        record_authz_denied(
            actor_type=actor_type,
            actor_id=actor_id,
            organisation_id=None if slug is None else organisation_id,
            target_urn=f"urn:kodera:organisation:{slug or 'unknown'}",
            request_id=request_id,
            required_scope=required_scope,
            reason=DENIAL_REASON,
        )


def initialise_workspace(*, initialiser: Initialiser, request_id: str) -> bool:
    """Run §6 step 3 in the caller's transaction. True when this call created the workspace,
    False when it already existed; raises InitialiseStateError when a check refuses."""
    if not connection.in_atomic_block:
        raise RuntimeError("the initialise step runs in the replay store's transaction")
    organisation_id = initialiser.organisation_id
    lock_organisation(organisation_id)
    check_organisation_ready(organisation_id=organisation_id, issuer=initialiser.issuer)
    if _find_workspace(organisation_id) is not None:
        return False
    # No workspace before the customer's CGV and DPA are accepted, with an order or, billing off,
    # for its tenant (G1 ruling, QUICK_WORKSPACE.md §3).
    if not has_accepted_agreements(organisation_id=organisation_id):
        raise InitialiseStateError(("ordered",))
    create_starter(
        organisation_id=organisation_id, actor_id=initialiser.identity_id, request_id=request_id
    )
    return True


def lock_organisation(organisation_id: UUID) -> None:
    """The organisation lock, in the caller's transaction, its wait bounded by LOCK_TIMEOUT."""
    with connection.cursor() as cursor:
        cursor.execute(LOCK_TIMEOUT)
    lock_for_transaction(Lock("organisation", organisation_id, "exclusive"))


def check_organisation_ready(*, organisation_id: UUID, issuer: str) -> None:
    """The organisation is `active` and its setup `ready`, or InitialiseStateError naming the state
    that would allow the step (PILOT_WORKSPACE_ONBOARDING.md §6 step 3)."""
    if organisation_state(organisation_id=organisation_id) != "active":
        raise InitialiseStateError(("active",))
    if read_setup(organisation_id=organisation_id, issuer=issuer).state != "ready":
        raise InitialiseStateError(("ready",))


def find_or_create_starter(*, organisation_id: UUID, actor_id: UUID, request_id: str) -> UUID:
    """The organisation's workspace, kept as it is when one exists, else the starter: for
    `createTenant`, whose agreements it has just recorded (QUICK_WORKSPACE.md §4.3 step 5)."""
    found = _find_workspace(organisation_id)
    if found is not None:
        return found
    return create_starter(organisation_id=organisation_id, actor_id=actor_id, request_id=request_id)


def create_starter(*, organisation_id: UUID, actor_id: UUID, request_id: str) -> UUID:
    """The §2 rows, their one audit event and the next channel set, in the caller's transaction,
    under the organisation lock; the caller has found no workspace."""
    workspace = Workspace.objects.create(organisation_id=organisation_id, structure_revision=1)
    default = ResourcePolicy.objects.create(
        workspace=workspace, visibility=ResourcePolicy.Visibility.ORGANISATION, revision=1
    )
    Workspace.objects.filter(pk=workspace.pk).update(default_policy=default)
    categories = _create_categories(workspace)
    _create_channels(workspace, categories)
    record_workspace_initialised(
        organisation_id=organisation_id,
        workspace_id=workspace.id,
        actor_id=actor_id,
        request_id=request_id,
        template_version=TEMPLATE_VERSION,
    )
    channel_sets.emit_for(
        organisation_id=organisation_id, workspace_id=workspace.id, reason="workspace.initialised"
    )
    workspace_id: UUID = workspace.id
    return workspace_id


def _find_workspace(organisation_id: UUID) -> UUID | None:
    found: UUID | None = (
        Workspace.objects.filter(organisation_id=organisation_id)
        .values_list("id", flat=True)
        .first()
    )
    return found


def _create_categories(workspace: Workspace) -> dict[str, Category]:
    return {
        key: Category.objects.create(workspace=workspace, template_key=key, name=name, position=i)
        for i, (key, name) in enumerate(CATEGORIES)
    }


def _create_channels(workspace: Workspace, categories: dict[str, Category]) -> None:
    positions: dict[str, int] = {}
    for category, key, name, kind in CHANNELS:
        position = positions.get(category, 0)
        positions[category] = position + 1
        Channel.objects.create(
            workspace=workspace,
            category=categories[category],
            kind=kind,
            template_key=key,
            name=name,
            topic="",
            position=position,
            policy_mode=Channel.PolicyMode.INHERIT,
            lifecycle=Channel.Lifecycle.ACTIVE,
        )
