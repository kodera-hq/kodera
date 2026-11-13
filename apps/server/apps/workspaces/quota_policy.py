"""Supervised quota snapshots; only the operator profile imports this writer."""

from django.db import transaction

from apps.audit.models import AuditEvent
from apps.docs.errors import RefusalError
from apps.identity.selectors import current_staff_grant
from apps.identity.staff import is_staff_principal
from apps.identity.staff_roles import OPERATOR

from .models import Workspace, WorkspaceQuota


@transaction.atomic
def configure(*, principal, organisation_id, policy_ref, limits, snapshot_bytes):
    if not is_staff_principal(principal):
        raise RefusalError(403)
    grant = current_staff_grant(
        identity_id=principal.identity_id, role=OPERATOR, lock_principal=True
    )
    if grant is None:
        raise RefusalError(403)
    if (
        not isinstance(policy_ref, str)
        or not policy_ref.strip()
        or len(policy_ref) > 128
        or any(ord(c) < 32 for c in policy_ref)
        or not isinstance(limits, dict)
        or limits.keys() != {"seats", "mediaBytes", "pages"}
        or any(
            v is not None and (type(v) is not int or not 0 <= v <= 2**63 - 1)
            for v in limits.values()
        )
        or type(snapshot_bytes) is not int
        or not 1 <= snapshot_bytes <= 2097152
    ):
        raise RefusalError(422)
    workspace = (
        Workspace.objects.select_for_update().filter(organisation_id=organisation_id).first()
    )
    if workspace is None:
        raise RefusalError(404)
    row, _ = WorkspaceQuota.objects.update_or_create(
        workspace=workspace,
        defaults={
            "policy_ref": policy_ref,
            "seats": limits["seats"],
            "media_bytes": limits["mediaBytes"],
            "pages": limits["pages"],
            "snapshot_bytes": snapshot_bytes,
        },
    )
    AuditEvent.objects.create(
        action="workspace.quota.configured",
        actor_type="staff",
        actor_id=principal.identity_id,
        actor_label=f"urn:kodera:identity:{principal.identity_id}",
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:workspace-resource:{row.id}",
        retention_class="standard",
        metadata={"policy_ref": policy_ref},
    )
    return row
