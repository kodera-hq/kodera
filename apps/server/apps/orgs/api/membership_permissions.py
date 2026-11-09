"""Customer membership declarations; persisted role and grant enforced by the services."""

from core.api.scopes import Operation

LIST_MEMBERSHIPS = Operation(method="GET", operation_id="listMemberships", scope="membership:read")
GET_MEMBERSHIP = Operation(method="GET", operation_id="getMembership", scope="membership:read")
CHANGE_MEMBERSHIP_ROLE = Operation(
    method="PATCH", operation_id="changeMembershipRole", scope="membership:update"
)
REMOVE_MEMBERSHIP = Operation(
    method="DELETE", operation_id="removeMembership", scope="membership:delete"
)
