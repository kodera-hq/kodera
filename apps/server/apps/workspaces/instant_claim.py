"""Warm-pool allocation claims with current owner checks and transaction-scoped locks."""

import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.identity.selectors import current_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken

from .initialise import lock_organisation
from .models import Channel, WarmPoolAllocation
from .warm_pool import InstantClaimRequest, build_instant_claim_plan, build_instant_claim_response


class ClaimForbiddenError(Exception):
    """The current customer is not an active organisation owner."""


class PoolUnavailableError(Exception):
    """No matching, ready, worker-prepared allocation exists. Never persisted for replay."""


def _owner(verified: VerifiedAccessToken) -> TenantCaller:
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise ClaimForbiddenError()
    _, identity = resolved
    try:
        caller = read_tenant_caller(verified=verified, organisation_id=identity.organisation_id)
    except (TenantCallerUnknownError, TenantCallerNotFoundError):
        raise ClaimForbiddenError() from None
    if caller.role != "org_owner" or caller.organisation_state != "active":
        raise ClaimForbiddenError()
    return caller


def _public_https(value: str) -> bool:
    try:
        url = urlsplit(value)
        return (
            len(value) <= 4096
            and url.scheme == "https"
            and bool(url.hostname)
            and re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", url.hostname or "") is not None
            and not url.username
            and not url.password
            and not url.port
            and not (url.hostname or "").endswith(
                (".local", ".internal", ".localhost", ".test", ".invalid")
            )
            and not any(ord(ch) < 33 or ch == "\\" for ch in value)
        )
    except ValueError:
        return False


class ClaimConflictError(Exception):
    """An allocation has already been claimed by another request."""


def authorise_instant_claim(verified: VerifiedAccessToken) -> UUID:
    """Read current owner authority before entering the idempotency store."""
    with transaction.atomic():
        return _owner(verified).organisation_id


def reauthorise_instant_claim(verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    """Re-read authority under the same organisation lock as membership changes."""
    lock_organisation(organisation_id)
    if _owner(verified).organisation_id != organisation_id:
        raise ClaimForbiddenError()


def claim_allocation(payload: InstantClaimRequest, organisation_id: UUID) -> dict[str, Any]:
    """Consume a ready allocation inside the idempotency store's transaction."""
    plan = build_instant_claim_plan(payload)
    allocation = (
        WarmPoolAllocation.objects.select_for_update()
        .filter(workspace__organisation_id=organisation_id, slug=payload.slug)
        .first()
    )
    if allocation is None or not plan["warm_pool_eligible"]:
        raise PoolUnavailableError()
    if allocation.claimed_at is not None:
        raise ClaimConflictError()
    if allocation.plan != plan or not all(
        map(
            _public_https,
            (
                allocation.workspace_url,
                allocation.invitation_url,
            ),
        )
    ):
        raise PoolUnavailableError()
    channels = list(Channel.objects.filter(workspace_id=allocation.workspace_id).order_by("id"))
    expected = {(ch["db_template_key"], ch["name"], ch["kind"]) for ch in plan["channels"]}
    actual = {
        (ch.template_key, ch.name, ch.kind)
        for ch in channels
        if ch.lifecycle == "active" and ch.room_state == "ready"
    }
    if len(channels) != len(expected) or actual != expected:
        raise PoolUnavailableError()
    result = build_instant_claim_response(
        payload,
        workspace_id=str(allocation.workspace_id),
        workspace_url=allocation.workspace_url,
        invitation_url=allocation.invitation_url,
        offer_mode=allocation.offer_mode,
    )
    result["channels"] = [{"id": str(ch.id), "name": ch.name, "kind": ch.kind} for ch in channels]
    allocation.claimed_at = timezone.now()
    allocation.save(update_fields=["claimed_at"])
    return result
