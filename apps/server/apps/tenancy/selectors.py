"""Tenant rows, read for the tenant reads in apps/billing/tenant_reads.py.

Every query is scoped to one organisation, or answers which organisation owns a tenant, except
`slug_availability`, which answers whether a slug is free and never which organisation holds it.
The caller's access is checked by apps/billing/access.py before any of these runs.
"""

from typing import Any
from uuid import UUID

from django.conf import settings
from django.db.models import QuerySet

from .models import RESERVED_TENANT_SLUGS, TENANT_STATUSES, Tenant, is_reserved_tenant_slug

STATUSES = frozenset(TENANT_STATUSES)
RESERVED_SLUGS = frozenset(RESERVED_TENANT_SLUGS)


def default_urls(row: Any) -> dict[str, str]:
    """Each of the tenant's applications that has a URL template in KODERA_TENANT_APP_URLS, to
    its default URL (the contract's `Tenant.default_urls`). Here rather than in the tenant reads so
    the operator profile, which does not install the tenant agent's application, can print it."""
    templates: dict[str, str] = settings.KODERA_TENANT_APP_URLS
    return {
        code: templates[code].replace("{slug}", row.slug) for code in row.apps if code in templates
    }


def tenants_of(organisation_id: UUID, *, status: str | None = None) -> QuerySet[Tenant]:
    rows = Tenant.objects.filter(organisation_id=organisation_id)
    return rows if status is None else rows.filter(status=status)


def tenant_of(*, organisation_id: UUID, tenant_id: UUID) -> Tenant | None:
    return Tenant.objects.filter(organisation_id=organisation_id, id=tenant_id).first()


def tenant_owner(tenant_id: UUID) -> UUID | None:
    return Tenant.objects.filter(id=tenant_id).values_list("organisation_id", flat=True).first()


def tenants_not_deleted(organisation_id: UUID) -> QuerySet[Tenant]:
    """The organisation's tenants that are not `deleted`: the one test of a live tenant, for the
    workspace guard and the one-workspace rule alike (QUICK_WORKSPACE.md §3)."""
    return Tenant.objects.filter(organisation_id=organisation_id).exclude(status="deleted")


def newest_tenant_not_deleted(organisation_id: UUID) -> Tenant | None:
    return tenants_not_deleted(organisation_id).order_by("-created_at", "-id").first()


MAX_SLUG = 32
SUGGESTIONS = 3
SUFFIXES = tuple(f"-{n}" for n in range(2, 12))


def _suffixed(slug: str, suffix: str) -> str:
    """The slug with a suffix, cut so the result stays within the 32-character label."""
    return slug[: MAX_SLUG - len(suffix)].rstrip("-") + suffix


def slug_availability(slug: str) -> dict[str, Any]:
    """checkSlugAvailability: whether a tenant slug, already of the tenant slug pattern, can be
    ordered. A slug any tenant has ever held is taken, a deleted one included, since a slug never
    names a second tenant (ADR-0008); a platform name or a punycode label is reserved, as the
    tenant row's own check constraints refuse it. When it cannot, up to three suffixed slugs that
    are free at the moment of the answer, which is not a reservation: placeOrder decides."""
    if is_reserved_tenant_slug(slug):
        reason = "reserved"
    elif Tenant.objects.filter(slug=slug).exists():
        reason = "taken"
    else:
        return {"slug": slug, "available": True, "reason": None, "suggestions": []}
    candidates = [
        candidate
        for candidate in dict.fromkeys(_suffixed(slug, suffix) for suffix in SUFFIXES)
        if not is_reserved_tenant_slug(candidate)
    ]
    held = set(Tenant.objects.filter(slug__in=candidates).values_list("slug", flat=True))
    free = [candidate for candidate in candidates if candidate not in held]
    return {"slug": slug, "available": False, "reason": reason, "suggestions": free[:SUGGESTIONS]}


def tenant_status_matches(*, tenant_id: UUID, organisation_id: UUID, status: str) -> bool:
    """The scoped tenant's persisted transition state, without exposing its row."""
    return Tenant.objects.filter(
        id=tenant_id, organisation_id=organisation_id, status=status
    ).exists()


def organisation_tenant_urls(*, organisation_ids: tuple[UUID, ...]) -> dict[UUID, dict[str, str]]:
    """Map each organisation to its newest live tenant's default application URLs."""
    if not organisation_ids:
        return {}
    result: dict[UUID, dict[str, str]] = {}
    rows = (
        Tenant.objects.filter(organisation_id__in=organisation_ids)
        .exclude(status="deleted")
        .order_by("organisation_id", "-created_at", "-id")
    )
    for row in rows:
        if row.organisation_id not in result:
            result[row.organisation_id] = default_urls(row)
    return result
