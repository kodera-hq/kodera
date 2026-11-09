"""The invitation mail: docs/specs/INVITATIONS.md §4.

The API process holds no outbox seal key, so it only records that a mail is owed (`sent_count`
ahead of `mail_enqueued_count`). This run, in the operator profile, opens the token sealed under
the contact seal key and hands the `invitation` template to the outbox in one transaction per
invitation; `run_deliveries` sends it. A resend owes one more mail with the same token.

A mail waits for the invitation's latest realm account delivery to succeed, because only its
outcome says whether the realm mailed a set-up link: `invitation` announces that mail, and
`invitation_account_ready`, for an account already set up, announces none. The realm run comes
first in each operator pass, so the wait is normally none.

Nothing is enqueued where it could not be sent: without the link, the keys or the sender's
settings, the run refuses as a whole. It prints counts, never an address or a token.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction

from apps.outbox.mail.dates import mail_instant
from apps.outbox.sender import MessageRefusedError, SenderUnavailableError, enqueue_message
from core.sealing import SealError, unseal

from .claim_configuration import ClaimConfigurationError, claim_link, organisation_claim_link
from .invitations import format_token, seal_context
from .models import Invitation, Organisation

LOG = logging.getLogger(__name__)
TEMPLATE = "invitation"
TEMPLATE_ACCOUNT_READY = "invitation_account_ready"
# The outbox keeps a message at most seven days; a resend enqueues a fresh one.
LIFETIME = timedelta(days=6)
ROLE_LABELS = {
    "fr": {
        "org_admin": "administrateur",
        "org_billing": "responsable de la facturation",
        "org_member": "membre",
    },
    "en": {"org_admin": "administrator", "org_billing": "billing contact", "org_member": "member"},
}


class InvitationMailUnavailableError(Exception):
    """This deployment cannot mail an invitation: nothing is enqueued."""


@dataclass
class InvitationMailReport:
    enqueued: list[UUID] = field(default_factory=list)
    skipped: list[UUID] = field(default_factory=list)


def _origins() -> frozenset[str]:
    origins: frozenset[str] = getattr(settings, "KODERA_MAIL_LINK_ORIGINS", frozenset())
    return origins


def invitation_link() -> str:
    """The Console's acceptance page, on an origin the outbox may link to."""
    raw = getattr(settings, "KODERA_INVITATION_LINK", None) or ""
    try:
        return claim_link({"KODERA_OWNER_CLAIM_LINK": raw}, _origins())
    except ClaimConfigurationError:
        raise InvitationMailUnavailableError(
            "KODERA_INVITATION_LINK is not a link on KODERA_MAIL_LINK_ORIGINS"
        ) from None


def organisation_invitation_link(base: str, organisation: Organisation) -> str:
    """`<base>/<organisation id>/<slug>`, like the owner claim link: the Console discovers the
    organisation's realm from it before sign-in. The outbox appends the token as the fragment."""
    return organisation_claim_link(
        {"KODERA_OWNER_CLAIM_LINK": base},
        _origins(),
        organisation_id=organisation.id,
        slug=organisation.slug,
    )


# Why an invitation's latest realm account delivery last ended: only a success records `mailed`
# (the realm mailed a set-up link) or `account_ready` (the account was set up already).
_LATEST_OUTCOME = """
SELECT a.last_reason FROM outbox_realmaccount a
JOIN outbox_outboxdelivery d ON d.id = a.delivery_id
WHERE a.invitation_id = %s
ORDER BY d.created_at DESC, d.id DESC LIMIT 1
"""
TEMPLATE_FOR_OUTCOME = {"mailed": TEMPLATE, "account_ready": TEMPLATE_ACCOUNT_READY}
# The same latest outcome, for each invitation owed a mail.
_OWED = """
SELECT i.id FROM orgs_invitation i
WHERE i.state = 'pending' AND i.expires_at > clock_timestamp()
  AND i.sent_count > i.mail_enqueued_count
  AND (
    SELECT a.last_reason FROM outbox_realmaccount a
    JOIN outbox_outboxdelivery d ON d.id = a.delivery_id
    WHERE a.invitation_id = i.id
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1
  ) IN ('mailed', 'account_ready')
ORDER BY i.id LIMIT %s
"""


def _owed(limit: int) -> list[UUID]:
    """Mails owed whose account delivery has succeeded: one still waiting is left out here, so a
    realm that is down cannot fill the batch and hold back every other invitation."""
    with connection.cursor() as cursor:
        cursor.execute(_OWED, [limit])
        return [row[0] for row in cursor.fetchall()]


def _template(invitation_id: UUID) -> str | None:
    """The template the latest account delivery's outcome calls for, or None while it has not
    succeeded."""
    with connection.cursor() as cursor:
        cursor.execute(_LATEST_OUTCOME, [invitation_id])
        row = cursor.fetchone()
    return None if row is None else TEMPLATE_FOR_OUTCOME.get(row[0])


def _now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def enqueue_invitation_mails(*, limit: int = 50) -> InvitationMailReport:
    """One `invitation` message for each mail owed, each in a transaction of its own."""
    if connection.in_atomic_block:
        raise RuntimeError("the invitation mail run uses transactions of its own")
    link = invitation_link()
    key = getattr(settings, "KODERA_CONTACT_SEAL_KEY", None)
    if not isinstance(key, bytes):
        raise InvitationMailUnavailableError("no contact seal key: KODERA_CONTACT_SEAL_KEY")
    report = InvitationMailReport()
    for invitation_id in _owed(limit):
        try:
            with transaction.atomic():
                invitation = (
                    Invitation.objects.select_for_update(skip_locked=True)
                    .filter(id=invitation_id, state="pending")
                    .first()
                )
                now = _now()
                if (
                    invitation is None
                    or invitation.expires_at <= now
                    or invitation.sent_count <= invitation.mail_enqueued_count
                ):
                    continue
                # Read under the invitation's lock: a resend, which writes a new account delivery,
                # takes the same lock.
                template = _template(invitation.id)
                if template is None:
                    continue
                secret = unseal(key, seal_context(invitation.id), bytes(invitation.token_sealed))
                organisation = Organisation.objects.get(id=invitation.organisation_id)
                locale = invitation.locale
                enqueue_message(
                    organisation_id=invitation.organisation_id,
                    template_id=template,
                    locale=locale,
                    recipient=invitation.email,
                    params={
                        "organisation_name": organisation.name,
                        "role": ROLE_LABELS[locale][invitation.role],
                        "expires_at": mail_instant(invitation.expires_at, locale),
                    },
                    expires_at=min(invitation.expires_at, now + LIFETIME),
                    link=organisation_invitation_link(link, organisation),
                    link_secret=format_token(invitation.id, secret.decode("ascii")),
                )
                Invitation.objects.filter(id=invitation.id).update(
                    mail_enqueued_count=invitation.sent_count, updated_at=now
                )
            report.enqueued.append(invitation_id)
        except SenderUnavailableError:
            raise
        except (
            SealError,
            MessageRefusedError,
            UnicodeDecodeError,
            ClaimConfigurationError,
        ) as refused:
            # The invitation stays owed and is reported; the error names its class only.
            LOG.error("invitation %s mail refused: %s", invitation_id, type(refused).__name__)
            report.skipped.append(invitation_id)
    return report
