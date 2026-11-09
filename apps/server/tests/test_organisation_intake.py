"""The staff intake, `POST /api/v1/organisations`: docs/specs/ORGANISATION_INTAKE.md §5.

Driven through the real URL resolver, the production token verifier and the replay store, against
the test database. Each refusal is checked for its status and problem type, and for what it did not
write: no organisation, reservation, job, intake or replay entry it should not have.
"""

import json
import threading
import time
import uuid
from dataclasses import FrozenInstanceError
from datetime import timedelta
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.identity.models import Identity, StaffRole, User
from apps.jobs.keys import derive_key
from apps.jobs.models import Job, JobStep
from apps.orgs import intake_services
from apps.orgs.models import (
    RESERVED_ORGANISATION_SLUGS,
    Membership,
    Organisation,
    OrganisationIntake,
    SlugReservation,
)
from config.environment import intake_admitted
from core import sealing
from core.idempotency import store as idempotency_store
from core.idempotency.models import IdempotencyRecord
from services.identity.trusted_issuers import load_trust

PATH = "/api/v1/organisations"
PROBLEMS = "https://kodera.io/problems/"
# config.settings.test's fixed KODERA_STAFF_ISSUER; organisation issuers share its origin.
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
CUSTOMER_ISSUER = "https://identity.staff.test/realms/alpha-org"
KID = "intake-test-key"
OWNER_EMAIL = "julie.marchand@acme.test"
OPERATION_REF = "X-Operation-Ref"


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def body(slug="acme-sa", **changes):
    document = {
        "slug": slug,
        "name": "ACME",
        "legal_name": "ACME SAS",
        "country": "FR",
        "vat_number": None,
        "billing_email": "compta@acme.test",
        "email_domains": ["acme.test"],
        "locale": "fr",
        "instruction_ref": "SUP-0418",
        "intended_owner": {"email": OWNER_EMAIL, "display_name": "Julie Marchand"},
    }
    document.update(changes)
    return document


@pytest.fixture
def world(transactional_db, settings, signing_key):
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key()))
    public.update(kid=KID, alg="RS256", use="sig", key_ops=["verify"])
    expires = int(time.time()) + 3600
    settings.KODERA_AUTH_TRUST = load_trust(
        json.dumps(
            [
                {
                    "lane": lane,
                    "issuer": issuer,
                    "generation": "intake-test",
                    "expires_at": expires,
                    "public_jwks": {"keys": [public]},
                }
                for lane, issuer in (("staff", STAFF_ISSUER), ("customer", CUSTOMER_ISSUER))
            ]
        )
    )

    def staff_identity(subject, *, roles=("staff_operator",)):
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

    def token(subject="operator-one", *, issuer=STAFF_ISSUER, amr=("pwd", "otp"), **claims):
        now = int(time.time())
        payload = {
            "iss": issuer,
            "sub": subject,
            "aud": "kodera-server",
            "iat": now,
            "exp": now + 300,
            "typ": "Bearer",
            # The web console's client: the customer lane admits only its allowed clients.
            "azp": "console",
            **claims,
        }
        if amr is not None:
            payload["amr"] = list(amr)
        return jwt.encode(payload, signing_key, algorithm="RS256", headers={"kid": KID})

    def post(document=None, *, key="intake-key-0000000001", credential=None, raw=None):
        headers = {}
        if credential is not False:
            headers["HTTP_AUTHORIZATION"] = "Bearer " + (credential or token())
        if key is not None:
            headers["HTTP_IDEMPOTENCY_KEY"] = key
        data = raw if raw is not None else json.dumps(document or body()).encode()
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        return client.post(PATH, data=data, content_type="application/json", **headers)

    operator = staff_identity("operator-one")
    return SimpleNamespace(staff_identity=staff_identity, token=token, post=post, operator=operator)


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert response.headers["Content-Type"].split(";")[0] == "application/problem+json"
    assert response.headers["Cache-Control"] == "no-store"
    document = response.json()
    assert document["type"] == PROBLEMS + kind and document["status"] == status
    assert document["request_id"] == response.headers["X-Request-Id"]
    assert OWNER_EMAIL not in response.content.decode()
    if kind != "idempotency-key-in-flight":
        assert OPERATION_REF not in response.headers
    return document


def written():
    return {
        "organisations": Organisation.objects.count(),
        "reservations": SlugReservation.objects.count(),
        "jobs": Job.objects.count(),
        "intakes": OrganisationIntake.objects.count(),
        "memberships": Membership.objects.count(),
    }


NOTHING = {"organisations": 0, "reservations": 0, "jobs": 0, "intakes": 0, "memberships": 0}
ONE_INTAKE = {"organisations": 1, "reservations": 1, "jobs": 1, "intakes": 1, "memberships": 0}


def expected_reference(identity_id, key, *, path=PATH):
    return derive_key([f"urn:kodera:identity:{identity_id}", "POST", path, "realm_create", key, 0])


# ------------------------------------------------------------------------------ recorded ----


def test_one_transaction_records_the_prospect_its_reservation_job_audit_and_intake(world):
    response = world.post()
    assert response.status_code == 201, response.content
    result = response.json()
    organisation = Organisation.objects.get()
    assert response.headers["Location"] == f"/api/v1/organisations/{organisation.id}"
    assert "Idempotency-Replayed" not in response.headers
    assert result["organisation"] | {"created_at": None, "updated_at": None} == {
        "id": str(organisation.id),
        "slug": "acme-sa",
        "name": "ACME",
        "state": "prospect",
        "realm": None,
        "created_at": None,
        "updated_at": None,
    }
    assert (organisation.state, organisation.realm) == ("prospect", "acme-sa")
    assert organisation.issuer == "https://identity.staff.test/realms/acme-sa"
    reservation = SlugReservation.objects.get()
    assert (reservation.organisation_id, reservation.slug, reservation.state) == (
        organisation.id,
        "acme-sa",
        "provisional",
    )
    job = Job.objects.get()
    expected = expected_reference(world.operator.id, "intake-key-0000000001")
    assert response.headers[OPERATION_REF] == job.idempotency_key == expected
    assert (job.organisation_id, job.kind, job.status, job.tenant_id) == (
        organisation.id,
        "realm_create",
        "queued",
        None,
    )
    assert (job.actor_type, job.actor_id) == ("staff", world.operator.id)
    assert JobStep.objects.filter(job_id=job.id).count() == 7
    bootstrap = result["bootstrap"]
    assert bootstrap["organisation_id"] == str(organisation.id)
    assert bootstrap["organisation_state"] == "prospect"
    assert bootstrap["intake"]["instruction_ref"] == "SUP-0418"
    assert bootstrap["intake"]["intended_owner_email_masked"] == "j***d@acme.test"
    assert bootstrap["realm"] == {"state": "pending", "name": None, "job_id": str(job.id)}
    assert bootstrap["identity_mapping"] == {
        "state": "pending",
        "identity_id": None,
        "bound_at": None,
    }
    assert bootstrap["claim"]["state"] == "not_issued"
    intake = OrganisationIntake.objects.get()
    assert (intake.organisation_id, intake.recorded_by_identity_id, intake.bootstrap_job_id) == (
        organisation.id,
        world.operator.id,
        job.id,
    )
    assert written() == ONE_INTAKE
    assert Identity.objects.filter(organisation_id=organisation.id).count() == 0
    actions = list(
        AuditEvent.objects.filter(organisation_id=organisation.id)
        .order_by("id")
        .values_list("action", "actor_type", "actor_id")
    )
    assert actions == [
        ("organisation.intake_recorded", "staff", world.operator.id),
        ("job.created", "staff", world.operator.id),
    ]
    recorded = AuditEvent.objects.get(action="organisation.intake_recorded")
    assert recorded.metadata == {"instruction_ref": "SUP-0418"}
    assert recorded.target_urn == "urn:kodera:organisation:acme-sa"


def test_the_intended_owner_contact_is_sealed_and_stored_nowhere_in_clear(world, settings):
    assert world.post().status_code == 201
    intake = OrganisationIntake.objects.get()
    sealed = bytes(intake.sealed_contact)
    assert OWNER_EMAIL.encode() not in sealed and b"Marchand" not in sealed
    opened = json.loads(
        sealing.unseal(
            settings.KODERA_CONTACT_SEAL_KEY,
            intake_services.SEAL_CONTEXT + intake.id.bytes,
            sealed,
        )
    )
    assert opened["intended_owner"] == {"email": OWNER_EMAIL, "display_name": "Julie Marchand"}
    assert opened["profile"]["billing_email"] == "compta@acme.test"
    with pytest.raises(sealing.SealError):
        sealing.unseal(
            settings.KODERA_CONTACT_SEAL_KEY,
            intake_services.SEAL_CONTEXT + uuid.uuid4().bytes,
            sealed,
        )
    for row in AuditEvent.objects.values("metadata", "target_urn", "actor_label"):
        assert OWNER_EMAIL not in json.dumps(row, default=str)
    stored = IdempotencyRecord.objects.get()
    assert OWNER_EMAIL.encode() not in bytes(stored.body)


def test_a_repeated_intake_replays_the_same_organisation_and_enqueues_nothing(world):
    first = world.post()
    second = world.post()
    assert (first.status_code, second.status_code) == (201, 201)
    assert second.content == first.content
    assert second.headers["Idempotency-Replayed"] == "true"
    assert second.headers[OPERATION_REF] == first.headers[OPERATION_REF]
    assert second.headers[OPERATION_REF] == Job.objects.get().idempotency_key
    assert written() == ONE_INTAKE


def test_after_the_replay_entry_expires_the_intention_still_names_one_organisation(world):
    first = world.post()
    IdempotencyRecord.objects.update(created_at=timezone.now() - timedelta(hours=25))
    again = world.post()
    assert again.status_code == 201 and "Idempotency-Replayed" not in again.headers
    assert again.json()["organisation"]["id"] == first.json()["organisation"]["id"]
    assert again.json()["bootstrap"]["realm"] == first.json()["bootstrap"]["realm"]
    assert again.headers[OPERATION_REF] == first.headers[OPERATION_REF]
    assert written() == ONE_INTAKE
    IdempotencyRecord.objects.update(created_at=timezone.now() - timedelta(hours=25))
    reused = world.post(body(slug="other-org"))
    problem(reused, 409, "idempotency-key-reuse")
    assert OPERATION_REF not in reused.headers
    assert written() == ONE_INTAKE


def test_a_slug_already_held_is_409_and_writes_nothing(world):
    assert world.post().status_code == 201
    taken = world.post(body(name="Another"), key="intake-key-0000000002")
    problem(taken, 409, "slug-taken")
    assert OPERATION_REF not in taken.headers
    assert written() == ONE_INTAKE
    assert AuditEvent.objects.filter(action="organisation.intake_recorded").count() == 1


def test_a_held_winner_in_flight_commit_replay_and_durable_retry_share_one_reference(
    world, monkeypatch
):
    key = "held-operation-" + ("a" * 16)
    reached, release = threading.Event(), threading.Event()
    real = intake_services.enqueue_job
    result = {}

    def paused(**arguments):
        enqueued = real(**arguments)
        reached.set()
        assert release.wait(10)
        return enqueued

    monkeypatch.setattr(intake_services, "enqueue_job", paused)

    def submit():
        try:
            result["winner"] = world.post(key=key, credential=world.token())
        finally:
            connection.close()

    winner = threading.Thread(target=submit, name="operation-reference-winner")
    winner.start()
    assert reached.wait(10), "the winning intake never reached its pre-commit hold"
    prospective = expected_reference(world.operator.id, key)
    try:
        contender = world.post(key=key, credential=world.token())
        problem(contender, 409, "idempotency-key-in-flight")
        assert contender.headers[OPERATION_REF] == prospective
    finally:
        release.set()
        winner.join(20)
    assert not winner.is_alive()
    committed = result["winner"]
    assert committed.status_code == 201
    assert committed.headers[OPERATION_REF] == prospective
    delayed = world.post(key=key)
    assert delayed.status_code == 201 and delayed.headers["Idempotency-Replayed"] == "true"
    assert delayed.headers[OPERATION_REF] == prospective
    IdempotencyRecord.objects.update(created_at=timezone.now() - timedelta(hours=25))
    durable = world.post(key=key)
    assert durable.status_code == 201 and "Idempotency-Replayed" not in durable.headers
    assert durable.headers[OPERATION_REF] == prospective == Job.objects.get().idempotency_key
    assert written() == ONE_INTAKE
    job = Job.objects.get()
    assert list(
        JobStep.objects.filter(job_id=job.id).order_by("seq").values_list("seq", "name", "status")
    ) == [
        (1, "create_realm", "pending"),
        (2, "create_clients", "pending"),
        (3, "create_service_account", "pending"),
        (4, "configure_idp", "pending"),
        (5, "configure_smtp", "pending"),
        (6, "apply_theme", "pending"),
        (7, "verify", "pending"),
    ]
    request_id = committed.headers["X-Request-Id"]
    assert list(
        AuditEvent.objects.filter(organisation_id=job.organisation_id)
        .order_by("id")
        .values_list(
            "action",
            "actor_type",
            "actor_id",
            "actor_label",
            "organisation_id",
            "target_urn",
            "before",
            "after",
            "request_id",
            "job_id",
            "source_ip_trunc",
            "retention_class",
            "metadata",
        )
    ) == [
        (
            "organisation.intake_recorded",
            "staff",
            world.operator.id,
            f"urn:kodera:identity:{world.operator.id}",
            job.organisation_id,
            "urn:kodera:organisation:acme-sa",
            None,
            None,
            request_id,
            None,
            None,
            "standard",
            {"instruction_ref": "SUP-0418"},
        ),
        (
            "job.created",
            "staff",
            world.operator.id,
            f"urn:kodera:identity:{world.operator.id}",
            job.organisation_id,
            f"urn:kodera:job:{job.id}",
            None,
            None,
            request_id,
            job.id,
            None,
            "standard",
            {"kind": "realm_create"},
        ),
    ]
    assert IdempotencyRecord.objects.count() == 1


def test_in_flight_body_precedence_and_executed_refusals_are_headerless(world, monkeypatch):
    key = "body-precedence-key-001"
    reached, release = threading.Event(), threading.Event()
    real = intake_services.enqueue_job
    result = {}

    def paused(**arguments):
        enqueued = real(**arguments)
        reached.set()
        assert release.wait(10)
        return enqueued

    monkeypatch.setattr(intake_services, "enqueue_job", paused)

    def submit():
        try:
            result["winner"] = world.post(key=key, credential=world.token())
        finally:
            connection.close()

    winner = threading.Thread(target=submit, name="body-precedence-winner")
    winner.start()
    assert reached.wait(10)
    prospective = expected_reference(world.operator.id, key)
    try:
        contenders = (
            world.post(key=key, raw=b"{"),
            world.post(body(name=""), key=key),
            world.post(body(slug="other-org"), key=key),
        )
        for contender in contenders:
            problem(contender, 409, "idempotency-key-in-flight")
            assert contender.headers[OPERATION_REF] == prospective
    finally:
        release.set()
        winner.join(20)
    assert result["winner"].status_code == 201
    reuse = world.post(body(slug="other-org"), key=key)
    problem(reuse, 409, "idempotency-key-reuse")
    assert OPERATION_REF not in reuse.headers

    for refusal_key, arguments, status, kind in (
        ("malformed-body-key-01", {"raw": b"{"}, 400, "malformed-request"),
        ("invalid-body-key-0001", {"document": body(name="")}, 422, "validation-error"),
    ):
        first = world.post(key=refusal_key, **arguments)
        replay = world.post(key=refusal_key, **arguments)
        problem(first, status, kind)
        assert replay.status_code == status
        assert replay.json()["type"] == PROBLEMS + kind
        assert OPERATION_REF not in first.headers and OPERATION_REF not in replay.headers
        assert replay.headers["Idempotency-Replayed"] == "true"


def test_a_rolled_back_winner_leaves_no_reference_state_and_retry_is_stable(world, monkeypatch):
    key = "rollback-operation-key-01"
    real = intake_services.enqueue_job

    def rollback_after_enqueue(**arguments):
        real(**arguments)
        raise RuntimeError("synthetic rollback after enqueue")

    monkeypatch.setattr(intake_services, "enqueue_job", rollback_after_enqueue)
    failed = world.post(key=key)
    problem(failed, 500, "internal-error")
    assert OPERATION_REF not in failed.headers
    assert written() == NOTHING and not AuditEvent.objects.exists()
    assert not IdempotencyRecord.objects.exists()
    monkeypatch.setattr(intake_services, "enqueue_job", real)
    retried = world.post(key=key)
    expected = expected_reference(world.operator.id, key)
    assert retried.status_code == 201
    assert retried.headers[OPERATION_REF] == expected == Job.objects.get().idempotency_key


def test_same_client_key_is_private_to_each_staff_identity(world):
    key = "shared-staff-key-00001"
    second = world.staff_identity("operator-two")
    first_response = world.post(body(slug="first-org"), key=key)
    second_response = world.post(
        body(slug="second-org"), key=key, credential=world.token(subject="operator-two")
    )
    assert (first_response.status_code, second_response.status_code) == (201, 201)
    first_ref = first_response.headers[OPERATION_REF]
    second_ref = second_response.headers[OPERATION_REF]
    assert first_ref == expected_reference(world.operator.id, key)
    assert second_ref == expected_reference(second.id, key)
    assert first_ref != second_ref
    assert second_ref not in first_response.content.decode()
    assert first_ref not in second_response.content.decode()
    assert all(second_ref not in str(value) for value in first_response.headers.values())
    assert all(first_ref not in str(value) for value in second_response.headers.values())
    assert set(Job.objects.values_list("idempotency_key", flat=True)) == {first_ref, second_ref}


def test_forced_advisory_collision_returns_the_contenders_own_reference(world, monkeypatch):
    first_key = "forced-collision-key-01"
    second_key = "forced-collision-key-02"
    reached, release = threading.Event(), threading.Event()
    real = intake_services.enqueue_job
    result = {}
    monkeypatch.setattr(idempotency_store, "lock_key", lambda scope: 424242)

    def paused(**arguments):
        enqueued = real(**arguments)
        reached.set()
        assert release.wait(10)
        return enqueued

    monkeypatch.setattr(intake_services, "enqueue_job", paused)

    def submit():
        try:
            result["holder"] = world.post(key=first_key, credential=world.token())
        finally:
            connection.close()

    holder = threading.Thread(target=submit, name="forced-collision-holder")
    holder.start()
    assert reached.wait(10)
    try:
        contender = world.post(
            body(slug="collision-other"), key=second_key, credential=world.token()
        )
        problem(contender, 409, "idempotency-key-in-flight")
        assert contender.headers[OPERATION_REF] == expected_reference(world.operator.id, second_key)
        assert contender.headers[OPERATION_REF] != expected_reference(world.operator.id, first_key)
    finally:
        release.set()
        holder.join(20)
    assert result["holder"].status_code == 201


def test_reference_is_never_disclosed_before_current_authentication_or_authorisation(world):
    for response in (
        world.post(credential=False),
        world.post(credential=world.token(issuer=CUSTOMER_ISSUER)),
        world.post(credential=world.token(amr=("pwd",))),
    ):
        assert response.status_code in {401, 403}
        assert OPERATION_REF not in response.headers


@pytest.mark.parametrize("supplied", ["", "a" * 64])
def test_record_intake_refuses_a_non_nominal_supplied_reference(world, supplied):
    from apps.orgs.api.intake_serializers import validate

    request = validate(body())
    assert isinstance(request, intake_services.IntakeRequest)
    with pytest.raises(TypeError, match="intake operation reference"):
        intake_services.record_intake(
            actor=intake_services.IntakeActor(world.operator.id),
            request=request,
            request_id="noncanonical-reference-test",
            path=PATH,
            idempotency_key="noncanonical-key-00001",
            operation_ref=supplied,
        )
    assert written() == NOTHING


def test_the_reference_value_object_is_immutable_and_has_no_caller_supplied_digest(world):
    reference = intake_services.intake_operation_reference(
        actor=intake_services.IntakeActor(world.operator.id),
        path=PATH,
        idempotency_key="immutable-reference-key-01",
    )
    assert reference.value == expected_reference(world.operator.id, "immutable-reference-key-01")
    assert not hasattr(intake_services, "_OPERATION_REFERENCE_FACTORY")
    with pytest.raises(FrozenInstanceError):
        reference.path = "/a/different/path"
    with pytest.raises(FrozenInstanceError):
        reference.value = "a" * 64
    with pytest.raises(TypeError):
        intake_services.IntakeOperationReference(
            identity_id=world.operator.id,
            path=PATH,
            idempotency_key="forged-reference-key-01",
            value="a" * 64,
        )


def test_record_intake_refuses_a_nominal_reference_for_another_intention(world):
    from apps.orgs.api.intake_serializers import validate

    actor = intake_services.IntakeActor(world.operator.id)
    supplied = intake_services.intake_operation_reference(
        actor=actor, path=PATH, idempotency_key="different-intention-key"
    )
    with pytest.raises(ValueError, match="not canonical"):
        intake_services.record_intake(
            actor=actor,
            request=validate(body()),
            request_id="mismatched-reference-test",
            path=PATH,
            idempotency_key="intended-key-00000001",
            operation_ref=supplied,
        )
    assert written() == NOTHING


def test_record_intake_refuses_a_reference_subclass(world):
    from apps.orgs.api.intake_serializers import validate

    class ReferenceSubclass(intake_services.IntakeOperationReference):
        pass

    supplied = ReferenceSubclass(
        identity_id=world.operator.id,
        path=PATH,
        idempotency_key="subclass-reference-key-01",
    )
    with pytest.raises(TypeError, match="intake operation reference"):
        intake_services.record_intake(
            actor=intake_services.IntakeActor(world.operator.id),
            request=validate(body()),
            request_id="subclass-reference-test",
            path=PATH,
            idempotency_key="subclass-reference-key-01",
            operation_ref=supplied,
        )
    assert written() == NOTHING


def test_the_http_route_derives_the_operation_reference_exactly_once(world, monkeypatch):
    calls = []
    real = intake_services.derive_key

    def counted(parts):
        calls.append(tuple(parts))
        return real(parts)

    monkeypatch.setattr(intake_services, "derive_key", counted)
    response = world.post(key="single-derivation-key-01")
    assert response.status_code == 201
    assert calls == [
        (
            f"urn:kodera:identity:{world.operator.id}",
            "POST",
            PATH,
            "realm_create",
            "single-derivation-key-01",
            0,
        )
    ]
    assert response.headers[OPERATION_REF] == Job.objects.get().idempotency_key


def test_reference_derivation_is_stable_complete_and_not_the_raw_client_key(world):
    actor = intake_services.IntakeActor(world.operator.id)
    key = "derivation-" + ("b" * 16)
    actual = intake_services.intake_operation_reference(actor=actor, path=PATH, idempotency_key=key)
    parts = [f"urn:kodera:identity:{world.operator.id}", "POST", PATH, "realm_create", key, 0]
    assert actual.value == derive_key(parts)
    assert actual == intake_services.intake_operation_reference(
        actor=actor, path=PATH, idempotency_key=key
    )
    assert actual.value != key
    for index in range(5):
        weakened = parts[:index] + parts[index + 1 :]
        assert derive_key(weakened) != actual.value
    assert derive_key([*parts[:-1], 1]) != actual.value


@pytest.mark.parametrize(
    "key",
    ["a" * 15, "a" * 256, "visible-key-0001" + "\x7f"],
    ids=["too-short", "too-long", "non-visible"],
)
def test_malformed_idempotency_keys_are_headerless_through_the_real_route(world, key):
    response = world.post(key=key)
    problem(response, 400, "malformed-request")
    assert OPERATION_REF not in response.headers
    assert written() == NOTHING


def test_operation_reference_does_not_widen_the_replay_record():
    concrete = {field.name for field in IdempotencyRecord._meta.get_fields()}
    assert "operation_ref" not in concrete and "operation_reference" not in concrete


def _wait_for_a_lock_wait(timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM pg_locks WHERE NOT granted")
            if cursor.fetchone()[0]:
                return
        time.sleep(0.02)
    raise AssertionError("the second intake never waited on the first one's slug")


@pytest.mark.parametrize("constraint_handled", [True, False], ids=["real", "mutant"])
def test_two_connections_racing_for_one_slug_commit_one_intake(
    world, monkeypatch, constraint_handled
):
    """The first intake holds its transaction open after reserving the slug; the second, on its
    own connection, waits on the unique index, and is refused when the first commits. With the
    slug constraints not recognised, the same race answers 500: the 409 rests on the constraint."""
    if not constraint_handled:
        monkeypatch.setattr(intake_services, "SLUG_TAKEN_CONSTRAINTS", frozenset())
    real = intake_services.enqueue_job
    reached, release = threading.Event(), threading.Event()

    def paused(**arguments):
        if threading.current_thread().name == "first":
            reached.set()
            assert release.wait(10)
        return real(**arguments)

    monkeypatch.setattr(intake_services, "enqueue_job", paused)
    tokens = {"first": world.token(), "second": world.token()}
    results = {}

    def submit(name, key):
        try:
            results[name] = world.post(key=key, credential=tokens[name])
        finally:
            connection.close()

    first = threading.Thread(target=submit, args=("first", "race-key-000000000001"), name="first")
    first.start()
    assert reached.wait(10), "the first intake never reached its job"
    second = threading.Thread(
        target=submit, args=("second", "race-key-000000000002"), name="second"
    )
    second.start()
    try:
        _wait_for_a_lock_wait()
    finally:
        release.set()
        first.join(20)
        second.join(20)
    assert results["first"].status_code == 201
    if constraint_handled:
        problem(results["second"], 409, "slug-taken")
    else:
        problem(results["second"], 500, "internal-error")
    assert written() == ONE_INTAKE
    assert AuditEvent.objects.filter(action="organisation.intake_recorded").count() == 1


# --------------------------------------------------------------------------- validation ----


@pytest.mark.parametrize(
    ("slug", "code"),
    [
        ("synth-apps-01", "reserved"),
        ("synth-" + "a" * 14, "reserved"),
        ("synth-", "pattern"),
        ("SYNTH-apps-01", "pattern"),
        ("synth-apps-01\n", "pattern"),
        ("synth-" + "a" * 15, "max_length"),
        ("master", "reserved"),
        ("kodera-staff", "reserved"),
        ("kodera-probe", "reserved"),
        ("kodera-dev", "reserved"),
        ("kodera", "reserved"),
        ("staff", "reserved"),
        ("admin", "reserved"),
        ("notify", "reserved"),
        ("staging", "reserved"),
        ("status", "reserved"),
        ("support", "reserved"),
        ("billing", "reserved"),
        ("console", "reserved"),
        ("developers", "reserved"),
        ("matrix", "reserved"),
        ("auth-admin", "reserved"),
        ("auth-mail", "reserved"),
        ("errors", "reserved"),
        ("ops-admin", "reserved"),
        ("abcd", "pattern"),
        ("a" * 21, "max_length"),
        ("Acme-sa", "pattern"),
        ("-acme-sa", "pattern"),
        ("acme-sa-", "pattern"),
        ("acmé-sa", "pattern"),
        ("acme-sa\n", "pattern"),
        (12345, "type"),
    ],
)
def test_an_invalid_or_reserved_slug_is_422_before_any_write(world, slug, code):
    refused = problem(world.post(body(slug=slug)), 422, "validation-error")
    assert refused["errors"] == [{"pointer": "/slug", "code": code}]
    assert written() == NOTHING
    assert not AuditEvent.objects.filter(action="organisation.intake_recorded").exists()


@pytest.mark.parametrize(
    ("extra", "pointer"),
    [
        ({"dpa_acceptance": {"accepted": True}}, "/dpa_acceptance"),
        ({"terms_acceptance": {"accepted": True}}, "/terms_acceptance"),
        ({"membership": {"role": "org_owner"}}, "/membership"),
        ({"role": "org_owner"}, "/role"),
        ({"order": {}}, "/order"),
    ],
)
def test_a_body_naming_a_membership_role_dpa_or_order_is_422(world, extra, pointer):
    refused = problem(world.post(body(**extra)), 422, "validation-error")
    assert {"pointer": pointer, "code": "unexpected"} in refused["errors"]
    assert written() == NOTHING


def test_each_required_and_nested_member_is_validated(world):
    document = body(intended_owner={"email": "not-an-address", "admin": True}, name="")
    del document["instruction_ref"]
    refused = problem(world.post(document), 422, "validation-error")
    assert sorted((e["pointer"], e["code"]) for e in refused["errors"]) == [
        ("/instruction_ref", "required"),
        ("/intended_owner/admin", "unexpected"),
        ("/intended_owner/email", "format"),
        ("/name", "min_length"),
    ]
    assert written() == NOTHING


def test_a_refusal_is_stored_and_replayed_under_its_key(world):
    first = world.post(body(slug="kodera-staff"))
    again = world.post(body(slug="kodera-staff"))
    assert (first.status_code, again.status_code) == (422, 422)
    assert again.content == first.content and again.headers["Idempotency-Replayed"] == "true"


def test_a_body_that_is_not_json_is_400(world):
    problem(world.post(raw=b'{"slug": '), 400, "malformed-request")
    problem(world.post(raw=b'{"a":1,"a":2}', key="intake-key-0000000003"), 400, "malformed-request")
    assert written() == NOTHING


def test_a_missing_idempotency_key_is_400(world):
    problem(world.post(key=None), 400, "idempotency-key-missing")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


# ------------------------------------------------------------------------- who may ask ----


def test_no_token_or_a_bad_one_is_401(world):
    problem(world.post(credential=False), 401, "unauthenticated")
    problem(world.post(credential="not.a.token"), 401, "unauthenticated")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_a_customer_token_naming_staff_operator_is_403(world):
    credential = world.token(
        "customer-person",
        issuer=CUSTOMER_ISSUER,
        realm_access={"roles": ["staff_operator"]},
        roles=["staff_operator"],
    )
    problem(world.post(credential=credential), 403, "forbidden")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_a_staff_token_without_a_second_factor_is_403_mfa_required_and_audited(world):
    for amr in (None, ("pwd",), ("OTP",)):
        refused = problem(world.post(credential=world.token(amr=amr)), 403, "mfa-required")
        assert refused["required_amr"] == ["hwk", "mfa", "otp"]
    denials = AuditEvent.objects.filter(action="authz.denied")
    assert denials.count() == 3
    assert set(denials.values_list("actor_id", "organisation_id")) == {(world.operator.id, None)}
    assert {row["reason"] for row in denials.values_list("metadata", flat=True)} == {"mfa_missing"}
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_a_staff_identity_without_a_current_operator_grant_is_403_and_audited(world):
    world.staff_identity("support-one", roles=("staff_support",))
    problem(world.post(credential=world.token("support-one")), 403, "forbidden")
    StaffRole.objects.filter(identity=world.operator).update(revoked_at=timezone.now())
    problem(world.post(credential=world.token()), 403, "forbidden")
    denials = AuditEvent.objects.filter(action="authz.denied")
    assert sorted(row["reason"] for row in denials.values_list("metadata", flat=True)) == [
        "role_missing",
        "role_missing",
    ]
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_an_unknown_or_disabled_staff_identity_is_401(world):
    problem(world.post(credential=world.token("never-stored")), 401, "unauthenticated")
    Identity.objects.filter(pk=world.operator.pk).update(enabled=False)
    problem(world.post(credential=world.token()), 401, "unauthenticated")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_a_revoked_grant_is_refused_before_the_replay_store_serves_the_first_answer(world):
    """Authorisation precedes the replay store: a key whose 201 is stored is not replayed to a
    caller who lost the grant since (IDEMPOTENCY_REPLAY.md §2.3)."""
    assert world.post().status_code == 201
    StaffRole.objects.filter(identity=world.operator).update(revoked_at=timezone.now())
    refused = world.post()
    problem(refused, 403, "forbidden")
    assert "Idempotency-Replayed" not in refused.headers
    assert written() == ONE_INTAKE


@pytest.mark.parametrize(
    "instruction_ref", ["julie@acme.test", "Julie Marchand", "sup-0418", "SUP-0418 call Julie"]
)
def test_an_instruction_reference_that_is_not_a_ticket_is_422(world, instruction_ref):
    refused = problem(world.post(body(instruction_ref=instruction_ref)), 422, "validation-error")
    assert refused["errors"] == [{"pointer": "/instruction_ref", "code": "pattern"}]
    assert written() == NOTHING


@pytest.mark.parametrize("slug", RESERVED_ORGANISATION_SLUGS)
def test_the_database_refuses_each_reserved_slug_itself(world, slug):
    with pytest.raises(IntegrityError) as refusal, transaction.atomic():
        Organisation.objects.create(
            slug=slug, realm=slug, issuer=f"https://identity.staff.test/realms/{slug}", name="X"
        )
    expected = (
        "organisation_realm_not_staff"
        if slug == "kodera-staff"
        else "organisation_slug_not_reserved"
    )
    assert refusal.value.__cause__.diag.constraint_name == expected


def test_a_failed_intake_record_rolls_back_the_organisation_its_job_and_its_audit(
    world, monkeypatch
):
    """The intake row is the last write of the transaction; its refusal by the database undoes the
    organisation, the reservation, the job, `organisation.intake_recorded` and `job.created`."""
    monkeypatch.setattr(intake_services, "mask_email", lambda email: "")
    problem(world.post(), 500, "internal-error")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0
    assert AuditEvent.objects.count() == 0, "an audit row outlived its rolled-back intake"


def test_an_unset_staff_issuer_resolves_no_staff_principal_and_closes_the_gate(world, settings):
    settings.KODERA_STAFF_ISSUER = None
    assert intake_services.intake_available() is False
    problem(world.post(), 401, "unauthenticated")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0


def test_a_grant_revoked_before_the_effect_is_403_and_stores_nothing(world, monkeypatch):
    real = intake_services.current_staff_grant
    reads = []

    def revoked_on_the_second_read(**arguments):
        reads.append(arguments)
        return real(**arguments) if len(reads) == 1 else None

    monkeypatch.setattr(intake_services, "current_staff_grant", revoked_on_the_second_read)
    problem(world.post(), 403, "forbidden")
    assert len(reads) == 2
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0
    monkeypatch.setattr(intake_services, "current_staff_grant", real)
    assert world.post().status_code == 201, "the refused key was not usable once the grant held"


def test_get_is_405(world):
    response = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1").get(PATH)
    problem(response, 405, "method-not-allowed")
    assert response.headers["Allow"] == "POST"


# -------------------------------------------------------------------- where it may run ----


@pytest.mark.parametrize(
    ("setting", "value"),
    [("KODERA_INTAKE_ADMITTED", False), ("KODERA_CONTACT_SEAL_KEY", None)],
)
def test_a_database_that_does_not_admit_the_intake_refuses_it(world, settings, setting, value):
    setattr(settings, setting, value)
    problem(world.post(), 503, "intake-closed")
    assert written() == NOTHING and IdempotencyRecord.objects.count() == 0
    setattr(settings, setting, True if setting == "KODERA_INTAKE_ADMITTED" else b"k" * 32)
    assert world.post().status_code == 201, "the same key was refused once the intake was admitted"


def test_the_gate_is_closed_unless_set_to_one():
    assert intake_admitted({}) is False
    assert intake_admitted({"KODERA_INTAKE_ADMITTED": ""}) is False
    assert intake_admitted({"KODERA_INTAKE_ADMITTED": "0"}) is False
    assert intake_admitted({"KODERA_INTAKE_ADMITTED": "1"}) is True
    for value in ("true", "yes", " 1", "2"):
        with pytest.raises(ImproperlyConfigured):
            intake_admitted({"KODERA_INTAKE_ADMITTED": value})


# ------------------------------------------------------------------------------ sealing ----


def test_a_sealed_value_opens_only_under_its_key_and_associated_data():
    key, other = b"\x01" * 32, b"\x02" * 32
    sealed = sealing.seal(key, b"context:a", b"secret")
    assert sealing.unseal(key, b"context:a", sealed) == b"secret"
    assert sealing.seal(key, b"context:a", b"secret") != sealed, "a nonce was reused"
    for wrong_key, context, value in (
        (other, b"context:a", sealed),
        (key, b"context:b", sealed),
        (key, b"context:a", sealed[:-1] + bytes([sealed[-1] ^ 1])),
        (key, b"context:a", b"\x02" + sealed[1:]),
        (key, b"context:a", sealed[:20]),
    ):
        with pytest.raises(sealing.SealError):
            sealing.unseal(wrong_key, context, value)


def test_a_seal_key_is_32_bytes_of_url_safe_base64():
    import base64

    name = "KODERA_CONTACT_SEAL_KEY"
    assert sealing.key_from_environment({}, name) is None
    encoded = base64.urlsafe_b64encode(b"\x07" * 32).decode()
    assert sealing.key_from_environment({name: encoded}, name) == b"\x07" * 32
    for value in ("not base64!", base64.urlsafe_b64encode(b"\x07" * 31).decode()):
        with pytest.raises(sealing.SealKeyError):
            sealing.key_from_environment({name: value}, name)


def test_the_masked_address_keeps_the_ends_of_the_local_part_and_the_domain():
    assert intake_services.mask_email("julie@acme.fr") == "j***e@acme.fr"
    assert intake_services.mask_email("joe@acme.fr") == "j***e@acme.fr"
    assert intake_services.mask_email("jo@acme.fr") == "***@acme.fr"
    assert intake_services.mask_email("j@acme.fr") == "***@acme.fr"
