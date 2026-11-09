"""Espace structure administration: docs/specs/ESPACE_STRUCTURE.md §10, ES-01–ES-13.

Real signed tokens, the real HTTP views and the disposable PostgreSQL test database. Every response
a scenario receives is checked against contracts/core-api.openapi.yaml by `call`
(tests/test_workspace_onboarding.py), problem documents included. Each scenario names, in its
failing assertion, what broke. The starter template is read back, never assumed: a test holds for
template version 1 and version 2 alike.
"""

import json
import threading
import time
from uuid import uuid4

import pytest
from django.db import connection, transaction
from django.test import Client
from order_fixtures import commit_order
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_concurrency import session
from test_workspace_onboarding import (
    call,
    http_signer as http_signer,
    initialise,
    model,
    problem,
    w as w,
)

pytestmark = pytest.mark.django_db(transaction=True)

BASE = "/organisations/{organisation_id}/workspace"
CATEGORIES = BASE + "/categories"
CATEGORY = BASE + "/categories/{category_id}"
CHANNELS = BASE + "/channels"
CHANNEL = BASE + "/channels/{channel_id}"
ARCHIVE = CHANNEL + "/actions/archive"
UNARCHIVE = CHANNEL + "/actions/unarchive"
ACCESS = CHANNEL + "/access"
ADMINISTRATION = BASE + "/administration"
READ = BASE
MERGE = "application/merge-patch+json"
# Distinctive values, so a scenario can prove none of them reached an audit row.
SECRET_NAMES = ("Nom-Secret-Cat", "Nom-Secret-Cat-Bis", "salon-secret", "salon-secret-bis")
SECRET_TOPIC = "Sujet-Secret"


@pytest.fixture
def e(w):
    """Alpha with its order committed and its starter workspace initialised by its owner."""
    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    assert initialise(w, w.owner).status_code == 201
    return w


# --- requests ---------------------------------------------------------------------------------


def send(w, who, method, template, body=None, *, if_match=None, raw=None, organisation=None, **ids):
    organisation = organisation or w.alpha
    target = "/api/v1" + template.format(organisation_id=organisation.id, **ids)
    headers = {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if if_match is not None:
        headers["HTTP_IF_MATCH"] = if_match
    if method == "get":
        response = w.client.get(target, **headers)
    else:
        if method == "post":
            headers["HTTP_IDEMPOTENCY_KEY"] = str(uuid4())
        data = raw if raw is not None else b"" if body is None else json.dumps(body)
        media = MERGE if method == "patch" else "application/json"
        response = getattr(w.client, method)(target, data=data, content_type=media, **headers)
    return call(response, template, method)


def administration(w, who=None):
    response = send(w, who or w.owner, "get", ADMINISTRATION)
    assert response.status_code == 200, response.content
    return response.json()


def rows(w, who=None):
    """Every category and channel of the administrative read, by id."""
    body = administration(w, who)
    found = {}
    for category in body["categories"]:
        found[category["id"]] = category
        for channel in category["channels"]:
            found[channel["id"]] = channel
    for channel in body["uncategorised_channels"]:
        found[channel["id"]] = channel
    return found


def starter(w):
    """The starter categories, by template key, as the administrative read returns them."""
    return {c["template_key"]: c for c in administration(w)["categories"] if c["template_key"]}


def create_category(w, name="Projets", who=None, **extra):
    response = send(w, who or w.owner, "post", CATEGORIES, {"name": name, **extra})
    assert response.status_code == 201, response.content
    return response.json()


def create_channel(w, category_id, name="annonces", kind="text", who=None, **extra):
    body = {"category_id": category_id, "kind": kind, "name": name, **extra}
    response = send(w, who or w.owner, "post", CHANNELS, body)
    assert response.status_code == 201, response.content
    return response.json()


def patch_channel(w, channel, body, who=None):
    return send(
        w,
        who or w.owner,
        "patch",
        CHANNEL,
        body,
        if_match=channel["etag"],
        channel_id=channel["id"],
    )


def access_of(w, channel_id, who=None):
    response = send(w, who or w.owner, "get", ACCESS, channel_id=channel_id)
    assert response.status_code == 200, response.content
    return response.json(), response.headers["ETag"]


def document(**changes):
    value = {
        "mode": "explicit",
        "visibility": "organisation",
        "allow_members": [],
        "deny_members": [],
        "read_only": False,
        "listen_only": False,
    }
    value.update(changes)
    return value


def set_access(w, channel_id, who=None, **changes):
    _, tag = access_of(w, channel_id)
    return send(
        w, who or w.owner, "patch", ACCESS, document(**changes), if_match=tag, channel_id=channel_id
    )


def membership(person):
    return str(person.member.id)


# --- what is stored ---------------------------------------------------------------------------


def _rows(name, *fields):
    return sorted(model("workspaces", name).objects.values_list(*fields), key=str)


def written():
    """Every row and event these operations may write, so a refusal can prove it wrote nothing."""
    return {
        "workspace": _rows("Workspace", "id", "structure_revision"),
        "categories": _rows("Category", "id", "name", "template_key", "position", "version"),
        "channels": _rows(
            "Channel",
            "id",
            "category_id",
            "name",
            "template_key",
            "topic",
            "position",
            "version",
            "lifecycle",
            "policy_mode",
            "explicit_policy_id",
        ),
        "policies": _rows("ResourcePolicy", "id", "visibility", "revision"),
        "rules": _rows(
            "ResourcePolicyRule", "id", "policy_id", "kind", "membership_id", "capability"
        ),
        "notices": _rows("ChannelNotice", "id", "channel_id", "membership_id"),
        "events": sorted(
            map(
                str,
                model("audit", "AuditEvent")
                .objects.exclude(action="authz.denied")
                .values_list("id", flat=True),
            )
        ),
    }


def revision(w):
    return (
        model("workspaces", "Workspace")
        .objects.values_list("structure_revision", flat=True)
        .get(organisation_id=w.alpha.id)
    )


def events(action=None):
    """The workspace's own audit rows (§9); a channel set's `engine_channel_set.*` rows are the
    engines' (tests/test_espace_channel_set.py)."""
    found = model("audit", "AuditEvent").objects.filter(action__startswith="workspace.")
    if action is not None:
        found = found.filter(action=action)
    return list(found.order_by("occurred_at", "id").values())


def stored_lists(w):
    """Each list's stored positions: the categories, each category's channels, the uncategorised."""
    workspace = model("workspaces", "Workspace").objects.get(organisation_id=w.alpha.id)
    lists = {
        "categories": list(
            model("workspaces", "Category")
            .objects.filter(workspace=workspace)
            .values_list("position", flat=True)
        )
    }
    for category_id, position in (
        model("workspaces", "Channel")
        .objects.filter(workspace=workspace)
        .exclude(lifecycle="deleted")
        .values_list("category_id", "position")
    ):
        lists.setdefault(str(category_id), []).append(position)
    return {key: sorted(value) for key, value in lists.items()}


def assert_dense(w, why):
    for key, positions in stored_lists(w).items():
        assert positions == list(range(len(positions))), f"ES-02 {why}: {key} is {positions}"


def names(w, category_id):
    """The names of one list of the administrative read, in order; None is the uncategorised."""
    body = administration(w)
    if category_id is None:
        listed = body["uncategorised_channels"]
    else:
        listed = next(c for c in body["categories"] if c["id"] == category_id)["channels"]
    assert [c["position"] for c in listed] == list(range(len(listed))), "ES-02: read not in order"
    return [c["name"] for c in listed]


# --- the operations, each prepared by the owner and performed by the caller --------------------


def _category(w):
    return {"target": create_category(w, SECRET_NAMES[0])}


def _channel(w):
    return {"target": create_channel(w, None, SECRET_NAMES[2], topic=SECRET_TOPIC)}


def _archived(w):
    target = create_channel(w, None, SECRET_NAMES[2])
    assert send(w, w.owner, "post", ARCHIVE, channel_id=target["id"]).status_code == 200
    return {"target": target}


def _with_access(w):
    target = create_channel(w, None, SECRET_NAMES[2])
    _, tag = access_of(w, target["id"])
    return {"target": target, "tag": tag}


OPERATIONS = {
    "createCategory": (
        lambda w: {},
        lambda w, who, ctx: send(w, who, "post", CATEGORIES, {"name": SECRET_NAMES[1]}),
        201,
        "workspace.category_created",
        "workspace:create",
    ),
    "patchCategory": (
        _category,
        lambda w, who, ctx: send(
            w,
            who,
            "patch",
            CATEGORY,
            {"name": SECRET_NAMES[1]},
            if_match=ctx["target"]["etag"],
            category_id=ctx["target"]["id"],
        ),
        200,
        "workspace.category_updated",
        "workspace:update",
    ),
    "deleteCategory": (
        _category,
        lambda w, who, ctx: send(w, who, "delete", CATEGORY, category_id=ctx["target"]["id"]),
        204,
        "workspace.category_deleted",
        "workspace:delete",
    ),
    "createChannel": (
        lambda w: {},
        lambda w, who, ctx: send(
            w,
            who,
            "post",
            CHANNELS,
            {"category_id": None, "kind": "audio", "name": SECRET_NAMES[3], "topic": SECRET_TOPIC},
        ),
        201,
        "workspace.channel_created",
        "workspace:create",
    ),
    "patchChannel": (
        _channel,
        lambda w, who, ctx: patch_channel(
            w, ctx["target"], {"name": SECRET_NAMES[3], "topic": SECRET_TOPIC + "-bis"}, who
        ),
        200,
        "workspace.channel_updated",
        "workspace:update",
    ),
    "archiveChannel": (
        _channel,
        lambda w, who, ctx: send(w, who, "post", ARCHIVE, channel_id=ctx["target"]["id"]),
        200,
        "workspace.channel_archived",
        "workspace:act",
    ),
    "unarchiveChannel": (
        _archived,
        lambda w, who, ctx: send(w, who, "post", UNARCHIVE, channel_id=ctx["target"]["id"]),
        200,
        "workspace.channel_unarchived",
        "workspace:act",
    ),
    "getChannelAccess": (
        _channel,
        lambda w, who, ctx: send(w, who, "get", ACCESS, channel_id=ctx["target"]["id"]),
        200,
        None,
        "workspace:read",
    ),
    "patchChannelAccess": (
        _with_access,
        lambda w, who, ctx: send(
            w,
            who,
            "patch",
            ACCESS,
            document(visibility="restricted", allow_members=[membership(w.member)]),
            if_match=ctx["tag"],
            channel_id=ctx["target"]["id"],
        ),
        200,
        "workspace.channel_access_changed",
        "workspace:update",
    ),
    "getWorkspaceAdministration": (
        lambda w: {},
        lambda w, who, ctx: send(w, who, "get", ADMINISTRATION),
        200,
        None,
        "workspace:read",
    ),
}


# --- ES-01: who may act -----------------------------------------------------------------------


@pytest.mark.parametrize("operation", sorted(OPERATIONS))
@pytest.mark.parametrize("who", ["owner", "admin"])
def test_es01_owners_and_admins_administer(e, operation, who):
    prepare, perform, status, _, _ = OPERATIONS[operation]
    response = perform(e, getattr(e, who), prepare(e))
    assert response.status_code == status, (
        f"ES-01: {operation} by {who} answered {response.status_code}: {response.content[:300]!r}"
    )


@pytest.mark.parametrize("operation", sorted(OPERATIONS))
@pytest.mark.parametrize(
    ("who", "status", "kind"),
    [("billing", 403, "forbidden"), ("member", 403, "forbidden"), ("foreigner", 404, "not-found")],
)
def test_es01_other_roles_and_organisations_are_refused(e, operation, who, status, kind):
    prepare, perform, _, action, scope = OPERATIONS[operation]
    context = prepare(e)
    before = written()
    denied = model("audit", "AuditEvent").objects.filter(action="authz.denied").count()
    problem(perform(e, getattr(e, who), context), status, kind)
    assert written() == before, f"ES-01: a refused {operation} by {who} wrote something"
    recorded = list(
        model("audit", "AuditEvent")
        .objects.filter(action="authz.denied")
        .order_by("occurred_at", "id")
        .values_list("metadata", flat=True)
    )[denied:]
    if status == 403 and action is not None:
        assert [r["required_scope"] for r in recorded] == [scope], (
            f"ES-01: the refused {operation} by {who} was not recorded once as authz.denied"
        )
    else:
        assert recorded == [], f"ES-01: a refused read or a 404 of {operation} was recorded"


@pytest.mark.parametrize("operation", sorted(OPERATIONS))
def test_es01_a_staff_token_is_refused_and_recorded(e, operation):
    prepare, perform, _, _, scope = OPERATIONS[operation]
    context = prepare(e)
    before = written()
    problem(perform(e, e.staff, context), 403, "forbidden")
    assert written() == before
    recorded = model("audit", "AuditEvent").objects.filter(action="authz.denied").get()
    assert (recorded.actor_type, recorded.metadata["required_scope"]) == ("staff", scope)


def test_es01_a_suspended_organisation_is_refused_every_mutation(e):
    target = create_category(e)
    channel = create_channel(e, None)
    model("orgs", "Organisation").objects.filter(pk=e.alpha.pk).update(state="suspended")
    before = written()
    problem(send(e, e.owner, "post", CATEGORIES, {"name": "Autre"}), 403, "forbidden")
    problem(
        send(
            e,
            e.owner,
            "patch",
            CATEGORY,
            {"name": "Autre"},
            if_match=target["etag"],
            category_id=target["id"],
        ),
        403,
        "forbidden",
    )
    problem(send(e, e.admin, "post", ARCHIVE, channel_id=channel["id"]), 403, "forbidden")
    assert written() == before, "ES-01: a suspended organisation's structure changed"
    assert administration(e)["categories"], "ES-01: a suspended organisation cannot be read"


def test_es01_an_unknown_token_is_401_and_no_workspace_is_404_or_409(w):
    problem(send(w, w.owner, "get", ADMINISTRATION), 404, "not-found")
    refused = problem(
        send(w, w.owner, "post", CATEGORIES, {"name": "Projets"}), 409, "invalid-state-transition"
    )
    assert refused["allowed_states"] == ["initialised"]
    created = problem(
        send(w, w.owner, "post", CHANNELS, {"category_id": None, "kind": "text", "name": "x"}),
        409,
        "invalid-state-transition",
    )
    assert created["allowed_states"] == ["initialised"]
    # Every operation that names a row is 404 before the workspace exists (§11), never a 409.
    row = str(uuid4())
    for template, method, body, ids in (
        (CATEGORY, "patch", {"name": "x"}, {"category_id": row}),
        (CATEGORY, "delete", None, {"category_id": row}),
        (CHANNEL, "patch", {"name": "x"}, {"channel_id": row}),
        (ARCHIVE, "post", None, {"channel_id": row}),
        (UNARCHIVE, "post", None, {"channel_id": row}),
        (ACCESS, "get", None, {"channel_id": row}),
        (ACCESS, "patch", document(), {"channel_id": row}),
    ):
        problem(send(w, w.owner, method, template, body, if_match='"x"', **ids), 404, "not-found")
    response = w.client.get(
        "/api/v1" + ADMINISTRATION.format(organisation_id=w.alpha.id),
        HTTP_AUTHORIZATION="Bearer not-a-token",
    )
    problem(call(response, ADMINISTRATION, "get"), 401, "unauthenticated")


# --- ES-02: dense positions -------------------------------------------------------------------


def test_es02_positions_stay_dense_through_creates_moves_archives_and_deletes(e):
    general = starter(e)["general"]["id"]
    first = create_category(e, "Premier", position=0)
    assert [c["name"] for c in administration(e)["categories"]][0] == "Premier"
    assert_dense(e, "after a category inserted at 0")
    last = create_category(e, "Dernier")
    assert administration(e)["categories"][-1]["id"] == last["id"], "an omitted position appends"

    before = names(e, general)
    a = create_channel(e, general, "a", position=0)
    b = create_channel(e, general, "b")
    assert names(e, general) == ["a", *before, "b"]
    assert_dense(e, "after channel creates")

    rows_now = rows(e)
    moved = patch_channel(e, rows_now[a["id"]], {"position": len(before) + 1})
    assert moved.status_code == 200, moved.content
    assert names(e, general) == [*before, "b", "a"], "ES-02: a move within a list"
    assert_dense(e, "after a move within a list")

    archived = send(e, e.owner, "post", ARCHIVE, channel_id=b["id"])
    assert archived.json()["position"] == rows(e)[b["id"]]["position"], "archive moved a channel"
    rows_now = rows(e)
    across = patch_channel(e, rows_now[b["id"]], {"category_id": first["id"], "position": 0})
    assert across.status_code == 200, across.content
    assert names(e, first["id"]) == ["b"] and names(e, general) == [*before, "a"]
    assert_dense(e, "after an archived channel moved across categories")

    rows_now = rows(e)
    out = patch_channel(e, rows_now[a["id"]], {"category_id": None})
    assert out.status_code == 200, out.content
    c = create_channel(e, None, "c", position=0)
    assert names(e, None) == ["c", "a"], "ES-02: to the uncategorised list"
    rows_now = rows(e)
    back = patch_channel(e, rows_now[a["id"]], {"category_id": general, "position": 0})
    assert back.status_code == 200, back.content
    assert names(e, None) == ["c"] and names(e, general)[0] == "a"
    assert_dense(e, "after moves to and from the uncategorised list")

    gone = send(e, e.owner, "delete", CATEGORY, category_id=last["id"])
    assert gone.status_code == 204, gone.content
    assert_dense(e, "after a category delete")
    moved_category = send(
        e,
        e.owner,
        "patch",
        CATEGORY,
        {"position": 0},
        if_match=rows(e)[general]["etag"],
        category_id=general,
    )
    assert moved_category.status_code == 200, moved_category.content
    assert administration(e)["categories"][0]["id"] == general
    assert_dense(e, "after a category move")
    assert c["kind"] == "text"


def test_es02_a_position_beyond_the_end_or_a_foreign_category_is_422(e):
    general = starter(e)["general"]
    size = len(general["channels"])
    before = written()
    refused = problem(
        send(
            e,
            e.owner,
            "post",
            CHANNELS,
            {"category_id": general["id"], "kind": "text", "name": "x", "position": size + 1},
        ),
        422,
        "validation-error",
    )
    assert refused["errors"] == [{"pointer": "/position", "code": "out_of_range"}]
    problem(
        send(e, e.owner, "post", CATEGORIES, {"name": "x", "position": len(starter(e)) + 1}),
        422,
        "validation-error",
    )
    channel = rows(e)[general["channels"][0]["id"]]
    problem(patch_channel(e, channel, {"position": size}), 422, "validation-error")
    problem(patch_channel(e, channel, {"category_id": str(uuid4())}), 422, "validation-error")
    unexpected = problem(patch_channel(e, channel, {"kind": "audio"}), 422, "validation-error")
    assert unexpected["errors"] == [{"pointer": "/kind", "code": "unexpected"}]
    problem(patch_channel(e, channel, {}), 422, "validation-error")
    problem(
        send(
            e,
            e.owner,
            "patch",
            CHANNEL,
            raw=b"[",
            if_match=channel["etag"],
            channel_id=channel["id"],
        ),
        400,
        "malformed-request",
    )
    problem(patch_channel(e, channel, {"name": " \t"}), 422, "validation-error")
    problem(patch_channel(e, channel, {"topic": "x" * 1025}), 422, "validation-error")
    assert written() == before, "ES-02: a refused write changed the structure"


def test_es02_two_concurrent_moves_in_one_list_both_apply_one_after_the_other(e, monkeypatch):
    """Two connections move disjoint pairs of one list. Each waits, once it holds the workspace
    row, until the other also holds it or a second has passed; the second cannot hold it before the
    first commits, so the wait times out, and it then applies to the first's result."""
    from apps.workspaces import administration as service

    category = create_category(e, "Liste")
    for name in "abcde":
        create_channel(e, category["id"], name)
    listed = {c["name"]: c for c in rows(e).values() if c.get("category_id") == category["id"]}
    barrier = threading.Barrier(2, timeout=1)
    waited = []
    revise = service._revise

    def revise_then_meet(organisation_id):
        found = revise(organisation_id)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM pg_locks WHERE NOT granted")
                waited.append(cursor.fetchone()[0])
        return found

    monkeypatch.setattr(service, "_revise", revise_then_meet)
    results = {}

    def run(name, who, channel, position):
        try:
            client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
            results[name] = client.patch(
                "/api/v1" + CHANNEL.format(organisation_id=e.alpha.id, channel_id=channel["id"]),
                data=json.dumps({"position": position}),
                content_type=MERGE,
                HTTP_AUTHORIZATION="Bearer " + who.credential,
                HTTP_IF_MATCH=channel["etag"],
            )
        finally:
            connection.close()

    start = revision(e)
    threads = [
        threading.Thread(target=run, args=("first", e.owner, listed["a"], 1)),
        threading.Thread(target=run, args=("second", e.admin, listed["e"], 3)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert [results[n].status_code for n in ("first", "second")] == [200, 200], (
        "ES-02: two concurrent moves did not both succeed: "
        + "; ".join(results[n].content[:200].decode() for n in results)
    )
    for response in results.values():
        call(response, CHANNEL, "patch")
    assert waited and waited[0] >= 1, "ES-02: the second move did not wait for the first"
    assert names(e, category["id"]) == ["b", "a", "c", "e", "d"]
    assert revision(e) == start + 2
    assert_dense(e, "after two concurrent moves")


def test_es02_a_held_workspace_answers_503_within_the_lock_timeout(e, monkeypatch):
    options = dict(connection.settings_dict["OPTIONS"])
    options["options"] = "-c statement_timeout=15000"
    monkeypatch.setitem(connection.settings_dict, "OPTIONS", options)
    connection.close()
    holder = session()
    try:
        holder.execute("BEGIN")
        holder.execute(
            "SELECT 1 FROM workspaces_workspace WHERE organisation_id=%s FOR UPDATE", [e.alpha.id]
        )
        started = time.monotonic()
        busy = send(e, e.owner, "post", CATEGORIES, {"name": "Projets"})
        elapsed = time.monotonic() - started
        refused = problem(busy, 503, "service-unavailable")
        assert busy.headers["Retry-After"] == str(refused["retry_after_s"])
        assert 1.5 <= elapsed < 6, f"ES-02: the lock wait was not bounded ({elapsed:.1f} s)"
        holder.execute("ROLLBACK")
    finally:
        holder.close()
    assert not model("workspaces", "Category").objects.filter(name="Projets").exists()


# --- ES-03: concurrency tokens ----------------------------------------------------------------


def test_es03_a_patch_without_if_match_is_428_and_a_stale_one_412(e):
    category = create_category(e)
    channel = create_channel(e, category["id"])
    _, access_tag = access_of(e, channel["id"])
    cases = [
        (CATEGORY, {"name": "Renommé"}, {"category_id": category["id"]}),
        (CHANNEL, {"name": "renomme"}, {"channel_id": channel["id"]}),
        (ACCESS, document(visibility="restricted"), {"channel_id": channel["id"]}),
    ]
    before = written()
    for template, body, ids in cases:
        problem(send(e, e.owner, "patch", template, body, **ids), 428, "precondition-required")
    stale = '"' + "0" * 64 + '"'
    for template, body, ids in cases:
        response = send(e, e.owner, "patch", template, body, if_match=stale, **ids)
        refused = problem(response, 412, "precondition-failed")
        assert refused["current_etag"] == response.headers["ETag"] != stale
    assert written() == before, "ES-03: a refused precondition wrote something"
    current = {
        CATEGORY: rows(e)[category["id"]]["etag"],
        CHANNEL: rows(e)[channel["id"]]["etag"],
        ACCESS: access_tag,
    }
    assert [current[t] for t, _, _ in cases] == [
        send(e, e.owner, "patch", t, b, if_match=stale, **i).json()["current_etag"]
        for t, b, i in cases
    ]
    gone = send(e, e.owner, "delete", CATEGORY, category_id=category["id"], if_match=stale)
    problem(gone, 412, "precondition-failed")


def test_es03_explicit_inherit_explicit_changes_the_access_etag(e):
    channel = create_channel(e, None)
    _, inherited = access_of(e, channel["id"])
    explicit = set_access(e, channel["id"])
    assert explicit.status_code == 200, explicit.content
    first = explicit.headers["ETag"]
    back = set_access(e, channel["id"], mode="inherit")
    assert back.status_code == 200, back.content
    again = set_access(e, channel["id"])
    assert again.status_code == 200, again.content
    tags = [inherited, first, back.headers["ETag"], again.headers["ETag"]]
    assert len(set(tags[1:])) == 3 and tags[2] == inherited, f"ES-03: access tags {tags}"
    policies = model("workspaces", "ResourcePolicy").objects.filter(visibility="organisation")
    assert policies.count() == 3, "ES-03: a detached policy was deleted or reused"
    assert access_of(e, channel["id"])[0]["mode"] == "explicit"


# --- ES-04: template keys ---------------------------------------------------------------------


def test_es04_renaming_a_templated_row_clears_its_key_and_moving_keeps_it(e):
    general = starter(e)["general"]
    channel = rows(e)[general["channels"][0]["id"]]
    assert channel["template_key"] is not None
    moved = patch_channel(e, channel, {"position": len(general["channels"]) - 1})
    assert moved.json()["template_key"] == channel["template_key"], "ES-04: a move cleared a key"
    renamed = patch_channel(e, moved.json(), {"name": "accueil"})
    assert renamed.json()["template_key"] is None, "ES-04: a renamed channel kept its key"
    category = send(
        e,
        e.owner,
        "patch",
        CATEGORY,
        {"name": "Général"},
        if_match=general["etag"],
        category_id=general["id"],
    )
    assert category.json()["template_key"] is None, "ES-04: a renamed category kept its key"
    retopic = patch_channel(e, rows(e)[general["channels"][1]["id"]], {"topic": "Bienvenue"})
    assert retopic.json()["template_key"] is not None, "ES-04: a new topic cleared a key"


# --- ES-05: category delete -------------------------------------------------------------------


def test_es05_a_category_holding_an_archived_channel_is_not_empty(e):
    category = create_category(e)
    channel = create_channel(e, category["id"])
    assert send(e, e.owner, "post", ARCHIVE, channel_id=channel["id"]).status_code == 200
    before = written()
    refused = problem(
        send(e, e.owner, "delete", CATEGORY, category_id=category["id"]), 409, "conflict"
    )
    assert refused["reason"] == "category_not_empty"
    assert written() == before
    out = patch_channel(e, rows(e)[channel["id"]], {"category_id": None})
    assert out.status_code == 200, out.content
    tag = rows(e)[category["id"]]["etag"]
    gone = send(e, e.owner, "delete", CATEGORY, category_id=category["id"], if_match=tag)
    assert gone.status_code == 204 and gone.content == b""
    problem(send(e, e.owner, "delete", CATEGORY, category_id=category["id"]), 404, "not-found")


# --- ES-06: access validation -----------------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    [
        "inherit_differs",
        "organisation_with_allow",
        "not_a_member",
        "removed_member",
        "foreign_member",
        "allowed_and_denied",
        "read_only_audio",
        "listen_only_text",
    ],
)
def test_es06_each_invalid_access_is_422(e, case):
    text = create_channel(e, None)
    audio = create_channel(e, None, "salon", kind="audio")
    removed = e.member.member
    if case == "removed_member":
        removed = model("orgs", "Membership").objects.get(pk=e.billing.member.pk)
        model("orgs", "Membership").objects.filter(pk=removed.pk).update(state="removed")
    bodies = {
        "inherit_differs": (text, document(mode="inherit", visibility="restricted")),
        "organisation_with_allow": (text, document(allow_members=[membership(e.member)])),
        "not_a_member": (text, document(visibility="restricted", allow_members=[str(uuid4())])),
        "removed_member": (
            text,
            document(visibility="restricted", allow_members=[str(removed.pk)]),
        ),
        "foreign_member": (text, document(deny_members=[membership(e.foreigner)])),
        "allowed_and_denied": (
            text,
            document(
                visibility="restricted",
                allow_members=[membership(e.member)],
                deny_members=[membership(e.member)],
            ),
        ),
        "read_only_audio": (audio, document(read_only=True)),
        "listen_only_text": (text, document(listen_only=True)),
    }
    channel, body = bodies[case]
    _, tag = access_of(e, channel["id"])
    before = written()
    response = send(e, e.owner, "patch", ACCESS, body, if_match=tag, channel_id=channel["id"])
    refused = problem(response, 422, "validation-error")
    assert refused["errors"], "ES-06: a 422 names no field"
    assert written() == before, f"ES-06: the refused {case} wrote something"


def test_es06_a_partial_access_document_is_422(e):
    channel = create_channel(e, None)
    _, tag = access_of(e, channel["id"])
    body = document()
    del body["listen_only"]
    response = send(e, e.owner, "patch", ACCESS, body, if_match=tag, channel_id=channel["id"])
    refused = problem(response, 422, "validation-error")
    assert refused["errors"] == [{"pointer": "/listen_only", "code": "required"}]


def test_es06_the_flags_store_deny_capability_rules_and_read_back(e):
    text = create_channel(e, None)
    audio = create_channel(e, None, "salon", kind="audio")
    assert set_access(e, text["id"], read_only=True).status_code == 200
    assert set_access(e, audio["id"], listen_only=True).status_code == 200
    Rule = model("workspaces", "ResourcePolicyRule")  # noqa: N806
    for channel, capabilities in (
        (text, {"message.post", "message.reply", "message.edit_own", "file.upload"}),
        (audio, {"media.speak", "media.video", "media.share"}),
    ):
        policy = model("workspaces", "Channel").objects.get(pk=channel["id"]).explicit_policy_id
        stored = set(
            Rule.objects.filter(policy_id=policy, kind="deny_capability").values_list(
                "capability", flat=True
            )
        )
        assert stored == capabilities, f"ES-06: {channel['kind']} flag rules are {stored}"
    assert access_of(e, text["id"])[0]["read_only"] is True
    assert access_of(e, audio["id"])[0]["listen_only"] is True


# --- ES-07: disclosure ------------------------------------------------------------------------


def visible_ids(w, who):
    response = send(w, who, "get", READ)
    assert response.status_code == 200, response.content
    body = response.json()
    found = {c["id"] for c in body["uncategorised_channels"]}
    for category in body["categories"]:
        found |= {c["id"] for c in category["channels"]}
    return found


def test_es07_a_restricted_channel_is_disclosed_to_admins_only_by_the_administrative_read(e):
    general = starter(e)["general"]["id"]
    channel = create_channel(e, general, "privé")
    restricted = set_access(
        e, channel["id"], visibility="restricted", allow_members=[membership(e.member)]
    )
    assert restricted.status_code == 200, restricted.content
    assert channel["id"] in visible_ids(e, e.member), "ES-07: the allowed member does not see it"
    for who in ("billing", "admin", "owner"):
        assert channel["id"] not in visible_ids(e, getattr(e, who)), f"ES-07: {who} sees it"
    disclosed = rows(e, e.admin)[channel["id"]]
    assert disclosed["access"] == {"mode": "explicit"}, "ES-07: the admin read hides it"
    access, _ = access_of(e, channel["id"], e.admin)
    assert access["allow_members"] == [membership(e.member)]


# --- ES-08: audit -----------------------------------------------------------------------------


@pytest.mark.parametrize("operation", sorted(OPERATIONS))
def test_es08_every_mutation_writes_one_event_and_one_revision(e, operation):
    prepare, perform, status, action, _ = OPERATIONS[operation]
    context = prepare(e)
    before, start = len(events()), revision(e)
    response = perform(e, e.admin, context)
    assert response.status_code == status, response.content
    new = events()[before:]
    if action is None:
        assert (new, revision(e)) == ([], start), f"ES-08: the read {operation} wrote"
        return
    assert [event["action"] for event in new] == [action], f"ES-08: {operation} wrote {new}"
    event = new[0]
    assert event["actor_type"] == "tenant" and event["actor_id"] == e.admin.identity.id
    assert event["request_id"] == response.headers["X-Request-Id"]
    kind = "category" if "category" in action else "channel"
    assert event["target_urn"].startswith(f"urn:kodera:{kind}:")
    recorded = json.dumps([event["metadata"], event["before"], event["after"]], ensure_ascii=False)
    for secret in (*SECRET_NAMES, SECRET_TOPIC):
        assert secret not in recorded, f"ES-08: {operation}'s event carries a name or topic"
    assert revision(e) == start + 1, f"ES-08: {operation} did not increment structure_revision once"


def test_es08_a_change_that_changes_nothing_writes_nothing(e):
    channel = create_channel(e, None, topic="Sujet")
    before = written()
    same = patch_channel(e, channel, {"topic": "Sujet"})
    assert same.status_code == 200 and same.headers["ETag"] == channel["etag"]
    assert send(e, e.owner, "post", UNARCHIVE, channel_id=channel["id"]).status_code == 200
    assert written() == before, "ES-08: a no-op wrote an event or a revision"


# --- ES-12: room state ------------------------------------------------------------------------


def test_es12_every_channel_is_pending_until_acknowledged(e):
    create_channel(e, None, "salon", kind="audio")
    channels = [row for row in rows(e).values() if "room_state" in row]
    assert channels and {row["room_state"] for row in channels} == {"pending"}
    stored = model("workspaces", "Channel").objects.values_list("room_state", "applied_access_etag")
    assert set(stored) == {("pending", None)}


# --- ES-13: self-grant ------------------------------------------------------------------------


def notices(w, channel_id):
    """The channel's entry of the next channel set's input (§13.1)."""
    from apps.workspaces.channel_sets import channel_set_input

    workspace = model("workspaces", "Workspace").objects.get(organisation_id=w.alpha.id)
    with transaction.atomic():
        _, channels = channel_set_input(workspace.id)
    return next(item for item in channels if item["channel_id"] == channel_id)


def notice_ids(channel_id, person):
    return [
        str(pk)
        for pk in model("workspaces", "ChannelNotice")
        .objects.filter(channel_id=channel_id, membership_id=person.member.id)
        .values_list("id", flat=True)
    ]


def test_es13_an_admin_granting_themselves_is_flagged_and_announced_once(e):
    channel = create_channel(e, None, "direction")
    hidden = set_access(
        e, channel["id"], visibility="restricted", allow_members=[membership(e.owner)]
    )
    assert hidden.status_code == 200, hidden.content
    assert channel["id"] not in visible_ids(e, e.admin)

    others = set_access(
        e,
        channel["id"],
        who=e.admin,
        visibility="restricted",
        allow_members=[membership(e.owner), membership(e.member)],
    )
    assert others.status_code == 200, others.content
    granted = events("workspace.channel_access_changed")[-1]["metadata"]
    assert "self_grant" not in granted, "ES-13: granting someone else is flagged as a self-grant"
    assert notices(e, channel["id"])["notices"] == [], "ES-13: granting someone else is announced"

    before = len(events("workspace.channel_access_changed"))
    grant = document(
        visibility="restricted",
        allow_members=[membership(e.owner), membership(e.member), membership(e.admin)],
    )
    _, tag = access_of(e, channel["id"], e.admin)
    own = send(e, e.admin, "patch", ACCESS, grant, if_match=tag, channel_id=channel["id"])
    assert own.status_code == 200, own.content
    recorded = events("workspace.channel_access_changed")[before:]
    assert len(recorded) == 1 and recorded[0]["metadata"]["self_grant"] is True
    assert recorded[0]["metadata"]["allow_members_added"] == [membership(e.admin)]
    entry = notices(e, channel["id"])
    assert [n["notice_id"] for n in entry["notices"]] == notice_ids(channel["id"], e.admin), (
        "ES-13: not exactly one pending notice"
    )
    assert len(entry["notices"]) == 1 and "alpha-admin" in entry["members"]
    assert channel["id"] in visible_ids(e, e.admin), "ES-13: the grant did not let them view"

    assert notices(e, channel["id"])["access_etag"] == own.headers["ETag"], (
        "ES-13: the set does not carry the access tag"
    )


def pending_notices(channel_id):
    return list(
        model("workspaces", "ChannelNotice")
        .objects.filter(channel_id=channel_id, acknowledged_at__isnull=True)
        .values_list("membership_id", flat=True)
    )


def test_es13_granting_oneself_again_before_the_notice_is_acknowledged_keeps_one_notice(e):
    channel = create_channel(e, None, "direction")
    owner_only = {"visibility": "restricted", "allow_members": [membership(e.owner)]}
    with_admin = {**owner_only, "allow_members": [membership(e.owner), membership(e.admin)]}
    assert set_access(e, channel["id"], **owner_only).status_code == 200
    for step, (who, body) in enumerate(
        [(e.admin, with_admin), (e.admin, owner_only), (e.admin, with_admin)]
    ):
        response = set_access(e, channel["id"], who=who, **body)
        assert response.status_code == 200, f"ES-13 step {step}: {response.content[:200]!r}"
    flagged = [
        event["metadata"].get("self_grant") for event in events("workspace.channel_access_changed")
    ]
    assert flagged == [None, True, None, True], f"ES-13: self-grants flagged {flagged}"
    assert pending_notices(channel["id"]) == [e.admin.member.id], (
        "ES-13: a second self-grant before acknowledgement stored a second notice"
    )


def test_es13_an_archived_audio_room_self_grant_is_flagged_on_access_alone(e):
    room = create_channel(e, None, "salon-prive", kind="audio")
    assert (
        set_access(
            e, room["id"], visibility="restricted", allow_members=[membership(e.owner)]
        ).status_code
        == 200
    )
    assert send(e, e.owner, "post", ARCHIVE, channel_id=room["id"]).status_code == 200
    own = set_access(
        e,
        room["id"],
        who=e.admin,
        visibility="restricted",
        allow_members=[membership(e.owner), membership(e.admin)],
    )
    assert own.status_code == 200, own.content
    flagged = events("workspace.channel_access_changed")[-1]["metadata"]
    assert flagged.get("self_grant") is True, "ES-13: an archived room's self-grant is not flagged"
    assert pending_notices(room["id"]) == [e.admin.member.id]


def test_es13_an_admin_lifting_their_own_deny_is_a_self_grant(e):
    channel = create_channel(e, None, "direction")
    assert set_access(e, channel["id"], deny_members=[membership(e.admin)]).status_code == 200
    assert channel["id"] not in visible_ids(e, e.admin)
    lifted = set_access(e, channel["id"], who=e.admin)
    assert lifted.status_code == 200, lifted.content
    flagged = events("workspace.channel_access_changed")[-1]["metadata"]
    assert flagged.get("self_grant") is True and flagged["deny_members_removed"] == [
        membership(e.admin)
    ], "ES-13: lifting one's own deny is not a flagged self-grant"
    assert pending_notices(channel["id"]) == [e.admin.member.id]


# --- S2: an archived channel keeps its viewers -------------------------------------------------


def test_an_archived_audio_room_stays_visible_and_keeps_its_set_members(e):
    room = create_channel(e, None, "salon", kind="audio")
    assert send(e, e.owner, "post", ARCHIVE, channel_id=room["id"]).status_code == 200
    body = send(e, e.member, "get", READ).json()
    shown = {c["id"]: c for c in body["uncategorised_channels"]}
    assert shown.get(room["id"], {}).get("lifecycle") == "archived", (
        "an archived audio room is absent from getWorkspace or not shown archived"
    )
    entry = notices(e, room["id"])
    assert (
        entry["archived"] and entry["audience"] == "all" and "alpha-member" not in entry["denied"]
    ), "the channel set would empty an archived room"


# --- S3: the flags own only their capabilities --------------------------------------------------


def test_an_access_change_keeps_a_deny_the_flags_do_not_own(e):
    channel = create_channel(e, None)
    assert set_access(e, channel["id"]).status_code == 200
    Rule = model("workspaces", "ResourcePolicyRule")  # noqa: N806
    policy = model("workspaces", "Channel").objects.get(pk=channel["id"]).explicit_policy_id
    Rule.objects.create(policy_id=policy, kind="deny_capability", capability="message.pin")
    for flag in (True, False):
        changed = set_access(e, channel["id"], read_only=flag)
        assert changed.status_code == 200, changed.content
        stored = set(
            Rule.objects.filter(policy_id=policy, kind="deny_capability").values_list(
                "capability", flat=True
            )
        )
        assert "message.pin" in stored, "an access change dropped a deny the flags do not own"


def denies(policy_id):
    return set(
        model("workspaces", "ResourcePolicyRule")
        .objects.filter(policy_id=policy_id, kind="deny_capability")
        .values_list("capability", flat=True)
    )


def inherited_deny(w, capability):
    """A deny on the workspace default, which a new channel inherits."""
    default = (
        model("workspaces", "Workspace")
        .objects.values_list("default_policy_id", flat=True)
        .get(organisation_id=w.alpha.id)
    )
    model("workspaces", "ResourcePolicyRule").objects.create(
        policy_id=default, kind="deny_capability", capability=capability
    )


def own_policy(channel):
    return model("workspaces", "Channel").objects.get(pk=channel["id"]).explicit_policy_id


@pytest.mark.parametrize(
    ("capability", "flag"), [("message.pin", False), ("message.pin", True), ("message.post", False)]
)
def test_going_explicit_copies_every_inherited_deny(e, capability, flag):
    """A channel's own policy starts as the one it inherited, every deny included; a flag then
    adds its whole set only when it changes. A partial set, `message.post` alone, is not
    `read_only`, and survives going explicit with `read_only` false."""
    channel = create_channel(e, None)
    inherited_deny(e, capability)
    explicit = set_access(e, channel["id"], read_only=flag)
    assert explicit.status_code == 200, explicit.content
    expected = {capability} | (
        {"message.post", "message.reply", "message.edit_own", "file.upload"} if flag else set()
    )
    assert denies(own_policy(channel)) == expected, "going explicit did not copy the denies"


def test_a_flag_turned_on_then_off_restores_the_prior_denies(e):
    channel = create_channel(e, None)
    inherited_deny(e, "message.pin")
    assert set_access(e, channel["id"]).status_code == 200
    prior = denies(own_policy(channel))
    assert set_access(e, channel["id"], read_only=True).status_code == 200
    assert denies(own_policy(channel)) > prior
    assert set_access(e, channel["id"], read_only=False).status_code == 200
    assert denies(own_policy(channel)) == prior == {"message.pin"}


def stored_deny(channel, capability):
    """A deny on a channel's own policy that no flag owns whole."""
    model("workspaces", "ResourcePolicyRule").objects.create(
        policy_id=own_policy(channel), kind="deny_capability", capability=capability
    )


def test_an_explicit_partial_deny_survives_a_change_that_leaves_the_flag_off(e):
    """Regression: an explicit channel with `message.post` alone denied is not `read_only`, so a
    change of members with `read_only` false leaves that deny, and echoing the access back
    changes nothing at all."""
    channel = create_channel(e, None)
    assert set_access(e, channel["id"]).status_code == 200
    stored_deny(channel, "message.post")
    changed = set_access(
        e, channel["id"], visibility="restricted", allow_members=[membership(e.member)]
    )
    assert changed.status_code == 200, changed.content
    assert denies(own_policy(channel)) == {"message.post"}, "a member change dropped the deny"

    access, tag = access_of(e, channel["id"])
    assert access["read_only"] is False
    before = len(events())
    echo = {key: value for key, value in access.items() if key != "channel_id"}
    echoed = send(e, e.owner, "patch", ACCESS, echo, if_match=tag, channel_id=channel["id"])
    assert echoed.status_code == 200, echoed.content
    assert echoed.headers["ETag"] == tag, "echoing the access changed its tag"
    assert len(events()) == before, "echoing the access wrote an event"
    assert denies(own_policy(channel)) == {"message.post"}


def test_going_explicit_copies_an_inherited_partial_listen_only_set(e):
    room = create_channel(e, None, "salon", kind="audio")
    inherited_deny(e, "media.share")
    explicit = set_access(e, room["id"], listen_only=False)
    assert explicit.status_code == 200, explicit.content
    assert denies(own_policy(room)) == {"media.share"}, "going explicit dropped media.share"


def test_listen_only_turned_on_then_off_restores_the_prior_denies(e):
    room = create_channel(e, None, "salon", kind="audio")
    inherited_deny(e, "message.pin")
    assert set_access(e, room["id"]).status_code == 200
    assert set_access(e, room["id"], listen_only=True).status_code == 200
    assert denies(own_policy(room)) == {
        "message.pin",
        "media.speak",
        "media.video",
        "media.share",
    }
    assert set_access(e, room["id"], listen_only=False).status_code == 200
    assert denies(own_policy(room)) == {"message.pin"}


def test_a_flag_turned_on_then_off_drops_an_overlapping_earlier_deny(e):
    """The stated limit (§11): nothing records which denies a flag brought, so turning
    `read_only` off removes its whole set, an earlier `message.post` deny included."""
    channel = create_channel(e, None)
    assert set_access(e, channel["id"]).status_code == 200
    stored_deny(channel, "message.post")
    assert set_access(e, channel["id"], read_only=True).status_code == 200
    assert set_access(e, channel["id"], read_only=False).status_code == 200
    assert "message.post" not in denies(own_policy(channel)), "the overlapping deny was kept"


def test_es13_opening_a_restricted_channel_to_the_organisation_is_a_self_grant(e):
    channel = create_channel(e, None, "direction")
    assert (
        set_access(
            e, channel["id"], visibility="restricted", allow_members=[membership(e.owner)]
        ).status_code
        == 200
    )
    opened = set_access(e, channel["id"], who=e.admin)
    assert opened.status_code == 200, opened.content
    flagged = events("workspace.channel_access_changed")[-1]["metadata"]
    assert flagged["self_grant"] is True
    entry = notices(e, channel["id"])
    assert [n["notice_id"] for n in entry["notices"]] == notice_ids(channel["id"], e.admin)
    assert entry["audience"] == "all" and "alpha-billing" not in entry["denied"]
    assert entry["exempt"] == [], "exempt is listed without a flag"


def test_an_unavailable_stored_row_answers_503_on_both_reads(e, monkeypatch):
    from apps.workspaces.api import administration as views
    from apps.workspaces.structure import WorkspaceUnavailableError

    def unavailable(**kwargs):
        raise WorkspaceUnavailableError()

    channel = create_channel(e, None)
    monkeypatch.setattr(views, "read_access", unavailable)
    monkeypatch.setattr(views, "read_administration", unavailable)
    for template, ids in ((ACCESS, {"channel_id": channel["id"]}), (ADMINISTRATION, {})):
        response = send(e, e.owner, "get", template, **ids)
        refused = problem(response, 503, "service-unavailable")
        assert response.headers["Retry-After"] == str(refused["retry_after_s"])
