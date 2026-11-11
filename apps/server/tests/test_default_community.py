"""Canonical community provisioning, membership and private-room boundaries."""

from types import SimpleNamespace

import pytest
from django.db import transaction
from django.test import override_settings

from apps.identity.models import Identity, User
from apps.orgs.community import bootstrap_community_workspace, ensure_community_membership
from apps.orgs.models import Membership
from apps.support.community import CommunitySupportForbiddenError, open_community_ticket
from apps.support.models import SupportTicket
from apps.support.tickets import TicketRateLimitedError, TicketRequest
from apps.workspaces.channel_access import resolve
from apps.workspaces.channel_sets import channel_set_input
from apps.workspaces.models import Category, Channel
from apps.workspaces.structure import WorkspaceNotFoundError, read_workspace
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db(transaction=True)
ISSUER = "https://identity.customer.test/realms/community"


def token(subject="member", issuer=ISSUER, **kwargs):
    return VerifiedAccessToken(
        issuer=issuer,
        subject=subject,
        audience=("kodera-server",),
        issued_at=1,
        expires_at=9999999999,
        not_before=None,
        amr=None,
        acr=None,
        auth_time=None,
        **kwargs,
    )


@pytest.fixture
def community(settings, monkeypatch):
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    settings.KODERA_DEFAULT_COMMUNITY_ISSUER = ISSUER
    monkeypatch.setattr("apps.orgs.community.is_trusted_issuer", lambda *args, **kwargs: True)
    owner = User.objects.create(email="owner@example.test")
    workspace = bootstrap_community_workspace(owner_user_id=owner.id)
    return SimpleNamespace(owner=owner, workspace=workspace, organisation=workspace.organisation)


def signup(subject="member"):
    verified = token(subject, email_verified=True, email=f"{subject}@example.test")
    return verified, ensure_community_membership(verified=verified)


def test_bootstrap_idempotence_and_private_policies(community):
    assert bootstrap_community_workspace().id == community.workspace.id
    assert Category.objects.count() == 3
    assert Channel.objects.count() == 14
    announcement = resolve(Channel.objects.get(name="announcements").id)
    assert announcement.read_only
    assert not {"message.react", "channel.history"} & announcement.denied
    assert resolve(Channel.objects.get(name="dev").id).visibility == "restricted"
    assert resolve(Channel.objects.get(name="partner-dinum").id).allow_members == ()


def test_signup_requires_exact_issuer_verified_email(community):
    for verified in (
        token(email="person@example.test"),
        token(
            issuer="https://other.test/realms/community",
            email_verified=True,
            email="person@example.test",
        ),
        token(email_verified=True, email="invalid"),
    ):
        assert ensure_community_membership(verified=verified) is None
    verified, member = signup()
    assert member.role == "org_member"
    assert ensure_community_membership(verified=verified).id == member.id
    assert Identity.objects.filter(subject="member").count() == 1


def test_customer_and_staff_get_member_role_preserving_owner(community):
    from test_customer_persistence_models import anchor, anchor_models, identity

    other, _, members = anchor(anchor_models())
    principal = identity(anchor_models(), other, members[0].user, subject="customer")
    assert (
        ensure_community_membership(verified=token(principal.subject, principal.issuer)).role
        == "org_member"
    )
    staff_issuer = "https://identity.staff.test/realms/kodera-staff"
    for user, subject, expected in (
        (community.owner, "owner", "org_owner"),
        (User.objects.create(email="staff@example.test"), "staff", "org_member"),
    ):
        Identity.objects.create(
            user=user, issuer=staff_issuer, realm="kodera-staff", subject=subject, email=user.email
        )
        assert ensure_community_membership(verified=token(subject, staff_issuer)).role == expected


def test_revoked_membership_and_disabled_identity_never_revived(community):
    verified, member = signup()
    for state in ("suspended", "removed"):
        Membership.objects.filter(id=member.id).update(state=state)
        assert ensure_community_membership(verified=verified).state == state
    Identity.objects.filter(subject=verified.subject).update(enabled=False)
    assert ensure_community_membership(verified=verified) is None


def test_member_visibility_and_engine_acl(community):
    verified, _ = signup()
    result = read_workspace(verified=verified, organisation_id=community.organisation.id)
    names = {channel.name for category in result.categories for channel in category.channels}
    assert names == {
        "announcements",
        "general",
        "developers-community",
        "support",
        "extensions",
        "self-hosting",
        "show-and-tell",
        "office-hours",
    }
    with transaction.atomic():
        _, channels = channel_set_input(community.workspace.id)
    announcement = next(channel for channel in channels if channel["name"] == "announcements")
    assert announcement["read_only"] and verified.subject not in announcement["exempt"]
    for name in (
        "dev",
        "strategy",
        "ops-oncall",
        "kodera-git-tracker",
        "partner-dinum",
        "partner-octo",
    ):
        restricted = next(channel for channel in channels if channel["name"] == name)
        assert restricted["audience"] == "listed" and verified.subject not in restricted["members"]


def test_other_customer_isolation(community):
    from test_customer_persistence_models import anchor, anchor_models

    other, _, _ = anchor(anchor_models())
    verified, _ = signup()
    with pytest.raises(WorkspaceNotFoundError):
        read_workspace(verified=verified, organisation_id=other.id)


def test_support_persistence_triage_quota_and_revocation(community):
    verified, member = signup()
    request = TicketRequest(
        "Login fails", "Keycloak login is blocked", "login", "blocked", "en", None, None, None
    )
    for _ in range(5):
        result = open_community_ticket(verified=verified, request=request)
        assert (result["priority"], result["queue"], result["confirmation"]) == (
            "P1",
            "identity-access",
            "ticket-created",
        )
        assert "body" not in result and "subject" not in result
    assert SupportTicket.objects.count() == 5
    with pytest.raises(TicketRateLimitedError):
        open_community_ticket(verified=verified, request=request)
    Membership.objects.filter(id=member.id).update(state="suspended")
    with pytest.raises(CommunitySupportForbiddenError):
        open_community_ticket(verified=verified, request=request)


def test_opt_in_is_required(community):
    with override_settings(KODERA_DEFAULT_COMMUNITY_ORG_SLUG=""):
        assert ensure_community_membership(verified=token()) is None


def test_explicit_identity_binding_is_unique_and_emits_subject(community):
    from apps.orgs.community import bind_community_identity

    bound = bind_community_identity(user_id=community.owner.id, subject="owner-community")
    assert (
        bind_community_identity(user_id=community.owner.id, subject="owner-community").id
        == bound.id
    )
    verified, member = signup()
    with pytest.raises(ValueError):
        bind_community_identity(user_id=member.user_id, subject="owner-community")
    with transaction.atomic():
        subjects, channels = channel_set_input(community.workspace.id)
    assert "owner-community" in subjects
    assert "owner-community" in next(c for c in channels if c["name"] == "announcements")["exempt"]


def test_administrator_demotion_removes_managed_staff_access(community):
    from apps.orgs.community import refresh_community_staff_grants

    _, member = signup()
    Membership.objects.filter(id=member.id).update(role="org_admin")
    with transaction.atomic():
        refresh_community_staff_grants(community.organisation.id)
    assert member.id in resolve(Channel.objects.get(name="dev").id).allow_members
    Membership.objects.filter(id=member.id).update(role="org_member")
    with transaction.atomic():
        refresh_community_staff_grants(community.organisation.id)
    assert member.id not in resolve(Channel.objects.get(name="dev").id).allow_members


def test_signed_http_signup_and_support_replay_revocation(
    community, settings, http_signer, frozen_clock
):
    import json

    from customer_http_fixtures import configure, token as signed_token, trust_entry
    from django.test import Client
    from test_workspace_onboarding import conformance_errors

    configure(settings, [trust_entry(http_signer, ISSUER)])
    credential = signed_token(
        http_signer, ISSUER, "http-member", email_verified=True, email="http@example.test"
    )
    client = Client()
    headers = {"HTTP_AUTHORIZATION": "Bearer " + credential}
    response = client.get("/api/v1/me", **headers)
    assert response.status_code == 200, response.content
    memberships = response.json()["organisations"]
    assert len(memberships) == 1 and memberships[0]["role"] == "org_member"
    assert memberships[0]["organisation"]["slug"] == "community"
    assert memberships[0]["identity_id"] == response.json()["identities"][0]["id"]
    headers["HTTP_IDEMPOTENCY_KEY"] = "community-support-http-001"
    body = json.dumps(
        {
            "subject": "Login issue",
            "body": "The login screen is blocked",
            "category": "login",
            "locale": "en",
        }
    )
    response = client.post(
        "/api/v1/community/support/tickets", body, content_type="application/json", **headers
    )
    assert response.status_code == 201, response.content
    assert conformance_errors(response, "/community/support/tickets", "post") == []
    assert (
        client.post(
            "/api/v1/community/support/tickets", body, content_type="application/json", **headers
        ).status_code
        == 201
    )
    assert SupportTicket.objects.count() == 1
    Membership.objects.filter(id=memberships[0]["membership_id"]).update(state="suspended")
    assert (
        client.post(
            "/api/v1/community/support/tickets", body, content_type="application/json", **headers
        ).status_code
        == 403
    )


from customer_http_fixtures import http_signer as http_signer  # noqa: E402
from test_access_tokens import frozen_clock as frozen_clock  # noqa: E402


def test_parallel_signup_creates_one_identity_and_membership(community):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections

    verified = token("race-member", email_verified=True, email="race@example.test")

    def join():
        close_old_connections()
        try:
            return ensure_community_membership(verified=verified).id
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        ids = list(executor.map(lambda _: join(), range(2)))
    assert len(set(ids)) == 1
    assert Identity.objects.filter(issuer=ISSUER, subject="race-member").count() == 1


def test_staff_http_profile_only_exposes_community(community, settings, http_signer, frozen_clock):
    from customer_http_fixtures import configure, token as signed_token, trust_entry
    from django.test import Client

    issuer = "https://identity.staff.test/realms/kodera-staff"
    Identity.objects.create(
        user=community.owner,
        issuer=issuer,
        realm="kodera-staff",
        subject="staff-owner",
        email=community.owner.email,
    )
    configure(
        settings, [trust_entry(http_signer, issuer, lane="staff"), trust_entry(http_signer, ISSUER)]
    )
    client = Client()
    response = client.get(
        "/api/v1/me",
        HTTP_AUTHORIZATION="Bearer " + signed_token(http_signer, issuer, "staff-owner"),
    )
    assert response.status_code == 200, response.content
    data = response.json()
    assert data["staff"] is True
    assert data["identities"][0]["issuer"] == issuer
    assert [m["organisation"]["slug"] for m in data["organisations"]] == ["community"]


def test_cross_realm_exception_requires_explicit_selector_opt_in(community):
    from test_customer_persistence_models import anchor, anchor_models, identity

    from apps.orgs.actor_selectors import TenantCallerNotFoundError, read_tenant_caller

    other, _, members = anchor(anchor_models())
    principal = identity(anchor_models(), other, members[0].user)
    verified = token(principal.subject, principal.issuer)
    ensure_community_membership(verified=verified)
    assert (
        read_workspace(verified=verified, organisation_id=community.organisation.id).workspace_id
        == community.workspace.id
    )
    with transaction.atomic(), pytest.raises(TenantCallerNotFoundError):
        read_tenant_caller(verified=verified, organisation_id=community.organisation.id)


def test_bootstrap_rejects_private_category_visibility_drift(community):
    for key in ("core_kodera", "design_partners"):
        policy = Category.objects.get(template_key=key).default_policy
        policy.visibility = "organisation"
        policy.save(update_fields=["visibility"])
        with pytest.raises(ValueError, match="category policy drift"):
            bootstrap_community_workspace()
        policy.visibility = "restricted"
        policy.save(update_fields=["visibility"])


def test_bootstrap_rejects_canonical_channel_drift_preserving_custom_resources(community):
    custom = Channel.objects.create(
        workspace=community.workspace, name="custom", kind="text", position=20, lifecycle="active"
    )
    announcement = Channel.objects.get(template_key="announcements")
    original_category = announcement.category_id
    announcement.category = Category.objects.get(template_key="core_kodera")
    announcement.position = 30
    announcement.save(update_fields=["category", "position"])
    with pytest.raises(ValueError, match="channel drift"):
        bootstrap_community_workspace()
    announcement.category_id = original_category
    announcement.policy_mode = "inherit"
    announcement.explicit_policy = None
    announcement.save(update_fields=["category", "policy_mode", "explicit_policy"])
    with pytest.raises(ValueError, match="channel drift"):
        bootstrap_community_workspace()
    custom.refresh_from_db()
    assert custom.name == "custom" and custom.category_id is None


@pytest.mark.parametrize("lane", ["canonical", "customer", "staff"])
def test_real_tenant_listing_is_canonical_and_membership_scoped(
    community, settings, http_signer, frozen_clock, lane
):
    from customer_http_fixtures import configure, token as signed_token, trust_entry
    from django.test import Client
    from test_customer_persistence_models import anchor, anchor_models, identity
    from test_workspace_onboarding import conformance_errors

    from apps.tenancy.models import Tenant

    other, _, members = anchor(anchor_models())
    if lane == "canonical":
        issuer, subject = ISSUER, "tenant-reader"
        signup(subject)
    elif lane == "customer":
        principal = identity(anchor_models(), other, members[0].user)
        issuer, subject = principal.issuer, principal.subject
        ensure_community_membership(verified=token(subject, issuer))
    else:
        issuer, subject = "https://identity.staff.test/realms/kodera-staff", "tenant-reader"
        Identity.objects.create(
            user=members[0].user,
            issuer=issuer,
            realm="kodera-staff",
            subject=subject,
            email=members[0].user.email,
        )
        ensure_community_membership(verified=token(subject, issuer))
    configure(
        settings,
        [trust_entry(http_signer, issuer, lane="staff" if lane == "staff" else "customer")],
    )
    headers = {"HTTP_AUTHORIZATION": "Bearer " + signed_token(http_signer, issuer, subject)}
    client = Client()
    path = f"/api/v1/organisations/{community.organisation.id}/tenants"
    response = client.get(path, **headers)
    assert response.status_code == 200, response.content
    assert conformance_errors(response, "/organisations/{organisation_id}/tenants", "get") == []
    rows = response.json()["data"]
    assert len(rows) == 1 and rows[0]["slug"] == "community"
    assert rows[0]["status"] == "provisioning" and rows[0]["apps"] == ["messaging"]
    tenant = Tenant.objects.get(id=rows[0]["id"])
    assert tenant.is_default_community and tenant.organisation_id == community.organisation.id
    assert bootstrap_community_workspace().id == community.workspace.id
    assert Tenant.objects.filter(slug="community").count() == 1
    # Only this tenant-list read is opened: ordinary organisation financial and metadata reads
    # retain their existing issuer and staff gates.
    if lane != "canonical":
        for suffix in ("invoices", "subscriptions"):
            assert client.get(
                f"/api/v1/organisations/{community.organisation.id}/{suffix}", **headers
            ).status_code in (403, 404)
    if lane != "customer":
        assert client.get(f"/api/v1/organisations/{other.id}/tenants", **headers).status_code in (
            403,
            404,
        )
    Membership.objects.filter(
        organisation=community.organisation,
        user_id=Identity.objects.get(issuer=issuer, subject=subject).user_id,
    ).update(state="suspended")
    assert client.get(path, **headers).status_code == 404
