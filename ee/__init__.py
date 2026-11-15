"""Kodera Enterprise Edition (`ee`) package.

Loaded exclusively when `KODERA_EDITION=enterprise` with a valid commercial subscription.
Governed by `ee/LICENSE` (Samouraï Coop Commercial License, `LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

EDITION = "enterprise"
LICENSE_ID = "LicenseRef-Kodera-EE"

__all__ = ["EDITION", "LICENSE_ID"]
