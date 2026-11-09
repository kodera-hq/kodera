"""R05 operation identity and replay: FS-OP-01..06."""

import json

from first_slice_harness import problem_type, scenario


@scenario("FS-OP-01")
def test_fs_op_01_one_intention_is_one_operation_and_one_external_effect(harness):
    h = harness
    h.api.require("createOrganisation")
    staff = h.staff()
    key = h.key("one-intention")
    body = h.intake_body("one-intention")

    def submit():
        return h.api.call("createOrganisation", principal=staff, body=body, idempotency_key=key)

    with h.fault_point("intake:hold-before-commit"):
        concurrent = h.race(submit, submit, submit)
    h.clock.advance(minutes=5)
    delayed = submit()
    completed = []
    in_flight = []
    for response in [*concurrent, delayed]:
        if response.status_code == 409:
            assert problem_type(response) == "idempotency-key-in-flight", (
                "an identical concurrent request conflicted for another reason"
            )
            in_flight.append(response)
            continue
        assert response.status_code in {200, 201}
        completed.append(response)
    assert completed and in_flight, "the held intake produced no in-flight reply to check"
    payloads = [reply.json() for reply in completed]
    assert len({reply["organisation"]["id"] for reply in payloads}) == 1, (
        "one intention produced more than one organisation"
    )
    assert len({reply["bootstrap"]["realm"]["job_id"] for reply in payloads}) == 1
    job_id = payloads[0]["bootstrap"]["realm"]["job_id"]
    job_reference = str(h.model("Job")._base_manager.get(pk=job_id).idempotency_key)
    for response in [*completed, *in_flight]:
        assert h.in_flight_reference(response) == job_reference, (
            "a complete or in-flight reply referenced a different durable operation"
        )
    h.worker.run_until_idle()
    assert (
        h.count("Job", organisation_id=payloads[0]["organisation"]["id"], kind="realm_create") == 1
    )
    assert len(h.identity_provider().realms(body["slug"])) == 1


@scenario("FS-OP-02")
def test_fs_op_02_one_client_key_on_two_targets_is_two_operations(harness):
    h = harness
    shared = h.shared_org("two-targets")
    key = h.key("shared-client-key")
    jobs = [
        h.expect(
            h.request_synthetic_provision(shared.staff, tenant, kind="backup", key=key),
            202,
            "triggerTenantJob",
        )
        for tenant in shared.tenants
    ]
    assert jobs[0]["id"] != jobs[1]["id"], "one client key on two targets became one operation"
    h.worker.run_until_idle()
    assert len({effect.correlation for effect in h.adapters.infrastructure.effects("backup")}) == 2

    with h.weakened("omit-operation-target-from-deduplication"):
        weak = h.shared_org("two-targets-weak")
        weak_key = h.key("weakened-client-key")
        weak_jobs = [
            h.expect(
                h.request_synthetic_provision(weak.staff, tenant, kind="backup", key=weak_key),
                202,
                "triggerTenantJob",
            )
            for tenant in weak.tenants
        ]
        assert weak_jobs[0]["id"] == weak_jobs[1]["id"], (
            "the weakening did not reach deduplication, so this scenario cannot detect it"
        )


@scenario("FS-OP-03")
def test_fs_op_03_an_altered_intention_conflicts_and_a_reserialised_one_does_not(harness):
    h = harness
    catalogue = h.publish_catalogue()
    active = h.active_organisation("altered")
    organisation_id = active.intake.organisation_id
    key = h.key("order")
    first = h.expect(
        h.place_order(active.owner, organisation_id, catalogue, "altered", key=key),
        201,
        "placeOrder",
    )
    alterations = {
        "effect-bearing payload": {"capacity_tier_code": "L"},
        "price reference": {"billing_period": "monthly"},
        "legal reference": {"dpa_acceptance": {"dpa_id": h.key("other-dpa"), "accepted": True}},
    }
    for name, change in alterations.items():
        response = h.place_order(
            active.owner, organisation_id, catalogue, "altered", key=key, **change
        )
        assert response.status_code == 409 and problem_type(response) == "idempotency-key-reuse", (
            name
        )
    body = h.order_body("altered", catalogue, first["order"]["dpa_id"])
    reserialised = json.dumps(dict(reversed(list(body.items()))), indent=3).encode()
    replay = h.api.call(
        "placeOrder",
        principal=active.owner,
        path={"organisation_id": organisation_id},
        raw=reserialised,
        idempotency_key=key,
    )
    assert replay.status_code in {200, 201} and replay.json()["order"]["id"] == first["order"]["id"]
    assert h.count("Order", organisation_id=organisation_id) == 1
    h.adapters.require_bound("invoice")
    assert len(h.adapters.invoice.effects("issue")) == 1


@scenario("FS-OP-04")
def test_fs_op_04_replay_reauthorises_before_reading_stored_output(harness):
    h = harness
    catalogue = h.publish_catalogue()
    other = h.other_org("elsewhere")
    for change in ("revoked", "moved", "demoted", "unchanged"):
        active = h.active_organisation(change)
        organisation_id = active.intake.organisation_id
        requester = h.add_member(active, "org_owner", f"second-{change}")
        key = h.key(f"stored/{change}")
        stored = h.expect(
            h.place_order(requester, organisation_id, catalogue, change, key=key), 201, "placeOrder"
        )
        path = {"organisation_id": organisation_id}
        membership = {**path, "membership_id": h.membership_id(requester, organisation_id)}
        if change == "revoked":
            h.expect_ok(
                h.api.call("removeMembership", principal=active.owner, path=membership),
                "removeMembership",
            )
        elif change == "moved":
            path = {"organisation_id": other.organisation.intake.organisation_id}
        elif change == "demoted":
            h.expect_ok(
                h.api.call(
                    "changeMembershipRole",
                    principal=active.owner,
                    path=membership,
                    body={"role": "org_member"},
                ),
                "changeMembershipRole",
            )
        replay = h.api.call(
            "placeOrder",
            principal=requester,
            path=path,
            body=h.order_body(change, catalogue, stored["order"]["dpa_id"]),
            idempotency_key=key,
        )
        if change == "unchanged":
            assert (
                replay.status_code in {200, 201}
                and replay.json()["order"]["id"] == stored["order"]["id"]
            )
        else:
            assert replay.status_code in {401, 403, 404}, (
                f"a {change} requester replayed stored output"
            )
            assert stored["order"]["id"] not in replay.content.decode(), (
                f"a {change} replay leaked the order"
            )

    with h.weakened("remove-organisation-scoping"):
        scoped = h.active_organisation("unscoped")
        unscoped_key = h.key("unscoped")
        stored = h.expect(
            h.place_order(
                scoped.owner,
                scoped.intake.organisation_id,
                catalogue,
                "unscoped",
                key=unscoped_key,
            ),
            201,
            "placeOrder",
        )
        leaked = h.api.call(
            "placeOrder",
            principal=scoped.owner,
            path={"organisation_id": other.organisation.intake.organisation_id},
            body=h.order_body("unscoped", catalogue, stored["order"]["dpa_id"]),
            idempotency_key=unscoped_key,
        )
        assert stored["order"]["id"] in leaked.content.decode(), (
            "the weakening did not reach organisation scoping, so this scenario cannot detect it"
        )


@scenario("FS-OP-05")
def test_fs_op_05_an_expired_response_cache_never_makes_a_second_effect(harness):
    h = harness
    h.decision("operation-scope-and-dedup-retention")
    catalogue = h.publish_catalogue()
    world = h.ordered("expired-cache")
    organisation_id = world.organisation.intake.organisation_id
    h.clock.advance(hours=25)
    retry = h.place_order(world.organisation.owner, organisation_id, catalogue, "expired-cache")
    if retry.status_code in {200, 201}:
        assert retry.json()["order"]["id"] == world.order["order"]["id"]
    else:
        assert retry.status_code in {409, 410}, (
            "an expired operation was treated as a new intention"
        )
    assert h.count("Order", organisation_id=organisation_id) == 1
    assert h.count("Job", tenant_id=world.tenant_id, kind="provision") == 1
    h.adapters.require_bound("invoice")
    assert len(h.adapters.invoice.effects("issue")) == 1


@scenario("FS-OP-06")
def test_fs_op_06_no_secret_persists_in_results_and_lost_delivery_is_revoked_and_reissued(harness):
    h = harness
    h.decision("mfa-contact-proof-and-claim-delivery")
    pending = h.owner_pending("secret")
    status = h.read_bootstrap_status(pending.staff, pending.intake.organisation_id)
    assert pending.token not in json.dumps(status), "the bootstrap view carries the claim token"
    assert h.stored_anywhere(pending.token) == [], "the claim token plaintext is persisted"
    owner = h.identities.with_second_factor(pending.owner)
    h.expect(h.claim_first_owner(owner, pending.token), 200, "consumeOwnerClaim")
    assert h.stored_anywhere(pending.token) == [], (
        "the claim response left its token in replay storage"
    )

    lost = h.owner_pending("lost-delivery")
    h.revoke_claim(lost.staff, lost.intake.organisation_id)
    reissued = h.adapters.claim_token(lost.intake.intended_owner_email)
    assert reissued != lost.token
    stale = h.claim_first_owner(
        h.identities.with_second_factor(lost.owner), lost.token, key=h.key("stale")
    )
    assert stale.status_code == 410

    world = h.ordered("links")
    invoice_id = world.order["invoice"]["id"]
    owner_link = h.api.call(
        "getInvoiceDownloadLink",
        principal=world.organisation.owner,
        path={"invoice_id": invoice_id},
    )
    h.expect(owner_link, 200, "getInvoiceDownloadLink")
    stranger = h.other_org("links-stranger").organisation.owner
    assert (
        h.api.call(
            "getInvoiceDownloadLink", principal=stranger, path={"invoice_id": invoice_id}
        ).status_code
        == 404
    )
