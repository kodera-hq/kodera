"""createTenant: docs/specs/QUICK_WORKSPACE.md §4, cases 1 to 6 of the spec's C2b acceptance.

Real signed tokens, the real route and the disposable PostgreSQL test database, billing off unless
a case turns it on. Every response is checked against contracts/core-api.openapi.yaml by `call`,
problem documents included. Each refusal is shown to write nothing, across every table the step
may write and every table it must never write.
"""

import json
import threading
import time

import pytest
from django.db import connection
from django.test import Client
from order_fixtures import commit_order
from test_accepted_agreements import documents
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import raw_update
from test_workspace_onboarding import (
    STARTER_CATEGORIES,
    STARTER_CHANNELS,
    call,
    http_signer as http_signer,
    initialise,
    model,
    path,
    problem,
    starter,
    unconfirmed,
    w as w,
)

from apps.billing.models import Pack

pytestmark = pytest.mark.django_db(transaction=True)

TENANTS = "/organisations/{organisation_id}/tenants"
KEY = "00000000-0000-4000-8000-000000000501"
OTHER_KEY = "00000000-0000-4000-8000-000000000502"
THIRD_KEY = "00000000-0000-4000-8000-000000000503"
CGV = {"code": "cgv", "version": "0.0", "locale": "fr"}
DPA = {"code": "dpa", "version": "0.0", "locale": "fr"}
WRITTEN = (
    ("tenancy", "Tenant"),
    ("legal", "Dpa"),
    ("legal", "Acceptance"),
    ("workspaces", "Workspace"),
    ("workspaces", "Category"),
    ("workspaces", "Channel"),
    ("workspaces", "ResourcePolicy"),
    ("engine_intents", "EngineChannelSetHead"),
    ("billing", "Order"),
    ("billing", "Subscription"),
    ("billing", "Invoice"),
    ("billing", "BillingProfile"),
    ("billing", "PaymentLink"),
    ("jobs", "Job"),
)
ACTIONS = ("tenant.ordered", "dpa.accepted", "workspace.initialised")


def offer():
    """The placeholder catalogue and documents, and the unbilled pack the offer sells
    (apps/billing/catalogue/offer.toml), whose `S` tier the placeholder already has."""
    documents()
    Pack.objects.get_or_create(
        code="workspace",
        defaults={
            "name": "Kodera",
            "apps": ["visio", "messaging"],
            "profile_ref": "workspace/1.0",
            "available": True,
        },
    )


@pytest.fixture
def u(w):
    """The workspace world of test_workspace_onboarding, billing off and the offer loaded: alpha is
    active, its setup ready, and it holds no tenant and no workspace."""
    w.settings.KODERA_BILLING_ENABLED = False
    offer()
    return w


def body(**overrides):
    return {"name": "Alpha", "slug": "alpha-team", "legal_acceptances": [CGV, DPA]} | overrides


def create(w, who, key=KEY, organisation=None, payload=None, **overrides):
    """POST createTenant; an override named `HTTP_…` is a header, any other a body member."""
    organisation = organisation or w.alpha
    headers = {name: overrides.pop(name) for name in list(overrides) if name.startswith("HTTP_")}
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(
        path(TENANTS, organisation),
        data=json.dumps(payload if payload is not None else body(**overrides)),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + who.credential,
        **headers,
    )
    return call(response, TENANTS, "post")


def counts():
    found = {f"{app}.{name}": model(app, name).objects.count() for app, name in WRITTEN}
    events = model("audit", "AuditEvent").objects.filter(action__in=ACTIONS)
    found |= {action: events.filter(action=action).count() for action in ACTIONS}
    return found


def head_revision(organisation):
    row = model("engine_intents", "EngineChannelSetHead").objects.filter(
        organisation_id=organisation.id
    )
    return row.values_list("revision", flat=True).first() or 0


# --- case 1: the one step ------------------------------------------------------------------------


def test_case1_billing_off_an_owner_creates_the_tenant_its_agreements_and_its_workspace(u):
    before = counts()
    revision = head_revision(u.alpha)
    emitted = model("engine_intents", "EngineChannelSet").objects.filter(organisation_id=u.alpha.id)
    sets_before = emitted.count()

    created = create(u, u.owner, HTTP_USER_AGENT="synthetic-agent/1.0")

    assert created.status_code == 201, created.content
    tenant = model("tenancy", "Tenant").objects.get(organisation_id=u.alpha.id)
    assert created["Location"] == f"/api/v1/tenants/{tenant.id}"
    answer = created.json()
    assert answer["tenant"]["id"] == str(tenant.id)
    assert (
        tenant.status,
        tenant.slug,
        tenant.name,
        tenant.locale,
        tenant.pack_code,
        tenant.capacity_tier_code,
        list(tenant.apps),
        tenant.profile_ref,
        tenant.realm,
    ) == (
        "ordered",
        "alpha-team",
        "Alpha",
        "fr",
        "workspace",
        "S",
        ["visio", "messaging"],
        "workspace/1.0",
        u.alpha.slug,
    )
    dpa = model("legal", "Dpa").objects.get(organisation_id=u.alpha.id)
    assert (dpa.state, dpa.tenant_id, dpa.pack_code) == ("accepted", tenant.id, "workspace")
    acceptances = model("legal", "Acceptance").objects.filter(organisation_id=u.alpha.id)
    assert sorted(row.document.code for row in acceptances) == ["cgv", "dpa"]
    assert {(row.order_id, row.tenant_id) for row in acceptances} == {(None, tenant.id)}
    assert {row.user_agent for row in acceptances} == {"synthetic-agent/1.0"}
    data = starter(u)
    assert answer["workspace_id"] == str(data.workspace.id)
    assert (data.categories, data.channels) == (STARTER_CATEGORIES, STARTER_CHANNELS)
    # Revisions are monotonic, not counters (tests/test_engine_channel_sets.py).
    assert head_revision(u.alpha) > revision, "the channel set was not emitted"
    # Exactly one emission for the new workspace: one more set row, and it is the head's.
    assert emitted.count() == sets_before + 1, "the channel set was not emitted exactly once"
    assert emitted.order_by("-revision").first().revision == head_revision(u.alpha)
    ordered = model("audit", "AuditEvent").objects.get(action="tenant.ordered")
    assert ordered.metadata == {"slug": "alpha-team", "billing": "off"}
    after = counts()
    # The channel-set head row may predate the step; its revision is checked above.
    grown = {name for name in after if after[name] != before[name]}
    grown.discard("engine_intents.EngineChannelSetHead")
    assert grown == {
        "tenancy.Tenant",
        "legal.Dpa",
        "legal.Acceptance",
        "workspaces.Workspace",
        "workspaces.Category",
        "workspaces.Channel",
        "workspaces.ResourcePolicy",
        *ACTIONS,
    }, "createTenant wrote a billing row or missed one of its own"
    assert all(after[action] == 1 for action in ACTIONS)


# --- case 2: a DPA the wizard left ---------------------------------------------------------------


def test_case2_a_dpa_already_generated_is_reused_and_one_from_an_older_template_superseded(u):
    from order_fixtures import owner_token

    from apps.legal import services as legal

    reused, _ = legal.generate_dpa(
        verified=owner_token(u.alpha.issuer, "alpha-owner"),
        organisation_id=u.alpha.id,
        pack_code="workspace",
        locale="fr",
        tenant_id=None,
    )
    created = create(u, u.owner)
    assert created.status_code == 201, created.content
    dpas = model("legal", "Dpa").objects.filter(organisation_id=u.alpha.id)
    assert list(dpas.values_list("id", "state")) == [(reused.id, "accepted")]


def test_case2_a_dpa_from_a_template_no_longer_in_force_is_superseded(u):
    from datetime import timedelta

    from order_fixtures import owner_token

    from apps.legal import services as legal

    older, _ = legal.generate_dpa(
        verified=owner_token(u.alpha.issuer, "alpha-owner"),
        organisation_id=u.alpha.id,
        pack_code="workspace",
        locale="fr",
        tenant_id=None,
    )
    template = model("legal", "LegalDocument").objects.get(id=older.template_id)
    text = "Synthetic DPA, version 0.1."
    model("legal", "LegalDocument").objects.create(
        code="dpa",
        version="0.1",
        locale="fr",
        title=template.title,
        sha256=legal.text_digest(text),
        text=text,
        sub_processors=template.sub_processors,
        published_at=template.published_at + timedelta(seconds=1),
    )
    newer = [CGV, {**DPA, "version": "0.1"}]
    created = create(u, u.owner, legal_acceptances=newer)
    assert created.status_code == 201, created.content
    rows = dict(
        model("legal", "Dpa").objects.filter(organisation_id=u.alpha.id).values_list("id", "state")
    )
    assert rows.pop(older.id) == "superseded"
    assert list(rows.values()) == ["accepted"]


# --- case 3: the replay --------------------------------------------------------------------------


def test_case3_the_same_key_and_body_replay_the_first_answer_and_write_nothing(u):
    first = create(u, u.owner)
    assert first.status_code == 201, first.content
    after_first = counts()
    again = create(u, u.owner)
    assert again.status_code == 201
    assert again.headers.get("Idempotency-Replayed") == "true"
    assert again.content == first.content
    assert counts() == after_first


def test_case3_the_same_key_with_another_body_is_a_reuse(u):
    assert create(u, u.owner).status_code == 201
    after_first = counts()
    problem(create(u, u.owner, slug="alpha-other"), 409, "idempotency-key-reuse")
    assert counts() == after_first


def test_case3_a_new_key_once_a_tenant_exists_is_tenant_exists(u):
    assert create(u, u.owner).status_code == 201
    after_first = counts()
    refused = problem(create(u, u.owner, key=OTHER_KEY, slug="alpha-other"), 409, "tenant-exists")
    assert "workspace" in refused["detail"]
    assert counts() == after_first


# --- case 4: each refusal writes nothing ---------------------------------------------------------


@pytest.mark.parametrize("who", ["admin", "billing", "member"])
def test_case4_a_member_who_is_not_the_owner_is_forbidden_and_recorded(u, who):
    before = counts()
    problem(create(u, getattr(u, who)), 403, "forbidden")
    denied = model("audit", "AuditEvent").objects.get(action="authz.denied")
    assert denied.metadata.get("required_scope") == "tenant:create"
    assert counts() == before


def test_case4_a_member_is_forbidden_whatever_the_switch_says(u):
    u.settings.KODERA_BILLING_ENABLED = True
    problem(create(u, u.member), 403, "forbidden")


def test_case4_a_staff_token_is_forbidden(u):
    before = counts()
    problem(create(u, u.staff), 403, "forbidden")
    assert counts() == before


def test_case4_a_stranger_and_another_organisation_s_owner_get_404(u):
    before = counts()
    problem(create(u, u.stranger), 404, "not-found")
    problem(create(u, u.foreigner), 404, "not-found")
    assert counts() == before


def test_case4_billing_on_is_billing_enabled_and_never_stored(u):
    u.settings.KODERA_BILLING_ENABLED = True
    before = counts()
    refused = problem(create(u, u.owner), 409, "billing-enabled")
    assert "placeOrder" in refused["detail"]
    assert counts() == before
    # Not stored: the same key is judged afresh once billing is off.
    u.settings.KODERA_BILLING_ENABLED = False
    assert create(u, u.owner).status_code == 201


def test_case4_an_answer_stored_before_billing_came_on_is_replayed(u):
    first = create(u, u.owner)
    assert first.status_code == 201
    u.settings.KODERA_BILLING_ENABLED = True
    again = create(u, u.owner)
    assert (again.status_code, again.content) == (201, first.content)


def test_case4_an_organisation_that_is_not_active_is_refused(u):
    raw_update(u.alpha, state="suspended")
    before = counts()
    refused = problem(create(u, u.owner), 409, "invalid-state-transition")
    assert refused["allowed_states"] == ["active"]
    assert counts() == before


def test_case4_a_setup_that_is_not_ready_is_refused(u):
    delta, owner = unconfirmed(u)
    before = counts()
    refused = problem(create(u, owner, organisation=delta), 409, "invalid-state-transition")
    assert refused["allowed_states"] == ["ready"]
    assert counts() == before


@pytest.mark.parametrize("slug", ["ab", "Alpha", "-alpha", "www", "staging", "matrix", "console"])
def test_case4_a_slug_that_fails_the_pattern_or_is_reserved_is_a_validation_error(u, slug):
    before = counts()
    refused = problem(create(u, u.owner, slug=slug), 422, "validation-error")
    assert refused["errors"] == [{"pointer": "/slug", "code": "format"}]
    assert counts() == before


def test_case4_a_taken_slug_is_slug_taken_with_suggestions(u):
    from test_accepted_agreements import ordered_tenant

    held = ordered_tenant(u.bravo)
    taken = model("tenancy", "Tenant").objects.get(id=held.id).slug
    before = counts()
    refused = problem(create(u, u.owner, slug=taken), 409, "slug-taken")
    assert refused["suggestions"] == [f"{taken}-2", f"{taken}-3", f"{taken}-4"]
    assert counts() == before


@pytest.mark.parametrize("document", [CGV, DPA])
def test_case4_a_version_not_in_force_is_a_validation_error_naming_the_one_that_is(u, document):
    stale = {**document, "version": "9.9"}
    acceptances = [stale if each is document else each for each in (CGV, DPA)]
    before = counts()
    refused = problem(create(u, u.owner, legal_acceptances=acceptances), 422, "validation-error")
    assert refused["errors"] == [
        {
            "pointer": "/legal_acceptances",
            "code": f"{document['code']}_not_in_force",
            "detail": "in force: 0.0",
        }
    ]
    assert counts() == before


@pytest.mark.parametrize(
    "acceptances",
    [[CGV], [CGV, CGV], [CGV, {**DPA, "code": "sla"}], [CGV, {**DPA, "extra": 1}]],
)
def test_case4_the_agreements_must_be_the_cgv_and_the_dpa_once_each(u, acceptances):
    before = counts()
    problem(create(u, u.owner, legal_acceptances=acceptances), 422, "validation-error")
    assert counts() == before


@pytest.mark.parametrize(
    ("overrides", "pointer", "code"),
    [
        ({"name": "  "}, "/name", "format"),
        ({"name": "Alpha\x07"}, "/name", "format"),
        ({"name": "Alpha\u2028Team"}, "/name", "format"),
        ({"slug": None}, "/slug", "type"),
        ({"slug": "a" * 65}, "/slug", "format"),
        ({"legal_acceptances": None}, "/legal_acceptances", "type"),
    ],
)
def test_case4_a_body_of_the_wrong_shape_names_the_member(u, overrides, pointer, code):
    before = counts()
    refused = problem(create(u, u.owner, **overrides), 422, "validation-error")
    assert {"pointer": pointer, "code": code} in refused["errors"], refused["errors"]
    payload = body()
    del payload["legal_acceptances"], payload["slug"]
    missing = problem(create(u, u.owner, key=OTHER_KEY, payload=payload), 422, "validation-error")
    assert {"pointer": "/legal_acceptances", "code": "required"} in missing["errors"]
    assert {"pointer": "/slug", "code": "required"} in missing["errors"]
    assert counts() == before


def test_a_name_with_a_no_break_space_is_a_name(u):
    created = create(u, u.owner, name="Café\u00a0du Port")
    assert created.status_code == 201, created.content
    assert created.json()["tenant"]["name"] == "Café\u00a0du Port"


def test_case4_the_pack_not_available_is_service_unavailable_and_not_stored(u):
    Pack.objects.filter(code="workspace").update(available=False)
    before = counts()
    refused = problem(create(u, u.owner), 503, "service-unavailable")
    assert refused["retry_after_s"] == 60
    assert counts() == before
    Pack.objects.filter(code="workspace").update(available=True)
    assert create(u, u.owner).status_code == 201


# --- case 5: the race ----------------------------------------------------------------------------


@pytest.mark.parametrize("code", ["cgv", "dpa"])
def test_case4_a_template_missing_is_service_unavailable_and_not_stored(u, monkeypatch, code):
    # A published document is never deleted, so the lookup is stubbed: a deployment that has not
    # loaded the template answers 503, before anything is written, whatever the request says.
    from apps.billing import unbilled as service

    found = service.in_force
    monkeypatch.setattr(
        service, "in_force", lambda **kwargs: None if kwargs["code"] == code else found(**kwargs)
    )
    before = counts()
    response = create(u, u.owner)
    problem(response, 503, "service-unavailable")
    assert response.headers["Retry-After"] == "60"
    assert counts() == before
    monkeypatch.undo()
    assert create(u, u.owner).status_code == 201


def test_case4_an_owner_demoted_after_authorisation_is_refused_under_the_lock(u, monkeypatch):
    """The view authorises before the replay store; the step reads the role again under the
    organisation lock, so agreements are never signed on a role the caller no longer holds."""
    from apps.billing.api import create_tenant as route

    authorise = route.authorise

    def then_demote(**kwargs):
        judged = authorise(**kwargs)
        # The organisation keeps an active owner (the database refuses to lose its last one).
        raw_update(u.admin.member, role="org_owner")
        raw_update(u.owner.member, role="org_admin")
        return judged

    monkeypatch.setattr(route, "authorise", then_demote)
    before = counts()
    problem(create(u, u.owner), 403, "forbidden")
    denied = model("audit", "AuditEvent").objects.get(action="authz.denied")
    assert denied.metadata.get("required_scope") == "tenant:create"
    assert counts() == before
    # Not stored: once the owner is the owner again, the same key is judged afresh.
    monkeypatch.setattr(route, "authorise", authorise)
    raw_update(u.owner.member, role="org_owner")
    assert create(u, u.owner).status_code == 201


def test_case4_billing_on_is_refused_in_the_step_when_the_view_skipped_the_switch(u, monkeypatch):
    """A stored answer that expires between the view's look and the store's: the step refuses."""
    from apps.billing.api import create_tenant as route

    monkeypatch.setattr(route, "holds_answer", lambda *args, **kwargs: True)
    u.settings.KODERA_BILLING_ENABLED = True
    before = counts()
    problem(create(u, u.owner), 409, "billing-enabled")
    assert counts() == before
    monkeypatch.undo()
    u.settings.KODERA_BILLING_ENABLED = False
    assert create(u, u.owner).status_code == 201


def test_the_tenants_path_allows_get_and_post(u):
    response = u.client.delete(
        path(TENANTS, u.alpha), HTTP_AUTHORIZATION="Bearer " + u.owner.credential
    )
    assert response.status_code == 405
    assert response.headers["Allow"] == "GET, POST"
    assert response.json()["allowed"] == ["GET", "POST"]


def test_case5_two_creations_at_once_with_different_slugs_make_one_tenant(u, monkeypatch):
    """Two connections, two keys, two slugs. The first request to check for a live tenant then
    waits, on its own connection, until it sees the other blocked on the organisation lock in
    pg_locks, or until the other has checked too. Under the lock, taken first, the other can only
    be blocked: that wait is the proof that both requests were in before the first committed. With
    the lock taken after the check, or dropped, both pass the check and two tenants are written."""
    from apps.billing import unbilled as service

    holds = service.holds_live_tenant
    checked = []
    saw_waiter = []
    guard = threading.Lock()

    def check_then_wait(organisation_id):
        found = holds(organisation_id)
        with guard:
            checked.append(found)
            first = len(checked) == 1
        deadline = time.monotonic() + 10
        while first and time.monotonic() < deadline:
            with guard:
                if len(checked) == 2:
                    break
            with connection.cursor() as cursor:
                # This organisation's lock (apps/jobs/locks.py's key), in this database only.
                cursor.execute(
                    "SELECT count(*) FROM pg_locks"
                    " WHERE locktype = 'advisory' AND NOT granted AND classid = 1"
                    " AND objid::bigint = (hashtext(%s::text)::bigint & 4294967295)"
                    " AND database = (SELECT oid FROM pg_database"
                    " WHERE datname = current_database())"
                    " AND pid <> pg_backend_pid()",
                    [str(organisation_id)],
                )
                if cursor.fetchone()[0]:
                    saw_waiter.append(True)
                    break
            time.sleep(0.01)
        return found

    monkeypatch.setattr(service, "holds_live_tenant", check_then_wait)
    results = {}

    def run(name, key, slug):
        try:
            client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
            results[name] = client.post(
                path(TENANTS, u.alpha),
                data=json.dumps(body(slug=slug)),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer " + u.owner.credential,
                HTTP_IDEMPOTENCY_KEY=key,
            )
        finally:
            connection.close()

    threads = [
        threading.Thread(target=run, args=("one", KEY, "alpha-one")),
        threading.Thread(target=run, args=("two", OTHER_KEY, "alpha-two")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(r.status_code for r in results.values()) == [201, 409], {
        name: (r.status_code, r.content[:200]) for name, r in results.items()
    }
    # The winner saw the loser blocked on the lock, and the loser checked after the commit.
    assert saw_waiter == [True] and checked == [False, True], (saw_waiter, checked)
    for response in results.values():
        call(response, TENANTS, "post")
    loser = next(r for r in results.values() if r.status_code == 409)
    assert loser.json()["type"].endswith("/tenant-exists")
    assert model("tenancy", "Tenant").objects.filter(organisation_id=u.alpha.id).count() == 1
    assert model("workspaces", "Workspace").objects.filter(organisation_id=u.alpha.id).count() == 1


# --- case 6: a workspace an earlier order left ---------------------------------------------------


def test_case6_a_workspace_left_by_a_cancelled_order_is_kept_and_named(u):
    u.settings.KODERA_BILLING_ENABLED = True
    placed = commit_order(u.alpha.id, u.alpha.issuer, "alpha-owner")
    assert initialise(u, u.owner, key=THIRD_KEY).status_code == 201
    workspace = model("workspaces", "Workspace").objects.get(organisation_id=u.alpha.id)
    model("billing", "Order").objects.filter(id=placed.order.id).update(state="cancelled")
    model("tenancy", "Tenant").objects.filter(id=placed.order.tenant_id).update(status="deleted")
    u.settings.KODERA_BILLING_ENABLED = False
    revision = head_revision(u.alpha)
    channels = model("workspaces", "Channel").objects.count()

    created = create(u, u.owner)

    assert created.status_code == 201, created.content
    assert created.json()["workspace_id"] == str(workspace.id)
    assert model("workspaces", "Workspace").objects.count() == 1
    assert model("workspaces", "Channel").objects.count() == channels
    assert head_revision(u.alpha) == revision, "an existing workspace's set was re-emitted"
    events = model("audit", "AuditEvent").objects.filter(action="workspace.initialised")
    assert events.count() == 1


def test_the_route_still_lists_tenants(u):
    assert create(u, u.owner).status_code == 201
    listed = u.client.get(path(TENANTS, u.alpha), HTTP_AUTHORIZATION="Bearer " + u.owner.credential)
    assert listed.status_code == 200
    assert [row["slug"] for row in listed.json()["data"]] == ["alpha-team"]
