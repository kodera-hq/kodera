"""A committed order for a test organisation, placed through the real service.

A workspace is initialised only once its organisation has an order with its CGV and DPA accepted
(`apps.workspaces.initialise`). Tests that reach the workspace place one here: the placeholder
catalogue and legal documents, a French billing profile, the DPA generated for the pack, and the
order itself, as its owner, exactly as `placeOrder` does.
"""

from uuid import UUID, uuid4

from apps.billing import catalogue, services
from apps.billing.models import Plan
from apps.billing.services import Accepted, Agreements, OrderRequest, TenantRequest
from apps.legal import services as legal
from apps.legal.models import LegalDocument
from services.identity.access_tokens import VerifiedAccessToken


def owner_token(issuer: str, subject: str) -> VerifiedAccessToken:
    return VerifiedAccessToken(
        issuer=issuer,
        subject=subject,
        audience=("kodera-server",),
        issued_at=0,
        expires_at=2**31,
        not_before=None,
        amr=None,
        acr=None,
        auth_time=None,
    )


def commit_order(organisation_id: UUID, issuer: str, subject: str) -> services.PlacedOrder:
    from billing_fiscal_fixtures import register_test_fiscal_periods

    register_test_fiscal_periods()
    if not Plan.objects.exists():
        catalogue.load(catalogue.read(catalogue.PLACEHOLDER), allow_placeholder=True)
    if not LegalDocument.objects.exists():
        legal.load_documents(legal.read_documents(legal.PLACEHOLDER), allow_placeholder=True)
    services.set_billing_profile(
        organisation_id=organisation_id,
        legal_name="Synthetic Customer SAS",
        address_line1="1 rue Synthétique",
        postal_code="75000",
        city="Paris",
        country="FR",
    )
    owner = owner_token(issuer, subject)
    dpa, _ = legal.generate_dpa(
        verified=owner,
        organisation_id=organisation_id,
        pack_code="visio-docs",
        locale="fr",
        tenant_id=None,
    )
    return services.place_order(
        verified=owner,
        organisation_id=organisation_id,
        idempotency_key=f"order-key-{uuid4().hex}",
        request=OrderRequest(
            pack_code="visio-docs",
            capacity_tier_code="M",
            billing_period="yearly",
            tenant=TenantRequest(slug=f"t{uuid4().hex[:12]}", name="Synthetic tenant"),
            agreements=Agreements(
                dpa_id=dpa.id, documents=(Accepted(code="cgv", version="0.0", locale="fr"),)
            ),
        ),
    )
