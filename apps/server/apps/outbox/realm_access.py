"""The realm access delivery's run: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.

`run_realm_deliveries` reconciles Core's suspended and removed memberships into deliveries, sweeps
abandoned attempts, then claims one delivery at a time under the organisation lock taken shared,
opening and committing its attempt before Keycloak is called, calls Keycloak outside any
transaction with the realm's own worker credential, and records the outcome. A delivery ends only on
a read-back that shows the target state; every write it makes is idempotent, so a repeat converges.

The API role can insert a delivery row, so the run trusts none of it but its operation: at the
claim it re-derives the realm and the realm user from Core's own membership, identity and
organisation rows, ends a row that does not agree with them, and withdraws one that would move the
realm away from the membership's current state. Where it sends the credential and the token is
pinned by the worker's settings (apps/outbox/realm/keycloak.py), never read from a row.

Logs and audit rows carry identifiers, the operation, the HTTP status and a reason only: never a
token, a secret, a user representation or an address. Not in the API image.
"""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_delivery_event
from core.db.ids import new_uuid7

from .realm.keycloak import (
    TIMEOUT_S,
    RealmAdmin,
    RealmCallError,
    RealmOrigins as RealmOrigins,
    RealmTarget,
    RealmUserAbsentError,
    realm_issuer,
)
from .realm_enqueue import ACCESS_OFF, ACCESS_ON, insert_realm_access

logger = logging.getLogger("apps.outbox.realm_access")

# Retry class A of docs/domain/JOB_CATALOGUE.md, as the mail sender's: five attempts, exponential
# from 30 s, cap 10 min, full jitter. `temporary` and `abandoned` attempts count.
MAX_DEFERRALS = 5
BACKOFF_BASE_S = 30.0
BACKOFF_CAP_S = 600.0
# Only reads and failures before anything was sent are retried (a write's unknown outcome is held,
# §6.1.2). The retry still waits longer than the client's request timeout, so even a read never
# overlaps the request it replaces.
BACKOFF_FLOOR_S = TIMEOUT_S + 5.0
STALE_AFTER = timedelta(minutes=15)
# The latest delivery of an identity that failed, or has been pending or in flight longer than this,
# is outstanding while Core still asks for it: an `access_off` of a membership that is off (the
# person keeps realm access Core took away), an `access_on` of an active membership of a usable
# identity (a reactivated member left disabled). So is every delivery whose outcome is unknown.
OUTSTANDING_AFTER = timedelta(minutes=5)
DEFAULT_LIMIT = 50
# An operator decides a delivery whose write outcome is unknown only once Keycloak can no longer be
# executing that write: longer than Keycloak's own server-side transaction timeout, 300 s by default
# in 26.0.7 (`quarkus.transaction-manager.default-transaction-timeout=300`,
# quarkus/runtime/src/main/resources/application.properties at tag 26.0.7), plus a margin. A
# deployment that raises Keycloak's timeout must raise this with it (§6.1.4).
RECONCILE_QUIET_PERIOD = timedelta(seconds=330)
# A run's three phases each have a window of their own, laid out from the run's start so that none
# can starve another (§6.1.9): new deliveries, then verification, then up to CORRECTION_BUDGET drift
# corrections. A phase starts no new work past its window's end, and a delivery starts no further
# call past it; only a call already started can run on, for at most its own deadline, so each
# window after the first begins CALL_OVERRUN_S after the previous one ends. The corrections always
# keep CORRECTION_PHASE_S, whatever the earlier phases overran.
DELIVERY_PHASE_S = 15.0
VERIFY_PHASE_S = 15.0
CORRECTION_PHASE_S = 10.0
CALL_OVERRUN_S = TIMEOUT_S
# The whole pass's deadline: the end of the correction window. A pass ends within it plus one
# call's own deadline.
RUN_DEADLINE_S = DELIVERY_PHASE_S + VERIFY_PHASE_S + CORRECTION_PHASE_S + 2 * CALL_OVERRUN_S
# One pass at a time, across every worker: a second run that finds this lock held does nothing.
RUN_LOCK = "run_realm_deliveries"
# The longest a pass can run: RUN_DEADLINE_S plus one call's own deadline (§6.1.9). A lock held for
# longer than twice that is a stuck pass, and every later run reports it instead of staying quiet.
RUN_BOUND_S = RUN_DEADLINE_S + TIMEOUT_S
STUCK_RUN_AFTER_S = 2 * RUN_BOUND_S
CORRECTION_BUDGET = 50
# A realm that needs verification and was not fully verified for this many passes in a row, or for
# this long, is an operator's: whether the listing failed, a job held the lock, or time ran out.
VERIFY_ALERT_PASSES = 5
VERIFY_ALERT_AFTER = timedelta(minutes=10)
RECONCILE_LOCK = "realm_access_reconcile"

# Called as factory(target, deadline=...): the deadline (time.monotonic()) bounds the token request.
AdminFactory = Callable[..., AbstractContextManager[RealmAdmin]]


@dataclass(frozen=True)
class OrganisationLock:
    """The organisation lock a realm-changing delivery takes shared for its execution, with the
    checks around it (JOB_CATALOGUE.md §1). The caller passes the queue's own functions
    (apps.jobs.services), since the outbox imports nothing of the queue but its flags."""

    try_take: Callable[..., bool]
    release: Callable[..., None]


class RealmRunUnavailableError(RuntimeError):
    """The run cannot run here: inside a caller's transaction."""


class ReadbackMismatchError(Exception):
    """The realm does not show the target state after the delivery's writes."""


class InconsistentNotFoundError(Exception):
    """A write or a sub-resource answered 404 while the user itself still reads back."""


@dataclass
class RunReport:
    already_running: bool = False
    # How long the session holding the run lock has existed, when another pass held it.
    lock_holder_age_s: float | None = None
    reconciled: int = 0
    succeeded: int = 0
    user_absent: int = 0
    deferred: int = 0
    failed: int = 0
    mismatched: int = 0
    credential: int = 0
    drift: int = 0
    unverifiable: int = 0
    unverified: int = 0
    reconciliation: int = 0
    late: int = 0
    withdrawn: int = 0
    held: int = 0
    outstanding: int = 0
    oldest_outstanding_s: int = 0

    def line(self) -> str:
        return " ".join(
            f"{name}={value}"
            for name, value in vars(self).items()
            if name not in ("already_running", "lock_holder_age_s")
        )

    @property
    def needs_operator(self) -> bool:
        """A failure, a refused credential, an unknown outcome, or a person whose realm access Core
        took away and the realm still grants: what a scheduler must report."""
        return bool(
            self.failed
            or self.mismatched
            or self.credential
            or self.drift
            or self.unverified
            or self.reconciliation
            or self.late
            or self.outstanding
        )


@dataclass(frozen=True)
class Claimed:
    delivery_id: UUID
    organisation_id: UUID
    attempt_id: UUID
    seq: int
    operation: str
    realm: str
    realm_user_id: str


@dataclass(frozen=True)
class Outcome:
    attempt: str  # accepted | temporary | transport | ambiguous | permanent
    reason: str | None
    http_status: int | None = None
    error_class: str | None = None


def _execute(statement: str, parameters: list[Any] | None = None) -> int:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        count: int = cursor.rowcount
    return count


def _rows(
    statement: str, parameters: list[Any] | dict[str, Any] | None = None
) -> list[tuple[Any, ...]]:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        rows: list[tuple[Any, ...]] = cursor.fetchall()
    return rows


def _metadata(
    *, seq: int | None, operation: str, http_status: int | None, reason: str | None
) -> dict[str, object]:
    return {"attempt": seq, "operation": operation, "http_status": http_status, "reason": reason}


def jitter(upper: float) -> float:
    return secrets.SystemRandom().uniform(0.0, upper)


def backoff_s(deferral: int) -> float:
    """At least BACKOFF_FLOOR_S, then retry class A's full jitter: a retry never starts while a
    request that timed out could still be processed by Keycloak."""
    return BACKOFF_FLOOR_S + jitter(min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** (deferral - 1)))


# ---------------------------------------------------------------------------- execute ----


def confirm_absent(admin: RealmAdmin) -> str:
    """A 404 user counts as absent only once the realm's admin API answers for the realm: a wrong
    realm or host is never read as a person who is already gone."""
    admin.count_users()
    return "user_absent"


def turn_off(admin: RealmAdmin, user_id: str) -> str | None:
    """Disable the user, end its online sessions, revoke every offline grant, read back."""
    found = admin.get_user(user_id)
    if found is None:
        return confirm_absent(admin)
    if found.get("enabled") is not False:
        admin.set_enabled(user_id, False)
    # Ends online sessions only, and sets the user's not-before (Keycloak 26.0.7 UserResource.logout).
    admin.logout(user_id)
    # Lists every client holding a consent or an offline token; revoking one removes both.
    for consent in admin.consents(user_id):
        client_id = consent.get("clientId")
        if isinstance(client_id, str) and client_id:
            admin.revoke_consent(user_id, client_id)
    after = admin.get_user(user_id)
    if after is None:
        return confirm_absent(admin)
    if after.get("enabled") is not False or admin.sessions(user_id) or admin.consents(user_id):
        raise ReadbackMismatchError()
    return None


def turn_on(admin: RealmAdmin, user_id: str) -> str | None:
    """Enable the user and nothing else: no session or grant is restored. It also overrides a
    disable made in Keycloak outside Core: Core's membership is authoritative."""
    found = admin.get_user(user_id)
    if found is None:
        return confirm_absent(admin)
    if found.get("enabled") is not True:
        admin.set_enabled(user_id, True)
    after = admin.get_user(user_id)
    if after is None:
        return confirm_absent(admin)
    if after.get("enabled") is not True:
        raise ReadbackMismatchError()
    return None


OPERATIONS: dict[str, Callable[[RealmAdmin, str], str | None]] = {
    ACCESS_OFF: turn_off,
    ACCESS_ON: turn_on,
}


class PhaseDeadlineError(Exception):
    """The phase's deadline passed between two calls: nothing more is started."""


class _DeadlineAdmin:
    """Checks the deadline before every call it passes on, so a delivery stops between its calls
    when its phase runs out. A call already started keeps its own deadline (TIMEOUT_S); a write
    once sent follows the ambiguity rules (§6.1.3)."""

    def __init__(self, admin: RealmAdmin, deadline: float) -> None:
        self._admin = admin
        self._deadline = deadline

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._admin, name)

        def guarded(*args: Any, **kwargs: Any) -> Any:
            if time.monotonic() >= self._deadline:
                raise PhaseDeadlineError()
            return method(*args, **kwargs)

        return guarded


def perform(
    claimed: Claimed, admin_factory: AdminFactory, *, deadline: float | None = None
) -> Outcome:
    """Call the realm for one claimed delivery; never raises. Past `deadline` (time.monotonic())
    it starts no further call, and the delivery waits for the next pass without spending budget:
    every call it completed is idempotent, and no write of it is in flight."""
    if deadline is not None and time.monotonic() >= deadline:
        return Outcome("transport", "deadline")
    try:
        with admin_factory(RealmTarget(claimed.realm), deadline=deadline) as opened:
            admin: Any = opened if deadline is None else _DeadlineAdmin(opened, deadline)
            try:
                reason = OPERATIONS[claimed.operation](admin, claimed.realm_user_id)
            except RealmUserAbsentError:
                # A 404 on a write or a sub-resource certifies nothing by itself: the user must
                # read back absent too, and the realm must answer for itself.
                if admin.get_user(claimed.realm_user_id) is not None:
                    raise InconsistentNotFoundError() from None
                reason = confirm_absent(admin)
        return Outcome("accepted", reason)
    except PhaseDeadlineError:
        return Outcome("transport", "deadline")
    except ReadbackMismatchError:
        return Outcome("temporary", "readback_mismatch")
    except InconsistentNotFoundError:
        return Outcome("permanent", "not_found_inconsistent")
    except RealmCallError as error:
        if error.kind == "transport":
            return Outcome("transport", "transport", error.http_status)
        if error.kind == "credential":
            return Outcome("transport", "credential", error.http_status)
        if error.kind == "temporary":
            return Outcome("temporary", "temporary", error.http_status)
        if error.kind == "ambiguous":
            return Outcome("ambiguous", "outcome_unknown", error.http_status)
        return Outcome("permanent", "rejected", error.http_status)
    except Exception as error:  # noqa: BLE001 - perform never raises
        # Raised anywhere, after a write may have left: its outcome is unknown.
        return Outcome("ambiguous", "outcome_unknown", None, type(error).__name__)


# ---------------------------------------------------------------------------- reconcile ----

# Every realm identity of a suspended or removed membership whose latest realm access delivery is
# missing or turns access on, or, when an operator asks, is an `access_off` that failed (§6.1.4).
_RECONCILE = """
SELECT m.organisation_id, m.id, i.id, i.subject
FROM orgs_membership m
JOIN identity_identity i ON i.user_id = m.user_id AND i.organisation_id = m.organisation_id
LEFT JOIN LATERAL (
    SELECT r.operation, d.status FROM outbox_realmaccess r
    JOIN outbox_outboxdelivery d ON d.id = r.delivery_id
    WHERE r.identity_id = i.id
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1
) latest ON true
WHERE m.state IN ('suspended', 'removed') AND m.deleted_at IS NULL
  AND (latest.operation IS NULL OR latest.operation = 'access_on'
       OR (%s AND latest.status = 'failed'))
ORDER BY m.organisation_id, m.id, i.id
"""


def reconcile(*, requeue_failed: bool = False) -> int:
    """Enqueue the `access_off` Core's state owes the realm; how many. Idempotent: concurrent
    passes serialise on a transaction lock, and a second pass finds nothing owed. A failed
    `access_off` is enqueued again only when an operator asks (`requeue_failed`)."""
    with transaction.atomic():
        _execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [RECONCILE_LOCK])
        owed = _rows(_RECONCILE, [requeue_failed])
        for organisation_id, membership_id, identity_id, subject in owed:
            insert_realm_access(
                organisation_id=organisation_id,
                membership_id=membership_id,
                identity_id=identity_id,
                realm_user_id=subject,
                operation=ACCESS_OFF,
            )
    if owed:
        logger.warning("realm access reconcile enqueued %s access_off deliveries", len(owed))
    return len(owed)


# -------------------------------------------------------------------------------- sweep ----

_ABANDONED = """
SELECT d.id, d.organisation_id, a.id, a.seq, r.operation
FROM outbox_outboxdelivery d
JOIN outbox_realmaccess r ON r.delivery_id = d.id
JOIN outbox_deliveryattempt a ON a.delivery_id = d.id AND a.outcome IS NULL
WHERE d.status = 'in_flight' AND d.category = 'identity_user_operation'
  AND a.started_at < clock_timestamp() - %s * interval '1 second'
ORDER BY d.id
FOR NO KEY UPDATE OF d SKIP LOCKED
"""


def sweep(report: RunReport) -> None:
    """An attempt abandoned by a runner that stalled or died has an unknown outcome: the runner may
    still land its write. It is closed `abandoned` and its delivery held in `needs_reconciliation`
    for an operator, never retried automatically (ADR-0004); it holds back every later delivery of
    the same identity and is outstanding on every run until an operator decides it (§6.1.4)."""
    with transaction.atomic():
        for delivery_id, organisation_id, attempt_id, seq, operation in _rows(
            _ABANDONED, [STALE_AFTER.total_seconds()]
        ):
            _execute(
                "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', "
                "finished_at = clock_timestamp() WHERE id = %s AND outcome IS NULL",
                [attempt_id],
            )
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'needs_reconciliation', "
                "updated_at = clock_timestamp() WHERE id = %s",
                [delivery_id],
            )
            record_delivery_event(
                action="outbox_delivery.reconciliation_required",
                delivery_id=delivery_id,
                organisation_id=organisation_id,
                metadata=_metadata(
                    seq=seq, operation=operation, http_status=None, reason="attempt_abandoned"
                ),
            )
            report.reconciliation += 1
            logger.error(
                "realm access delivery %s attempt %s abandoned: held for an operator's decision",
                delivery_id,
                seq,
            )


def _spent(delivery_id: UUID) -> int:
    ((spent,),) = _rows(
        "SELECT count(*) FROM outbox_deliveryattempt WHERE delivery_id = %s "
        "AND outcome IN ('temporary', 'abandoned')",
        [delivery_id],
    )
    return int(spent)


# -------------------------------------------------------------------------------- claim ----

# The oldest due delivery with no earlier delivery of the same identity still pending, in flight or
# unresolved, so an access_off and a later access_on of one person apply in commit order, and
# nothing of a person runs while an outcome of theirs is unknown.
_CLAIM = """
SELECT d.id, d.organisation_id, r.operation, r.membership_id, r.identity_id, r.realm_user_id
FROM outbox_outboxdelivery d JOIN outbox_realmaccess r ON r.delivery_id = d.id
WHERE d.status = 'pending' AND d.category = 'identity_user_operation' AND d.changes_realm
  AND r.not_before <= clock_timestamp() AND NOT (d.id = ANY(%s))
  {ordered}
  {only}
ORDER BY d.created_at, d.id
LIMIT 1
FOR NO KEY UPDATE OF d SKIP LOCKED
"""
IN_ORDER = """AND NOT EXISTS (
    SELECT 1 FROM outbox_outboxdelivery e JOIN outbox_realmaccess q ON q.delivery_id = e.id
    WHERE q.identity_id = r.identity_id AND e.status IN ('pending', 'in_flight', 'needs_reconciliation')
      AND (e.created_at, e.id) < (d.created_at, d.id))"""

# Core's own rows the delivery names, the membership read under a share lock: a change still open
# is waited for, then seen; one that commits later is ordered after this delivery.
_SUBJECT = """
SELECT m.organisation_id, m.user_id, m.state, m.deleted_at IS NULL,
       i.organisation_id, i.user_id, i.subject, i.realm, i.issuer,
       i.enabled AND i.deleted_at IS NULL,
       o.realm, o.issuer
FROM orgs_membership m, identity_identity i, orgs_organisation o
WHERE m.id = %s AND i.id = %s AND o.id = %s
FOR SHARE OF m
"""


@dataclass(frozen=True)
class Subject:
    """What Core's own rows say about a delivery's person, re-derived at the claim."""

    realm: str
    realm_user_id: str
    membership_state: str
    membership_live: bool
    identity_usable: bool


def payload_problem(
    *,
    organisation_id: UUID,
    realm_user_id: str,
    found: tuple[Any, ...] | None,
    origins_issuer: str,
) -> str | None:
    """Which check a delivery's payload fails against Core's rows, or None. Each names a field,
    never a value."""
    if found is None:
        return "row_missing"
    (
        m_organisation,
        m_user,
        _state,
        _live,
        i_organisation,
        i_user,
        subject,
        realm,
        issuer,
        _usable,
        o_realm,
        o_issuer,
    ) = found
    if m_organisation != organisation_id:
        return "membership_organisation"
    if i_organisation != organisation_id or i_user != m_user:
        return "identity_person"
    if subject != realm_user_id:
        return "realm_user_id"
    if realm != o_realm or issuer != o_issuer:
        return "realm"
    try:
        served = realm_issuer(realm, RealmOrigins(issuer=origins_issuer, admin=""))
    except RealmCallError:
        return "realm"
    if issuer != served:
        return "issuer"
    return None


def withdrawn(operation: str, subject: Subject) -> bool:
    """Whether executing the delivery would move the realm away from the membership's current
    state: an `access_off` of an active membership (a reconcile that raced a reactivation), or an
    `access_on` of one that is not active, or of an identity that is not usable."""
    active = subject.membership_state == "active" and subject.membership_live
    if operation == ACCESS_OFF:
        return active
    return not (active and subject.identity_usable)


def _end(
    delivery_id: UUID,
    organisation_id: UUID,
    *,
    status: str,
    action: str,
    metadata: dict[str, object],
) -> None:
    _execute(
        "UPDATE outbox_outboxdelivery SET status = %s, finished_at = clock_timestamp(), "
        "updated_at = clock_timestamp() WHERE id = %s",
        [status, delivery_id],
    )
    record_delivery_event(
        action=action, delivery_id=delivery_id, organisation_id=organisation_id, metadata=metadata
    )


_AGAIN = object()


def claim_next(
    report: RunReport,
    skipped: set[UUID],
    lock: OrganisationLock,
    *,
    origins_issuer: str,
    only: list[UUID] | None = None,
) -> Claimed | None:
    """The next due delivery, its organisation lock held and its attempt opened and committed; or
    None when nothing is due. A delivery held by a realm job is skipped for this run, and a
    mismatched or withdrawn one ended; either way the claim moves on to the next."""
    while True:
        claimed = _claim_one(report, skipped, lock, origins_issuer, only)
        if claimed is not _AGAIN:
            return claimed  # type: ignore[return-value]


def _claim_one(
    report: RunReport,
    skipped: set[UUID],
    lock: OrganisationLock,
    origins_issuer: str,
    only: list[UUID] | None = None,
) -> Claimed | None | object:
    locked: UUID | None = None
    opened: Claimed | None = None
    try:
        with transaction.atomic():
            if only is None:
                rows = _rows(_CLAIM.format(ordered=IN_ORDER, only=""), [sorted(skipped)])
            else:
                rows = _rows(
                    _CLAIM.format(ordered=IN_ORDER, only="AND d.id = ANY(%s)"),
                    [sorted(skipped), list(only)],
                )
            if not rows:
                return None
            (
                delivery_id,
                organisation_id,
                operation,
                membership_id,
                identity_id,
                realm_user_id,
            ) = rows[0]
            skipped.add(delivery_id)
            if not lock.try_take(organisation_id=organisation_id):
                report.held += 1
                logger.info("realm access delivery %s held: organisation lock", delivery_id)
                return _AGAIN
            locked = organisation_id
            found = _rows(_SUBJECT, [membership_id, identity_id, organisation_id])
            row = found[0] if found else None
            problem = payload_problem(
                organisation_id=organisation_id,
                realm_user_id=realm_user_id,
                found=row,
                origins_issuer=origins_issuer,
            )
            if problem is not None or row is None:
                _end(
                    delivery_id,
                    organisation_id,
                    status="failed",
                    action="outbox_delivery.failed",
                    metadata=_metadata(
                        seq=None, operation=operation, http_status=None, reason="payload_mismatch"
                    ),
                )
                report.failed += 1
                report.mismatched += 1
                logger.error(
                    "realm access delivery %s failed: payload_mismatch on %s", delivery_id, problem
                )
                return _AGAIN
            subject = Subject(
                realm=row[7],
                realm_user_id=row[6],
                membership_state=row[2],
                membership_live=row[3],
                identity_usable=row[9],
            )
            if withdrawn(operation, subject):
                _end(
                    delivery_id,
                    organisation_id,
                    status="failed",
                    action="outbox_delivery.failed",
                    metadata=_metadata(
                        seq=None, operation=operation, http_status=None, reason="withdrawn"
                    ),
                )
                report.withdrawn += 1
                logger.info(
                    "realm access delivery %s withdrawn: %s no longer matches the membership",
                    delivery_id,
                    operation,
                )
                return _AGAIN
            ((last_seq,),) = _rows(
                "SELECT coalesce(max(seq), 0) FROM outbox_deliveryattempt WHERE delivery_id = %s",
                [delivery_id],
            )
            seq = int(last_seq) + 1
            attempt_id = new_uuid7()
            reference = f"realm-access:{attempt_id}"
            _execute(
                "INSERT INTO outbox_deliveryattempt (id, delivery_id, seq, message_id) "
                "VALUES (%s, %s, %s, %s)",
                [attempt_id, delivery_id, seq, reference],
            )
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'in_flight', "
                "started_at = clock_timestamp(), operation_ref = %s, "
                "updated_at = clock_timestamp() WHERE id = %s",
                [reference, delivery_id],
            )
        # Committed: the attempt is open, and the lock stays held until its outcome is recorded.
        opened = Claimed(
            delivery_id=delivery_id,
            organisation_id=organisation_id,
            attempt_id=attempt_id,
            seq=seq,
            operation=operation,
            realm=subject.realm,
            realm_user_id=subject.realm_user_id,
        )
        logger.info(
            "realm access delivery %s attempt %s claimed: operation %s", delivery_id, seq, operation
        )
        return opened
    finally:
        if locked is not None and opened is None:
            lock.release(organisation_id=locked)


# ------------------------------------------------------------------------------- record ----


def attempt_is_open(claimed: Claimed) -> bool:
    return bool(
        _rows(
            "SELECT 1 FROM outbox_outboxdelivery d JOIN outbox_deliveryattempt a "
            "ON a.delivery_id = d.id WHERE d.id = %s AND d.status = 'in_flight' "
            "AND a.id = %s AND a.outcome IS NULL FOR NO KEY UPDATE OF d",
            [claimed.delivery_id, claimed.attempt_id],
        )
    )


def record_outcome(claimed: Claimed, outcome: Outcome, report: RunReport) -> None:
    """Close the attempt and move the delivery, with its audit row, in one transaction."""
    metadata = _metadata(
        seq=claimed.seq,
        operation=claimed.operation,
        http_status=outcome.http_status,
        reason=outcome.reason,
    )
    with transaction.atomic():
        if not attempt_is_open(claimed):
            # The delivery waits for an operator, whose realm read decides it: this outcome is
            # recorded nowhere, and reported.
            report.late += 1
            logger.error(
                "realm access delivery %s attempt %s outcome %s arrived after it was abandoned",
                claimed.delivery_id,
                claimed.seq,
                outcome.attempt,
            )
            return
        _execute(
            "UPDATE outbox_deliveryattempt SET outcome = %s, finished_at = clock_timestamp() "
            "WHERE id = %s",
            [outcome.attempt, claimed.attempt_id],
        )
        if outcome.attempt == "accepted":
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="succeeded",
                action="outbox_delivery.sent",
                metadata=metadata,
            )
            report.succeeded += 1
            if outcome.reason == "user_absent":
                report.user_absent += 1
                logger.warning(
                    "realm access delivery %s: realm user absent, the realm answers",
                    claimed.delivery_id,
                )
        elif outcome.attempt == "transport":
            _transport(claimed, outcome, metadata, report)
        elif outcome.attempt == "ambiguous":
            # A write may still be executing in Keycloak: never retried (ADR-0004). The delivery
            # blocks every later one of the person and is outstanding until an operator decides
            # it, after the quiet period, from a fresh realm read (§6.1.4).
            _execute(
                "UPDATE outbox_outboxdelivery SET status = 'needs_reconciliation', "
                "updated_at = clock_timestamp() WHERE id = %s",
                [claimed.delivery_id],
            )
            record_delivery_event(
                action="outbox_delivery.reconciliation_required",
                delivery_id=claimed.delivery_id,
                organisation_id=claimed.organisation_id,
                metadata=metadata,
            )
            report.reconciliation += 1
            logger.error(
                "realm access delivery %s attempt %s: write outcome unknown, held for an "
                "operator, http_status %s error %s",
                claimed.delivery_id,
                claimed.seq,
                outcome.http_status,
                outcome.error_class,
            )
        elif outcome.attempt == "permanent":
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="failed",
                action="outbox_delivery.failed",
                metadata=metadata,
            )
            report.failed += 1
            logger.error(
                "realm access delivery %s failed: rejected, http_status %s",
                claimed.delivery_id,
                outcome.http_status,
            )
        else:
            _defer(claimed, metadata, report)
    logger.info(
        "realm access delivery %s attempt %s operation %s outcome %s reason %s http_status %s "
        "error %s",
        claimed.delivery_id,
        claimed.seq,
        claimed.operation,
        outcome.attempt,
        outcome.reason,
        outcome.http_status,
        outcome.error_class,
    )


def _transport(
    claimed: Claimed, outcome: Outcome, metadata: dict[str, object], report: RunReport
) -> None:
    """Nothing reached the realm, or the credential was refused: the delivery waits for the next run
    and spends no budget. A refused credential is an operator's at once; a long outage is reported
    by `outstanding` (§6.1.6)."""
    _execute(
        "UPDATE outbox_outboxdelivery SET status = 'pending', "
        "updated_at = clock_timestamp() WHERE id = %s",
        [claimed.delivery_id],
    )
    record_delivery_event(
        action="outbox_delivery.deferred",
        delivery_id=claimed.delivery_id,
        organisation_id=claimed.organisation_id,
        metadata=metadata,
    )
    report.deferred += 1
    if outcome.reason == "credential":
        report.credential += 1
        logger.error(
            "realm access delivery %s deferred: the realm credential is missing or refused, "
            "http_status %s",
            claimed.delivery_id,
            outcome.http_status,
        )


def _defer(claimed: Claimed, metadata: dict[str, object], report: RunReport) -> None:
    spent = _spent(claimed.delivery_id)
    if spent >= MAX_DEFERRALS:
        _end(
            claimed.delivery_id,
            claimed.organisation_id,
            status="failed",
            action="outbox_delivery.failed",
            metadata={**metadata, "reason": "attempts_exhausted"},
        )
        report.failed += 1
        logger.error("realm access delivery %s failed: attempts exhausted", claimed.delivery_id)
        return
    _execute(
        "UPDATE outbox_realmaccess SET not_before = clock_timestamp() + %s * interval '1 second' "
        "WHERE delivery_id = %s",
        [backoff_s(spent), claimed.delivery_id],
    )
    _execute(
        "UPDATE outbox_outboxdelivery SET status = 'pending', updated_at = clock_timestamp() "
        "WHERE id = %s",
        [claimed.delivery_id],
    )
    record_delivery_event(
        action="outbox_delivery.deferred",
        delivery_id=claimed.delivery_id,
        organisation_id=claimed.organisation_id,
        metadata=metadata,
    )
    report.deferred += 1


# --------------------------------------------------------------------------- outstanding ----

# Each identity of a membership that is off whose latest delivery is an access_off that failed,
# waits for an operator, or has been pending or in flight longer than OUTSTANDING_AFTER.
_OUTSTANDING = """
SELECT count(*), coalesce(extract(epoch FROM clock_timestamp() - min(created_at)), 0)
FROM (
  SELECT d.created_at
  FROM outbox_outboxdelivery d
  JOIN outbox_realmaccess r ON r.delivery_id = d.id
  JOIN orgs_membership m ON m.id = r.membership_id
  WHERE r.operation = 'access_off' AND m.state IN ('suspended', 'removed') AND m.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM outbox_outboxdelivery e JOIN outbox_realmaccess q ON q.delivery_id = e.id
      WHERE q.identity_id = r.identity_id AND (e.created_at, e.id) > (d.created_at, d.id))
    AND (d.status = 'failed'
         OR (d.status IN ('pending', 'in_flight')
             AND d.created_at < clock_timestamp() - %(after)s * interval '1 second'))
  UNION ALL
  SELECT d.created_at
  FROM outbox_outboxdelivery d
  JOIN outbox_realmaccess r ON r.delivery_id = d.id
  JOIN orgs_membership m ON m.id = r.membership_id
  JOIN identity_identity i ON i.id = r.identity_id
  WHERE r.operation = 'access_on' AND m.state = 'active' AND m.deleted_at IS NULL
    AND i.enabled AND i.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM outbox_outboxdelivery e JOIN outbox_realmaccess q ON q.delivery_id = e.id
      WHERE q.identity_id = r.identity_id AND (e.created_at, e.id) > (d.created_at, d.id))
    AND (d.status = 'failed'
         OR (d.status IN ('pending', 'in_flight')
             AND d.created_at < clock_timestamp() - %(after)s * interval '1 second'))
  UNION ALL
  SELECT d.created_at
  FROM outbox_outboxdelivery d JOIN outbox_realmaccess r ON r.delivery_id = d.id
  WHERE d.status = 'needs_reconciliation'
) stuck
"""


def outstanding() -> tuple[int, int]:
    """How many deliveries leave a person with realm access Core took away, or with an unknown
    outcome, and the age in seconds of the oldest."""
    ((count, oldest),) = _rows(_OUTSTANDING, {"after": OUTSTANDING_AFTER.total_seconds()})
    return int(count), int(oldest)


# ---------------------------------------------------------------------------------- run ----


def run_realm_deliveries(
    *,
    admin_factory: AdminFactory,
    organisation_lock: OrganisationLock,
    origins_issuer: str,
    limit: int = DEFAULT_LIMIT,
    reconcile_first: bool = True,
    requeue_failed: bool = False,
) -> RunReport:
    """Reconcile, sweep, then claim, execute and record due realm access deliveries (§6.1.2),
    and report what is still outstanding."""
    if connection.in_atomic_block:
        raise RealmRunUnavailableError("run_realm_deliveries runs in transactions of its own")
    ((running,),) = _rows("SELECT pg_try_advisory_lock(hashtext(%s))", [RUN_LOCK])
    if not running:
        age = run_lock_holder_age()
        logger.info("run_realm_deliveries: another pass holds the run lock (held %ss)", age)
        return RunReport(already_running=True, lock_holder_age_s=age)
    try:
        report = _run(
            admin_factory=admin_factory,
            organisation_lock=organisation_lock,
            origins_issuer=origins_issuer,
            limit=limit,
            reconcile_first=reconcile_first,
            requeue_failed=requeue_failed,
        )
    except BaseException:
        # The pass failed, perhaps because its connection died: releasing the lock may fail too,
        # and must not replace the error that ended the pass. A dead session releases it anyway.
        try:
            _release_run_lock()
        except Exception as error:  # noqa: BLE001 - logged; the original error is re-raised
            logger.error(
                "run_realm_deliveries could not release the run lock: %s", type(error).__name__
            )
        raise
    _release_run_lock()
    return report


def _release_run_lock() -> None:
    _execute("SELECT pg_advisory_unlock(hashtext(%s))", [RUN_LOCK])


# The session holding the run lock, a one-key advisory lock: its key splits into classid (high 32
# bits) and objid (low 32 bits), objsubid 1. Its age is its session's: the command opens one
# connection per run (CONN_MAX_AGE is 0), so the session starts with the pass.
_RUN_LOCK_HOLDER_AGE = """
SELECT max(extract(epoch FROM clock_timestamp() - a.backend_start))
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
  AND l.classid::bigint = ((hashtext(%(key)s)::bigint >> 32) & 4294967295)
  AND l.objid::bigint = (hashtext(%(key)s)::bigint & 4294967295)
"""


def run_lock_holder_age() -> float | None:
    """Seconds since the session holding the run lock started, or None if it cannot be read."""
    rows = _rows(_RUN_LOCK_HOLDER_AGE, {"key": RUN_LOCK})
    if not rows or rows[0][0] is None:
        return None
    return float(rows[0][0])


def run_lock_verdict(age_s: float | None) -> str:
    """`stuck_run` once the holder is older than STUCK_RUN_AFTER_S, else `already_running`. An
    age that cannot be read is not called stuck: the holder may have just ended."""
    if age_s is not None and age_s > STUCK_RUN_AFTER_S:
        return "stuck_run"
    return "already_running"


def phase_ends(start: float) -> tuple[float, float, float]:
    """The ends of the delivery, verification and correction windows of a run started at `start`
    (time.monotonic()): each window begins CALL_OVERRUN_S after the previous one ends, so a call
    started at the end of one never eats into the next, and none ends after RUN_DEADLINE_S."""
    run_end = start + RUN_DEADLINE_S
    delivery_end = min(start + DELIVERY_PHASE_S, run_end)
    verify_end = min(delivery_end + CALL_OVERRUN_S + VERIFY_PHASE_S, run_end)
    correction_end = min(verify_end + CALL_OVERRUN_S + CORRECTION_PHASE_S, run_end)
    return delivery_end, verify_end, correction_end


def _run(
    *,
    admin_factory: AdminFactory,
    organisation_lock: OrganisationLock,
    origins_issuer: str,
    limit: int,
    reconcile_first: bool,
    requeue_failed: bool,
) -> RunReport:
    delivery_end, verify_end, correction_end = phase_ends(time.monotonic())
    report = RunReport()
    if reconcile_first:
        report.reconciled = reconcile(requeue_failed=requeue_failed)
    sweep(report)
    skipped: set[UUID] = set()

    def deliver(budget: int, phase_end: float, only: list[UUID] | None = None) -> None:
        attempted = 0
        while attempted < budget and time.monotonic() < phase_end:
            claimed = claim_next(
                report, skipped, organisation_lock, origins_issuer=origins_issuer, only=only
            )
            if claimed is None:
                break
            attempted += 1
            try:
                outcome = perform(claimed, admin_factory, deadline=phase_end)
                record_outcome(claimed, outcome, report)
            finally:
                organisation_lock.release(organisation_id=claimed.organisation_id)

    # New revocations first, in their own phase; then every realm is verified in a phase of its
    # own; then the corrections that verification enqueued, with a budget of their own (§6.1.9).
    # Every phase ends at the run's deadline at the latest.
    deliver(limit, delivery_end)
    corrections = verify_realms(
        report=report,
        admin_factory=admin_factory,
        organisation_lock=organisation_lock,
        origins_issuer=origins_issuer,
        phase_end=verify_end,
    )
    if corrections:
        deliver(CORRECTION_BUDGET, correction_end, only=corrections)
    report.unverified = unverified_realms()
    report.outstanding, report.oldest_outstanding_s = outstanding()
    if report.outstanding:
        logger.error(
            "realm access outstanding: %s deliveries leave access Core removed or an outcome "
            "unknown, oldest %ss",
            report.outstanding,
            report.oldest_outstanding_s,
        )
    return report


# ------------------------------------------------------------ an operator's decision ----


@dataclass(frozen=True)
class RealmState:
    """What a realm read observed of one realm user: never its representation."""

    present: bool
    enabled: bool
    sessions: int
    grants: int


def observe(admin: RealmAdmin, user_id: str) -> RealmState:
    """The realm user's current state, read; an absent user only once the realm answers."""
    found = admin.get_user(user_id)
    if found is None:
        confirm_absent(admin)
        return RealmState(present=False, enabled=False, sessions=0, grants=0)
    return RealmState(
        present=True,
        enabled=found.get("enabled") is True,
        sessions=len(admin.sessions(user_id)),
        grants=len(admin.consents(user_id)),
    )


def reached(operation: str, state: RealmState) -> bool:
    """Whether the realm shows what `operation` sets: off is disabled with no session and no grant,
    on is enabled. An absent user has nothing either operation could change."""
    if not state.present:
        return True
    if operation == ACCESS_OFF:
        return not state.enabled and state.sessions == 0 and state.grants == 0
    return state.enabled


@dataclass(frozen=True)
class Unresolved:
    """A realm access delivery waiting for an operator, its subject re-derived from Core's rows."""

    delivery_id: UUID
    organisation_id: UUID
    operation: str
    membership_id: UUID
    identity_id: UUID
    realm: str
    realm_user_id: str
    # When its last attempt ended (or started, if it never closed): the quiet period runs from here.
    last_attempt_at: datetime | None
    # The last attempt's own closing record: when the runner closed it `ambiguous` itself, that
    # record is the evidence the runner's write ended on its side (§6.1.4).
    last_attempt_id: UUID | None
    last_attempt_outcome: str | None


class UnresolvedRefusedError(Exception):
    """Not a realm access delivery in needs_reconciliation, or one Core's rows contradict."""


def unresolved(delivery_id: UUID, *, origins_issuer: str) -> Unresolved:
    with transaction.atomic():
        rows = _rows(
            "SELECT d.organisation_id, r.operation, r.membership_id, r.identity_id, "
            "r.realm_user_id FROM outbox_outboxdelivery d JOIN outbox_realmaccess r "
            "ON r.delivery_id = d.id WHERE d.id = %s AND d.status = 'needs_reconciliation'",
            [delivery_id],
        )
        if not rows:
            raise UnresolvedRefusedError("not_in_reconciliation")
        organisation_id, operation, membership_id, identity_id, realm_user_id = rows[0]
        found = _rows(_SUBJECT, [membership_id, identity_id, organisation_id])
        row = found[0] if found else None
        problem = payload_problem(
            organisation_id=organisation_id,
            realm_user_id=realm_user_id,
            found=row,
            origins_issuer=origins_issuer,
        )
        if problem is not None or row is None:
            raise UnresolvedRefusedError("payload_mismatch")
        last = _rows(
            "SELECT id, outcome, coalesce(finished_at, started_at) FROM outbox_deliveryattempt "
            "WHERE delivery_id = %s ORDER BY seq DESC LIMIT 1",
            [delivery_id],
        )
        last_attempt_id, last_attempt_outcome, last_attempt_at = last[0] if last else (None,) * 3
    return Unresolved(
        delivery_id=delivery_id,
        organisation_id=organisation_id,
        operation=operation,
        membership_id=membership_id,
        identity_id=identity_id,
        realm=row[7],
        realm_user_id=row[6],
        last_attempt_at=last_attempt_at,
        last_attempt_id=last_attempt_id,
        last_attempt_outcome=last_attempt_outcome,
    )


def desired_operation(held: Unresolved) -> str:
    """What Core's membership asks of the realm now, read under a share lock on the membership:
    on for an active membership of a usable identity, off for anything else."""
    rows = _rows(
        "SELECT m.state = 'active' AND m.deleted_at IS NULL, "
        "i.enabled AND i.deleted_at IS NULL "
        "FROM orgs_membership m, identity_identity i WHERE m.id = %s AND i.id = %s "
        "FOR SHARE OF m",
        [held.membership_id, held.identity_id],
    )
    return ACCESS_ON if rows and rows[0][0] and rows[0][1] else ACCESS_OFF


def enqueue_desired(held: Unresolved, operation: str) -> UUID:
    """A fresh delivery of what Core asks, in the decision's transaction."""
    return insert_realm_access(
        organisation_id=held.organisation_id,
        membership_id=held.membership_id,
        identity_id=held.identity_id,
        realm_user_id=held.realm_user_id,
        operation=operation,
    )


# ---------------------------------------------------------------- bulk verification ----

# The realms Core has turned someone off in, least recently attempted first: `last_attempted_at`
# moves when a listing of the realm starts, whatever its outcome, so a realm that keeps failing goes
# to the back and cannot keep a healthy one from its turn; a realm skipped (a held lock, a spent
# phase) keeps its place at the front.
_REALMS_TO_VERIFY = """
SELECT o.id, o.realm, o.issuer
FROM orgs_organisation o
LEFT JOIN outbox_realmverification v ON v.organisation_id = o.id
WHERE EXISTS (
  SELECT 1 FROM orgs_membership m
  WHERE m.organisation_id = o.id AND m.state IN ('suspended', 'removed') AND m.deleted_at IS NULL)
ORDER BY v.last_attempted_at NULLS FIRST, o.id
"""

# Who must be off in one realm, as verified: every identity of a suspended or removed membership
# whose latest delivery is an access_off that succeeded. Anything else is owned elsewhere: open
# work by its own delivery, held in order (§6.1.2); a failed access_off by `outstanding` and the
# operator (§6.1.6); a missing or stray access_on by reconcile (§6.1.4).
_MUST_BE_OFF = """
SELECT i.id, m.id, i.subject
FROM orgs_membership m
JOIN identity_identity i ON i.user_id = m.user_id AND i.organisation_id = m.organisation_id
WHERE m.organisation_id = %s AND m.state IN ('suspended', 'removed') AND m.deleted_at IS NULL
  AND (
    SELECT r.operation = 'access_off' AND d.status = 'succeeded'
    FROM outbox_realmaccess r JOIN outbox_outboxdelivery d ON d.id = r.delivery_id
    WHERE r.identity_id = i.id
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1
  )
"""

# Under the membership's share lock: still off, and still nothing open for the identity.
_STILL_OFF = """
SELECT 1 FROM orgs_membership m
WHERE m.id = %s AND m.state IN ('suspended', 'removed') AND m.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM outbox_outboxdelivery e JOIN outbox_realmaccess q ON q.delivery_id = e.id
    WHERE q.identity_id = %s AND e.status IN ('pending', 'in_flight', 'needs_reconciliation'))
FOR SHARE OF m
"""

_HEALTH_ENSURE = """
INSERT INTO outbox_realmverification (organisation_id, realm) VALUES (%s, %s)
ON CONFLICT (organisation_id) DO UPDATE SET realm = EXCLUDED.realm
"""
_HEALTH_ATTEMPTED = """
UPDATE outbox_realmverification SET last_attempted_at = clock_timestamp() WHERE organisation_id = %s
"""
_HEALTH_VERIFIED = """
UPDATE outbox_realmverification SET last_verified_at = clock_timestamp(), unverified_passes = 0,
  consecutive_failures = 0, last_failure = NULL, updated_at = clock_timestamp()
WHERE organisation_id = %s
"""
_HEALTH_FAILED = """
UPDATE outbox_realmverification SET unverified_passes = unverified_passes + 1,
  consecutive_failures = consecutive_failures + 1, last_failure = %s,
  updated_at = clock_timestamp()
WHERE organisation_id = %s
"""
# A pass that did not read the realm (a job held its lock, or the phase ran out) counts towards
# the alert and leaves the failure history exactly as it was.
_HEALTH_SKIPPED = """
UPDATE outbox_realmverification SET unverified_passes = unverified_passes + 1,
  updated_at = clock_timestamp()
WHERE organisation_id = %s
"""
_UNVERIFIED = """
SELECT count(*) FROM outbox_realmverification v
WHERE EXISTS (
  SELECT 1 FROM orgs_membership m
  WHERE m.organisation_id = v.organisation_id AND m.state IN ('suspended', 'removed')
    AND m.deleted_at IS NULL)
  AND (v.unverified_passes >= %s
       OR clock_timestamp() - coalesce(v.last_verified_at, v.first_needed_at)
          > %s * interval '1 second')
"""


def _health(statement: str, parameters: list[Any]) -> None:
    with transaction.atomic():
        _execute(statement, parameters)


def unverified_realms() -> int:
    """Realms that need verification and were not fully verified for VERIFY_ALERT_PASSES passes in
    a row, or for longer than VERIFY_ALERT_AFTER."""
    ((count,),) = _rows(_UNVERIFIED, [VERIFY_ALERT_PASSES, VERIFY_ALERT_AFTER.total_seconds()])
    return int(count)


def verify_realms(
    *,
    report: RunReport,
    admin_factory: AdminFactory,
    organisation_lock: OrganisationLock,
    origins_issuer: str,
    phase_end: float | None = None,
) -> list[UUID]:
    """For each realm Core has turned someone off in, list every enabled realm user in full pages
    and compare with who Core says must be off; enqueue an `access_off` for each one found enabled
    (a drift), with its audit row. Returns those deliveries' ids, which the run claims at once with
    a budget of their own. One listing, so one token, per realm per pass. Sessions and grants are
    not listed: a disabled user can open no session and refresh no token, and the correction logs
    out and revokes every grant (§6.1.9)."""
    if phase_end is None:
        phase_end = time.monotonic() + VERIFY_PHASE_S
    corrections: list[UUID] = []
    for organisation_id, realm, issuer in _rows(_REALMS_TO_VERIFY):
        _health(_HEALTH_ENSURE, [organisation_id, realm])
        if time.monotonic() >= phase_end:
            _health(_HEALTH_SKIPPED, [organisation_id])
            continue
        try:
            served = realm_issuer(realm, RealmOrigins(issuer=origins_issuer, admin="")) == issuer
        except RealmCallError:
            served = False
        if not served:
            _health(_HEALTH_FAILED, ["not_served", organisation_id])
            report.unverifiable += 1
            logger.error(
                "realm access verification: organisation %s is not this Keycloak's", organisation_id
            )
            continue
        if not organisation_lock.try_take(organisation_id=organisation_id):
            _health(_HEALTH_SKIPPED, [organisation_id])
            report.held += 1
            continue
        try:
            _health(_HEALTH_ATTEMPTED, [organisation_id])
            try:
                with admin_factory(RealmTarget(realm), deadline=phase_end) as admin:
                    enabled = admin.enabled_user_ids(deadline=phase_end)
            except Exception as error:  # noqa: BLE001 - a failed listing is counted, never raised
                kind = error.kind if isinstance(error, RealmCallError) else "temporary"
                _health(_HEALTH_FAILED, [kind, organisation_id])
                report.unverifiable += 1
                if kind == "credential":
                    report.credential += 1
                    logger.error(
                        "realm access verification of organisation %s: the realm credential is "
                        "missing or refused",
                        organisation_id,
                    )
                else:
                    logger.warning(
                        "realm access verification of organisation %s failed: %s %s",
                        organisation_id,
                        kind,
                        type(error).__name__,
                    )
                continue
            _health(_HEALTH_VERIFIED, [organisation_id])
            for identity_id, membership_id, subject in _rows(_MUST_BE_OFF, [organisation_id]):
                if subject not in enabled:
                    continue
                delivery_id = _enqueue_correction(
                    organisation_id, membership_id, identity_id, subject
                )
                if delivery_id is None:
                    continue
                corrections.append(delivery_id)
                report.drift += 1
                logger.error(
                    "realm access drift: identity %s of a membership that is off is enabled in "
                    "its realm; access_off %s enqueued",
                    identity_id,
                    delivery_id,
                )
        finally:
            organisation_lock.release(organisation_id=organisation_id)
    return corrections


def _enqueue_correction(
    organisation_id: UUID, membership_id: UUID, identity_id: UUID, subject: str
) -> UUID | None:
    with transaction.atomic():
        if not _rows(_STILL_OFF, [membership_id, identity_id]):
            return None  # reactivated, or new work enqueued meanwhile: that decides
        delivery_id = insert_realm_access(
            organisation_id=organisation_id,
            membership_id=membership_id,
            identity_id=identity_id,
            realm_user_id=subject,
            operation=ACCESS_OFF,
        )
        record_delivery_event(
            action="outbox_delivery.drift_detected",
            delivery_id=delivery_id,
            organisation_id=organisation_id,
            metadata={
                "attempt": None,
                "operation": ACCESS_OFF,
                "http_status": None,
                "reason": "realm_drift",
                "enabled": True,
            },
        )
    return delivery_id
