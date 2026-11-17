"""Real local-store composition; external receipt controls are synthetic, not provider proof."""

import importlib
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from django.db import connection, transaction
from test_account_erasure import AccountControlAdapter
from test_core_erasure import ControlledAdapter, operator
from test_e2ee_relay import admit_peer, relay as relay, world as world
from test_e2ee_relay_privacy import account_cutoff, foreign_device
from test_proximity_erasure import presence, private_broker

from apps.e2ee.models import Device, Envelope
from apps.identity.models import Identity
from apps.orgs.account_erasure_services import advance_account_erasure
from apps.orgs.erasure_services import advance_erasure, begin_erasure, database_now
from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
from apps.proximity.erasure import ProximityAccountErasureAdapter, ProximityWorkspaceErasureAdapter

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def optional_enterprise_source(monkeypatch):
    """Admit the local optional package for this integration test only."""
    previous = {name for name in sys.modules if name == "ee" or name.startswith("ee.")}
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3]))
    yield
    # Preserve Community absence checks in later randomly ordered test modules.
    for name in set(sys.modules) - previous:
        if name == "ee" or name.startswith("ee."):
            del sys.modules[name]


def seed_ee_person(org, user):
    identifier = uuid4()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO ee_scim_user(id,organisation_id,user_id,tenant_slug,user_name,"
            "user_name_lower,external_id,display_name,given_name,family_name,emails_json,"
            "active,roles_json,department,member_state,version,created_at,updated_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,NULL,'Synthetic Person','','','[]',true,'[]',NULL,"
            "'active',1,clock_timestamp(),clock_timestamp())",
            [identifier, org.id, user.id, org.slug, user.email, user.email.lower()],
        )
        cursor.execute(
            "INSERT INTO ee_scim_session(organisation_id,scim_user_id,user_id,tenant_slug,session_id) VALUES(%s,%s,%s,%s,%s)",
            [org.id, identifier, user.id, org.slug, str(uuid4())],
        )
    return identifier


def ee_exists(identifier):
    with connection.cursor() as cursor:
        cursor.execute("SELECT EXISTS(SELECT 1 FROM ee_scim_user WHERE id=%s)", [identifier])
        return cursor.fetchone()[0]


def seed_owned_po(relay):
    # Optional Enterprise code is resolved only in this explicit integration fixture.
    billing = importlib.import_module("ee.billing.api")

    from apps.orgs.models import Membership

    org, _, members, tokens = relay[:4]
    Membership.objects.filter(pk=members[2].id).update(role="org_billing")
    identity = Identity.objects.get(organisation=org, user_id=members[2].user_id)
    principal = billing.BillingPrincipal(
        lane="customer",
        identity_id=str(identity.id),
        user_id=str(identity.user_id),
        issuer=identity.issuer,
        subject=tokens[2].subject,
        org_roles={str(org.id): "org_billing"},
        live_authority=True,
    )
    router = billing.EnterpriseBillingRouter(authenticator=lambda _headers: principal)
    env = {"KODERA_EDITION": "enterprise"}
    created = router.dispatch(
        "POST",
        "/api/v1/ee/billing/purchase-orders",
        body=json.dumps(
            {
                "organisation_id": str(org.id),
                "customer_po_reference": "BDC-COMBINED-ONLY",
                "plan_code": "sovereign",
                "billing_months": 12,
                "committed_seats": 30,
                "committed_storage_gb": 100,
                "subtotal_excl_vat_minor": 500000,
            }
        ).encode(),
        headers={},
        environ=env,
    )
    assert created.status_code == 201, created.content
    identifier = created.json()["po_id"]
    for payload in (
        {"action": "issue"},
        {"action": "countersign", "signatory": "Synthetic Plain Name"},
    ):
        response = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{identifier}/transitions",
            body=json.dumps(payload).encode(),
            headers={},
            environ=env,
        )
        assert response.status_code == 200, response.content
        assert "countersigned_by_user_id" not in response.json()
    return identifier


def seed_passport(org, user, key):
    from datetime import timedelta

    from apps.identity.models import PassportMagicLinkToken, PassportOutboxBinding
    from apps.identity.passport import generate_magic_link_token
    from core.db.ids import new_uuid7
    from core.passport import enqueue_passport_magic_link

    raw, digest = generate_magic_link_token()
    delivery = new_uuid7()
    now = database_now()
    with transaction.atomic():
        PassportOutboxBinding.objects.create(
            delivery_id=delivery, user_id=user.id, organisation_id=org.id, created_at=now
        )
        enqueue_passport_magic_link(
            seal_key=key,
            link="https://app.localhost/passport/verify",
            organisation_id=org.id,
            organisation_name=org.name,
            recipient=user.email,
            raw_token=raw,
            expires_at=now + timedelta(minutes=10),
            delivery_id=delivery,
        )
        token = PassportMagicLinkToken.objects.create(
            token_sha256=digest,
            user_id=user.id,
            delivery_id=delivery,
            email_normalized=user.email.lower(),
            domain_normalized=user.email.rsplit("@", 1)[1],
            code_challenge="A" * 43,
            code_challenge_method="S256",
            expires_at=now + timedelta(minutes=10),
        )
    return token.pk


@pytest.mark.parametrize("kind", ["account", "organisation"])
def test_local_ee_passport_po_broker_and_relay_share_one_cutoff_and_preserve_sibling(
    relay, settings, kind
):
    from apps.identity.models import PassportMagicLinkToken
    from apps.orgs.privacy_models import AccountErasure, PrivacyErasure

    org, workspace, members = relay[:3]
    po = seed_owned_po(relay)
    admit_peer(relay)
    target = Identity.objects.get(organisation=org, user_id=members[2].user_id)
    sibling = foreign_device()
    local_ee = seed_ee_person(org, members[2].user)
    sibling_ee = seed_ee_person(sibling.organisation, sibling.membership.user)
    key = os.urandom(32)
    settings.KODERA_OUTBOX_SEAL_KEY = key
    target_token = seed_passport(org, members[2].user, key)
    sibling_token = seed_passport(sibling.organisation, sibling.membership.user, key)
    with private_broker() as (broker, gateway, _):
        presence(broker, workspace.id, target.id, 17)
        presence(broker, sibling.organisation_id, sibling.identity_id, 18)
        if kind == "account":
            row = account_cutoff(relay, 2)
            advance = advance_account_erasure
            adapter = ProximityAccountErasureAdapter(gateway)
            controls = {
                d: AccountControlAdapter(d)
                for d in row.inventory["required_domains"]
                if d not in {"proximity_ephemeral", "account_message_outbox"}
            }
            controls["account_message_outbox"] = PassportAccountOutboxErasureAdapter()
        else:
            row = begin_erasure(
                organisation_id=org.id,
                instruction_ref="DEL-490",
                instruction_sha256="7" * 64,
                purge_not_before=database_now(),
                actor_identity_id=operator().id,
            )
            advance = advance_erasure
            adapter = ProximityWorkspaceErasureAdapter(gateway)
            controls = {
                d: ControlledAdapter(d)
                for d in row.inventory["required_domains"]
                if d != "proximity_ephemeral"
            }
        assert row.inventory["proximity_inventory_version"] == 1
        assert len(row.inventory["required_domains"]) == 6
        assert "e2ee" in row.inventory
        held = advance(row.id, controls)
        assert not held["complete"] and held["held_domains"] == ["proximity_ephemeral"]
        assert gateway.inspect_account(identity_ids=[str(target.id)])["remaining_records"] == 1
        assert not ee_exists(local_ee) and ee_exists(sibling_ee)
        assert not PassportMagicLinkToken.objects.filter(pk=target_token).exists()
        assert PassportMagicLinkToken.objects.filter(pk=sibling_token).exists()
        assert Device.objects.filter(pk=sibling.id, revoked_at__isnull=True).exists()
        if kind == "account":
            assert Device.objects.get(pk=relay[5][2]).revoked_at is not None
        else:
            assert not Envelope.objects.filter(organisation=org).exists()
        controls["proximity_ephemeral"] = adapter
        complete = advance(row.id, controls)
        assert complete["complete"] and not complete["held_domains"]
        journal = (AccountErasure if kind == "account" else PrivacyErasure).objects.get(pk=row.id)
        assert complete["counts"] == journal.counts
        assert advance(row.id, controls)["counts"] == complete["counts"]
        assert gateway.inspect_account(identity_ids=[str(target.id)]) == {
            "remaining_records": 0,
            "remaining_replay_bindings": 0,
        }
        assert (
            gateway.inspect_account(identity_ids=[str(sibling.identity_id)])["remaining_records"]
            == 1
        )
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT countersigned_by,countersigned_by_user_id,total_incl_vat_minor FROM ee_billing_purchase_orders WHERE po_id=%s",
                [po],
            )
            label, owner, total = cursor.fetchone()
        assert owner is None and label.startswith("erased") and total > 0
