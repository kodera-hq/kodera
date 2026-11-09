"""Issue a tenant agent's credential (ADR-0016) under a staff operator's authority.

The token is written once to `--token-file`, a new file created with mode 600, and never printed:
the one line on standard output names the organisation, the credential and the staff identity.
The file is refused if it exists already. Hand it to the tenant host as `KODERA_AGENT_TOKEN`, then
delete it.
"""

import os
from pathlib import Path
from typing import Any, NoReturn
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Issue a tenant agent's credential and write its token, once, to a new mode-600 file."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--staff-identity", type=UUID, required=True)
        parser.add_argument("--organisation", required=True, help="the organisation's slug")
        parser.add_argument("--tenant", type=UUID, help="the tenant the agent serves, if any")
        parser.add_argument("--token-file", type=Path, required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from apps.engine_intents.enrolment import EnrolmentRefusedError, enrol_agent
        from apps.orgs.realm_bootstrap import Refused, organisation_of, principal_for

        name = "enrol_tenant_agent"
        staff = options["staff_identity"]
        path: Path = options["token_file"]
        organisation_id = None
        try:
            principal = principal_for(staff)
            organisation = organisation_of(options["organisation"])
            organisation_id = organisation.id
            # Created before the credential exists, so an unwritable path writes nothing.
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except (Refused, EnrolmentRefusedError) as refusal:
            self._refused(name, organisation_id, staff, str(refusal))
        except OSError as error:
            reason = f"cannot create the token file: {error.strerror}"
            self._refused(name, organisation_id, staff, reason)
        try:
            # The token reaches the disk before the credential commits: a failed write leaves no
            # credential, and a failed commit leaves no file.
            with os.fdopen(descriptor, "w") as handle, transaction.atomic():
                credential_id, token = enrol_agent(
                    principal=principal,
                    organisation_id=organisation.id,
                    tenant_id=options["tenant"],
                )
                handle.write(token + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException as error:
            path.unlink(missing_ok=True)
            if isinstance(error, EnrolmentRefusedError):
                self._refused(name, organisation_id, staff, str(error))
            raise
        tenant = options["tenant"] or "-"
        self.stdout.write(
            f"{name} organisation={organisation_id} tenant={tenant} credential={credential_id} "
            f"staff_identity={staff} outcome=enrolled"
        )

    def _refused(self, name: str, organisation_id: object, staff: UUID, reason: str) -> NoReturn:
        self.stdout.write(
            f"{name} organisation={organisation_id or '-'} staff_identity={staff} outcome=refused"
        )
        raise CommandError(f"{reason}; nothing written")
