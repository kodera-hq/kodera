"""`manage.py triage_support_tickets`: classify open support tickets, deduplicate by fingerprint,
and emit sanitized zero-PII engineering issue payloads."""

import json
import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.support.models import SupportTicket
from apps.support.triage import (
    TicketTriageInput,
    build_sanitized_github_issue,
    classify_support_ticket,
    compute_dedup_fingerprint,
    redact_pii,
)


def run_triage_selftest() -> dict[str, Any]:
    """Run an in-memory self-test of classification, deduplication, and PII redaction."""
    org_id = uuid.UUID("018f1234-5678-7000-8000-000000000001")
    ticket_a = TicketTriageInput(
        ticket_id=uuid.UUID("018f1234-5678-7000-8000-000000000010"),
        organisation_id=org_id,
        category="calls",
        severity="outage",
        subject="Coupure LiveKit & Matrix sur plateau #42 (alice@production.fr)",
        body=(
            "Camille Test, téléphone +33 6 00 00 00 01, poste 2001:db8::72, tenant atelier-test. "
            "Contact: alice@production.fr / IP 192.168.10.45 / "
            "org 018f1234-5678-7000-8000-000000000001 / "
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        ),
        tenant_slug="atelier-test",
        reply_to_email="alice@production.fr",
        contact_email="regie@production.fr",
    )
    ticket_b = TicketTriageInput(
        ticket_id=uuid.UUID("018f1234-5678-7000-8000-000000000011"),
        organisation_id=org_id,
        category="calls",
        severity="outage",
        subject="Coupure LiveKit & Matrix sur plateau #99 (bob@production.fr)",
        body="Même incident observé en salle montage.",
    )

    verdict_a = classify_support_ticket(ticket_a)
    verdict_b = classify_support_ticket(ticket_b)
    if verdict_a.priority != "P0" or verdict_a.queue != "infra-sre":
        raise CommandError(f"selftest classification failed: {verdict_a}")
    if verdict_a.dedup_fingerprint != verdict_b.dedup_fingerprint:
        raise CommandError("selftest deduplication failed on identical normalized subjects")

    issue = build_sanitized_github_issue(ticket_a, verdict_a)
    combined_issue = f"{issue['title']}\n{issue['body']}"
    for forbidden in (
        "Camille Test",
        "+33 6 00 00 00 01",
        "2001:db8::72",
        "atelier-test",
        "alice@production.fr",
        "regie@production.fr",
        "192.168.10.45",
        str(org_id),
        "eyJhbGciOiJIUzI1NiJ9",
    ):
        if forbidden in combined_issue:
            raise CommandError(f"selftest PII redaction leaked '{forbidden}'")

    # Self-test mutation check: verify that unredacted PII is caught by the detector.
    unredacted_probe = "Leak probe alice@production.fr"
    if "alice@production.fr" in redact_pii(unredacted_probe):
        raise CommandError("selftest redaction probe failed")

    return {
        "status": "ok",
        "priority": verdict_a.priority,
        "queue": verdict_a.queue,
        "fingerprint": verdict_a.dedup_fingerprint,
        "redacted_verified": True,
    }


class Command(BaseCommand):
    help = (
        "Classify open support tickets, deduplicate recurring incidents per organisation, "
        "and build zero-PII engineering issue payloads."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--selftest",
            action="store_true",
            help="Run in-memory classification, deduplication, and PII-redaction self-tests without touching the DB.",
        )
        parser.add_argument("--limit", type=int, default=50)
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit triage results as JSON.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if not 1 <= options["limit"] <= 500:
            raise CommandError("--limit must be 1 to 500")

        if options["selftest"]:
            result = run_triage_selftest()
            if options["json"]:
                self.stdout.write(json.dumps(result, sort_keys=True))
            else:
                self.stdout.write(
                    f"selftest=ok priority={result['priority']} queue={result['queue']} "
                    f"fingerprint={result['fingerprint']}"
                )
            return

        tickets = list(
            SupportTicket.objects.filter(state="open", content_erased_at__isnull=True).order_by(
                "created_at"
            )[: options["limit"]]
        )
        seen_fingerprints: set[str] = set()
        issues: list[dict[str, Any]] = []
        duplicates = 0

        for ticket in tickets:
            verdict = classify_support_ticket(ticket)
            if verdict.dedup_fingerprint in seen_fingerprints:
                duplicates += 1
                continue
            seen_fingerprints.add(verdict.dedup_fingerprint)
            issues.append(build_sanitized_github_issue(ticket, verdict))

        summary = {
            "processed": len(tickets),
            "unique_issues": len(issues),
            "duplicates_skipped": duplicates,
            "issues": issues,
        }
        if options["json"]:
            self.stdout.write(json.dumps(summary, sort_keys=True))
        else:
            self.stdout.write(
                f"processed={summary['processed']} unique_issues={summary['unique_issues']} "
                f"duplicates_skipped={summary['duplicates_skipped']}"
            )


__all__ = ["Command", "compute_dedup_fingerprint", "run_triage_selftest"]
