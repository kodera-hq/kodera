"""R06 commercial effects and invoice authority: FS-BILL-01..06."""

from first_slice_harness import scenario

PLACE_ORDER_DECISION = "place-order-staff-operator-and-dpa-acceptance"


def _total(order):
    money = order["price_snapshot"]["total_incl_vat"]
    return money["amount_minor"], money["currency"]


@scenario("FS-BILL-01")
def test_fs_bill_01_a_committed_order_survives_a_dispatcher_crash_into_one_invoice_request(harness):
    h = harness
    h.decision(PLACE_ORDER_DECISION)
    catalogue = h.publish_catalogue()
    active = h.active_organisation("dispatch")
    organisation_id = active.intake.organisation_id
    with h.fault_point("dispatcher:before-adapter-call"):
        result = h.expect(
            h.place_order(active.owner, organisation_id, catalogue, "dispatch"), 201, "placeOrder"
        )
    assert result["billing_pending"] is True
    assert h.count("Order", organisation_id=organisation_id) == 1
    assert h.count("DpaAcceptance", organisation_id=organisation_id) == 1
    assert h.count("OutboxDelivery", status="pending") == 1
    h.adapters.require_bound("invoice")
    assert h.adapters.invoice.effects() == ()
    order = h.expect(
        h.api.call("getOrder", principal=active.owner, path={"order_id": result["order"]["id"]}),
        200,
        "getOrder",
    )
    assert order["invoice_id"] is None, "the console was shown an invoice before one was observed"
    h.worker.restart_dispatcher()
    (effect,) = h.adapters.invoice.effects("issue")
    assert effect.correlation == result["order"]["id"]


@scenario("FS-BILL-02")
def test_fs_bill_02_a_lost_issuance_response_is_found_by_correlation_not_reissued(harness):
    h = harness
    world = h.delivery_unknown()
    correlation = world.order["order"]["id"]
    h.worker.restart_dispatcher()
    (issued,) = h.adapters.invoice.lookup(correlation)
    assert h.model("Invoice")._base_manager.get(order_id=correlation).number == issued.reference

    manual = h.delivery_unknown("without-lookup")
    h.adapters.invoice.without("lookup")
    h.worker.restart_dispatcher()
    reissued = [
        e
        for e in h.adapters.invoice.effects("issue")
        if e.correlation == manual.order["order"]["id"]
    ]
    assert len(reissued) == 1, "without a lookup capability the dispatcher guessed and issued again"
    assert h.count("OutboxDelivery", status="needs_reconciliation") == 1


@scenario("FS-BILL-03")
def test_fs_bill_03_the_provider_number_is_the_only_invoice_number(harness):
    h = harness
    world = h.ordered("numbering")
    h.adapters.require_bound("invoice")
    with h.fault_point("dispatcher:after-adapter-call-before-local-commit"):
        h.worker.restart_dispatcher()
    h.worker.restart_dispatcher()
    (effect,) = h.adapters.invoice.effects("issue")
    invoice = h.model("Invoice")._base_manager.get(order_id=world.order["order"]["id"])
    assert invoice.number == effect.reference, (
        "Core numbered or renumbered an invoice the provider issued"
    )


@scenario("FS-BILL-04")
def test_fs_bill_04_only_valid_payment_events_converge_and_none_marks_the_wrong_order(harness):
    h = harness
    world = h.ordered("payments")
    reference = world.order["order"]["id"]
    amount, currency = _total(world.order["order"])
    payment = h.adapters.payment
    pending = payment.event(
        reference=reference, amount_cents=amount, currency=currency, kind="payment.pending"
    )
    succeeded = payment.event(reference=reference, amount_cents=amount, currency=currency)
    for event in (succeeded, succeeded, pending):
        h.deliver_payment_event(event)
    assert h.count("Payment", order_id=reference, status="verified") == 1, (
        "repeated or reordered events diverged"
    )

    other = h.other_org("payments-other")
    elsewhere = other.order["order"]["id"]
    invalid = (
        payment.event(reference=elsewhere, amount_cents=amount, valid_signature=False),
        payment.event(reference=elsewhere, amount_cents=amount, account="acct_elsewhere"),
        payment.event(reference=elsewhere, amount_cents=amount, currency="USD"),
        payment.event(reference=elsewhere, amount_cents=amount + 1, currency=currency),
        payment.event(reference=h.key("unknown-reference"), amount_cents=amount, currency=currency),
    )
    for event in invalid:
        h.deliver_payment_event(event)
    assert h.count("Payment", order_id=elsewhere, status="verified") == 0

    for event in (succeeded, pending, *invalid):
        evidence = h.payment_inbox_evidence(event.event_id)
        assert evidence is not None, f"payment event {event.event_id} left no retained evidence"
    outcomes = {h.payment_inbox_evidence(event.event_id)["outcome"] for event in invalid}
    assert outcomes <= {"rejected", "needs_review"}, "an invalid or unknown event was accepted"
    assert h.stored_anywhere(payment.secret_hex()) == [], "the inbox retained a signing credential"


@scenario("FS-BILL-05")
def test_fs_bill_05_a_browser_return_or_unauthenticated_success_starts_nothing(harness):
    h = harness
    catalogue = h.publish_catalogue()
    active = h.active_organisation("return-url")
    result = h.expect(
        h.place_order(active.owner, active.intake.organisation_id, catalogue, "return-url"),
        201,
        "placeOrder",
    )
    reference, tenant_id = result["order"]["id"], result["tenant"]["id"]
    amount, currency = _total(result["order"])
    h.deliver_payment_return({"order": reference, "status": "paid"})
    h.deliver_payment_event(
        h.adapters.payment.event(
            reference=reference, amount_cents=amount, currency=currency, valid_signature=False
        )
    )
    assert h.count("Payment", order_id=reference, status="verified") == 0
    assert h.count("Job", tenant_id=tenant_id) == 0
    h.deliver_payment_event(
        h.adapters.payment.event(reference=reference, amount_cents=amount, currency=currency)
    )
    assert h.count("Payment", order_id=reference, status="verified") == 1
    assert h.count("Job", tenant_id=tenant_id) == 0, (
        "a verified payment started provisioning without staff"
    )

    with h.weakened("accept-unauthenticated-payment-status"):
        unverified = h.active_organisation("unverified-return")
        order = h.expect(
            h.place_order(
                unverified.owner, unverified.intake.organisation_id, catalogue, "unverified"
            ),
            201,
            "placeOrder",
        )
        h.deliver_payment_return({"order": order["order"]["id"], "status": "paid"})
        assert h.count("Payment", order_id=order["order"]["id"], status="verified") == 1, (
            "the weakening did not reach payment authentication, so this scenario cannot detect it"
        )


@scenario("FS-BILL-06")
def test_fs_bill_06_accepted_price_and_legal_evidence_is_immutable(harness):
    h = harness
    h.decision(PLACE_ORDER_DECISION)
    catalogue = h.publish_catalogue()
    active = h.active_organisation("snapshot")
    organisation_id = active.intake.organisation_id
    key = h.key("snapshot")
    first = h.expect(
        h.place_order(active.owner, organisation_id, catalogue, "snapshot", key=key),
        201,
        "placeOrder",
    )
    h.publish_catalogue()
    order = h.expect(
        h.api.call("getOrder", principal=active.owner, path={"order_id": first["order"]["id"]}),
        200,
        "getOrder",
    )
    assert order["price_snapshot"] == first["order"]["price_snapshot"]
    assert order["dpa_id"] == first["order"]["dpa_id"]
    retry = h.place_order(
        active.owner, organisation_id, catalogue, "snapshot", key=key, billing_period="monthly"
    )
    assert retry.status_code == 409, "a retry with different values changed an accepted intention"
