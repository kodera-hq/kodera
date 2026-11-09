"""A tenant agent's credential, issued and revoked by a staff operator's command (ADR-0016).

`issue_credential` and `revoke_credential` hold the credential itself; this module is the product
path that reaches them: the acting staff identity must hold a current `staff_operator` grant, a
tenant named must be the organisation's own and not deleted, and each change writes its `agent.*`
audit row in its transaction. The token is returned to the caller once and stored nowhere but as
its secret's digest.

Not in the API image: `.dockerignore` admits no line that names it. The commands that call it run
from the operator image.
"""

from __future__ import annotations

from uuid import UUID

from django.db import transaction

from apps.audit.services import record_agent_credential_event
from apps.identity.selectors import current_staff_grant
from apps.identity.staff import StaffPrincipal
from apps.tenancy.services import tenant_status_of

from .models import EngineAgentCredential
from .services import issue_credential, revoke_credential

OPERATOR = "staff_operator"


class EnrolmentRefusedError(Exception):
    """A refusal that wrote nothing; its message names the reason, never a token."""


def _require_operator(principal: StaffPrincipal) -> None:
    # Locked, so a revocation of the grant cannot commit between this read and the change.
    grant = current_staff_grant(
        identity_id=principal.identity_id, role=OPERATOR, lock_principal=True
    )
    if grant is None:
        raise EnrolmentRefusedError("the staff identity holds no current staff_operator grant")


def enrol_agent(
    *, principal: StaffPrincipal, organisation_id: UUID, tenant_id: UUID | None
) -> tuple[UUID, str]:
    """A new credential for the organisation's tenant agent: (credential id, `eac1_…` token)."""
    with transaction.atomic():
        _require_operator(principal)
        if tenant_id is not None:
            status = tenant_status_of(organisation_id=organisation_id, tenant_id=tenant_id)
            if status is None:
                raise EnrolmentRefusedError("the organisation has no tenant with that id")
            if status == "deleted":
                raise EnrolmentRefusedError("the tenant is deleted")
        credential_id, token = issue_credential(
            organisation_id=organisation_id, tenant_ref=tenant_id
        )
        record_agent_credential_event(
            action="agent.enrolled",
            credential_id=credential_id,
            organisation_id=organisation_id,
            actor_id=principal.identity_id,
            tenant_id=tenant_id,
        )
    return credential_id, token


def revoke_agent(*, principal: StaffPrincipal, organisation_id: UUID, credential_id: UUID) -> None:
    """Revoke one of the organisation's active agent credentials; its pending commands end."""
    with transaction.atomic():
        _require_operator(principal)
        credential = (
            EngineAgentCredential.objects.select_for_update()
            .filter(id=credential_id, organisation_id=organisation_id)
            .first()
        )
        if credential is None:
            raise EnrolmentRefusedError("the organisation has no agent credential with that id")
        if credential.state != "active":
            raise EnrolmentRefusedError("the agent credential is not active")
        revoke_credential(credential_id=credential_id)
        record_agent_credential_event(
            action="agent.revoked",
            credential_id=credential_id,
            organisation_id=organisation_id,
            actor_id=principal.identity_id,
            tenant_id=credential.tenant_ref,
        )
