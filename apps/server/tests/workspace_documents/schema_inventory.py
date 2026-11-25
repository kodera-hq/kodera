"""The objects owned by workspace document migrations, separate from the older baseline."""

TABLES = frozenset(
    {
        "docs_document",
        "docs_documentgrant",
        "docs_documentlink",
        "docs_documentsnapshot",
        "docs_documentupdate",
        "docs_collaborationticket",
        "docs_collection",
        "docs_collectionrow",
    }
)
FUNCTIONS = frozenset(
    {
        "docs_document_role",
        "docs_journal_guard",
        "docs_scope_guard",
        "docs_collab_fence",
        "docs_collab_audit",
        "docs_redeem_collaboration_ticket",
    }
)

COLLECTION_QUOTA_FUNCTIONS = frozenset(
    {
        ("docs_collection_scope_guard", ""),
        ("docs_collab_snapshot_admit", "p_document uuid, p_bytes bigint"),
    }
)


ROLE_GRANT_TABLE = "docs_documentrolegrant"
ROLE_GRANT_FUNCTION = "docs_role_grant_scope_guard"
ROLE_GRANT_KIND_TRIGGER = ("trigger", "workspaces_workspacerole", "docs_role_grant_subteam_kind")

# Function details match pg_get_function_identity_arguments, including argument names.
PRE_ROLE_GRANT_FUNCTIONS = frozenset(
    {
        (
            "function",
            "docs_document_role",
            "p_document uuid, p_organisation uuid, p_member uuid, p_identity uuid, "
            "p_issuer text, p_subject text",
        ),
        (
            "function",
            "docs_collab_fence",
            "p_document uuid, p_organisation uuid, p_member uuid, p_identity uuid, "
            "p_issuer text, p_subject text, p_role text, p_confidential boolean, p_epoch bigint",
        ),
    }
)
# Before 0012 added confidential admission, the fence had only seven arguments.
# Keep these alternatives separate from the 0012 signatures used to build 0013's keys.
PRE_CONFIDENTIAL_COLLAB_FUNCTIONS = frozenset(
    (kind, name, detail.removesuffix(", p_confidential boolean, p_epoch bigint"))
    for kind, name, detail in PRE_ROLE_GRANT_FUNCTIONS
)
# schema_objects includes columns and constraints as well as function signatures.
# These 0012 additions still identify its schema if either fence is missing.
# docs_fulltext is not a marker: its index key already exists before 0012.
CONFIDENTIAL_COLLAB_KEYS = frozenset(
    {
        ("column", "docs_document", "is_confidential"),
        ("column", "docs_document", "encryption_epoch"),
        ("constraint", "docs_document", "docs_confidential_markdown_empty"),
        ("constraint", "docs_document", "docs_encryption_epoch_nonnegative"),
        *(PRE_ROLE_GRANT_FUNCTIONS - PRE_CONFIDENTIAL_COLLAB_FUNCTIONS),
    }
)
# Only new 0013 keys belong here. Both older fences and the six-argument role
# function survive as compatibility wrappers; they cannot identify 0013 alone.
ROLE_GRANT_KEYS = frozenset(
    {
        ("relation", ROLE_GRANT_TABLE, ROLE_GRANT_TABLE),
        ("function", ROLE_GRANT_FUNCTION, ""),
        ("trigger", ROLE_GRANT_TABLE, "docs_role_grant_scope"),
        ("trigger", ROLE_GRANT_TABLE, "aa_privacy_cutoff"),
        ROLE_GRANT_KIND_TRIGGER,
        *(
            (kind, name, detail + ", p_device uuid")
            for kind, name, detail in PRE_ROLE_GRANT_FUNCTIONS
        ),
    }
)


def without_documents(objects):
    # Exact ownership: changes to any older table/function remain in the comparison.
    if not all(("relation", table, table) in objects for table in TABLES):
        raise AssertionError("document tables are missing from the current schema")
    present_functions = {key[1] for key in objects if key[0] == "function" and key[1] in FUNCTIONS}
    if present_functions != FUNCTIONS:
        raise AssertionError("document scope functions are missing from the current schema")
    added_functions = {("function", *value) for value in COLLECTION_QUOTA_FUNCTIONS}
    if not added_functions <= objects.keys():
        raise AssertionError(
            "document collection/quota functions are missing from the current schema"
        )
    # Any surviving 0013 object requires the complete migration inventory.
    if ROLE_GRANT_KEYS & objects.keys():
        if not ROLE_GRANT_KEYS <= objects.keys():
            raise AssertionError("document role grant objects are missing from the current schema")
    required = PRE_CONFIDENTIAL_COLLAB_FUNCTIONS
    if (ROLE_GRANT_KEYS | CONFIDENTIAL_COLLAB_KEYS) & objects.keys():
        # 0012 and 0013 both retain the seven- and nine-argument fences. Independent
        # column/constraint evidence prevents a damaged 0012 from passing as 0007.
        required |= PRE_ROLE_GRANT_FUNCTIONS | CONFIDENTIAL_COLLAB_KEYS
    if not required <= objects.keys():
        raise AssertionError(
            "pre-role-grant document functions or confidential objects are missing "
            "from the current schema"
        )
    return {
        key: value
        for key, value in objects.items()
        if key[1] not in TABLES | {ROLE_GRANT_TABLE}
        and key not in ROLE_GRANT_KEYS
        and not (key[0] == "function" and key[1] in FUNCTIONS)
        and key not in added_functions
    }
