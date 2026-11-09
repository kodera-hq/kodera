"""Settle an organisation's order in flight as complimentary, under a staff operator's authority.

apps/billing/complimentary.py: the unpaid invoice is credited in full, the order becomes `paid`,
audited as `order.complimentary` with the operator and the reason. It prints the order's tenant
(slug, realm and each application's host) to be checked against the tenant's Fleet record.
"""

from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.billing.switch import billing_enabled
from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Settle an organisation's order in flight as complimentary: no charge, its invoice credited."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--organisation", required=True, help="the organisation's slug")
        parser.add_argument("--order", type=UUID, required=True)
        parser.add_argument("--reason", required=True, help="why it is complimentary, audited")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        if not billing_enabled():
            # QUICK_WORKSPACE.md §2.2: a deployment that does not bill settles nothing.
            raise CommandError("billing is disabled on this deployment; nothing written")
        if not getattr(settings, "KODERA_INVOICE_SERIES", None):
            raise CommandError(
                "KODERA_INVOICE_SERIES is not set: the credit note is numbered in the API's "
                "invoice series, so give the API's value; nothing written"
            )
        from apps.billing.complimentary import ComplimentaryRefusedError, settle_complimentary
        from apps.orgs.realm_bootstrap import Refused, organisation_of, principal_for

        name = "settle_complimentary_order"
        staff = options["staff_identity"]
        organisation_id = None
        try:
            principal = principal_for(staff)
            organisation = organisation_of(options["organisation"])
            organisation_id = organisation.id
            settled = settle_complimentary(
                principal=principal,
                organisation_id=organisation.id,
                order_id=options["order"],
                reason=options["reason"],
            )
        except (Refused, ComplimentaryRefusedError) as refusal:
            self.stdout.write(
                f"{name} organisation={organisation_id or '-'} staff_identity={staff} "
                "outcome=refused"
            )
            raise CommandError(f"{refusal}; nothing written") from None
        self.stdout.write(
            f"{name} organisation={organisation_id} order={options['order']} "
            f"credit_note={settled.credit_note.number} subscription={settled.subscription} "
            f"staff_identity={staff} outcome=complimentary"
        )
        self.stdout.write(tenant_line(organisation.id, settled.tenant_id))


def tenant_line(organisation_id: UUID, tenant_id: UUID | None) -> str:
    """`tenant=… slug=… realm=… host.<app>=…`, one host per application with a URL."""
    from apps.tenancy.selectors import default_urls, tenant_of

    row = (
        None
        if tenant_id is None
        else tenant_of(organisation_id=organisation_id, tenant_id=tenant_id)
    )
    if row is None:
        return "tenant=-"
    hosts = " ".join(
        f"host.{app}={urlsplit(url).hostname}" for app, url in sorted(default_urls(row).items())
    )
    return f"tenant={row.id} slug={row.slug} realm={row.realm or '-'} {hosts or 'host=-'}"
