"""Finite admission and closed audit controls; no local service is started."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from owner_claim_consume_fixtures import (
    call_consume,
    http_signer as http_signer,
    issued_owner as issued_owner,
    owner_world as owner_world,
    post_consume,
    w as w,
)

ORG = UUID("01900000-0000-7000-8000-000000000001")
ACTOR = UUID("01900000-0000-7000-8000-000000000002")
TARGET = UUID("01900000-0000-7000-8000-000000000003")


@pytest.mark.parametrize(
    "state,expected", [("55P03", True), ("40P01", False), ("23514", False), (None, False)]
)
def test_only_named_nowait_sqlstate_is_transient_admission(state, expected):
    from apps.orgs.claim_consumption import _is_busy

    error = RuntimeError("synthetic private diagnostic")
    cause = RuntimeError("synthetic secret")
    cause.sqlstate = state
    error.__cause__ = cause
    assert _is_busy(error) is expected


@pytest.mark.parametrize(
    "action,kind",
    [
        ("owner_claim.consumed", "owner_claim"),
        ("membership.created", "membership"),
        ("organisation.activated", "organisation"),
    ],
)
def test_consumption_audit_writer_is_closed_tenant_identifier_only(monkeypatch, action, kind):
    from apps.audit import services

    rows = []
    monkeypatch.setattr(services.AuditEvent.objects, "create", lambda **row: rows.append(row))
    services.record_consumption_event(
        action=action,
        organisation_id=ORG,
        target_id=TARGET,
        actor_id=ACTOR,
        request_id="public-consume-request-1",
    )
    assert rows[0]["action"] == action
    assert rows[0]["actor_type"] == "tenant"
    assert rows[0]["actor_id"] == ACTOR
    assert rows[0]["target_urn"] == f"urn:kodera:{kind}:{TARGET}"
    assert rows[0]["metadata"] == {}
    with pytest.raises(ValueError):
        services.record_consumption_event(
            action="identity.bound",
            organisation_id=ORG,
            target_id=TARGET,
            actor_id=ACTOR,
            request_id="public-consume-request-1",
        )


def test_terminal_denial_state_reasons_are_registered_without_loosening_staff_registry():
    from apps.audit import services

    assert services.AUTHZ_DENIED_REASONS == frozenset({"mfa_missing", "role_missing"})
    assert services.CLAIM_DENIED_REASONS == frozenset({"issued", "consumed", "expired", "revoked"})


def test_admission_weakening_mutation_exposes_deadlock_misclassification(monkeypatch):
    from contextlib import nullcontext

    from django.db import OperationalError
    from django.test import RequestFactory

    from apps.orgs import claim_consumption
    from apps.orgs.api import owner_claims as view
    from services.identity.access_tokens import VerifiedAccessToken

    error = OperationalError("synthetic private diagnostic")
    error.__cause__ = RuntimeError()
    error.__cause__.sqlstate = "40P01"
    principal = claim_consumption.ConsumerPrincipal(TARGET, ACTOR, ORG)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    monkeypatch.setattr(
        view, "verify_configured_token", lambda *args, **kwargs: (verified, "customer")
    )
    monkeypatch.setattr(claim_consumption, "connection", SimpleNamespace(in_atomic_block=False))
    monkeypatch.setattr(claim_consumption, "transaction", SimpleNamespace(atomic=nullcontext))
    monkeypatch.setattr(claim_consumption, "resolve_consumer", lambda **kwargs: principal)
    monkeypatch.setattr(claim_consumption, "try_lock", lambda lock: True)
    monkeypatch.setattr(claim_consumption, "unlock", lambda locks: None)

    def crash(*args, **kwargs):
        raise error

    monkeypatch.setattr(view, "respond_once", crash)
    request = RequestFactory().post(
        "/api/v1/owner-claims/actions/consume",
        data=b"{}",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer public-unit-credential",
    )

    def require_generic_failure():
        response = view.consume_owner_claim(request)
        assert response.status_code == 500, "deadlock was reclassified as transient admission"

    require_generic_failure()
    monkeypatch.setattr(claim_consumption, "_is_busy", lambda error: True)
    with pytest.raises(AssertionError, match="deadlock was reclassified"):
        require_generic_failure()


def test_actual_hold_queries_admit_parent_before_identity_and_sorted_retained_fanout(monkeypatch):
    from apps.orgs import claim_consumption as service
    from services.identity.access_tokens import VerifiedAccessToken

    statements = []
    answers = iter(
        [
            (ACTOR, "owner@customer.test", None),
            (TARGET,),
            [(ORG, "prospect", "public-org", "public-org", "Public org", None, None, None)],
        ]
    )

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, parameters):
            statements.append(sql)

        def fetchone(self):
            return next(answers)

        def fetchall(self):
            return next(answers)

    monkeypatch.setattr(service, "connection", SimpleNamespace(cursor=Cursor))
    principal = service.ConsumerPrincipal(TARGET, ACTOR, ORG)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    held = service._hold_principal(principal, verified)
    assert held.organisation[0] == ORG
    assert "identity_user" in statements[0] and "FOR NO KEY UPDATE NOWAIT" in statements[0]
    assert "identity_identity" in statements[1] and "FOR SHARE NOWAIT" in statements[1]
    assert "ORDER BY id FOR NO KEY UPDATE NOWAIT" in statements[2]
    assert "identity_identity" in statements[2] and "orgs_membership" in statements[2]
    assert "deleted_at" not in statements[2].split(" WHERE ", 1)[1].split("ORDER BY")[0]


def test_fresh_handler_cannot_run_outside_its_entered_held_transaction():
    from apps.orgs import claim_consumption as service
    from services.identity.access_tokens import VerifiedAccessToken

    principal = service.ConsumerPrincipal(TARGET, ACTOR, ORG)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    operation = service.Consumption(
        principal=principal, verified=verified, body=b"{}", request_id="public-request-1"
    )
    with pytest.raises(RuntimeError, match="consume handler requires current held authority"):
        operation.fresh()


def test_retained_deleted_organisation_never_grants_bootstrap_or_owner_replay(monkeypatch):
    from apps.orgs import claim_consumption as service
    from services.identity.access_tokens import VerifiedAccessToken

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            pass

        def fetchone(self):
            return (TARGET,)

        def fetchall(self):
            return []

    monkeypatch.setattr(service, "connection", SimpleNamespace(cursor=Cursor))
    principal = service.ConsumerPrincipal(TARGET, ACTOR, ORG)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    operation = service.Consumption(
        principal=principal, verified=verified, body=b"{}", request_id="public-request-1"
    )
    operation.held = service.HeldConsumer(
        "owner@customer.test",
        None,
        (ORG, "prospect", "public-org", "public-org", "Public org", None, None, "deleted"),
    )
    with pytest.raises(service.ConsumeGuardError, match="consume authority refused"):
        operation._bound_role(SimpleNamespace(state="issued"))


def test_consume_domain_closure_does_not_depend_on_api_or_http_modules():
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    tree = ast.parse((root / "apps/orgs/claim_consumption.py").read_text())
    forbidden = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.startswith(("api.", "apps.orgs.api.", "core.api.", "django.http")):
                forbidden.append(module)
    assert forbidden == [], "consume domain service crosses its API boundary"


@pytest.mark.parametrize("mode", ["advisory", "nowait"])
def test_transient_admission_refusal_never_audits_or_mutates_receipt(monkeypatch, mode):
    from contextlib import nullcontext

    from django.db import OperationalError

    from apps.orgs import claim_consumption as service
    from services.identity.access_tokens import VerifiedAccessToken

    principal = service.ConsumerPrincipal(TARGET, ACTOR, ORG)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        1,
        9999999999,
        None,
        ("otp",),
        None,
        1,
    )
    audits, releases = [], []
    monkeypatch.setattr(service, "connection", SimpleNamespace(in_atomic_block=False))
    monkeypatch.setattr(service, "transaction", SimpleNamespace(atomic=nullcontext))
    monkeypatch.setattr(service, "resolve_consumer", lambda **kwargs: principal)
    monkeypatch.setattr(service, "try_lock", lambda lock: mode == "nowait")
    monkeypatch.setattr(service, "unlock", lambda locks: releases.append(locks))
    monkeypatch.setattr(service, "record_authz_denied", lambda **row: audits.append(row))
    with pytest.raises(service.ConsumeGuardError) as caught:
        with service.consumption_operation(
            verified=verified,
            lane="customer",
            body=b"{}",
            parser=lambda body: None,
            request_id="public-transient-request-1",
        ):
            error = OperationalError("synthetic private lock message")
            error.__cause__ = RuntimeError()
            error.__cause__.sqlstate = "55P03"
            raise error
    assert caught.value.kind == "service-unavailable"
    assert audits == [], "transient admission persisted an authorization audit"
    assert len(releases) == (mode == "nowait")


@pytest.mark.django_db(transaction=True)
def test_actual_replay_hook_omission_releases_forbidden_cached_success(issued_owner, monkeypatch):
    from apps.orgs import claim_consumption as service
    from core.idempotency.store import ReplayAuthority

    assert post_consume(issued_owner).status_code == 200

    def require_current_facts():
        response = post_consume(issued_owner, facts={"kodera_mfa_enrolled": False})
        assert response.status_code == 403, "cached success escaped current factor authority"
        assert "Idempotency-Replayed" not in response

    require_current_facts()
    original = service.Consumption.authority

    def omit_replay(self, event):
        if not isinstance(event, ReplayAuthority):
            return original(self, event)
        return None

    monkeypatch.setattr(service.Consumption, "authority", omit_replay)
    with pytest.raises(AssertionError, match="cached success escaped"):
        require_current_facts()


@pytest.mark.django_db(transaction=True)
def test_actual_metadata_hook_omission_releases_forbidden_key_reuse_details(
    issued_owner, monkeypatch
):
    from apps.orgs import claim_consumption as service
    from core.idempotency.store import MetadataAuthority

    assert post_consume(issued_owner).status_code == 200
    changed = {"token": issued_owner[2], "display_name": "Changed logical body"}

    def require_current_facts():
        response = post_consume(
            issued_owner,
            payload=changed,
            facts={"kodera_mfa_enrolled": False},
        )
        assert response.status_code == 403, "key metadata escaped current factor authority"
        assert "first_seen_at" not in response.json()

    require_current_facts()
    original = service.Consumption.authority

    def omit_metadata(self, event):
        if not isinstance(event, MetadataAuthority):
            return original(self, event)
        return None

    monkeypatch.setattr(service.Consumption, "authority", omit_metadata)
    with pytest.raises(AssertionError, match="key metadata escaped"):
        require_current_facts()


@pytest.mark.django_db(transaction=True)
def test_actual_contact_gate_omission_admits_forbidden_first_ownership(issued_owner, monkeypatch):
    from apps.orgs import claim_consumption as service

    def require_no_effect(key):
        response = post_consume(issued_owner, key=key, facts={"email_verified": False})
        assert response.status_code == 403, "unverified contact obtained first ownership"

    require_no_effect("consume-public-key-0001")

    def omit_facts(self, claim, now):
        self.factor_horizon = now + timedelta(seconds=300)

    monkeypatch.setattr(service.Consumption, "_facts", omit_facts)
    with pytest.raises(AssertionError, match="unverified contact obtained"):
        require_no_effect("consume-public-key-0002")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "failing_action",
    [
        "owner_claim.consumed",
        "membership.created",
        "organisation.activated",
        "replay",
        "reservation",
        "activation",
    ],
)
def test_each_actual_audit_boundary_fault_rolls_back_effects_and_receipt(
    issued_owner, monkeypatch, failing_action
):
    from django.db.models.query import QuerySet

    from apps.audit.models import AuditEvent
    from apps.identity.models import User
    from apps.orgs import claim_consumption as service
    from apps.orgs.models import Membership, Organisation, OwnerClaim, SlugReservation
    from core.idempotency.models import IdempotencyRecord

    before = list(User.objects.values_list("id", "display_name"))
    audits = AuditEvent.objects.count()
    original = service.record_consumption_event

    def fail(**row):
        if row["action"] == failing_action:
            raise RuntimeError("synthetic exact audit boundary")
        return original(**row)

    monkeypatch.setattr(service, "record_consumption_event", fail)
    if failing_action == "replay":
        create = IdempotencyRecord.objects.create

        def fail_after_receipt(**row):
            create(**row)
            raise RuntimeError("synthetic exact audit boundary")

        monkeypatch.setattr(IdempotencyRecord.objects, "create", fail_after_receipt)
    elif failing_action in {"reservation", "activation"}:
        update = QuerySet.update

        def fail_after_effect(queryset, **row):
            result = update(queryset, **row)
            if (
                failing_action == "reservation"
                and queryset.model is SlugReservation
                and row.get("state") == "permanent"
            ) or (
                failing_action == "activation"
                and queryset.model is Organisation
                and row.get("state") == "active"
            ):
                raise RuntimeError("synthetic exact audit boundary")
            return result

        monkeypatch.setattr(QuerySet, "update", fail_after_effect)
    with pytest.raises(RuntimeError, match="synthetic exact audit boundary"):
        call_consume(
            issued_owner, payload={"token": issued_owner[2], "display_name": "Changed own profile"}
        )
    assert list(User.objects.values_list("id", "display_name")) == before
    assert AuditEvent.objects.count() == audits and Membership.objects.count() == 0
    assert IdempotencyRecord.objects.count() == 0
    assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"
    assert Organisation.objects.get(id=issued_owner[0].organisation.id).state == "prospect"
    assert (
        SlugReservation.objects.get(organisation_id=issued_owner[0].organisation.id).state
        == "provisional"
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["delete", "update"])
def test_actual_binding_mutation_is_refused_by_retained_storage_not_a_fixture_bypass(
    issued_owner, operation
):
    from django.db import IntegrityError, transaction

    from apps.orgs.models import OwnerBinding

    binding = OwnerBinding.objects.get(organisation_id=issued_owner[0].organisation.id)
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        if operation == "delete":
            OwnerBinding.objects.filter(id=binding.id).delete()
        else:
            OwnerBinding.objects.filter(id=binding.id).update(issuer=binding.issuer)
    assert caught.value.__cause__.sqlstate == "23514"
    assert caught.value.__cause__.diag.constraint_name == "owner_binding_immutable"
    assert (
        OwnerBinding.objects.get(id=binding.id).identity_id == issued_owner[1].intended_identity_id
    )


@pytest.mark.parametrize("state", ["prospect", "active"])
def test_common_binding_gate_refuses_both_replay_roles_and_omission_loses_refusal(
    monkeypatch, state
):
    import inspect
    import textwrap

    from apps.orgs import claim_consumption as service
    from core.idempotency.store import ReplayAuthority
    from services.identity.access_tokens import VerifiedAccessToken

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, parameters):
            pass

        def fetchone(self):
            return None

        def fetchall(self):
            return [] if state == "prospect" else [(TARGET, "org_owner", "active", object())]

    principal = service.ConsumerPrincipal(TARGET, ACTOR, ORG)
    now = datetime.now(UTC)
    verified = VerifiedAccessToken(
        "https://id.customer.test/realms/public-org",
        "public-subject",
        ("kodera-server",),
        int(now.timestamp()),
        int(now.timestamp()) + 300,
        None,
        ("otp",),
        None,
        int(now.timestamp()),
        email_verified=True,
        authorized_party="synthetic-console",
        mfa_enrolled=True,
    )
    operation = service.Consumption(
        principal=principal,
        verified=verified,
        body=b"{}",
        request_id="public-binding-request-1",
        console_client_id="synthetic-console",
    )
    operation.held = service.HeldConsumer(
        "owner@customer.test",
        None,
        (ORG, state, "public-org", "public-org", "Public org", None, None, None),
    )
    monkeypatch.setattr(service, "connection", SimpleNamespace(cursor=Cursor))
    monkeypatch.setattr(service, "database_now", lambda: now)
    monkeypatch.setattr(operation, "_context", lambda: (None, SimpleNamespace(state="consumed")))

    def require_binding_refusal():
        with pytest.raises(service.ConsumeGuardError):
            operation.authority(ReplayAuthority(200))

    require_binding_refusal()
    original = textwrap.dedent(inspect.getsource(service.Consumption._bound_role))
    guarded = 'if cursor.fetchone() is None:\n            raise ConsumeGuardError("forbidden", reason=claim.state)'
    assert guarded in original
    namespace = dict(service.__dict__)
    exec(  # noqa: S102 — one fixed mutation of the checked local function, no external input
        compile(
            original.replace(guarded, "cursor.fetchone()"), "<binding-refusal-mutation>", "exec"
        ),
        namespace,
    )
    monkeypatch.setattr(service.Consumption, "_bound_role", namespace["_bound_role"])
    with pytest.raises(pytest.fail.Exception, match="DID NOT RAISE"):
        require_binding_refusal()


@pytest.mark.django_db(transaction=True)
def test_actual_consumed_binding_guard_refuses_another_person_membership(issued_owner):
    from django.db import IntegrityError, transaction
    from django.utils import timezone

    from apps.identity.models import User
    from apps.orgs.models import Membership, OwnerClaim

    claim = issued_owner[1]
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        person = User.objects.create(email="wrong.consuming.person@customer.test")
        membership = Membership.objects.create(
            user=person,
            organisation_id=claim.organisation_id,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        OwnerClaim.objects.filter(id=claim.id).update(
            state="consumed",
            consumed_at=timezone.now(),
            consumed_by_identity_id=claim.intended_identity_id,
            membership_id=membership.id,
        )
    assert caught.value.__cause__.sqlstate == "23514"
    assert caught.value.__cause__.diag.constraint_name == "owner_claim_consumed_membership_valid"
    assert OwnerClaim.objects.get(id=claim.id).state == "issued"
    assert not Membership.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("gate", ["owner", "reservation"])
def test_actual_activation_requires_owner_and_permanent_reservation(issued_owner, gate):
    from django.db import IntegrityError, transaction
    from django.utils import timezone

    from apps.identity.models import Identity
    from apps.orgs.models import Membership, Organisation, SlugReservation

    org = issued_owner[0].organisation
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        if gate == "owner":
            SlugReservation.objects.filter(organisation=org).update(
                state="permanent", protected_at=timezone.now()
            )
        else:
            intended = Identity.objects.get(id=issued_owner[1].intended_identity_id)
            Membership.objects.create(
                user_id=intended.user_id,
                organisation=org,
                role="org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
        Organisation.objects.filter(id=org.id).update(state="active")
    assert caught.value.__cause__.sqlstate == "23514"
    assert caught.value.__cause__.diag.constraint_name == (
        "organisation_owner_required" if gate == "owner" else "organisation_reservation_required"
    )
    assert Organisation.objects.get(id=org.id).state == "prospect"
    assert SlugReservation.objects.get(organisation=org).state == "provisional"
    assert not Membership.objects.exists()
