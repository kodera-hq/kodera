"""Edition gate and capability metadata for Kodera Enterprise Edition (`ee/`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import os

COMMUNITY_EDITION = "community"
ENTERPRISE_EDITION = "enterprise"
ENTERPRISE_LICENSE_ID = "LicenseRef-Kodera-EE"
ENTERPRISE_MODULES = ("saml", "scim", "audit_export")


class EnterpriseEditionRequiredError(PermissionError):
    """Raised when an Enterprise Edition service is invoked outside `KODERA_EDITION=enterprise`."""

    code = "enterprise_edition_required"

    def __init__(self, message: str = "Enterprise Edition required") -> None:
        super().__init__(message)


def current_edition() -> str:
    """Resolve the active Kodera edition from Django settings overrides or `os.environ`."""
    try:
        from django.conf import settings
    except ImportError:
        settings = None  # type: ignore[assignment]

    if settings is not None and getattr(settings, "configured", False):
        wrapped = getattr(settings, "_wrapped", None)
        if (
            wrapped is not None
            and type(wrapped).__name__ == "UserSettingsHolder"
            and "KODERA_EDITION" in wrapped.__dict__
        ):
            val = wrapped.__dict__["KODERA_EDITION"]
            return ENTERPRISE_EDITION if val == ENTERPRISE_EDITION else COMMUNITY_EDITION

    env_val = os.environ.get("KODERA_EDITION")
    if env_val is not None:
        cleaned = env_val.strip()
        if cleaned == "":
            return COMMUNITY_EDITION
        return ENTERPRISE_EDITION if cleaned == ENTERPRISE_EDITION else COMMUNITY_EDITION

    if settings is not None and getattr(settings, "configured", False):
        configured = getattr(settings, "KODERA_EDITION", COMMUNITY_EDITION)
        return ENTERPRISE_EDITION if configured == ENTERPRISE_EDITION else COMMUNITY_EDITION

    return COMMUNITY_EDITION


def is_enterprise_enabled() -> bool:
    """Return True strictly when `KODERA_EDITION=enterprise`."""
    return current_edition() == ENTERPRISE_EDITION


def require_enterprise_edition() -> None:
    """Enforce `KODERA_EDITION=enterprise` in service entry points."""
    if not is_enterprise_enabled():
        raise EnterpriseEditionRequiredError()


def edition_capabilities() -> dict[str, object]:
    """Return non-secret Enterprise Edition status and active module list."""
    return {
        "edition": current_edition(),
        "license": ENTERPRISE_LICENSE_ID,
        "enterprise_enabled": is_enterprise_enabled(),
        "modules": list(ENTERPRISE_MODULES),
    }
