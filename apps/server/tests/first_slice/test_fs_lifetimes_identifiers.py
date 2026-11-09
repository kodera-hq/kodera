"""R02 and R07 lifetimes and coherent identifiers: FS-LIFE-01..03 and FS-ID-01..03."""

import pytest
from django.db import IntegrityError, transaction
from first_slice_harness import (
    IDENTITY_HOST,
    ORGANISATION_SLUG_RULE,
    TENANT_SLUG_RULE,
    problem_type,
    scenario,
)


@scenario("FS-LIFE-01")
def test_fs_life_01_removing_or_suspending_one_tenant_leaves_its_sibling_and_realm(harness):
    h = harness
    for kind in ("suspend", "decommission"):
        shared = h.shared_org(kind)
        changed, sibling = shared.tenants
        h.expect(
            h.request_synthetic_provision(shared.staff, changed, kind=kind), 202, "triggerTenantJob"
        )
        h.worker.run_until_idle()
        realm = shared.organisation.intake.slug
        provider = h.identity_provider()
        assert provider.client_login(realm, changed) is False, (
            f"{kind} left the tenant's access working"
        )
        assert provider.client_login(realm, sibling) is True, f"{kind} broke the sibling tenant"
        assert provider.realm_exists(realm), f"{kind} removed the shared realm"
        status = h.api.call(
            "getTenantStatus", principal=shared.organisation.owner, path={"tenant_id": sibling}
        )
        assert h.expect(status, 200, "getTenantStatus")["status"] == "active"


@scenario("FS-LIFE-02")
def test_fs_life_02_retained_records_stay_reachable_after_the_final_tenant_goes(harness):
    h = harness
    h.decision("tenant-scoped-retained-access-window")
    world = h.retained_records()
    other = h.other_org()
    owner = world.organisation.owner
    organisation_id = world.organisation.intake.organisation_id
    h.expect(
        h.request_synthetic_provision(world.staff, world.tenant_id, kind="decommission"),
        202,
        "triggerTenantJob",
    )
    h.worker.run_until_idle()
    assert (
        h.identity_provider().client_login(world.organisation.intake.slug, world.tenant_id) is False
    )
    invoices = h.expect(
        h.api.call("listInvoices", principal=owner, path={"organisation_id": organisation_id}),
        200,
        "listInvoices",
    )
    invoice_id = invoices["items"][0]["id"]
    h.expect(
        h.api.call("getInvoiceDownloadLink", principal=owner, path={"invoice_id": invoice_id}),
        200,
        "getInvoiceDownloadLink",
    )
    stranger = h.api.call(
        "getInvoiceDownloadLink",
        principal=other.organisation.owner,
        path={"invoice_id": invoice_id},
    )
    assert stranger.status_code == 404


@scenario("FS-LIFE-03")
def test_fs_life_03_closure_waits_for_retained_access_and_cannot_resurrect_the_identity(harness):
    h = harness
    h.decision("tenant-scoped-retained-access-window")
    h.decision("post-identity-erasure-one-time-redelivery")
    world = h.retained_records("closing")
    owner = world.organisation.owner
    organisation_id = world.organisation.intake.organisation_id
    h.expect(
        h.request_synthetic_provision(world.staff, world.tenant_id, kind="decommission"),
        202,
        "triggerTenantJob",
    )
    h.worker.run_until_idle()

    blocked = h.close_organisation(
        owner, organisation_id, erase_identity=True, retained_access_alternative=None
    )
    assert blocked.status_code == 409, (
        "closure completed while a retained-access obligation was unresolved"
    )
    assert h.count("Organisation", pk=organisation_id, state="closed") == 0

    completed = h.close_organisation(
        owner, organisation_id, erase_identity=True, retained_access_alternative="approved"
    )
    assert 200 <= completed.status_code < 300, "the approved closure flow did not complete"
    # The owner's token still verifies; the erased identity is unknown to Core (AUTHZ.md §2 step 6).
    me = h.api.call("getMe", principal=owner)
    assert me.status_code == 403, "closure left the owner's access working"
    assert me.json()["type"] == "https://kodera.io/problems/identity-unknown", (
        "closure left the owner's identity resolvable"
    )
    replay = h.claim_first_owner(owner, world.organisation.token)
    old_token = h.claim_first_owner(owner, world.organisation.token, key=h.key("closing/fresh"))
    for name, response in (("replay", replay), ("old bootstrap token", old_token)):
        assert response.status_code in {403, 404, 409, 410}, f"a {name} after closure was accepted"
    assert h.count("Membership", organisation_id=organisation_id, state="active") == 0
    assert h.count("Identity", organisation_id=organisation_id, enabled=True) == 0, (
        "closure left an identity a replay could resurrect"
    )


def _tenant(slug, label):
    return {"slug": slug, "name": f"Synthetic {label}", "locale": "fr"}


@scenario("FS-ID-01")
def test_fs_id_01_every_admitted_slug_shape_authenticates_coherently(harness):
    h = harness
    h.slug_rule("organisation")
    h.slug_rule("tenant")
    minimum, maximum = ORGANISATION_SLUG_RULE
    staff = h.staff()
    namespace = h.namespace
    accepted = {
        "minimum": namespace[:minimum],
        "maximum": (namespace + "x" * maximum)[:maximum],
        "inner-hyphens": f"{namespace[:4]}-{namespace[4:6]}-{namespace[6:8]}",
    }
    for label, slug in accepted.items():
        intake = h.record_intake(staff, label, slug=slug)
        assert intake.slug == slug
        organisation = h.model("Organisation")._base_manager.get(pk=intake.organisation_id)
        assert (organisation.slug, organisation.realm) == (slug, slug)
        assert organisation.issuer.endswith(f"/realms/{slug}")
        h.worker.run_until_idle()
        status = h.read_bootstrap_status(staff, intake.organisation_id)
        assert status["slug"] == slug, (
            "the owner-claim bootstrap does not carry the slug it created"
        )
        discovered = h.api.call("discoverRealm", body={"slug": slug})
        assert h.expect(discovered, 200, "discoverRealm")["realm"] == slug
        assert h.identity_provider().login(slug).issuer == organisation.issuer

    tenant_minimum, tenant_maximum = TENANT_SLUG_RULE
    catalogue = h.publish_catalogue()
    active = h.active_organisation("tenant-slugs")
    for label, slug in {
        "tenant-minimum": ("t" + namespace)[:tenant_minimum],
        "tenant-maximum": (namespace + "y" * tenant_maximum)[:tenant_maximum],
    }.items():
        result = h.expect(
            h.place_order(
                active.owner,
                active.intake.organisation_id,
                catalogue,
                label,
                tenant=_tenant(slug, label),
            ),
            201,
            "placeOrder",
        )
        assert result["tenant"]["slug"] == slug
        h.settle_order(result)
    assert (
        h.console().organisation_slug_rule()
        == h.api.contract["components"]["schemas"]["OrganisationCreateRequest"]["properties"][
            "slug"
        ]["pattern"]
    )


@scenario("FS-ID-02")
def test_fs_id_02_every_invalid_slug_fails_before_any_identity_side_effect(harness):
    h = harness
    h.slug_rule("organisation")
    h.slug_rule("tenant")
    minimum, maximum = ORGANISATION_SLUG_RULE
    staff = h.staff()
    refused = {
        "too-short": "a" * (minimum - 1),
        "too-long": "a" * (maximum + 1),
        "former-21-character-counterexample": "abcdefghij-klmnopqrst",
        "uppercase": "Acme-sa",
        "non-ascii": "acmé-sa",
        "leading-hyphen": "-acme-sa",
        "trailing-hyphen": "acme-sa-",
    }
    for label, slug in refused.items():
        response = h.api.call(
            "createOrganisation",
            principal=staff,
            body=h.intake_body(label, slug=slug),
            idempotency_key=h.key(label),
        )
        assert response.status_code == 422 and problem_type(response) == "validation-error", label
    assert h.count("Organisation") == 0 and h.count("SlugReservation") == 0
    assert h.count("Job") == 0
    for length in (minimum - 1, maximum + 1):
        slug = "b" * length
        with pytest.raises(IntegrityError), transaction.atomic():
            h.model("Organisation")._base_manager.create(
                slug=slug, realm=slug, issuer=f"{IDENTITY_HOST}/realms/{slug}", name="Synthetic"
            )

    tenant_minimum, tenant_maximum = TENANT_SLUG_RULE
    catalogue = h.publish_catalogue()
    active = h.active_organisation("tenant-refusals")
    for label, slug in {
        "tenant-too-short": "t" * (tenant_minimum - 1),
        "tenant-too-long": "t" * (tenant_maximum + 1),
    }.items():
        response = h.place_order(
            active.owner,
            active.intake.organisation_id,
            catalogue,
            label,
            tenant=_tenant(slug, label),
        )
        assert response.status_code == 422 and problem_type(response) == "validation-error", label
    assert h.count("Tenant", organisation_id=active.intake.organisation_id) == 0

    for name in h.reserved_organisation_slugs():
        response = h.api.call(
            "createOrganisation",
            principal=staff,
            body=h.intake_body(f"reserved-{name}", slug=name),
            idempotency_key=h.key(f"reserved/{name}"),
        )
        assert response.status_code == 422, f"the reserved slug {name} was admitted"
    h.record_intake(staff, "ordinary")
    assert h.count("Organisation", slug=h.slug("ordinary")) == 1, "an ordinary slug did not succeed"


@scenario("FS-ID-03")
def test_fs_id_03_the_state_capability_mapping_is_closed_and_exhaustive(harness):
    h = harness
    pending = h.owner_pending("prospect-order")
    prospect_id = pending.intake.organisation_id
    refused = h.api.call(
        "placeOrder",
        principal=pending.owner,
        path={"organisation_id": prospect_id},
        body=h.example("order-request.json"),
        idempotency_key=h.key("prospect-order"),
    )
    assert refused.status_code == 409 and problem_type(refused) == "invalid-state-transition", (
        "a prospect organisation was allowed to order"
    )
    assert "prospect" not in (refused.json().get("allowed_states") or []), (
        "the refusal names prospect among the states that may order"
    )
    assert h.count("Order", organisation_id=prospect_id) == 0

    active = h.active_organisation("ownerless")
    active_id = active.intake.organisation_id
    last_owner = {
        "organisation_id": active_id,
        "membership_id": h.membership_id(active.owner, active_id),
    }
    removal = h.api.call("removeMembership", principal=active.owner, path=last_owner)
    assert removal.status_code == 409 and problem_type(removal) == "last-owner-protected"
    with pytest.raises(IntegrityError), transaction.atomic():
        h.model("Membership")._base_manager.filter(
            organisation_id=active_id, role="org_owner"
        ).update(state="removed")
    assert h.count("Membership", organisation_id=active_id, role="org_owner", state="active") == 1
    assert h.count("Organisation", pk=active_id, state="active") == 1

    decision = h.decision("organisation-states-and-wire-operations")
    contract_states = set(h.api.contract["components"]["schemas"]["OrganisationState"]["enum"])
    persisted_states = {value for value, _ in h.model("Organisation").State.choices}
    assert contract_states == persisted_states, (
        f"{decision.key}: persistence and the contract disagree on the organisation states"
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        h.model("Organisation")._base_manager.filter(pk=active_id).update(state="unknown-state")
