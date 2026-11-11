"""Persist the canonical tenant without declaring its infrastructure ready."""

from uuid import UUID

from django.utils import timezone

from .models import Tenant


def provision_community_tenant(*, organisation_id: UUID) -> None:
    tenant, _ = Tenant.objects.get_or_create(
        slug="community",
        defaults={
            "organisation_id": organisation_id,
            "is_default_community": True,
            "name": "Kodera Community",
            "status": "provisioning",
            "status_changed_at": timezone.now(),
            "pack_code": "workspace",
            "capacity_tier_code": "S",
            "apps": ["messaging"],
            "realm": "community",
            "locale": "en",
        },
    )
    if (
        not tenant.is_default_community
        or tenant.organisation_id != organisation_id
        or tenant.realm != "community"
        or tenant.apps != ["messaging"]
        or tenant.status in {"deleted", "decommissioning"}
    ):
        raise ValueError("Existing community tenant binding requires operator reconciliation")
