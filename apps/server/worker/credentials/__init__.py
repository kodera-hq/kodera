"""The only package permitted to load a credential (docs/dev/SETTINGS_AND_SECRETS.md §4).

A credential is loaded for one job or one delivery through a context manager, never put in the
process environment, and dropped when that lifetime ends, on failure too. The API image does not
carry this package, and tests/architecture/test_adr_0003.py proves no API module imports it.
"""

from .realm import (
    MAX_SECRET_BYTES,
    REALM_NAME,
    WORKER_CLIENT_ID,
    ClientCredential,
    CredentialUnavailableError,
    DirectoryCredentialSource,
)

__all__ = [
    "MAX_SECRET_BYTES",
    "REALM_NAME",
    "WORKER_CLIENT_ID",
    "ClientCredential",
    "CredentialUnavailableError",
    "DirectoryCredentialSource",
]
