"""One-guard readiness and installed PostgreSQL mutations, with rollback on every exit."""

import ast
import inspect
import re
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection, transaction
from django.utils import timezone
from test_operator_realm_bootstrap import (
    _fail,
    complete,
    outcome_of,
    refused_by,
    run,
    start,
    test_every_command_refuses_before_the_cutover_and_does_not_even_sweep as gate_acceptance,
    test_requeue_refuses_an_organisation_that_is_not_prospect as prospect_acceptance,
    to_trust_hold,
    w as w,
    who,
    written,
)

from apps.jobs.keys import derive_key
from apps.jobs.models import Job, JobReconciliationDecision
from apps.orgs import bootstrap_selectors, realm_bootstrap as rb
from apps.orgs.models import Organisation, RealmReadiness
from apps.orgs.realm_readiness import realm_ready, record_realm_ready

pytestmark = pytest.mark.django_db(transaction=True)


def compile_mutation(function, transform):
    tree = ast.parse(inspect.getsource(function))
    tree, edits = transform(tree)
    assert edits == 1, f"expected one operator mutation, got {edits}"
    ast.fix_missing_locations(tree)
    namespace = dict(function.__globals__)
    exec(compile(tree, inspect.getsourcefile(function), "exec"), namespace)  # noqa: S102
    return namespace[function.__name__]


def changed_if(function, expression, replacement):
    def transform(tree):
        edits = 0

        class ChangeOne(ast.NodeTransformer):
            def visit_If(self, node):
                nonlocal edits
                if ast.unparse(node.test) == expression:
                    edits += 1
                    node.test = ast.parse(replacement, mode="eval").body
                return self.generic_visit(node)

        return ChangeOne().visit(tree), edits

    return compile_mutation(function, transform)


def test_intake_gate_mutation_reaches_the_previously_forbidden_sweep(capsys, w, monkeypatch):
    gate_acceptance(capsys, w, "start")
    mutant = changed_if(
        rb.principal_for,
        "getattr(settings, 'KODERA_INTAKE_ADMITTED', False) is not True",
        "False",
    )
    monkeypatch.setattr(rb, "principal_for", mutant)
    with pytest.raises(AssertionError):
        gate_acceptance(capsys, w, "start")
    assert Job.objects.get(pk=w.job_id).status == "needs_reconciliation"


def test_tooling_pattern_mutation_admits_the_forbidden_verify_step(monkeypatch):
    progress = SimpleNamespace(
        unresolved_operation_ref="awaiting tooling step 7 run valid", unresolved_seq=7
    )
    assert rb._held_tooling_step(progress) is None
    pattern = rb.TOOLING_HOLD_PATTERN.pattern
    assert pattern.count("[1-6]") == 1
    monkeypatch.setattr(rb, "TOOLING_HOLD_PATTERN", re.compile(pattern.replace("[1-6]", "[1-7]")))
    with pytest.raises(AssertionError):
        assert rb._held_tooling_step(progress) is None
    assert rb._held_tooling_step(progress) == 7


@pytest.mark.parametrize("boundary", ["sequence", "verify", "dispatched"])
def test_tooling_sequence_and_dispatched_verify_mutations_have_named_catches(boundary):
    if boundary == "sequence":
        function = rb._held_tooling_step
        expression = "progress.unresolved_seq != int(found.group(1))"
        progress = SimpleNamespace(
            unresolved_operation_ref="awaiting tooling step 1 run valid", unresolved_seq=2
        )
        expected, wrongful = None, 1
    else:
        function = rb._step7_dispatched
        expression = "step.seq == VERIFY" if boundary == "verify" else "step.dispatched"
        progress = SimpleNamespace(
            steps=[
                SimpleNamespace(
                    seq=6 if boundary == "verify" else 7, dispatched=boundary == "verify"
                )
            ]
        )
        expected, wrongful = False, True

    def transform(tree):
        edits = 0

        class ChangeOne(ast.NodeTransformer):
            def visit(self, node):
                nonlocal edits
                if (
                    isinstance(node, (ast.Compare, ast.Attribute))
                    and ast.unparse(node) == expression
                ):
                    edits += 1
                    return ast.Constant(boundary != "sequence")
                return super().visit(node)

        return ChangeOne().visit(tree), edits

    assert function(progress) is expected
    mutant = compile_mutation(function, transform)
    with pytest.raises(AssertionError):
        assert mutant(progress) is expected
    assert mutant(progress) == wrongful


def test_missing_next_run_mutation_commits_a_forbidden_decision(capsys, w, monkeypatch):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    before = written()
    decisions = JobReconciliationDecision.objects.count()

    def acceptance():
        try:
            start(capsys, w, *outcome_of(1))
        except RuntimeError as error:
            # A downstream exception alone is not the catch: check the forbidden committed write.
            assert str(error) == "the next step changed under the claim"
        assert written() == before, "decision committed before the next tooling run was supplied"

    acceptance()
    monkeypatch.setattr(
        rb,
        "start",
        changed_if(
            rb.start,
            "following is not None and following in TOOLING_STEPS and (tooling_run is None)",
            "False",
        ),
    )
    with pytest.raises(AssertionError, match="decision committed before"):
        acceptance()
    assert JobReconciliationDecision.objects.count() == decisions + 1


@pytest.mark.parametrize("boundary", ["active_only", "replay", "prospect", "terminal"])
def test_requeue_guard_mutations_have_an_observed_contract_catch(capsys, w, monkeypatch, boundary):
    organisation = "pilot-one"
    if boundary == "prospect":
        prospect_acceptance(capsys, w)
        organisation = "active-org"
        expression = "organisation.state != Organisation.State.PROSPECT"
        replacement = "False"
    elif boundary == "terminal":
        expression, replacement = "latest.status not in REPLACEABLE", "False"
    else:
        _fail(w.job_id)
        assert run(capsys, "requeue_realm_bootstrap", *who(w.operator))[0] == 0
        expression = "latest.status not in REPLACEABLE and len(jobs) > 1"
        replacement = "len(jobs) > 1" if boundary == "active_only" else "False"

    def invoke():
        return run(
            capsys,
            "requeue_realm_bootstrap",
            "--staff-identity",
            str(w.operator.id),
            "--organisation",
            organisation,
        )

    if boundary == "active_only":
        latest = Job.objects.exclude(pk=w.job_id).get()
        Job.objects.filter(pk=latest.pk).update(status="failed", error_code="step_failed")
        count = Job.objects.count()
        assert invoke()[0] == 0
        assert Job.objects.count() == count + 1
        latest = Job.objects.order_by("-created_at", "-id").first()
        Job.objects.filter(pk=latest.pk).update(status="failed", error_code="step_failed")
    else:
        code, _, err = invoke()
        assert code == (0 if boundary == "replay" else 1), err
    before = written()
    count = Job.objects.count()

    def acceptance():
        code, _, err = invoke()
        if boundary == "active_only":
            assert code == 0 and Job.objects.count() == count + 1, "terminal replacement replayed"
        elif boundary == "replay":
            assert code == 0 and written() == before, "active replacement replay refused"
        else:
            assert code == 1 and written() == before, "ineligible organisation or job requeued"
        return err

    monkeypatch.setattr(rb, "requeue", changed_if(rb.requeue, expression, replacement))
    with pytest.raises(AssertionError, match="replayed|replay refused|ineligible"):
        acceptance()
    if boundary in {"prospect", "terminal"}:
        assert Job.objects.count() == count + 1
    elif boundary == "active_only":
        assert Job.objects.count() == count
    else:
        assert invoke()[0] == 1


def reader_without(boundary):
    recorded = boundary in {"job_id", "revoked_at__isnull"}
    function = (
        bootstrap_selectors._recorded_realm_ready
        if recorded
        else bootstrap_selectors.counting_realm_ready
    )
    tree = ast.parse(inspect.getsource(function))
    edits = 0

    class RemoveOne(ast.NodeTransformer):
        def visit_keyword(self, node):
            nonlocal edits
            if (
                boundary in {"job_id", "revoked_at__isnull", "deleted_at__isnull"}
                and node.arg == boundary
            ):
                edits += 1
                return None
            return self.generic_visit(node)

        def visit_Compare(self, node):
            nonlocal edits
            if boundary == "succeeded" and ast.unparse(node) == "job.status != 'succeeded'":
                edits += 1
                return ast.Constant(False)
            return self.generic_visit(node)

        def visit_Return(self, node):
            nonlocal edits
            if boundary == "trust" and ast.unparse(node.value).startswith("recorded and "):
                edits += 1
                node.value = ast.Name("recorded", ast.Load())
            return self.generic_visit(node)

    tree = RemoveOne().visit(tree)
    assert edits == 1, f"expected one reader mutation, got {edits}"
    ast.fix_missing_locations(tree)
    namespace = dict(function.__globals__)
    exec(compile(tree, inspect.getsourcefile(function), "exec"), namespace)  # noqa: S102
    if not recorded:
        return namespace[function.__name__]
    # Bind the changed fact reader into a private copy of the effective counting closure.
    # Neither the product facade nor its globals are changed for another test.
    tree = ast.parse(inspect.getsource(bootstrap_selectors.counting_realm_ready))
    exec(compile(tree, inspect.getsourcefile(function), "exec"), namespace)  # noqa: S102
    return namespace["counting_realm_ready"]


@pytest.mark.parametrize(
    "boundary", ["succeeded", "job_id", "revoked_at__isnull", "trust", "deleted_at__isnull"]
)
def test_each_effective_readiness_boundary_has_a_false_readiness_catch(capsys, w, boundary):
    if boundary == "succeeded":
        record_realm_ready(
            organisation_id=w.organisation.id, job_id=w.job_id, recorded_by=w.operator.id
        )
    else:
        to_trust_hold(capsys, w)
        assert complete(capsys, w)[0] == 0
        assert realm_ready(organisation_id=w.organisation.id)
        if boundary == "job_id":
            Job.objects.create(
                organisation_id=w.organisation.id,
                kind="realm_create",
                idempotency_key=derive_key(["mutation-new-generation", w.job_id]),
                desired_spec_hash=derive_key(["spec", w.organisation.id]),
                max_attempts=3,
                actor_type="staff",
                actor_id=w.operator.id,
                status="succeeded",
            )
        elif boundary == "revoked_at__isnull":
            RealmReadiness.objects.update(revoked_at=timezone.now())
        elif boundary == "deleted_at__isnull":
            deleted = timezone.now()
            Organisation.objects.filter(pk=w.organisation.id).update(
                deleted_at=deleted, purge_after=deleted + timedelta(days=30)
            )
        else:
            w.settings.KODERA_AUTH_TRUST = ()

    def acceptance(reader):
        assert not reader(organisation_id=w.organisation.id), "uncountable fact reported ready"

    acceptance(realm_ready)
    mutant = reader_without(boundary)
    with pytest.raises(AssertionError, match="uncountable fact reported ready"):
        acceptance(mutant)
    assert mutant(organisation_id=w.organisation.id) is True


@contextmanager
def rollback_schema():
    """Actual installed mutations cannot leak to another test, even after a failed assertion."""
    with transaction.atomic():
        try:
            yield
        finally:
            transaction.set_rollback(True)


def install_trigger_mutation(kind):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_functiondef('realm_readiness_change()'::regprocedure)")
        original = cursor.fetchone()[0]
        if kind == "delete":
            assert original.count("BEGIN\n") == 1
            changed = original.replace(
                "BEGIN\n", "BEGIN\n  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n", 1
            )
        elif kind == "second_revocation":
            assert original.count("AND OLD.revoked_at IS NULL") == 1
            changed = original.replace("AND OLD.revoked_at IS NULL", "AND TRUE", 1)
        else:
            # One equality predicate consists of its NEW and OLD operands, removed together.
            new, old = f"NEW.{kind}, ", f"OLD.{kind}, "
            assert kind == "job_id"
            replacement = ""
            assert original.count(new) == original.count(old) == 1
            changed = original.replace(new, replacement, 1).replace(old, replacement, 1)
        assert changed != original
        cursor.execute(changed)
    return original


@pytest.mark.parametrize(
    "kind",
    ["delete", "second_revocation", "job_id"],
)
def test_installed_trigger_guard_mutations_allow_the_named_forbidden_write(capsys, w, kind):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    fact = RealmReadiness.objects.get()
    if kind == "delete":

        def write():
            return RealmReadiness.objects.filter(pk=fact.pk).delete()

        def wrongly_written():
            return not RealmReadiness.objects.filter(pk=fact.pk).exists()
    else:
        field = "revoked_at" if kind == "second_revocation" else kind
        if kind == "second_revocation":
            RealmReadiness.objects.filter(pk=fact.pk).update(revoked_at=timezone.now())
            changed = timezone.now() + timedelta(seconds=1)
        else:
            changed = uuid4()

        def write():
            return RealmReadiness.objects.filter(pk=fact.pk).update(**{field: changed})

        def wrongly_written():
            return RealmReadiness.objects.filter(**{field: changed}).exists()

    refused_by("realm_readiness_immutable", write)
    with rollback_schema():
        original_function = install_trigger_mutation(kind)
        with pytest.raises(pytest.fail.Exception, match="DID NOT RAISE"):
            refused_by("realm_readiness_immutable", write)
        assert wrongly_written(), "mutation did not produce the prohibited effect"
    assert RealmReadiness.objects.filter(pk=fact.pk).exists(), "rollback did not restore the fact"
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_functiondef('realm_readiness_change()'::regprocedure)")
        assert cursor.fetchone()[0] == original_function
