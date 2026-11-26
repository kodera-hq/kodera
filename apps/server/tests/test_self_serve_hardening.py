"""Admission on the shared console, including the last paid-capacity boundary in PostgreSQL."""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connections
from django.test import Client
from django.utils import timezone
from test_place_order_http import order_body
from test_s3_beta_self_serve_and_sovereign import (
    SHARED_ISSUER,
    _mint_customer_jwt,
    _setup_shared_realm_settings,
    _verified_shared,
)

from apps.billing.models import Invoice, Order, Subscription
from apps.identity.passport import passport_secret
from apps.orgs.claim_configuration import ClaimConfigurationError
from apps.orgs.invitation_mail import organisation_invitation_link
from apps.orgs.models import Membership, Organisation
from apps.workspaces.api import self_serve as endpoint
from apps.workspaces.models import WorkspaceInviteLink
from apps.workspaces.moderation import create_link
from apps.workspaces.self_serve import SelfServeValidationError, parse_self_serve_request
from config.environment import self_serve_disposable_domains
from core.api.edge import SlidingWindow
from core.passport import issue_passport_session_token

WEB = Path(__file__).resolve().parents[2] / "web" / "src"
SIGNUP = "/api/v1/workspaces/self-serve"
APP = "https://app.example.org"
COMMUNITY = "https://community.example.org"


def root_route_paths(web=WEB):
    # TanStack's root children live both in app/ and in the features imported by routeTree.ts.
    # Read the route objects themselves. Unknown path expressions require an explicit resolution.
    tree = (web / "app/routeTree.ts").read_text()
    for prop in re.finditer(r"\bpaths\s*:\s*", tree):
        group = re.match(r"\[([^\]]*)\]", tree[prop.end() :])
        assert group, "Resolve the lazy root paths before checking their reservations"
        for expr in group[1].split(","):
            if expr.strip():
                yield literal(expr.strip())
    for file in sorted(web.rglob("*.ts*")):
        if ".test." in file.name or file.suffix not in {".ts", ".tsx"}:
            continue
        source = file.read_text()
        root = re.search(
            r"""\bimport\s*\{[^}]*?\brootRoute(?:\s+as\s+(\w+))?[^}]*\}\s*from\s*['"][^'"]*/root-route['"]""",
            source,
        )
        if not root:
            continue
        local_name = root[1] or "rootRoute"
        parent = rf"getParentRoute\s*:\s*\(\)\s*=>\s*{local_name}\b"
        blocks = re.split(r"\bcreateRoute\s*\(\s*\{", source)
        assert not re.search(parent, blocks[0]), f"Unresolved root route factory in {file}"
        for block in blocks[1:]:
            if not re.search(parent, block):
                continue
            path = re.search(r"\bpath\s*:\s*([^,\n}]+)", block)
            if not path:
                # These two placeholders expand the ROUTE_UNITS under $org and the lazy paths above.
                assert file == web / "app/lazyRouteTree.ts" and re.search(r"\bpath\s*,", block)
                continue
            expr = path[1].strip()
            if expr == "MATRIX_CALLBACK_PATH":
                constant = re.search(
                    r"export const MATRIX_CALLBACK_PATH\s*=\s*([^\n]+)",
                    (web / "auth/matrix.ts").read_text(),
                )
                assert constant
                expr = constant[1]
            yield literal(expr)


def literal(expr):
    match = re.fullmatch(r"""(['"`])([^'"`]*?)\1""", expr)
    assert match and "${" not in expr, f"Unresolved web route expression: {expr}"
    return match[2]


def test_route_reader_discovers_a_new_feature_under_an_import_alias(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    (app / "routeTree.ts").write_text("const lazy = [{ paths: ['/future-lazy/new'] }]")
    feature = tmp_path / "future.tsx"
    feature.write_text(
        "import { rootRoute as root } from './app/root-route'\n"
        "export const future = createRoute({path: '/future-area', getParentRoute: () => root})"
    )
    assert set(root_route_paths(tmp_path)) == {"/future-lazy/new", "/future-area"}


def test_web_routes_and_system_names_cannot_be_workspace_slugs():
    routes = {path.strip("/").split("/")[0] for path in root_route_paths()}
    assert {"login", "auth", "espace", "invitations", "workspaces", "booking"} <= routes
    protected = set(
        "login auth workspaces espace order assets api realms _matrix _kodera .well-known "
        "community admin staff kodera support security privacy status docs pricing settings "
        "invite invites join logout callback healthz".split()
    )
    public_directories = {item.name for item in (WEB.parent / "public").iterdir() if item.is_dir()}
    for slug in sorted(routes | protected | public_directories):
        if not slug or slug.startswith("$"):
            continue
        with pytest.raises(SelfServeValidationError, match="self-serve") as refused:
            parse_self_serve_request({"name": "Test workspace", "slug": slug})
        assert any(error["pointer"] == "/slug" for error in refused.value.errors), slug
    assert parse_self_serve_request({"name": "Test workspace", "slug": "login-studio"}).slug


def post(client, path, token, body, **meta):
    return client.post(
        path,
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {token}",
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
        **meta,
    )


@pytest.fixture
def shared(settings, http_signer, monkeypatch):
    _setup_shared_realm_settings(settings, http_signer)
    monkeypatch.setattr(endpoint, "signup_window", SlidingWindow())

    def credential(subject, email):
        return _mint_customer_jwt(
            http_signer, SHARED_ISSUER, subject=subject, email=email, email_verified=True
        )

    return credential


def client():
    return Client(HTTP_HOST="127.0.0.1")


@pytest.mark.django_db(transaction=True)
def test_milestone_a_cardless_signup_and_direct_sovereign_order(settings, shared):
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_APP_ORIGIN = APP
    owner = shared("workshop-owner", "owner@workshop.example")
    browser = client()
    created = post(browser, SIGNUP, owner, {"name": "Workshop", "slug": "workshop"})
    assert created.status_code == 201, created.content
    assert created.json()["redirect_path"] == "/workshop/workspace"
    assert created["Location"] == APP + "/workshop/workspace"
    org = created.json()["organisation_id"]
    order = post(
        browser,
        f"/api/v1/organisations/{org}/orders",
        owner,
        order_body(uuid4(), pack_code="sovereign", plan_code="sovereign", capacity_tier_code="S"),
    )
    assert order.status_code == 409, order.content
    assert order.json()["type"].endswith("/billing-disabled")
    assert not any(model.objects.exists() for model in (Order, Subscription, Invoice))


def test_shared_workspace_invitation_uses_allowlisted_app_origin(settings):
    settings.KODERA_APP_ORIGIN = APP
    settings.KODERA_MAIL_LINK_ORIGINS = {APP, COMMUNITY}
    base = COMMUNITY + "/invitations/accept"
    org = Organisation(id=uuid4(), slug="workshop", shared_realm=True, plan_tier="freemium_pme")
    community = Organisation(
        id=uuid4(), slug="community", is_default_community=True, plan_tier="community"
    )
    for target, origin in [(org, APP), (community, COMMUNITY)]:
        link = organisation_invitation_link(base, target)
        assert link == f"{origin}/invitations/accept/{target.id}/{target.slug}"
    settings.KODERA_MAIL_LINK_ORIGINS = {COMMUNITY}

    with pytest.raises(ClaimConfigurationError):
        organisation_invitation_link(base, org)


@pytest.mark.django_db(transaction=True)
def test_disposable_signup_domains_include_subdomains_and_operator_additions(settings, shared):
    settings.KODERA_SELF_SERVE_DISPOSABLE_DOMAINS = self_serve_disposable_domains(
        {"KODERA_SELF_SERVE_DISPOSABLE_DOMAINS": " Disposable.EXAMPLE, other.example "}
    )
    for i, domain in enumerate(["Mailinator.com", "mx.disposable.example", "yopmail.com"]):
        owner = shared(f"founder-{i}", f"owner@{domain}")
        response = post(client(), SIGNUP, owner, {"name": "Studio", "slug": "studio"})
        assert response.status_code == 403, response.content
    assert not Organisation.objects.filter(slug="studio").exists()
    owner = shared("founder-other", "owner@notdisposable.example")
    assert post(client(), SIGNUP, owner, {"name": "Studio", "slug": "studio"}).status_code == 201


@pytest.mark.django_db(transaction=True)
def test_passport_signup_rechecks_the_verified_accounts_email_domain(settings, shared):
    owner = shared("passport-owner", "owner@studio.example")
    created = post(client(), SIGNUP, owner, {"name": "Studio", "slug": "studio"})
    assert created.status_code == 201
    member = Membership.objects.get(organisation_id=created.json()["organisation_id"])
    token = issue_passport_session_token(
        secret=passport_secret(),
        user_id=member.user_id,
        active_organisation_id=member.organisation_id,
        email_verified=True,
    )
    settings.KODERA_SELF_SERVE_DISPOSABLE_DOMAINS = {"studio.example"}
    response = post(client(), SIGNUP, token, {"name": "Second", "slug": "second"})
    assert response.status_code == 403
    assert not Organisation.objects.filter(slug="second").exists()


@pytest.mark.django_db(transaction=True)
def test_signup_limits_follow_the_verified_person_and_the_trusted_peer(shared, monkeypatch):
    monkeypatch.setattr(endpoint, "SIGNUP_IDENTITY_LIMIT", 1)
    monkeypatch.setattr(endpoint, "SIGNUP_IP_LIMIT", 2)
    alice = shared("founder-alice", "alice@studio.example")
    bob = shared("founder-bob", "bob@studio.example")
    browser = client()

    def attempt(owner, peer, forwarded):
        return post(browser, SIGNUP, owner, {}, REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR=forwarded)

    assert attempt(alice, "192.0.2.1", "192.0.2.10").status_code == 422
    identity_limit = attempt(alice, "192.0.2.2", "192.0.2.11")
    assert identity_limit.status_code == 429 and int(identity_limit["Retry-After"]) > 0
    assert identity_limit["RateLimit-Remaining"] == "0"
    assert attempt(bob, "192.0.2.1", "192.0.2.12").status_code == 422
    charlie = shared("founder-charlie", "charlie@studio.example")
    peer_limit = attempt(charlie, "192.0.2.1", "192.0.2.13")
    assert peer_limit.status_code == 429 and int(peer_limit["Retry-After"]) > 0
    assert peer_limit["RateLimit-Limit"] == "2"
    assert attempt(charlie, "192.0.2.3", "192.0.2.13").status_code == 422


@pytest.mark.django_db(transaction=True)
def test_two_independent_invites_race_for_the_fifth_seat(shared):
    owner_email = "owner@studio.example"
    owner = shared("studio-owner", owner_email)
    created = post(client(), SIGNUP, owner, {"name": "Studio", "slug": "studio"})
    assert created.status_code == 201, created.content
    org = UUID(created.json()["organisation_id"])

    def invite(uses):
        return create_link(
            verified=_verified_shared("studio-owner", owner_email),
            organisation_id=org,
            expires_at=timezone.now() + timedelta(days=1),
            max_uses=uses,
            role="org_member",
            channel_id=None,
            request_id=str(uuid4()),
        )

    def member(n):
        return shared(f"studio-member-{n}", f"member{n}@studio.example")

    def redeem(token, code):
        return post(client(), "/api/v1/workspace-invites/redeem", token, {"code": code})

    _, first = invite(3)
    for n in range(2, 5):
        assert redeem(member(n), first).status_code == 200
    assert Membership.objects.filter(organisation_id=org, state="active").count() == 4

    start = Barrier(2)

    def compete(token, code):
        try:
            # Rendezvous inside the two real request transactions, before either has a seat.
            rendezvoused = False

            def overlap(execute, sql, params, many, context):
                nonlocal rendezvoused
                if not rendezvoused and context["connection"].in_atomic_block:
                    rendezvoused = True
                    start.wait(timeout=10)
                return execute(sql, params, many, context)

            with connections["default"].execute_wrapper(overlap):
                response = redeem(token, code)
            assert rendezvoused
            return response.status_code, response.json()
        finally:
            connections.close_all()

    contenders = [(member(n), *invite(1)) for n in (5, 6)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        workers = [pool.submit(compete, token, code) for token, _, code in contenders]
        results = [worker.result(timeout=15) for worker in workers]
    assert sorted(status for status, _ in results) == [200, 402], results
    assert next(body for status, body in results if status == 402)["quota_key"] == "seats"
    assert Membership.objects.filter(organisation_id=org, state="active").count() == 5
    assert sorted(
        WorkspaceInviteLink.objects.filter(
            pk__in=[link.pk for _, link, _ in contenders]
        ).values_list("uses_count", flat=True)
    ) == [0, 1]
