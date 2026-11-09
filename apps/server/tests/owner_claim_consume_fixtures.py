"""Actual issued-claim setup; synthetic verified facts are not provider MFA proof."""

import time
from dataclasses import replace

import pytest
from django.test import RequestFactory
from owner_claim_fixtures import bind, owner_world as owner_world
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.orgs.models import OwnerClaim
from apps.outbox.mail.seal import unseal
from apps.outbox.models import OutboxMessage
from services.identity.access_tokens import VerifiedAccessToken


@pytest.fixture
def issued_owner(owner_world, settings):
    return issue_owner(owner_world, settings)


def issue_owner(owner_world, settings):
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    outcome = bind(owner_world)
    claim = OwnerClaim.objects.get(id=outcome.claim_id)
    message = OutboxMessage.objects.get(delivery_id=outcome.delivery_id)
    delivered = unseal(settings.KODERA_OUTBOX_SEAL_KEY, outcome.delivery_id, bytes(message.sealed))
    now = int(time.time())
    verified = VerifiedAccessToken(
        issuer=owner_world.organisation.issuer,
        subject="synthetic-intended-owner",
        audience=("kodera-server",),
        issued_at=now,
        expires_at=now + 300,
        not_before=None,
        amr=("pwd", "otp"),
        acr=None,
        auth_time=now,
        email_verified=True,
        authorized_party="synthetic-console",
        mfa_enrolled=True,
    )
    return owner_world, claim, delivered.secret, verified


def call_consume(issued, *, key="consume-public-key-0001", payload=None, facts=None):
    import json

    from apps.orgs.api.owner_claims import consume_request

    _, _, token, verified = issued
    request = RequestFactory().post(
        "/api/v1/owner-claims/actions/consume",
        data=json.dumps({"token": token} if payload is None else payload),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    return consume_request(
        request,
        verified=replace(verified, **(facts or {})),
        lane="customer",
        request_id="consume-public-request-1",
    )


def post_consume(issued, *, key="consume-public-key-0001", payload=None, facts=None, omit=()):
    import json
    import time

    from customer_http_fixtures import token
    from django.test import Client

    world, _, secret, verified = issued
    now = int(time.time())
    claims = {
        "iat": now,
        "exp": now + 300,
        "auth_time": now,
        "amr": ["pwd", "otp"],
        "email_verified": True,
        "azp": "synthetic-console",
        "kodera_mfa_enrolled": True,
    }
    claims.update(facts or {})
    for name in omit:
        claims.pop(name)
    credential = token(world.signer, verified.issuer, verified.subject, **claims)
    return Client().post(
        "/api/v1/owner-claims/actions/consume",
        data=json.dumps({"token": secret} if payload is None else payload),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credential,
        HTTP_IDEMPOTENCY_KEY=key,
    )
