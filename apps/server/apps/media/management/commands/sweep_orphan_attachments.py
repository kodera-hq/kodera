"""Bounded, resumable sweep of rowless S3 attachment orphans older than the 600s drain fence."""

import json
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = (
        "Delete rowless S3 attachment objects older than the presigned upload + stream drain fence."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--max-orgs", type=int, default=50)
        parser.add_argument("--max-pages", type=int, default=100)
        parser.add_argument("--max-deletes", type=int, default=100)
        parser.add_argument("--after-org", type=str, default=None)
        parser.add_argument("--continuation", type=str, default=None)
        parser.add_argument("--json", action="store_true", dest="json_output")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.media.services import sweep_orphan_attachments
        from apps.media.storage import StorageRefusedError

        try:
            report = sweep_orphan_attachments(
                max_orgs=options["max_orgs"],
                max_pages=options["max_pages"],
                max_deletes=options["max_deletes"],
                after_org=options["after_org"],
                continuation=options["continuation"],
            )
        except (ValueError, StorageRefusedError) as error:
            raise CommandError(str(error)) from None

        if options["json_output"]:
            self.stdout.write(json.dumps(report, sort_keys=True))
            return

        self.stdout.write(
            f"orphan attachment sweep deleted={report['deleted']} "
            f"organisations={report['organisationsScanned']} "
            f"pages={report['pagesScanned']} "
            f"inspected={report['objectsInspected']} "
            f"skipped_recent={report['skippedRecent']} "
            f"skipped_tracked={report['skippedTracked']} "
            f"has_more={str(report['hasMore']).lower()} "
            f"next_after_org={report['nextAfterOrg'] or '-'} "
            f"next_continuation={report['nextContinuation'] or '-'}"
        )
