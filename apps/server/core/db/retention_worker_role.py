"""Separate processing capability from operator admission; emit source-only grants."""

import re

ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
FUNCTIONS = (
    "privacy_purge_core(uuid)",
    "privacy_record_absence(uuid,text,timestamptz,text,text,timestamptz)",
    "privacy_complete_erasure(uuid)",
    "billing_purge_due_record(text,uuid)",
)
ADMISSION_FUNCTIONS = (
    "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)",
    "billing_close_contract(uuid,timestamptz,text,text,uuid)",
    "billing_qualify_legacy_accounting(text,uuid,timestamptz,text)",
)
EXTENSION_FUNCTIONS = ("extension_erasure_step(uuid,uuid,timestamptz,text,integer)",)
RESERVED_ROLES = frozenset(
    {"kodera_api", "kodera_collab", "kodera_worker", "public", "postgres", "root", "kodera"}
)


def _require(role: str, purpose: str) -> None:
    prefix = f"kodera_retention_{purpose}"
    if (
        not ROLE.fullmatch(role)
        or role in RESERVED_ROLES
        or role.startswith("pg_")
        or not (role == prefix or role.startswith(prefix + "_"))
        or role.endswith(("_owner", "_admin", "_superuser", "_migrations"))
    ):
        raise ValueError("separate statutory erasure " + purpose + " role required")


def grant_statements(role: str, *, include_extensions: bool = False) -> list[str]:
    """Processing resumes an existing approved intent; it cannot mint authority or deadlines."""
    _require(role, "worker")
    functions = FUNCTIONS + (EXTENSION_FUNCTIONS if include_extensions else ())
    return [
        f'GRANT USAGE ON SCHEMA public TO "{role}"',
        f'GRANT UPDATE (updated_at) ON TABLE orgs_privacyerasure TO "{role}"',
        f'GRANT SELECT (source_table,source_id,purge_after,authority_ref,basis,organisation_reference) ON TABLE billing_statutoryrecord TO "{role}"',
        *(f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in functions),
        *(
            f'GRANT SELECT ON TABLE "{table}" TO "{role}"'
            for table in ["orgs_privacyerasure", "orgs_erasurereceipt"]
        ),
    ]


def admission_grant_statements(role: str, *, include_extensions: bool = False) -> list[str]:
    """Separate operator profile; never applied to HTTP, collaboration or processing roles."""
    _require(role, "admission")
    functions = ADMISSION_FUNCTIONS + (EXTENSION_FUNCTIONS if include_extensions else ())
    return [
        f'GRANT USAGE ON SCHEMA public TO "{role}"',
        f'GRANT INSERT ON TABLE billing_fiscalperiod TO "{role}"',
        *(
            f'GRANT SELECT ON TABLE "{table}" TO "{role}"'
            for table in ["billing_fiscalperiod", "orgs_privacyerasure"]
        ),
        *(f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in functions),
    ]
