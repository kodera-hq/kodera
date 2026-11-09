"""getWorkspace and initialiseWorkspace: docs/specs/PILOT_WORKSPACE_ONBOARDING.md §7, WS-01–WS-15.

Real signed tokens, the real HTTP views and the disposable PostgreSQL test database. Every response
a scenario receives is checked against contracts/core-api.openapi.yaml (WS-14) by `call`, problem
documents included. Each scenario names, in its failing assertion, what broke.
"""

import hashlib
import json
import threading
import time
from functools import cache
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import jsonschema_rs
import pytest
import yaml
from customer_http_fixtures import (
    configure,
    http_signer as http_signer,
    token,
    trust_entry,
)
from django.apps import apps
from django.db import connection, transaction
from django.test import Client
from django.urls import resolve
from django.utils import timezone
from order_fixtures import commit_order
from test_access_tokens import NOW, frozen_clock as frozen_clock
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor, anchor_models, identity, raw_update

from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)

ROOT = Path(__file__).resolve().parents[1]
READ = "/organisations/{organisation_id}/workspace"
INITIALISE = "/organisations/{organisation_id}/workspace/actions/initialise"
PROBLEMS = "https://kodera.io/problems/"
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
KEY = "00000000-0000-4000-8000-000000000001"
OTHER_KEY = "00000000-0000-4000-8000-000000000002"
INITIALISED = b'{"state":"initialised"}'


# --- the contract (WS-14) ---------------------------------------------------------------------


@cache
def contract():
    return yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())


def _component(kind, node):
    while "$ref" in node:
        node = contract()["components"][kind][node["$ref"].rsplit("/", 1)[-1]]
    return node


def _validator(schema):
    root = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **schema,
        "components": contract()["components"],
    }
    return jsonschema_rs.validator_for(root)


def _header_value(header, response, name):
    """A header's value as its schema reads it: an integer header (OpenAPI's `simple` style) is
    its decimal digits, and anything else is the string as sent."""
    value = response.headers[name]
    if header["schema"].get("type") == "integer" and value.isascii() and value.isdigit():
        return int(value)
    return value


def conformance_errors(response, template, method):
    """Why `response` is not one the contract declares for that operation, or []."""
    operation = contract()["paths"][template][method]
    status = str(response.status_code)
    if status not in operation["responses"]:
        return [f"{operation['operationId']} declares no {status}"]
    declared = _component("responses", operation["responses"][status])
    errors = []
    for name, header in declared.get("headers", {}).items():
        header = _component("headers", header)
        if header.get("required") and name not in response.headers:
            errors.append(f"{status} lacks its required {name} header")
        if name in response.headers and "schema" in header:
            if not _validator(header["schema"]).is_valid(_header_value(header, response, name)):
                errors.append(f"{status} {name} header does not match its schema")
    content = declared.get("content")
    if not content:
        if response.content:
            errors.append(f"{status} carries a body the contract does not declare")
        return errors
    media = response.headers.get("Content-Type", "").split(";")[0]
    if media not in content:
        return [*errors, f"{status} is {media}, not a declared media type"]
    body = json.loads(response.content)
    for error in _validator(content[media]["schema"]).iter_errors(body):
        errors.append(f"{status} body: {error.message}")
    return errors


def call(response, template, method):
    errors = conformance_errors(response, template, method)
    assert errors == [], "WS-14: a response does not conform to the contract: " + "; ".join(errors)
    return response


# --- the world --------------------------------------------------------------------------------


def model(app, name):
    return apps.get_model(app, name)


def person(w, organisation, role, subject, *, state="active"):
    user = w.models.User.objects.create(email=f"{subject}@customer.test")
    bound = identity(w.models, organisation, user, subject=subject)
    member = None
    if role is not None:
        member = w.models.Membership.objects.create(
            user=user,
            organisation=organisation,
            role=role,
            state=state,
            accepted_at=timezone.now(),
        )
    return SimpleNamespace(
        user=user,
        identity=bound,
        member=member,
        credential=token(w.signer, organisation.issuer, subject=subject),
    )


def realm_job(organisation, status, *, seed=None):
    """A realm_create job in `status`, written as the queue would leave it."""
    seed = seed or uuid4().hex
    Job = model("jobs", "Job")  # noqa: N806
    job = Job.objects.create(
        organisation_id=organisation.id,
        kind="realm_create",
        idempotency_key=hashlib.sha256(("key" + seed).encode()).hexdigest(),
        desired_spec_hash=hashlib.sha256(("spec" + seed).encode()).hexdigest(),
        max_attempts=3,
        actor_type="staff",
        status="queued",
    )
    if status == "needs_reconciliation":
        step = model("jobs", "JobStep").objects.create(
            job=job, seq=1, name="create_realm", retry_class="C", timeout_s=60
        )
        Job.objects.filter(pk=job.pk).update(
            status=status, unresolved_step=step, unresolved_operation_ref="awaiting tooling step 1"
        )
    elif status in ("leased", "running"):
        Job.objects.filter(pk=job.pk).update(
            status=status, runner_id="runner", lease_expires_at=timezone.now()
        )
    elif status == "failed":
        Job.objects.filter(pk=job.pk).update(status=status, error_code="step_failed")
    elif status != "queued":
        Job.objects.filter(pk=job.pk).update(status=status)
    return job


def confirm_owner(organisation):
    """What the intake recorder's `confirm_owner_contact` records (FIRST_OWNER_BOOTSTRAP.md §8.7):
    the `owner_claim.confirmed` event. The command itself is not on main yet."""
    staff = new_uuid7()
    model("audit", "AuditEvent").objects.create(
        action="owner_claim.confirmed",
        actor_type="staff",
        actor_id=staff,
        actor_label=f"urn:kodera:identity:{staff}",
        organisation_id=organisation.id,
        target_urn=f"urn:kodera:owner_claim:{new_uuid7()}",
        retention_class="standard",
    )


def unconfirmed(w):
    """An active organisation whose realm job succeeded, trusted, with its claim consumed (its owner
    holds the membership) and no `owner_claim.confirmed` yet."""
    delta, _, owners = anchor(w.models, slug="delta")
    w.trust.append(trust_entry(w.signer, delta.issuer))
    configure(w.settings, w.trust)
    user = owners[0].user
    identity(w.models, delta, user, subject="delta-owner")
    realm_job(delta, "succeeded")
    return delta, SimpleNamespace(credential=token(w.signer, delta.issuer, subject="delta-owner"))


@pytest.fixture
def w(transactional_db, settings, http_signer):
    models = anchor_models()
    alpha, _, owners = anchor(models, slug="alpha")
    bravo, _, _ = anchor(models, slug="bravo")
    charlie, _, _ = anchor(
        models, slug="charlie", state="prospect", owners=0, reservation_state="provisional"
    )
    trust = [
        trust_entry(http_signer, alpha.issuer),
        trust_entry(http_signer, bravo.issuer),
        trust_entry(http_signer, charlie.issuer),
        trust_entry(http_signer, STAFF_ISSUER, lane="staff"),
    ]
    configure(settings, trust)
    world = SimpleNamespace(
        models=models,
        settings=settings,
        trust=trust,
        signer=http_signer,
        alpha=alpha,
        bravo=bravo,
        charlie=charlie,
        client=Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"),
    )
    owner_user = owners[0].user
    world.owner = SimpleNamespace(
        user=owner_user,
        identity=identity(models, alpha, owner_user, subject="alpha-owner"),
        member=owners[0],
        credential=token(http_signer, alpha.issuer, subject="alpha-owner"),
    )
    world.admin = person(world, alpha, "org_admin", "alpha-admin")
    world.billing = person(world, alpha, "org_billing", "alpha-billing")
    world.member = person(world, alpha, "org_member", "alpha-member")
    world.stranger = person(world, alpha, None, "alpha-stranger")
    world.foreigner = person(world, bravo, "org_owner", "bravo-owner")
    world.bootstrap = person(world, charlie, None, "charlie-intended-owner")
    world.staff = SimpleNamespace(credential=token(http_signer, STAFF_ISSUER, subject="staff-one"))
    realm_job(alpha, "succeeded")
    confirm_owner(alpha)
    return world


@pytest.fixture(autouse=True)
def alpha_ordered(request):
    """Alpha has a committed order: no workspace before its CGV and DPA are accepted. The tests
    of that refusal start without one."""
    if request.node.name.startswith("test_without_a_committed_order"):
        return
    w = request.getfixturevalue("w")
    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")


def path(template, organisation):
    return "/api/v1" + template.format(organisation_id=organisation.id)


def read(w, who, organisation=None, **headers):
    organisation = organisation or w.alpha
    response = w.client.get(
        path(READ, organisation), HTTP_AUTHORIZATION="Bearer " + who.credential, **headers
    )
    return call(response, READ, "get")


def initialise(w, who, key=KEY, organisation=None, body=b"", **headers):
    organisation = organisation or w.alpha
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(
        path(INITIALISE, organisation),
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + who.credential,
        **headers,
    )
    return call(response, INITIALISE, "post")


def problem(response, status, kind):
    assert response.status_code == status, (
        f"expected {status} {kind}, got {response.status_code}: {response.content[:300]!r}"
    )
    body = response.json()
    assert body["type"] == PROBLEMS + kind, f"expected {kind}, got {body['type']}"
    assert body["request_id"] == response.headers["X-Request-Id"] or (
        response.headers.get("Idempotency-Replayed") == "true"
    )
    return body


def written():
    """Every row this feature may write, so a scenario can prove it wrote nothing."""
    return {
        name: sorted(map(str, model("workspaces", name).objects.values_list("id", flat=True)))
        for name in ("Workspace", "Category", "Channel", "ResourcePolicy", "ResourcePolicyRule")
    } | {
        "events": sorted(
            map(
                str,
                model("audit", "AuditEvent")
                .objects.filter(action="workspace.initialised")
                .values_list("id", flat=True),
            )
        )
    }


EMPTY: dict[str, list[str]] = {
    "Workspace": [],
    "Category": [],
    "Channel": [],
    "ResourcePolicy": [],
    "ResourcePolicyRule": [],
    "events": [],
}


def starter(w):
    """The rows §2 names, read back as plain values."""
    Workspace = model("workspaces", "Workspace")  # noqa: N806
    workspace = Workspace.objects.get(organisation_id=w.alpha.id)
    policy = model("workspaces", "ResourcePolicy").objects.get(pk=workspace.default_policy_id)
    categories = list(
        model("workspaces", "Category")
        .objects.filter(workspace=workspace)
        .order_by("position")
        .values_list("template_key", "name", "position", "default_policy_id", "version")
    )
    channels = list(
        model("workspaces", "Channel")
        .objects.filter(workspace=workspace)
        .order_by("category__position", "position")
        .values_list(
            "category__template_key",
            "template_key",
            "name",
            "position",
            "kind",
            "policy_mode",
            "explicit_policy_id",
            "lifecycle",
            "topic",
            "version",
        )
    )
    return SimpleNamespace(
        workspace=workspace,
        policy=(policy.workspace_id == workspace.id, policy.visibility, policy.revision),
        rules=model("workspaces", "ResourcePolicyRule").objects.filter(policy=policy).count(),
        categories=categories,
        channels=channels,
    )


STARTER_CATEGORIES = [("general", "General", 0, None, 1), ("team", "Team", 1, None, 1)]
STARTER_CHANNELS = [
    ("general", "welcome", "welcome", 0, "text", "inherit", None, "active", "", 1),
    ("general", "general", "general", 1, "text", "inherit", None, "active", "", 1),
    ("team", "lounge", "lounge", 0, "audio", "inherit", None, "active", "", 1),
]


def expected_view(w, *, can_initialise=False):
    data = starter(w)
    categories = {
        key: str(pk)
        for key, pk in model("workspaces", "Category")
        .objects.filter(workspace=data.workspace)
        .values_list("template_key", "id")
    }
    channels = {
        key: str(pk)
        for key, pk in model("workspaces", "Channel")
        .objects.filter(workspace=data.workspace)
        .values_list("template_key", "id")
    }

    def channel(key, kind="text"):
        return {
            "id": channels[key],
            "kind": kind,
            "name": key,
            "template_key": key,
            "topic": "",
            "lifecycle": "active",
            "room_state": "pending",
        }

    return {
        "organisation_id": str(w.alpha.id),
        "state": "initialised",
        "setup": {"state": "ready", "reason": None},
        "can_initialise": can_initialise,
        "id": str(data.workspace.id),
        "categories": [
            {
                "id": categories["general"],
                "name": "General",
                "template_key": "general",
                "channels": [channel("welcome"), channel("general")],
            },
            {
                "id": categories["team"],
                "name": "Team",
                "template_key": "team",
                "channels": [channel("lounge", "audio")],
            },
        ],
        "uncategorised_channels": [],
    }


# --- routes -----------------------------------------------------------------------------------


def test_routes_declare_their_operations():
    from core.api.scopes import ATTRIBUTE

    declared = []
    for route in (READ, INITIALISE):
        match = resolve("/api/v1" + route.format(organisation_id=uuid4()))
        declared += [
            (op.method, op.operation_id, op.scope) for op in getattr(match.func, ATTRIBUTE)
        ]
    assert declared == [
        ("GET", "getWorkspace", "workspace:read"),
        ("POST", "initialiseWorkspace", "workspace:act"),
    ], "the workspace routes are absent or declare the wrong operations"


def test_each_route_refuses_the_other_method(w):
    get = w.client.post(path(READ, w.alpha), HTTP_AUTHORIZATION="Bearer " + w.owner.credential)
    post = w.client.get(
        path(INITIALISE, w.alpha), HTTP_AUTHORIZATION="Bearer " + w.owner.credential
    )
    assert (get.status_code, get.headers["Allow"]) == (405, "GET")
    assert (post.status_code, post.headers["Allow"]) == (405, "POST")
    assert written() == EMPTY


# --- WS-01 to WS-04: one initialisation -------------------------------------------------------


def test_ws01_owner_initialises_a_confirmed_active_organisation(w):
    before = read(w, w.owner)
    assert before.status_code == 200
    assert before.json() == {
        "organisation_id": str(w.alpha.id),
        "state": "not_initialised",
        "setup": {"state": "ready", "reason": None},
        "can_initialise": True,
        "id": None,
        "categories": [],
        "uncategorised_channels": [],
    }, "WS-01: the read before initialisation is not the ready, empty view"

    response = initialise(w, w.owner)
    assert response.status_code == 201, "WS-01: the first initialisation did not answer 201"
    assert response.content == INITIALISED, "WS-01: the answer carries more than its state"
    assert response.headers["Location"] == f"/api/v1/organisations/{w.alpha.id}/workspace"
    assert "Idempotency-Replayed" not in response.headers
    assert response.headers["Cache-Control"] == "no-store"

    data = starter(w)
    assert data.workspace.structure_revision == 1, "WS-01: structure_revision is not 1"
    assert data.policy == (True, "organisation", 1), "WS-01: the workspace default policy is wrong"
    assert data.rules == 0, "WS-01: the starter wrote a policy rule"
    assert data.categories == STARTER_CATEGORIES, "WS-01: the starter categories are wrong"
    assert data.channels == STARTER_CHANNELS, "WS-01: the starter channels are wrong"
    assert model("workspaces", "ResourcePolicy").objects.count() == 1

    events = list(
        model("audit", "AuditEvent").objects.filter(action="workspace.initialised").values()
    )
    assert len(events) == 1, "WS-01: not exactly one workspace.initialised event"
    event = events[0]
    assert (
        event["actor_type"],
        event["actor_id"],
        event["organisation_id"],
        event["target_urn"],
        event["metadata"],
        event["retention_class"],
        event["request_id"],
    ) == (
        "tenant",
        w.owner.identity.id,
        w.alpha.id,
        f"urn:kodera:workspace:{data.workspace.id}",
        {"workspace_id": str(data.workspace.id), "template_version": 2},
        "standard",
        response.headers["X-Request-Id"],
    ), "WS-01: the workspace.initialised event is wrong"

    after = read(w, w.owner)
    assert after.json() == expected_view(w), "WS-01: the read after initialisation is wrong"


def test_ws02_same_key_is_replayed_byte_for_byte(w):
    first = initialise(w, w.owner)
    rows = written()
    second = initialise(w, w.owner)
    assert (second.status_code, second.content) == (first.status_code, first.content), (
        "WS-02: the replay is not the first answer"
    )
    assert second.headers["Location"] == first.headers["Location"]
    assert second.headers["Idempotency-Replayed"] == "true", "WS-02: the replay is not marked"
    assert written() == rows, "WS-02: the replay wrote a row or an event"


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_ws03_another_key_or_the_admin_answers_200_and_writes_nothing(w, who):
    first = initialise(w, w.owner)
    rows = written()
    again = initialise(w, getattr(w, who), key=OTHER_KEY)
    assert again.status_code == 200, "WS-03: a second initialisation did not answer 200"
    assert again.content == INITIALISED
    assert again.headers["Location"] == first.headers["Location"]
    assert "Idempotency-Replayed" not in again.headers
    assert written() == rows, "WS-03: a second initialisation wrote a row or an event"


def test_ws04_owner_and_admin_at_once_create_one_starter(w, monkeypatch):
    """Two connections, two keys. Each request waits, once it has checked for a workspace, until
    the other has checked too or a second has passed; under the organisation lock the second
    request cannot reach that check before the first commits, so the wait times out."""
    from apps.workspaces import initialise as service

    barrier = threading.Barrier(2, timeout=1)
    waited_on_lock = []
    find = service._find_workspace

    def find_then_meet(organisation_id):
        found = find(organisation_id)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted"
                )
                waited_on_lock.append(cursor.fetchone()[0])
        return found

    monkeypatch.setattr(service, "_find_workspace", find_then_meet)
    results = {}

    def run(name, who, key):
        try:
            client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
            response = client.post(
                path(INITIALISE, w.alpha),
                data=b"",
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer " + who.credential,
                HTTP_IDEMPOTENCY_KEY=key,
            )
            results[name] = response
        finally:
            connection.close()

    threads = [
        threading.Thread(target=run, args=("owner", w.owner, KEY)),
        threading.Thread(target=run, args=("admin", w.admin, OTHER_KEY)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(r.status_code for r in results.values()) == [200, 201], (
        "WS-04: two concurrent initialisations did not answer one 201 and one 200"
    )
    for response in results.values():
        call(response, INITIALISE, "post")
    assert waited_on_lock and waited_on_lock[0] >= 1, (
        "WS-04: the second initialisation did not wait on the organisation lock"
    )
    data = starter(w)
    assert (data.categories, data.channels) == (STARTER_CATEGORIES, STARTER_CHANNELS)
    assert len(written()["events"]) == 1, "WS-04: concurrent initialisations wrote two events"


# --- WS-05, WS-06, WS-10, WS-11: refusals before the step -------------------------------------


def test_ws05_a_suspended_organisation_is_refused_and_keeps_a_ready_setup(w):
    raw_update(w.alpha, state="suspended")
    response = initialise(w, w.owner)
    body = problem(response, 409, "invalid-state-transition")
    assert body["allowed_states"] == ["active"], "WS-05: a suspended organisation was not refused"
    assert written() == EMPTY, "WS-05: a refused initialisation wrote something"
    view = read(w, w.owner).json()
    assert (view["setup"], view["can_initialise"], view["state"]) == (
        {"state": "ready", "reason": None},
        False,
        "not_initialised",
    ), "WS-05: a suspended organisation's read is wrong"


def test_ws06_without_the_owner_confirmation_nothing_can_be_initialised(w):
    delta, owner = unconfirmed(w)
    view = read(w, owner, delta).json()
    assert view["setup"] == {"state": "pending", "reason": "awaiting_owner_confirmation"}, (
        "WS-06: an unconfirmed owner is not shown as awaiting confirmation"
    )
    assert view["can_initialise"] is False, "WS-06: an unconfirmed owner may initialise"
    body = problem(initialise(w, owner, organisation=delta), 409, "invalid-state-transition")
    assert body["allowed_states"] == ["ready"], "WS-06: an unconfirmed owner was not refused"
    assert written() == EMPTY, "WS-06: a refused initialisation wrote something"


@pytest.mark.parametrize("who", ["billing", "member"])
def test_ws10_billing_and_member_are_forbidden(w, who):
    caller = getattr(w, who)
    problem(initialise(w, caller), 403, "forbidden")
    assert written() == EMPTY, "WS-10: a forbidden initialisation wrote something"
    assert read(w, caller).json()["can_initialise"] is False, f"WS-10: {who} may initialise"


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_can_initialise_is_true_only_for_owner_and_admin_before_the_starter(w, who):
    caller = getattr(w, who)
    assert read(w, caller).json()["can_initialise"] is True
    initialise(w, caller)
    assert read(w, caller).json()["can_initialise"] is False, "initialised but still initialisable"


def test_ws11_an_activated_organisation_has_no_workspace_until_initialised(w):
    """consumeOwnerClaim is not on main: the activated organisation of the fixture stands for the
    claim's result, and nothing but initialiseWorkspace may create its workspace."""
    view = read(w, w.owner).json()
    assert view["state"] == "not_initialised" and view["id"] is None
    assert written() == EMPTY, "WS-11: a workspace exists before initialisation"


# --- WS-07: the setup state -------------------------------------------------------------------

SETUP_ROWS = [
    # (latest job, trusted, confirmed) -> (state, reason)
    ((None, True, True), ("failed", "realm_job_failed")),
    ((None, False, False), ("failed", "realm_job_failed")),
    (("failed", True, True), ("failed", "realm_job_failed")),
    (("failed", False, False), ("failed", "realm_job_failed")),
    (("cancelled", False, True), ("failed", "realm_job_failed")),
    (("queued", True, True), ("pending", None)),
    (("queued", False, False), ("pending", None)),
    (("leased", True, True), ("running", None)),
    (("running", False, False), ("running", None)),
    (("orphaned", True, False), ("running", None)),
    (("needs_reconciliation", False, True), ("running", None)),
    (("succeeded", False, True), ("failed", "issuer_untrusted")),
    (("succeeded", False, False), ("failed", "issuer_untrusted")),
    (("succeeded", True, False), ("pending", "awaiting_owner_confirmation")),
    (("succeeded", True, True), ("ready", None)),
]


@pytest.mark.parametrize(("facts", "expected"), SETUP_ROWS)
def test_ws07_setup_derivation_row_by_row(facts, expected):
    from apps.workspaces.setup import derive_setup

    status, trusted, confirmed = facts
    derived = derive_setup(latest_status=status, issuer_trusted=trusted, owner_confirmed=confirmed)
    assert (derived.state, derived.reason) == expected, f"WS-07: {facts} derived {derived}"


def test_ws07_an_unknown_job_status_is_refused():
    from apps.workspaces.setup import derive_setup

    with pytest.raises(ValueError, match="no setup row matches"):
        derive_setup(latest_status="paused", issuer_trusted=True, owner_confirmed=True)


@pytest.mark.parametrize(
    "status", ["queued", "leased", "running", "orphaned", "needs_reconciliation", "failed"]
)
def test_ws07_the_latest_realm_job_is_read(w, status):
    model("jobs", "Job").objects.filter(organisation_id=w.alpha.id).update(
        status="failed", error_code="step_failed"
    )
    realm_job(w.alpha, status)
    expected = {
        "queued": ("pending", None),
        "failed": ("failed", "realm_job_failed"),
    }.get(status, ("running", None))
    view = read(w, w.owner).json()
    assert (view["setup"]["state"], view["setup"]["reason"]) == expected, (
        f"WS-07: the latest realm job ({status}) was not the one read"
    )
    assert view["can_initialise"] is False


def test_ws07_a_replacement_job_supersedes_a_failed_one(w):
    model("jobs", "Job").objects.filter(organisation_id=w.alpha.id).update(
        status="failed", error_code="step_failed"
    )
    assert read(w, w.owner).json()["setup"] == {"state": "failed", "reason": "realm_job_failed"}
    realm_job(w.alpha, "succeeded")
    assert read(w, w.owner).json()["setup"] == {"state": "ready", "reason": None}, (
        "WS-07: a requeued, succeeded realm job did not supersede the failed one"
    )


def test_ws07_an_untrusted_or_expired_issuer_is_failed(w, settings):
    configure(settings, [trust_entry(w.signer, w.bravo.issuer)])
    from apps.workspaces.setup import read_setup

    with transaction.atomic():
        assert read_setup(organisation_id=w.alpha.id, issuer=w.alpha.issuer).reason == (
            "issuer_untrusted"
        ), "WS-07: an issuer absent from the trust list was not untrusted"
    configure(settings, [trust_entry(w.signer, w.alpha.issuer, expires_at=NOW + 600)])
    with transaction.atomic():
        assert read_setup(organisation_id=w.alpha.id, issuer=w.alpha.issuer).state == "ready"
    from datetime import UTC, datetime

    import time_machine

    with time_machine.travel(datetime.fromtimestamp(NOW + 601, UTC), tick=False):
        with transaction.atomic():
            assert read_setup(organisation_id=w.alpha.id, issuer=w.alpha.issuer).reason == (
                "issuer_untrusted"
            ), "WS-07: an expired trust entry still counts as trusted"


def test_ws07_no_realm_job_is_failed(w):
    other = person(w, w.bravo, "org_member", "bravo-member")
    confirm_owner(w.bravo)
    assert read(w, other, w.bravo).json()["setup"] == {
        "state": "failed",
        "reason": "realm_job_failed",
    }, "WS-07: an organisation without a realm job is not failed"


def test_ws07_another_organisations_job_and_confirmation_do_not_count(w):
    other = person(w, w.bravo, "org_owner", "bravo-second-owner")
    view = read(w, other, w.bravo).json()
    assert view["setup"] == {"state": "failed", "reason": "realm_job_failed"}
    realm_job(w.bravo, "succeeded")
    assert read(w, other, w.bravo).json()["setup"]["reason"] == "awaiting_owner_confirmation", (
        "WS-07: another organisation's confirmation counted"
    )


# --- WS-08: visibility ------------------------------------------------------------------------


def restricted_policy(workspace, *, allow=(), deny=(), visibility="restricted"):
    Policy = model("workspaces", "ResourcePolicy")  # noqa: N806
    Rule = model("workspaces", "ResourcePolicyRule")  # noqa: N806
    policy = Policy.objects.create(workspace=workspace, visibility=visibility)
    for member in allow:
        Rule.objects.create(policy=policy, kind="allow_member", membership=member)
    for member in deny:
        Rule.objects.create(policy=policy, kind="deny_member", membership=member)
    return policy


def add_channel(workspace, category, name, position, *, policy=None, lifecycle="active"):
    return model("workspaces", "Channel").objects.create(
        workspace=workspace,
        category=category,
        name=name,
        kind="text",
        position=position,
        policy_mode="explicit" if policy is not None else "inherit",
        explicit_policy=policy,
        lifecycle=lifecycle,
    )


def names(view):
    return (
        [
            (category["name"], [channel["name"] for channel in category["channels"]])
            for category in view["categories"]
        ],
        [channel["name"] for channel in view["uncategorised_channels"]],
    )


def test_ws08_visibility_is_filtered_server_side(w):
    initialise(w, w.owner)
    data = starter(w)
    Category = model("workspaces", "Category")  # noqa: N806
    general = Category.objects.get(workspace=data.workspace, template_key="general")
    add_channel(
        data.workspace,
        general,
        "board",
        2,
        policy=restricted_policy(data.workspace, allow=[w.member.member]),
    )
    add_channel(
        data.workspace,
        general,
        "not-for-owner",
        3,
        policy=restricted_policy(data.workspace, deny=[w.owner.member], visibility="organisation"),
    )
    add_channel(data.workspace, general, "starting", 4, lifecycle="provisioning")
    add_channel(data.workspace, general, "leaving", 5, lifecycle="deletion_pending")
    add_channel(data.workspace, general, "old", 6, lifecycle="archived")
    private = Category.objects.create(
        workspace=data.workspace,
        name="Private",
        position=2,
        default_policy=restricted_policy(data.workspace),
    )
    add_channel(data.workspace, private, "secret", 0)
    add_channel(data.workspace, None, "lobby", 0)

    member = read(w, w.member).json()
    assert names(member) == (
        [
            ("General", ["welcome", "general", "board", "not-for-owner", "old"]),
            ("Team", ["lounge"]),
        ],
        ["lobby"],
    ), "WS-08: the member's view is wrong"
    archived = member["categories"][0]["channels"][-1]
    assert archived["lifecycle"] == "archived", "WS-08: an archived channel is not shown archived"

    billing = read(w, w.billing).json()
    assert names(billing) == (
        [("General", ["welcome", "general", "not-for-owner", "old"]), ("Team", ["lounge"])],
        ["lobby"],
    ), "WS-08: a restricted channel is visible without a grant"

    owner = read(w, w.owner).json()
    assert names(owner) == (
        [("General", ["welcome", "general", "old"]), ("Team", ["lounge"])],
        ["lobby"],
    ), "WS-08: a deny_member did not hide a channel from the org_owner"

    for view in (member, billing, owner):
        text = json.dumps(view)
        for absent in ("starting", "leaving", "secret", "Private", "position", "revision"):
            assert absent not in text, f"WS-08: the answer reveals {absent!r}"

    model("workspaces", "ResourcePolicyRule").objects.create(
        policy=private.default_policy, kind="allow_member", membership=w.billing.member
    )
    assert names(read(w, w.billing).json())[0][-1] == ("Private", ["secret"]), (
        "WS-08: a category the caller may now view is still absent"
    )
    model("workspaces", "Channel").objects.filter(name="secret").update(
        policy_mode="explicit", explicit_policy=restricted_policy(data.workspace)
    )
    assert names(read(w, w.billing).json())[0][-1] == ("Private", []), (
        "WS-08: a category is not visible when a channel created in it would be"
    )


# --- WS-09: callers outside the four roles ----------------------------------------------------


def test_ws09_callers_outside_the_four_roles_never_see_a_200(w):
    initialise(w, w.owner)
    rows = written()
    for who, status, kind in (
        (w.foreigner, 404, "not-found"),
        (w.stranger, 404, "not-found"),
        (w.bootstrap, 404, "not-found"),
        (w.staff, 403, "forbidden"),
    ):
        problem(read(w, who), status, kind)
        problem(initialise(w, who, key=OTHER_KEY), status, kind)
    problem(read(w, w.bootstrap, w.charlie), 404, "not-found")
    problem(initialise(w, w.bootstrap, organisation=w.charlie), 404, "not-found")
    raw_update(w.member.member, state="removed")
    problem(read(w, w.member), 404, "not-found")
    assert written() == rows, "WS-09: a refused caller wrote something"


def test_ws09_a_members_token_from_another_realm_does_not_reach_this_organisation(w):
    # Every organisation realm issues the same audience: the issuer is what binds a token to the
    # organisation it may act on. The alpha owner also owns bravo; a valid bravo token is refused here.
    identity(w.models, w.bravo, w.owner.user, subject="alpha-owner-in-bravo")
    w.models.Membership.objects.create(
        user=w.owner.user,
        organisation=w.bravo,
        role="org_owner",
        state="active",
        accepted_at=timezone.now(),
    )
    elsewhere = SimpleNamespace(
        credential=token(w.signer, w.bravo.issuer, subject="alpha-owner-in-bravo")
    )
    rows = written()
    problem(read(w, elsewhere), 404, "not-found")
    problem(initialise(w, elsewhere, key=OTHER_KEY), 404, "not-found")
    assert written() == rows, "a token from another realm wrote something"
    assert initialise(w, w.owner).status_code == 201, (
        "the alpha token itself must still reach alpha"
    )
    assert written() != rows, "the alpha initialisation wrote nothing"


def test_ws09_unknown_and_absent_organisations_are_404(w):
    unknown = SimpleNamespace(id=uuid4())
    problem(read(w, w.owner, unknown), 404, "not-found")
    problem(initialise(w, w.owner, organisation=unknown), 404, "not-found")


def test_unverifiable_tokens_are_401_and_unbound_tokens_are_403_identity_unknown(w):
    nobody = SimpleNamespace(credential=token(w.signer, w.alpha.issuer, subject="no-identity"))
    for response in (read(w, nobody), initialise(w, nobody)):
        problem(response, 403, "identity-unknown")
        assert "WWW-Authenticate" not in response.headers
    forged = SimpleNamespace(credential="not-a-token")
    problem(read(w, forged), 401, "unauthenticated")
    assert written() == EMPTY


# --- WS-12, WS-13: faults and refusals around the step ----------------------------------------


def test_ws12_a_fault_after_the_categories_rolls_back_and_the_same_key_runs_again(
    w, monkeypatch, caplog
):
    from apps.workspaces import initialise as service

    create_channels = service._create_channels
    reached = []

    def fail_after_categories(*args, **kwargs):
        reached.append(model("workspaces", "Category").objects.count())
        raise RuntimeError("synthetic fault after the categories were inserted")

    monkeypatch.setattr(service, "_create_channels", fail_after_categories)
    failed = initialise(w, w.owner)
    assert reached == [2], "WS-12: the fault was not injected after the categories"
    problem(failed, 500, "internal-error")
    logged = [r.getMessage() for r in caplog.records if r.name == "apps.workspaces.api.views"]
    assert logged == [
        f"initialiseWorkspace failed: RuntimeError request_id={failed.headers['X-Request-Id']}"
    ], "WS-12: the failure was not logged by its class and request id alone"
    assert w.owner.credential not in caplog.text and "synthetic fault" not in caplog.text
    assert written() == EMPTY, "WS-12: a failed initialisation left rows behind"
    assert not model("idempotency", "IdempotencyRecord").objects.exists(), (
        "WS-12: a failed initialisation stored its answer"
    )
    monkeypatch.setattr(service, "_create_channels", create_channels)
    retried = initialise(w, w.owner)
    assert retried.status_code == 201, "WS-12: the same key did not run again after the fault"
    data = starter(w)
    assert (data.categories, data.channels) == (STARTER_CATEGORIES, STARTER_CHANNELS)


@pytest.mark.parametrize(
    ("key", "body", "kind"),
    [
        (None, b"", "idempotency-key-missing"),
        ("", b"", "idempotency-key-missing"),
        ("k" * 15, b"", "malformed-request"),
        ("k" * 8 + " " + "k" * 8, b"", "malformed-request"),
        (KEY, b"{}", "malformed-request"),
        (KEY, b" ", "malformed-request"),
    ],
)
def test_ws13_header_and_body_refusals_never_reach_the_step(w, key, body, kind):
    problem(initialise(w, w.owner, key=key, body=body), 400, kind)
    assert written() == EMPTY, "WS-13: a refused request reached the step"


# --- WS-14: the conformance check can fail ----------------------------------------------------


def test_ws14_the_conformance_check_refuses_what_the_contract_does_not_declare(w):
    good = read(w, w.owner)
    assert conformance_errors(good, READ, "get") == []
    with_extra = SimpleNamespace(
        status_code=200,
        headers=good.headers,
        content=json.dumps({**good.json(), "revision": 1}).encode(),
    )
    assert conformance_errors(with_extra, READ, "get"), "the check passed an undeclared member"
    teapot = SimpleNamespace(status_code=418, headers=good.headers, content=b"")
    assert conformance_errors(teapot, READ, "get") == ["getWorkspace declares no 418"]
    no_tag = SimpleNamespace(
        status_code=200,
        headers={k: v for k, v in good.headers.items() if k != "ETag"},
        content=good.content,
    )
    assert "200 lacks its required ETag header" in conformance_errors(no_tag, READ, "get")


# --- WS-15: one ETag per view -----------------------------------------------------------------


def test_ws15_the_etag_is_the_callers_view(w):
    initialise(w, w.owner)
    data = starter(w)
    general = model("workspaces", "Category").objects.get(
        workspace=data.workspace, template_key="general"
    )
    first = read(w, w.member)
    tag = first.headers["ETag"]
    assert tag == '"' + hashlib.sha256(first.content).hexdigest() + '"', (
        "WS-15: not the view's hash"
    )
    assert first.headers["Cache-Control"] == "no-store"

    hidden = add_channel(
        data.workspace, general, "hidden", 2, policy=restricted_policy(data.workspace)
    )
    model("workspaces", "Channel").objects.filter(pk=hidden.pk).update(name="renamed-hidden")
    unchanged = read(w, w.member)
    assert unchanged.headers["ETag"] == tag, "WS-15: a hidden change changed the member's tag"
    not_modified = read(w, w.member, HTTP_IF_NONE_MATCH=tag)
    assert not_modified.status_code == 304 and not_modified.content == b"", (
        "WS-15: a matching If-None-Match did not answer 304"
    )
    assert not_modified.headers["ETag"] == tag
    assert "Content-Type" not in not_modified.headers, "WS-15: the 304 carries a Content-Type"
    weak = read(w, w.member, HTTP_IF_NONE_MATCH="W/" + tag)
    assert weak.status_code == 304, "WS-15: a weak If-None-Match did not match (RFC 9110)"

    model("workspaces", "Channel").objects.filter(template_key="welcome").update(name="hello")
    renamed = read(w, w.member, HTTP_IF_NONE_MATCH=tag)
    assert renamed.status_code == 200 and renamed.headers["ETag"] != tag, (
        "WS-15: a visible rename did not change the tag"
    )
    new_tag = renamed.headers["ETag"]
    model("workspaces", "Channel").objects.filter(template_key="welcome").update(
        policy_mode="explicit", explicit_policy=restricted_policy(data.workspace)
    )
    revoked = read(w, w.member, HTTP_IF_NONE_MATCH=new_tag)
    assert revoked.status_code == 200, "WS-15: a lost view answered 304"
    assert "hello" not in revoked.content.decode()
    for response in (first, unchanged, renamed, revoked):
        assert "revision" not in response.content.decode(), "WS-15: an answer carries a revision"


def test_ws15_a_revoked_caller_never_gets_304(w):
    first = read(w, w.member)
    raw_update(w.member.member, state="removed")
    problem(read(w, w.member, HTTP_IF_NONE_MATCH=first.headers["ETag"]), 404, "not-found")


# --- the stored key -------------------------------------------------------------------------


def test_template_keys_are_guarded_by_the_database(w):
    from django.db import IntegrityError

    initialise(w, w.owner)
    data = starter(w)
    Category = model("workspaces", "Category")  # noqa: N806
    for value, constraint in (
        ("General", "category_template_key_valid"),
        ("team", "category_template_key_unique"),
    ):
        with pytest.raises(IntegrityError) as refused, transaction.atomic():
            Category.objects.create(
                workspace=data.workspace, name="Another", position=9, template_key=value
            )
        assert refused.value.__cause__.diag.constraint_name == constraint
    for value, constraint in (
        ("x" * 33, "channel_template_key_valid"),
        ("welcome", "channel_template_key_unique"),
    ):
        with pytest.raises(IntegrityError) as refused, transaction.atomic():
            model("workspaces", "Channel").objects.create(
                workspace=data.workspace,
                name="another",
                kind="text",
                position=9,
                template_key=value,
            )
        assert refused.value.__cause__.diag.constraint_name == constraint


# --- the bounded lock wait (§6 step 3) -------------------------------------------------------


def test_ws04_the_lock_wait_is_bounded_at_two_seconds(w, monkeypatch):
    """Another connection holds the organisation lock under the jobs' key function. The step waits
    at most 2 seconds, answers 500 with nothing written or stored, and the same key then runs. The
    connection's own statement_timeout is raised for this test, so only the step's lock_timeout can
    end the wait in time."""
    options = dict(connection.settings_dict["OPTIONS"])
    options["options"] = "-c statement_timeout=15000"
    monkeypatch.setitem(connection.settings_dict, "OPTIONS", options)
    connection.close()
    holder = session()
    try:
        holder.execute("SELECT pg_advisory_lock(1, hashtext(%s::text))", [str(w.alpha.id)])
        started = time.monotonic()
        waited = initialise(w, w.owner)
        elapsed = time.monotonic() - started
        problem(waited, 500, "internal-error")
        assert 1.5 <= elapsed < 6, f"WS-04: the lock wait was not bounded at 2 s ({elapsed:.1f} s)"
        assert written() == EMPTY, "WS-04: a timed-out wait wrote something"
        assert not model("idempotency", "IdempotencyRecord").objects.exists(), (
            "WS-04: a timed-out wait stored its answer"
        )
        holder.execute("SELECT pg_advisory_unlock(1, hashtext(%s::text))", [str(w.alpha.id)])
    finally:
        holder.close()
    assert initialise(w, w.owner).status_code == 201, "WS-04: the same key did not run again"


# --- AUTHZ.md §9: every 403 on the mutating verb is recorded ---------------------------------


def denials():
    return list(
        model("audit", "AuditEvent")
        .objects.filter(action="authz.denied")
        .order_by("occurred_at", "id")
        .values(
            "actor_type",
            "actor_id",
            "actor_label",
            "organisation_id",
            "target_urn",
            "request_id",
            "metadata",
        )
    )


def test_every_workspace_403_is_recorded_as_authz_denied(w):
    refused = [
        initialise(w, w.billing, HTTP_X_REQUEST_ID="denied-billing"),
        initialise(w, w.member, HTTP_X_REQUEST_ID="denied-member"),
        initialise(w, w.staff, HTTP_X_REQUEST_ID="denied-staff"),
    ]
    for response in refused:
        problem(response, 403, "forbidden")
    target = f"urn:kodera:organisation:{w.alpha.slug}"
    scope = {"required_scope": "workspace:act", "reason": "role_missing"}
    assert denials() == [
        {
            "actor_type": "tenant",
            "actor_id": w.billing.identity.id,
            "actor_label": f"urn:kodera:identity:{w.billing.identity.id}",
            "organisation_id": w.alpha.id,
            "target_urn": target,
            "request_id": "c-denied-billing",
            "metadata": scope,
        },
        {
            "actor_type": "tenant",
            "actor_id": w.member.identity.id,
            "actor_label": f"urn:kodera:identity:{w.member.identity.id}",
            "organisation_id": w.alpha.id,
            "target_urn": target,
            "request_id": "c-denied-member",
            "metadata": scope,
        },
        {
            "actor_type": "staff",
            "actor_id": None,
            "actor_label": "unknown",
            "organisation_id": w.alpha.id,
            "target_urn": target,
            "request_id": "c-denied-staff",
            "metadata": scope,
        },
    ], "AUTHZ §9: a 403 on initialiseWorkspace was not recorded as one authz.denied"
    assert written() == EMPTY
    initialise(w, w.owner)
    read(w, w.billing)
    problem(read(w, w.foreigner), 404, "not-found")
    assert len(denials()) == 3, "AUTHZ §9: a success or a tenant read wrote authz.denied"
    problem(read(w, w.staff, HTTP_X_REQUEST_ID="denied-staff-read"), 403, "forbidden")
    assert denials()[3:] == [
        {
            "actor_type": "staff",
            "actor_id": None,
            "actor_label": "unknown",
            "organisation_id": w.alpha.id,
            "target_urn": target,
            "request_id": "c-denied-staff-read",
            "metadata": {"required_scope": "workspace:read", "reason": "role_missing"},
        }
    ], "AUTHZ §9: the staff 403 of getWorkspace was not recorded as one authz.denied"


def test_a_staff_denial_names_the_stored_staff_identity(w):
    user = w.models.User.objects.create(email="operator@staff.test", enabled=True)
    staff = w.models.Identity.objects.create(
        user=user,
        organisation=None,
        issuer=STAFF_ISSUER,
        realm="kodera-staff",
        subject="staff-one",
        email="operator@staff.test",
        enabled=True,
    )
    problem(initialise(w, w.staff, HTTP_X_REQUEST_ID="denied-stored-staff"), 403, "forbidden")
    [event] = denials()
    assert (event["actor_type"], event["actor_id"], event["actor_label"]) == (
        "staff",
        staff.id,
        f"urn:kodera:identity:{staff.id}",
    ), "the staff denial does not name the stored staff identity"


@pytest.mark.parametrize(
    ("who", "operation", "line"),
    [
        ("member", "initialise", "initialiseWorkspace denial not recorded"),
        ("staff", "initialise", "initialiseWorkspace failed"),
        ("staff", "read", "getWorkspace failed"),
    ],
)
def test_a_denial_that_cannot_be_recorded_answers_500(w, monkeypatch, caplog, who, operation, line):
    from apps.workspaces import initialise as service

    def refuse(**fields):
        raise RuntimeError("synthetic audit failure")

    monkeypatch.setattr(service, "record_authz_denied", refuse)
    caller = getattr(w, who)
    response = initialise(w, caller) if operation == "initialise" else read(w, caller)
    problem(response, 500, "internal-error")
    assert denials() == [], "a denial that failed to be recorded left a row"
    logged = [r.getMessage() for r in caplog.records if r.name == "apps.workspaces.api.views"]
    assert logged == [f"{line}: RuntimeError request_id={response.headers['X-Request-Id']}"], (
        "a failed denial write was not logged by its class and request id alone"
    )
    assert caller.credential not in caplog.text and "synthetic audit failure" not in caplog.text
    assert written() == EMPTY


# --- properties the scenarios did not own ----------------------------------------------------


def test_a_non_staff_confirmation_does_not_confirm_the_owner(w):
    delta, owner = unconfirmed(w)
    actor = new_uuid7()
    model("audit", "AuditEvent").objects.create(
        action="owner_claim.confirmed",
        actor_type="tenant",
        actor_id=actor,
        actor_label=f"urn:kodera:identity:{actor}",
        organisation_id=delta.id,
        target_urn=f"urn:kodera:owner_claim:{new_uuid7()}",
        retention_class="standard",
    )
    assert read(w, owner, delta).json()["setup"] == {
        "state": "pending",
        "reason": "awaiting_owner_confirmation",
    }, "a confirmation by a non-staff actor counted"


def test_a_replay_is_never_served_to_a_caller_who_lost_the_role(w):
    raw_update(w.member.member, role="org_admin")
    first = initialise(w, w.member)
    assert first.status_code == 201
    raw_update(w.member.member, role="org_member")
    retried = initialise(w, w.member)
    problem(retried, 403, "forbidden")
    assert "Idempotency-Replayed" not in retried.headers, "a demoted caller was served a replay"
    other = initialise(w, w.owner)
    assert other.status_code == 200, "another caller with the same key did not run its own step"
    assert "Idempotency-Replayed" not in other.headers, "another caller was served a replay"


# --- the order before the workspace (G1) ---------------------------------------------------------


def test_without_a_committed_order_the_workspace_is_refused(w):
    assert read(w, w.owner).json()["can_initialise"] is False
    response = initialise(w, w.owner)
    assert response.status_code == 409
    assert response.json()["allowed_states"] == ["ordered"]
    assert model("workspaces", "Workspace").objects.count() == 0


def test_without_a_committed_order_a_cancelled_one_does_not_count(w):
    placed = commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    assert read(w, w.owner).json()["can_initialise"] is True
    model("billing", "Order").objects.filter(id=placed.order.id).update(state="cancelled")
    assert read(w, w.owner).json()["can_initialise"] is False
    response = initialise(w, w.owner)
    assert response.status_code == 409 and response.json()["allowed_states"] == ["ordered"]
