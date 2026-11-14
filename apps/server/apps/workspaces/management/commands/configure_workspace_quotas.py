"""Apply an explicit resource policy, never derive limits from capacity sizing guides."""

from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from apps.orgs.management.operator import require_operator_profile


def ceiling(raw):
    if raw == "unlimited":
        return None
    try:
        value = int(raw)
    except (ValueError, TypeError):
        raise ValueError("quota must be a nonnegative integer or unlimited") from None
    if str(value) != raw or not 0 <= value <= 2**63 - 1:
        raise ValueError("quota must be a nonnegative integer or unlimited")
    return value


class Command(BaseCommand):
    help = "Apply an audited, explicit workspace quota policy as a staff operator"

    def add_arguments(self, parser):
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--organisation", type=UUID, required=True)
        parser.add_argument("--policy-ref", required=True)
        parser.add_argument("--seats", required=True)
        parser.add_argument("--media-bytes", required=True)
        parser.add_argument("--pages", required=True)
        parser.add_argument("--snapshot-bytes", type=int, required=True)

    def handle(self, *args, **options):
        require_operator_profile()
        from apps.docs.errors import RefusalError
        from apps.orgs.realm_bootstrap import Refused, principal_for
        from apps.workspaces.quota_policy import configure

        try:
            configure(
                principal=principal_for(options["staff_identity"]),
                organisation_id=options["organisation"],
                policy_ref=options["policy_ref"],
                limits={
                    "seats": ceiling(options["seats"]),
                    "mediaBytes": ceiling(options["media_bytes"]),
                    "pages": ceiling(options["pages"]),
                },
                snapshot_bytes=options["snapshot_bytes"],
            )
        except (ValueError, Refused, RefusalError):
            raise CommandError("workspace quota policy refused; nothing written") from None
        self.stdout.write("Workspace quota policy configured")
