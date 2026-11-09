"""The intake's named fault points: core/faults.py, at the sites docs/specs/FIRST_SLICE_G1.md names.

Driven through the real URL resolver, the production token verifier and the replay store, against
the test database, by a staff actor this module builds (the first-slice harness's signed fixture
never carries a second factor, so it cannot reach the intake). A crash is the in-process
`SimulatedCrash` (lane decision D5): it is a BaseException, so it passes every `except Exception`
in Core and rolls back the transaction it leaves, as a killed process's transaction rolls back.

Each property is the one FS-BOOT-02, FS-OP-01 and FS-CON-06 rely on: what each site has written
when it is reached, all-or-nothing at each point inside the transaction, a hold that answers a
contender `409 idempotency-key-in-flight` with the winner's `X-Operation-Ref`, one queued job with
its steps after the commit, and an open dispatch when `close_dispatch` crashes. Arming is refused
outside the test profile.
"""

import json
import threading
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.db import connection
from django.test import Client

from apps.audit.models import AuditEvent
from apps.identity.models import Identity, StaffRole, User
from apps.jobs import services
from apps.jobs.keys import derive_key
from apps.jobs.models import Job, JobDispatch, JobStep
from apps.orgs.models import Organisation, OrganisationIntake, SlugReservation
from core import faults
from core.idempotency.models import IdempotencyRecord
from services.identity.trusted_issuers import load_trust

PATH = "/api/v1/organisations"
PROBLEMS = "https://kodera.io/problems/"
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
KID = "fault-point-test-key"
OPERATION_REF = "X-Operation-Ref"
IN_TRANSACTION = (
    "intake:after-desired-state",
    "intake:after-audit",
    "intake:after-job",
    "intake:before-commit",
)
AFTER_COMMIT = ("intake:after-commit", "intake:after-commit-before-dispatch")
REALM_ACKNOWLEDGEMENT = "realm_create:after-provider-success-before-acknowledgement"


class Barrier:
    """The two events a hold point needs: the harness's `Hold` has the same shape."""

    def __init__(self) -> None:
        self.reached = threading.Event()
        self.released = threading.Event()


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def body(slug="fault-sa"):
    return {
        "slug": slug,
        "name": "Fault",
        "legal_name": "Fault SAS",
        "country": "FR",
        "vat_number": None,
        "billing_email": "compta@fault.test",
        "email_domains": ["fault.test"],
        "locale": "fr",
        "instruction_ref": "SUP-0418",
        "intended_owner": {"email": "owner@fault.test", "display_name": "Owner"},
    }


@pytest.fixture
def world(transactional_db, settings, signing_key):
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key()))
    public.update(kid=KID, alg="RS256", use="sig", key_ops=["verify"])
    settings.KODERA_AUTH_TRUST = load_trust(
        json.dumps(
            [
                {
                    "lane": "staff",
                    "issuer": STAFF_ISSUER,
                    "generation": "fault-point-test",
                    "expires_at": int(time.time()) + 3600,
                    "public_jwks": {"keys": [public]},
                }
            ]
        )
    )
    user = User.objects.create(email="operator@staff.test", enabled=True)
    operator = Identity.objects.create(
        user=user,
        organisation=None,
        issuer=STAFF_ISSUER,
        realm="kodera-staff",
        subject="operator-fault",
        email="operator@staff.test",
        enabled=True,
    )
    StaffRole.objects.create(identity=operator, realm="kodera-staff", role="staff_operator")

    def post(key="fault-key-000000000001", slug="fault-sa"):
        now = int(time.time())
        token = jwt.encode(
            {
                "iss": STAFF_ISSUER,
                "sub": "operator-fault",
                "aud": "kodera-server",
                "iat": now,
                "exp": now + 300,
                "typ": "Bearer",
                "amr": ["pwd", "otp"],
            },
            signing_key,
            algorithm="RS256",
            headers={"kid": KID},
        )
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        return client.post(
            PATH,
            data=json.dumps(body(slug)).encode(),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + token,
            HTTP_IDEMPOTENCY_KEY=key,
        )

    yield SimpleNamespace(post=post, operator=operator)
    faults.disarm_all()


@pytest.fixture
def armed():
    """Arm points for one test, and always leave the process with none armed."""
    yield faults.arm
    faults.disarm_all()


def reference(identity_id, key):
    return derive_key([f"urn:kodera:identity:{identity_id}", "POST", PATH, "realm_create", key, 0])


def written():
    return {
        "organisations": Organisation.objects.count(),
        "reservations": SlugReservation.objects.count(),
        "jobs": Job.objects.count(),
        "steps": JobStep.objects.count(),
        "intake_recorded": AuditEvent.objects.filter(action="organisation.intake_recorded").count(),
        "job_created": AuditEvent.objects.filter(action="job.created").count(),
        "intakes": OrganisationIntake.objects.count(),
        "replay_entries": IdempotencyRecord.objects.count(),
    }


NOTHING = {
    "organisations": 0,
    "reservations": 0,
    "jobs": 0,
    "steps": 0,
    "intake_recorded": 0,
    "job_created": 0,
    "intakes": 0,
    "replay_entries": 0,
}
COMMITTED = {
    "organisations": 1,
    "reservations": 1,
    "jobs": 1,
    "steps": 7,
    "intake_recorded": 1,
    "job_created": 1,
    "intakes": 1,
    "replay_entries": 1,
}


# --------------------------------------------------------------------------- sites ----


def test_each_site_is_reached_once_where_its_name_says(world, monkeypatch):
    """What the intake's own connection has written when each site is reached: the order of
    JOB_QUEUE.md §4.1 (job row, the caller's audit, steps, job.created), then the intake row, then
    the replay entry, which exists only after the commit."""
    seen = {}

    def observe(site):
        seen[site] = written()

    monkeypatch.setattr(faults, "reach", observe)
    response = world.post()
    assert response.status_code == 201, response.content
    assert list(seen) == [
        "intake:after-desired-state",
        "intake:after-audit",
        "intake:after-job",
        "intake:before-commit",
        "intake:after-commit",
    ], "the intake reached its sites in another order, or reached one twice"
    assert seen["intake:after-desired-state"] == NOTHING | {"organisations": 1, "reservations": 1}
    assert seen["intake:after-audit"] == NOTHING | {
        "organisations": 1,
        "reservations": 1,
        "jobs": 1,
        "intake_recorded": 1,
    }
    assert seen["intake:after-job"] == COMMITTED | {"intakes": 0, "replay_entries": 0}
    assert seen["intake:before-commit"] == COMMITTED | {"replay_entries": 0}
    assert seen["intake:after-commit"] == COMMITTED


# --------------------------------------------------------------- all or nothing ----


@pytest.mark.parametrize("point", IN_TRANSACTION)
def test_a_crash_inside_the_intake_transaction_writes_nothing_and_the_retry_records_once(
    world, armed, point
):
    armed(point)
    with pytest.raises(faults.SimulatedCrash) as crash:
        world.post()
    assert crash.value.point == point
    assert faults.disarm(point) == 1, f"{point} was not reached exactly once"
    assert written() == NOTHING, f"a crash at {point} left part of the intake committed"

    retried = world.post()
    assert retried.status_code == 201, retried.content
    assert "Idempotency-Replayed" not in retried.headers
    assert retried.headers[OPERATION_REF] == reference(world.operator.id, "fault-key-000000000001")
    assert written() == COMMITTED


# ------------------------------------------------------------------------- hold ----


def test_a_held_intake_answers_a_contender_in_flight_with_the_same_operation_reference(
    world, armed
):
    barrier = Barrier()
    armed("intake:hold-before-commit", hold=barrier)
    result = {}

    def submit():
        try:
            result["winner"] = world.post()
        finally:
            connection.close()

    winner = threading.Thread(target=submit, name="held-intake")
    winner.start()
    try:
        assert barrier.reached.wait(10), "the intake never reached its pre-commit hold"
        contender = world.post()
        assert contender.status_code == 409, contender.content
        assert contender.json()["type"] == PROBLEMS + "idempotency-key-in-flight"
        assert written() == NOTHING, "the held intake was visible before its commit"
    finally:
        barrier.released.set()
        winner.join(20)
    assert not winner.is_alive()
    committed = result["winner"]
    assert committed.status_code == 201, committed.content
    expected = reference(world.operator.id, "fault-key-000000000001")
    assert contender.headers[OPERATION_REF] == committed.headers[OPERATION_REF] == expected
    assert expected == Job.objects.get().idempotency_key
    assert faults.disarm("intake:hold-before-commit") == 1
    assert written() == COMMITTED


# ------------------------------------------------------------------ after commit ----


@pytest.mark.parametrize("point", AFTER_COMMIT)
def test_a_crash_after_the_commit_leaves_exactly_one_queued_job_with_its_steps(world, armed, point):
    armed(point)
    with pytest.raises(faults.SimulatedCrash) as crash:
        world.post()
    assert crash.value.point == point
    assert faults.disarm(point) == 1
    assert written() == COMMITTED, f"a crash at {point} lost or doubled what had committed"
    job = Job.objects.get()
    assert (job.kind, job.status) == ("realm_create", "queued")
    assert JobStep.objects.filter(job_id=job.id, status="pending").count() == 7

    replayed = world.post()
    assert replayed.status_code == 201
    assert replayed.headers["Idempotency-Replayed"] == "true"
    assert replayed.headers[OPERATION_REF] == job.idempotency_key
    assert written() == COMMITTED


# ------------------------------------------------------------------ close dispatch ----


def _open_realm_dispatch(world):
    created = world.post()
    assert created.status_code == 201, created.content
    job = Job.objects.get(kind="realm_create")
    claim = services.claim_job(runner_id="fault-points", job_id=job.id)
    assert isinstance(claim, services.Claim), claim
    assert services.record_step(claim=claim, seq=1, status="running")
    dispatch = services.record_dispatch(claim=claim, seq=1, operation_ref="synthetic-realm-op")
    assert dispatch is not None
    return claim, dispatch


def test_a_crash_before_acknowledging_a_realm_success_leaves_the_dispatch_open(world, armed):
    claim, dispatch = _open_realm_dispatch(world)
    armed(REALM_ACKNOWLEDGEMENT)
    with pytest.raises(faults.SimulatedCrash) as crash:
        services.close_dispatch(
            claim=claim, dispatch_id=dispatch, outcome="completed", evidence_ref="synthetic-proof"
        )
    assert crash.value.point == REALM_ACKNOWLEDGEMENT
    assert faults.disarm(REALM_ACKNOWLEDGEMENT) == 1
    row = JobDispatch.objects.get(pk=dispatch)
    assert (row.closed_at, row.terminal_outcome, row.terminal_evidence_ref) == (None, None, None), (
        "the acknowledgement the crash interrupted was recorded anyway"
    )

    assert services.close_dispatch(
        claim=claim, dispatch_id=dispatch, outcome="completed", evidence_ref="synthetic-proof"
    )
    assert JobDispatch.objects.get(pk=dispatch).terminal_outcome == "completed"


def test_the_acknowledgement_point_is_not_reached_by_a_failure(world, armed):
    claim, dispatch = _open_realm_dispatch(world)
    armed(REALM_ACKNOWLEDGEMENT)
    assert services.close_dispatch(
        claim=claim, dispatch_id=dispatch, outcome="failed", evidence_ref="synthetic-proof"
    )
    assert faults.disarm(REALM_ACKNOWLEDGEMENT) == 0, (
        "a provider failure reached the success-acknowledgement point"
    )


# --------------------------------------------------------------------- refusals ----


def test_reach_is_inert_when_nothing_is_armed():
    for site in faults.SITES:
        assert faults.reach(site) is None


def test_arming_is_refused_unless_the_test_profile_permits_it(settings, monkeypatch):
    settings.FAULT_POINTS_PERMITTED = False
    with pytest.raises(faults.FaultPointsRefused, match="fault points are refused"):
        faults.arm("intake:after-job")
    settings.FAULT_POINTS_PERMITTED = True
    monkeypatch.setenv("DJANGO_SETTINGS_MODULE", "config.settings.deploy")
    with pytest.raises(faults.FaultPointsRefused, match="fault points are refused"):
        faults.arm("intake:after-job")
    monkeypatch.setenv("DJANGO_SETTINGS_MODULE", "config.settings.test")
    settings.SETTINGS_MODULE = "config.settings.customer_http"
    with pytest.raises(faults.FaultPointsRefused, match="fault points are refused"):
        faults.arm("intake:after-job")
    assert not faults.armed_points(), "a refused arm left a point armed"


def test_arming_refuses_an_unknown_point_a_hold_without_a_barrier_and_a_second_arm(armed):
    with pytest.raises(faults.FaultPointsRefused, match="not a Core fault point"):
        armed("intake:somewhere")
    with pytest.raises(faults.FaultPointsRefused, match="needs a barrier"):
        armed("intake:hold-before-commit")
    with pytest.raises(faults.FaultPointsRefused, match="takes no barrier"):
        armed("intake:after-job", hold=Barrier())
    armed("intake:after-commit")
    with pytest.raises(faults.FaultPointsRefused, match="already armed"):
        armed("intake:after-commit-before-dispatch")


def test_a_crash_passes_an_except_exception():
    """The property the view's `except Exception` and the harness depend on."""
    assert issubclass(faults.SimulatedCrash, BaseException)
    assert not issubclass(faults.SimulatedCrash, Exception)
