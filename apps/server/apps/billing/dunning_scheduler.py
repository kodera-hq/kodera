"""Durable supervised collection proposals, revalidated against current ledger and dispute state.

No tenant status is written here. Notice confirmations are explicit operator attestations, not
claims of SMTP delivery. Suspension/termination additionally require a matching succeeded job
and the actual tenant transition; an absent transition writer therefore stays fail-closed.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from uuid import UUID

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal
from core.db.ids import new_uuid7

from . import events
from .actors import Actor
from .dunning import STEPS, Debt, DeliveredStep, DunningRefusedError, Proposal, propose
from .models import DunningAction, DunningCase, DunningDispute, Invoice, Payment, Subscription
from .states import SUBSCRIPTION_TRANSITIONS, require_transition

EVIDENCE = re.compile(
    r"urn:kodera:evidence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
STATE = {
    "reminder_1": "notice",
    "reminder_2": "notice",
    "formal_notice": "formal_notice",
    "suspension_notice": "suspension_notice",
    "suspended": "suspended",
    "terminated": "terminated",
}
ACTION = {
    "reminder_1": "dunning.reminder_sent",
    "reminder_2": "dunning.reminder_sent",
    "formal_notice": "dunning.formal_notice_sent",
    "suspension_notice": "dunning.suspension_notice_sent",
    "suspended": "dunning.suspended",
    "terminated": "dunning.terminated",
}
SYSTEM = Actor("system", None)


def _operator(principal: StaffPrincipal) -> None:
    if (
        not isinstance(principal, StaffPrincipal)
        or current_staff_grant(
            identity_id=principal.identity_id, role="staff_operator", lock_principal=True
        )
        is None
    ):
        raise DunningRefusedError("dunning_staff_operator_confirmation_required")


def _locked(subscription_id: UUID) -> tuple[Subscription, DunningCase, list[Invoice]]:
    # Match collection/cancellation's invoice-before-subscription lock order.
    invoices = list(
        Invoice.objects.select_for_update()
        .filter(subscription_id=subscription_id)
        .order_by("created_at", "id")
    )
    subscription = Subscription.objects.select_for_update().get(id=subscription_id)
    case, _ = DunningCase.objects.get_or_create(subscription=subscription)
    case = DunningCase.objects.select_for_update().get(id=case.id)
    return subscription, case, invoices


def _proposal(
    subscription: Subscription, case: DunningCase, invoices: list[Invoice], now: datetime
) -> Proposal | None:
    debts = []
    for invoice in invoices:
        if invoice.state not in {"issued", "overdue"} or invoice.due_at is None:
            continue
        owed = max(0, invoice.total_incl_vat_minor - invoice.amount_paid_minor)
        disputes = DunningDispute.objects.filter(
            invoice=invoice,
            closed_at__isnull=True,
            hold_until__gt=now,
            ticket__state__in=("open", "pending_customer", "pending_kodera"),
        )
        disputed = min(owed, disputes.aggregate(total=Sum("amount_minor"))["total"] or 0)
        hold_until = disputes.order_by("-hold_until").values_list("hold_until", flat=True).first()
        processing_row = (
            Payment.objects.filter(invoice=invoice, state="processing")
            .order_by("-last_event_at")
            .first()
        )
        if processing_row is not None and processing_row.last_event_at is None:
            raise DunningRefusedError("dunning_processing_evidence_date_missing")
        processing = None if processing_row is None else processing_row.last_event_at
        debts.append(Debt(invoice.id, invoice.due_at, owed, disputed, hold_until, processing))
    rows = list(DunningAction.objects.filter(case=case, episode=case.episode, state="confirmed"))
    order = {name: index for index, (name, _, _) in enumerate(STEPS)}
    rows.sort(key=lambda row: order[row.step])
    delivered = []
    for row in rows:
        if row.delivered_at is None:
            raise DunningRefusedError("dunning_notice_trail_date_invalid")
        delivered.append(DeliveredStep(row.step, row.delivered_at, row.receipt_at))
    return propose(
        subscription_id=subscription.id, debts=tuple(debts), delivered=tuple(delivered), now=now
    )


def schedule_subscription(subscription_id: UUID) -> DunningAction | None:
    with transaction.atomic():
        subscription, case, invoices = _locked(subscription_id)
        if subscription.state not in {"active", "past_due", "suspended"}:
            return None
        now = timezone.now()
        proposal = _proposal(subscription, case, invoices, now)
        outstanding = any(
            row.state in {"issued", "overdue"} and row.total_incl_vat_minor > row.amount_paid_minor
            for row in invoices
        )
        if not outstanding and case.state != "current":
            # Resume of an actually suspended tenant needs its confirmed transition, not a
            # scheduler write. Keep the episode until that writer has resumed the tenant.
            if subscription.state == "suspended":
                return None
            DunningAction.objects.filter(case=case, episode=case.episode, state="prepared").update(
                state="cancelled", updated_at=now
            )
            case.state, case.episode = "current", new_uuid7()
            case.save(update_fields=["state", "episode", "updated_at"])
            if subscription.state == "past_due":
                subscription.state = "active"
                subscription.save(update_fields=["state", "updated_at"])
            events.record(
                "dunning.cleared",
                actor=SYSTEM,
                organisation_id=subscription.organisation_id,
                target=("organisation", subscription.organisation_id),
                metadata={"subscription_id": str(subscription.id)},
            )
            return None
        overdue = any(
            row.state in {"issued", "overdue"}
            and row.due_at is not None
            and row.due_at < now
            and row.total_incl_vat_minor > row.amount_paid_minor
            for row in invoices
        )
        if not overdue:
            return None
        if subscription.state == "active":
            subscription.state = "past_due"
            subscription.save(update_fields=["state", "updated_at"])
        for invoice in invoices:
            if (
                invoice.state == "issued"
                and invoice.due_at is not None
                and invoice.due_at < now
                and invoice.total_incl_vat_minor > invoice.amount_paid_minor
            ):
                invoice.state = "overdue"
                invoice.save(update_fields=["state", "updated_at"])
                events.record(
                    "invoice.overdue",
                    actor=SYSTEM,
                    organisation_id=subscription.organisation_id,
                    target=("invoice", invoice.id),
                    metadata={"subscription_id": str(subscription.id)},
                )
        if case.state == "current":
            case.state = "past_due"
            case.save(update_fields=["state", "updated_at"])
        if proposal is None or proposal.step == "cleared" or proposal.invoice_id is None:
            return None
        key = hashlib.sha256(f"{case.episode}:{proposal.idempotency_key}".encode()).hexdigest()
        action, created = DunningAction.objects.get_or_create(
            idempotency_key=key,
            defaults={
                "case": case,
                "episode": case.episode,
                "invoice_id": proposal.invoice_id,
                "step": proposal.step,
            },
        )
        if created:
            events.record(
                "dunning.proposal_prepared",
                actor=SYSTEM,
                organisation_id=subscription.organisation_id,
                target=("organisation", subscription.organisation_id),
                metadata={
                    "action_id": str(action.id),
                    "step": action.step,
                    "subscription_id": str(subscription.id),
                },
            )
        return action


def confirm_action(
    *,
    principal: StaffPrincipal,
    action_id: UUID,
    delivered_at: datetime,
    evidence_ref: str,
    receipt_at: datetime | None = None,
    job_id: UUID | None = None,
) -> DunningAction:
    if not EVIDENCE.fullmatch(evidence_ref):
        raise DunningRefusedError("dunning_delivery_evidence_required")
    with transaction.atomic():
        _operator(principal)
        subscription_id = DunningAction.objects.values_list("case__subscription_id", flat=True).get(
            id=action_id
        )
        subscription, case, invoices = _locked(subscription_id)
        action = DunningAction.objects.select_for_update().get(id=action_id)
        if action.state == "confirmed":
            if (
                action.delivered_at,
                action.receipt_at,
                action.evidence_ref,
                action.confirmed_by_id,
                action.job_id,
            ) != (delivered_at, receipt_at, evidence_ref, principal.identity_id, job_id):
                raise DunningRefusedError("dunning_confirmation_reuse")
            return action
        now = timezone.now()
        proposal = _proposal(subscription, case, invoices, now)
        if (
            action.state != "prepared"
            or case.episode != action.episode
            or proposal is None
            or (proposal.step, proposal.invoice_id) != (action.step, action.invoice_id)
        ):
            raise DunningRefusedError("dunning_proposal_stale_or_held")
        if (
            delivered_at.tzinfo is None
            or not action.created_at <= delivered_at <= now
            or (
                receipt_at is not None
                and (receipt_at.tzinfo is None or not delivered_at <= receipt_at <= now)
            )
        ):
            raise DunningRefusedError("dunning_delivery_date_invalid")
        # Evaluate the same legal clock at actual delivery, not the later confirmation.
        at_delivery = _proposal(subscription, case, invoices, delivered_at)
        if at_delivery is None or (at_delivery.step, at_delivery.invoice_id) != (
            action.step,
            action.invoice_id,
        ):
            raise DunningRefusedError("dunning_delivery_before_legal_milestone")
        if action.step == "formal_notice" and receipt_at is None:
            raise DunningRefusedError("dunning_formal_notice_receipt_required")
        if action.step in {"suspended", "terminated"}:
            from apps.jobs.selectors import succeeded_tenant_transition
            from apps.tenancy.selectors import tenant_status_matches

            expected_kind = "suspend" if action.step == "suspended" else "decommission"
            expected_status = "suspended" if action.step == "suspended" else "decommissioning"
            if (
                job_id is None
                or not succeeded_tenant_transition(
                    job_id=job_id,
                    organisation_id=subscription.organisation_id,
                    tenant_id=subscription.tenant_id,
                    kind=expected_kind,
                    not_before=action.created_at,
                    not_after=delivered_at,
                )
                or subscription.tenant_id is None
                or not tenant_status_matches(
                    tenant_id=subscription.tenant_id,
                    organisation_id=subscription.organisation_id,
                    status=expected_status,
                )
            ):
                raise DunningRefusedError("dunning_transition_job_evidence_required")
            target_state = "suspended" if action.step == "suspended" else "cancelled"
            require_transition(
                SUBSCRIPTION_TRANSITIONS,
                machine="subscription",
                current=subscription.state,
                requested=target_state,
            )
            subscription.state = target_state
            if target_state == "cancelled":
                subscription.cancelled_at = now
            subscription.save(update_fields=["state", "cancelled_at", "updated_at"])
        action.state, action.delivered_at, action.receipt_at = "confirmed", delivered_at, receipt_at
        action.evidence_ref, action.confirmed_by_id, action.job_id = (
            evidence_ref,
            principal.identity_id,
            job_id,
        )
        action.save(
            update_fields=[
                "state",
                "delivered_at",
                "receipt_at",
                "evidence_ref",
                "confirmed_by",
                "job_id",
                "updated_at",
            ]
        )
        case.state = STATE[action.step]
        case.save(update_fields=["state", "updated_at"])
        events.record(
            ACTION[action.step],
            actor=Actor("staff", principal.identity_id),
            organisation_id=subscription.organisation_id,
            target=("organisation", subscription.organisation_id),
            metadata={
                "action_id": str(action.id),
                "subscription_id": str(subscription.id),
                "step": action.step,
                "operator_id": str(principal.identity_id),
                "evidence_ref": evidence_ref,
                "evidence_kind": "operator_attestation"
                if job_id is None
                else "confirmed_transition_job",
            },
        )
        return action


@transaction.atomic
def record_dispute(
    *,
    principal: StaffPrincipal,
    invoice_id: UUID,
    ticket_id: UUID,
    amount_minor: int,
    hold_until: datetime,
) -> DunningDispute:
    """Link a verified current billing support case; repeated identical evidence is idempotent."""
    from apps.support.selectors import open_billing_ticket

    _operator(principal)
    invoice = Invoice.objects.select_for_update().get(id=invoice_id)
    now = timezone.now()
    if (
        type(amount_minor) is not int
        or amount_minor <= 0
        or hold_until.tzinfo is None
        or not now < hold_until <= now + timedelta(days=90)
    ):
        raise DunningRefusedError("dunning_dispute_bound")
    if not open_billing_ticket(ticket_id=ticket_id, organisation_id=invoice.organisation_id):
        raise DunningRefusedError("dunning_dispute_ticket_required")
    row = DunningDispute.objects.filter(
        invoice=invoice, ticket_id=ticket_id, closed_at__isnull=True
    ).first()
    if row is not None:
        if (row.amount_minor, row.hold_until) != (amount_minor, hold_until):
            raise DunningRefusedError("dunning_dispute_reuse")
        return row
    reserved = (
        DunningDispute.objects.filter(
            invoice=invoice, closed_at__isnull=True, hold_until__gt=now
        ).aggregate(total=Sum("amount_minor"))["total"]
        or 0
    )
    if reserved + amount_minor > invoice.total_incl_vat_minor - invoice.amount_paid_minor:
        raise DunningRefusedError("dunning_dispute_exceeds_debt")
    row = DunningDispute.objects.create(
        invoice=invoice, ticket_id=ticket_id, amount_minor=amount_minor, hold_until=hold_until
    )
    events.record(
        "dunning.dispute_recorded",
        actor=Actor("staff", principal.identity_id),
        organisation_id=invoice.organisation_id,
        target=("invoice", invoice.id),
        metadata={
            "dispute_id": str(row.id),
            "ticket_id": str(ticket_id),
            "amount_minor": amount_minor,
        },
    )
    return row
