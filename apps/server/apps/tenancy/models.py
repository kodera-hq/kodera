"""The tenant an order creates: contracts/core-api.openapi.yaml `Tenant`, desired state only.

Only what `OrderResult.tenant` needs. A tenant is written in status `ordered` by the order
transaction; provisioning, environment allocation (ADR-0012) and the rest of the lifecycle come
with their jobs. The slug is unique across every tenant ever written and a tenant row is never
deleted, so a slug never names a second tenant (ADR-0008).
"""

from django.db import models
from django.db.models import Q

from core.db.models import StoredModel

TENANT_STATUSES = (
    "ordered",
    "provisioning",
    "ready",
    "active",
    "upgrading",
    "maintenance",
    "suspended",
    "decommissioning",
    "deleted",
    "failed",
)
SLUG = r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$"
# Labels a tenant may not take: the platform's own hosts, and punycode (`xn--`), which can render
# as another name. A closed list: adding a name is a contract change and a migration. Since contract
# 0.38.0 it also holds the platform labels of kodera.io that organisation slugs reserve
# (`RESERVED_ORGANISATION_SLUGS`, ADR-0018): a tenant's slug names its Matrix homeserver,
# `{slug}.kodera.io` (ADR-0023), so `staging` would be the staging Matrix domain itself. And
# `errors` and `ops-admin`, platform-prod hosts of kodera.io that organisation slugs do not reserve
# yet (deployment profiles policy/kad-platform-ingress.yaml). Migrations tenancy.0003 and 0004.
RESERVED_TENANT_SLUGS = (
    "community",
    "www",
    "api",
    "app",
    "auth",
    "identity",
    "mail",
    "status",
    "staff",
    "admin",
    "kodera",
    "kodera-staff",
    "notify",
    "staging",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
    "auth-admin",
    "auth-mail",
    "errors",
    "ops-admin",
)


def is_reserved_tenant_slug(slug: str) -> bool:
    """A label no tenant may take: the rule the ordering service and checkSlugAvailability apply,
    and that the model's check constraint mirrors in its own expression."""
    return slug in RESERVED_TENANT_SLUGS or slug.startswith("xn--")


class Tenant(StoredModel):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    is_default_community = models.BooleanField(default=False)
    slug = models.TextField(unique=True)
    name = models.TextField()
    status = models.TextField(default="ordered")
    status_changed_at = models.DateTimeField()
    pack_code = models.TextField()
    capacity_tier_code = models.TextField()
    apps = models.JSONField()
    region = models.TextField(default="fr-par")
    realm = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    profile_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    locale = models.TextField(default="fr")

    class Meta:
        constraints = [
            models.CheckConstraint(name="tenancy_tenant_slug_valid", condition=Q(slug__regex=SLUG)),
            models.CheckConstraint(
                name="tenancy_tenant_slug_not_reserved",
                condition=(
                    Q(is_default_community=True, slug="community")
                    | (~Q(slug__in=RESERVED_TENANT_SLUGS) & ~Q(slug__startswith="xn--"))
                ),
            ),
            models.CheckConstraint(
                name="tenancy_tenant_community_binding",
                condition=Q(is_default_community=False) | Q(slug="community"),
            ),
            models.CheckConstraint(
                name="tenancy_tenant_status_valid", condition=Q(status__in=TENANT_STATUSES)
            ),
            models.CheckConstraint(
                name="tenancy_tenant_region_valid", condition=Q(region="fr-par")
            ),
            models.CheckConstraint(
                name="tenancy_tenant_locale_valid", condition=Q(locale__in=("fr", "en"))
            ),
            models.CheckConstraint(
                name="tenancy_tenant_name_valid", condition=Q(name__length__range=(1, 200))
            ),
        ]

    def __str__(self) -> str:
        return f"tenant {self.slug} {self.status}"
