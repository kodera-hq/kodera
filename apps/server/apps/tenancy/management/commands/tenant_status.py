"""List tenants, or move one along the pilot's operator override (QUICK_WORKSPACE.md §5).

    manage.py tenant_status list [--state S]
    manage.py tenant_status set --staff-identity <id> --tenant <id> \\
        --to provisioning|active|failed|deleted --reason <text>

`list` prints one line per tenant: `id slug organisation status apps created_at`. `set` needs a
current `staff_operator` grant; it prints one line naming the tenant, the statuses it passed
through and the staff identity, or refuses with the reason and writes nothing.
"""

from typing import Any, NoReturn
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile

NAME = "tenant_status"


class Command(BaseCommand):
    help = "List tenants, or move one along the pilot's operator override, with a reason."

    def add_arguments(self, parser: CommandParser) -> None:
        actions = parser.add_subparsers(dest="action", required=True)
        listing = actions.add_parser("list", help="print every tenant, or those in one state")
        listing.add_argument("--state")
        setting = actions.add_parser("set", help="move one tenant, with a reason")
        setting.add_argument("--staff-identity", type=UUID, required=True)
        setting.add_argument("--tenant", type=UUID, required=True)
        setting.add_argument(
            "--to", required=True, choices=("provisioning", "active", "failed", "deleted")
        )
        setting.add_argument("--reason", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        if options["action"] == "list":
            self._list(options["state"])
        else:
            self._set(options)

    def _list(self, state: str | None) -> None:
        from apps.tenancy.operator_status import StatusRefusedError, list_tenants

        try:
            listed = list_tenants(state=state)
        except StatusRefusedError as refusal:
            raise CommandError(str(refusal)) from None
        for row in listed:
            self.stdout.write(
                f"{row.id} {row.slug} {row.organisation} {row.status} "
                f"{','.join(row.apps) or '-'} {row.created_at.isoformat()}"
            )

    def _set(self, options: dict[str, Any]) -> None:
        from apps.orgs.realm_bootstrap import Refused, principal_for
        from apps.tenancy.operator_status import StatusRefusedError, set_status

        staff: UUID = options["staff_identity"]
        tenant: UUID = options["tenant"]
        try:
            principal = principal_for(staff)
            passed = set_status(
                principal=principal, tenant_id=tenant, to=options["to"], reason=options["reason"]
            )
        except (Refused, StatusRefusedError) as refusal:
            self._refused(tenant, staff, str(refusal).removesuffix("; nothing written"))
        self.stdout.write(
            f"{NAME} tenant={tenant} to={'>'.join(passed)} staff_identity={staff} outcome=moved"
        )

    def _refused(self, tenant: UUID, staff: UUID, reason: str) -> NoReturn:
        self.stdout.write(f"{NAME} tenant={tenant} staff_identity={staff} outcome=refused")
        raise CommandError(f"{reason}; nothing written")
