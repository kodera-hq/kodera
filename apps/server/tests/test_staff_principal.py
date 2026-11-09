"""The staff principal: docs/specs/STAFF_IDENTITY.md §5.

`resolve_staff_principal` is the request constructor, and refuses unless the token is on the staff
lane, from the one staff issuer of the settings, with a second factor in `amr`, for a stored staff
identity. Each refusal clause is proven by running the resolver's source with that clause deleted
and requiring its own case to stop being refused. The job queue's decision functions take nothing
else as a principal.
The ratified pilot's separate command-only constructor is proven below by removing each predicate.
"""

import ast
import copy
import datetime as dt
import pickle
import sys
import threading
import time
import types
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.db import connection, connections, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.identity import command_principal, staff
from apps.identity.models import Identity, StaffRole, User
from services.identity.access_tokens import VerifiedAccessToken

# config.settings.test's fixed KODERA_STAFF_ISSUER, and a staff-realm issuer that is not it.
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
OTHER_STAFF_ISSUER = "https://identity.elsewhere.test/realms/kodera-staff"
CUSTOMER_ISSUER = "https://identity.customer.test/realms/alpha"


def stored_staff_identity(*, issuer=STAFF_ISSUER, roles=("staff_operator",)):
    user = User.objects.create(email="operator@staff.test", enabled=True)
    identity = Identity.objects.create(
        user=user,
        organisation=None,
        issuer=issuer,
        realm="kodera-staff",
        subject="staff-" + uuid.uuid4().hex[:8],
        email="operator@staff.test",
        enabled=True,
    )
    for role in roles:
        StaffRole.objects.create(identity=identity, realm="kodera-staff", role=role)
    return identity


def token(issuer, subject, amr=("pwd", "otp")):
    now = int(time.time())
    return VerifiedAccessToken(
        issuer=issuer,
        subject=subject,
        audience=("kodera-server",),
        issued_at=now,
        expires_at=now + 300,
        not_before=None,
        amr=None if amr is None else tuple(amr),
        acr=None,
        auth_time=now,
    )


# ------------------------------------------------------------------------ what is refused ----

# Each case is (verified, lane) for one refusal, built against the database. The name is the
# clause of the resolver that alone refuses it: see CLAUSES below.


def case_look_alike(identity):
    verified = token(identity.issuer, identity.subject)
    return SimpleNamespace(**{name: getattr(verified, name) for name in vars(verified)}), "staff"


class _SubclassedToken(VerifiedAccessToken):
    """A class of the verifier's shape that the verifier did not produce."""


def case_subclass(identity):
    verified = token(identity.issuer, identity.subject)
    fields = {name: getattr(verified, name) for name in vars(verified)}
    return _SubclassedToken(**fields), "staff"


def case_other_lane(identity):
    return token(identity.issuer, identity.subject), "customer"


def case_other_issuer(_identity):
    other = stored_staff_identity(issuer=OTHER_STAFF_ISSUER)
    return token(other.issuer, other.subject), "staff"


def case_trailing_slash(identity):
    return token(identity.issuer + "/", identity.subject), "staff"


def case_upper_case_otp(identity):
    return token(identity.issuer, identity.subject, amr=("pwd", "OTP")), "staff"


def case_padded_otp(identity):
    return token(identity.issuer, identity.subject, amr=(" otp",)), "staff"


def case_deleted_identity(identity):
    now = timezone.now()
    Identity.objects.filter(pk=identity.pk).update(
        deleted_at=now, purge_after=now + dt.timedelta(days=1)
    )
    return token(identity.issuer, identity.subject), "staff"


def case_no_amr(identity):
    return token(identity.issuer, identity.subject, amr=None), "staff"


def case_no_second_factor(identity):
    return token(identity.issuer, identity.subject, amr=("pwd", "kba")), "staff"


def case_unstorable_subject(_identity):
    return token(STAFF_ISSUER, "staff\x00subject"), "staff"


def case_unknown_subject(_identity):
    return token(STAFF_ISSUER, "no-such-staff-subject"), "staff"


CASES = {
    "look-alike evidence": case_look_alike,
    "a subclass of the verified token": case_subclass,
    "another lane": case_other_lane,
    "another staff issuer": case_other_issuer,
    "the staff issuer with a trailing slash": case_trailing_slash,
    "an upper-case OTP": case_upper_case_otp,
    "a padded otp": case_padded_otp,
    "a deleted staff identity": case_deleted_identity,
    "no amr": case_no_amr,
    "no second factor": case_no_second_factor,
    "an unstorable subject": case_unstorable_subject,
    "no stored staff identity": case_unknown_subject,
}


def outcome(module, verified, lane):
    try:
        module.resolve_staff_principal(verified, lane)
    except module.StaffPrincipalError as error:
        assert str(error) == "staff principal refused" and error.__cause__ is None
        return "refused"
    except Exception as error:  # noqa: BLE001 - anything else is what a mutant did instead
        return type(error).__name__
    return "resolved"


@pytest.mark.parametrize("name", sorted(CASES))
def test_the_resolver_refuses(db, name):
    verified, lane = CASES[name](stored_staff_identity())
    assert outcome(staff, verified, lane) == "refused", (
        f"a staff principal was resolved from {name}"
    )


def test_a_customer_token_is_refused_whatever_it_claims(db):
    stored_staff_identity()
    for lane in ("customer", "staff"):
        verified = token(CUSTOMER_ISSUER, "customer-subject", amr=("otp",))
        assert outcome(staff, verified, lane) == "refused"


COMMAND_PREDICATES = (
    "id",
    "issuer",
    "enabled",
    "deleted_at__isnull",
    "user__enabled",
    "user__deleted_at__isnull",
)


def command_identity_case(predicate):
    identity = stored_staff_identity(
        issuer=OTHER_STAFF_ISSUER if predicate == "issuer" else STAFF_ISSUER, roles=()
    )
    if predicate == "id":
        return uuid.uuid4()
    if predicate == "enabled":
        Identity.objects.filter(pk=identity.pk).update(enabled=False)
    elif predicate == "deleted_at__isnull":
        now = timezone.now()
        Identity.objects.filter(pk=identity.pk).update(
            deleted_at=now, purge_after=now + dt.timedelta(days=1)
        )
    elif predicate == "user__enabled":
        User.objects.filter(pk=identity.user_id).update(enabled=False)
    elif predicate == "user__deleted_at__isnull":
        now = timezone.now()
        User.objects.filter(pk=identity.user_id).update(
            deleted_at=now, purge_after=now + dt.timedelta(days=1)
        )
    return identity.id


@contextmanager
def command_builder_without(predicate):
    class Delete(ast.NodeTransformer):
        changed = 0

        def visit_If(self, node):
            if (
                predicate == "uuid_type"
                and ast.unparse(node.test) == "not isinstance(identity_id, UUID)"
            ):
                self.changed += 1
                return None
            return self.generic_visit(node)

        def visit_Call(self, node):
            if isinstance(node.func, ast.Attribute) and node.func.attr == "filter":
                kept = [keyword for keyword in node.keywords if keyword.arg != predicate]
                self.changed += len(node.keywords) - len(kept)
                node.keywords = kept
            return self.generic_visit(node)

    path = Path(command_principal.__file__)
    delete = Delete()
    tree = ast.fix_missing_locations(delete.visit(ast.parse(path.read_text())))
    assert delete.changed == 1, "the command builder mutation must delete exactly one predicate"
    name = "apps.identity._command_principal_mutant"
    module = types.ModuleType(name)
    module.__package__ = "apps.identity"
    sys.modules[name] = module
    try:
        exec(compile(tree, str(path), "exec"), module.__dict__)  # noqa: S102
        yield module
    finally:
        del sys.modules[name]


@pytest.mark.parametrize("predicate", COMMAND_PREDICATES)
def test_each_command_builder_predicate_has_a_refusal_and_deletion_proof(db, predicate):
    identity_id = command_identity_case(predicate)
    with pytest.raises(staff.StaffPrincipalError, match="staff principal refused"):
        command_principal.staff_principal_for_command(identity_id)
    with command_builder_without(predicate) as mutant:
        assert staff.is_staff_principal(mutant.staff_principal_for_command(identity_id)), (
            f"deleting {predicate} did not expose its own invalid command identity"
        )


def test_every_command_builder_filter_predicate_has_a_deletion_proof():
    tree = ast.parse(Path(command_principal.__file__).read_text())
    predicates = {
        keyword.arg
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "filter"
        for keyword in node.keywords
    }
    assert predicates == set(COMMAND_PREDICATES), "a command builder predicate lacks a proof"


def test_command_builder_accepts_stored_staff_without_carrying_a_role(db, settings):
    identity = stored_staff_identity(roles=())
    principal = command_principal.staff_principal_for_command(identity.id)
    assert staff.is_staff_principal(principal)
    assert (principal.identity_id, principal.issuer) == (identity.id, STAFF_ISSUER)
    assert not hasattr(principal, "roles")
    with pytest.raises(staff.StaffPrincipalError):
        command_principal.staff_principal_for_command(str(identity.id))
    settings.KODERA_STAFF_ISSUER = None
    with pytest.raises(staff.StaffPrincipalError):
        command_principal.staff_principal_for_command(identity.id)


def test_command_builder_uuid_input_guard_has_a_deletion_proof(db):
    identity = stored_staff_identity(roles=())
    with pytest.raises(staff.StaffPrincipalError, match="staff principal refused"):
        command_principal.staff_principal_for_command(str(identity.id))
    with command_builder_without("uuid_type") as mutant:
        assert staff.is_staff_principal(mutant.staff_principal_for_command(str(identity.id)))


@pytest.mark.parametrize("disabled", ["identity", "person"])
def test_a_disabled_staff_identity_is_refused(db, disabled):
    identity = stored_staff_identity()
    if disabled == "identity":
        Identity.objects.filter(pk=identity.pk).update(enabled=False)
    else:
        User.objects.filter(pk=identity.user_id).update(enabled=False)
    assert outcome(staff, token(identity.issuer, identity.subject), "staff") == "refused"


@pytest.mark.parametrize("method", ["otp", "hwk", "mfa"])
def test_a_stored_staff_identity_with_a_second_factor_resolves(db, method):
    identity = stored_staff_identity(roles=())
    principal = staff.resolve_staff_principal(
        token(identity.issuer, identity.subject, amr=("pwd", method)), "staff"
    )
    assert staff.is_staff_principal(principal)
    assert (principal.identity_id, principal.issuer) == (identity.pk, STAFF_ISSUER)
    assert not hasattr(principal, "roles"), "a staff principal carries a role"


def test_the_staff_issuer_comes_from_the_settings(db, settings):
    identity = stored_staff_identity()
    verified = token(identity.issuer, identity.subject)
    assert settings.KODERA_STAFF_ISSUER == STAFF_ISSUER
    assert staff.resolve_staff_principal(verified, "staff").identity_id == identity.pk
    settings.KODERA_STAFF_ISSUER = None
    with pytest.raises(staff.StaffPrincipalError):
        staff.resolve_staff_principal(verified, "staff")


# ---------------------------------------------------------------------- the principal itself ----


def test_a_principal_cannot_be_built_by_calling_the_class():
    with pytest.raises(TypeError, match="built only by resolve_staff_principal"):
        staff.StaffPrincipal(identity_id=uuid.uuid4(), issuer=STAFF_ISSUER)
    with pytest.raises(TypeError):
        staff.StaffPrincipal()


def test_a_principal_is_immutable_and_not_serialised(db):
    identity = stored_staff_identity()
    principal = staff.resolve_staff_principal(token(identity.issuer, identity.subject), "staff")
    with pytest.raises(AttributeError):
        principal.identity_id = uuid.uuid4()
    with pytest.raises(AttributeError):
        del principal.issuer
    with pytest.raises(TypeError):
        pickle.dumps(principal)
    assert copy.copy(principal) is principal and copy.deepcopy(principal) is principal
    assert principal.identity_id == identity.pk
    assert not staff.is_staff_principal(
        SimpleNamespace(identity_id=identity.pk, issuer=STAFF_ISSUER)
    )


@pytest.mark.parametrize(
    "function", ["record_reconciliation_decision", "record_delivery_reconciliation_decision"]
)
def test_a_decision_refuses_a_principal_the_resolver_did_not_build(db, function):
    from apps.jobs import services

    identity = stored_staff_identity()
    now = timezone.now()
    evidence = services.Evidence(
        provider="scaleway", resource_id="fr-par-1/instance-7", request_id="r", observed_at=now
    )
    decision = services.ReconciliationDecision(
        subject_id=uuid.uuid4(),
        exit="fail",
        operation_outcome="no_effect",
        compute_terminated=evidence,
        target_read=evidence,
    )
    forged = SimpleNamespace(identity_id=identity.pk, issuer=STAFF_ISSUER)
    with (
        CaptureQueriesContext(connection) as queries,
        pytest.raises(TypeError, match="StaffPrincipal"),
    ):
        getattr(services, function)(principal=forged, decision=decision)
    assert len(queries) == 0, "a decision read the database before refusing a forged principal"


# ------------------------------------------------- each refusal clause can be seen to fail ----

# The resolver's refusals, each an `if <test>: raise StaffPrincipalError()`, by the source of its
# test, and the case only that clause refuses.
CLAUSES = {
    "type(verified) is not VerifiedAccessToken": "look-alike evidence",
    "lane != 'staff'": "another lane",
    "verified.issuer != configured_staff_issuer()": "another staff issuer",
    "not MFA_METHODS.intersection(verified.amr or ())": "no second factor",
    "not is_storable_subject(verified.subject)": "an unstorable subject",
    "identity is None": "no stored staff identity",
}


@contextmanager
def resolver_without(clause):
    """apps.identity.staff with the one refusal whose test is `clause` deleted from the resolver."""

    class Delete(ast.NodeTransformer):
        changed = 0

        def visit_FunctionDef(self, node):
            if node.name != "resolve_staff_principal":
                return node
            kept = []
            for statement in node.body:
                if isinstance(statement, ast.If) and ast.unparse(statement.test) == clause:
                    self.changed += 1
                    continue
                kept.append(statement)
            node.body = kept
            return node

    with mutated_resolver(Delete()) as module:
        yield module


@contextmanager
def mutated_resolver(transformer):
    """apps.identity.staff with the source change `transformer` makes, exactly once."""
    path = Path(staff.__file__)
    tree = ast.fix_missing_locations(transformer.visit(ast.parse(path.read_text(encoding="utf-8"))))
    assert transformer.changed == 1, f"the mutant changed {transformer.changed} places, not one"
    name = "apps.identity._staff_principal_mutant"
    module = types.ModuleType(name)
    module.__package__ = "apps.identity"
    sys.modules[name] = module
    try:
        # The only input is this repository's own resolver source, with one counted deletion.
        exec(compile(tree, str(path), "exec"), module.__dict__)  # noqa: S102
        yield module
    finally:
        del sys.modules[name]


def test_every_refusal_of_the_resolver_has_a_clause_here():
    tree = ast.parse(Path(staff.__file__).read_text(encoding="utf-8"))
    (resolver,) = (
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "resolve_staff_principal"
    )
    refusals = {
        ast.unparse(statement.test)
        for statement in resolver.body
        if isinstance(statement, ast.If)
        and any(isinstance(inner, ast.Raise) for inner in statement.body)
    }
    assert refusals == set(CLAUSES), "a refusal of the resolver has no deletion proof here"


@pytest.mark.parametrize("clause", sorted(CLAUSES))
def test_deleting_a_refusal_lets_its_own_case_through(db, clause):
    name = CLAUSES[clause]
    verified, lane = CASES[name](stored_staff_identity())
    assert outcome(staff, verified, lane) == "refused"
    with resolver_without(clause) as mutant:
        assert outcome(mutant, verified, lane) != "refused", (
            f"with {clause!r} deleted, {name} was still refused: the case does not rest on it"
        )


class _WidenMfa(ast.NodeTransformer):
    """MFA_METHODS with one more entry."""

    def __init__(self, entry):
        self.entry = entry
        self.changed = 0

    def visit_Assign(self, node):
        if [ast.unparse(target) for target in node.targets] == ["MFA_METHODS"]:
            node.value.args[0].elts.append(ast.Constant(self.entry))
            self.changed += 1
        return node


class _IsinstanceForType(ast.NodeTransformer):
    """The exact-class check written as isinstance, which admits a subclass."""

    changed = 0

    def visit_If(self, node):
        if ast.unparse(node.test) == "type(verified) is not VerifiedAccessToken":
            node.test = ast.parse("not isinstance(verified, VerifiedAccessToken)", mode="eval").body
            self.changed += 1
        return self.generic_visit(node)


@pytest.mark.parametrize(
    ("entry", "case"),
    [("pwd", "no second factor"), ("OTP", "an upper-case OTP"), (" otp", "a padded otp")],
)
def test_widening_the_second_factors_lets_its_case_through(db, entry, case):
    verified, lane = CASES[case](stored_staff_identity())
    assert outcome(staff, verified, lane) == "refused"
    with mutated_resolver(_WidenMfa(entry)) as mutant:
        assert outcome(mutant, verified, lane) == "resolved", (
            f"with {entry!r} among the second factors, {case} was still refused"
        )


def test_isinstance_instead_of_the_exact_class_lets_a_subclass_through(db):
    verified, lane = CASES["a subclass of the verified token"](stored_staff_identity())
    assert outcome(staff, verified, lane) == "refused"
    with mutated_resolver(_IsinstanceForType()) as mutant:
        assert outcome(mutant, verified, lane) == "resolved"


# --------------------------------------- a revocation and a decision on two connections ----

# The decision reads its grant FOR SHARE in its own transaction (§5): a revocation that starts
# after the read waits for the decision, and a decision that reads after a revocation took the
# grant's row waits for it and sees it. Each side runs on its own thread, so on its own session,
# and the other is released only once PostgreSQL shows it waiting on a lock. The test sessions'
# statement timeout is two seconds: each wait is released well within it.


def _organisation():
    from django.apps import apps

    slug = "s" + uuid.uuid4().hex[:12]
    with transaction.atomic():
        organisation = apps.get_model("orgs", "Organisation").objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.customer.test/realms/{slug}",
            name="Synthetic organisation",
            state="prospect",
        )
        apps.get_model("orgs", "SlugReservation").objects.create(
            namespace="organisation", slug=slug, organisation=organisation, state="provisional"
        )
    return organisation


def _unresolved_delivery():
    from apps.outbox.models import OutboxDelivery

    now = timezone.now()
    return OutboxDelivery.objects.create(
        organisation=_organisation(),
        category="message",
        changes_realm=False,
        status="needs_reconciliation",
        operation_ref="synthetic-op",
        started_at=now - dt.timedelta(minutes=1),
        created_at=now,
        updated_at=now,
    )


def _decision(subject_id):
    from apps.jobs import services

    now = timezone.now()
    evidence = services.Evidence(
        provider="scaleway", resource_id="fr-par-1/instance-7", request_id="r", observed_at=now
    )
    return services.ReconciliationDecision(
        subject_id=subject_id,
        exit="fail",
        operation_outcome="no_effect",
        compute_terminated=evidence,
        target_read=evidence,
    )


def _lock_waiters():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
            "AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()"
        )
        return cursor.fetchone()[0]


def _wait_until_waiting(done):
    deadline = time.monotonic() + 1.2
    while time.monotonic() < deadline:
        if done.is_set():
            return False
        if _lock_waiters():
            return True
        time.sleep(0.02)
    return False


class _Side(threading.Thread):
    """One session's work, its result or what it raised."""

    def __init__(self, work):
        super().__init__(daemon=True)
        self.work = work
        self.result = None
        self.error = None
        self.done = threading.Event()

    def run(self):
        try:
            self.result = self.work()
        except BaseException as error:  # noqa: BLE001 - reported by the test
            self.error = error
        finally:
            self.done.set()
            connections.close_all()


def _operators():
    deciding = stored_staff_identity()
    revoking = stored_staff_identity()
    principal = staff.resolve_staff_principal(token(deciding.issuer, deciding.subject), "staff")
    return deciding, revoking, principal


@pytest.mark.django_db(transaction=True)
def test_a_revocation_waits_for_a_decision_that_read_the_grant():
    from apps.identity.staff_roles import revoke_staff_role
    from apps.jobs import services

    deciding, revoking, principal = _operators()
    delivery = _unresolved_delivery()
    read, release = threading.Event(), threading.Event()

    def decide():
        with transaction.atomic():
            result = services.record_delivery_reconciliation_decision(
                principal=principal, decision=_decision(delivery.pk)
            )
            read.set()
            assert release.wait(5)
            return result

    decider = _Side(decide)
    decider.start()
    assert read.wait(5), "the decision did not return inside its caller's transaction"
    revoker = _Side(
        lambda: revoke_staff_role(
            acting_identity_id=revoking.pk, subject=deciding.subject, role="staff_operator"
        )
    )
    revoker.start()
    waited = _wait_until_waiting(revoker.done)
    release.set()
    decider.join(10)
    revoker.join(10)
    assert waited, "a revocation did not wait for a decision that had read the grant"
    assert decider.error is None and isinstance(decider.result, services.DecisionRecorded)
    assert revoker.error is None, revoker.error
    # The revocation finished only after the decision committed: it was still waiting when the
    # decision was released, and the grant the decision relied on is revoked now.
    grant = StaffRole.objects.get(identity_id=deciding.pk, role="staff_operator")
    assert grant.revoked_at is not None


@pytest.mark.django_db(transaction=True)
def test_a_decision_waits_for_a_revocation_and_sees_it():
    from apps.identity.staff_roles import revoke_staff_role
    from apps.jobs import services
    from apps.outbox.models import OutboxDelivery

    deciding, revoking, principal = _operators()
    delivery = _unresolved_delivery()
    revoked, release = threading.Event(), threading.Event()

    def revoke():
        with transaction.atomic():
            grant_id = revoke_staff_role(
                acting_identity_id=revoking.pk, subject=deciding.subject, role="staff_operator"
            )
            revoked.set()
            assert release.wait(5)
            return grant_id

    revoker = _Side(revoke)
    revoker.start()
    assert revoked.wait(5), "the revocation did not return inside its caller's transaction"
    decider = _Side(
        lambda: services.record_delivery_reconciliation_decision(
            principal=principal, decision=_decision(delivery.pk)
        )
    )
    decider.start()
    waited = _wait_until_waiting(decider.done)
    release.set()
    revoker.join(10)
    decider.join(10)
    assert waited, "a decision did not wait for a revocation that held the grant"
    assert revoker.error is None, revoker.error
    assert decider.error is None, decider.error
    assert decider.result == services.DecisionRefused(subject_id=delivery.pk, reason="role_missing")
    assert OutboxDelivery.objects.get(pk=delivery.pk).status == "needs_reconciliation"
