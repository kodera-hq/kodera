"""Materialized anonymous realm selection in one current coherent snapshot."""

from typing import Any

from django.conf import settings

from apps.identity.discovery_db import Deadline, discovery_transaction
from services.identity.discovery_policy import (
    DiscoveryUnavailableError,
    configured_key,
    validate_value,
)

from .bootstrap_selectors import counting_realm_ready
from .intake_services import organisation_issuer
from .models import Organisation


def select_realms(kind: str, value: str) -> dict[str, Any]:
    configured_key(getattr(settings, "KODERA_DISCOVERY_HMAC_KEY", None))
    validate_value(kind, value)
    result: dict[str, Any] = dict(
        realm=None, issuer=None, openid_configuration_url=None, organisation=None, candidates=[]
    )
    if kind == "domain":
        # No verified organisation/domain association exists until its proof producer does: the
        # true answer is the zero result, so a client falls back to slug entry instead of retrying.
        return result
    try:
        # The realm's issuer at this deployment's identity provider (ADR-0006, ADR-0015).
        expected_issuer = organisation_issuer(value)
    except RuntimeError:
        raise DiscoveryUnavailableError("configuration") from None
    with discovery_transaction(Deadline(), read_only=True):
        organisation = Organisation.objects.filter(
            slug=value, realm=value, deleted_at__isnull=True, state__in=("active", "suspended")
        ).first()
        if (
            organisation is not None
            and organisation.issuer == expected_issuer
            and counting_realm_ready(organisation_id=organisation.id)
        ):
            result.update(
                realm=value,
                issuer=organisation.issuer,
                openid_configuration_url=organisation.issuer + "/.well-known/openid-configuration",
                organisation={
                    "id": str(organisation.id),
                    "slug": value,
                    "realm": value,
                    "name": organisation.name,
                },
            )
    return result
