"""Owned synthetic HTTP fixtures; real signatures and persisted rows only."""

import importlib
import json
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import Client
from django.urls import Resolver404, resolve
from django.utils import timezone
from test_access_tokens import NOW, claims, sign
from test_customer_persistence_models import anchor, anchor_models, identity, raw_update

from config.environment import allowed_oidc_client_ids

ROOT = Path(__file__).resolve().parents[1]
ME = "/api/v1/me"
PROBLEMS = "https://kodera.io/problems/"


def require_route():
    try:
        return resolve(ME)
    except Resolver404:
        raise AssertionError("customer GET /api/v1/me is not routed") from None


def trust_module():
    assert (ROOT / "services/identity/trusted_issuers.py").is_file(), (
        "finite public trust loader is not implemented"
    )
    return importlib.import_module("services.identity.trusted_issuers")


def trust_entry(signer, issuer, *, lane="customer", expires_at=NOW + 600):
    return {
        "lane": lane,
        "issuer": issuer,
        "generation": "owned-http-fixture",
        "expires_at": expires_at,
        "public_jwks": {"keys": [signer[2]]},
    }


def configure(settings, entries):
    # The trust a process started with KODERA_CONSOLE_CLIENT_ID=synthetic-console resolves: the
    # default clients plus that console (config.environment.allowed_oidc_client_ids).
    allowed = allowed_oidc_client_ids({"KODERA_CONSOLE_CLIENT_ID": "synthetic-console"})
    settings.KODERA_AUTH_TRUST = trust_module().load_trust(json.dumps(entries), allowed_azp=allowed)


def token(signer, issuer, subject="same-opaque-subject", **changes):
    return sign(signer, claims(iss=issuer, sub=subject, **changes))


def request(client, credential=None, **headers):
    if credential is not None:
        headers["HTTP_AUTHORIZATION"] = "Bearer " + credential
    return client.get(ME, **headers)


def safe_problem(response, status, kind, *, sentinels=()):
    assert response.status_code == status, "customer denial returned the wrong HTTP status"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Content-Type"].split(";")[0] == "application/problem+json"
    body = response.json()
    assert body["status"] == status and body["type"] == PROBLEMS + kind
    assert body["request_id"] == response.headers["X-Request-Id"]
    assert not {"identities", "organisations", "email", "subject"}.intersection(body)
    if any(value in response.content.decode() for value in sentinels):
        pytest.fail("sensitive sentinel appeared in a customer denial")
    if status == 401:
        assert response.headers["WWW-Authenticate"].startswith("Bearer")
    else:
        assert "WWW-Authenticate" not in response.headers, "a non-401 denial carries a challenge"
    return body


@pytest.fixture(scope="module")
def http_signer():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="same-owned-kid", alg="RS256", use="sig", key_ops=["verify"])
    return key, "RS256", public


@pytest.fixture
def http_world(transactional_db, settings, http_signer):
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    models = anchor_models()
    first, _, _ = anchor(models, slug="alpha")
    second, _, _ = anchor(models, slug="bravo")
    person = models.User.objects.create(email="first-person@customer.test", display_name="First")
    other = models.User.objects.create(email="other-person@customer.test", display_name="Other")
    current = identity(models, first, person, subject="same-opaque-subject")
    unrelated = identity(models, second, other, subject="same-opaque-subject")
    memberships = []
    for user, organisation in ((person, first), (other, second)):
        memberships.append(
            models.Membership.objects.create(
                user=user,
                organisation=organisation,
                role="org_member",
                state="active",
                accepted_at=timezone.now(),
            )
        )
    configure(
        settings, [trust_entry(http_signer, first.issuer), trust_entry(http_signer, second.issuer)]
    )
    return SimpleNamespace(
        models=models,
        first=first,
        second=second,
        person=person,
        other=other,
        current=current,
        unrelated=unrelated,
        member=memberships[0],
        other_member=memberships[1],
        credential=token(http_signer, first.issuer),
        other_credential=token(http_signer, second.issuer),
        client=Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"),
    )


def soft_delete(item):
    now = timezone.now()
    raw_update(item, deleted_at=now, purge_after=now + timedelta(days=1))


def rows(models):
    return {
        name: list(model._base_manager.order_by("id").values())
        for name, model in vars(models).items()
    }
