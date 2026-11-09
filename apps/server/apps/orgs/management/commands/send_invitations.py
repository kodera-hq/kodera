"""`manage.py send_invitations --once`: hand each owed invitation mail to the outbox
(docs/specs/INVITATIONS.md §4). `run_deliveries` sends it."""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.invitation_mail import InvitationMailUnavailableError, enqueue_invitation_mails
from apps.outbox.sender import SenderUnavailableError


class Command(BaseCommand):
    help = (
        "Enqueue the invitation mails owed by inviteToOrganisation and resendInvitation, once. "
        "Needs KODERA_INVITATION_LINK, KODERA_MAIL_LINK_ORIGINS, KODERA_CONTACT_SEAL_KEY "
        "and KODERA_OUTBOX_SEAL_KEY."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit")
        parser.add_argument("--limit", type=int, default=50)

    def handle(self, *args: Any, **options: Any) -> None:
        if not options["once"]:
            raise CommandError("send_invitations runs only with --once")
        if options["limit"] < 1:
            raise CommandError("--limit must be at least 1")
        try:
            report = enqueue_invitation_mails(limit=options["limit"])
        except (InvitationMailUnavailableError, SenderUnavailableError) as unavailable:
            raise CommandError(f"invitation mails refused: {unavailable}") from None
        self.stdout.write(
            f"invitations enqueued={len(report.enqueued)} skipped={len(report.skipped)}"
        )
        if report.skipped:
            raise CommandError(f"{len(report.skipped)} invitation mails could not be enqueued")
