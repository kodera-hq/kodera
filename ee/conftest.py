"""Root pytest configuration for `ee/` isolating PostgreSQL test DB when `POSTGRES_DB` is set."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SERVER_ROOT = _REPO_ROOT / "apps" / "server"
_SERVER_TESTS = _SERVER_ROOT / "tests"

for _entry in (str(_REPO_ROOT), str(_SERVER_ROOT), str(_SERVER_TESTS)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)


def pytest_configure() -> None:
    pg_db = os.environ.get("POSTGRES_DB", "").strip()
    if not pg_db:
        return
    from django.conf import settings

    test_cfg = dict(settings.DATABASES["default"].get("TEST") or {})
    test_cfg["NAME"] = pg_db if pg_db.startswith("test_") else f"test_{pg_db}"
    settings.DATABASES["default"]["TEST"] = test_cfg
