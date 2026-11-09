"""Pure operator refusal cases and counted single-guard deletion proofs."""

import ast
import inspect
from types import SimpleNamespace
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, trust_entry
from django.utils import timezone

from apps.orgs import realm_bootstrap as rb

ISSUER = "https://identity.staff.test/realms/pilot-one"


def without_if(function, expression):
    """Compile one deletion against the function's real globals; a mismatched target is an error."""
    tree = ast.parse(inspect.getsource(function))
    found = 0

    class DeleteGuard(ast.NodeTransformer):
        def visit_If(self, node):
            nonlocal found
            if ast.unparse(node.test) == expression:
                found += 1
                return ast.Pass()
            return self.generic_visit(node)

    tree = DeleteGuard().visit(tree)
    assert found == 1, f"expected one guard deletion, found {found}"
    ast.fix_missing_locations(tree)
    namespace = dict(function.__globals__)
    exec(compile(tree, inspect.getsourcefile(function), "exec"), namespace)  # noqa: S102
    return namespace[function.__name__]


@pytest.mark.parametrize("value", [False, None])
def test_lost_claim_refusal_has_a_single_guard_deletion_proof(value):
    def acceptance(function):
        with pytest.raises(rb.Refused, match="this command's claim was lost") as caught:
            function(value, "synthetic write")
        assert caught.value.outcome == "claim_lost"

    acceptance(rb.kept)
    mutated = without_if(rb.kept, "written is None or written is False")
    with pytest.raises(pytest.fail.Exception, match="DID NOT RAISE"):
        acceptance(mutated)
    rb.kept(True, "positive write")
    rb.kept(uuid4(), "positive write")


@pytest.mark.parametrize(
    ("status", "expression", "message"),
    [
        ("leased", "progress.status in STILL_CLAIMED", "claimed until"),
        ("running", "progress.status in STILL_CLAIMED", "claimed until"),
        ("succeeded", "progress.status == 'succeeded'", "already succeeded"),
        ("failed", "progress.status in REPLACEABLE", "replace it"),
        ("cancelled", "progress.status in REPLACEABLE", "replace it"),
    ],
)
def test_closed_job_refusal_has_a_single_guard_deletion_proof(status, expression, message):
    progress = SimpleNamespace(status=status, lease_expires_at=timezone.now())
    record = rb.Record("synthetic", "pilot-one", uuid4())

    def acceptance(function):
        with pytest.raises(rb.Refused, match=message):
            function(progress, record)

    acceptance(rb.refuse_unless_open)
    with pytest.raises(pytest.fail.Exception, match="DID NOT RAISE"):
        acceptance(without_if(rb.refuse_unless_open, expression))
    rb.refuse_unless_open(SimpleNamespace(status="queued"), record)


@pytest.mark.parametrize(
    ("reference", "sequence", "expected"),
    [
        ("awaiting tooling step 1 run valid", 1, 1),
        ("awaiting tooling step 6 run valid", 6, 6),
        ("awaiting tooling step 7 run valid", 7, None),
        ("awaiting tooling step 1 run valid", 2, None),
        ("foreign operation", 1, None),
        (None, 1, None),
    ],
)
def test_tooling_hold_requires_its_pattern_and_matching_sequence(reference, sequence, expected):
    progress = SimpleNamespace(unresolved_operation_ref=reference, unresolved_seq=sequence)
    assert rb._held_tooling_step(progress) == expected


@pytest.mark.parametrize(
    ("sequence", "dispatched", "expected"),
    [(7, True, True), (7, False, False), (6, True, False)],
)
def test_only_a_dispatched_verify_is_handed_to_complete(sequence, dispatched, expected):
    progress = SimpleNamespace(steps=[SimpleNamespace(seq=sequence, dispatched=dispatched)])
    assert rb._step7_dispatched(progress) is expected


@pytest.mark.parametrize("invalid", ["expired", "wrong_lane", "unreadable"])
def test_verification_rejects_invalid_pins_or_published_keys(settings, http_signer, invalid):
    from dataclasses import replace

    entry = trust_entry(
        http_signer, ISSUER, lane="staff" if invalid == "wrong_lane" else "customer"
    )
    configure(settings, [entry])
    if invalid == "expired":
        current = settings.KODERA_AUTH_TRUST[0]
        settings.KODERA_AUTH_TRUST = (
            replace(current, snapshot=replace(current.snapshot, expires_at=0)),
        )
    keys = {"keys": [http_signer[2]]} if invalid != "unreadable" else {"keys": []}
    read = rb.RealmRead(ISSUER, {"issuer": ISSUER}, keys, "synthetic-read")
    reason = (
        "published_keys_unreadable"
        if invalid == "unreadable"
        else "issuer_not_in_trust_configuration"
    )
    assert rb.mismatch(read, "ok") == reason
