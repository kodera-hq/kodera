"""Serialized workspace role administration with strict hierarchy and tenant fences."""

from typing import Any
from uuid import UUID

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count, Q

from apps.orgs.actor_selectors import TenantCaller
from services.identity.access_tokens import VerifiedAccessToken

from .iam_validation import validate_permissions
from .models import Workspace, WorkspaceMemberRole, WorkspaceRole
from .moderation import ADMINS, RefusalError, _audit, _context, _target, _text
from .selectors import lock_workspace

ROLE_FIELDS = {
    "name",
    "slug",
    "kind",
    "color",
    "icon",
    "position",
    "is_hoisted",
    "is_mentionable",
    "permissions",
}


def capabilities(workspace: Workspace, caller: TenantCaller) -> set[str]:
    values = WorkspaceMemberRole.objects.filter(
        workspace=workspace, membership_id=caller.membership_id
    ).values_list("role__permissions", flat=True)
    return {permission for permissions in values for permission in permissions}


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID, capability: str | None = None):
    workspace, caller = _context(verified, organisation_id, lock=False)
    if (
        capability
        and caller.role not in ADMINS
        and capability not in capabilities(workspace, caller)
    ):
        raise RefusalError(403)
    return workspace, caller


def mutation_context(
    verified: VerifiedAccessToken, organisation_id: UUID, capability: str | None = None
):
    workspace, _ = authorize(verified, organisation_id, capability)
    lock_workspace(workspace_id=workspace.id)
    return authorize(verified, organisation_id, capability)


def check_manage(
    workspace: Workspace,
    caller: TenantCaller,
    roles: list[WorkspaceRole],
    *,
    position: int | None = None,
    permissions: list[str] | None = None,
) -> None:
    if caller.role == "org_owner":
        return
    own = WorkspaceRole.objects.filter(
        workspace=workspace, workspacememberrole__membership_id=caller.membership_id
    )
    highest = own.order_by("-position").values_list("position", flat=True).first()
    if (
        highest is None
        or any(role.position >= highest for role in roles)
        or (position is not None and position >= highest)
    ):
        raise RefusalError(403)
    granted = capabilities(workspace, caller)
    if caller.role not in ADMINS:
        if "manage_roles" not in granted:
            raise RefusalError(403)
        if permissions is not None and not set(permissions) <= granted:
            raise RefusalError(403)
        if any(not set(role.permissions) <= granted for role in roles):
            raise RefusalError(403)


def resolve_roles(workspace: Workspace, value: Any) -> list[WorkspaceRole]:
    if not isinstance(value, list) or len(value) > 100:
        raise RefusalError(422)
    try:
        ids = [UUID(item) for item in value if isinstance(item, str)]
    except ValueError:
        raise RefusalError(422) from None
    if len(ids) != len(value) or len(set(ids)) != len(ids):
        raise RefusalError(422)
    roles = list(WorkspaceRole.objects.filter(workspace=workspace, id__in=ids).order_by("id"))
    if len(roles) != len(ids):
        raise RefusalError(404)
    return roles


def role_wire(role: WorkspaceRole, member_count: int = 0) -> dict[str, Any]:
    return {
        "id": str(role.id),
        "workspace_id": str(role.workspace_id),
        "organisation_id": str(role.organisation_id),
        **{field: getattr(role, field) for field in sorted(ROLE_FIELDS)},
        "created_at": role.created_at.isoformat(),
        "updated_at": role.updated_at.isoformat(),
        "member_count": member_count,
    }


def _validate(role: WorkspaceRole) -> None:
    _text(role.name, 100)
    if type(role.position) is not int or not 0 <= role.position <= 2147483647:
        raise RefusalError(422)
    if type(role.is_hoisted) is not bool or type(role.is_mentionable) is not bool:
        raise RefusalError(422)
    if any(not isinstance(getattr(role, key), str) for key in ("slug", "color", "kind", "icon")):
        raise RefusalError(422)
    if role.icon:
        _text(role.icon, 32)
    try:
        validate_permissions(role.permissions)
        role.full_clean(validate_unique=False)
    except (ValidationError, TypeError, ValueError):
        raise RefusalError(422) from None


@transaction.atomic
def list_roles(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    workspace, _ = authorize(verified, organisation_id)
    roles = (
        WorkspaceRole.objects.filter(workspace=workspace)
        .annotate(
            members=Count(
                "workspacememberrole",
                filter=Q(
                    workspacememberrole__membership__state="active",
                    workspacememberrole__membership__deleted_at__isnull=True,
                    workspacememberrole__membership__accepted_at__isnull=False,
                ),
            )
        )
        .order_by("-position", "id")
    )
    assignments: dict[str, list[str]] = {}
    for member_id, role_id in (
        WorkspaceMemberRole.objects.filter(
            workspace=workspace,
            membership__state="active",
            membership__deleted_at__isnull=True,
            membership__accepted_at__isnull=False,
        )
        .order_by("membership_id", "role_id")
        .values_list("membership_id", "role_id")
    ):
        assignments.setdefault(str(member_id), []).append(str(role_id))
    return {
        "data": [role_wire(role, role.members) for role in roles],
        "assignments": [
            {"membership_id": member_id, "role_ids": ids} for member_id, ids in assignments.items()
        ],
    }


@transaction.atomic
def create_role(
    *, verified: VerifiedAccessToken, organisation_id: UUID, data: dict[str, Any], request_id: str
) -> dict[str, Any]:
    workspace, caller = mutation_context(verified, organisation_id, "manage_roles")
    if not {"name", "slug"} <= data.keys() or data.keys() - ROLE_FIELDS:
        raise RefusalError(422)
    role = WorkspaceRole(workspace=workspace, organisation_id=organisation_id, **data)
    _validate(role)
    check_manage(workspace, caller, [], position=role.position, permissions=role.permissions)
    role.save(force_insert=True)
    _audit(workspace, caller.identity_id, "workspace.role.created", role.id, request_id)
    return role_wire(role)


@transaction.atomic
def update_role(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    role_id: UUID,
    data: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    workspace, caller = mutation_context(verified, organisation_id, "manage_roles")
    role = WorkspaceRole.objects.filter(workspace=workspace, id=role_id).first()
    if role is None:
        raise RefusalError(404)
    if not data or data.keys() - ROLE_FIELDS:
        raise RefusalError(422)
    check_manage(workspace, caller, [role])
    for field, value in data.items():
        setattr(role, field, value)
    _validate(role)
    check_manage(workspace, caller, [], position=role.position, permissions=role.permissions)
    role.save(update_fields=[*data, "updated_at"])
    _audit(workspace, caller.identity_id, "workspace.role.updated", role.id, request_id)
    return role_wire(role, WorkspaceMemberRole.objects.filter(role=role).count())


@transaction.atomic
def delete_role(
    *, verified: VerifiedAccessToken, organisation_id: UUID, role_id: UUID, request_id: str
) -> None:
    from .models import WorkspaceInviteLink

    workspace, caller = mutation_context(verified, organisation_id, "manage_roles")
    role = WorkspaceRole.objects.filter(workspace=workspace, id=role_id).first()
    if role is None:
        raise RefusalError(404)
    check_manage(workspace, caller, [role])
    for link in WorkspaceInviteLink.objects.filter(
        workspace=workspace, auto_role_ids__contains=[str(role.id)]
    ):
        link.auto_role_ids = [value for value in link.auto_role_ids if value != str(role.id)]
        link.save(update_fields=["auto_role_ids", "updated_at"])
    role.delete()
    _audit(workspace, caller.identity_id, "workspace.role.deleted", role_id, request_id)


@transaction.atomic
def assign_roles(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    membership_id: UUID,
    role_ids: Any,
    request_id: str,
) -> dict[str, Any]:
    workspace, caller = mutation_context(verified, organisation_id, "manage_roles")
    target = _target(workspace, membership_id)
    roles = resolve_roles(workspace, role_ids)
    current = list(
        WorkspaceRole.objects.filter(
            workspace=workspace, workspacememberrole__membership_id=target.id
        )
    )
    if caller.role != "org_owner" and (target.role in ADMINS or target.id == caller.membership_id):
        raise RefusalError(403)
    check_manage(workspace, caller, [*current, *roles])
    WorkspaceMemberRole.objects.filter(workspace=workspace, membership_id=target.id).delete()
    WorkspaceMemberRole.objects.bulk_create(
        [
            WorkspaceMemberRole(workspace=workspace, membership_id=target.id, role=role)
            for role in roles
        ]
    )
    _audit(workspace, caller.identity_id, "workspace.member.roles_updated", target.id, request_id)
    return {"membership_id": str(target.id), "role_ids": [str(role.id) for role in roles]}
