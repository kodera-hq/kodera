"""Tenant writes other applications call: the order transaction creates the tenant it orders."""

import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from .models import SLUG, Tenant, is_reserved_tenant_slug

SLUG_PATTERN = re.compile(SLUG.removesuffix("$") + r"\Z")


class TenantSlugTakenError(Exception):
    """The slug names a tenant already, now or in the past (ADR-0008): `409 conflict`."""


class TenantSlugInvalidError(Exception):
    """Not a DNS label of 3 to 32 characters: `422 validation-error`."""


@dataclass(frozen=True, slots=True)
class OrderedTenant:
    id: UUID
    organisation_id: UUID


def create_ordered_tenant(
    *,
    organisation_id: UUID,
    slug: str,
    name: str,
    locale: str,
    pack_code: str,
    capacity_tier_code: str,
    apps: list[str],
    profile_ref: str | None,
    realm: str | None,
) -> OrderedTenant:
    """The tenant an order creates, in status `ordered`, in the caller's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("a tenant is ordered in its order's transaction")
    if not SLUG_PATTERN.match(slug) or is_reserved_tenant_slug(slug):
        raise TenantSlugInvalidError()
    try:
        with transaction.atomic():
            tenant = Tenant.objects.create(
                organisation_id=organisation_id,
                slug=slug,
                name=name,
                locale=locale,
                pack_code=pack_code,
                capacity_tier_code=capacity_tier_code,
                apps=apps,
                profile_ref=profile_ref,
                realm=realm,
                status_changed_at=timezone.now(),
            )
    except IntegrityError as refused:
        if getattr(refused.__cause__, "diag", None) and refused.__cause__.diag.constraint_name == (  # type: ignore[union-attr]
            "tenancy_tenant_slug_key"
        ):
            raise TenantSlugTakenError() from None
        raise
    return OrderedTenant(id=tenant.id, organisation_id=organisation_id)


def delete_ordered_tenant(*, tenant_id: UUID) -> bool:
    """`ordered → deleted` (TENANT_STATE_MACHINE.md T21): the order was cancelled before anything
    was built. In the caller's transaction. The row is kept, so its slug stays taken: stricter
    than ADR-0008, which lets a slug no external resource used be released. Returns
    whether the tenant moved: one already past `ordered` is left as it is."""
    if not connection.in_atomic_block:
        raise RuntimeError("a tenant is deleted in its order's transaction")
    moved = Tenant.objects.filter(id=tenant_id, status="ordered").update(
        status="deleted", status_changed_at=timezone.now(), updated_at=timezone.now()
    )
    return moved == 1


def tenant_representation(*, tenant_id: UUID) -> dict[str, Any]:
    """The contract's `Tenant` for the tenant an order created."""
    row = Tenant.objects.get(id=tenant_id)

    def instant(value: Any) -> str:
        return str(value.isoformat().replace("+00:00", "Z"))

    return {
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "slug": row.slug,
        "name": row.name,
        "status": row.status,
        "status_changed_at": instant(row.status_changed_at),
        "pack_code": row.pack_code,
        "capacity_tier_code": row.capacity_tier_code,
        "apps": list(row.apps),
        "region": row.region,
        "realm": row.realm,
        "profile_ref": row.profile_ref,
        "locale": row.locale,
        "created_at": instant(row.created_at),
        "updated_at": instant(row.updated_at),
    }


def tenant_status_of(*, organisation_id: UUID, tenant_id: UUID) -> str | None:
    """The status of the organisation's tenant `tenant_id`, or None when it has no such tenant."""
    found: str | None = (
        Tenant.objects.filter(id=tenant_id, organisation_id=organisation_id)
        .values_list("status", flat=True)
        .first()
    )
    return found
