"""Audit writers: docs/domain/AUDIT_TAXONOMY.md.

The job queue writes only the `job.*` rows of §3, each in the transaction of the change it records
(docs/specs/JOB_QUEUE.md §6). The staff role commands write the two `staff_role.*` rows, each in the
transaction of the grant or revocation (docs/specs/STAFF_IDENTITY.md §4). The mail sender writes the
four system `outbox_delivery.*` rows, each in the transaction of the delivery change it records
(docs/specs/OUTBOX_MAIL_SENDER.md §8). A delivery's reconciliation decision writes
`outbox_delivery.reconciliation_decided`, a staff row, in the decision's transaction
(docs/specs/JOB_QUEUE.md §7). The staff intake writes `organisation.intake_recorded` in its
transaction, and `authz.denied` for a stored staff identity it refuses, in a transaction of its own
(docs/specs/ORGANISATION_INTAKE.md §1). `getWorkspace` and `initialiseWorkspace` write `authz.denied`
for each `403` they answer, in a transaction of their own, and `initialiseWorkspace` writes
`workspace.initialised`, a tenant row, in the transaction that creates the starter workspace
(docs/specs/PILOT_WORKSPACE_ONBOARDING.md §§6, 9). The structure administration writes its eight
`workspace.*` tenant rows, each in the transaction of the change it records
(docs/specs/ESPACE_STRUCTURE.md §9). The pilot's operator commands write
`realm.created` and `realm.verification_failed` under the acting staff identity
(docs/specs/FIRST_OWNER_BOOTSTRAP.md §5.5).
"""

from collections.abc import Mapping
from uuid import UUID

from .models import AuditEvent

JOB_ACTIONS = frozenset(
    {
        "job.created",
        "job.started",
        "job.step_succeeded",
        "job.step_failed",
        "job.succeeded",
        "job.failed",
        "job.cancelled",
        "job.orphaned",
        "job.reconciliation_required",
        "job.reconciliation_decided",
    }
)


def record_job_event(
    *,
    action: str,
    job_id: UUID,
    organisation_id: UUID,
    actor_type: str,
    actor_id: UUID | None,
    request_id: str | None,
    metadata: Mapping[str, object],
) -> None:
    """One AuditEvent naming the job, written in the caller's transaction."""
    if action not in JOB_ACTIONS:
        raise ValueError(f"{action} is not a job action the queue writes")
    AuditEvent.objects.create(
        action=action,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label="system" if actor_type == "system" else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:job:{job_id}",
        job_id=job_id,
        request_id=request_id,
        retention_class="standard",
        metadata=dict(metadata),
    )


STAFF_ROLE_ACTIONS = frozenset({"staff_role.granted", "staff_role.revoked"})


def record_staff_role_event(
    *,
    action: str,
    actor_id: UUID | None,
    identity_id: UUID,
    metadata: Mapping[str, object],
) -> None:
    """One AuditEvent for a staff role grant or revocation, written in the caller's transaction
    (docs/specs/STAFF_IDENTITY.md §4). A fleet-level event: no organisation. The actor is the
    granting staff identity, or the system when `actor_id` is None (the one-time bootstrap)."""
    if action not in STAFF_ROLE_ACTIONS:
        raise ValueError(f"{action} is not a staff role action")
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if actor_id is None else "staff",
        actor_id=actor_id,
        actor_label="system" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=None,
        target_urn=f"urn:kodera:identity:{identity_id}",
        retention_class="standard",
        metadata=dict(metadata),
    )


OUTBOX_DELIVERY_ACTIONS = frozenset(
    {
        "outbox_delivery.sent",
        "outbox_delivery.deferred",
        "outbox_delivery.failed",
        "outbox_delivery.reconciliation_required",
        # The realm access bulk verification found a user Core turned off enabled in its realm,
        # and enqueued the access_off this row names (MEMBERSHIP_LIFECYCLE.md §6.1.9).
        "outbox_delivery.drift_detected",
    }
)


def record_delivery_event(
    *,
    action: str,
    delivery_id: UUID,
    organisation_id: UUID,
    metadata: Mapping[str, object],
) -> None:
    """One AuditEvent naming an outbox delivery, written by the system in the caller's
    transaction. `metadata` carries identifiers, codes and reasons only (OUTBOX_MAIL_SENDER §5.2)."""
    if action not in OUTBOX_DELIVERY_ACTIONS:
        raise ValueError(f"{action} is not an outbox delivery action")
    AuditEvent.objects.create(
        action=action,
        actor_type="system",
        actor_id=None,
        actor_label="system",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:outbox_delivery:{delivery_id}",
        retention_class="standard",
        metadata=dict(metadata),
    )


DELIVERY_DECISION_ACTION = "outbox_delivery.reconciliation_decided"


def record_delivery_decision_event(
    *,
    delivery_id: UUID,
    organisation_id: UUID,
    actor_id: UUID,
    metadata: Mapping[str, object],
) -> None:
    """The staff decision that takes an outbox delivery out of needs_reconciliation, written in the
    decision's transaction (docs/specs/JOB_QUEUE.md §7). The actor is the deciding staff identity;
    `metadata` carries the exit, the decision reference and the staff role grant the decision relied
    on, never the evidence's content."""
    AuditEvent.objects.create(
        action=DELIVERY_DECISION_ACTION,
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:outbox_delivery:{delivery_id}",
        retention_class="standard",
        metadata=dict(metadata),
    )


def record_intake_recorded(
    *,
    actor_id: UUID,
    organisation_id: UUID,
    slug: str,
    request_id: str,
    instruction_ref: str,
) -> None:
    """`organisation.intake_recorded`, written in the intake's transaction by its staff actor
    (docs/specs/ORGANISATION_INTAKE.md). `metadata` carries the instruction reference as recorded,
    and never the intended owner's contact (AUDIT_TAXONOMY.md §3, changelog)."""
    AuditEvent.objects.create(
        action="organisation.intake_recorded",
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:organisation:{slug}",
        request_id=request_id,
        retention_class="standard",
        metadata={"instruction_ref": instruction_ref},
    )


AUTHZ_DENIED_REASONS = frozenset({"mfa_missing", "role_missing"})
CLAIM_DENIED_REASONS = frozenset({"issued", "consumed", "expired", "revoked"})


def record_staff_denial(
    *,
    actor_id: UUID,
    target_urn: str,
    request_id: str,
    required_scope: str,
    reason: str,
) -> None:
    """`authz.denied` for a stored staff identity refused a staff operation, in a transaction of
    its own: the refused request writes nothing else (FIRST_OWNER_BOOTSTRAP.md §3.7 rule 3). A
    fleet-level row, since the refusal precedes any organisation."""
    if reason not in AUTHZ_DENIED_REASONS:
        raise ValueError(f"{reason} is not a staff denial reason")
    AuditEvent.objects.create(
        action="authz.denied",
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=None,
        target_urn=target_urn,
        request_id=request_id,
        retention_class="standard",
        metadata={"required_scope": required_scope, "reason": reason},
    )


def record_authz_denied(
    *,
    actor_type: str,
    actor_id: UUID | None,
    organisation_id: UUID | None,
    target_urn: str,
    request_id: str,
    required_scope: str,
    reason: str,
) -> None:
    """One `authz.denied` for a `403` (AUTHZ.md §9): the request id, the actor or `unknown`, the
    attempted target, the required scope and the reason. Never a token, a header or a request body.
    Written in the caller's transaction, which must not be the refused one."""
    if reason not in AUTHZ_DENIED_REASONS | CLAIM_DENIED_REASONS:
        raise ValueError(f"{reason} is not a denial reason")
    AuditEvent.objects.create(
        action="authz.denied",
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label="unknown" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=target_urn,
        request_id=request_id,
        retention_class="standard",
        metadata={"required_scope": required_scope, "reason": reason},
    )


def record_consumption_event(
    *, action: str, organisation_id: UUID, target_id: UUID, actor_id: UUID, request_id: str
) -> None:
    """Exactly the three tenant effects, in the effect's transaction, without secret metadata."""
    kinds = {
        "owner_claim.consumed": "owner_claim",
        "membership.created": "membership",
        "organisation.activated": "organisation",
    }
    if action not in kinds:
        raise ValueError("consumption audit action refused")
    AuditEvent.objects.create(
        action=action,
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:{kinds[action]}:{target_id}",
        request_id=request_id,
        retention_class="standard",
        metadata={},
    )


MEMBERSHIP_ACTIONS = frozenset(
    {
        "membership.role_changed",
        "membership.suspended",
        "membership.reactivated",
        "membership.removed",
    }
)


def record_membership_event(
    *,
    action: str,
    organisation_id: UUID,
    membership_id: UUID,
    actor_id: UUID,
    request_id: str,
    before: Mapping[str, object],
    after: Mapping[str, object],
) -> None:
    """One membership change by a tenant administrator, in the change's transaction
    (MEMBERSHIP_LIFECYCLE.md §4). `before` and `after` hold only the changed field."""
    if action not in MEMBERSHIP_ACTIONS:
        raise ValueError(f"{action} is not a membership change")
    AuditEvent.objects.create(
        action=action,
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:membership:{membership_id}",
        request_id=request_id,
        retention_class="standard",
        before=dict(before),
        after=dict(after),
        metadata={},
    )


INVITATION_ACTIONS = frozenset(
    {
        "invitation.sent",
        "invitation.resent",
        "invitation.accepted",
        "invitation.revoked",
        "invitation.expired",
    }
)


def record_invitation_event(
    *,
    action: str,
    organisation_id: UUID,
    invitation_id: UUID,
    actor_id: UUID | None,
    request_id: str | None,
    metadata: Mapping[str, object] | None = None,
) -> None:
    """One `invitation.*` row in the change's transaction (docs/specs/INVITATIONS.md §6): a tenant
    actor for what a person did, `system` for an expiry. Never the address or the token."""
    if action not in INVITATION_ACTIONS:
        raise ValueError(f"{action} is not an invitation event")
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if actor_id is None else "tenant",
        actor_id=actor_id,
        actor_label="system" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:invitation:{invitation_id}",
        request_id=request_id,
        retention_class="standard",
        metadata=dict(metadata or {}),
    )


def record_support_ticket_opened(
    *,
    organisation_id: UUID,
    ticket_id: UUID,
    actor_id: UUID,
    request_id: str,
    category: str,
    severity: str,
) -> None:
    """`support.ticket_opened`, in the ticket's transaction (docs/specs/SUPPORT_TICKETS.md): the
    category and severity only, never the subject, the message or an address."""
    AuditEvent.objects.create(
        action="support.ticket_opened",
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:support_ticket:{ticket_id}",
        request_id=request_id,
        retention_class="standard",
        metadata={"category": category, "severity": severity},
    )


def record_membership_created(
    *, organisation_id: UUID, membership_id: UUID, actor_id: UUID, request_id: str
) -> None:
    """`membership.created` for an accepted invitation, the invitee as the actor, in the
    acceptance's transaction (AUDIT_TAXONOMY.md §3)."""
    AuditEvent.objects.create(
        action="membership.created",
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:membership:{membership_id}",
        request_id=request_id,
        retention_class="standard",
        metadata={"source": "invitation"},
    )


def record_organisation_updated(
    *,
    organisation_id: UUID,
    slug: str,
    actor_id: UUID,
    request_id: str,
    before: Mapping[str, object],
    after: Mapping[str, object],
) -> None:
    """One `organisation.updated` by a tenant owner, in the change's transaction
    (ORGANISATION_NOTICE_CONTACTS.md §3). `before` and `after` hold only the changed fields."""
    if not after or set(before) != set(after):
        raise ValueError("an organisation update names the same changed fields before and after")
    AuditEvent.objects.create(
        action="organisation.updated",
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:organisation:{slug}",
        request_id=request_id,
        retention_class="standard",
        before=dict(before),
        after=dict(after),
        metadata={},
    )


WORKSPACE_INITIALISED = "workspace.initialised"


def record_workspace_initialised(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    actor_id: UUID,
    request_id: str,
    template_version: int,
) -> None:
    """One `workspace.initialised`, written in the transaction that creates the starter workspace
    (PILOT_WORKSPACE_ONBOARDING.md §6). The actor is the initialising tenant identity; `metadata`
    names the workspace and the template version, never a category or channel name."""
    AuditEvent.objects.create(
        action=WORKSPACE_INITIALISED,
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:workspace:{workspace_id}",
        request_id=request_id,
        retention_class="standard",
        metadata={"workspace_id": str(workspace_id), "template_version": template_version},
    )


# The structure administration's eight actions and the URN type each one's target is
# (ESPACE_STRUCTURE.md §9).
STRUCTURE_ACTIONS = {
    "workspace.category_created": "category",
    "workspace.category_updated": "category",
    "workspace.category_deleted": "category",
    "workspace.channel_created": "channel",
    "workspace.channel_updated": "channel",
    "workspace.channel_archived": "channel",
    "workspace.channel_unarchived": "channel",
    "workspace.channel_access_changed": "channel",
}
# What a structure event never carries: the customer's own words, and a person's contact.
STRUCTURE_FORBIDDEN_METADATA = frozenset({"name", "topic", "email", "display_name"})


def record_structure_event(
    *,
    action: str,
    organisation_id: UUID,
    target_id: UUID,
    actor_id: UUID,
    request_id: str,
    metadata: Mapping[str, object],
) -> None:
    """One structure administration change by a tenant owner or admin, in the change's
    transaction (ESPACE_STRUCTURE.md §9). `metadata` carries ids, kinds, positions, changed field
    names and the access tag, never a name, a topic or a member's personal data."""
    target = STRUCTURE_ACTIONS.get(action)
    if target is None:
        raise ValueError(f"{action} is not a structure administration action")
    if STRUCTURE_FORBIDDEN_METADATA & set(metadata):
        raise ValueError("a structure event carries no name, topic or contact")
    AuditEvent.objects.create(
        action=action,
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:{target}:{target_id}",
        request_id=request_id,
        retention_class="standard",
        metadata=dict(metadata),
    )


def record_channel_set_refused(
    *, organisation_id: UUID, workspace_id: UUID, reason: str, problem: str
) -> None:
    """`workspace.channel_set_refused`: a membership change committed, and the channel set it
    should have recorded was refused by its emitter (ESPACE_STRUCTURE.md §13.5). Written by the
    system in the change's transaction; `metadata` carries the change's `reason` and the
    emitter's `problem`, never a subject."""
    AuditEvent.objects.create(
        action="workspace.channel_set_refused",
        actor_type="system",
        actor_id=None,
        actor_label="system",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:workspace:{workspace_id}",
        retention_class="standard",
        metadata={"reason": reason, "problem": problem},
    )


REALM_ACTIONS = frozenset({"realm.created", "realm.verification_failed"})


def record_realm_event(
    *,
    action: str,
    organisation_id: UUID,
    realm: str,
    job_id: UUID,
    actor_id: UUID | None,
    metadata: Mapping[str, object],
) -> None:
    """One `realm.*` row of the `realm_create` job, written in the caller's transaction. The actor
    is the acting staff identity for the invited pilot, which runs the realm step by operator
    command (FIRST_OWNER_BOOTSTRAP.md §5.5, AUDIT_TAXONOMY.md §3), or the system when `actor_id`
    is None. The target is the realm, by name; `metadata` carries codes and references, never an
    address or a token."""
    if action not in REALM_ACTIONS:
        raise ValueError(f"{action} is not a realm action")
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if actor_id is None else "staff",
        actor_id=actor_id,
        actor_label="system" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:realm:{realm}",
        job_id=job_id,
        retention_class="standard",
        metadata=dict(metadata),
    )


OWNER_ACTIONS = frozenset(
    {
        "identity.bound",
        "owner_claim.issued",
        "owner_claim.expired",
        "owner_claim.revoked",
        "owner_claim.confirmed",
    }
)


def record_owner_event(
    *,
    action: str,
    organisation_id: UUID,
    target_id: UUID,
    actor_id: UUID | None,
    request_id: str | None,
    metadata: Mapping[str, object],
) -> None:
    """Closed, secret-free bootstrap registry in the caller's transaction."""
    if action not in OWNER_ACTIONS or (action == "owner_claim.expired") != (actor_id is None):
        raise ValueError("owner event actor/action refused")
    allowed = {
        "binding_id",
        "claim_id",
        "delivery_id",
        "identity_id",
        "evidence_ref",
        "staff_role_grant_ref",
    }
    if set(metadata) - allowed or any(
        not isinstance(value, str)
        or not 1 <= len(value) <= 512
        or any(character.isspace() or character == "@" for character in value)
        for value in metadata.values()
    ):
        raise ValueError("owner event metadata refused")
    kind = "identity" if action == "identity.bound" else "owner_claim"
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if actor_id is None else "staff",
        actor_id=actor_id,
        actor_label="system" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:{kind}:{target_id}",
        request_id=request_id,
        retention_class="standard",
        metadata=dict(metadata),
    )


# AUDIT_TAXONOMY.md §Billing: each billing action and the actor types its row allows.
BILLING_ACTIONS: Mapping[str, frozenset[str]] = {
    **dict.fromkeys(
        ("plan.published", "plan.deprecated", "price.published", "price.deprecated"),
        frozenset({"staff"}),
    ),
    **dict.fromkeys(
        ("subscription.created", "subscription.changed", "subscription.terminated"),
        frozenset({"staff", "tenant"}),
    ),
    # `system` when an order unpaid past its invoice's due date is cancelled (BILLING_MODEL.md §4.1).
    "subscription.cancelled": frozenset({"staff", "tenant", "system"}),
    **dict.fromkeys(
        ("invoice.issued", "invoice.sent", "invoice.paid", "invoice.overdue", "invoice.voided"),
        frozenset({"staff", "system"}),
    ),
    # Issued by Core when an order is cancelled (BILLING_MODEL.md §4.1), or by staff.
    "credit_note.issued": frozenset({"staff", "system"}),
    # The notice delivering a credit note to the customer (apps/billing/confirmations.py).
    "credit_note.notice_enqueued": frozenset({"system"}),
    # The order's other two rows (AUDIT_TAXONOMY.md §§Organisation, Tenant), written by the same
    # transaction: the DPA accepted with the order, and the tenant it orders.
    "dpa.accepted": frozenset({"tenant"}),
    "tenant.ordered": frozenset({"tenant", "staff"}),
    # The tenant of an order cancelled before anything was built (TENANT_STATE_MACHINE.md T21).
    "tenant.deleted": frozenset({"staff", "system"}),
    # The order confirmation enqueued by the operator profile (apps/billing/confirmations.py).
    "order.confirmation_enqueued": frozenset({"system"}),
    # A cancelled order whose confirmation was sent: its formed contract is terminated, with notice.
    "order.terminated": frozenset({"system"}),
    # An order in flight settled with no charge by a staff operator (BILLING_MODEL.md §4.2).
    "order.complimentary": frozenset({"staff"}),
    **dict.fromkeys(
        (
            "payment.received",
            "payment.failed",
            "payment.refunded",
            "payment.reconciled",
            "payment.reconciliation_mismatch",
        ),
        frozenset({"system"}),
    ),
}


def record_billing_event(
    *,
    action: str,
    actor_type: str,
    actor_id: UUID | None,
    organisation_id: UUID | None,
    target_urn: str,
    request_id: str | None,
    metadata: Mapping[str, object],
) -> None:
    """One billing row of AUDIT_TAXONOMY.md, written in the caller's transaction. `metadata`
    carries identifiers, codes and amounts, never a card, an IBAN or a provider secret."""
    allowed = BILLING_ACTIONS.get(action)
    if allowed is None or actor_type not in allowed:
        raise ValueError(f"{action} by {actor_type} is not a billing audit row")
    if (actor_type == "system") != (actor_id is None):
        raise ValueError("a system row names no actor; any other names one")
    AuditEvent.objects.create(
        action=action,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label="system" if actor_id is None else f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=target_urn,
        request_id=request_id,
        retention_class="standard",
        metadata=dict(metadata),
    )


# The pilot's operator override of a tenant's status (`manage.py tenant_status`,
# QUICK_WORKSPACE.md §5): one row per transition, by the staff operator who ran it.
TENANT_STATUS_ACTIONS = frozenset(
    {
        "tenant.provision_requested",
        "tenant.ready",
        "tenant.activated",
        "tenant.failed",
        "tenant.deleted",
    }
)


def record_tenant_status_event(
    *,
    action: str,
    tenant_id: UUID,
    organisation_id: UUID,
    actor_id: UUID,
    metadata: Mapping[str, object],
) -> None:
    """One `tenant.*` status row of AUDIT_TAXONOMY.md §3 by a staff operator, written in the
    caller's transaction. `metadata` carries the transition, the override flag and the reason."""
    if action not in TENANT_STATUS_ACTIONS:
        raise ValueError(f"{action} is not a tenant status action")
    AuditEvent.objects.create(
        action=action,
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:tenant:{tenant_id}",
        request_id=None,
        retention_class="standard",
        metadata=dict(metadata),
    )


ENGINE_CHANNEL_SET_ACTIONS = frozenset(
    {"engine_channel_set.issued", "engine_channel_set.applied", "engine_channel_set.failed"}
)


def record_engine_channel_set_event(
    *,
    action: str,
    channel_set_id: UUID,
    organisation_id: UUID,
    agent_id: UUID | None,
    metadata: Mapping[str, object],
) -> None:
    """One `engine_channel_set.*` row (ADR-0018), written in the caller's transaction: `issued` by
    the system with the set, `applied` or `failed` by the agent credential reporting it. `metadata`
    carries revisions, counts, codes and channel ids, never a name, a topic or a subject."""
    if action not in ENGINE_CHANNEL_SET_ACTIONS:
        raise ValueError(f"{action} is not an engine channel-set action")
    if (action == "engine_channel_set.issued") != (agent_id is None):
        raise ValueError("a channel set is issued by the system and reported by an agent")
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if agent_id is None else "agent",
        actor_id=agent_id,
        actor_label="system" if agent_id is None else f"urn:kodera:agent:{agent_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:channel_set:{channel_set_id}",
        retention_class="standard",
        metadata=dict(metadata),
    )


ENGINE_MEMBER_SET_ACTIONS = frozenset(
    {
        "engine_member_set.issued",
        "engine_member_set.refused",
        "engine_member_set.applied",
        "engine_member_set.failed",
    }
)
_SYSTEM_MEMBER_SET_ACTIONS = frozenset({"engine_member_set.issued", "engine_member_set.refused"})


def record_engine_member_set_event(
    *,
    action: str,
    member_set_id: UUID | None,
    organisation_id: UUID,
    agent_id: UUID | None,
    metadata: Mapping[str, object],
    organisation_slug: str | None = None,
) -> None:
    """One `engine_member_set.*` row (ADR-0016), written in the caller's transaction: `issued` by
    the system with the set, `refused` by the system after a set that failed closed rolled its
    change back (target: the organisation, by slug), `applied` or `failed` by the agent credential reporting
    it. `metadata` carries revisions, counts and codes, never a subject."""
    if action not in ENGINE_MEMBER_SET_ACTIONS:
        raise ValueError(f"{action} is not an engine member-set action")
    if (action in _SYSTEM_MEMBER_SET_ACTIONS) != (agent_id is None):
        raise ValueError("a member set is issued by the system and reported by an agent")
    if (action == "engine_member_set.refused") != (member_set_id is None):
        raise ValueError("only a refused set has no member set")
    if member_set_id is None and not organisation_slug:
        raise ValueError("a refused set names its organisation")
    AuditEvent.objects.create(
        action=action,
        actor_type="system" if agent_id is None else "agent",
        actor_id=agent_id,
        actor_label="system" if agent_id is None else f"urn:kodera:agent:{agent_id}",
        organisation_id=organisation_id,
        target_urn=(
            f"urn:kodera:member_set:{member_set_id}"
            if member_set_id is not None
            else f"urn:kodera:organisation:{organisation_slug}"
        ),
        retention_class="standard",
        metadata=dict(metadata),
    )


AGENT_CREDENTIAL_ACTIONS = frozenset({"agent.enrolled", "agent.revoked"})


def record_agent_credential_event(
    *,
    action: str,
    credential_id: UUID,
    organisation_id: UUID,
    actor_id: UUID,
    tenant_id: UUID | None,
) -> None:
    """One `agent.*` row for a tenant-agent credential issued or revoked by a staff operator's
    command (ADR-0016), written in the caller's transaction. It names the credential, never its
    token."""
    if action not in AGENT_CREDENTIAL_ACTIONS:
        raise ValueError(f"{action} is not an agent credential action")
    AuditEvent.objects.create(
        action=action,
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:agent:{credential_id}",
        retention_class="standard",
        metadata={"tenant_id": None if tenant_id is None else str(tenant_id)},
    )


def record_workspace_resource_event(
    *,
    action: str,
    organisation_id: UUID,
    target_id: UUID,
    actor_id: UUID,
    request_id: str,
) -> None:
    """Append a workspace resource action with identifiers only, in its caller's transaction."""
    import re

    if (
        not isinstance(action, str)
        or len(action) > 100
        or re.fullmatch(r"workspace(?:\.[a-z][a-z0-9_]*){1,3}", action) is None
    ):
        raise ValueError("a workspace resource event needs a bounded workspace action")
    AuditEvent.objects.create(
        action=action,
        actor_type="tenant",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:workspace-resource:{target_id}",
        request_id=request_id,
        retention_class="standard",
        metadata={},
    )
    if action in {
        "workspace.member.kick",
        "workspace.member.ban",
        "workspace.member.unban",
        "workspace.member.mute",
    }:
        from django.apps import apps

        if apps.is_installed("apps.notifications"):
            from apps.notifications.services import record_moderation

            record_moderation(organisation_id=organisation_id, membership_id=target_id)


def record_workspace_quota_configured(
    *, actor_id: UUID, organisation_id: UUID, quota_id: UUID, policy_ref: str
) -> None:
    """The supervised quota change, in the caller's configuration transaction."""
    AuditEvent.objects.create(
        action="workspace.quota.configured",
        actor_type="staff",
        actor_id=actor_id,
        actor_label=f"urn:kodera:identity:{actor_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:workspace-resource:{quota_id}",
        retention_class="standard",
        metadata={"policy_ref": policy_ref},
    )
