"""Compatibility import for the canonical reviewed API writer grant policy."""

from core.db.api_writer_role import (
    DELETE as DELETE,
    EXECUTE_FUNCTIONS as EXECUTE_FUNCTIONS,
    INSERT as INSERT,
    ROLE as ROLE,
    SELECT as SELECT,
    SELECT_COLUMNS as SELECT_COLUMNS,
    UPDATE_COLUMNS as UPDATE_COLUMNS,
    grant_statements as grant_statements,
)
