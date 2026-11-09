"""Excluded operator decision on one held owner-claim mail; never a resend."""

from uuid import UUID

from django.db import connection, transaction

from apps.identity.staff import StaffPrincipal
from apps.jobs.services import (
    DecisionRefused,
    Evidence,
    ReconciliationDecision,
    record_delivery_reconciliation_decision,
)
from apps.outbox.selectors import held_owner_claim_operation

from .owner_claims import ClaimRefusedError, _reference, authorized_operator
from .realm_bootstrap import observed_at

CLAIM_DELIVERY_PAIRS = frozenset({("resume", "completed"), ("fail", "no_effect")})


def decide_claim_delivery(*, principal: StaffPrincipal, decision: ReconciliationDecision) -> UUID:
    if (
        type(decision) is not ReconciliationDecision
        or (decision.exit, decision.operation_outcome) not in CLAIM_DELIVERY_PAIRS
    ):
        raise ClaimRefusedError("delivery_pair_refused")
    if connection.in_atomic_block:
        raise RuntimeError("delivery control requires its own transaction")
    with authorized_operator(principal), transaction.atomic():
        operation_ref = held_owner_claim_operation(decision.subject_id)
        if operation_ref is None:
            raise ClaimRefusedError("not_claim_delivery")
        if (
            type(decision.target_read) is not Evidence
            or decision.target_read.resource_id != operation_ref
        ):
            raise ClaimRefusedError("message_id_mismatch")
        result = record_delivery_reconciliation_decision(principal=principal, decision=decision)
        if isinstance(result, DecisionRefused):
            raise ClaimRefusedError(result.reason)
        return result.decision_id


def delivery_evidence_from(options, prefix: str) -> Evidence:
    values = {
        part: options.get(prefix + "_" + part)
        for part in ("provider", "resource_id", "request_id", "observed_at")
    }
    if any(not isinstance(value, str) or not value for value in values.values()):
        raise ClaimRefusedError("evidence_missing")
    _reference(values["provider"])
    _reference(values["request_id"])
    resource = values["resource_id"]
    # Message-ID contains '@'; unlike a general reference, it is validated against the held row.
    if len(resource) > 512 or any(
        character.isspace() or ord(character) < 32 for character in resource
    ):
        raise ClaimRefusedError("evidence_refused")
    return Evidence(
        provider=values["provider"],
        resource_id=resource,
        request_id=values["request_id"],
        observed_at=observed_at(values["observed_at"], "evidence"),
    )
