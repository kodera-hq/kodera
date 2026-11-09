"""The two-operation bootstrap exception never grants ordinary customer access."""

import importlib
import time
from pathlib import Path
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, token, trust_entry
from django.test import Client
from owner_claim_fixtures import activate_owner_history_fixture, bind, owner_world as owner_world
from test_customer_persistence_models import anchor, anchor_models, identity as stored_identity
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.identity.models import Identity, StaffRole
from apps.orgs.models import Membership, OwnerBinding, OwnerClaim


def test_bootstrap_read_and_closed_authorizer_exist_before_http_acceptance():
    root = Path(__file__).resolve().parents[1]
    assert (root / "apps/orgs/bootstrap_services.py").is_file(), (
        "specified bootstrap read service missing"
    )
    permissions = importlib.import_module("apps.orgs.api.bootstrap_permissions")
    assert callable(permissions.authorise_bootstrap_operation)
    assert permissions.BOOTSTRAP_OPERATIONS == frozenset(
        {"getOrganisationBootstrap", "consumeOwnerClaim"}
    )


def credential(world, identity, **changes):
    now = int(time.time())
    return token(world.signer, identity.issuer, identity.subject, iat=now, exp=now + 300, **changes)


def get(world, identity, target=None, **changes):
    path = "/api/v1/organisations/" + str(target or world.organisation.id) + "/bootstrap"
    return Client().get(path, HTTP_AUTHORIZATION="Bearer " + credential(world, identity, **changes))


@pytest.mark.django_db(transaction=True)
def test_bound_customer_without_membership_mfa_or_contact_fact_reads_secret_free_view(owner_world):
    issued = bind(owner_world)
    identity = Identity.objects.get(id=OwnerBinding.objects.get(id=issued.binding_id).identity_id)
    response = get(owner_world, identity)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Request-Id"]
    body = response.json()
    assert body["organisation_state"] == "prospect" and body["claim"]["state"] == "issued"
    assert body["realm"]["state"] == body["identity_mapping"]["state"] == "ready"
    assert body["identity_mapping"]["identity_id"] == str(identity.id)
    assert not Membership.objects.filter(organisation_id=owner_world.organisation.id).exists()
    text = response.content.decode()
    assert bytes(OwnerClaim.objects.get(id=issued.claim_id).token_hash).decode() not in text
    assert "first.owner@customer.test" not in text
    assert not {"token_hash", "sealed_contact", "delivery_id", "owner_confirmed"}.intersection(body)
    ordinary = Client().get(
        "/api/v1/organisations/" + str(owner_world.organisation.id),
        HTTP_AUTHORIZATION="Bearer " + credential(owner_world, identity),
    )
    assert ordinary.status_code == 403
    assert get(owner_world, identity, target=uuid4()).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_bound_persons_token_from_another_realm_reads_no_bootstrap_here(owner_world):
    # Organisation realms share one audience: only the issuer binds a token to this organisation.
    issued = bind(owner_world)
    bound = Identity.objects.get(id=OwnerBinding.objects.get(id=issued.binding_id).identity_id)
    bravo, _, _ = anchor(anchor_models(), slug="bravo")
    elsewhere = stored_identity(anchor_models(), bravo, bound.user, subject="bound-owner-in-bravo")
    owner_world.trust.append(trust_entry(owner_world.signer, bravo.issuer))
    configure(owner_world.settings, owner_world.trust)
    assert get(owner_world, bound).status_code == 200, "the bound token must still read here"
    foreign = get(owner_world, elsewhere)
    unknown = get(owner_world, elsewhere, target=uuid4())
    assert foreign.status_code == unknown.status_code == 404, "a foreign realm reached bootstrap"
    assert foreign.json()["type"] == unknown.json()["type"], "foreign and unknown targets differ"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("role", ["staff_operator", "staff_support", "staff_security"])
def test_staff_read_requires_independently_sufficient_allowed_current_role_and_mfa(
    owner_world, role
):
    from test_operator_realm_bootstrap import staff

    actor = staff("reader-" + role, roles=(role,))
    assert get(owner_world, actor, amr=["pwd", "otp"]).status_code == (
        403 if role == "staff_security" else 200
    )
    assert get(owner_world, actor, amr=["pwd"]).status_code == 403
    from django.utils import timezone

    StaffRole.objects.filter(identity=actor).update(revoked_at=timezone.now())
    assert get(owner_world, actor, amr=["otp"]).status_code == 403


@pytest.mark.django_db(transaction=True)
def test_unknown_customer_is_403_identity_unknown_and_invalid_signature_is_401(owner_world):
    # A current token, as credential() signs one: token()'s default iat is in the future, which
    # the verifier refuses with a 401 before any identity is resolved.
    now = int(time.time())
    response = Client().get(
        "/api/v1/organisations/" + str(owner_world.organisation.id) + "/bootstrap",
        HTTP_AUTHORIZATION="Bearer "
        + token(
            owner_world.signer,
            owner_world.organisation.issuer,
            "unbound-unknown",
            iat=now,
            exp=now + 300,
        ),
    )
    assert response.status_code == 403
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"
    assert "WWW-Authenticate" not in response.headers
    assert (
        Client()
        .get(
            "/api/v1/organisations/" + str(owner_world.organisation.id) + "/bootstrap",
            HTTP_AUTHORIZATION="Bearer invalid",
        )
        .status_code
        == 401
    )


@pytest.mark.django_db(transaction=True)
def test_bootstrap_expiry_is_read_time_database_clock_and_single_system_audit(
    owner_world, settings
):
    from django.db import connection

    from apps.audit.models import AuditEvent

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    issued = bind(owner_world)
    identity = Identity.objects.get(id=OwnerBinding.objects.get(id=issued.binding_id).identity_id)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    first, second = get(owner_world, identity), get(owner_world, identity)
    assert first.status_code == second.status_code == 200
    assert first.json()["claim"]["state"] == second.json()["claim"]["state"] == "expired"
    assert OwnerClaim.objects.get(id=issued.claim_id).state == "expired"
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 1


@pytest.mark.django_db(transaction=True)
def test_post_consumption_bootstrap_stays_readable_and_preserves_terminal_wire_history(owner_world):
    from django.db import transaction
    from django.utils import timezone

    issued = bind(owner_world)
    claim = OwnerClaim.objects.get(id=issued.claim_id)
    identity = Identity.objects.get(id=claim.intended_identity_id)
    with transaction.atomic():
        member = Membership.objects.create(
            user_id=identity.user_id,
            organisation_id=claim.organisation_id,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        activate_owner_history_fixture(claim.organisation_id)
        OwnerClaim.objects.filter(id=claim.id).update(
            state="consumed",
            consumed_at=timezone.now(),
            consumed_by_identity_id=identity.id,
            membership_id=member.id,
        )
    response = get(owner_world, identity)
    assert response.status_code == 200
    assert response.json()["claim"]["state"] == "consumed"
    assert response.json()["claim"]["membership_id"] == str(member.id)


def test_latest_public_job_selector_exists_before_private_projection_change():
    from apps.jobs import selectors

    assert callable(getattr(selectors, "latest_job_state", None)), "narrow queue selector missing"


def test_unbound_status_queries_do_not_project_sealed_intake(monkeypatch):
    from django.db.models.query import QuerySet

    from apps.orgs.bootstrap_selectors import bootstrap_view

    statements = []

    def empty_result(queryset):
        statements.append(queryset.query.get_compiler(using=queryset.db).as_sql()[0])
        queryset._result_cache = []

    monkeypatch.setattr(QuerySet, "_fetch_all", empty_result)
    assert bootstrap_view(organisation_id=uuid4()) is None
    assert statements
    assert all('"sealed_contact"' not in sql for sql in statements)
    assert all('"recorded_by_identity_id"' not in sql for sql in statements)


@pytest.mark.django_db(transaction=True)
def test_materialized_status_excludes_private_columns_from_executed_sql(owner_world):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from apps.orgs.bootstrap_selectors import bootstrap_view

    bind(owner_world)
    with CaptureQueriesContext(connection) as captured:
        view = bootstrap_view(organisation_id=owner_world.organisation.id)
        assert view is not None and view.claim_state == "issued"
    projections = [
        row["sql"].split(" FROM ", 1)[0] for row in captured if row["sql"].startswith("SELECT")
    ]
    assert projections
    for private in (
        "sealed_contact",
        "token_hash",
        "delivery_id",
        "desired_spec_hash",
        "payload",
        "subject",
        "recorded_by_identity_id",
    ):
        assert all('"' + private + '"' not in sql for sql in projections), private


@pytest.mark.django_db(transaction=True)
def test_latest_job_state_preserves_replacement_order_and_time_tie(owner_world):
    from django.utils import timezone

    from apps.jobs.models import Job
    from apps.jobs.selectors import latest_job_state

    original = Job.objects.filter(
        organisation_id=owner_world.organisation.id, kind="realm_create"
    ).get()
    stamp = timezone.now()
    replacements = [
        Job.objects.create(
            organisation_id=original.organisation_id,
            kind=original.kind,
            status="queued",
            desired_spec_hash=original.desired_spec_hash,
            idempotency_key=digit * 64,
            max_attempts=original.max_attempts,
            actor_type="staff",
            actor_id=owner_world.operator.id,
            created_at=stamp,
        )
        for digit in ("b", "c")
    ]
    selected = latest_job_state(organisation_id=original.organisation_id, kind=original.kind)
    expected = max(row.id for row in replacements)
    assert selected is not None and selected.id == expected and selected.status == "queued"
    assert latest_job_state(organisation_id=uuid4(), kind="realm_create") is None


AUTHORITY_WITHDRAWALS = (
    "customer_identity",
    "customer_person",
    "staff_grant",
    "staff_identity",
    "staff_person",
)


def authority_target(world, case):
    from test_operator_realm_bootstrap import staff

    if case.startswith("customer"):
        issued = bind(world)
        return Identity.objects.get(id=OwnerBinding.objects.get(id=issued.binding_id).identity_id)
    return staff("concurrent-bootstrap-reader", roles=("staff_support",))


def withdraw_authority(actor, case):
    from django.utils import timezone

    from apps.identity.models import User

    if case == "staff_grant":
        assert (
            StaffRole.objects.filter(identity=actor, revoked_at__isnull=True).update(
                revoked_at=timezone.now()
            )
            == 1
        )
    elif case.endswith("person"):
        assert User.objects.filter(id=actor.user_id).update(enabled=False) == 1
    else:
        assert Identity.objects.filter(id=actor.id).update(enabled=False) == 1


def authorized_get(world, actor, case):
    return get(world, actor, **({"amr": ["otp"]} if case.startswith("staff") else {}))


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("case", AUTHORITY_WITHDRAWALS)
def test_committed_authority_withdrawal_denies_waiting_read_before_expiry(
    owner_world, settings, case
):
    from django.db import connection, transaction
    from owner_claim_fixtures import (
        assert_database_wait,
        finish_db_call,
        settle_db_calls,
        start_db_call,
    )

    from apps.audit.models import AuditEvent

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    actor = authority_target(owner_world, case)
    if case.startswith("staff"):
        bind(owner_world)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    read = None
    try:
        with transaction.atomic():
            withdraw_authority(actor, case)
            read = start_db_call(lambda: authorized_get(owner_world, actor, case))
            assert_database_wait(read[2])
    finally:
        settle_db_calls(read)
    assert read is not None
    response = finish_db_call(read)
    assert response.status_code in (401, 403)
    assert OwnerClaim.objects.get().state == "issued"
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("case", AUTHORITY_WITHDRAWALS)
def test_held_authority_covers_response_bytes_and_withdrawal_waits_for_release(
    owner_world, monkeypatch, case
):
    import threading

    from owner_claim_fixtures import (
        assert_database_wait,
        finish_db_call,
        settle_db_calls,
        start_db_call,
    )

    from apps.orgs import bootstrap_services

    actor = authority_target(owner_world, case)
    entered, release = threading.Event(), threading.Event()
    real_serializer = bootstrap_services.serialize_bootstrap

    def held_serializer(view):
        encoded = real_serializer(view)
        entered.set()
        assert release.wait(10), "held response materialization not released"
        return encoded

    monkeypatch.setattr(bootstrap_services, "serialize_bootstrap", held_serializer)
    read = start_db_call(lambda: authorized_get(owner_world, actor, case))
    change = None
    try:
        assert entered.wait(10)
        change = start_db_call(lambda: withdraw_authority(actor, case))
        assert_database_wait(change[2])
    finally:
        release.set()
        settle_db_calls(read, change)
    assert finish_db_call(read).status_code == 200
    assert change is not None
    finish_db_call(change)
    assert authorized_get(owner_world, actor, case).status_code in (401, 403)


@pytest.mark.django_db(transaction=True)
def test_bootstrap_expiry_audit_failure_rolls_back_and_releases_held_authority(
    owner_world, settings, monkeypatch
):
    from django.db import connection
    from owner_claim_fixtures import finish_db_call, start_db_call

    from apps.audit import services as audit_services
    from apps.orgs import bootstrap_services
    from services.identity.trusted_issuers import verify_configured_token

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    actor = authority_target(owner_world, "customer_identity")
    verified, lane = verify_configured_token(
        credential(owner_world, actor), trusted=settings.KODERA_AUTH_TRUST
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    before = OwnerClaim.objects.get().state

    def crash(**kwargs):
        raise RuntimeError("public synthetic audit failure")

    monkeypatch.setattr(audit_services, "record_owner_event", crash)
    with pytest.raises(RuntimeError, match="public synthetic audit failure"):
        bootstrap_services.read_bootstrap(
            verified=verified,
            lane=lane,
            target_id=owner_world.organisation.id,
            request_id="req-bootstrap-audit-failure",
        )
    assert OwnerClaim.objects.get().state == before == "issued"
    assert (
        finish_db_call(start_db_call(lambda: withdraw_authority(actor, "customer_identity")))
        is None
    )


@pytest.mark.django_db(transaction=True)
def test_staff_status_after_trust_withdrawal_and_restoration_keeps_recorded_history(
    owner_world, settings
):
    from apps.jobs.models import Job
    from apps.orgs.models import RealmReadiness

    issued = bind(owner_world)
    before_job = list(Job.objects.values())
    before_facts = list(RealmReadiness.objects.values())
    trusted = settings.KODERA_AUTH_TRUST
    settings.KODERA_AUTH_TRUST = tuple(entry for entry in trusted if entry.lane == "staff")
    response = get(owner_world, owner_world.operator, amr=["otp"])
    assert response.status_code == 200
    body = response.json()
    assert body["realm"]["state"] == "failed"
    assert body["identity_mapping"]["state"] == "ready"
    assert body["claim"]["state"] == "issued"
    assert "reason" not in body["realm"]
    assert "reason" not in body["identity_mapping"] and "reason" not in body["claim"]
    settings.KODERA_AUTH_TRUST = trusted
    restored = get(owner_world, owner_world.operator, amr=["otp"])
    assert restored.status_code == 200 and restored.json()["realm"]["state"] == "ready"
    assert (
        list(Job.objects.values()) == before_job
        and list(RealmReadiness.objects.values()) == before_facts
    )
    assert OwnerClaim.objects.get(id=issued.claim_id).state == "issued"


def test_recorded_realm_without_current_trust_keeps_history_before_policy_repair(monkeypatch):
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from apps.orgs import bootstrap_selectors as selector

    now = datetime(2000, 1, 1, tzinfo=UTC)
    organisation_id, job_id = uuid4(), uuid4()

    class Query:
        def __init__(self, row):
            self.row = row

        def filter(self, **kwargs):
            return self

        def only(self, *fields):
            return self

        def order_by(self, *fields):
            return self

        def first(self):
            return self.row

        def exists(self):
            return self.row is not None

    monkeypatch.setattr(
        selector.Organisation,
        "objects",
        Query(
            SimpleNamespace(
                id=organisation_id,
                slug="synthetic",
                state="prospect",
                realm="synthetic",
                issuer="https://identity.customer.test/realms/synthetic",
                updated_at=now,
            )
        ),
    )
    monkeypatch.setattr(
        selector.OrganisationIntake,
        "objects",
        Query(
            SimpleNamespace(
                instruction_ref="public-intake",
                created_at=now,
                intended_owner_email_masked="p***c@customer.test",
                bootstrap_job_id=job_id,
            )
        ),
    )
    monkeypatch.setattr(
        selector.OwnerBinding,
        "objects",
        Query(SimpleNamespace(id=uuid4(), identity_id=uuid4(), recorded_at=now)),
    )
    monkeypatch.setattr(selector.OwnerClaim, "objects", Query(None))
    monkeypatch.setattr(selector.RealmReadiness, "objects", Query(object()))
    monkeypatch.setattr(
        selector,
        "latest_job_state",
        lambda **kwargs: SimpleNamespace(id=job_id, status="succeeded"),
    )
    monkeypatch.setattr(selector, "counting_realm_ready", lambda **kwargs: False)
    monkeypatch.setattr(selector, "is_trusted_issuer", lambda *args, **kwargs: False)
    view = selector.bootstrap_view(organisation_id=organisation_id)
    assert view is not None and view.realm_state == "failed"
    assert view.realm_name == "synthetic" and view.identity_state == "ready"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "case",
    (
        "revoked",
        "missing_replacement",
        "queued_replacement",
        "failed_replacement",
        "cancelled_replacement",
        "mismatched_issuer",
        "mismatched_realm",
        "stale_fact",
    ),
)
def test_invalid_or_replaced_readiness_fact_does_not_count_as_untrusted_history(
    owner_world, settings, case
):
    from django.utils import timezone

    from apps.jobs.models import Job
    from apps.orgs import bootstrap_selectors as selector
    from apps.orgs.models import RealmReadiness

    bind(owner_world)
    settings.KODERA_AUTH_TRUST = tuple(
        entry for entry in settings.KODERA_AUTH_TRUST if entry.lane == "staff"
    )
    original = Job.objects.get(id=owner_world.job_id)
    if case.startswith("mismatched") or case == "stale_fact":
        arguments = dict(
            organisation_id=owner_world.organisation.id,
            job_id=original.id,
            issuer=owner_world.organisation.issuer,
            realm=owner_world.organisation.realm,
        )
        assert selector._recorded_realm_ready(**arguments)
        if case == "mismatched_issuer":
            arguments["issuer"] = "https://wrong.customer.test/realms/wrong"
        elif case == "mismatched_realm":
            arguments["realm"] = "wrong-realm"
        else:
            arguments["job_id"] = uuid4()
        assert not selector._recorded_realm_ready(**arguments)
        return
    if case == "revoked":
        RealmReadiness.objects.filter(job_id=original.id).update(revoked_at=timezone.now())
    else:
        status = {
            "missing_replacement": "succeeded",
            "queued_replacement": "queued",
            "failed_replacement": "failed",
            "cancelled_replacement": "cancelled",
        }[case]
        Job.objects.create(
            organisation_id=original.organisation_id,
            kind="realm_create",
            status=status,
            error_code="step_failed" if status == "failed" else None,
            desired_spec_hash=original.desired_spec_hash,
            idempotency_key="d" * 64,
            max_attempts=original.max_attempts,
            actor_type="staff",
            actor_id=owner_world.operator.id,
        )
    response = get(owner_world, owner_world.operator, amr=["otp"])
    assert response.status_code == 200
    body = response.json()
    assert body["realm"]["state"] == (
        "failed" if case in {"failed_replacement", "cancelled_replacement"} else "pending"
    )
    assert body["realm"]["name"] is None and body["identity_mapping"]["state"] == "pending"
    assert body["claim"]["state"] == "issued"
