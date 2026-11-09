"""Self-tests of the first-slice harness. Each proves that a guard the scenarios rely on can refuse.

None of these is a scenario. The first is the population check: the set of collected scenario
identifiers must equal the inventory and the manifest, so deleting, renaming or duplicating a
scenario turns CI red by name. The rest hold each harness seam to a positive control, because a
harness that reported every operation missing would keep all thirty-three honestly red for ever,
and each measured seam to the change that must turn its gap into a failure.
"""

import ast
import dataclasses
import json
import os
import socket
import threading
import time
import uuid
from datetime import timedelta

import pytest
from django.db import connection
from django.http import HttpResponse
from django.urls import path
from first_slice_harness import (
    HERE,
    INVENTORY_PATH,
    ORGANISATION_SLUG_SCHEMAS,
    REQUIRED_WEAKENINGS,
    ROOT,
    STATES,
    T0,
    TENANT_SLUG_SCHEMAS,
    BlockedOnDecisionError,
    CapabilityUnavailableError,
    Decisions,
    ExternalConnectionError,
    InfrastructureAdapter,
    InjectedFailureError,
    InventoryError,
    InvoiceAdapter,
    LostResponseError,
    MailAdapter,
    MissingBehaviourError,
    NonRetryableFailureError,
    PaymentAdapter,
    ScenarioRow,
    Worker,
    admission_refusals,
    catalogue_write_surface,
    collect_population,
    contract_slug_patterns,
    contract_write_operations,
    failure_summary,
    incomplete_population,
    installed_model_names,
    is_loopback,
    load_inventory,
    local_identity_issuers,
    manifest_ids,
    population_problems,
    realm_update_request_surface,
    slug_rule_disagreements,
    verdict,
    worker_steps_unbound,
)

from dev.first_slice_bootstrap import load_contract
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

BASE = INVENTORY_PATH.read_text(encoding="utf-8")
SCENARIO_FILES = sorted(HERE.glob("test_fs_*.py"))


def _teapot(request):
    return HttpResponse(status=418)


def _refuses_the_method(request):
    return HttpResponse(status=405)


# Served only while a test points ROOT_URLCONF at this module: the positive control for the
# harness's routing measurement.
urlpatterns = [
    path("api/v1/organisations", _teapot),
    path("api/v1/owner-claims/actions/consume", _refuses_the_method),
]


def _operations():
    contract = load_contract(ROOT)
    return {
        operation.get("operationId")
        for item in contract["paths"].values()
        if isinstance(item, dict)
        for operation in item.values()
        if isinstance(operation, dict)
    }


def _environment(**changes):
    environment = {"DATABASE_URL": os.environ.get("DATABASE_URL", "")}
    if not environment["DATABASE_URL"]:
        environment.pop("DATABASE_URL")
    environment.update(changes)
    return environment


def _trust(issuer):
    return json.dumps([{"lane": "customer", "issuer": issuer}])


# ------------------------------------------------------------------------- population ----


def test_collected_scenarios_equal_the_inventory_and_the_manifest():
    inventory = load_inventory(BASE)
    report = collect_population(HERE)
    problems = population_problems(
        inventory_ids=inventory.ids,
        collected=[entry["id"] for entry in report["scenarios"]],
        manifest=manifest_ids(),
        malformed=report["malformed"],
        unmarked=report["unmarked"],
        required_count=inventory.required_count,
    )
    assert not problems, (
        "the collected first-slice scenarios disagree with the inventory:\n" + "\n".join(problems)
    )


def test_the_inventory_is_well_formed_and_states_every_scenario_honestly():
    inventory = load_inventory(BASE)
    assert inventory.required_count == 33 and len(inventory.rows) == 33
    assert {row.state for row in inventory.rows} <= set(STATES)
    for row in inventory.rows:
        if row.state == "blocked":
            assert inventory.decisions[str(row.gap).removeprefix("decision:")].status == "open", (
                row.id
            )


INVENTORY_REFUSALS = [
    (
        "duplicate",
        'id = "FS-BOOT-02"',
        'id = "FS-BOOT-01"',
        "FS-BOOT-01 appears more than once in the inventory",
    ),
    (
        "xfail-without-gap",
        'gap = "harness:identity-provider-second-factor"\nreason = "Core declares the three fault',
        'reason = "Core declares the three fault',
        "FS-BOOT-02 (xfail) must carry exactly",
    ),
    (
        "blocked-without-decision",
        'gap = "decision:post-identity-erasure-one-time-redelivery"\nreason = "audited',
        'gap = "operation:retainedAccess"\nreason = "audited',
        "FS-LIFE-03 is blocked but its gap names no decision",
    ),
    (
        "red-on-a-decided-decision",
        'source = "first-slice FS-D3; docs/specs/FIRST_SLICE_G1.md"\nstatus = "open"',
        'source = "first-slice FS-D3; docs/specs/FIRST_SLICE_G1.md"\nstatus = "decided"',
        "FS-LIFE-03 is red on decision post-identity-erasure-one-time-redelivery, which the "
        "inventory records as decided",
    ),
    (
        "unknown-state",
        'id = "FS-OP-01"\ngroup = "R05 operation identity and replay"\nstate = "xfail"',
        'id = "FS-OP-01"\ngroup = "R05 operation identity and replay"\nstate = "skip"',
        "FS-OP-01 has state 'skip'",
    ),
    (
        "pass-with-a-gap",
        'id = "FS-OP-01"\ngroup = "R05 operation identity and replay"\nstate = "xfail"',
        'id = "FS-OP-01"\ngroup = "R05 operation identity and replay"\nstate = "pass"',
        "FS-OP-01 (pass) must carry exactly",
    ),
    (
        "count",
        "required_count = 33",
        "required_count = 34",
        "the inventory holds 33 scenarios; ACCEPTANCE.md requires 34",
    ),
    (
        "malformed-gap",
        'gap = "harness:identity-provider-admission"',
        'gap = "identity-provider-admission"',
        "FS-HARNESS-01 has a malformed gap",
    ),
    (
        "unlisted-decision",
        'gap = "decision:post-identity-erasure-one-time-redelivery"\nreason = "audited',
        'gap = "decision:retained-access"\nreason = "audited',
        "FS-LIFE-03 names decision retained-access, which is not listed",
    ),
]


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [row[1:] for row in INVENTORY_REFUSALS],
    ids=[row[0] for row in INVENTORY_REFUSALS],
)
def test_a_malformed_inventory_is_refused_by_name(old, new, message):
    assert BASE.count(old) == 1, "the refusal's anchor no longer matches the inventory exactly once"
    with pytest.raises(InventoryError) as refused:
        load_inventory(BASE.replace(old, new))
    assert message in str(refused.value)


def test_population_problems_name_every_disagreement():
    ids = ["FS-BOOT-01", "FS-BOOT-02"]
    assert (
        population_problems(inventory_ids=ids, collected=ids, manifest=ids, required_count=2) == []
    )
    assert population_problems(
        inventory_ids=ids,
        collected=["FS-BOOT-01", "FS-BOOT-01", "FS-BOOT-09"],
        manifest=["FS-BOOT-01", "FS-BOOT-03"],
        malformed=["a.py::x"],
        unmarked=["b.py::y"],
        required_count=3,
    ) == [
        "a.py::x carries a malformed scenario identifier",
        "b.py::y is a scenario-file test with no scenario identifier",
        "FS-BOOT-02 is in the inventory but no collected test carries it",
        "FS-BOOT-01 is collected by 2 tests; a scenario is exactly one test",
        "FS-BOOT-09 is collected but absent from the inventory",
        "FS-BOOT-03 is in dev/first_slice_manifest.json but not the inventory",
        "FS-BOOT-02 is in the inventory but not dev/first_slice_manifest.json",
        "the inventory holds 2 scenarios; it requires 3",
    ]


def test_an_incomplete_population_names_what_was_deselected_and_what_never_ran():
    ids = ("FS-BOOT-01", "FS-BOOT-02", "FS-BOOT-03")
    assert incomplete_population(ids, {"FS-BOOT-01", "FS-BOOT-02", "FS-BOOT-03"}, set()) is None
    assert incomplete_population(ids, {"FS-BOOT-01"}, {"FS-BOOT-03"}) == (
        "first-slice population incomplete: deselected FS-BOOT-03; never collected or never run "
        "FS-BOOT-02. Every mandatory scenario must run; FIRST_SLICE_CASE runs exactly one."
    )


def test_verdict_accepts_only_the_recorded_gap_and_refuses_skips():
    xfail = ScenarioRow("FS-OP-01", "g", "xfail", "operation:createOrganisation", "r")
    blocked = ScenarioRow(
        "FS-ID-03", "g", "blocked", "decision:organisation-states-and-wire-operations", "r"
    )
    passing = ScenarioRow("FS-BOOT-01", "g", "pass", None, None)
    recorded = MissingBehaviourError("operation:createOrganisation", "d")
    assert verdict(xfail, outcome="skipped", wasxfail=True, exc=recorded, xpass=False) == (
        "xfail",
        None,
    )
    label, message = verdict(
        xfail,
        outcome="skipped",
        wasxfail=True,
        exc=MissingBehaviourError("operation:placeOrder", "d"),
        xpass=False,
    )
    assert label == "failed" and message is not None
    assert message.startswith(
        "FS-OP-01 is red for a reason the inventory does not record: expected gap "
        "'operation:createOrganisation', observed 'operation:placeOrder'"
    )
    label, message = verdict(
        xfail, outcome="skipped", wasxfail=True, exc=pytest.xfail.Exception("x"), xpass=False
    )
    assert label == "failed" and message is not None and "observed None" in message
    decision = BlockedOnDecisionError("organisation-states-and-wire-operations", "d")
    assert verdict(blocked, outcome="skipped", wasxfail=True, exc=decision, xpass=False) == (
        "blocked",
        None,
    )
    label, message = verdict(passing, outcome="skipped", wasxfail=False, exc=None, xpass=False)
    assert (
        label == "failed" and message is not None and message.startswith("FS-BOOT-01 was skipped")
    )
    assert verdict(xfail, outcome="failed", wasxfail=False, exc=None, xpass=True) == (
        "passed unexpectedly",
        None,
    )
    assert verdict(passing, outcome="passed", wasxfail=False, exc=None, xpass=False) == (
        "passed",
        None,
    )


def test_a_failure_is_summarised_by_what_actually_failed():
    assert failure_summary(ModuleNotFoundError("No module named 'kodera'")) == (
        "ModuleNotFoundError: No module named 'kodera'"
    )
    assert failure_summary(MissingBehaviourError("operation:placeOrder", "not routed")) == (
        "operation:placeOrder: not routed"
    )
    assert failure_summary(None) == ""


# -------------------------------------------------------------------------- admission ----


def test_admission_refuses_external_endpoints_public_issuers_and_an_unavailable_database():
    assert admission_refusals(_environment()) == [], "the positive control was refused"
    assert (
        admission_refusals(
            _environment(
                KODERA_INVOICE_PROVIDER_URL="https://invoices.acceptance.test/v1",
                KODERA_AUTH_TRUST=_trust("http://127.0.0.1:8080/realms/acme-sa"),
                GITHUB_SERVER_URL="https://github.com",
            )
        )
        == []
    ), "a local provider, a loopback issuer or an unrelated URL was refused"
    assert admission_refusals(
        _environment(
            KODERA_INVOICE_PROVIDER_URL="https://invoices.example.com/v1",
            KODERA_AUTH_TRUST=_trust("https://login.example.com/realms/acme-sa"),
        )
    ) == [
        "an external provider endpoint is configured: KODERA_INVOICE_PROVIDER_URL names "
        "invoices.example.com",
        "a public identity issuer is configured: login.example.com",
    ]
    with socket.socket() as spare:
        spare.bind(("127.0.0.1", 0))
        port = spare.getsockname()[1]
    assert admission_refusals(
        {"DATABASE_URL": f"postgres://kodera:kodera@127.0.0.1:{port}/kodera_server"}
    ) == [
        f"a dependency is unavailable: PostgreSQL at 127.0.0.1:{port} does not accept connections"
    ]
    assert admission_refusals(_environment(KODERA_AUTH_TRUST="not json")) == [
        "KODERA_AUTH_TRUST is not a parseable trust list"
    ]


# ------------------------------------------------------------------------- the seams ----


def test_an_unrouted_operation_is_a_gap_and_a_routed_one_is_driven(harness, settings):
    # The real consume route exists and still requires production authentication.
    assert harness.api.call("consumeOwnerClaim", body={}).status_code == 401
    import types

    missing_routes = types.ModuleType("first_slice_missing_consume_route")
    missing_routes.urlpatterns = []
    settings.ROOT_URLCONF = missing_routes
    with pytest.raises(MissingBehaviourError) as absent:
        harness.api.call("consumeOwnerClaim", body={})
    assert absent.value.gap == "operation:consumeOwnerClaim"
    settings.ROOT_URLCONF = __name__
    assert harness.api.call("createOrganisation", body={}).status_code == 418
    with pytest.raises(MissingBehaviourError, match="does not accept POST") as refused:
        harness.api.call("consumeOwnerClaim", body={})
    assert refused.value.gap == "operation:consumeOwnerClaim"


def test_the_harness_drives_the_real_routed_api_through_production_authentication(harness):
    customer = harness.identities.customer("acme-sa", "person")
    response = harness.api.call("getMe", principal=customer)
    # The token verifies through production authentication; Core holds no identity for it.
    assert response.status_code == 403, "an unknown customer was not refused by the real /me view"
    assert response.headers["Content-Type"].startswith("application/problem+json")
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"


def test_a_missing_model_is_a_gap_and_an_installed_one_is_counted_in_postgres(harness, monkeypatch):
    from django.apps import apps

    installed = tuple(apps.get_models())
    assert any(model.__name__ == "OwnerClaim" for model in installed)
    with monkeypatch.context() as missing:
        missing.setattr(
            apps,
            "get_models",
            lambda: [model for model in installed if model.__name__ != "OwnerClaim"],
        )
        with pytest.raises(MissingBehaviourError) as absent:
            harness.count("OwnerClaim")
        assert absent.value.gap == "record:OwnerClaim"
        assert harness.count_if_present("OwnerClaim") == 0
    assert harness.count("OwnerClaim") == 0
    assert harness.count("Organisation") == 0
    assert connection.vendor == "postgresql"
    assert str(connection.settings_dict["NAME"]).startswith("test_"), (
        "the harness reached a database it does not own"
    )


def test_an_open_decision_blocks_by_name_and_a_decided_one_does_not():
    old = 'its effect column admits local synthetic tests before it"\nstatus = "open"'
    assert BASE.count(old) == 1
    decisions = Decisions(load_inventory(BASE.replace(old, old.replace('"open"', '"decided"'))))
    with pytest.raises(BlockedOnDecisionError) as blocked:
        decisions.require("post-identity-erasure-one-time-redelivery")
    assert blocked.value.gap == "decision:post-identity-erasure-one-time-redelivery"
    assert decisions.require("tenant-scoped-retained-access-window").status == "decided"
    assert decisions.require("invoice-issuer-and-reconciliation").status == "decided"
    with pytest.raises(AssertionError, match="which the inventory lacks"):
        decisions.require("nonexistent")


def test_the_signed_fixture_is_verified_by_production_code_and_never_mints_a_second_factor(
    harness, settings
):
    identities = harness.identities
    customer = identities.customer("acme-sa", "person")
    verified, lane = verify_configured_token(
        identities.bearer(customer), trusted=settings.KODERA_AUTH_TRUST
    )
    assert lane == "customer" and verified.subject == customer.subject
    assert (verified.amr, verified.acr, verified.auth_time) == (None, None, None)
    staff = harness.staff()
    assert (
        verify_configured_token(identities.bearer(staff), trusted=settings.KODERA_AUTH_TRUST)[1]
        == "staff"
    )
    with pytest.raises(TokenVerificationError):
        verify_configured_token(
            identities.bearer(identities.untrusted("acme-sa", "stranger")),
            trusted=settings.KODERA_AUTH_TRUST,
        )
    with pytest.raises(MissingBehaviourError) as missing:
        identities.with_second_factor(customer)
    assert missing.value.gap == "harness:identity-provider-second-factor"


def test_synthetic_adapters_record_hold_inject_and_correlate():
    invoice = InvoiceAdapter()
    first = invoice.issue("order-1", {"amount": 1})
    assert first.reference == "SYN-INV-000001" and invoice.lookup("order-1") == (first,)
    invoice.inject("before-effect", InjectedFailureError)
    with pytest.raises(InjectedFailureError):
        invoice.issue("order-2", {})
    assert invoice.lookup("order-2") == ()
    invoice.inject("after-effect", LostResponseError)
    with pytest.raises(LostResponseError):
        invoice.issue("order-3", {})
    assert [effect.reference for effect in invoice.lookup("order-3")] == ["SYN-INV-000002"]
    invoice.issue("order-1", {"amount": 1})
    assert len(invoice.lookup("order-1")) == 2, (
        "the ledger must show a duplicate effect, never hide it"
    )

    hold = invoice.hold("before-effect")
    done = []
    worker = threading.Thread(target=lambda: done.append(invoice.issue("order-4", {})))
    worker.start()
    assert hold.wait_reached() and invoice.lookup("order-4") == ()
    hold.release()
    worker.join(10)
    assert len(done) == 1 and invoice.lookup("order-4") == (done[0],)
    invoice.without("lookup")
    with pytest.raises(CapabilityUnavailableError):
        invoice.lookup("order-1")

    payment = PaymentAdapter()
    good = payment.event(reference="order-1", amount_cents=100)
    forged = payment.event(reference="order-1", amount_cents=100, valid_signature=False)
    assert payment.verify(good.body, good.signature) and not payment.verify(
        forged.body, forged.signature
    )
    assert [effect.correlation for effect in payment.effects("emit")] == [
        good.event_id,
        forged.event_id,
    ]

    mail = MailAdapter()
    token = "own_" + "A" * 43
    mail.deliver("owner@acme.acceptance.test", "Claim", f"Your claim: {token}")
    assert token not in json.dumps(mail.redacted())
    assert token not in json.dumps([dataclasses.asdict(effect) for effect in mail.effects()])
    assert token in mail.take("owner@acme.acceptance.test").body

    targeted = InfrastructureAdapter()
    targeted.inject("before-effect", NonRetryableFailureError, correlation="job-failing")
    try:
        survivor = targeted.provision("job-surviving", {})
    except NonRetryableFailureError:
        pytest.fail("a failure targeted at one correlation reached another")
    assert targeted.lookup("job-surviving") == (survivor,)
    with pytest.raises(NonRetryableFailureError):
        targeted.provision("job-failing", {})
    assert targeted.lookup("job-failing") == ()
    targeted.inject("before-effect", InjectedFailureError)
    targeted.inject("before-effect", NonRetryableFailureError, correlation="job-failing")
    with pytest.raises(NonRetryableFailureError):
        targeted.provision("job-failing", {})
    with pytest.raises(InjectedFailureError):
        targeted.provision("job-surviving", {})
    assert not issubclass(NonRetryableFailureError, InjectedFailureError), (
        "a non-retryable failure must not be handled as the retryable one"
    )

    infrastructure = InfrastructureAdapter()
    assert infrastructure.outcome("project-1") == "absent"
    infrastructure.provision("project-1", {})
    assert infrastructure.outcome("project-1") == "complete"
    infrastructure.set_outcome("project-1", "running")
    assert infrastructure.outcome("project-1") == "running"


def test_the_clock_starts_at_t0_and_moves_only_by_explicit_offsets(harness):
    assert harness.clock.now() == T0
    assert harness.clock.advance(hours=72) == T0 + timedelta(hours=72)
    assert int(time.time()) == int((T0 + timedelta(hours=72)).timestamp())


def test_the_egress_guard_refuses_a_non_loopback_address_and_admits_loopback(harness):
    for address in (("192.0.2.10", 443), ("example.test", 443)):
        with socket.socket() as probe, pytest.raises(ExternalConnectionError):
            probe.connect(address)
    assert harness.refused_connections == ["('192.0.2.10', 443)", "('example.test', 443)"]
    with socket.create_server(("127.0.0.1", 0)) as server:
        with socket.create_connection(server.getsockname(), timeout=2):
            accepted, _ = server.accept()
            accepted.close()
    assert is_loopback(("::1", 5432, 0, 0)) and is_loopback("/tmp/.s.PGSQL.5432")  # noqa: S108
    assert not is_loopback(("10.0.0.1", 5432))


def test_an_in_flight_reply_without_an_operation_reference_is_a_named_contract_gap(harness):
    class Reply:
        def __init__(self, body, headers):
            self.content = json.dumps(body).encode()
            self.headers = headers
            self._body = body

        def json(self):
            return self._body

    with pytest.raises(MissingBehaviourError) as absent:
        harness.in_flight_reference(Reply({"type": "idempotency-key-in-flight"}, {}))
    assert absent.value.gap == "contract:idempotency-key-in-flight-operation-reference"
    reference = "0123456789abcdef" * 4
    assert harness.in_flight_reference(Reply({}, {"X-Operation-Ref": reference})) == reference
    for weakened in (
        Reply({"job_id": "j-1"}, {}),
        Reply({}, {"Location": "/api/v1/jobs/j-2"}),
        Reply({}, {"X-Operation-Ref": reference + "\n"}),
    ):
        with pytest.raises(MissingBehaviourError):
            harness.in_flight_reference(weakened)


def test_every_required_weakening_is_named_and_encoded_in_the_scenario_that_owns_it(harness):
    assert set(REQUIRED_WEAKENINGS) == {
        "remove-organisation-scoping",
        "bypass-first-owner-subject-binding",
        "omit-operation-target-from-deduplication",
        "remove-organisation-resource-serialisation",
        "allow-old-fence-dispatch",
        "force-unlock-on-database-lease-evidence-alone",
        "drop-durable-job",
        "accept-unauthenticated-payment-status",
        "compensate-before-step-9-only",
    }
    encoded: dict[str, set[str]] = {}
    for source in SCENARIO_FILES:
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.FunctionDef):
                continue
            owners = [
                decorator.args[0].value
                for decorator in node.decorator_list
                if isinstance(decorator, ast.Call)
                and getattr(decorator.func, "id", None) == "scenario"
                and isinstance(decorator.args[0], ast.Constant)
            ]
            names = {
                call.args[0].value
                for call in ast.walk(node)
                if isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute)
                and call.func.attr == "weakened"
                and call.args
                and isinstance(call.args[0], ast.Constant)
            }
            for owner in owners:
                encoded.setdefault(owner, set()).update(names)
    for name, owner in REQUIRED_WEAKENINGS.items():
        assert name in encoded.get(owner, set()), f"{owner} does not encode the weakening {name}"
    with pytest.raises(AssertionError, match="is not a required weakening"):
        with harness.weakened("remove-everything"):
            pass
    with pytest.raises(MissingBehaviourError) as absent:
        with harness.weakened("drop-durable-job"):
            pass
    assert absent.value.gap == "harness:implementation-weakening"


def _fs_con_01_shape_problems(source: str) -> list[str]:
    """Every way FS-CON-01's source departs from the fault and outcome the lead's ruling requires.

    It reads the syntax tree, so it proves the scenario's shape and not its behaviour: that the one
    failure is injected, as a direct statement of the client-creation barrier and after the worker
    reached it, at `before-effect`, for `failed_job`, with the class the harness exports as
    `NonRetryableFailureError`; that nothing returns or raises before the outcome assertions; and
    that each outcome assertion is a direct statement, present exactly once.
    """
    module = ast.parse(source)
    problems: list[str] = []
    function = next(
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_fs_con_01_")
    )

    bindings = [
        (getattr(node, "module", None), alias.name)
        for node in ast.walk(module)
        if isinstance(node, ast.ImportFrom | ast.Import)
        for alias in node.names
        if (alias.asname or alias.name.split(".")[0]) == "NonRetryableFailureError"
    ]
    rebound = [
        node.lineno
        for node in ast.walk(module)
        if (isinstance(node, ast.Name) and node.id == "NonRetryableFailureError")
        and isinstance(node.ctx, ast.Store | ast.Del)
    ] + [
        node.lineno
        for node in ast.walk(module)
        if isinstance(node, ast.FunctionDef | ast.ClassDef | ast.AsyncFunctionDef)
        and node.name == "NonRetryableFailureError"
    ]
    if bindings != [("first_slice_harness", "NonRetryableFailureError")] or rebound:
        problems.append(
            "FS-CON-01's failure type does not resolve to first_slice_harness."
            f"NonRetryableFailureError: bound by {bindings}, rebound at lines {rebound}"
        )

    for node in ast.walk(function):
        if isinstance(node, ast.Return | ast.Raise):
            problems.append(
                f"FS-CON-01 {type(node).__name__.lower()}s at line {node.lineno}, so its outcome "
                "assertions may never run"
            )

    def direct_call(statement: ast.stmt, attribute: str) -> ast.Call | None:
        if (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and getattr(statement.value.func, "attr", None) == attribute
        ):
            return statement.value
        return None

    def check_injection(block: ast.With, correlation: str, where: str) -> ast.Call | None:
        runs = [i for i, st in enumerate(block.body) if direct_call(st, "run_until_idle")]
        injects: list[tuple[int, ast.Call]] = []
        for i, st in enumerate(block.body):
            found = direct_call(st, "inject")
            if found is not None:
                injects.append((i, found))
        if not runs:
            problems.append(
                f"FS-CON-01's {where} does not run the worker as a direct statement, so the "
                "barrier may never be reached"
            )
        if len(injects) != 1:
            problems.append(
                f"FS-CON-01's {where} does not inject exactly one failure as a direct statement"
            )
            return None
        index, call = injects[0]
        text = ast.unparse(call)
        if runs and index < runs[0]:
            problems.append(
                f"FS-CON-01 injects before the {where} is reached, so before step 9: {text}"
            )
        point = call.args[0] if call.args else None
        if not (isinstance(point, ast.Constant) and point.value == "before-effect"):
            problems.append(f"FS-CON-01's {where} failure is not injected at before-effect: {text}")
        kind = call.args[1] if len(call.args) > 1 else None
        if not (isinstance(kind, ast.Name) and kind.id == "NonRetryableFailureError"):
            problems.append(
                f"FS-CON-01's {where} failure is retryable, so a retry can turn it into a "
                f"success: {text}"
            )
        aimed = [ast.unparse(k.value) for k in call.keywords if k.arg == "correlation"]
        if len(call.args) != 2 or aimed != [correlation] or len(call.keywords) != 1:
            problems.append(
                f"FS-CON-01's {where} failure is not aimed at {correlation} alone: {text}"
            )
        return call

    def is_barrier(statement: ast.stmt, tenants: tuple[str, ...]) -> bool:
        if not isinstance(statement, ast.With):
            return False
        points = [
            ast.unparse(item.context_expr)
            for item in statement.items
            if isinstance(item.context_expr, ast.Call)
            and getattr(item.context_expr.func, "attr", None) == "fault_point"
        ]
        expected = [f"h.fault_point(f'provision:{{{t}}}:after-clients-created')" for t in tenants]
        return len(statement.items) == len(tenants) and points == expected

    barriers = [
        st
        for st in function.body
        if isinstance(st, ast.With) and is_barrier(st, ("failed", "survivor"))
    ]
    allowed: list[ast.Call] = []
    if len(barriers) != 1:
        problems.append(
            "FS-CON-01 has no single client-creation barrier on both provisions as a direct "
            "statement"
        )
        return problems
    barrier = barriers[0]
    main = check_injection(barrier, "failed_job", "barrier")
    allowed += [main] if main is not None else []

    weakenings = [
        st
        for st in function.body
        if isinstance(st, ast.With)
        and "compensate-before-step-9-only" in ast.unparse(st.items[0].context_expr)
    ]
    for weakening in weakenings:
        inner = [
            st for st in weakening.body if isinstance(st, ast.With) and is_barrier(st, ("tenant",))
        ]
        if len(inner) != 1:
            problems.append("FS-CON-01's counterexample has no client-creation barrier")
            continue
        counter = check_injection(inner[0], "job['id']", "counterexample barrier")
        allowed += [counter] if counter is not None else []

    for node in ast.walk(function):
        if (
            isinstance(node, ast.Call)
            and getattr(node.func, "attr", None) == "inject"
            and not any(node is call for call in allowed)
        ):
            problems.append(
                "FS-CON-01 injects a failure that is not a direct statement of a client-creation "
                f"barrier, so it may land anywhere: {ast.unparse(node)}"
            )

    at_barrier = [ast.unparse(st.test) for st in barrier.body if isinstance(st, ast.Assert)]
    required_at_barrier = (
        "provider.client_exists(realm, failed) and provider.client_exists(realm, survivor)"
    )
    if at_barrier.count(required_at_barrier) != 1:
        problems.append("FS-CON-01 no longer observes both provisions' clients at the barrier")
    position = function.body.index(barrier)
    afterwards = [
        ast.unparse(st.test) for st in function.body[position + 1 :] if isinstance(st, ast.Assert)
    ]
    for expected in (
        "h.read_operation(active.staff, failed_job)['status'] == 'failed'",
        "h.read_operation(active.staff, survivor_job)['status'] == 'succeeded'",
        "not provider.client_exists(realm, failed)",
        "provider.client_exists(realm, survivor)",
        "provider.realm_settings(realm) == settings",
    ):
        if afterwards.count(expected) != 1:
            problems.append(f"FS-CON-01 no longer asserts, after the failure, {expected}")
    return problems


def test_fs_con_01_fails_one_provision_past_step_9_with_a_targeted_non_retryable_fault():
    """FS-CON-01's counterexamples mean nothing unless its fault is the one the lead ruled: past
    the client-creation barrier, aimed at the failing provision's job, and not retryable. The body
    cannot run yet, so this holds its source shape — not its behaviour — to that ruling."""
    source = (HERE / "test_fs_concurrency.py").read_text(encoding="utf-8")
    problems = _fs_con_01_shape_problems(source)
    assert problems == [], "\n".join(problems)


def test_the_decided_slug_rules_are_measured_against_every_contract_slug_pattern(
    harness, monkeypatch
):
    decided = r"^[a-z0-9][a-z0-9-]{3,18}[a-z0-9](?![\s\S])"
    wide = r"^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$"
    narrow = r"^[a-z0-9][a-z0-9-]{4,18}[a-z0-9](?![\s\S])"
    former = r"^[a-z0-9][a-z0-9-]{0,18}[a-z0-9](?![\s\S])"
    assert slug_rule_disagreements({"Decided": decided}, 5, 20) == []
    assert slug_rule_disagreements({"Wide": wide, "Narrow": narrow, "Former": former}, 5, 20) == [
        "Wide.slug accepts 4 characters",
        "Wide.slug accepts 21 characters",
        "Narrow.slug refuses 5 characters",
        "Former.slug accepts 4 characters",
    ]
    assert slug_rule_disagreements({"Tenant": r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$"}, 3, 32) == []
    assert set(contract_slug_patterns(harness.api.contract, ORGANISATION_SLUG_SCHEMAS)) == set(
        ORGANISATION_SLUG_SCHEMAS
    )
    assert set(contract_slug_patterns(harness.api.contract, TENANT_SLUG_SCHEMAS)) == set(
        TENANT_SLUG_SCHEMAS
    )
    with pytest.raises(AssertionError, match="no longer carries Organisation.slug"):
        contract_slug_patterns({"components": {"schemas": {}}}, ("Organisation",))

    tenant_rule = r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$"
    schemas = {
        name: {
            "properties": {"slug": {"pattern": decided, "not": {"enum": ["admin", "kodera-staff"]}}}
        }
        for name in ORGANISATION_SLUG_SCHEMAS
    }
    schemas["Tenant"] = {"properties": {"slug": {"pattern": tenant_rule}}}
    schemas["OrderRequest"] = {
        "properties": {"tenant": {"properties": {"slug": {"pattern": tenant_rule}}}}
    }
    monkeypatch.setattr(harness.api, "contract", {"components": {"schemas": schemas}})
    harness.slug_rule("organisation")
    harness.slug_rule("tenant")
    assert harness.reserved_organisation_slugs() == ("admin", "kodera-staff")

    schemas["OrganisationBootstrap"] = {"properties": {"slug": {"pattern": wide}}}
    del schemas["OrganisationCreateRequest"]["properties"]["slug"]["not"]
    with pytest.raises(MissingBehaviourError) as organisation:
        harness.slug_rule("organisation")
    assert organisation.value.gap == "contract:organisation-slug-rule-5-20"
    assert "OrganisationBootstrap.slug accepts 21 characters" in organisation.value.detail
    with pytest.raises(MissingBehaviourError) as reserved:
        harness.reserved_organisation_slugs()
    assert reserved.value.gap == "contract:reserved-organisation-slugs"


# -------------------------------------------------------------------------- tripwires ----


def test_every_operation_the_harness_or_a_scenario_names_is_in_the_contract():
    named: set[str] = set()
    for source in [*SCENARIO_FILES, HERE / "first_slice_harness.py"]:
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            owner = node.func.value
            if node.func.attr in {"call", "require", "url", "operation"}:
                if not (isinstance(owner, ast.Attribute) and owner.attr == "api"):
                    continue
                arguments = node.args
            elif node.func.attr in {"expect", "expect_ok"}:
                arguments = node.args[-1:]
            else:
                continue
            named |= {
                a.value
                for a in arguments
                if isinstance(a, ast.Constant) and isinstance(a.value, str)
            }
    assert {"createOrganisation", "consumeOwnerClaim", "placeOrder", "triggerTenantJob"} <= named
    assert named <= _operations(), f"not in the contract: {sorted(named - _operations())}"


def test_catalogue_publication_is_measured_against_the_contract_and_the_models():
    # The catalogue models exist and publish_catalogue drives the operator command over them; a
    # contract write on catalogue resources would be a second surface publish_catalogue must drive.
    operations = catalogue_write_surface(load_contract(ROOT), [])
    assert operations == [], "a catalogue publication surface exists: " + ", ".join(operations)
    models = catalogue_write_surface({}, installed_model_names())
    assert models == [
        "model CapacityTier",
        "model LegalDocument",
        "model Pack",
        "model Plan",
        "model Price",
    ], models
    assert {"listPlans", "listPrices", "listLegalDocuments"} <= _operations()
    ok = {"responses": {"204": {"description": "done"}}}
    synthetic = {
        "paths": {
            "/catalog/plans": {"get": {"operationId": "listPlans", **ok}},
            "/catalog/publications": {"post": {"operationId": "publishCatalogue", **ok}},
            "/legal-documents": {"put": {"operationId": "replaceTexts", **ok}},
            "/elsewhere": {"patch": {"operationId": "createOffer", **ok}},
            "/tagged": {"delete": {"operationId": "removeThing", "tags": ["Catalog"], **ok}},
            "/orders": {"post": {"operationId": "placeOrder", **ok}},
        }
    }
    assert catalogue_write_surface(synthetic, ["Organisation", "LegalDocumentVersion"]) == [
        "POST /catalog/publications (publishCatalogue)",
        "PUT /legal-documents (replaceTexts)",
        "PATCH /elsewhere (createOffer)",
        "DELETE /tagged (removeThing)",
        "model LegalDocumentVersion",
    ]


def test_the_other_measured_seams_turn_into_failures_when_their_subject_appears(
    harness, monkeypatch, tmp_path
):
    staff = harness.staff()
    measured = {
        "service:payment-inbox": lambda: harness.deliver_payment_event(None),
        "service:payment-return": lambda: harness.deliver_payment_return({}),
        "service:owner-claim-revocation": lambda: harness.revoke_claim(staff, "o"),
        "service:organisation-closure": lambda: harness.close_organisation(staff, "o"),
        "service:operator-reconciliation": lambda: harness.operator_reconciliation(staff, "j"),
        "service:realm-update": lambda: harness.request_realm_update(staff, "o"),
        "worker:step-bindings": lambda: Worker().run_until_idle(),
        "worker:outbox-dispatcher": lambda: Worker().restart_dispatcher(),
        "harness:identity-provider-admission": harness.identity_provider,
    }
    for gap, reach in measured.items():
        with pytest.raises(MissingBehaviourError) as absent:
            reach()
        assert absent.value.gap == gap
    with pytest.raises(MissingBehaviourError) as absent:
        Worker().reaped("j")
    assert absent.value.gap == "worker:step-bindings"
    # The claim and the sweep are the queue's own since G1.5-B: no gap, a real answer.
    Worker().sweep()
    assert Worker().claim(str(uuid.uuid4())).reason == "not_claimable"

    ok = {"responses": {"204": {"description": "done"}}}
    appeared = {
        "paths": {
            "/jobs/{job_id}/actions/reconcile": {"post": {"operationId": "reconcileJob", **ok}}
        }
    }
    assert contract_write_operations(appeared, r"reconcil") == [
        "POST /jobs/{job_id}/actions/reconcile (reconcileJob)"
    ]
    monkeypatch.setattr(harness.api, "contract", appeared)
    with pytest.raises(AssertionError, match="operator reconciliation operation now exists"):
        harness.operator_reconciliation(staff, "j")

    assert realm_update_request_surface(load_contract(ROOT)) == []
    widened = {
        "paths": {
            "/tenants/{tenant_id}/jobs": {
                "post": {
                    "operationId": "triggerTenantJob",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/JobTriggerRequest"}
                            }
                        }
                    },
                    **ok,
                }
            },
            "/organisations/{organisation_id}/jobs": {
                "post": {
                    "operationId": "triggerOrganisationJob",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "allOf": [{"properties": {"kind": {"const": "realm_update"}}}]
                                }
                            }
                        }
                    },
                    **ok,
                }
            },
            "/organisations/{organisation_id}/realm-settings": {
                "patch": {"operationId": "patchRealmSettings", **ok}
            },
            "/organisations/{organisation_id}/actions/sync": {
                "post": {"operationId": "syncRealm", **ok}
            },
            "/organisations/{organisation_id}/operations": {
                "post": {
                    "operationId": "requestOrganisationOperation",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "properties": {
                                        "kind": {
                                            "anyOf": [
                                                {"const": "provision"},
                                                {"allOf": [{"enum": ["realm_update"]}]},
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    **ok,
                }
            },
            "/organisations/{organisation_id}/refresh": {
                "post": {
                    "operationId": "refreshOrganisation",
                    "parameters": [
                        {"in": "query", "name": "kind", "schema": {"enum": ["realm_update"]}}
                    ],
                    **ok,
                }
            },
            "/organisations/{organisation_id}/rerun": {
                "parameters": [{"$ref": "#/components/parameters/JobKindQuery"}],
                "post": {"operationId": "rerunOrganisation", **ok},
                "get": {"operationId": "listReruns", **ok},
            },
            "/organisations/{organisation_id}/preview": {
                "post": {
                    "operationId": "previewOrganisation",
                    "parameters": [
                        {"in": "query", "name": "kind", "schema": {"enum": ["provision"]}},
                        {"in": "path", "name": "kind", "schema": {"const": "realm_update"}},
                    ],
                    **ok,
                }
            },
            "/auth/discover": {"post": {"operationId": "discoverRealm", **ok}},
            "/organisations/{organisation_id}/realm": {"get": {"operationId": "getRealm", **ok}},
        },
        "components": {
            "schemas": {
                "JobTriggerRequest": {
                    "properties": {"kind": {"$ref": "#/components/schemas/JobKind"}}
                },
                "JobKind": {"type": "string", "enum": ["provision", "realm_update"]},
            },
            "parameters": {
                "JobKindQuery": {
                    "in": "query",
                    "name": "kind",
                    "schema": {"oneOf": [{"$ref": "#/components/schemas/JobKind"}]},
                }
            },
        },
    }
    assert realm_update_request_surface(widened) == [
        "POST /tenants/{tenant_id}/jobs (triggerTenantJob)",
        "POST /organisations/{organisation_id}/jobs (triggerOrganisationJob)",
        "PATCH /organisations/{organisation_id}/realm-settings (patchRealmSettings)",
        "POST /organisations/{organisation_id}/actions/sync (syncRealm)",
        "POST /organisations/{organisation_id}/operations (requestOrganisationOperation)",
        "POST /organisations/{organisation_id}/refresh (refreshOrganisation)",
        "POST /organisations/{organisation_id}/rerun (rerunOrganisation)",
    ]
    monkeypatch.setattr(harness.api, "contract", widened)
    with pytest.raises(AssertionError, match="a direct realm_update request now exists"):
        harness.request_realm_update(staff, "o")

    from apps.jobs.kinds import KINDS
    from worker import registry

    assert worker_steps_unbound()
    served = registry.Registry(
        registry.StepPlan("backup", seq, spec.name, convergent=False)
        for seq, spec in enumerate(KINDS["backup"].steps, start=1)
    )
    monkeypatch.setattr(registry, "PRODUCTION", served)
    assert not worker_steps_unbound()
    with pytest.raises(AssertionError, match="production registry serves a kind: wire"):
        Worker().run_until_idle()

    assert (
        local_identity_issuers({"KODERA_AUTH_TRUST": _trust("https://id.acceptance.test/r")}) == []
    )
    monkeypatch.setenv("KODERA_AUTH_TRUST", _trust("http://127.0.0.1:8080/realms/acme-sa"))
    with pytest.raises(AssertionError, match="admits a loopback identity provider"):
        harness.identity_provider()
