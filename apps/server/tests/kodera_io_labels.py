"""Every first label the platform uses under kodera.io: the one list both reserved-slug lists are pinned to.

An organisation's slug is its realm and once named its Matrix homeserver (ADR-0018). A tenant's
slug names its homeserver, `{slug}.{matrix domain}` (ADR-0023), so on staging it sits beside
`staging.kodera.io`'s own hosts too. Either would collide with a platform host that has the same
label. The labels come from:
- ADR-0018's list (ESPACE_STRUCTURE.md §8);
- ADR-0015's identity and mail hosts;
- the platform-prod hosts of deployment profiles `policy/kad-platform-ingress.yaml` (`admin`,
  `ops-admin`, `errors`);
- staging's hosts (`auth`, `auth-admin`, `app`, `api`, `notify`).

A new host under kodera.io is added here first. tests/test_reserved_platform_slugs.py and
tests/test_reserved_tenant_platform_labels.py then name each reserved list that lacks a label its
slug pattern admits.
"""

import re

KODERA_IO_LABELS = (
    "community",
    "www",
    "id",
    "api",
    "app",
    "auth",
    "auth-admin",
    "auth-mail",
    "mail",
    "admin",
    "ops-admin",
    "errors",
    "notify",
    "staging",
    "status",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
)


def fitting(pattern):
    """The labels a slug pattern admits: only those can collide."""
    rule = re.compile(pattern)
    return tuple(label for label in KODERA_IO_LABELS if rule.fullmatch(label))
