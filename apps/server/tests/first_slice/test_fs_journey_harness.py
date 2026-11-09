"""Full internal journey and proof quality: FS-JOURNEY-01 and FS-HARNESS-01."""

import json
import socket
import time

import pytest
from first_slice_harness import (
    ExternalConnectionError,
    SelectionError,
    collect_population,
    disposable_copy,
    manifest_ids,
    population_problems,
    public_jwk,
    run_runners,
    scenario,
    select_case,
    verdict,
)

RUNNER_TARGET = "tests/first_slice/test_fs_bootstrap.py"


@scenario("FS-JOURNEY-01")
def test_fs_journey_01_intake_to_observed_synthetic_provision_is_one_coherent_history(harness):
    h = harness
    h.decision("place-order-staff-operator-and-dpa-acceptance")
    world = h.empty_customer()
    intake = h.record_intake(world.staff, "journey")
    h.worker.run_until_idle()
    status = h.read_bootstrap_status(world.staff, intake.organisation_id)
    owner = h.identities.with_second_factor(h.bound_owner(intake, status))
    h.expect(
        h.claim_first_owner(owner, h.adapters.claim_token(intake.intended_owner_email)),
        200,
        "consumeOwnerClaim",
    )
    result = h.expect(
        h.place_order(owner, intake.organisation_id, world.catalogue, "journey"), 201, "placeOrder"
    )
    job = h.expect(
        h.request_synthetic_provision(world.staff, result["tenant"]["id"]), 202, "triggerTenantJob"
    )
    h.worker.run_until_idle()
    assert h.read_operation(world.staff, job["id"])["status"] == "succeeded"
    tenant = h.expect(
        h.api.call("getTenantStatus", principal=owner, path={"tenant_id": result["tenant"]["id"]}),
        200,
        "getTenantStatus",
    )
    h.adapters.require_bound("infrastructure")
    assert len(h.adapters.infrastructure.effects("provision")) == 1
    assert h.refused_connections == [], "the journey reached for a real cloud endpoint"
    history = h.audit_actions(intake.organisation_id)
    assert history.index("organisation.intake_recorded") < history.index("owner_claim.consumed")
    assert history.index("membership.created") < history.index("organisation.activated")
    assert h.console().displayed_tenant_status(result["tenant"]["id"]) == tenant["status"]


@scenario("FS-HARNESS-01")
def test_fs_harness_01_the_runner_refuses_before_reporting_acceptance(harness):
    h = harness
    ids = list(h.inventory.ids)
    manifest = manifest_ids()
    count = h.inventory.required_count

    assert (
        population_problems(
            inventory_ids=ids, collected=ids, manifest=manifest, required_count=count
        )
        == []
    )
    label, message = verdict(
        h.inventory.row("FS-BOOT-03"), outcome="skipped", wasxfail=False, exc=None, xpass=False
    )
    assert (
        label == "failed" and message is not None and message.startswith("FS-BOOT-03 was skipped")
    )
    with pytest.raises(SelectionError, match="names no mandatory first-slice scenario"):
        select_case("FS-BOOT-99", ids)

    # The actual runner, in a disposable copy: a valid environment runs, and a configured external
    # endpoint, a public identity issuer or an unavailable PostgreSQL refuses before any report.
    root = disposable_copy(h.scratch("runner") / "repo")
    with socket.socket() as spare:
        spare.bind(("127.0.0.1", 0))
        closed_port = spare.getsockname()[1]
    public_trust = json.dumps(
        [
            {
                "lane": "customer",
                "issuer": "https://login.example.com/realms/acme-sa",
                "generation": "runner-refusal",
                "expires_at": int(time.time()) + 86400,
                "public_jwks": {"keys": [public_jwk("runner-refusal")]},
            }
        ]
    )
    case = {"FIRST_SLICE_CASE": "FS-BOOT-02"}
    expected = {
        "valid": ({}, 0, "1 xfail, 32 not run (of 33 mandatory)"),
        "provider-endpoint": (
            {"KODERA_INVOICE_PROVIDER_URL": "https://invoices.example.com/v1"},
            4,
            "an external provider endpoint is configured: KODERA_INVOICE_PROVIDER_URL names "
            "invoices.example.com",
        ),
        "public-issuer": (
            {"KODERA_AUTH_TRUST": public_trust},
            4,
            "a public identity issuer is configured: login.example.com",
        ),
        "database-unavailable": (
            {"DATABASE_URL": f"postgres://kodera:kodera@127.0.0.1:{closed_port}/kodera_server"},
            4,
            f"a dependency is unavailable: PostgreSQL at 127.0.0.1:{closed_port} does not accept "
            "connections",
        ),
    }
    runs = run_runners(
        root,
        {name: {**case, **extra} for name, (extra, _, _) in expected.items()},
        [RUNNER_TARGET],
    )
    for name, (_, status, sentence) in expected.items():
        result = runs[name]
        assert result.status == status and sentence in result.output, (
            f"runner {name}: exit {result.status}, expected {status} with {sentence!r}\n"
            f"{result.output[-3000:]}"
        )

    # A removed scenario, found by the runner's own collection of the copy.
    source = root / RUNNER_TARGET
    text = source.read_text(encoding="utf-8")
    start, end = text.index('@scenario("FS-BOOT-03")'), text.index('@scenario("FS-BOOT-04")')
    source.write_text(text[:start] + text[end:], encoding="utf-8")
    report = collect_population(root / "tests/first_slice", cwd=root)
    assert population_problems(
        inventory_ids=ids,
        collected=[entry["id"] for entry in report["scenarios"]],
        manifest=manifest,
        malformed=report["malformed"],
        unmarked=report["unmarked"],
        required_count=count,
    ) == ["FS-BOOT-03 is in the inventory but no collected test carries it"]

    with socket.socket() as probe, pytest.raises(ExternalConnectionError):
        probe.connect(("192.0.2.10", 443))
    assert h.refused_connections == ["('192.0.2.10', 443)"]

    h.admit_services()
