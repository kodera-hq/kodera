"""Warm-pool allocation claims with current owner checks and transaction-scoped locks."""

import json
import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.identity.selectors import all_identity_organisation_ids, current_identities
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import Channel, WarmPoolAllocation, Workspace, WorkspaceTemplateApplication
from .services import (
    TemplateActorForbiddenError,
    TemplateActorUnknownError,
    TemplateOperationConflictError,
    TemplateProvisioningStepError,
    _lock_and_verify_template_actor,
    apply_workspace_template,
    template_spec_fingerprint,
)
from .templates import canonical_plan, resolve_template
from .warm_pool import (
    InstantClaimInputError,
    InstantClaimRequest,
    build_instant_claim_plan,
    build_instant_claim_response,
    parse_instant_claim_request,
)


class ClaimForbiddenError(Exception):
    """The current customer is not an active organisation owner."""


class ClaimIdentityUnknownError(Exception):
    """The verified token no longer resolves to an enabled customer identity."""


class PoolUnavailableError(Exception):
    """No matching, ready, worker-prepared allocation exists. Never persisted for replay."""


def _owner(verified: VerifiedAccessToken) -> TenantCaller:
    candidates = current_identities(issuer=verified.issuer, subject=verified.subject)
    if not candidates:
        raise ClaimIdentityUnknownError()
    candidate_org_ids = [
        ident.organisation_id for _person, ident in candidates if ident.organisation_id is not None
    ]
    orgs_with_alloc = (
        set(
            WarmPoolAllocation.objects.filter(
                workspace__organisation_id__in=candidate_org_ids,
                claimed_at__isnull=True,
            ).values_list("workspace__organisation_id", flat=True)
        )
        if len(candidate_org_ids) > 1
        else set()
    )
    ordered = sorted(
        candidates,
        key=lambda item: 0 if item[1].organisation_id in orgs_with_alloc else 1,
    )
    saw_known = False
    for _person, identity in ordered:
        if identity.organisation_id is None:
            continue
        try:
            caller = read_tenant_caller(verified=verified, organisation_id=identity.organisation_id)
        except TenantCallerUnknownError:
            continue
        except TenantCallerNotFoundError:
            saw_known = True
            continue
        saw_known = True
        if caller.role == "org_owner" and caller.organisation_state == "active":
            return caller
    if not saw_known:
        raise ClaimIdentityUnknownError()
    raise ClaimForbiddenError()


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


def _lock_and_verify_owner(
    verified: VerifiedAccessToken, organisation_id: UUID
) -> tuple[UUID, UUID]:
    try:
        return _lock_and_verify_template_actor(
            organisation_id=organisation_id,
            verified=verified,
        )
    except TemplateActorUnknownError:
        raise ClaimIdentityUnknownError() from None
    except TemplateActorForbiddenError:
        raise ClaimForbiddenError() from None


def reauthorise_instant_claim(verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    """Re-read authority under canonical membership/identity/user/organisation locks."""
    _lock_and_verify_owner(verified, organisation_id)


def reauthorise_replay_instant_claim(
    verified: VerifiedAccessToken,
    *,
    fallback_organisation_id: UUID,
    stored_status: int | None,
    stored_body: bytes | None,
    request_body: bytes = b"",
    content_type: str = "",
) -> None:
    """Bind replay, key-reuse, and in-flight authority to the original target organisation."""
    if stored_status is not None and 200 <= stored_status <= 299:
        try:
            parsed = json.loads(stored_body or b"")
            raw_ws_id = parsed.get("workspaceId") if isinstance(parsed, dict) else None
            ws_id = UUID(raw_ws_id) if isinstance(raw_ws_id, str) else None
        except (ValueError, UnicodeDecodeError, TypeError):
            ws_id = None
        if ws_id is None:
            raise ClaimForbiddenError()
        target_org_id = (
            Workspace.objects.filter(id=ws_id).values_list("organisation_id", flat=True).first()
        )
        if target_org_id is None:
            raise ClaimForbiddenError()
        _lock_and_verify_owner(verified, target_org_id)
        return

    caller_org_ids = all_identity_organisation_ids(issuer=verified.issuer, subject=verified.subject)
    if caller_org_ids:
        try:
            candidate = parse_instant_claim_request(request_body, content_type)
        except InstantClaimInputError:
            candidate = None
        if candidate is not None:
            slug_org_id = (
                WarmPoolAllocation.objects.filter(
                    slug=candidate.slug,
                    workspace__organisation_id__in=caller_org_ids,
                )
                .values_list("workspace__organisation_id", flat=True)
                .first()
            )
            if slug_org_id is not None:
                for target_id in sorted({slug_org_id, fallback_organisation_id}):
                    _lock_and_verify_owner(verified, target_id)
                return
    _lock_and_verify_owner(verified, fallback_organisation_id)


def _expected_fingerprint(payload: InstantClaimRequest) -> str:
    template = resolve_template(payload.template_id)
    return template_spec_fingerprint(
        template.id,
        template.version,
        payload.customization.to_dict() if payload.customization is not None else None,
    )


def prepare_template_claim(
    payload: InstantClaimRequest,
    organisation_id: UUID,
    *,
    verified: VerifiedAccessToken,
    request_id: str = "",
) -> None:
    """Execute resumable WorkspaceTemplate v2 steps outside the idempotency store's savepoint."""
    if payload.operation_key is None:
        return
    with transaction.atomic():
        membership_id, identity_id = _lock_and_verify_owner(verified, organisation_id)
    fingerprint = _expected_fingerprint(payload)
    existing_app = (
        WorkspaceTemplateApplication.objects.filter(
            workspace__organisation_id=organisation_id, operation_key=payload.operation_key
        )
        .values_list("spec_fingerprint", flat=True)
        .first()
    )
    if existing_app is not None and existing_app != fingerprint:
        return

    plan = build_instant_claim_plan(payload)
    allocation = WarmPoolAllocation.objects.filter(
        workspace__organisation_id=organisation_id, slug=payload.slug
    ).first()
    if allocation is None or not plan["warm_pool_eligible"]:
        raise PoolUnavailableError()
    if allocation.claimed_at is not None:
        return
    if canonical_plan(allocation.plan) != plan or not all(
        map(_public_https, (allocation.workspace_url, allocation.invitation_url))
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

    try:
        apply_workspace_template(
            organisation_id=organisation_id,
            template_id=payload.template_id,
            operation_key=payload.operation_key,
            verified=verified,
            creator_membership_id=membership_id,
            actor_identity_id=identity_id,
            customization=payload.customization,
            request_id=request_id,
        )
    except TemplateActorUnknownError:
        raise ClaimIdentityUnknownError() from None
    except TemplateActorForbiddenError:
        raise ClaimForbiddenError() from None
    except TemplateOperationConflictError:
        return
    except TemplateProvisioningStepError:
        raise PoolUnavailableError() from None


def claim_allocation(payload: InstantClaimRequest, organisation_id: UUID) -> dict[str, Any]:
    """Consume a ready allocation inside the idempotency store's transaction."""
    if payload.operation_key is not None:
        fingerprint = _expected_fingerprint(payload)
        prior_app = (
            WorkspaceTemplateApplication.objects.select_for_update()
            .filter(workspace__organisation_id=organisation_id, operation_key=payload.operation_key)
            .first()
        )
        if prior_app is not None and prior_app.spec_fingerprint != fingerprint:
            raise ClaimConflictError()

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
    # The stored plan is read with today's identifiers (a plan prepared as `givre` is `light`),
    # by the same canonicalisation the claim's own identifiers went through.
    if canonical_plan(allocation.plan) != plan or not all(
        map(
            _public_https,
            (
                allocation.workspace_url,
                allocation.invitation_url,
            ),
        )
    ):
        raise PoolUnavailableError()
    if payload.operation_key is not None:
        app_row = (
            WorkspaceTemplateApplication.objects.select_for_update()
            .filter(workspace_id=allocation.workspace_id, operation_key=payload.operation_key)
            .first()
        )
        if app_row is None or app_row.state != WorkspaceTemplateApplication.State.COMPLETED:
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
