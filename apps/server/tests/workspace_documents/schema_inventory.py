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
    return {
        key: value
        for key, value in objects.items()
        if key[1] not in TABLES
        and not (key[0] == "function" and key[1] in FUNCTIONS)
        and key not in added_functions
    }
