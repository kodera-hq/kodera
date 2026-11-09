"""Initial actual intake/queue/outbox binding acceptance; collect only during preparation.

Run only on the admitted disposable database after exact source allocation. Existing K7 world
uses actual stored actors, intake and queue; public realm documents are an explicit fixture.
"""

import importlib
from pathlib import Path

import pytest
from owner_claim_fixtures import owner_world as owner_world
from test_operator_realm_bootstrap import http_signer as http_signer, w as w


@pytest.fixture
def bind_service():
    import apps.orgs

    path = Path(apps.orgs.__file__).parent / "owner_claims.py"
    assert path.is_file(), "specified K8a binding service missing"
    return importlib.import_module("apps.orgs.owner_claims")


def tables():
    from apps.audit.models import AuditEvent
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, OwnerBinding, OwnerClaim
    from apps.outbox.models import OutboxDelivery, OutboxMessage

    return tuple(
        model.objects.count()
        for model in (
            AuditEvent,
            Identity,
            User,
            Membership,
            Organisation,
            OwnerBinding,
            OwnerClaim,
            OutboxDelivery,
            OutboxMessage,
        )
    )


def arguments(service, world):
    from apps.identity.command_principal import staff_principal_for_command

    return {
        "principal": staff_principal_for_command(world.operator.id),
        "organisation_id": world.organisation.id,
        "subject": "synthetic-intended-owner",
        "account_record": service.AccountCreationRecord(
            issuer=world.organisation.issuer,
            subject="synthetic-intended-owner",
            credential_created=False,
            evidence_ref="synthetic-account-created-1",
        ),
        "contact": "first.owner@customer.test",
        "request_id": "req-owner-bind-1",
    }


@pytest.mark.django_db(transaction=True)
def test_actual_bind_is_atomic_sealed_and_creates_no_membership(
    bind_service, owner_world, settings, capsys, caplog
):
    from apps.orgs.claim_tokens import verify_claim_secret
    from apps.orgs.models import Membership, Organisation, OwnerBinding, OwnerClaim
    from apps.outbox.mail.dates import mail_instant
    from apps.outbox.mail.seal import unseal
    from apps.outbox.models import OutboxMessage

    before_members = Membership.objects.count()
    outcome = bind_service.bind_intended_owner(**arguments(bind_service, owner_world))
    claim = OwnerClaim.objects.get(id=outcome.claim_id)
    binding = OwnerBinding.objects.get(id=outcome.binding_id)
    message = OutboxMessage.objects.get(delivery_id=outcome.delivery_id)
    payload = unseal(settings.KODERA_OUTBOX_SEAL_KEY, outcome.delivery_id, bytes(message.sealed))
    assert payload.recipient == "first.owner@customer.test"
    assert verify_claim_secret(payload.secret, bytes(claim.token_hash))
    assert message.template_id == "owner_claim" and message.locale == "fr"
    assert message.expires_at == claim.expires_at
    assert message.params["expires_at"] == mail_instant(claim.expires_at, "fr")
    assert "#" not in message.link and payload.secret not in message.link
    assert Membership.objects.count() == before_members
    assert Organisation.objects.get(id=owner_world.organisation.id).state == "prospect"
    assert binding.identity_id == claim.intended_identity_id
    assert claim.state == "issued"
    out, err = capsys.readouterr()
    text = out + err + caplog.text + repr(outcome)
    assert payload.secret not in text and payload.recipient not in text


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "refusal",
    [
        "known_credential",
        "different_issuer",
        "recorder",
        "contact_mismatch",
        "missing_contact_key",
        "missing_outbox_key",
        "missing_origin",
    ],
)
def test_bind_refusal_rolls_back_every_effect(bind_service, owner_world, settings, refusal):
    from dataclasses import replace

    from apps.identity.command_principal import staff_principal_for_command

    supplied = arguments(bind_service, owner_world)
    if refusal == "known_credential":
        supplied["account_record"] = replace(supplied["account_record"], credential_created=True)
    elif refusal == "different_issuer":
        supplied["account_record"] = replace(
            supplied["account_record"], issuer="https://identity.other.test/realms/other"
        )
    elif refusal == "recorder":
        supplied["principal"] = staff_principal_for_command(owner_world.recorder.id)
    elif refusal == "contact_mismatch":
        supplied["contact"] = "First.owner@customer.test"
    elif refusal == "missing_contact_key":
        settings.KODERA_CONTACT_SEAL_KEY = None
    elif refusal == "missing_outbox_key":
        settings.KODERA_OUTBOX_SEAL_KEY = None
    else:
        settings.KODERA_MAIL_LINK_ORIGINS = frozenset()
    before = tables()
    with pytest.raises(bind_service.ClaimRefusedError):
        bind_service.bind_intended_owner(**supplied)
    assert tables() == before


def test_binding_interface_exists_before_effectful_acceptance():
    from apps.orgs import owner_claims

    assert callable(getattr(owner_claims, "bind_intended_owner", None)), (
        "specified atomic binding service missing"
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "change",
    [
        "unready",
        "withdrawn_issuer",
        "disabled_operator",
        "revoked_operator",
        "not_prospect",
        "already_bound",
        "wrong_subject",
        "missing_link",
        "invalid_lifetime",
    ],
)
def test_each_binding_precondition_refuses_without_new_effects(
    bind_service, owner_world, settings, change
):
    from dataclasses import replace

    from apps.identity.models import Identity, StaffRole
    from apps.orgs.models import Organisation, RealmReadiness

    supplied = arguments(bind_service, owner_world)
    if change == "unready":
        RealmReadiness.objects.filter(organisation_id=owner_world.organisation.id).update(
            revoked_at=__import__("django.utils.timezone", fromlist=["now"]).now()
        )
    elif change == "withdrawn_issuer":
        settings.KODERA_AUTH_TRUST = tuple(
            entry for entry in settings.KODERA_AUTH_TRUST if entry.lane == "staff"
        )
    elif change == "disabled_operator":
        Identity.objects.filter(id=owner_world.operator.id).update(enabled=False)
    elif change == "revoked_operator":
        from django.utils import timezone

        StaffRole.objects.filter(identity=owner_world.operator).update(revoked_at=timezone.now())
    elif change == "not_prospect":
        Organisation.objects.filter(id=owner_world.organisation.id).update(state="closed")
    elif change == "already_bound":
        bind_service.bind_intended_owner(**supplied)
    elif change == "wrong_subject":
        supplied["account_record"] = replace(
            supplied["account_record"], subject="different-subject"
        )
    elif change == "missing_link":
        settings.KODERA_OWNER_CLAIM_LINK = None
    else:
        settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "0"
    before = tables()
    with pytest.raises(bind_service.ClaimRefusedError):
        bind_service.bind_intended_owner(**supplied)
    assert tables() == before


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("stage", ["binding", "identity_audit", "claim", "delivery"])
def test_injected_failure_rolls_back_all_binding_effects(
    bind_service, owner_world, monkeypatch, stage
):
    from apps.orgs.models import OwnerBinding, OwnerClaim

    target, attribute = {
        "binding": (OwnerBinding.objects, "create"),
        "identity_audit": (bind_service, "record_owner_event"),
        "claim": (OwnerClaim.objects, "create"),
        "delivery": (bind_service, "enqueue_message"),
    }[stage]
    original = getattr(target, attribute)

    def crash(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("public synthetic post-write crash")

    monkeypatch.setattr(target, attribute, crash)
    before = tables()
    with pytest.raises(RuntimeError, match="public synthetic post-write crash"):
        bind_service.bind_intended_owner(**arguments(bind_service, owner_world))
    assert tables() == before


@pytest.mark.django_db(transaction=True)
def test_existing_exclusive_org_key_refuses_without_wait_or_leaked_hold(bind_service, owner_world):
    from django.db import connection

    from apps.jobs.kinds import Lock
    from apps.jobs.locks import held

    guard = connection.copy(alias="synthetic-owner-conflict")
    guard.ensure_connection()
    try:
        with guard.cursor() as cursor:
            cursor.execute(
                "SELECT pg_try_advisory_lock(1, hashtext(%s::text))",
                [str(owner_world.organisation.id)],
            )
            assert cursor.fetchone()[0]
        before = tables()
        with pytest.raises(bind_service.ClaimRefusedError, match="organisation_locked"):
            bind_service.bind_intended_owner(**arguments(bind_service, owner_world))
        assert tables() == before
        assert not held(Lock("organisation", owner_world.organisation.id, "exclusive"))
    finally:
        guard.close()


@pytest.mark.django_db(transaction=True)
def test_concurrent_bind_has_one_binding_claim_mail_and_releases_exclusive_hold(
    bind_service, owner_world, monkeypatch
):
    import threading

    from owner_claim_fixtures import finish_db_call, settle_db_calls, start_db_call

    from apps.jobs.kinds import Lock
    from apps.jobs.locks import held
    from apps.orgs.models import OwnerBinding, OwnerClaim
    from apps.outbox.models import OutboxMessage

    entered, release = threading.Event(), threading.Event()
    real_issue = bind_service._issue

    def held_issue(**kwargs):
        entered.set()
        assert release.wait(10)
        return real_issue(**kwargs)

    monkeypatch.setattr(bind_service, "_issue", held_issue)
    supplied = arguments(bind_service, owner_world)
    winner = start_db_call(lambda: bind_service.bind_intended_owner(**supplied))
    loser = None

    def rival():
        try:
            bind_service.bind_intended_owner(**supplied)
        except bind_service.ClaimRefusedError as refusal:
            return str(refusal)
        return "incorrectly admitted"

    try:
        assert entered.wait(10)
        loser = start_db_call(rival)
        assert loser[2] != winner[2]
        assert finish_db_call(loser) == "organisation_locked"
    finally:
        release.set()
        settle_db_calls(winner, loser)
    outcome = finish_db_call(winner)
    assert (
        OwnerBinding.objects.count()
        == OwnerClaim.objects.count()
        == OutboxMessage.objects.filter(template_id="owner_claim").count()
        == 1
    )
    assert OwnerClaim.objects.get().id == outcome.claim_id
    assert not held(Lock("organisation", owner_world.organisation.id, "exclusive"))


@pytest.mark.django_db(transaction=True)
def test_failed_bind_releases_operator_person_and_organisation_hold(
    bind_service, owner_world, monkeypatch
):
    from owner_claim_fixtures import finish_db_call, start_db_call

    from apps.identity.models import User
    from apps.jobs.kinds import Lock
    from apps.jobs.locks import held

    def crash(**kwargs):
        raise RuntimeError("public synthetic enqueue crash")

    monkeypatch.setattr(bind_service, "enqueue_message", crash)
    with pytest.raises(RuntimeError, match="public synthetic enqueue crash"):
        bind_service.bind_intended_owner(**arguments(bind_service, owner_world))
    assert not held(Lock("organisation", owner_world.organisation.id, "exclusive"))
    assert (
        finish_db_call(
            start_db_call(
                lambda: User.objects.filter(id=owner_world.operator.user_id).update(enabled=False)
            )
        )
        == 1
    )


@pytest.mark.django_db(transaction=True)
def test_existing_exact_issuer_subject_is_not_reassociated_or_found_by_contact(
    owner_world, bind_service
):
    from django.db import transaction

    from apps.identity.owner_binding import CreatedOwnerIdentity, create_owner_identity

    with transaction.atomic():
        existing = create_owner_identity(
            organisation_id=owner_world.organisation.id,
            issuer=owner_world.organisation.issuer,
            realm=owner_world.organisation.realm,
            subject="synthetic-intended-owner",
            contact="different.contact@customer.test",
            display_name=None,
        )
    assert type(existing) is CreatedOwnerIdentity
    assert not hasattr(existing, "save")
    before = tables()
    with pytest.raises(bind_service.ClaimRefusedError, match="already_bound"):
        bind_service.bind_intended_owner(**arguments(bind_service, owner_world))
    assert tables() == before


@pytest.mark.django_db(transaction=True)
def test_owned_creator_duplicate_and_wrong_issuer_fk_roll_back_fresh_person(owner_world):
    from django.db import IntegrityError, transaction

    from apps.identity.owner_binding import create_owner_identity

    supplied = dict(
        organisation_id=owner_world.organisation.id,
        issuer=owner_world.organisation.issuer,
        realm=owner_world.organisation.realm,
        subject="direct-public-subject",
        contact="public.owner@customer.test",
        display_name=None,
    )
    with transaction.atomic():
        created = create_owner_identity(**supplied)
    assert created.identity_id != created.user_id
    before = tables()
    for changes in (
        {},
        {
            "issuer": "https://different.customer.test/realms/wrong",
            "subject": "another-public-subject",
        },
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            create_owner_identity(**{**supplied, **changes})
        assert tables() == before
