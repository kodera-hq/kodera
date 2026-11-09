"""createTenant: on a deployment that does not bill, the owner's one step to a workspace.

In billing, beside the switch and `placeOrder`, because it is the other way a tenant is created:
its route (apps/billing/api/create_tenant.py) imports this module only, which names what it needs
of the legal, tenancy and workspace applications.

docs/specs/QUICK_WORKSPACE.md §4. The view authorises the caller with `authorise` (owner only)
and refuses while billing is on, both before the replay store; `create_tenant` is the step the
store runs once per key. It takes the organisation lock first, judges the caller and the switch
again under it, checks the organisation and its setup, that the organisation holds no live tenant
and that the offer is configured, and only then writes, in the store's transaction: the tenant on
the unbilled offer, its DPA, the acceptance of the CGV and the DPA for that tenant, and the
starter workspace. It writes no order, subscription, invoice or job.

The one-workspace rule is this step's own (lead ruling on QUICK_WORKSPACE.md C2a, option B): the
database lets an organisation own more than one tenant, as the domain model does, so the lock is
what settles two concurrent creations.
"""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from apps.identity.selectors import current_identity
from apps.legal.services import (
    Accepted as Accepted,
    DpaNotFoundError,
    LegalValidationError as LegalValidationError,
    LegalVersionError as LegalVersionError,
    Signatory,
    check_agreements,
    in_force,
    prepare_dpa,
    record_agreements,
)
from apps.orgs.actor_selectors import organisation_slug
from apps.tenancy.selectors import slug_availability, tenants_not_deleted
from apps.tenancy.services import (
    TenantSlugInvalidError as TenantSlugInvalidError,
    TenantSlugTakenError as TenantSlugTakenError,
    create_ordered_tenant,
    tenant_representation,
)
from apps.workspaces.initialise import (
    InitialiseForbiddenError as InitialiseForbiddenError,
    Initialiser as Initialiser,
    InitialiseStateError as InitialiseStateError,
    authorise_initialise,
    check_organisation_ready,
    find_or_create_starter,
    lock_organisation,
    reauthorise_initialise,
    record_staff_denial as record_staff_denial,
    record_tenant_denial as record_tenant_denial,
)
from apps.workspaces.structure import (
    WorkspaceCallerUnknownError as WorkspaceCallerUnknownError,
    WorkspaceNotFoundError as WorkspaceNotFoundError,
)
from services.identity.access_tokens import VerifiedAccessToken

from . import events
from .actors import Actor
from .models import CapacityTier, Pack
from .switch import UNBILLED_PACK, UNBILLED_TIER, require_no_billing

REQUIRED_SCOPE = "tenant:create"
CREATING_ROLES = frozenset({"org_owner"})


class TenantExistsError(Exception):
    """The organisation holds a tenant that is not `deleted`: `409 tenant-exists`."""


class OfferNotConfiguredError(Exception):
    """The unbilled pack is not on sale, its tier or its DPA template is missing: `503`, nothing
    written, since the deployment is what is wrong and the same request succeeds once fixed."""


@dataclass(frozen=True, slots=True)
class TenantRequest:
    """The contract's `TenantCreation`, its shape already checked by the view."""

    name: str
    slug: str
    locale: str
    cgv: Accepted
    dpa: Accepted


@dataclass(frozen=True, slots=True)
class CreatedTenant:
    tenant_id: UUID
    workspace_id: UUID


def authorise(*, verified: VerifiedAccessToken, organisation_id: UUID) -> Initialiser:
    """The caller against current state, before the replay store: the owner, or a recorded `403`
    for another member's role (InitialiseForbiddenError), `404` for anyone else."""
    return authorise_initialise(
        verified=verified, organisation_id=organisation_id, roles=CREATING_ROLES
    )


def free_slugs(slug: str) -> list[str]:
    """Up to three slugs free now, for a `slug-taken` answer: not a reservation."""
    suggestions: list[str] = slug_availability(slug)["suggestions"]
    return suggestions


def created_representation(created: "CreatedTenant") -> dict[str, Any]:
    """The contract's `TenantCreated`."""
    return {
        "tenant": tenant_representation(tenant_id=created.tenant_id),
        "workspace_id": str(created.workspace_id),
    }


def holds_live_tenant(organisation_id: UUID) -> bool:
    """Whether the organisation holds a tenant that is not `deleted`: check 4 of
    QUICK_WORKSPACE.md §4.2."""
    return tenants_not_deleted(organisation_id).exists()


def _offer(request: TenantRequest) -> Pack:
    """The unbilled pack, once its tier and both templates the request names are found; otherwise
    the deployment is what is wrong (`503`), whatever the request says."""
    pack = Pack.objects.filter(code=UNBILLED_PACK, available=True).first()
    if pack is None or not CapacityTier.objects.filter(code=UNBILLED_TIER).exists():
        raise OfferNotConfiguredError()
    for document in (request.cgv, request.dpa):
        if in_force(code=document.code, locale=document.locale, pack_code=pack.code) is None:
            raise OfferNotConfiguredError()
    return pack


def create_tenant(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    request: TenantRequest,
    request_id: str,
    source_ip: str | None,
    user_agent: str | None,
) -> CreatedTenant:
    """QUICK_WORKSPACE.md §4.2 and §4.3 in the caller's transaction, or an exception and nothing
    the caller should keep: the caller runs it in a savepoint and rolls it back on any refusal."""
    # First, before any check: two creations at once are decided one after the other.
    lock_organisation(organisation_id)
    # The caller again, under the lock: the agreements are signed on the role held now, not on
    # the one the view read before the replay store (a demoted owner is refused, unstored).
    creator = reauthorise_initialise(
        verified=verified, organisation_id=organisation_id, roles=CREATING_ROLES
    )
    # Again in the step: the view skips it when the store holds an answer, which may expire
    # before the store looks the key up.
    require_no_billing()
    check_organisation_ready(organisation_id=organisation_id, issuer=creator.issuer)
    if holds_live_tenant(organisation_id):
        raise TenantExistsError()
    pack = _offer(request)
    tenant = create_ordered_tenant(
        organisation_id=organisation_id,
        slug=request.slug,
        name=request.name,
        locale=request.locale,
        pack_code=pack.code,
        capacity_tier_code=UNBILLED_TIER,
        apps=list(pack.apps),
        profile_ref=pack.profile_ref,
        realm=organisation_slug(organisation_id=organisation_id),
    )
    try:
        dpa, _ = prepare_dpa(
            organisation_id=organisation_id,
            pack_code=pack.code,
            locale=request.dpa.locale,
            tenant_id=tenant.id,
        )
    except DpaNotFoundError:
        # Defensive: `_offer` found the template, and a published document is never deleted.
        raise OfferNotConfiguredError() from None
    if dpa.version != request.dpa.version:
        raise LegalVersionError("dpa", (dpa.version,))
    # The DPA travels as `dpa_id`, never among the documents, which refuse it.
    checked = check_agreements(
        organisation_id=organisation_id,
        pack_code=pack.code,
        documents=[request.cgv],
        dpa_id=dpa.id,
    )
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise WorkspaceCallerUnknownError()
    person, _ = resolved
    record_agreements(
        checked,
        order_id=None,
        tenant_id=tenant.id,
        signatory=Signatory(
            identity_id=creator.identity_id,
            person_id=person.id,
            email=person.email,
            name=person.display_name or person.email,
            role=None,
            source_ip=source_ip,
            user_agent=user_agent,
        ),
        request_id=request_id,
    )
    events.record(
        "tenant.ordered",
        actor=Actor("tenant", creator.identity_id, request_id),
        organisation_id=organisation_id,
        target=("tenant", tenant.id),
        metadata={"slug": request.slug, "billing": "off"},
    )
    workspace_id = find_or_create_starter(
        organisation_id=organisation_id, actor_id=creator.identity_id, request_id=request_id
    )
    return CreatedTenant(tenant_id=tenant.id, workspace_id=workspace_id)
