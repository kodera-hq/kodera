"""The per-realm credential of the realm access delivery: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.5.

The delivery acts with the organisation realm's own service-account client, `kodera-identity-worker`
(realm-apply step 3 of identity realm tooling): `manage-users` and `view-users` of `realm-management` in
that realm and nothing else. Its secret is loaded for one delivery, never put in the process
environment, and dropped when the delivery ends, on failure too.

The source is a directory, one file per realm named after the realm; a mounted Secret Manager
secret fits it. SETTINGS_AND_SECRETS.md §4 places credential loading here, in worker/credentials/.
It is not in the API image.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

WORKER_CLIENT_ID = "kodera-identity-worker"
# A realm name as a file name: no separator, no dot-only name, nothing a path could climb with.
REALM_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
MAX_SECRET_BYTES = 4096


class CredentialUnavailableError(Exception):
    """No usable credential for the realm. The message names the realm, never a value."""


@dataclass(frozen=True)
class ClientCredential:
    client_id: str
    secret: str = field(repr=False)


class DirectoryCredentialSource:
    """One file per realm under `directory`, holding the realm worker client's secret."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @contextmanager
    def load(self, realm: str) -> Iterator[ClientCredential]:
        if REALM_NAME.fullmatch(realm) is None:
            raise CredentialUnavailableError("the realm name is not a credential name")
        try:
            # A mounted secret is often a symlink into a versioned store: followed, but only to a
            # file that stays under the directory.
            root = self.directory.resolve(strict=True)
            path = (root / realm).resolve(strict=True)
            if not path.is_relative_to(root) or not path.is_file():
                raise CredentialUnavailableError(f"no credential for realm {realm}")
            raw = path.read_bytes()[: MAX_SECRET_BYTES + 1]
        except OSError:
            raise CredentialUnavailableError(f"credential of realm {realm} unreadable") from None
        try:
            secret = raw.decode("ascii").strip()
        except UnicodeDecodeError:
            raise CredentialUnavailableError(f"credential of realm {realm} unreadable") from None
        del raw
        if not secret or len(secret) > MAX_SECRET_BYTES or any(c.isspace() for c in secret):
            raise CredentialUnavailableError(f"credential of realm {realm} unusable")
        credential = ClientCredential(WORKER_CLIENT_ID, secret)
        del secret
        try:
            yield credential
        finally:
            # Python cannot zero a str; the last reference this module holds goes here.
            del credential
