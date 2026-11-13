"""Source-only operator grants: separate erasure/statutory workers from the HTTP API role."""

import re

ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
FUNCTIONS = (
    "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)",
    "privacy_purge_core(uuid)",
    "privacy_record_absence(uuid,text,timestamptz,text,text,timestamptz)",
    "privacy_complete_erasure(uuid)",
    "billing_close_contract(uuid,timestamptz,text,text,uuid)",
    "billing_qualify_legacy_accounting(text,uuid,timestamptz,text)",
    "billing_purge_due_record(text,uuid)",
)


EXTENSION_FUNCTIONS = ("extension_erasure_step(uuid,uuid,timestamptz,text,integer)",)


def grant_statements(role: str, *, include_extensions: bool = False) -> list[str]:
    """Reviewable statements only; this module never creates a role or applies grants."""
    if not ROLE.fullmatch(role) or role in {"kodera_api", "public"}:
        raise ValueError("separate statutory erasure worker role required")
    functions = FUNCTIONS + (EXTENSION_FUNCTIONS if include_extensions else ())
    return [
        f'GRANT USAGE ON SCHEMA public TO "{role}"',
        f'GRANT INSERT ON TABLE billing_fiscalperiod TO "{role}"',
        f'GRANT UPDATE (updated_at) ON TABLE orgs_privacyerasure TO "{role}"',
        f'GRANT SELECT (source_table,source_id,purge_after,authority_ref,basis,organisation_reference) ON TABLE billing_statutoryrecord TO "{role}"',
        *(f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in functions),
        *(
            f'GRANT SELECT ON TABLE "{table}" TO "{role}"'
            for table in [
                "orgs_privacyerasure",
                "orgs_erasurereceipt",
                "billing_fiscalperiod",
            ]
        ),
    ]
