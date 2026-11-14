"""Kodera Passport cross-workspace magic-link sign-in and workspace switcher against PostgreSQL.

Covers:
- `POST /api/v1/auth/passport/magic-link/request`: enumerator-safe constant `202 Accepted` shape,
  domain/email normalization, 32-byte CSPRNG raw token never leaked on the wire, SHA-256 hash at
  rest, RFC 7636 S256 PKCE + optional device challenge validation, and IP/email rate limits.
- `POST /api/v1/auth/passport/magic-link/verify`: atomic `SELECT ... FOR UPDATE` single-use burn,
  replay refusal (`401`), expiry refusal (`> 10 min`), wrong PKCE/device verifier burn + refusal,
  and cross-organisation workspace directory across one realm per organisation.
- `GET /api/v1/auth/passport/workspaces` & `POST /api/v1/auth/passport/switch-workspace`:
  works with both `kp1.` Passport session tokens and OIDC customer Bearer tokens, filters out
  kicked/banned workspace memberships and non-active organisations, persists active workspace
  context, writes `auth.login_succeeded`, and refuses non-member switches with `403 forbidden`
  + `authz.denied` audit record.
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import connection
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import anchor, anchor_models, identity

from apps.identity.models import (
    PassportMagicLinkToken,
    PassportRateLimitEvent,
    PassportWorkspaceContext,
)
from apps.identity.passport import PassportMagicLinkDelivery
from apps.workspaces.models import Workspace, WorkspaceMemberRestriction
from core.passport import compute_pkce_s256, hash_magic_link_token

pytestmark = pytest.mark.django_db(transaction=True)

REQUEST_URL = "/api/v1/auth/passport/magic-link/request"
VERIFY_URL = "/api/v1/auth/passport/magic-link/verify"
WORKSPACES_URL = "/api/v1/auth/passport/workspaces"
SWITCH_URL = "/api/v1/auth/passport/switch-workspace"

PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
PKCE_CHALLENGE = compute_pkce_s256(PKCE_VERIFIER)
DEVICE_VERIFIER = "device-secret-challenge-0001"


@pytest.fixture
def passport_world(settings, http_signer):  # noqa: F811
    deliveries: list[PassportMagicLinkDelivery] = []
    settings.KODERA_PASSPORT_HMAC_KEY = "passport-test-hmac-secret-32bytes-minimum!!"
    settings.KODERA_PASSPORT_DELIVERY_SINK = deliveries.append
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"

    models = anchor_models()
    org_alpha, _, _ = anchor(models, slug="alpha-org")
    org_bravo, _, _ = anchor(models, slug="bravo-org")
    org_outsider, _, _ = anchor(models, slug="outsider-org")
    org_suspended, _, _ = anchor(models, slug="suspended-org", state="suspended")

    person = models.User.objects.create(
        email="camille.laurent@acme.fr",
        display_name="Camille Laurent",
    )
    id_alpha = identity(models, org_alpha, person, subject="camille-alpha-sub")
    id_bravo = identity(models, org_bravo, person, subject="camille-bravo-sub")
    identity(models, org_suspended, person, subject="camille-suspended-sub")

    now = timezone.now()
    mem_alpha = models.Membership.objects.create(
        user=person,
        organisation=org_alpha,
        role="org_owner",
        state="active",
        accepted_at=now,
    )
    mem_bravo = models.Membership.objects.create(
        user=person,
        organisation=org_bravo,
        role="org_admin",
        state="active",
        accepted_at=now,
    )
    models.Membership.objects.create(
        user=person,
        organisation=org_suspended,
        role="org_member",
        state="active",
        accepted_at=now,
    )

    ws_alpha = Workspace.objects.create(organisation=org_alpha)
    ws_bravo = Workspace.objects.create(organisation=org_bravo)

    configure(
        settings,
        [
            trust_entry(http_signer, org_alpha.issuer),
            trust_entry(http_signer, org_bravo.issuer),
            trust_entry(http_signer, org_outsider.issuer),
        ],
    )

    return SimpleNamespace(
        client=Client(),
        deliveries=deliveries,
        models=models,
        person=person,
        org_alpha=org_alpha,
        org_bravo=org_bravo,
        org_outsider=org_outsider,
        org_suspended=org_suspended,
        id_alpha=id_alpha,
        id_bravo=id_bravo,
        mem_alpha=mem_alpha,
        mem_bravo=mem_bravo,
        ws_alpha=ws_alpha,
        ws_bravo=ws_bravo,
        signer=http_signer,
    )


def _post_json(client: Client, url: str, payload: object, **headers: Any):
    return client.post(
        url,
        data=json.dumps(payload).encode("utf-8"),
        content_type="application/json",
        **headers,
    )


def _audit_rows(action: str) -> list[tuple[str, str | None, str | None, dict, str | None]]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT action, actor_id::text, organisation_id::text, metadata, target_urn"
            " FROM audit_auditevent WHERE action = %s ORDER BY occurred_at, id",
            [action],
        )
        return [
            (
                row[0],
                row[1],
                row[2],
                row[3] if isinstance(row[3], dict) else json.loads(row[3]),
                row[4],
            )
            for row in cursor.fetchall()
        ]


def test_magic_link_request_is_enumerator_safe_normalizes_email_and_hashes_token_at_rest(
    passport_world,
):
    w = passport_world

    # Existing user with mixed-case email + whitespace
    res_known = _post_json(
        w.client,
        REQUEST_URL,
        {
            "email": "  Camille.Laurent@ACME.FR ",
            "code_challenge": PKCE_CHALLENGE,
            "code_challenge_method": "S256",
        },
    )
    # Non-existent user
    res_unknown = _post_json(
        w.client,
        REQUEST_URL,
        {
            "email": "nobody.never@unknown-domain.fr",
            "code_challenge": PKCE_CHALLENGE,
            "code_challenge_method": "S256",
        },
    )

    assert res_known.status_code == 202
    assert res_unknown.status_code == 202
    assert res_known.json() == {"status": "accepted", "expires_in_seconds": 600}
    assert res_unknown.json() == {"status": "accepted", "expires_in_seconds": 600}
    assert res_known.headers["Cache-Control"] == "no-store"

    # Delivery sink fired ONLY for the existing user, never leaking raw token in HTTP body
    assert len(w.deliveries) == 1
    delivery = w.deliveries[0]
    assert delivery.email_normalized == "camille.laurent@acme.fr"
    assert delivery.raw_token not in res_known.content.decode("utf-8")

    # Raw token decodes to 32 CSPRNG bytes (43 base64url chars without padding)
    assert len(delivery.raw_token) == 43
    raw_bytes = base64.urlsafe_b64decode(delivery.raw_token + "=")
    assert len(raw_bytes) == 32

    # At rest, only the 64-hex SHA-256 digest is stored
    stored = PassportMagicLinkToken.objects.get(email_normalized="camille.laurent@acme.fr")
    assert stored.domain_normalized == "acme.fr"
    assert stored.token_sha256 == hashlib.sha256(delivery.raw_token.encode("ascii")).hexdigest()
    assert stored.token_sha256 == hash_magic_link_token(delivery.raw_token)
    assert stored.consumed_at is None
    assert PassportMagicLinkToken.objects.filter(
        email_normalized="nobody.never@unknown-domain.fr"
    ).exists()


def test_magic_link_request_input_guards_and_rate_limits(passport_world, settings):
    w = passport_world

    # Unsupported media type -> 415
    res_415 = w.client.post(REQUEST_URL, data=b"{}", content_type="text/plain")
    assert res_415.status_code == 415

    # Payload too large -> 413
    res_413 = w.client.post(REQUEST_URL, data=b"x" * 5000, content_type="application/json")
    assert res_413.status_code == 413

    # Duplicate JSON key -> 400
    res_dup = w.client.post(
        REQUEST_URL,
        data=b'{"email":"a@b.fr","email":"c@d.fr","code_challenge":"'
        + PKCE_CHALLENGE.encode()
        + b'"}',
        content_type="application/json",
    )
    assert res_dup.status_code == 400

    # Invalid PKCE challenge -> 422
    res_422 = _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": "too-short"},
    )
    assert res_422.status_code == 422
    assert res_422.json()["errors"] == [
        {"pointer": "/code_challenge", "code": "invalid-code-challenge"}
    ]

    # Per-email rate limit -> 429 with Retry-After
    settings.KODERA_PASSPORT_EMAIL_RATE_LIMIT = 2
    settings.KODERA_PASSPORT_IP_RATE_LIMIT = 10
    PassportRateLimitEvent.objects.all().delete()

    for _ in range(2):
        ok = _post_json(
            w.client,
            REQUEST_URL,
            {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
        )
        assert ok.status_code == 202

    limited = _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    assert limited.json()["type"] == "https://kodera.io/problems/rate-limited"


def test_magic_link_verify_establishes_cross_workspace_session_and_rejects_replay(passport_world):
    w = passport_world

    req = _post_json(
        w.client,
        REQUEST_URL,
        {
            "email": "camille.laurent@acme.fr",
            "code_challenge": PKCE_CHALLENGE,
            "code_challenge_method": "S256",
            "device_challenge": DEVICE_VERIFIER,
        },
    )
    assert req.status_code == 202
    raw_token = w.deliveries[-1].raw_token

    verified = _post_json(
        w.client,
        VERIFY_URL,
        {
            "token": raw_token,
            "code_verifier": PKCE_VERIFIER,
            "device_verifier": DEVICE_VERIFIER,
        },
    )
    assert verified.status_code == 200
    body = verified.json()
    assert body["user"] == {
        "id": str(w.person.id),
        "email": "camille.laurent@acme.fr",
        "display_name": "Camille Laurent",
    }
    assert body["session_token"].startswith("kp1.")
    assert body["expires_in_seconds"] == 3600

    # Suspended organisation is excluded; alpha-org and bravo-org (ordered by slug) are returned
    slugs = [entry["organisation_slug"] for entry in body["workspaces"]]
    assert slugs == ["alpha-org", "bravo-org"]
    assert body["active_organisation_id"] == str(w.org_alpha.id)
    assert body["active_workspace_id"] == str(w.ws_alpha.id)
    assert body["workspaces"][0]["active"] is True
    assert body["workspaces"][1]["active"] is False

    # Audit event auth.login_succeeded written
    logins = _audit_rows("auth.login_succeeded")
    assert len(logins) == 1
    assert logins[0][2] == str(w.org_alpha.id)
    assert logins[0][3] == {
        "amr": ["magic_link", "pkce", "device"],
        "realm": w.org_alpha.realm,
    }

    # Single-use burn: immediate replay of the exact same token + verifier MUST return 401
    replay = _post_json(
        w.client,
        VERIFY_URL,
        {
            "token": raw_token,
            "code_verifier": PKCE_VERIFIER,
            "device_verifier": DEVICE_VERIFIER,
        },
    )
    assert replay.status_code == 401
    assert replay.headers["WWW-Authenticate"] == "Bearer"


def test_magic_link_verify_rejects_expired_token_and_burns_on_wrong_pkce_verifier(passport_world):
    w = passport_world

    # 1. Expired token (> 10 min) -> 401
    _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    expired_raw = w.deliveries[-1].raw_token
    PassportMagicLinkToken.objects.filter(token_sha256=hash_magic_link_token(expired_raw)).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )

    res_expired = _post_json(
        w.client,
        VERIFY_URL,
        {"token": expired_raw, "code_verifier": PKCE_VERIFIER},
    )
    assert res_expired.status_code == 401

    # 2. Wrong PKCE code_verifier -> 401 AND burns token so follow-up with valid verifier is 401
    _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    fresh_raw = w.deliveries[-1].raw_token

    wrong_verifier = "A" * 43
    res_wrong = _post_json(
        w.client,
        VERIFY_URL,
        {"token": fresh_raw, "code_verifier": wrong_verifier},
    )
    assert res_wrong.status_code == 401

    res_retry = _post_json(
        w.client,
        VERIFY_URL,
        {"token": fresh_raw, "code_verifier": PKCE_VERIFIER},
    )
    assert res_retry.status_code == 401


@pytest.mark.usefixtures("frozen_clock")
def test_workspaces_and_switch_workspace_enforce_membership_and_moderation_boundaries(
    passport_world,
):
    w = passport_world

    # Issue Passport session via magic-link verify
    _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    verified = _post_json(
        w.client,
        VERIFY_URL,
        {"token": w.deliveries[-1].raw_token, "code_verifier": PKCE_VERIFIER},
    )
    session_token = verified.json()["session_token"]

    # 1. GET /auth/passport/workspaces with kp1. session token
    dir_res = w.client.get(
        WORKSPACES_URL,
        HTTP_AUTHORIZATION=f"Bearer {session_token}",
    )
    assert dir_res.status_code == 200
    assert [e["organisation_slug"] for e in dir_res.json()["workspaces"]] == [
        "alpha-org",
        "bravo-org",
    ]

    # 2. POST /auth/passport/switch-workspace to bravo-org succeeds and updates persisted context
    sw_res = _post_json(
        w.client,
        SWITCH_URL,
        {"organisation_id": str(w.org_bravo.id)},
        HTTP_AUTHORIZATION=f"Bearer {session_token}",
    )
    assert sw_res.status_code == 200
    sw_body = sw_res.json()
    assert sw_body["active_organisation_id"] == str(w.org_bravo.id)
    assert sw_body["active_workspace_id"] == str(w.ws_bravo.id)
    assert sw_body["workspace"]["organisation_slug"] == "bravo-org"
    assert sw_body["workspace"]["role"] == "org_admin"
    assert sw_body["session_token"].startswith("kp1.")

    ctx = PassportWorkspaceContext.objects.get(user_id=w.person.id)
    assert ctx.active_organisation_id == w.org_bravo.id
    assert ctx.active_workspace_id == w.ws_bravo.id

    # 3. Switching to an organisation where caller is NOT a member returns 403 + authz.denied
    forbidden = _post_json(
        w.client,
        SWITCH_URL,
        {"organisation_id": str(w.org_outsider.id)},
        HTTP_AUTHORIZATION=f"Bearer {sw_body['session_token']}",
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["type"] == "https://kodera.io/problems/forbidden"
    assert "WWW-Authenticate" not in forbidden.headers

    denials = _audit_rows("authz.denied")
    assert len(denials) == 1
    assert denials[0][2] == str(w.org_bravo.id)
    assert denials[0][3] == {"required_scope": "identity:act", "reason": "role_missing"}
    assert denials[0][4] == "urn:kodera:organisation:outsider-org"

    # 4. Works with OIDC customer Bearer token too, and omits workspace_id when banned/kicked
    WorkspaceMemberRestriction.objects.create(
        workspace=w.ws_bravo,
        membership=w.mem_bravo,
        banned=True,
    )
    oidc_bearer = token(w.signer, w.org_alpha.issuer, subject="camille-alpha-sub")
    oidc_dir = w.client.get(
        WORKSPACES_URL,
        HTTP_AUTHORIZATION=f"Bearer {oidc_bearer}",
    )
    assert oidc_dir.status_code == 200
    by_slug = {e["organisation_slug"]: e for e in oidc_dir.json()["workspaces"]}
    assert by_slug["alpha-org"]["workspace_id"] == str(w.ws_alpha.id)
    assert by_slug["bravo-org"]["workspace_id"] is None
