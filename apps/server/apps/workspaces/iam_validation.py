"""Bounded capability vocabulary shared by storage and workspace administration."""

from django.core.exceptions import ValidationError

from .models import POLICY_CAPABILITIES

WORKSPACE_CAPABILITIES = (*POLICY_CAPABILITIES, "manage_roles", "view_audit_log")


def validate_permissions(value: object) -> None:
    if (
        not isinstance(value, list)
        or any(not isinstance(item, str) or item not in WORKSPACE_CAPABILITIES for item in value)
        or len(set(value)) != len(value)
    ):
        raise ValidationError("Permissions must be a unique list of workspace capabilities.")
