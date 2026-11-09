"""The CGV and the DPA accepted without an order, and the workspace guard that reads them.

docs/specs/QUICK_WORKSPACE.md §3. On a deployment that does not bill, the owner accepts the
agreements for the one tenant the workspace is created with: each acceptance names the tenant and
no order. `has_accepted_agreements` is the G1 guard both workspace operations ask: an order not
cancelled with its DPA accepted, as before, or both agreements accepted, with no order, for a
tenant of the organisation that is not deleted. Real records on the disposable PostgreSQL; the
workspace operations through the real views.
"""

from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from order_fixtures import commit_order, owner_token
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import http_signer as http_signer, initialise, read, w as w

from apps.audit.models import AuditEvent
from apps.billing import catalogue
from apps.billing.models import Order, Plan
from apps.billing.selectors import has_committed_order
from apps.legal import services as legal
from apps.legal.models import Acceptance, Dpa, LegalDocument
from apps.legal.services import has_accepted_agreements
from apps.tenancy.models import Tenant
from apps.tenancy.services import create_ordered_tenant

pytestmark = pytest.mark.django_db(transaction=True)


def documents():
    # The placeholder offer and documents, as commit_order loads them: generate_dpa asks whether
    # the pack is available.
    if not Plan.objects.exists():
        catalogue.load(catalogue.read(catalogue.PLACEHOLDER), allow_placeholder=True)
    if not LegalDocument.objects.exists():
        legal.load_documents(legal.read_documents(legal.PLACEHOLDER), allow_placeholder=True)


def ordered_tenant(organisation):
    with transaction.atomic():
        return create_ordered_tenant(
            organisation_id=organisation.id,
            slug=f"u{uuid4().hex[:12]}",
            name="Unbilled tenant",
            locale="fr",
            pack_code="visio-docs",
            capacity_tier_code="S",
            apps=["visio", "docs"],
            profile_ref=None,
            realm=organisation.slug,
        )


def accept_unbilled(w, organisation=None):
    """The owner accepts the CGV and the DPA for a new tenant, with no order: what createTenant
    records, through the same two legal services the order uses."""
    organisation = organisation or w.alpha
    documents()
    tenant = ordered_tenant(organisation)
    dpa, _ = legal.generate_dpa(
        verified=owner_token(organisation.issuer, "alpha-owner"),
        organisation_id=organisation.id,
        pack_code="visio-docs",
        locale="fr",
        tenant_id=None,
    )
    with transaction.atomic():
        checked = legal.check_agreements(
            organisation_id=organisation.id,
            pack_code="visio-docs",
            documents=[legal.Accepted(code="cgv", version="0.0", locale="fr")],
            dpa_id=dpa.id,
        )
        legal.record_agreements(
            checked,
            order_id=None,
            tenant_id=tenant.id,
            signatory=legal.Signatory(
                identity_id=w.owner.identity.id,
                person_id=w.owner.user.id,
                email=w.owner.user.email,
                name="Synthetic Owner",
                role=None,
                source_ip="203.0.113.7",
                user_agent="synthetic-agent/1.0",
            ),
            request_id=None,
        )
    return tenant


def acceptance_row(w, dpa=None, **ids):
    """One acceptance written directly: of the CGV, or of `dpa` when one is given."""
    documents()
    document = (
        LegalDocument.objects.filter(code="cgv").first()
        if dpa is None
        else LegalDocument.objects.get(id=dpa.template_id)
    )
    return Acceptance.objects.create(
        organisation_id=w.alpha.id,
        document=document,
        dpa=dpa,
        identity_id=w.owner.identity.id,
        accepted_at=timezone.now(),
        **ids,
    )


def generated_dpa(w):
    documents()
    dpa, _ = legal.generate_dpa(
        verified=owner_token(w.alpha.issuer, "alpha-owner"),
        organisation_id=w.alpha.id,
        pack_code="visio-docs",
        locale="fr",
        tenant_id=None,
    )
    return dpa


# --- the record ----------------------------------------------------------------------------------


def test_an_unbilled_acceptance_names_its_tenant_and_no_order(w):
    tenant = accept_unbilled(w)
    rows = Acceptance.objects.filter(organisation_id=w.alpha.id)
    assert sorted(row.document.code for row in rows) == ["cgv", "dpa"]
    assert {(row.order_id, row.tenant_id) for row in rows} == {(None, tenant.id)}
    audit = AuditEvent.objects.get(action="dpa.accepted", organisation_id=w.alpha.id)
    assert audit.metadata["order_id"] is None


def test_an_acceptance_with_an_order_names_no_tenant(w):
    placed = commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    rows = Acceptance.objects.filter(order_id=placed.order.id)
    assert rows.count() == 2
    assert {row.tenant_id for row in rows} == {None}


@pytest.mark.parametrize("ids", ["both", "neither"])
def test_an_acceptance_names_exactly_one_of_an_order_and_a_tenant(w, ids):
    values = {"both": {"order_id": uuid4(), "tenant_id": uuid4()}, "neither": {}}[ids]
    with pytest.raises(IntegrityError, match="legal_acceptance_order_or_tenant"):
        with transaction.atomic():
            acceptance_row(w, **values)


def test_a_document_is_accepted_once_per_tenant(w):
    tenant_id = uuid4()
    acceptance_row(w, tenant_id=tenant_id)
    with pytest.raises(IntegrityError, match="legal_acceptance_once_per_tenant"):
        with transaction.atomic():
            acceptance_row(w, tenant_id=tenant_id)


# --- the guard -----------------------------------------------------------------------------------


def test_with_nothing_accepted_the_guard_is_false(w):
    documents()
    ordered_tenant(w.alpha)
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


def test_an_order_not_cancelled_with_its_dpa_accepted_passes_the_guard_as_before(w):
    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    assert has_accepted_agreements(organisation_id=w.alpha.id) is True


def test_both_agreements_accepted_for_a_live_tenant_pass_the_guard(w):
    accept_unbilled(w)
    assert has_committed_order(organisation_id=w.alpha.id) is False
    assert has_accepted_agreements(organisation_id=w.alpha.id) is True
    assert has_accepted_agreements(organisation_id=w.bravo.id) is False


def test_a_deleted_tenant_s_acceptances_do_not_count(w):
    tenant = accept_unbilled(w)
    Tenant.objects.filter(id=tenant.id).update(status="deleted")
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


def test_the_cgv_alone_without_an_order_does_not_count(w):
    tenant = ordered_tenant(w.alpha)
    acceptance_row(w, tenant_id=tenant.id)
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


def test_both_agreements_must_name_the_same_tenant(w):
    # An accepted DPA, from a tenant since deleted, whose own acceptances no longer count.
    first = accept_unbilled(w)
    Tenant.objects.filter(id=first.id).update(status="deleted")
    dpa = Dpa.objects.get(organisation_id=w.alpha.id, state="accepted")
    one, other = ordered_tenant(w.alpha), ordered_tenant(w.alpha)
    acceptance_row(w, tenant_id=one.id)
    acceptance_row(w, dpa=dpa, tenant_id=other.id)
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False

    acceptance_row(w, tenant_id=other.id)
    assert has_accepted_agreements(organisation_id=w.alpha.id) is True


def test_the_dpa_alone_without_an_order_does_not_count(w):
    first = accept_unbilled(w)
    Tenant.objects.filter(id=first.id).update(status="deleted")
    dpa = Dpa.objects.get(organisation_id=w.alpha.id, state="accepted")
    tenant = ordered_tenant(w.alpha)
    acceptance_row(w, dpa=dpa, tenant_id=tenant.id)
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


def test_a_dpa_that_is_not_accepted_does_not_count(w):
    tenant = ordered_tenant(w.alpha)
    dpa = generated_dpa(w)
    acceptance_row(w, tenant_id=tenant.id)
    acceptance_row(w, dpa=dpa, tenant_id=tenant.id)
    assert dpa.state == "generated"
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


def test_the_agreements_never_name_another_organisation_s_tenant(w):
    foreign = ordered_tenant(w.bravo)
    dpa = generated_dpa(w)
    with pytest.raises(ValueError, match="another organisation"):
        with transaction.atomic():
            checked = legal.check_agreements(
                organisation_id=w.alpha.id,
                pack_code="visio-docs",
                documents=[legal.Accepted(code="cgv", version="0.0", locale="fr")],
                dpa_id=dpa.id,
            )
            legal.record_agreements(
                checked,
                order_id=None,
                tenant_id=foreign.id,
                signatory=legal.Signatory(
                    identity_id=w.owner.identity.id,
                    person_id=w.owner.user.id,
                    email=w.owner.user.email,
                    name="Synthetic Owner",
                    role=None,
                    source_ip=None,
                    user_agent=None,
                ),
                request_id=None,
            )
    assert not Acceptance.objects.exists()
    assert Dpa.objects.get(id=dpa.id).state == "generated"


def test_a_cancelled_order_whose_tenant_lives_on_does_not_count(w):
    # The paid path names the tenant on the DPA too: a guard keyed on the DPA's tenant would let
    # a cancelled order through once its tenant has moved past `ordered`. The acceptances name
    # the order, so this one never counts.
    placed = commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    Order.objects.filter(id=placed.order.id).update(state="cancelled")
    Tenant.objects.filter(id=placed.order.tenant_id).update(status="provisioning")
    assert has_committed_order(organisation_id=w.alpha.id) is False
    assert has_accepted_agreements(organisation_id=w.alpha.id) is False


# --- both workspace operations ask the guard -----------------------------------------------------


def test_the_workspace_is_initialised_on_agreements_accepted_without_an_order(w):
    assert read(w, w.owner).json()["can_initialise"] is False
    refused = initialise(w, w.owner)
    assert refused.status_code == 409, refused.content
    assert refused.json()["allowed_states"] == ["ordered"]

    accept_unbilled(w)

    assert read(w, w.owner).json()["can_initialise"] is True
    created = initialise(w, w.owner, key="00000000-0000-4000-8000-000000000305")
    assert created.status_code == 201, created.content
