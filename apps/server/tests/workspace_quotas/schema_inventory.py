"""Exact objects removed when reversing the workspace quota migrations."""

TABLE = "workspaces_workspacequota"
FUNCTIONS = frozenset(
    {
        ("workspace_quota_usage", "p_workspace uuid"),
        ("workspace_quota_refuse", "p_key text, p_limit bigint, p_used bigint, p_requested bigint"),
        ("workspace_seed_quota", ""),
        ("workspace_resource_quota_guard", ""),
        ("workspace_seat_quota_guard", ""),
        ("workspace_snapshot_quota_guard", ""),
    }
)
TRIGGERS = frozenset(
    {
        ("workspaces_workspace", "workspace_seed_quota"),
        ("docs_document", "docs_page_quota"),
        ("media_attachment", "media_reservation_quota"),
        ("orgs_membership", "membership_seat_quota"),
        ("orgs_invitation", "invitation_seat_quota"),
        ("docs_documentsnapshot", "docs_snapshot_quota"),
        ("docs_documentupdate", "docs_update_quota"),
    }
)

CONSTRAINTS = frozenset(
    {
        ("orgs_membership", "membership_seat_quota"),
        ("orgs_invitation", "invitation_seat_quota"),
    }
)


def without_quotas(objects):
    functions = {("function", *value) for value in FUNCTIONS}
    triggers = {("trigger", *value) for value in TRIGGERS}
    constraints = {("constraint", *value) for value in CONSTRAINTS}
    assert ("relation", TABLE, TABLE) in objects, "workspace quota table is missing"
    assert functions <= objects.keys(), "workspace quota functions are missing"
    assert triggers <= objects.keys(), "workspace quota triggers are missing"
    assert constraints <= objects.keys(), "workspace quota constraint triggers are missing"
    return {
        key: value
        for key, value in objects.items()
        if key[1] != TABLE
        and key not in functions
        and key not in triggers
        and key not in constraints
    }
