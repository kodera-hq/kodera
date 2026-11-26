"""Admission on the shared console, including the last paid-capacity boundary in PostgreSQL."""

import json
import re
from collections import defaultdict
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Event
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection, connections
from django.test import Client
from django.utils import timezone
from test_customer_azp_allowlist import startup
from test_customer_persistence_concurrency import blocked_by, session
from test_place_order_http import order_body
from test_s3_beta_self_serve_and_sovereign import (
    SHARED_ISSUER,
    _mint_customer_jwt,
    _setup_shared_realm_settings,
    _verified_shared,
)
from test_workspace_templates_warm_pool import VALID_CLAIM_PAYLOAD

from apps.billing.models import (
    CreatorConnectAccount,
    Invoice,
    Order,
    Subscription,
    VipMembershipEntitlement,
    VipTierOffer,
    WorkspaceBoostGrant,
)
from apps.identity.community import ensure_shared_realm_identity
from apps.identity.passport import passport_secret
from apps.orgs.claim_configuration import ClaimConfigurationError
from apps.orgs.intake_services import SLUG
from apps.orgs.invitation_mail import organisation_invitation_link
from apps.orgs.models import Membership, Organisation
from apps.workspaces import moderation
from apps.workspaces.api import self_serve as endpoint
from apps.workspaces.moderation import create_link
from apps.workspaces.self_serve import SelfServeValidationError, parse_self_serve_request
from apps.workspaces.warm_pool import (
    SLUG_PATTERN,
    InstantClaimInputError,
    parse_instant_claim_request,
    workspace_slug_is_reserved,
)
from config.environment import app_origin, self_serve_disposable_domains
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
    children = defaultdict(list)
    for file in sorted(web.rglob("*.ts*")):
        if ".test." in file.name or file.suffix not in {".ts", ".tsx"}:
            continue
        source = file.read_text()
        if "getParentRoute" not in source:
            continue
        module = file.with_suffix("")
        imports = {}
        for names, path in re.findall(
            r"""\bimport\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]""", source
        ):
            for spec in names.split(","):
                name, _, alias = spec.strip().partition(" as ")
                imports[alias or name] = ((file.parent / path).resolve(), name)
        # Account for every parent declaration so unsupported factories fail the reservation check.
        routes = re.findall(
            r"(?:\bconst\s+(\w+)\s*=\s*)?\bcreateRoute\s*\(\s*\{(.*?)\}\s*\)", source, re.S
        )
        assert len(routes) == len(re.findall(r"\bgetParentRoute\s*:", source)), (
            f"Unresolved route factory in {file}"
        )
        for name, options in routes:
            parent = re.search(r"\bgetParentRoute\s*:\s*\(\)\s*=>\s*(\w+)", options)
            assert parent, f"Unresolved route parent in {file}"
            key = imports.get(parent[1], (module, parent[1]))
            children[key].append((module, name, options))

    root = (web / "app/root-route", "rootRoute")
    declared = {(module, name) for routes in children.values() for module, name, _ in routes}
    unresolved = children.keys() - declared - {root}
    assert not unresolved, (
        f"Resolve route parents before checking workspace reservations: {unresolved}"
    )
    layouts = [root]
    while layouts:
        for module, name, options in children[layouts.pop()]:
            path = re.search(r"\bpath\s*:\s*([^,\n}]+)", options)
            if not path:
                if re.search(r"\bpath\s*,", options):
                    # The two lazy placeholder factories expand the paths handled above or under $org.
                    assert module == web / "app/lazyRouteTree"
                else:
                    assert name and re.search(r"\bid\s*:", options), (
                        f"Unresolved layout in {module}"
                    )
                    layouts.append((module, name))
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


def test_route_reader_follows_pathless_layouts_and_import_aliases(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    (app / "routeTree.ts").write_text("const lazy = [{ paths: ['/future-lazy/new'] }]")
    (app / "layouts.ts").write_text(
        "import { rootRoute as root } from './root-route'\n"
        "const layout = createRoute({getParentRoute: () => root, id: 'shell'})\n"
        "export const inner = createRoute({id: 'inner', getParentRoute: () => layout})"
    )
    (tmp_path / "future.tsx").write_text(
        "import { inner as parent } from './app/layouts'\n"
        "const future = createRoute({path: '/future-area', getParentRoute: () => parent})\n"
        "const child = createRoute({path: 'details', getParentRoute: () => future})"
    )
    assert set(root_route_paths(tmp_path)) == {"/future-lazy/new", "/future-area"}


def test_web_routes_and_system_names_cannot_be_workspace_slugs():
    routes = {path.strip("/").split("/")[0] for path in root_route_paths()}
    assert {"login", "auth", "espace", "invitations", "workspaces", "booking"} <= routes
    protected = set(
        "login auth workspaces espace order assets api realms _matrix _kodera .well-known "
        "community admin staff kodera support security privacy status docs pricing settings "
        "invite invites join logout callback healthz xn--studio synth-studio".split()
    )
    public_directories = {item.name for item in (WEB.parent / "public").iterdir() if item.is_dir()}
    for slug in sorted(routes | protected | public_directories):
        if not slug or slug.startswith("$"):
            continue
        assert workspace_slug_is_reserved(slug), slug
        with pytest.raises(SelfServeValidationError, match="self-serve") as refused:
            parse_self_serve_request({"name": "Test workspace", "slug": slug})
        code = "slug_reserved" if SLUG.fullmatch(slug) else "format"
        assert {"pointer": "/slug", "code": code} in refused.value.errors, slug
        if SLUG_PATTERN.fullmatch(slug):
            with pytest.raises(InstantClaimInputError) as claim:
                parse_instant_claim_request(
                    json.dumps({**VALID_CLAIM_PAYLOAD, "slug": slug}).encode()
                )
            assert claim.value.errors == [("/slug", "reserved")], slug
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
@pytest.mark.parametrize(
    "origins, canonical, headers",
    [
        (APP, "", {}),
        (f"{COMMUNITY},{APP}", APP, {"HTTP_ORIGIN": COMMUNITY}),
    ],
)
def test_milestone_a_cardless_signup_and_direct_sovereign_order(
    settings, shared, origins, canonical, headers
):
    settings.KODERA_BILLING_ENABLED = False
    settings.KODERA_CONSOLE_ORIGINS = origins
    settings.KODERA_APP_ORIGIN = app_origin(
        {"KODERA_APP_ORIGIN": canonical, "KODERA_CONSOLE_ORIGINS": origins}
    )
    owner = shared("workshop-owner", "owner@workshop.example")
    browser = client()
    created = post(browser, SIGNUP, owner, {"name": "Workshop", "slug": "workshop"}, **headers)
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


@pytest.mark.parametrize(
    "origins, canonical",
    [
        (f"{COMMUNITY},{APP}", ""),
        (f"{COMMUNITY},{APP}", "https://other.example.org"),
        (COMMUNITY, APP),
    ],
)
@pytest.mark.parametrize("profile", ["config.settings.customer_http", "config.settings.deploy"])
def test_inconsistent_workspace_origin_refuses_startup(http_signer, profile, origins, canonical):
    result = startup(
        profile, http_signer, KODERA_APP_ORIGIN=canonical, KODERA_CONSOLE_ORIGINS=origins
    )
    assert "KODERA_APP_ORIGIN" in result["refused"]


@pytest.mark.django_db(transaction=True)
def test_unbilled_workspace_refuses_monetization_writes(settings, shared):
    settings.KODERA_BILLING_ENABLED = False
    owner = shared("studio-owner", "owner@studio.example")
    browser = client()
    created = post(browser, SIGNUP, owner, {"name": "Studio", "slug": "studio"})
    assert created.status_code == 201, created.content
    org = created.json()["organisation_id"]
    base = f"/api/v1/organisations/{org}/workspace/monetization/"
    for operation in ("boosts/checkout", "connect/onboarding", "vip-tiers", "vip-passes/checkout"):
        refused = post(browser, base + operation, owner, {})
        assert refused.status_code == 409, (operation, refused.content)
        assert refused.json()["type"].endswith("/billing-disabled")
    assert not any(
        model.objects.exists()
        for model in (
            CreatorConnectAccount,
            Invoice,
            WorkspaceBoostGrant,
            VipTierOffer,
            VipMembershipEntitlement,
        )
    )


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
        assert response.json()["code"] == "disposable-email-not-allowed"
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
    assert response.json()["code"] == "disposable-email-not-allowed"
    assert not Organisation.objects.filter(slug="second").exists()
    member.user.email = "legacy local part@studio.invalid"
    member.user.save(update_fields=["email"])
    accepted = post(client(), SIGNUP, token, {"name": "Second", "slug": "second"})
    assert accepted.status_code == 201, accepted.content


@pytest.mark.django_db(transaction=True)
def test_signup_limits_follow_the_verified_person_and_the_trusted_peer(shared, monkeypatch):
    monkeypatch.setattr(endpoint, "SIGNUP_IDENTITY_LIMIT", 1)
    monkeypatch.setattr(endpoint, "SIGNUP_IP_LIMIT", 2)
    alice = shared("founder-alice", "alice@studio.example")
    bob = shared("founder-bob", "bob@studio.example")
    browser = client()

    def attempt(owner, peer, forwarded):
        return post(browser, SIGNUP, owner, {}, REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR=forwarded)

    for _ in range(3):
        assert attempt("invalid", "192.0.2.1", "192.0.2.10").status_code == 401
    assert attempt(alice, "192.0.2.1", "192.0.2.10").status_code == 422
    identity_limit = attempt(alice, "192.0.2.2", "192.0.2.11")
    assert identity_limit.status_code == 429 and int(identity_limit["Retry-After"]) > 0
    assert identity_limit["RateLimit-Remaining"] == "0"
    assert attempt(bob, "192.0.2.1", "192.0.2.12").status_code == 422
    charlie = shared("founder-charlie", "charlie@studio.example")
    peer_limit = attempt(charlie, "192.0.2.1", "192.0.2.13")
    assert peer_limit.status_code == 429 and int(peer_limit["Retry-After"]) > 0
    assert peer_limit["RateLimit-Limit"] == "2"
    assert attempt("invalid", "192.0.2.1", "192.0.2.13").status_code == 401
    assert attempt(charlie, "192.0.2.3", "192.0.2.13").status_code == 422


@pytest.mark.django_db(transaction=True)
def test_two_independent_invites_race_for_the_fifth_seat(shared, monkeypatch):
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

    # Binding a new identity also locks the organisation. Bind both first so the only
    # competing association write in redeem_link is the membership insert for the seat.
    organisation = Organisation.objects.get(pk=org)
    for n in (5, 6):
        assert ensure_shared_realm_identity(
            verified=_verified_shared(f"studio-member-{n}", f"member{n}@studio.example"),
            organisation_id=org,
            issuer=organisation.issuer,
            realm=organisation.realm,
        )
    holder = Future()
    waiter = Future()
    release = Event()
    create_member = moderation.create_from_workspace_link

    def contend_for_seat(**kwargs):
        assert connection.in_atomic_block
        pid = connection.connection.info.backend_pid
        if holder.done():
            waiter.set_result(pid)
            return create_member(**kwargs)
        # The insert trigger has acquired the organisation row lock in redeem_link.
        membership = create_member(**kwargs)
        holder.set_result(pid)
        assert release.wait(timeout=15)
        return membership

    monkeypatch.setattr(moderation, "create_from_workspace_link", contend_for_seat)

    def compete(token, code):
        try:
            return redeem(token, code)
        finally:
            connections.close_all()

    link_a, code_a = invite(1)
    link_b, code_b = invite(1)
    with session() as observer, ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(compete, member(5), code_a)
        try:
            holder_pid = holder.result(timeout=10)
            b = pool.submit(compete, member(6), code_b)
            blocked_by(observer, waiter.result(timeout=10), holder_pid)
        finally:
            release.set()
        winner = a.result(timeout=10)
        refused = b.result(timeout=10)
    assert winner.status_code == 200, winner.content
    assert refused.status_code == 402, refused.content
    assert refused.json()["quota_key"] == "seats"
    assert Membership.objects.filter(organisation_id=org, state="active").count() == 5
    link_a.refresh_from_db()
    link_b.refresh_from_db()
    assert (link_a.uses_count, link_b.uses_count) == (1, 0)
