"""The realm account delivery's run: docs/specs/INVITATIONS.md §4.

For each due delivery, the run reads the invitation and its organisation from Core's own rows (the
payload names the invitation only), then, with that realm's worker credential and outside any
transaction: finds the account holding the invitation's address, creates it when there is none,
with the required actions to verify the address and set a password (TOTP enrollment is optional),
and, while any action is still pending, has the realm mail the person the link to complete them.
It records the account's id, which accepting the invitation requires as the caller's subject.

Every step is idempotent: the account is looked up before it is created, and a create that
collides reads it again. A repeat at worst mails a second set-up link, which is why, unlike a
realm access delivery, an attempt whose outcome is unknown is retried rather than held. The run
never enables, disables or deletes an account.

Logs and audit rows carry identifiers, the HTTP status and a reason only: never an address, a
token or a user representation. Not in the API image.
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_delivery_event

from .realm.keycloak import RealmAccountAdmin, RealmCallError, RealmTarget

logger = logging.getLogger("apps.outbox.realm_accounts")

REQUIRED_ACTIONS = ("VERIFY_EMAIL", "UPDATE_PASSWORD")
# The set-up link stays valid three days; a late invitee asks for a resend, which sends a new one.
ACTIONS_LIFESPAN_S = 3 * 24 * 3600
# The organisation realm's console client (identity realm tooling's org-realm-template.json): the set-up
# mail returns the person to it when KODERA_REALM_SETUP_REDIRECT names where.
CONSOLE_CLIENT_ID = "console"
MAX_ATTEMPTS = 5
BACKOFF_BASE_S = 30.0
BACKOFF_CAP_S = 600.0
STALE_AFTER = timedelta(minutes=15)
DEFAULT_LIMIT = 50

AdminFactory = Callable[[RealmTarget], AbstractContextManager[Any]]


@dataclass
class AccountReport:
    succeeded: int = 0
    mailed: int = 0
    deferred: int = 0
    failed: int = 0
    withdrawn: int = 0
    credential: int = 0
    configuration: int = 0

    def line(self) -> str:
        return (
            f"accounts succeeded={self.succeeded} mailed={self.mailed} deferred={self.deferred} "
            f"failed={self.failed} withdrawn={self.withdrawn} credential={self.credential} "
            f"configuration={self.configuration}"
        )

    @property
    def needs_operator(self) -> bool:
        return self.failed > 0 or self.credential > 0 or self.configuration > 0


@dataclass(frozen=True)
class _Claimed:
    delivery_id: UUID
    organisation_id: UUID
    invitation_id: UUID
    realm: str
    email: str
    locale: str
    attempt: int


class _AccountRefusedError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class _RedirectRefusedError(Exception):
    """The realm answered 400 to a set-up mail naming the return address: its `console` client
    does not list it. The realm's configuration is the operator's to fix, not this invitation's
    fault, so the delivery is held like a refused credential and every later one in that realm
    with it."""


def backoff_s(attempt: int) -> float:
    upper = min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** (attempt - 1))
    return 15.0 + secrets.SystemRandom().uniform(0, upper)


def _sweep() -> None:
    """An attempt open for 15 minutes belonged to a runner that died or stalled: run it again."""
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_outboxdelivery d SET status = 'pending', updated_at = clock_timestamp() "
            "FROM outbox_realmaccount a WHERE a.delivery_id = d.id AND d.status = 'in_flight' "
            "AND d.started_at < clock_timestamp() - %s * interval '1 second'",
            [int(STALE_AFTER.total_seconds())],
        )


_CLAIM = """
SELECT d.id, d.organisation_id, a.invitation_id, a.attempts
FROM outbox_outboxdelivery d JOIN outbox_realmaccount a ON a.delivery_id = d.id
WHERE d.status = 'pending' AND d.category = 'identity_user_operation' AND d.changes_realm
  AND a.not_before <= clock_timestamp() AND NOT (d.id = ANY(%s::uuid[]))
ORDER BY d.created_at, d.id
LIMIT 1
FOR NO KEY UPDATE OF d SKIP LOCKED
"""

_SOURCE = """
SELECT i.state, i.email, i.expires_at > clock_timestamp(), o.realm, o.issuer, o.state, i.locale
FROM orgs_invitation i JOIN orgs_organisation o ON o.id = i.organisation_id
WHERE i.id = %s AND i.organisation_id = %s AND o.deleted_at IS NULL
"""


def _end(
    delivery_id: UUID,
    organisation_id: UUID,
    status: str,
    action: str,
    *,
    attempt: int,
    reason: str,
    http_status: int | None = None,
    realm_user_id: str | None = None,
    retry_after_s: float | None = None,
) -> None:
    """Record an outcome, with its audit row, in the caller's transaction."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_outboxdelivery SET status = %s, updated_at = clock_timestamp(), "
            "finished_at = CASE WHEN %s IN ('succeeded', 'failed') THEN clock_timestamp() END "
            "WHERE id = %s",
            [status, status, delivery_id],
        )
        cursor.execute(
            "UPDATE outbox_realmaccount SET last_reason = %s, "
            "realm_user_id = coalesce(%s, realm_user_id), "
            "not_before = clock_timestamp() + %s * interval '1 second' WHERE delivery_id = %s",
            [reason, realm_user_id, retry_after_s or 0, delivery_id],
        )
    record_delivery_event(
        action=action,
        delivery_id=delivery_id,
        organisation_id=organisation_id,
        metadata={
            "attempt": attempt,
            "operation": "account_ensure",
            "http_status": http_status,
            "reason": reason,
        },
    )


def _claim(
    attempted: list[UUID], origins_issuer: str, report: AccountReport
) -> tuple[bool, _Claimed | None]:
    """Whether a due delivery was found, and the one claimed for a call, if any: one that no
    longer agrees with Core's rows is ended here, without a call."""
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(_CLAIM, [attempted])
        row = cursor.fetchone()
        if row is None:
            return False, None
        delivery_id, organisation_id, invitation_id, attempts = row
        attempted.append(delivery_id)
        cursor.execute(_SOURCE, [invitation_id, organisation_id])
        source = cursor.fetchone()
        if source is None:
            _end(
                delivery_id,
                organisation_id,
                "failed",
                "outbox_delivery.failed",
                attempt=attempts,
                reason="payload_mismatch",
            )
            report.failed += 1
            logger.error("realm account %s: payload_mismatch", delivery_id)
            return True, None
        state, email, live, realm, issuer, organisation_state, locale = source
        if issuer != f"{origins_issuer}/realms/{realm}":
            _end(
                delivery_id,
                organisation_id,
                "failed",
                "outbox_delivery.failed",
                attempt=attempts,
                reason="payload_mismatch",
            )
            report.failed += 1
            logger.error("realm account %s: issuer outside the pinned origin", delivery_id)
            return True, None
        if state != "pending" or not live or organisation_state != "active":
            # Revoked, accepted or expired since it was written: no account is owed any more.
            _end(
                delivery_id,
                organisation_id,
                "failed",
                "outbox_delivery.failed",
                attempt=attempts,
                reason="withdrawn",
            )
            report.withdrawn += 1
            return True, None
        cursor.execute(
            "UPDATE outbox_outboxdelivery SET status = 'in_flight', started_at = clock_timestamp(), "
            "updated_at = clock_timestamp() WHERE id = %s",
            [delivery_id],
        )
        cursor.execute(
            "UPDATE outbox_realmaccount SET attempts = attempts + 1 WHERE delivery_id = %s",
            [delivery_id],
        )
    return True, _Claimed(
        delivery_id, organisation_id, invitation_id, realm, email, locale, attempts + 1
    )


def _exact(admin: RealmAccountAdmin, email: str) -> dict[str, Any] | None:
    found = [
        user
        for user in admin.users_by_email(email)
        if isinstance(user.get("email"), str) and user["email"].lower() == email
    ]
    if len(found) > 1:
        raise _AccountRefusedError("account_ambiguous")
    return found[0] if found else None


def ensure_account(
    admin: RealmAccountAdmin, email: str, locale: str, setup_redirect: str | None = None
) -> tuple[str, bool]:
    """The account holding `email`, created with the required actions and the invitation's
    `locale` when absent, so the realm's set-up mail and sign-in pages speak the invitee's
    language; whether the realm was asked to mail the set-up link, which returns the person to
    `setup_redirect`."""
    user = _exact(admin, email)
    if user is None:
        admin.create_user(
            {
                "username": email,
                "email": email,
                "enabled": True,
                "emailVerified": False,
                "requiredActions": list(REQUIRED_ACTIONS),
                "attributes": {"locale": [locale]},
            }
        )
        user = _exact(admin, email)
        if user is None:
            raise RealmCallError("temporary", cause="created_user_not_found")
    user_id = user.get("id")
    if not isinstance(user_id, str) or not 1 <= len(user_id) <= 255:
        raise _AccountRefusedError("account_unreadable")
    if user.get("enabled") is not True:
        # Someone Core turned off, or an operator did: an invitation never turns an account on.
        raise _AccountRefusedError("account_disabled")
    pending = user.get("requiredActions")
    if not isinstance(pending, list) or not all(isinstance(item, str) for item in pending):
        raise _AccountRefusedError("account_unreadable")
    if not pending:
        return user_id, False
    # The logout moves the account's notBefore to this second, and the realm refuses any set-up
    # link issued before it (identity realm tooling): the link mailed next works, every older one is dead.
    # It also ends the person's sessions, which is meant for a reset. A failed logout sends
    # nothing and is classified like a failed send; nothing comes between the two calls.
    admin.logout(user_id)
    if setup_redirect is None:
        admin.execute_actions_email(user_id, pending, ACTIONS_LIFESPAN_S)
    else:
        try:
            admin.execute_actions_email(
                user_id,
                pending,
                ACTIONS_LIFESPAN_S,
                client_id=CONSOLE_CLIENT_ID,
                redirect_uri=setup_redirect,
            )
        except RealmCallError as error:
            if error.kind == "permanent" and error.http_status == 400:
                raise _RedirectRefusedError() from error
            raise
    return user_id, True


def run_realm_accounts(
    *,
    admin_factory: AdminFactory,
    origins_issuer: str,
    limit: int = DEFAULT_LIMIT,
    setup_redirect: str | None = None,
) -> AccountReport:
    """Sweep, then deliver up to `limit` due realm account deliveries, one at a time."""
    if connection.in_atomic_block:
        raise RuntimeError("the realm account run uses transactions of its own")
    report = AccountReport()
    _sweep()
    attempted: list[UUID] = []
    while len(attempted) < limit:
        found, claimed = _claim(attempted, origins_issuer, report)
        if not found:
            break
        if claimed is not None:
            _deliver(claimed, admin_factory, report, setup_redirect)
    return report


def _deliver(
    claimed: _Claimed,
    admin_factory: AdminFactory,
    report: AccountReport,
    setup_redirect: str | None = None,
) -> None:
    try:
        with admin_factory(RealmTarget(realm=claimed.realm)) as admin:
            user_id, mailed = ensure_account(admin, claimed.email, claimed.locale, setup_redirect)
    except _AccountRefusedError as refused:
        with transaction.atomic():
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="failed",
                action="outbox_delivery.failed",
                attempt=claimed.attempt,
                reason=refused.reason,
            )
        report.failed += 1
        logger.error("realm account %s: %s", claimed.delivery_id, refused.reason)
        return
    except _RedirectRefusedError:
        with transaction.atomic():
            # Like a refused credential: no budget is spent, and the next run tries again once the
            # realm lists the return address.
            _end(
                claimed.delivery_id,
                claimed.organisation_id,
                status="pending",
                action="outbox_delivery.deferred",
                attempt=claimed.attempt,
                reason="redirect_refused",
                http_status=400,
            )
        report.configuration += 1
        logger.error(
            "realm account %s: the realm refused the set-up return address", claimed.delivery_id
        )
        return
    except RealmCallError as error:
        with transaction.atomic():
            if error.kind in ("transport", "credential"):
                # Nothing reached the realm, or the credential is the operator's to fix: no
                # budget is spent and the next run tries again.
                _end(
                    claimed.delivery_id,
                    claimed.organisation_id,
                    status="pending",
                    action="outbox_delivery.deferred",
                    attempt=claimed.attempt,
                    reason=error.kind,
                    http_status=error.http_status,
                )
                if error.kind == "credential":
                    report.credential += 1
                    logger.error("realm account %s: credential refused", claimed.delivery_id)
                else:
                    report.deferred += 1
            elif error.kind == "permanent" or claimed.attempt >= MAX_ATTEMPTS:
                reason = "rejected" if error.kind == "permanent" else "attempts_exhausted"
                _end(
                    claimed.delivery_id,
                    claimed.organisation_id,
                    status="failed",
                    action="outbox_delivery.failed",
                    attempt=claimed.attempt,
                    reason=reason,
                    http_status=error.http_status,
                )
                report.failed += 1
                logger.error("realm account %s: %s", claimed.delivery_id, reason)
            else:
                _end(
                    claimed.delivery_id,
                    claimed.organisation_id,
                    status="pending",
                    action="outbox_delivery.deferred",
                    attempt=claimed.attempt,
                    reason=error.kind,
                    http_status=error.http_status,
                    retry_after_s=backoff_s(claimed.attempt),
                )
                report.deferred += 1
        return
    with transaction.atomic():
        _end(
            claimed.delivery_id,
            claimed.organisation_id,
            status="succeeded",
            action="outbox_delivery.sent",
            attempt=claimed.attempt,
            reason="mailed" if mailed else "account_ready",
            realm_user_id=user_id,
        )
    report.succeeded += 1
    report.mailed += int(mailed)
