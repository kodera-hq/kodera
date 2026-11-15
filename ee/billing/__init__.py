# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Kodera Enterprise commercial billing, warm-pool Autopilot, and purchase orders.

All runtime entrypoints and HTTP handlers in this package are strictly gated behind
``KODERA_EDITION=enterprise`` and refuse execution (HTTP ``404``) in Community mode.
"""

from __future__ import annotations

import os
from collections.abc import Mapping


class EnterpriseEditionRequiredError(PermissionError):
    """Raised when an Enterprise-only billing operation is invoked outside Enterprise mode."""


def is_enterprise_edition(environ: Mapping[str, str] | None = None) -> bool:
    """Return True strictly when ``KODERA_EDITION`` normalizes to ``enterprise``."""
    source = os.environ if environ is None else environ
    return source.get("KODERA_EDITION", "community").strip().lower() == "enterprise"


def require_enterprise_edition(environ: Mapping[str, str] | None = None) -> None:
    """Refuse execution unless ``KODERA_EDITION=enterprise``."""
    if not is_enterprise_edition(environ):
        raise EnterpriseEditionRequiredError(
            "Enterprise billing requires KODERA_EDITION=enterprise"
        )


__all__ = [
    "EnterpriseEditionRequiredError",
    "is_enterprise_edition",
    "require_enterprise_edition",
]
