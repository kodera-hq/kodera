"""The objects owned by workspace moderation migrations, separate from the older baseline."""

TABLES = frozenset(
    {
        "workspaces_workspacemoderator",
        "workspaces_workspacememberrestriction",
        "workspaces_workspaceinvitelink",
        "workspaces_workspaceinviteredemption",
        "workspaces_workspaceabusereport",
    }
)
FUNCTIONS = frozenset(
    {
        "workspace_moderation_member_scope",
        "workspace_invite_scope",
        "workspace_redemption_scope",
    }
)


def without_moderation(objects):
    # Exact ownership: changes to any older table/function remain in the comparison.
    if not all(("relation", table, table) in objects for table in TABLES):
        raise AssertionError("moderation tables are missing from the current schema")
    if not all(("function", name, "") in objects for name in FUNCTIONS):
        raise AssertionError("moderation scope functions are missing from the current schema")
    return {
        key: value
        for key, value in objects.items()
        if key[1] not in TABLES and not (key[0] == "function" and key[1] in FUNCTIONS)
    }
