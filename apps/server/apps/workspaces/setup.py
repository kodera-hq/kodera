"""The organisation's setup state: docs/specs/PILOT_WORKSPACE_ONBOARDING.md §3.

Derived on every read and never stored. `derive_setup` is the §3 table, evaluated top to bottom;
the first row whose condition holds wins, so each row names only what tells it apart from the rows
above it. `read_setup` gathers its three facts in the caller's transaction.
"""

from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from django.conf import settings
from django.db import connection

from apps.audit.selectors import owner_confirmation_recorded
from apps.jobs.selectors import latest_job_status
from services.identity.trusted_issuers import is_trusted_issuer

REALM_JOB = "realm_create"
# The queue's statuses (JOB_QUEUE.md §3.3), not the contract's JobStatus, which lacks
# needs_reconciliation.
STOPPED = frozenset({"failed", "cancelled"})
IN_PROGRESS = frozenset({"leased", "running", "orphaned", "needs_reconciliation"})


@dataclass(frozen=True, slots=True)
class Setup:
    state: str
    reason: str | None


@dataclass(frozen=True, slots=True)
class _Facts:
    latest_status: str | None
    issuer_trusted: bool
    owner_confirmed: bool


_Row = tuple[Callable[[_Facts], bool], Setup]

# §3, rows 1–7, in order.
ROWS: tuple[_Row, ...] = (
    (lambda f: f.latest_status is None, Setup("failed", "realm_job_failed")),
    (lambda f: f.latest_status in STOPPED, Setup("failed", "realm_job_failed")),
    (lambda f: f.latest_status == "queued", Setup("pending", None)),
    (lambda f: f.latest_status in IN_PROGRESS, Setup("running", None)),
    (lambda f: not f.issuer_trusted, Setup("failed", "issuer_untrusted")),
    (lambda f: not f.owner_confirmed, Setup("pending", "awaiting_owner_confirmation")),
    (lambda f: f.latest_status == "succeeded", Setup("ready", None)),
)


def derive_setup(
    *, latest_status: str | None, issuer_trusted: bool, owner_confirmed: bool
) -> Setup:
    facts = _Facts(latest_status, issuer_trusted, owner_confirmed)
    for condition, setup in ROWS:
        if condition(facts):
            return setup
    raise ValueError("no setup row matches the realm job's status")


def read_setup(*, organisation_id: UUID, issuer: str) -> Setup:
    """§3's derivation over the organisation's latest `realm_create` job, the trust list and the
    owner's confirmation, read in the caller's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("the setup state is read in the caller's transaction")
    return derive_setup(
        latest_status=latest_job_status(organisation_id=organisation_id, kind=REALM_JOB),
        issuer_trusted=is_trusted_issuer(issuer, trusted=settings.KODERA_AUTH_TRUST),
        owner_confirmed=owner_confirmation_recorded(organisation_id=organisation_id),
    )
