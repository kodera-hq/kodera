"""The deployed middleware confines live and invalidated guests before Core views."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.http import HttpResponse
from django.test import Client, RequestFactory
from django.utils import timezone
from test_deploy_operator_contracts import deployed_middleware
from test_h2_3_governance import governed as governed, world as world

from apps.identity.models import Identity, User
from apps.orgs.models import Membership
from apps.workspaces import bridges, guest_http
from apps.workspaces.api import bridges as bridge_api
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.mark.parametrize("state", ["active", "expired", "revoked"])
def test_deployed_stack_blocks_guest_membership_invites_and_directory(
    governed, settings, monkeypatch, state
):
    settings.MIDDLEWARE = deployed_middleware()
    org, _, _, tokens = governed[0]
    user = User.objects.create(email="guest@example.org")
    guest = Identity.objects.create(
        user=user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=str(uuid4()),
        email=user.email,
    )
    grant = bridges.grant_guest(
        verified=tokens[0],
        organisation_id=org.id,
        body={
            "guestIdentityId": str(guest.id),
            "matrixUserId": "@guest:peer.example.org",
            "channelId": str(governed[2][0].id),
            "matrixRoomId": "!guest:local.example.org",
            "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
        },
        request_id=str(uuid4()),
    )
    if state == "expired":
        expired_now = timezone.now() + timedelta(hours=2)
        monkeypatch.setattr(bridges.timezone, "now", lambda: expired_now)
    elif state == "revoked":
        bridges.revoke_guest(
            verified=tokens[0],
            organisation_id=org.id,
            grant_id=grant["id"],
            request_id=str(uuid4()),
        )
    token = VerifiedAccessToken(
        org.issuer,
        guest.subject,
        ("kodera-server",),
        0,
        2**31,
        None,
        None,
        None,
        None,
        email_verified=True,
    )
    monkeypatch.setattr(guest_http, "verify_configured_token", lambda *a, **kw: (token, "customer"))
    monkeypatch.setattr(bridge_api, "verify_configured_token", lambda *a, **kw: (token, "customer"))
    client = Client(HTTP_AUTHORIZATION="Bearer synthetic")
    for method, path in [
        ("post", f"/api/v1/organisations/{org.id}/memberships"),
        ("post", "/api/v1/invitations/accept"),
        ("get", f"/api/v1/organisations/{org.id}/memberships"),
        ("get", f"/api/v1/organisations/{org.id}/workspace"),
        ("get", f"/api/v1/organisations/{org.id}/workspace/documents"),
        ("get", f"/api/v1/organisations/{org.id}/workspace/search"),
    ]:
        response = getattr(client, method)(path)
        assert response.status_code == 403
        assert response.json()["type"] == "https://kodera.io/problems/forbidden"
    assert not Membership.objects.filter(user=user).exists()
    # The sole guest route still reaches its own live grant check.
    response = client.get(f"/api/v1/organisations/{org.id}/workspace/guest-channel")
    assert response.status_code == (200 if state == "active" else 404)
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200


def test_guest_scope_leaves_health_and_operator_paths_to_their_own_handlers(monkeypatch):
    def unexpected(*a, **kw):
        pytest.fail("guest middleware authenticated a non-customer path")

    monkeypatch.setattr(guest_http, "verify_configured_token", unexpected)
    middleware = guest_http.GuestScopeMiddleware(lambda request: HttpResponse(status=204))
    for path in ["/health/live", "/health/ready", "/staff/v1/jobs", "/agent/v1/channel-authority"]:
        assert middleware(RequestFactory().get(path)).status_code == 204
