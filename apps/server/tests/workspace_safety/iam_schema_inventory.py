"""Exact additive objects owned by the granular workspace administration migrations."""

TABLES = frozenset(
    {
        "workspaces_workspacerole",
        "workspaces_workspacememberrole",
        "workspaces_workspacechannelroleoverride",
    }
)
FUNCTIONS = frozenset(
    {
        ("workspace_iam_permissions", "value jsonb"),
        ("workspace_iam_scope", ""),
        ("workspace_iam_cutoff_guard", ""),
        ("workspace_iam_erasure_hook", ""),
        ("workspace_iam_profile_guard", ""),
        ("workspace_iam_invite_guard", ""),
    }
)
SHARED = frozenset(
    {
        *(
            ("column", "workspaces_workspace", field)
            for field in (
                "description",
                "banner_preset",
                "icon_mxc",
                "traits",
                "arrivals_channel_id",
                "rules_channel_id",
                "moderator_updates_channel_id",
                "security_alerts_channel_id",
                "invites_paused",
            )
        ),
        ("column", "workspaces_workspaceinvitelink", "auto_role_ids"),
        ("column", "workspaces_workspaceinvitelink", "created_by_id"),
        (
            "constraint",
            "workspaces_workspaceinvitelink",
            "workspaces_workspace_created_by_id_bf7e7378_fk_orgs_memb",
        ),
        (
            "index",
            "workspaces_workspaceinvitelink",
            "workspaces_workspaceinvitelink_created_by_id_bf7e7378",
        ),
        ("trigger", "workspaces_workspace", "workspace_iam_profile_guard"),
        ("trigger", "workspaces_workspaceinvitelink", "workspace_iam_invite_guard"),
        ("trigger", "orgs_privacyerasure", "aa_03_workspace_iam_erasure"),
        *(("trigger", table, "aa_privacy_cutoff") for table in TABLES),
    }
)


UX_OBJECTS = frozenset(
    {
        *(
            ("column", "workspaces_workspace", name)
            for name in (
                "display_name",
                "logo_url",
                "default_ui_mode",
                "default_channel_id",
                "allow_member_channel_creation",
                "allow_member_invites",
                "allow_link_previews",
            )
        ),
        ("function", "workspace_ux_guard", ""),
        ("trigger", "workspaces_workspace", "workspace_ux_guard"),
    }
)


def without_iam(objects):
    if ("column", "workspaces_workspace", "display_name") in objects:
        assert UX_OBJECTS <= objects.keys(), "workspace identity and UX inventory is incomplete"
        objects = {key: value for key, value in objects.items() if key not in UX_OBJECTS}
    # Historical lifecycle targets intentionally predate IAM. A partial current schema fails.
    present = any(key[1] in TABLES or key in SHARED for key in objects)
    if not present:
        return objects
    required = (
        SHARED
        | {("function", *item) for item in FUNCTIONS}
        | {("relation", table, table) for table in TABLES}
    )
    assert required <= objects.keys(), "granular workspace administration inventory is incomplete"
    return {
        key: value for key, value in objects.items() if key[1] not in TABLES and key not in required
    }


CONFIDENTIAL_OBJECTS = frozenset(
    {
        ("column", "workspaces_channel", "is_confidential"),
        ("constraint", "workspaces_channel", "channel_confidential_text_only"),
        ("trigger", "workspaces_channel", "channel_confidential_immutable"),
        ("function", "workspace_channel_confidential_immutable", ""),
    }
)


def without_confidential(objects):
    if ("column", "workspaces_channel", "is_confidential") not in objects:
        return objects
    assert CONFIDENTIAL_OBJECTS <= objects.keys(), (
        "confidential channel designation inventory is incomplete"
    )
    return {key: value for key, value in objects.items() if key not in CONFIDENTIAL_OBJECTS}
