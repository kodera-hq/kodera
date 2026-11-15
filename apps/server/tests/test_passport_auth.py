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


def test_magic_link_request_fails_closed_503_without_sink_or_outbox_seal_key(
    passport_world,
    settings,
):
    """Production guard: when neither an explicit delivery sink nor `KODERA_OUTBOX_SEAL_KEY` +
    allowed magic-link URL is configured, `POST /auth/passport/magic-link/request` fails closed
    with `503 service-unavailable` (`Retry-After: 30`) BEFORE charging rate limits or writing
    undeliverable `PassportMagicLinkToken` rows."""
    w = passport_world
    settings.KODERA_PASSPORT_DELIVERY_SINK = None
    settings.KODERA_OUTBOX_SEAL_KEY = None
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_PASSPORT_MAGIC_LINK = None
    PassportMagicLinkToken.objects.all().delete()
    PassportRateLimitEvent.objects.all().delete()

    res_no_key = _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    assert res_no_key.status_code == 503
    assert res_no_key.headers["Retry-After"] == "30"
    assert res_no_key.json()["type"] == "https://kodera.io/problems/service-unavailable"
    assert PassportMagicLinkToken.objects.count() == 0
    assert PassportRateLimitEvent.objects.count() == 0

    # Even with a valid 32-byte seal key, missing allowed link origins also fails closed with 503.
    settings.KODERA_OUTBOX_SEAL_KEY = bytes(range(32))
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset()
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset()
    res_no_origin = _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    assert res_no_origin.status_code == 503
    assert res_no_origin.headers["Retry-After"] == "30"
    assert PassportMagicLinkToken.objects.count() == 0
    assert PassportRateLimitEvent.objects.count() == 0


def test_magic_link_request_enqueues_durable_sealed_outbox_and_delivers_end_to_end(
    passport_world,
    settings,
):
    """Production delivery path: with `KODERA_PASSPORT_DELIVERY_SINK=None`, `request` seals
    `(recipient, raw_token)` into `outbox_outboxdelivery` + `outbox_message` in the same
    transaction; `apps.outbox.sender.run_deliveries` unseals, sends `#<raw_token>`, erases
    `sealed`, and the delivered fragment verifies cleanly via `/magic-link/verify`."""
    from email import message_from_bytes, policy

    from smtp_stub import smtp_stub

    from apps.outbox import sender
    from apps.outbox.mail.transport import MailTransport

    w = passport_world
    seal_key = bytes(range(32))
    settings.KODERA_PASSPORT_DELIVERY_SINK = None
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_PASSPORT_MAGIC_LINK = None

    # 1. Known member and unknown address return identical 202 shape (enumerator-safe)
    res_known = _post_json(
        w.client,
        REQUEST_URL,
        {
            "email": "camille.laurent@acme.fr",
            "code_challenge": PKCE_CHALLENGE,
            "code_challenge_method": "S256",
        },
    )
    res_unknown = _post_json(
        w.client,
        REQUEST_URL,
        {
            "email": "unknown.person@acme.fr",
            "code_challenge": PKCE_CHALLENGE,
            "code_challenge_method": "S256",
        },
    )
    assert res_known.status_code == 202
    assert res_unknown.status_code == 202
    assert (
        res_known.json()
        == res_unknown.json()
        == {
            "status": "accepted",
            "expires_in_seconds": 600,
        }
    )

    # 2. Verify exactly one `passport_magic_link` outbox row was enqueued, sealed at rest
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.id, d.organisation_id::text, d.status, m.template_id, m.link, m.sealed"
            " FROM outbox_outboxdelivery d"
            " JOIN outbox_message m ON m.delivery_id = d.id"
            " WHERE m.template_id = 'passport_magic_link'"
        )
        rows = cursor.fetchall()
    assert len(rows) == 1
    delivery_id, delivery_org_id, status_before, _, link_base, sealed_before = rows[0]
    assert delivery_org_id == str(w.org_alpha.id)
    assert status_before == "pending"
    assert link_base == "https://app.localhost/login/passport"
    assert sealed_before is not None

    # 3. Drain outbox through `apps.outbox.sender.run_deliveries` against in-process SMTP stub
    with smtp_stub() as stub:
        transport = MailTransport(
            host=stub.host,
            port=stub.port,
            starttls=False,
            username=None,
            password=None,
            sender="Kodera <no-reply@notify.localhost>",
            reply_to="support@kodera.io",
        )
        report = sender.run_deliveries(transport, limit=10, key=seal_key)

    assert report.sent == 1
    assert len(stub.record.messages) == 1

    # Sealed recipient + token ciphertext is wiped from PostgreSQL once sent
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.status, m.sealed FROM outbox_outboxdelivery d"
            " JOIN outbox_message m ON m.delivery_id = d.id WHERE d.id = %s",
            [delivery_id],
        )
        status_after, sealed_after = cursor.fetchone()
    assert status_after == "succeeded"
    assert sealed_after is None

    # 4. Extract `#<raw_token>` from delivered email body and complete `/magic-link/verify`
    parsed_mail = message_from_bytes(stub.record.messages[0], policy=policy.default)
    body_text = parsed_mail.get_body(preferencelist=("plain",)).get_content()
    prefix = "https://app.localhost/login/passport#"
    assert prefix in body_text
    raw_token = body_text.split(prefix, 1)[1].splitlines()[0].strip()
    assert raw_token not in res_known.content.decode("utf-8")

    verified = _post_json(
        w.client,
        VERIFY_URL,
        {"token": raw_token, "code_verifier": PKCE_VERIFIER},
    )
    assert verified.status_code == 200
    vbody = verified.json()
    assert vbody["session_token"].startswith("kp1.")
    assert [e["organisation_slug"] for e in vbody["workspaces"]] == ["alpha-org", "bravo-org"]


@pytest.mark.usefixtures("frozen_clock")
def test_disabled_target_identity_with_active_sibling_realm_is_excluded_and_refused(
    passport_world,
):
    """Disabling or soft-deleting a customer `Identity` in `bravo-org` while the
    person retains an active sibling `Identity` in `alpha-org` immediately excludes `bravo-org`
    from `/magic-link/verify` and `/workspaces`, and refuses `/switch-workspace` to `bravo-org`
    with `403` without persisting `bravo-org` in `PassportWorkspaceContext`."""
    w = passport_world
    w.models.Identity.objects.filter(pk=w.id_bravo.id).update(enabled=False)

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
    assert verified.status_code == 200
    vbody = verified.json()
    assert [e["organisation_slug"] for e in vbody["workspaces"]] == ["alpha-org"]
    session_token = vbody["session_token"]

    ws_res = w.client.get(
        WORKSPACES_URL,
        HTTP_AUTHORIZATION=f"Bearer {session_token}",
    )
    assert ws_res.status_code == 200
    assert [e["organisation_slug"] for e in ws_res.json()["workspaces"]] == ["alpha-org"]

    sw_denied = _post_json(
        w.client,
        SWITCH_URL,
        {"organisation_id": str(w.org_bravo.id)},
        HTTP_AUTHORIZATION=f"Bearer {session_token}",
    )
    assert sw_denied.status_code == 403
    ctx = PassportWorkspaceContext.objects.get(user_id=w.person.id)
    assert ctx.active_organisation_id == w.org_alpha.id

    # Soft-deleted target Identity (`enabled=False, deleted_at!=None, purge_after>deleted_at`)
    now_del = timezone.now()
    w.models.Identity.objects.filter(pk=w.id_bravo.id).update(
        enabled=False,
        deleted_at=now_del,
        purge_after=now_del + timedelta(days=30),
    )
    assert (
        _post_json(
            w.client,
            SWITCH_URL,
            {"organisation_id": str(w.org_bravo.id)},
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        ).status_code
        == 403
    )


@pytest.mark.usefixtures("frozen_clock")
def test_passport_two_connection_concurrency_fences_and_nowait_conflict(
    passport_world,
):
    """Two-connection PostgreSQL concurrency proof:
    1. Reverse-order held `FOR NO KEY UPDATE` on `orgs_membership` / `identity_identity` or
       exclusive advisory cutoff lock causes `verify`, `workspaces`, and `switch-workspace`
       to return HTTP `409 Conflict` (`NOWAIT`) immediately with rollback (token unburned).
    2. Forward-order admitted `_acquire_passport_fence` (`FOR SHARE` + shared cutoff lock)
       blocks concurrent membership revocation and account-erasure cutoff until commit."""
    import psycopg
    from django.db import transaction

    from apps.identity.passport import _acquire_passport_fence

    w = passport_world
    _post_json(
        w.client,
        REQUEST_URL,
        {"email": "camille.laurent@acme.fr", "code_challenge": PKCE_CHALLENGE},
    )
    unburned_raw = w.deliveries[-1].raw_token

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
    assert verified.status_code == 200
    session_token = verified.json()["session_token"]

    cfg = connection.settings_dict
    with psycopg.connect(
        host=cfg["HOST"],
        port=cfg["PORT"],
        dbname=cfg["NAME"],
        user=cfg["USER"],
        password=cfg["PASSWORD"],
        autocommit=False,
    ) as conn2:
        # 1a. Held row lock on `orgs_membership` -> 409 on verify, workspaces, switch-workspace
        conn2.execute(
            "SELECT 1 FROM orgs_membership WHERE id = %s FOR NO KEY UPDATE",
            [w.mem_bravo.id],
        )
        r_ver_409 = _post_json(
            w.client,
            VERIFY_URL,
            {"token": unburned_raw, "code_verifier": PKCE_VERIFIER},
        )
        assert r_ver_409.status_code == 409
        assert r_ver_409["Content-Type"].startswith("application/problem+json")

        r_ws_409 = w.client.get(
            WORKSPACES_URL,
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        )
        assert r_ws_409.status_code == 409

        r_sw_409 = _post_json(
            w.client,
            SWITCH_URL,
            {"organisation_id": str(w.org_bravo.id)},
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        )
        assert r_sw_409.status_code == 409
        conn2.rollback()

        # Verify rollback preserved unburned magic-link token so it still verifies cleanly!
        token_hash = hash_magic_link_token(unburned_raw)
        assert PassportMagicLinkToken.objects.get(token_sha256=token_hash).consumed_at is None

        # 1b. Held row lock on `identity_identity` -> 409 on switch-workspace
        conn2.execute(
            "SELECT 1 FROM identity_identity WHERE id = %s FOR NO KEY UPDATE",
            [w.id_bravo.id],
        )
        assert (
            _post_json(
                w.client,
                SWITCH_URL,
                {"organisation_id": str(w.org_bravo.id)},
                HTTP_AUTHORIZATION=f"Bearer {session_token}",
            ).status_code
            == 409
        )
        conn2.rollback()

        # 1c. Held exclusive account-erasure advisory lock -> 409 on verify, workspaces, switch
        conn2.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:' || %s, 0))",
            [str(w.person.id)],
        )
        assert (
            _post_json(
                w.client,
                VERIFY_URL,
                {"token": unburned_raw, "code_verifier": PKCE_VERIFIER},
            ).status_code
            == 409
        )
        assert (
            w.client.get(
                WORKSPACES_URL,
                HTTP_AUTHORIZATION=f"Bearer {session_token}",
            ).status_code
            == 409
        )
        assert (
            _post_json(
                w.client,
                SWITCH_URL,
                {"organisation_id": str(w.org_bravo.id)},
                HTTP_AUTHORIZATION=f"Bearer {session_token}",
            ).status_code
            == 409
        )
        conn2.rollback()

        # Now `unburned_raw` still verifies 200 once contention clears!
        assert (
            _post_json(
                w.client,
                VERIFY_URL,
                {"token": unburned_raw, "code_verifier": PKCE_VERIFIER},
            ).status_code
            == 200
        )

        # 2. Forward-order fence on conn1 blocks concurrent membership mutation & cutoff lock on conn2
        with transaction.atomic():
            _acquire_passport_fence(user_id=w.person.id, extra_org_ids=(w.org_bravo.id,))
            conn2.execute("SET LOCAL lock_timeout = '100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                conn2.execute(
                    "UPDATE orgs_membership SET state = 'removed' WHERE id = %s",
                    [w.mem_bravo.id],
                )
            conn2.rollback()

            conn2.execute("SET LOCAL lock_timeout = '100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                conn2.execute(
                    "SELECT pg_advisory_xact_lock("
                    "hashtextextended('privacy_account_cutoff:' || %s, 0))",
                    [str(w.person.id)],
                )
            conn2.rollback()

        # Once fence commits and revocation commits on conn2, switch-workspace to bravo-org -> 403
        conn2.execute(
            "UPDATE orgs_membership SET state = 'removed', updated_at = clock_timestamp()"
            " WHERE id = %s",
            [w.mem_bravo.id],
        )
        conn2.commit()

    assert (
        _post_json(
            w.client,
            SWITCH_URL,
            {"organisation_id": str(w.org_bravo.id)},
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        ).status_code
        == 403
    )
    assert PassportWorkspaceContext.objects.get(user_id=w.person.id).active_organisation_id == (
        w.org_alpha.id
    )


def test_passport_account_and_organisation_privacy_erasure_end_to_end_and_token_purge(
    passport_world,
    settings,
):
    """Passport account and organisation privacy erasure invariants:
    1. Organisation privacy erasure (`begin_erasure` + `advance_erasure`) clears `alpha-org`
       Passport contexts, unshared magic-link tokens, and sealed `passport_magic_link` outbox
       messages; `sender.run_deliveries` never sends withdrawn `alpha-org` mail while still
       delivering sibling `bravo-org` mail; post-cutoff writes raise `23514`; completion reaches
       `complete=True` and cleans up `identity_passportoutboxbinding`.
    2. Account privacy erasure (`begin_account_erasure` + `advance_account_erasure` with
       `PassportAccountOutboxErasureAdapter`) wipes the person's Passport contexts, tokens, and
       sealed outbox messages, refuses post-cutoff writes (`23514`), records verified receipt for
       `account_message_outbox`, and reaches `complete=True`.
    3. `purge_passport_tokens` management command deletes expired/consumed tokens and stale
       rate-limit rows while preserving active unexpired challenges."""
    from uuid import uuid4

    from django.core.management import call_command
    from django.db import IntegrityError, transaction
    from smtp_stub import smtp_stub
    from test_core_erasure import operator

    from apps.identity.models import PassportOutboxBinding
    from apps.orgs.account_erasure_services import (
        AccountAbsenceProof,
        advance_account_erasure,
        begin_account_erasure,
    )
    from apps.orgs.erasure_services import (
        AbsenceProof,
        advance_erasure,
        begin_erasure,
        database_now,
    )
    from apps.orgs.privacy_models import AccountErasureReceipt
    from apps.outbox import sender
    from apps.outbox.mail.transport import MailTransport
    from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
    from services.identity.trusted_issuers import verify_configured_token

    class _OrgStubAdapter:
        revision = "passport-org-stub-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope):
            return AbsenceProof(
                scope.request_id,
                scope.organisation_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "a" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope, proof) -> bool:
            return proof.evidence_sha256 == "a" * 64

    class _AccountStubAdapter:
        revision = "passport-acc-stub-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope):
            return AccountAbsenceProof(
                scope.request_id,
                scope.user_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "b" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope, proof) -> bool:
            return proof.evidence_sha256 == "b" * 64

    w = passport_world
    seal_key = bytes(range(32))
    settings.KODERA_PASSPORT_DELIVERY_SINK = None
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_PASSPORT_MAGIC_LINK = None

    now = timezone.now()
    # Seed co-owners on alpha & bravo so last-owner transfer guard is satisfied for `w.person`,
    # plus an unshared `solo_alpha` user and a `bravo_only` user.
    co_owner_bravo = w.models.User.objects.create(
        email="co.owner.bravo@bravo.fr", display_name="Bravo Co-Owner"
    )
    identity(w.models, w.org_bravo, co_owner_bravo, subject="bravo-co-owner-sub")
    w.models.Membership.objects.create(
        user=co_owner_bravo,
        organisation=w.org_bravo,
        role="org_owner",
        state="active",
        accepted_at=now,
    )

    solo_alpha = w.models.User.objects.create(
        email="solo.alpha@only-alpha.fr", display_name="Solo Alpha"
    )
    identity(w.models, w.org_alpha, solo_alpha, subject="solo-alpha-sub")
    w.models.Membership.objects.create(
        user=solo_alpha,
        organisation=w.org_alpha,
        role="org_owner",
        state="active",
        accepted_at=now,
    )

    shared_person = w.models.User.objects.create(
        email="shared.camille@acme.fr", display_name="Shared Camille"
    )
    identity(w.models, w.org_alpha, shared_person, subject="shared-alpha-sub")
    identity(w.models, w.org_bravo, shared_person, subject="shared-bravo-sub")
    w.models.Membership.objects.create(
        user=shared_person,
        organisation=w.org_alpha,
        role="org_admin",
        state="active",
        accepted_at=now,
    )
    w.models.Membership.objects.create(
        user=shared_person,
        organisation=w.org_bravo,
        role="org_admin",
        state="active",
        accepted_at=now,
    )

    PassportWorkspaceContext.objects.create(
        user_id=shared_person.id,
        active_organisation_id=w.org_alpha.id,
        active_workspace_id=w.ws_alpha.id,
    )
    PassportWorkspaceContext.objects.create(
        user_id=co_owner_bravo.id,
        active_organisation_id=w.org_bravo.id,
        active_workspace_id=w.ws_bravo.id,
    )

    # Enqueue sealed Passport magic-link deliveries for `solo_alpha` (alpha-org) & `co_owner_bravo` (bravo-org)
    assert (
        _post_json(
            w.client,
            REQUEST_URL,
            {"email": "solo.alpha@only-alpha.fr", "code_challenge": PKCE_CHALLENGE},
        ).status_code
        == 202
    )
    assert (
        _post_json(
            w.client,
            REQUEST_URL,
            {"email": "co.owner.bravo@bravo.fr", "code_challenge": PKCE_CHALLENGE},
        ).status_code
        == 202
    )
    assert PassportOutboxBinding.objects.filter(organisation_id=w.org_alpha.id).count() == 1
    assert PassportOutboxBinding.objects.filter(organisation_id=w.org_bravo.id).count() == 1

    # --- 1. Organisation Erasure on `alpha-org` ---
    staff_actor = operator()
    org_erasure = begin_erasure(
        organisation_id=w.org_alpha.id,
        instruction_ref="DEL-1001",
        instruction_sha256="1" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_actor.id,
    )
    assert "passport_unshared_email_sha256s" in org_erasure.inventory
    assert not PassportWorkspaceContext.objects.filter(
        active_organisation_id=w.org_alpha.id
    ).exists()
    assert PassportWorkspaceContext.objects.filter(active_organisation_id=w.org_bravo.id).exists()
    assert not PassportMagicLinkToken.objects.filter(
        email_normalized="solo.alpha@only-alpha.fr"
    ).exists()

    # `alpha-org` outbox mail is withdrawn at cutoff (`sealed IS NULL`), while `bravo-org` mail delivers!
    with smtp_stub() as stub:
        transport = MailTransport(
            host=stub.host,
            port=stub.port,
            starttls=False,
            username=None,
            password=None,
            sender="Kodera <no-reply@notify.localhost>",
            reply_to="support@kodera.io",
        )
        report = sender.run_deliveries(transport, limit=10, key=seal_key)
    assert report.sent == 1
    assert len(stub.record.messages) == 1
    assert b"co.owner.bravo@bravo.fr" in stub.record.messages[0]
    assert b"solo.alpha@only-alpha.fr" not in stub.record.messages[0]

    # Post-cutoff Passport writes targeting `alpha-org` or `solo_alpha` fail closed (`23514`)
    with pytest.raises(IntegrityError), transaction.atomic():
        PassportWorkspaceContext.objects.create(
            user_id=shared_person.id,
            active_organisation_id=w.org_alpha.id,
            active_workspace_id=w.ws_alpha.id,
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        PassportMagicLinkToken.objects.create(
            user_id=solo_alpha.id,
            token_sha256="c" * 64,
            email_normalized="solo.alpha@only-alpha.fr",
            domain_normalized="only-alpha.fr",
            code_challenge=PKCE_CHALLENGE,
            code_challenge_method="S256",
            expires_at=database_now() + timedelta(minutes=10),
        )

    org_adapters = {d: _OrgStubAdapter(d) for d in org_erasure.inventory["required_domains"]}
    org_done = advance_erasure(org_erasure.id, org_adapters)
    assert org_done["complete"] is True
    assert not PassportOutboxBinding.objects.filter(organisation_id=w.org_alpha.id).exists()
    # Shared user `shared_person` keeps active sibling `bravo-org` identity!
    shared_person.refresh_from_db()
    assert shared_person.enabled is True

    # --- 2. Account Erasure on `shared_person` (with real `PassportAccountOutboxErasureAdapter`) ---
    PassportWorkspaceContext.objects.update_or_create(
        user_id=shared_person.id,
        defaults={
            "active_organisation_id": w.org_bravo.id,
            "active_workspace_id": w.ws_bravo.id,
        },
    )
    assert (
        _post_json(
            w.client,
            REQUEST_URL,
            {"email": "shared.camille@acme.fr", "code_challenge": PKCE_CHALLENGE},
        ).status_code
        == 202
    )
    assert PassportOutboxBinding.objects.filter(user_id=shared_person.id).count() == 1

    from dataclasses import replace

    now_epoch = int(database_now().timestamp())
    raw_bravo_jwt = token(
        w.signer,
        w.org_bravo.issuer,
        subject="shared-bravo-sub",
    )
    verified_raw, _ = verify_configured_token(
        raw_bravo_jwt,
        trusted=settings.KODERA_AUTH_TRUST,
    )
    verified_jwt = replace(
        verified_raw,
        auth_time=now_epoch,
        expires_at=now_epoch + 600,
    )

    acc_erasure = begin_account_erasure(
        verified=verified_jwt,
        confirmation="delete",
        instruction_ref="DEL-1002",
        instruction_sha256="2" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_actor.id,
    )
    assert len(acc_erasure.inventory["passport_delivery_ids"]) == 1
    assert not PassportWorkspaceContext.objects.filter(user_id=shared_person.id).exists()
    assert not PassportMagicLinkToken.objects.filter(
        email_normalized="shared.camille@acme.fr"
    ).exists()

    # Withdrawn account mail is never sent by outbox sender
    with smtp_stub() as stub2:
        transport2 = MailTransport(
            host=stub2.host,
            port=stub2.port,
            starttls=False,
            username=None,
            password=None,
            sender="Kodera <no-reply@notify.localhost>",
            reply_to="support@kodera.io",
        )
        report2 = sender.run_deliveries(transport2, limit=10, key=seal_key)
    assert report2.sent == 0
    assert len(stub2.record.messages) == 0

    # Post-cutoff token & context writes for `shared_person` fail closed (`23514`)
    with pytest.raises(IntegrityError), transaction.atomic():
        PassportWorkspaceContext.objects.create(
            user_id=shared_person.id,
            active_organisation_id=w.org_bravo.id,
            active_workspace_id=w.ws_bravo.id,
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        PassportMagicLinkToken.objects.create(
            user_id=shared_person.id,
            token_sha256="d" * 64,
            email_normalized="shared.camille@acme.fr",
            domain_normalized="acme.fr",
            code_challenge=PKCE_CHALLENGE,
            code_challenge_method="S256",
            expires_at=database_now() + timedelta(minutes=10),
        )

    acc_adapters = {
        domain: (
            PassportAccountOutboxErasureAdapter()
            if domain == "account_message_outbox"
            else _AccountStubAdapter(domain)
        )
        for domain in acc_erasure.inventory["required_domains"]
    }
    acc_done = advance_account_erasure(acc_erasure.id, acc_adapters)
    assert acc_done["complete"] is True
    assert AccountErasureReceipt.objects.filter(
        erasure=acc_erasure,
        domain="account_message_outbox",
        adapter_revision="passport-outbox-v1",
    ).exists()
    assert not PassportOutboxBinding.objects.filter(user_id=shared_person.id).exists()
    # Idempotent second call after binding cleanup still succeeds cleanly
    assert advance_account_erasure(acc_erasure.id, acc_adapters)["complete"] is True

    # --- 3. `purge_passport_tokens` management command ---
    app_now = timezone.now()
    expired_tok = PassportMagicLinkToken.objects.create(
        user_id=co_owner_bravo.id,
        token_sha256=hashlib.sha256(str(uuid4()).encode()).hexdigest(),
        email_normalized="co.owner.bravo@bravo.fr",
        domain_normalized="bravo.fr",
        code_challenge=PKCE_CHALLENGE,
        code_challenge_method="S256",
        expires_at=app_now - timedelta(minutes=15),
    )
    active_tok = PassportMagicLinkToken.objects.create(
        user_id=co_owner_bravo.id,
        token_sha256=hashlib.sha256(str(uuid4()).encode()).hexdigest(),
        email_normalized="co.owner.bravo@bravo.fr",
        domain_normalized="bravo.fr",
        code_challenge=PKCE_CHALLENGE,
        code_challenge_method="S256",
        expires_at=app_now + timedelta(minutes=9),
    )
    stale_rl = PassportRateLimitEvent.objects.create(
        scope="ip",
        digest=hashlib.sha256(b"ip:stale").hexdigest(),
    )
    PassportRateLimitEvent.objects.filter(pk=stale_rl.id).update(
        occurred_at=app_now - timedelta(hours=2)
    )
    fresh_rl = PassportRateLimitEvent.objects.create(
        scope="ip",
        digest=hashlib.sha256(b"ip:fresh").hexdigest(),
    )
    PassportRateLimitEvent.objects.filter(pk=fresh_rl.id).update(occurred_at=app_now)

    call_command("purge_passport_tokens")
    assert not PassportMagicLinkToken.objects.filter(pk=expired_tok.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=active_tok.id).exists()
    assert not PassportRateLimitEvent.objects.filter(pk=stale_rl.id).exists()
    assert PassportRateLimitEvent.objects.filter(pk=fresh_rl.id).exists()


def test_oidc_origin_suspended_or_removed_membership_is_refused_on_workspaces_and_switch(
    passport_world,
):
    """Customer OIDC bearer whose Identity in `alpha-org` remains enabled while their
    `alpha-org` Membership is `suspended` or `removed` must be refused `403` on both
    `GET /api/v1/auth/passport/workspaces` and `POST /api/v1/auth/passport/switch-workspace`,
    even when a sibling `bravo-org` Identity and Membership remain active."""
    w = passport_world
    now = timezone.now()

    co_owner_alpha = w.models.User.objects.create(
        email="co.owner.alpha@acme.fr", display_name="Alpha Co-Owner"
    )
    identity(w.models, w.org_alpha, co_owner_alpha, subject="alpha-co-owner-sub")
    w.models.Membership.objects.create(
        user=co_owner_alpha,
        organisation=w.org_alpha,
        role="org_owner",
        state="active",
        accepted_at=now,
    )

    alpha_bearer = token(w.signer, w.org_alpha.issuer, subject="camille-alpha-sub")
    bravo_bearer = token(w.signer, w.org_bravo.issuer, subject="camille-bravo-sub")

    for revoked_state in ("suspended", "removed"):
        w.models.Membership.objects.filter(pk=w.mem_alpha.id).update(
            state=revoked_state,
            updated_at=timezone.now(),
        )

        dir_refused = w.client.get(
            WORKSPACES_URL,
            HTTP_AUTHORIZATION=f"Bearer {alpha_bearer}",
        )
        assert dir_refused.status_code == 403, revoked_state
        assert dir_refused["Content-Type"].startswith("application/problem+json")

        sw_refused = _post_json(
            w.client,
            SWITCH_URL,
            {"organisation_id": str(w.org_bravo.id)},
            HTTP_AUTHORIZATION=f"Bearer {alpha_bearer}",
        )
        assert sw_refused.status_code == 403, revoked_state
        assert sw_refused["Content-Type"].startswith("application/problem+json")
        assert not PassportWorkspaceContext.objects.filter(user_id=w.person.id).exists()

        # Sibling `bravo-org` OIDC bearer (where membership IS active) succeeds and lists only `bravo-org`
        bravo_ok = w.client.get(
            WORKSPACES_URL,
            HTTP_AUTHORIZATION=f"Bearer {bravo_bearer}",
        )
        assert bravo_ok.status_code == 200
        assert [e["organisation_slug"] for e in bravo_ok.json()["workspaces"]] == ["bravo-org"]


def test_same_contact_independent_persons_isolate_token_erasure_and_outbox_delivery(
    passport_world,
    settings,
):
    """Independent people sharing the same permitted non-unique contact address must isolate
    magic-link token ownership across account erasure, organisation erasure, cutoff guards,
    completion checks, and outbox sender withdrawal."""
    from dataclasses import replace

    from django.db import IntegrityError, transaction
    from smtp_stub import smtp_stub
    from test_core_erasure import operator

    from apps.identity.models import PassportOutboxBinding
    from apps.identity.passport import generate_magic_link_token
    from apps.orgs.account_erasure_services import (
        AccountAbsenceProof,
        advance_account_erasure,
        begin_account_erasure,
    )
    from apps.orgs.erasure_services import (
        AbsenceProof,
        advance_erasure,
        begin_erasure,
        database_now,
    )
    from apps.outbox import sender
    from apps.outbox.mail.transport import MailTransport
    from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
    from core.db.ids import new_uuid7
    from core.passport import enqueue_passport_magic_link
    from services.identity.trusted_issuers import verify_configured_token

    class _OrgStubAdapter:
        revision = "same-contact-org-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope):
            return AbsenceProof(
                scope.request_id,
                scope.organisation_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "a" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope, proof) -> bool:
            return proof.evidence_sha256 == "a" * 64

    class _AccountStubAdapter:
        revision = "same-contact-acc-v1"

        def __init__(self, domain: str) -> None:
            self.domain = domain

        def erase_and_verify(self, scope):
            return AccountAbsenceProof(
                scope.request_id,
                scope.user_id,
                scope.cutoff_at,
                self.domain,
                scope.inventory_sha256,
                "b" * 64,
                self.revision,
                database_now(),
            )

        def verify_proof(self, scope, proof) -> bool:
            return proof.evidence_sha256 == "b" * 64

    w = passport_world
    seal_key = bytes(range(32))
    settings.KODERA_PASSPORT_DELIVERY_SINK = None
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_PASSPORT_MAGIC_LINK = None

    shared_email = "shared.contact@acme.fr"
    now = database_now()

    person_p1 = w.models.User.objects.create(email=shared_email, display_name="Person P1 Alpha")
    identity(w.models, w.org_alpha, person_p1, subject="person-p1-alpha-sub")
    w.models.Membership.objects.create(
        user=person_p1,
        organisation=w.org_alpha,
        role="org_admin",
        state="active",
        accepted_at=now,
    )

    person_p2 = w.models.User.objects.create(email=shared_email, display_name="Person P2 Outsider")
    identity(w.models, w.org_outsider, person_p2, subject="person-p2-outsider-sub")
    w.models.Membership.objects.create(
        user=person_p2,
        organisation=w.org_outsider,
        role="org_owner",
        state="active",
        accepted_at=now,
    )

    person_q = w.models.User.objects.create(email=shared_email, display_name="Person Q Bravo")
    identity(w.models, w.org_bravo, person_q, subject="person-q-bravo-sub")
    w.models.Membership.objects.create(
        user=person_q,
        organisation=w.org_bravo,
        role="org_admin",
        state="active",
        accepted_at=now,
    )

    def _seed_bound_magic_link(person_obj, org_obj):
        raw_tok, tok_sha = generate_magic_link_token()
        deliv_id = new_uuid7()
        db_now = database_now()
        exp = max(timezone.now(), db_now) + timedelta(minutes=10)
        with transaction.atomic():
            PassportOutboxBinding.objects.create(
                delivery_id=deliv_id,
                user_id=person_obj.id,
                organisation_id=org_obj.id,
                created_at=db_now,
            )
            enqueue_passport_magic_link(
                seal_key=seal_key,
                link="https://app.localhost/passport/verify",
                organisation_id=org_obj.id,
                organisation_name=org_obj.name,
                recipient=shared_email,
                raw_token=raw_tok,
                expires_at=exp,
                delivery_id=deliv_id,
            )
            tok_row = PassportMagicLinkToken.objects.create(
                token_sha256=tok_sha,
                user_id=person_obj.id,
                delivery_id=deliv_id,
                email_normalized=shared_email,
                domain_normalized="acme.fr",
                code_challenge=PKCE_CHALLENGE,
                code_challenge_method="S256",
                expires_at=exp,
            )
        return raw_tok, tok_row, deliv_id

    _, tok_p1, _ = _seed_bound_magic_link(person_p1, w.org_alpha)
    _, tok_p2, _ = _seed_bound_magic_link(person_p2, w.org_outsider)
    raw_q, tok_q, deliv_q = _seed_bound_magic_link(person_q, w.org_bravo)

    _, unbound_sha = generate_magic_link_token()
    unbound_tok = PassportMagicLinkToken.objects.create(
        token_sha256=unbound_sha,
        user_id=None,
        delivery_id=None,
        email_normalized=shared_email,
        domain_normalized="acme.fr",
        code_challenge=PKCE_CHALLENGE,
        code_challenge_method="S256",
        expires_at=now + timedelta(minutes=10),
    )

    # --- 1. Account erasure of `person_p1` ---
    staff_actor = operator()
    now_epoch = int(database_now().timestamp())
    raw_p1_jwt = token(w.signer, w.org_alpha.issuer, subject="person-p1-alpha-sub")
    verified_p1_raw, _ = verify_configured_token(raw_p1_jwt, trusted=settings.KODERA_AUTH_TRUST)
    verified_p1 = replace(verified_p1_raw, auth_time=now_epoch, expires_at=now_epoch + 600)

    acc_erasure = begin_account_erasure(
        verified=verified_p1,
        confirmation="delete",
        instruction_ref="DEL-4001",
        instruction_sha256="3" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_actor.id,
    )

    # P1's bound token and the unbound fallback token are removed; P2's and Q's bound tokens survive!
    assert not PassportMagicLinkToken.objects.filter(pk=tok_p1.id).exists()
    assert not PassportMagicLinkToken.objects.filter(pk=unbound_tok.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=tok_p2.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=tok_q.id).exists()

    # During P1's `cutoff`, unbound (`user_id=None`) and P1-bound (`user_id=P1`) writes fail closed,
    # while Q-bound (`user_id=Q`) writes STILL succeed cleanly!
    with pytest.raises(IntegrityError), transaction.atomic():
        PassportMagicLinkToken.objects.create(
            token_sha256="e" * 64,
            user_id=None,
            email_normalized=shared_email,
            domain_normalized="acme.fr",
            code_challenge=PKCE_CHALLENGE,
            code_challenge_method="S256",
            expires_at=database_now() + timedelta(minutes=10),
        )
    _, q_cutoff_sha = generate_magic_link_token()
    q_cutoff_tok = PassportMagicLinkToken.objects.create(
        token_sha256=q_cutoff_sha,
        user_id=person_q.id,
        delivery_id=None,
        email_normalized=shared_email,
        domain_normalized="acme.fr",
        code_challenge=PKCE_CHALLENGE,
        code_challenge_method="S256",
        expires_at=database_now() + timedelta(minutes=10),
    )
    assert PassportMagicLinkToken.objects.filter(pk=q_cutoff_tok.id).exists()

    acc_adapters = {
        domain: (
            PassportAccountOutboxErasureAdapter()
            if domain == "account_message_outbox"
            else _AccountStubAdapter(domain)
        )
        for domain in acc_erasure.inventory["required_domains"]
    }
    acc_done = advance_account_erasure(acc_erasure.id, acc_adapters)
    assert acc_done["complete"] is True
    assert PassportMagicLinkToken.objects.filter(pk=tok_q.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=q_cutoff_tok.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=tok_p2.id).exists()

    # --- 2. Organisation erasure of `outsider-org` where `person_p2` is unshared ---
    org_erasure = begin_erasure(
        organisation_id=w.org_outsider.id,
        instruction_ref="DEL-4002",
        instruction_sha256="4" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_actor.id,
    )
    assert not PassportMagicLinkToken.objects.filter(pk=tok_p2.id).exists()
    assert PassportMagicLinkToken.objects.filter(pk=tok_q.id).exists()
    assert PassportOutboxBinding.objects.filter(delivery_id=deliv_q).exists()

    # Outbox sender withdraws P1 & P2 deliveries while delivering Q's `bravo-org` magic link!
    with smtp_stub() as stub:
        transport = MailTransport(
            host=stub.host,
            port=stub.port,
            starttls=False,
            username=None,
            password=None,
            sender="Kodera <no-reply@notify.localhost>",
            reply_to="support@kodera.io",
        )
        report = sender.run_deliveries(transport, limit=10, key=seal_key)
    import email as stdlib_email

    assert report.sent == 1
    assert len(stub.record.messages) == 1
    parsed_mime = stdlib_email.message_from_bytes(stub.record.messages[0])
    decoded_body = parsed_mime.get_payload(decode=True)
    assert isinstance(decoded_body, bytes)
    assert raw_q.encode("ascii") in decoded_body

    org_adapters = {d: _OrgStubAdapter(d) for d in org_erasure.inventory["required_domains"]}
    org_done = advance_erasure(org_erasure.id, org_adapters)
    assert org_done["complete"] is True

    # Q's bound live token STILL verifies 200 on `/api/v1/auth/passport/magic-link/verify`!
    verify_res = _post_json(
        w.client,
        VERIFY_URL,
        {"token": raw_q, "code_verifier": PKCE_VERIFIER},
    )
    assert verify_res.status_code == 200
    assert [e["organisation_slug"] for e in verify_res.json()["workspaces"]] == ["bravo-org"]
