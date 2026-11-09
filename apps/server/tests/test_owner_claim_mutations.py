"""Primitive controls must fail when their refusal or history rules are weakened."""

import base64
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from uuid import UUID

import pytest
from owner_claim_fixtures import owner_world as owner_world
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

ROOT = Path(__file__).resolve().parents[1]


def altered_module(name, before, after):
    source = (ROOT / "apps/orgs" / f"{name}.py").read_text()
    assert source.count(before) == 1, "mutation target must be exact"
    import sys
    from contextlib import nullcontext

    module = ModuleType("apps.orgs.owner_claim_mutation")
    module.__package__ = "apps.orgs"
    module.__dict__["nullcontext"] = nullcontext
    sys.modules[module.__name__] = module
    try:
        exec(  # noqa: S102 — exact finite local source mutation, no external input
            compile(source.replace(before, after), "<public-test-mutation>", "exec"),
            module.__dict__,
        )
    finally:
        del sys.modules[module.__name__]
    return module


def test_contact_control_detects_local_part_folding():
    from apps.orgs import claim_contact

    def control(module):
        assert module.normalise_contact("First.Owner@CUSTOMER.Test") == "First.Owner@customer.test"

    control(claim_contact)
    weakened = altered_module(
        "claim_contact", "{local}@{domain.lower()}", "{local.lower()}@{domain.lower()}"
    )
    with pytest.raises(AssertionError):
        control(weakened)


def test_token_control_detects_noncanonical_trailing_bits():
    from apps.orgs import claim_tokens

    claim_id = UUID("018f1234-5678-7abc-8def-0123456789ab")

    def control(module):
        assert module.claim_id_for_token(f"oc1_{claim_id}_" + "A" * 42 + "B") is None

    control(claim_tokens)
    weakened = altered_module(
        "claim_tokens",
        'len(raw) != 32 or base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != secret',
        "len(raw) != 32",
    )
    with pytest.raises(AssertionError):
        control(weakened)


def test_terminal_history_control_detects_expiring_every_state():
    from apps.orgs import claim_readiness

    now = datetime(2000, 1, 1, tzinfo=UTC)

    def control(module):
        for state in ("consumed", "revoked", "expired"):
            assert module.expiry_transition_for(state, expires_at=now, now=now) == state

    control(claim_readiness)
    weakened = altered_module(
        "claim_readiness", 'state == "issued" and expires_at <= now', "expires_at <= now"
    )
    with pytest.raises(AssertionError):
        control(weakened)


def test_whole_token_control_detects_locator_substitution():
    from apps.orgs import claim_tokens

    first = UUID("018f1234-5678-7abc-8def-0123456789ab")
    second = UUID("018f1234-5678-7abc-8def-0123456789ac")
    secret = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")

    def control(module):
        verifier = module.hash_claim_secret(module.format_claim_token(first, secret))
        assert not module.verify_claim_secret(module.format_claim_token(second, secret), verifier)

    control(claim_tokens)
    weakened = altered_module("claim_tokens", "_HASHER.hash(secret)", "_HASHER.hash(secret[41:])")
    weakened.verify_claim_secret = lambda value, verifier: claim_tokens.verify_claim_secret(
        value[41:], verifier
    )
    with pytest.raises(AssertionError):
        control(weakened)


def test_parameter_guard_control_detects_unbounded_verification():
    from unittest.mock import patch

    from apps.orgs import claim_tokens

    secret = "public verifier guard vector".ljust(43, "-")
    hostile = claim_tokens.hash_claim_secret(secret).replace(b"m=65536", b"m=2147483647")

    def control(module):
        with patch.object(type(module._HASHER), "verify", return_value=True) as expensive:
            assert not module.verify_claim_secret(secret, hostile)
            expensive.assert_not_called()

    control(claim_tokens)
    weakened = altered_module(
        "claim_tokens",
        'if extract_parameters(verifier.decode("ascii")) != RFC_9106_LOW_MEMORY:',
        "if False:",
    )
    with pytest.raises(AssertionError):
        control(weakened)


@pytest.mark.django_db(transaction=True)
def test_nullable_consumer_guard_mutation_detects_forbidden_consumption(owner_world):
    from django.db import connection, transaction
    from django.utils import timezone
    from owner_claim_fixtures import bind

    from apps.identity.models import Identity
    from apps.orgs.models import Membership, Organisation, OwnerClaim

    first = OwnerClaim.objects.get(id=bind(owner_world).claim_id)
    intended = Identity.objects.get(id=first.intended_identity_id)
    with pytest.raises(AssertionError, match="NULL consumer was admitted"), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='orgs_ownerclaim'::regclass AND conname='owner_claim_terminal_fields_valid'"
            )
            definition = cursor.fetchone()[0]
            clause = "(consumed_by_identity_id IS NOT NULL)"
            assert definition.count(clause) == 1, "exact NULL guard mutation target missing"
            weakened = definition.replace(clause, "TRUE")
            cursor.execute(
                "ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_terminal_fields_valid"
            )
            cursor.execute(
                "ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_terminal_fields_valid "
                + weakened
            )  # noqa: S608 — fixed owned table, original database definition and exact finite mutation
        member = Membership.objects.create(
            user_id=intended.user_id,
            organisation_id=first.organisation_id,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Organisation.objects.filter(id=first.organisation_id).update(state="active")
        OwnerClaim.objects.filter(id=first.id).update(
            state="consumed",
            consumed_at=timezone.now(),
            consumed_by_identity_id=None,
            membership_id=member.id,
        )
        assert not OwnerClaim.objects.filter(
            id=first.id, state="consumed", consumed_by_identity_id__isnull=True
        ).exists(), "NULL consumer was admitted"
    # The assertion rolls back the temporary constraint and forbidden effect together.
    first.refresh_from_db()
    assert first.state == "issued"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("guard", ("contact", "prospect", "current_operator"))
def test_atomic_binding_refusal_controls_detect_actual_forbidden_writes(owner_world, guard):
    from django.utils import timezone
    from owner_claim_fixtures import arguments, written

    from apps.identity.models import StaffRole
    from apps.orgs import owner_claims
    from apps.orgs.models import Organisation

    before_text, after_text = {
        "contact": ("if recipient != supplied:", "if False:"),
        "prospect": (
            'organisation.state != "prospect" or not realm_ready(organisation_id=organisation.id)',
            "not realm_ready(organisation_id=organisation.id)",
        ),
        "current_operator": ("with operator_authorization(principal):", "with nullcontext():"),
    }[guard]
    if guard == "prospect":
        Organisation.objects.filter(id=owner_world.organisation.id).update(state="closed")
    elif guard == "current_operator":
        StaffRole.objects.filter(identity=owner_world.operator).update(revoked_at=timezone.now())

    def control(module):
        supplied = arguments(owner_world)
        supplied["account_record"] = module.AccountCreationRecord(
            **{
                name: getattr(supplied["account_record"], name)
                for name in ("issuer", "subject", "credential_created", "evidence_ref")
            }
        )
        if guard == "contact":
            supplied["contact"] = "First.owner@customer.test"
        baseline = written()
        try:
            module.bind_intended_owner(**supplied)
        except module.ClaimRefusedError:
            pass
        assert written() == baseline, "weakened binding guard admitted forbidden writes"

    control(owner_claims)
    weakened = altered_module("owner_claims", before_text, after_text)
    with pytest.raises(AssertionError, match="weakened binding guard admitted forbidden writes"):
        control(weakened)
