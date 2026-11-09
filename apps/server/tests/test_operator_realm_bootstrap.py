"""The operator-run realm step of the invited pilot: docs/specs/FIRST_OWNER_BOOTSTRAP.md §§5.5, 5.7.

`start_realm_bootstrap`, `complete_realm_bootstrap`, `requeue_realm_bootstrap` and `sweep_jobs`, run
as an operator runs them — `run_from_argv`, so each refusal is asserted by its message and by the
exit status — against the real queue on a real PostgreSQL, over a `realm_create` job the real intake
enqueued. Only the realm's public documents are served by the test: the fetch is the one function
replaced, and what it returns is read and checked by the command's own code.
"""

import ast
import inspect
import threading
from dataclasses import replace
from datetime import timedelta
from io import StringIO
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from customer_http_fixtures import configure, http_signer as http_signer, trust_entry
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, connections, transaction
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.identity.command_principal import staff_principal_for_command
from apps.identity.models import Identity, StaffRole, User
from apps.jobs.keys import derive_key
from apps.jobs.models import Job, JobDispatch, JobReconciliationDecision, JobStep
from apps.jobs.services import Evidence, ReconciliationDecision, record_reconciliation_decision
from apps.orgs import realm_bootstrap as rb
from apps.orgs.intake_services import (
    IntakeActor,
    IntakeRequest,
    IntendedOwner,
    Recorded,
    record_intake,
)
from apps.orgs.models import Organisation, RealmReadiness
from apps.orgs.realm_readiness import realm_ready

pytestmark = pytest.mark.django_db(transaction=True)

STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
SLUG = "pilot-one"
ISSUER = f"https://identity.staff.test/realms/{SLUG}"
OWNER_ADDRESS = "first.owner@customer.test"
INTAKE_PATH = "/api/v1/organisations"
INTAKE_KEY = "00000000-0000-0000-0000-000000000001"


# ------------------------------------------------------------------------------- the world ----


def staff(subject, *, roles=("staff_operator",)):
    user = User.objects.create(email=f"{subject}@staff.test", enabled=True)
    identity = Identity.objects.create(
        user=user,
        organisation=None,
        issuer=STAFF_ISSUER,
        realm="kodera-staff",
        subject=subject,
        email=f"{subject}@staff.test",
        enabled=True,
    )
    for role in roles:
        StaffRole.objects.create(identity=identity, realm="kodera-staff", role=role)
    return identity


def intake(recorder, slug=SLUG, key=INTAKE_KEY):
    with transaction.atomic():
        outcome = record_intake(
            actor=IntakeActor(identity_id=recorder.id),
            request=IntakeRequest(
                slug=slug,
                name="Synthetic pilot",
                instruction_ref="SUP-0001",
                intended_owner=IntendedOwner(email=OWNER_ADDRESS),
                profile={},
            ),
            request_id="req-synthetic-1",
            path=INTAKE_PATH,
            idempotency_key=key,
        )
    assert isinstance(outcome, Recorded)
    return outcome.view


class Realm:
    """The realm's public documents, as the identity service would publish them."""

    def __init__(self, issuer, jwk):
        self.issuer = issuer
        self.discovery = {"issuer": issuer, "jwks_uri": issuer + "/protocol/openid-connect/certs"}
        self.jwks = {"keys": [jwk]}
        self.down = False
        self.fail_after = None  # fail every fetch once this many have answered
        self.fetches = 0

    def fetch(self, url, request_id):
        assert request_id, "a read carries its correlation"
        if self.down or (self.fail_after is not None and self.fetches >= self.fail_after):
            raise rb.RealmUnreachable("synthetic outage")
        self.fetches += 1
        if url == self.issuer + "/.well-known/openid-configuration":
            return dict(self.discovery)
        if url == self.discovery.get("jwks_uri"):
            return dict(self.jwks)
        raise rb.RealmUnreachable("not served")


@pytest.fixture
def w(transactional_db, settings, http_signer, monkeypatch):
    recorder = staff("recorder")
    operator = staff("operator")
    view = intake(recorder)
    organisation = Organisation.objects.get(id=view.organisation_id)
    assert organisation.issuer == ISSUER
    trust = [trust_entry(http_signer, ISSUER), trust_entry(http_signer, STAFF_ISSUER, lane="staff")]
    configure(settings, trust)
    realm = Realm(ISSUER, http_signer[2])
    monkeypatch.setattr(rb, "fetch_document", realm.fetch)
    return SimpleNamespace(
        recorder=recorder,
        operator=operator,
        organisation=organisation,
        job_id=view.job_id,
        realm=realm,
        settings=settings,
        signer=http_signer,
        trust=trust,
    )


def run(capsys, name, *argv):
    """The command as `manage.py` runs it — its parser, `execute`, and a `CommandError` turned into
    its message on standard error and its exit status, as `run_from_argv` does — without
    `run_from_argv`'s closing of every connection under the test: (exit status, out, err)."""
    import sys

    from django.core.management import load_command_class

    app = "jobs" if name == "sweep_jobs" else "orgs"
    command = load_command_class(f"apps.{app}", name)
    options = vars(command.create_parser("manage.py", name).parse_args(list(argv)))
    positional = options.pop("args", ())
    capsys.readouterr()
    try:
        command.execute(*positional, **options)
        code = 0
    except CommandError as error:
        sys.stderr.write(f"CommandError: {error}\n")
        code = error.returncode
    out, err = capsys.readouterr()
    return code, out, err


def evidence(prefix, label, when=None):
    when = when or timezone.now()
    return [
        f"--{prefix}-provider",
        "tooling",
        f"--{prefix}-resource-id",
        f"{SLUG}-{label}",
        f"--{prefix}-request-id",
        f"req-{label}",
        f"--{prefix}-observed-at",
        when.isoformat(),
    ]


def who(identity):
    return ["--staff-identity", str(identity.id), "--organisation", SLUG]


def start(capsys, w, *extra, identity=None):
    return run(capsys, "start_realm_bootstrap", *who(identity or w.operator), *extra)


def outcome_of(n, result="completed", run_next=None):
    args = ["--outcome", result, *evidence("compute", f"run-{n}"), *evidence("target", f"read-{n}")]
    return args + (["--tooling-run", run_next] if run_next else [])


def complete(capsys, w, *extra, result="ok", identity=None, compute=True):
    sign_in = ["--sign-in-result", result, "--sign-in-evidence", "signin-ref-1"] if result else []
    held = evidence("compute", "trust-deploy") if compute else []
    return run(
        capsys, "complete_realm_bootstrap", *who(identity or w.operator), *sign_in, *held, *extra
    )


def job(job_id):
    return Job.objects.get(id=job_id)


def steps(job_id):
    return {s.seq: s.status for s in JobStep.objects.filter(job_id=job_id)}


def written():
    """Everything a command could write, counted."""
    return (
        Job.objects.count(),
        list(Job.objects.order_by("id").values_list("status", "fence", "unresolved_operation_ref")),
        JobDispatch.objects.count(),
        JobReconciliationDecision.objects.count(),
        AuditEvent.objects.count(),
        RealmReadiness.objects.count(),
        list(JobStep.objects.order_by("id").values_list("status")),
    )


def held_on(job_id):
    row = job(job_id)
    return row.status, row.unresolved_operation_ref


def to_trust_hold(capsys, w):
    """Steps 1–6 run through the commands, leaving the job held for the trust entry."""
    code, out, err = start(capsys, w, "--tooling-run", "run-1")
    assert code == 0, err
    for n in range(1, 7):
        code, out, err = start(
            capsys, w, *outcome_of(n, run_next=f"run-{n + 1}" if n < 6 else None)
        )
        assert code == 0, err
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting trust entry")


def refused(result, message):
    code, out, err = result
    assert code == 1, f"exit status {code}, not 1: {err}"
    assert message in err, f"{message!r} not in {err!r}"
    assert "outcome=" in out, "a refusal printed no record"
    return out


def refused_by(constraint, write):
    """`write` refused by the database under the named constraint or trigger."""
    from django.db import IntegrityError

    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        write()
    assert caught.value.__cause__.diag.constraint_name == constraint


def expire(job_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE jobs_job SET lease_expires_at = clock_timestamp() - interval '1 second' "
            "WHERE id = %s AND lease_expires_at IS NOT NULL",
            [job_id],
        )


# --------------------------------------------------------------------------- happy path ----


def test_the_whole_realm_step_runs_to_a_ready_realm(capsys, w):
    code, out, _ = start(capsys, w, "--tooling-run", "run-1")
    assert code == 0
    assert out.strip() == (
        f"start_realm_bootstrap organisation={SLUG} job={w.job_id} step=1 "
        f"staff_identity={w.operator.id} outcome=held:awaiting_tooling"
    )
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting tooling step 1 run run-1")
    lines = [out]
    for n in range(1, 7):
        code, out, err = start(
            capsys, w, *outcome_of(n, run_next=f"run-{n + 1}" if n < 6 else None)
        )
        assert code == 0, err
        lines.append(out)
        if n < 6:
            assert held_on(w.job_id) == (
                "needs_reconciliation",
                f"awaiting tooling step {n + 1} run run-{n + 1}",
            )
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting trust entry")
    assert "outcome=held:awaiting_trust_entry" in lines[-1]
    assert steps(w.job_id) == {**dict.fromkeys(range(1, 7), "succeeded"), 7: "running"}
    assert not realm_ready(organisation_id=w.organisation.id)

    code, out, err = complete(capsys, w)
    assert code == 0, err
    lines.append(out)
    assert out.strip().endswith(f"step=7 staff_identity={w.operator.id} outcome=succeeded")
    row = job(w.job_id)
    assert (row.status, row.error_code) == ("succeeded", None)
    assert steps(w.job_id) == dict.fromkeys(range(1, 8), "succeeded")
    output_ref = JobStep.objects.get(job_id=w.job_id, seq=7).output_ref
    assert "signin-ref-1" in output_ref and "verify " in output_ref
    fact = RealmReadiness.objects.get()
    assert (fact.organisation_id, fact.issuer, fact.realm, fact.job_id) == (
        w.organisation.id,
        ISSUER,
        SLUG,
        w.job_id,
    )
    assert fact.recorded_by_identity_id == w.operator.id
    assert realm_ready(organisation_id=w.organisation.id)
    # No line names an address or anything sealed.
    assert not any("@" in line for line in lines)


def test_the_audit_rows_name_the_staff_actor_and_the_job_rows_keep_the_queues(capsys, w):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    rows = AuditEvent.objects.filter(organisation_id=w.organisation.id)
    created = rows.get(action="realm.created")
    assert (created.actor_type, created.actor_id) == ("staff", w.operator.id)
    assert created.target_urn == f"urn:kodera:realm:{SLUG}" and created.job_id == w.job_id
    decided = rows.filter(action="job.reconciliation_decided")
    assert decided.count() == 7
    assert set(decided.values_list("actor_type", "actor_id")) == {("staff", w.operator.id)}
    job_created = rows.get(action="job.created")
    assert (job_created.actor_type, job_created.actor_id) == ("staff", w.recorder.id)
    queue_rows = rows.filter(action__startswith="job.").exclude(
        action__in=("job.created", "job.reconciliation_decided")
    )
    assert queue_rows.filter(action="job.succeeded").count() == 1
    assert set(queue_rows.values_list("actor_type", flat=True)) == {"system"}
    assert not rows.filter(action="realm.verification_failed").exists()


# ------------------------------------------------------------------------------ refusals ----


@pytest.mark.parametrize("name", ["start", "complete", "requeue"])
def test_every_command_refuses_before_the_cutover_and_does_not_even_sweep(capsys, w, name):
    w.settings.KODERA_INTAKE_ADMITTED = False
    # A lease that expired: a sweep would move it. The gate comes first.
    Job.objects.filter(id=w.job_id).update(
        status="leased", runner_id="dead", lease_expires_at=timezone.now() - timedelta(minutes=5)
    )
    before = written()
    argv = {
        "start": ("start_realm_bootstrap", "--tooling-run", "run-1"),
        "complete": (
            "complete_realm_bootstrap",
            "--sign-in-result",
            "ok",
            "--sign-in-evidence",
            "s",
        ),
        "requeue": ("requeue_realm_bootstrap",),
    }[name]
    refused(run(capsys, argv[0], *who(w.operator), *argv[1:]), "KODERA_INTAKE_ADMITTED is not 1")
    assert written() == before


def _disable(identity):
    Identity.objects.filter(id=identity.id).update(enabled=False)


def _delete_person(identity):
    now = timezone.now()
    User.objects.filter(id=identity.user_id).update(deleted_at=now, purge_after=now + timedelta(1))


def _revoke(identity):
    StaffRole.objects.filter(identity=identity).update(revoked_at=timezone.now())


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (_disable, "names no enabled staff identity"),
        (_delete_person, "names no enabled staff identity"),
        (_revoke, "holds no current staff_operator grant"),
    ],
)
@pytest.mark.parametrize("name", ["start_realm_bootstrap", "requeue_realm_bootstrap"])
def test_the_staff_identity_is_refused_unless_current_and_an_operator(
    capsys, w, change, message, name
):
    change(w.operator)
    before = written()
    refused(
        run(capsys, name, *who(w.operator), "--tooling-run", "run-1")
        if name == "start_realm_bootstrap"
        else run(capsys, name, *who(w.operator)),
        message,
    )
    assert written() == before


def test_an_unknown_staff_identity_and_organisation_are_refused(capsys, w):
    before = written()
    refused(
        run(
            capsys,
            "start_realm_bootstrap",
            "--staff-identity",
            str(w.organisation.id),
            "--organisation",
            SLUG,
            "--tooling-run",
            "r",
        ),
        "names no enabled staff identity",
    )
    refused(
        run(
            capsys,
            "start_realm_bootstrap",
            "--staff-identity",
            str(w.operator.id),
            "--organisation",
            "no-such-org",
            "--tooling-run",
            "r",
        ),
        "no organisation has that slug",
    )
    assert written() == before


def test_a_customer_identity_is_not_a_staff_identity(capsys, w):
    owner = User.objects.create(email="someone@customer.test", enabled=True)
    customer = Identity.objects.create(
        user=owner,
        organisation=w.organisation,
        issuer=ISSUER,
        realm=SLUG,
        subject="c-1",
        email="someone@customer.test",
        enabled=True,
    )
    refused(
        start(capsys, w, "--tooling-run", "r", identity=customer), "names no enabled staff identity"
    )


def test_start_refuses_a_held_step_without_its_outcome_or_the_next_run(capsys, w):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    before = written()
    refused(start(capsys, w), "held on tooling step 1: give its --outcome")
    refused(start(capsys, w, *outcome_of(1)), "step 2 is a tooling step: give the --tooling-run")
    refused(
        start(capsys, w, "--outcome", "completed", *evidence("compute", "x"), "--tooling-run", "r"),
        "--outcome needs the --compute-* and --target-* evidence",
    )
    refused(
        start(capsys, w, *evidence("compute", "x"), "--tooling-run", "r"),
        "evidence was given without --outcome",
    )
    refused(
        start(
            capsys,
            w,
            "--outcome",
            "completed",
            *evidence("compute", "x")[:4],
            *evidence("target", "y"),
            "--tooling-run",
            "r",
        ),
        "--compute-* needs all four",
    )
    refused(
        start(capsys, w, *outcome_of(1, run_next="has space")), "--tooling-run must be a reference"
    )
    refused(
        start(capsys, w, *outcome_of(1, run_next="someone@example.test")),
        "--tooling-run must be a reference",
    )
    assert written() == before


def test_a_decision_the_queue_refuses_writes_nothing(capsys, w):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    before = written()
    stale = timezone.now() - timedelta(hours=1)
    result = start(
        capsys,
        w,
        "--outcome",
        "completed",
        *evidence("compute", "c", stale),
        *evidence("target", "t", stale),
        "--tooling-run",
        "run-2",
    )
    refused(result, "the queue refused the decision (evidence_out_of_order)")
    assert written() == before


def test_start_hands_step_7_to_complete_and_complete_hands_steps_1_to_6_to_start(capsys, w):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    before = written()
    refused(complete(capsys, w), "held on tooling step 1: run start_realm_bootstrap")
    assert written() == before
    for n in range(1, 7):
        assert start(capsys, w, *outcome_of(n, run_next=f"run-{n + 1}" if n < 6 else None))[0] == 0
    before = written()
    refused(
        start(capsys, w, *outcome_of(7)),
        "which is not a tooling step: run complete_realm_bootstrap",
    )
    assert written() == before


def test_complete_refuses_without_the_sign_in_or_the_holds_evidence(capsys, w):
    to_trust_hold(capsys, w)
    before = written()
    refused(
        complete(capsys, w, result=None),
        "--sign-in-result and --sign-in-evidence are both required",
    )
    refused(complete(capsys, w, compute=False), "give the --compute-* evidence")
    assert written() == before


def test_complete_writes_nothing_when_the_realm_does_not_answer(capsys, w):
    to_trust_hold(capsys, w)
    w.realm.down = True
    before = written()
    refused(complete(capsys, w), "could not be read; nothing written")
    assert written() == before
    w.realm.down = False
    assert complete(capsys, w)[0] == 0


def test_complete_refuses_an_undispatched_verify_before_fetching_or_writing(capsys, w):
    JobStep.objects.filter(job_id=w.job_id, seq__lt=7).update(status="succeeded")
    before = written()
    refused(complete(capsys, w), "step 7 was never held for the trust entry")
    assert written() == before
    assert w.realm.fetches == 0


@pytest.mark.parametrize("reference", ["foreign operation", "awaiting tooling step 2 run foreign"])
def test_start_refuses_a_malformed_tooling_hold_without_a_decision(capsys, w, reference):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    Job.objects.filter(id=w.job_id).update(unresolved_operation_ref=reference)
    before = written()
    refused(start(capsys, w, *outcome_of(1, run_next="run-2")), "not a tooling step")
    assert written() == before


@pytest.mark.parametrize("status", ["leased", "running"])
@pytest.mark.parametrize("name", ["start", "complete"])
def test_a_live_lease_is_refused(capsys, w, status, name):
    Job.objects.filter(id=w.job_id).update(
        status=status, runner_id="another", lease_expires_at=timezone.now() + timedelta(minutes=2)
    )
    before = written()
    result = start(capsys, w, "--tooling-run", "r") if name == "start" else complete(capsys, w)
    refused(result, "the job is claimed until")
    assert written() == before


@pytest.mark.parametrize(
    ("status", "message"),
    [
        ("failed", "replace it with requeue_realm_bootstrap"),
        ("cancelled", "replace it with requeue_realm_bootstrap"),
        ("succeeded", "has already succeeded"),
    ],
)
def test_an_ended_job_is_refused(capsys, w, status, message):
    Job.objects.filter(id=w.job_id).update(
        status=status, error_code="step_failed" if status == "failed" else None
    )
    before = written()
    refused(start(capsys, w, "--tooling-run", "r"), message)
    refused(complete(capsys, w), message)
    assert written() == before


def test_an_organisation_without_a_realm_job_is_refused(capsys, w):
    from test_customer_persistence_models import anchor, anchor_models

    anchor(
        anchor_models(),
        slug="bare-org",
        state="prospect",
        owners=0,
        reservation_state="provisional",
    )
    refused(
        run(
            capsys,
            "start_realm_bootstrap",
            "--staff-identity",
            str(w.operator.id),
            "--organisation",
            "bare-org",
            "--tooling-run",
            "r",
        ),
        "has no realm_create job",
    )


# ------------------------------------------------------------------------ the outcomes ----


def test_no_effect_dispatches_the_same_step_again_and_partial_fails_the_job(capsys, w):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    code, out, err = start(capsys, w, *outcome_of(1, "no_effect", run_next="run-1b"))
    assert code == 0, err
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting tooling step 1 run run-1b")
    assert not AuditEvent.objects.filter(action="realm.created").exists()
    code, out, err = start(capsys, w, *outcome_of(1, "partial"))
    assert code == 0, err
    assert "outcome=failed:reconciliation_failed" in out
    row = job(w.job_id)
    assert (row.status, row.error_code) == ("failed", "reconciliation_failed")


# --------------------------------------------------------------------------- the verify ----


def _other_issuer(w):
    w.realm.discovery["issuer"] = "https://identity.staff.test/realms/elsewhere"


def _jwks_elsewhere(w):
    w.realm.discovery["jwks_uri"] = "https://elsewhere.test/certs"


def _untrusted(w):
    configure(w.settings, [trust_entry(w.signer, STAFF_ISSUER, lane="staff")])


def _other_keys(w):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = __import__("json").loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="another-kid", alg="RS256", use="sig")
    w.realm.jwks = {"keys": [public]}


def _expired_pin(w):
    w.settings.KODERA_AUTH_TRUST = tuple(
        replace(entry, snapshot=replace(entry.snapshot, expires_at=0))
        if entry.snapshot.issuer == ISSUER
        else entry
        for entry in w.settings.KODERA_AUTH_TRUST
    )


def _wrong_lane(w):
    configure(w.settings, [trust_entry(w.signer, ISSUER, lane="staff")])


def _unreadable_keys(w):
    w.realm.jwks = {"keys": [{"kid": "invalid", "kty": "RSA", "alg": "RS256"}]}


def _foreign_pin(w):
    configure(w.settings, [trust_entry(w.signer, ISSUER + "-other")])


@pytest.mark.parametrize(
    ("change", "reason", "sign_in"),
    [
        (_other_issuer, "discovery_issuer_differs", "ok"),
        (_jwks_elsewhere, "jwks_uri_not_of_the_issuer", "ok"),
        (_untrusted, "issuer_not_in_trust_configuration", "ok"),
        (_foreign_pin, "issuer_not_in_trust_configuration", "ok"),
        (_expired_pin, "issuer_not_in_trust_configuration", "ok"),
        (_wrong_lane, "issuer_not_in_trust_configuration", "ok"),
        (_unreadable_keys, "published_keys_unreadable", "ok"),
        (_other_keys, "published_keys_differ_from_pinned", "ok"),
        (lambda w: None, "test_sign_in_failed", "failed"),
    ],
)
def test_a_definite_mismatch_fails_the_job_with_its_reason(capsys, w, change, reason, sign_in):
    to_trust_hold(capsys, w)
    change(w)
    code, out, err = complete(capsys, w, result=sign_in)
    assert code == 1 and f"mismatch ({reason})" in err
    assert f"outcome=failed:{reason}" in out
    row = job(w.job_id)
    assert (row.status, row.error_code) == ("failed", "step_failed")
    assert steps(w.job_id)[7] == "failed"
    assert reason in JobStep.objects.get(job_id=w.job_id, seq=7).output_ref
    failed = AuditEvent.objects.get(action="realm.verification_failed")
    assert (failed.actor_type, failed.actor_id, failed.metadata["reason"]) == (
        "staff",
        w.operator.id,
        reason,
    )
    assert not RealmReadiness.objects.exists()
    assert not realm_ready(organisation_id=w.organisation.id)


@pytest.mark.parametrize(
    ("change", "reason", "sign_in", "predicate"),
    [
        (_other_issuer, "discovery_issuer_differs", "ok", None),
        (_jwks_elsewhere, "jwks_uri_not_of_the_issuer", "ok", None),
        (_untrusted, "issuer_not_in_trust_configuration", "ok", None),
        (
            _foreign_pin,
            "issuer_not_in_trust_configuration",
            "ok",
            "entry.snapshot.issuer == read.issuer",
        ),
        (
            _expired_pin,
            "issuer_not_in_trust_configuration",
            "ok",
            "entry.snapshot.expires_at > now",
        ),
        (_wrong_lane, "issuer_not_in_trust_configuration", "ok", "entry.lane == 'customer'"),
        (_unreadable_keys, "published_keys_unreadable", "ok", None),
        (_other_keys, "published_keys_differ_from_pinned", "ok", None),
        (lambda w: None, "test_sign_in_failed", "failed", None),
    ],
)
def test_each_verify_guard_has_a_named_behavioral_mutation_proof(
    capsys, w, monkeypatch, change, reason, sign_in, predicate
):
    """Mutants run the complete real-queue acceptance above; setup errors are never caught."""
    tree = ast.parse(inspect.getsource(rb.mismatch))
    edits = 0

    class WeakenOneGuard(ast.NodeTransformer):
        def visit_Return(self, node):
            nonlocal edits
            if (
                predicate is None
                and isinstance(node.value, ast.Constant)
                and node.value.value == reason
            ):
                edits += 1
                node.value = ast.Constant(None)
            return self.generic_visit(node)

        def visit_Compare(self, node):
            nonlocal edits
            if predicate is not None and ast.unparse(node) == predicate:
                edits += 1
                return ast.Constant(True)
            return self.generic_visit(node)

    tree = WeakenOneGuard().visit(tree)
    assert edits == 1, f"expected one verify-guard mutation, got {edits}"
    ast.fix_missing_locations(tree)
    namespace = dict(rb.mismatch.__globals__)
    exec(compile(tree, inspect.getsourcefile(rb.mismatch), "exec"), namespace)  # noqa: S102
    monkeypatch.setattr(rb, "mismatch", namespace["mismatch"])
    with pytest.raises(AssertionError):
        test_a_definite_mismatch_fails_the_job_with_its_reason(capsys, w, change, reason, sign_in)
    # The exact first acceptance assertion is the catch: it wrongly admitted success. Verify
    # the mutation reached that state rather than causing a fixture/helper assertion instead.
    assert job(w.job_id).status == "succeeded"
    assert steps(w.job_id)[7] == "succeeded"
    assert RealmReadiness.objects.count() == 1


def test_a_verify_that_does_not_answer_holds_the_job_and_runs_again(capsys, w):
    to_trust_hold(capsys, w)
    w.realm.fail_after = 2  # the first read answers, the verify's does not
    code, out, err = complete(capsys, w)
    assert code == 1 and "did not answer the verify" in err
    assert "outcome=held:verify_unanswered" in out
    assert held_on(w.job_id) == ("needs_reconciliation", f"verify {ISSUER}")
    assert not AuditEvent.objects.filter(action="realm.verification_failed").exists()
    w.realm.fail_after = None
    code, out, err = complete(capsys, w)
    assert code == 0, err
    assert job(w.job_id).status == "succeeded"


# ------------------------------------------------------------------ the realm-ready fact ----


def test_the_fact_counts_only_once_the_job_succeeded_and_only_while_trusted(capsys, w, monkeypatch):
    to_trust_hold(capsys, w)
    real_finish = rb.finish_job

    def crash(**kwargs):
        raise RuntimeError("synthetic crash before the job's end")

    monkeypatch.setattr(rb, "finish_job", crash)
    with pytest.raises(RuntimeError, match="synthetic crash"):
        call_command(
            "complete_realm_bootstrap",
            *who(w.operator),
            "--sign-in-result",
            "ok",
            "--sign-in-evidence",
            "s1",
            *evidence("compute", "deploy"),
            stdout=StringIO(),
        )
    assert RealmReadiness.objects.count() == 1, "the fact is written before the end"
    assert job(w.job_id).status == "running"
    assert not realm_ready(organisation_id=w.organisation.id), "a fact counted before its job ended"

    # Re-entry: the lease left by the crash is swept, and the next run ends the job.
    monkeypatch.setattr(rb, "finish_job", real_finish)
    refused(complete(capsys, w, compute=False), "the job is claimed until")
    expire(w.job_id)
    verify_dispatches = JobDispatch.objects.filter(job_id=w.job_id, step__seq=7).count()
    code, out, err = complete(capsys, w, compute=False)
    assert code == 0, err
    assert job(w.job_id).status == "succeeded"
    assert JobDispatch.objects.filter(job_id=w.job_id, step__seq=7).count() == verify_dispatches, (
        "a recorded verify was run again"
    )
    assert RealmReadiness.objects.count() == 1
    assert realm_ready(organisation_id=w.organisation.id)

    # issuer_untrusted withdraws it, and it counts again once the entry is back.
    _untrusted(w)
    assert not realm_ready(organisation_id=w.organisation.id)
    configure(w.settings, w.trust)
    assert realm_ready(organisation_id=w.organisation.id)
    expired = [trust_entry(w.signer, ISSUER, expires_at=int(timezone.now().timestamp()) + 30)]
    configure(w.settings, expired)
    import time_machine

    with time_machine.travel(timezone.now() + timedelta(minutes=1), tick=False):
        assert not realm_ready(organisation_id=w.organisation.id), "an expired entry still counted"


def test_a_revoked_fact_does_not_count(capsys, w):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    RealmReadiness.objects.update(revoked_at=timezone.now())
    assert not realm_ready(organisation_id=w.organisation.id)


@pytest.mark.parametrize("latest_status", ["queued", "succeeded"])
def test_an_earlier_fact_does_not_count_for_a_new_creation_generation(capsys, w, latest_status):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    assert realm_ready(organisation_id=w.organisation.id)
    latest = Job.objects.create(
        organisation_id=w.organisation.id,
        kind="realm_create",
        idempotency_key=derive_key(["new-generation", w.job_id]),
        desired_spec_hash=derive_key(["spec", w.organisation.id]),
        max_attempts=3,
        actor_type="staff",
        actor_id=w.operator.id,
        status=latest_status,
    )
    assert rb.jobs_newest_first(w.organisation.id)[0].id == latest.id
    assert not realm_ready(organisation_id=w.organisation.id)


@pytest.mark.parametrize(
    "field",
    [
        "id",
        "organisation_id",
        "issuer",
        "realm",
        "job_id",
        "recorded_by_identity_id",
        "recorded_by_realm",
        "recorded_at",
    ],
)
def test_every_recorded_fact_field_is_immutable(capsys, w, field):
    from uuid import uuid4

    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    fact = RealmReadiness.objects.get()
    original = getattr(fact, field)
    changed = (
        original + timedelta(seconds=1)
        if field == "recorded_at"
        else original + "-changed"
        if isinstance(original, str)
        else uuid4()
    )
    refused_by(
        "realm_readiness_immutable",
        lambda: RealmReadiness.objects.filter(pk=fact.pk).update(**{field: changed}),
    )
    fact.refresh_from_db()
    assert getattr(fact, field) == original
    assert realm_ready(organisation_id=w.organisation.id)


def test_fact_uniqueness_and_revocation_clock_are_enforced(capsys, w):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    fact = RealmReadiness.objects.get()
    refused_by(
        "realm_readiness_job_unique",
        lambda: RealmReadiness.objects.create(
            organisation_id=fact.organisation_id,
            issuer=fact.issuer,
            realm=fact.realm,
            job_id=fact.job_id,
            recorded_by_identity_id=fact.recorded_by_identity_id,
        ),
    )
    refused_by(
        "realm_readiness_revocation_valid",
        lambda: RealmReadiness.objects.filter(pk=fact.pk).update(
            revoked_at=fact.recorded_at - timedelta(seconds=1)
        ),
    )
    RealmReadiness.objects.filter(pk=fact.pk).update(revoked_at=fact.recorded_at)
    assert not realm_ready(organisation_id=w.organisation.id)


@pytest.mark.parametrize("lost", [False, None])
def test_a_lost_fenced_step_write_stops_before_dispatch(capsys, w, monkeypatch, lost):
    monkeypatch.setattr(rb, "record_step", lambda **kw: lost)
    result = start(capsys, w, "--tooling-run", "synthetic-run")
    out = refused(result, "this command's claim was lost")
    assert "outcome=claim_lost" in out
    assert JobDispatch.objects.count() == 0
    assert not RealmReadiness.objects.exists()
    assert w.realm.fetches == 0


def test_the_fact_is_immutable_but_for_its_revocation(capsys, w):
    to_trust_hold(capsys, w)
    assert complete(capsys, w)[0] == 0
    refused_by(
        "realm_readiness_immutable", lambda: RealmReadiness.objects.update(issuer=ISSUER + "x")
    )
    refused_by("realm_readiness_immutable", lambda: RealmReadiness.objects.all().delete())
    RealmReadiness.objects.update(revoked_at=timezone.now())
    refused_by(
        "realm_readiness_immutable",
        lambda: RealmReadiness.objects.update(revoked_at=timezone.now()),
    )


def test_the_fact_names_only_its_organisations_own_issuer(w):
    refused_by(
        "realm_readiness_organisation_binding_fk",
        lambda: RealmReadiness.objects.create(
            organisation_id=w.organisation.id,
            issuer="https://identity.staff.test/realms/x",
            realm=SLUG,
            job_id=w.job_id,
            recorded_by_identity_id=w.operator.id,
        ),
    )
    refused_by(
        "realm_readiness_recorder_staff_fk",
        lambda: RealmReadiness.objects.create(
            organisation_id=w.organisation.id,
            issuer=ISSUER,
            realm=SLUG,
            job_id=w.job_id,
            recorded_by_identity_id=w.organisation.id,
        ),
    )


# ------------------------------------------------------------------------------ re-entry ----


def test_a_crash_between_the_decision_and_the_claim_resumes_without_a_second_decision(
    capsys, w, monkeypatch
):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    real_claim = rb.claim_job

    def crash(**kwargs):
        raise RuntimeError("synthetic crash after the decision")

    monkeypatch.setattr(rb, "claim_job", crash)
    with pytest.raises(RuntimeError, match="synthetic crash"):
        call_command(
            "start_realm_bootstrap",
            *who(w.operator),
            *outcome_of(1, run_next="run-2"),
            stdout=StringIO(),
        )
    assert job(w.job_id).status == "queued"
    assert steps(w.job_id)[2] == "pending"
    decisions = JobReconciliationDecision.objects.count()
    monkeypatch.setattr(rb, "claim_job", real_claim)
    code, out, err = start(capsys, w, *outcome_of(1, run_next="run-2"))
    assert code == 0, err
    assert JobReconciliationDecision.objects.count() == decisions, "the decision was recorded twice"
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting tooling step 2 run run-2")
    assert AuditEvent.objects.filter(action="realm.created").count() == 1


def test_a_crash_between_the_dispatch_and_the_hold_is_swept_and_never_dispatched_again(
    capsys, w, monkeypatch
):
    def crash(**kwargs):
        raise RuntimeError("synthetic crash after the dispatch")

    monkeypatch.setattr(rb, "hold_for_reconciliation", crash)
    with pytest.raises(RuntimeError, match="synthetic crash"):
        call_command(
            "start_realm_bootstrap", *who(w.operator), "--tooling-run", "run-1", stdout=StringIO()
        )
    monkeypatch.undo()
    monkeypatch.setattr(rb, "fetch_document", w.realm.fetch)
    assert job(w.job_id).status == "running"
    refused(start(capsys, w, "--tooling-run", "run-1"), "the job is claimed until")
    expire(w.job_id)
    # The sweep, run first, holds the job on the open dispatch: the next run asks for its outcome.
    refused(
        start(capsys, w, "--tooling-run", "run-1"), "held on tooling step 1: give its --outcome"
    )
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting tooling step 1 run run-1")
    assert JobDispatch.objects.filter(job_id=w.job_id).count() == 1


def test_sweep_jobs_runs_the_queues_sweep(capsys, w, monkeypatch):
    def crash(**kwargs):
        raise RuntimeError("synthetic crash after the dispatch")

    monkeypatch.setattr(rb, "hold_for_reconciliation", crash)
    with pytest.raises(RuntimeError):
        call_command(
            "start_realm_bootstrap", *who(w.operator), "--tooling-run", "run-1", stdout=StringIO()
        )
    expire(w.job_id)
    code, out, _ = run(capsys, "sweep_jobs")
    assert (code, out.strip()) == (0, "sweep_jobs outcome=swept")
    assert held_on(w.job_id) == ("needs_reconciliation", "awaiting tooling step 1 run run-1")
    required = AuditEvent.objects.get(action="job.reconciliation_required")
    assert required.actor_type == "system"


# --------------------------------------------------------------------------- concurrency ----


def _in_thread(results, index, name, argv, barrier=None):
    try:
        call_command(name, *argv, stdout=StringIO())
        results[index] = "ok"
    except CommandError as error:
        results[index] = str(error)
    except Exception as error:  # noqa: BLE001 - reported to the test
        results[index] = repr(error)
    finally:
        connections.close_all()


def test_two_concurrent_starts_record_one_decision_and_one_dispatch(capsys, w, monkeypatch):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    barrier = threading.Barrier(2, timeout=20)
    real = rb.latest_progress

    def both_read_first(organisation):
        progress = real(organisation)
        barrier.wait()
        return progress

    monkeypatch.setattr(rb, "latest_progress", both_read_first)
    results = [None, None]
    argv = [*who(w.operator), *outcome_of(1, run_next="run-2")]
    threads = [
        threading.Thread(target=_in_thread, args=(results, i, "start_realm_bootstrap", argv))
        for i in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert sorted(results, key=str) == sorted(
        ["ok", "the queue refused the decision (not_in_reconciliation); nothing written"], key=str
    ), results
    assert JobReconciliationDecision.objects.count() == 1
    assert JobDispatch.objects.filter(job_id=w.job_id, step__seq=2).count() == 1
    assert AuditEvent.objects.filter(action="realm.created").count() == 1


# ------------------------------------------------------------------------------- requeue ----


def _fail(job_id):
    Job.objects.filter(id=job_id).update(status="failed", error_code="step_failed")


def test_requeue_replaces_a_failed_job_once_and_a_repeat_returns_it(capsys, w):
    _fail(w.job_id)
    code, out, err = run(capsys, "requeue_realm_bootstrap", *who(w.operator))
    assert code == 0, err
    new = Job.objects.exclude(id=w.job_id).get()
    assert new.idempotency_key == derive_key(["requeue", w.job_id])
    assert new.desired_spec_hash == job(w.job_id).desired_spec_hash
    assert (new.kind, new.status, new.organisation_id) == (
        "realm_create",
        "queued",
        w.organisation.id,
    )
    assert f"job={new.id}" in out and "outcome=requeued" in out
    audit = AuditEvent.objects.get(action="job.created", job_id=new.id)
    assert (audit.actor_type, audit.actor_id) == ("staff", w.operator.id)
    before = written()
    code, out, err = run(capsys, "requeue_realm_bootstrap", *who(w.operator))
    assert code == 0 and f"job={new.id}" in out and "outcome=already_requeued" in out
    assert written() == before
    # The intake's own key still answers the original job, never the replacement.
    again = intake(w.recorder)
    assert (again.organisation_id, again.job_id) == (w.organisation.id, w.job_id)
    assert Job.objects.count() == 2
    # The new job is the one the commands work on.
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    assert held_on(new.id) == ("needs_reconciliation", "awaiting tooling step 1 run run-1")


@pytest.mark.parametrize("status", ["queued", "needs_reconciliation", "succeeded"])
def test_requeue_refuses_a_job_that_did_not_fail(capsys, w, status):
    if status == "needs_reconciliation":
        assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    elif status == "succeeded":
        Job.objects.filter(id=w.job_id).update(status="succeeded")
    before = written()
    refused(
        run(capsys, "requeue_realm_bootstrap", *who(w.operator)),
        f"the latest realm_create job is {status}: only a failed or cancelled one",
    )
    assert written() == before


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_requeue_can_replace_a_terminal_replacement(capsys, w, status):
    _fail(w.job_id)
    assert run(capsys, "requeue_realm_bootstrap", *who(w.operator))[0] == 0
    first_replacement = Job.objects.exclude(id=w.job_id).get()
    Job.objects.filter(id=first_replacement.id).update(
        status=status, error_code="step_failed" if status == "failed" else None
    )

    code, out, err = run(capsys, "requeue_realm_bootstrap", *who(w.operator))
    assert code == 0, err
    latest = Job.objects.exclude(id__in=[w.job_id, first_replacement.id]).get()
    assert latest.idempotency_key == derive_key(["requeue", first_replacement.id])
    assert latest.status == "queued" and "outcome=requeued" in out
    before = written()
    code, out, err = run(capsys, "requeue_realm_bootstrap", *who(w.operator))
    assert code == 0 and f"job={latest.id}" in out and "outcome=already_requeued" in out, err
    assert written() == before


def test_requeue_refuses_an_organisation_that_is_not_prospect(capsys, w):
    from test_customer_persistence_models import anchor, anchor_models

    active, _, _ = anchor(anchor_models(), slug="active-org", state="active", owners=1)
    Job.objects.create(
        organisation_id=active.id,
        kind="realm_create",
        idempotency_key=derive_key(["synthetic", active.id]),
        desired_spec_hash=derive_key(["spec", active.id]),
        max_attempts=3,
        actor_type="staff",
        status="failed",
        error_code="step_failed",
    )
    before = written()
    refused(
        run(
            capsys,
            "requeue_realm_bootstrap",
            "--staff-identity",
            str(w.operator.id),
            "--organisation",
            "active-org",
        ),
        "is active, not prospect",
    )
    assert written() == before


def test_two_concurrent_requeues_enqueue_one_job(w, monkeypatch):
    _fail(w.job_id)
    barrier = threading.Barrier(2, timeout=20)
    real = rb.jobs_newest_first

    def both_read_first(organisation_id):
        found = real(organisation_id)
        barrier.wait()
        return found

    monkeypatch.setattr(rb, "jobs_newest_first", both_read_first)
    results = [None, None]
    threads = [
        threading.Thread(
            target=_in_thread, args=(results, i, "requeue_realm_bootstrap", who(w.operator))
        )
        for i in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert results == ["ok", "ok"], results
    assert Job.objects.count() == 2
    assert AuditEvent.objects.filter(action="job.created").count() == 2  # the intake's and one


# ----------------------------------------------------------------- the decision's own role ----


def test_a_command_principal_without_a_grant_is_refused_by_the_decision_itself(capsys, w):
    assert start(capsys, w, "--tooling-run", "run-1")[0] == 0
    _revoke(w.operator)
    principal = staff_principal_for_command(w.operator.id)
    now = timezone.now()
    piece = Evidence(provider="tooling", resource_id="r", request_id="q", observed_at=now)
    result = record_reconciliation_decision(
        principal=principal,
        decision=ReconciliationDecision(
            subject_id=w.job_id,
            exit="resume",
            operation_outcome="completed",
            compute_terminated=piece,
            target_read=piece,
        ),
    )
    assert getattr(result, "reason", None) == "role_missing"
