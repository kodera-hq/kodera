"""Declared customer-only subset of the getMe contract; authority remains persisted."""

from core.api.scopes import Operation

SCOPE = "identity:read"
ROLES = ("org_owner", "org_admin", "org_billing", "org_member")
GET_ME = Operation(method="GET", operation_id="getMe", scope=SCOPE)
