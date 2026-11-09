"""Contract 0.22.0: the Espace structure operations, their AUTHZ cells and their audit actions.

Source assertions over contracts/core-api.openapi.yaml, docs/api/AUTHZ.md and
docs/domain/AUDIT_TAXONOMY.md (docs/specs/ESPACE_STRUCTURE.md §§2, 3, 8, 9). Every check fails with
a fixed message, and a mutation proves each message can be produced.
"""

import copy
import re
from pathlib import Path

import jsonschema_rs
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
BASE = "/organisations/{organisation_id}/workspace"
ADMINISTERING = ["org_owner", "org_admin"]
KEY = {"$ref": "#/components/parameters/IdempotencyKey"}
IF_MATCH = {"$ref": "#/components/parameters/IfMatch"}
OPERATIONS = {
    "createCategory": (BASE + "/categories", "post", "workspace:create"),
    "patchCategory": (BASE + "/categories/{category_id}", "patch", "workspace:update"),
    "deleteCategory": (BASE + "/categories/{category_id}", "delete", "workspace:delete"),
    "createChannel": (BASE + "/channels", "post", "workspace:create"),
    "patchChannel": (BASE + "/channels/{channel_id}", "patch", "workspace:update"),
    "archiveChannel": (BASE + "/channels/{channel_id}/actions/archive", "post", "workspace:act"),
    "unarchiveChannel": (
        BASE + "/channels/{channel_id}/actions/unarchive",
        "post",
        "workspace:act",
    ),
    "getChannelAccess": (BASE + "/channels/{channel_id}/access", "get", "workspace:read"),
    "patchChannelAccess": (BASE + "/channels/{channel_id}/access", "patch", "workspace:update"),
    "getWorkspaceAdministration": (BASE + "/administration", "get", "workspace:read"),
}
ACCESS_FIELDS = {"mode", "visibility", "allow_members", "deny_members", "read_only", "listen_only"}
NEW_SLUGS = [
    "notify",
    "staging",
    "status",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
    "auth-admin",
    "auth-mail",
]
AUDIT_ACTIONS = {
    "workspace.category_created": "category",
    "workspace.category_updated": "category",
    "workspace.category_deleted": "category",
    "workspace.channel_created": "channel",
    "workspace.channel_updated": "channel",
    "workspace.channel_archived": "channel",
    "workspace.channel_unarchived": "channel",
    "workspace.channel_access_changed": "channel",
}
AUTHZ_CELL = "read own, create own, update own, delete own, act own (initialise, archive)"


def _response(contract, node, kind="responses"):
    while "$ref" in node:
        node = contract["components"][kind][node["$ref"].rsplit("/", 1)[-1]]
    return node


def assert_contract(contract, authz, taxonomy):
    version = tuple(int(part) for part in contract["info"]["version"].split("."))
    assert version >= (0, 22, 0), "version"
    schemas = contract["components"]["schemas"]

    for operation_id, (path, method, scope) in OPERATIONS.items():
        op = contract["paths"].get(path, {}).get(method)
        assert op is not None and op["operationId"] == operation_id, "operations"
        assert op["x-kodera-scope"] == scope, "scopes"
        assert op["x-kodera-authz"]["roles"] == ADMINISTERING, "roles"
        responses = op["responses"]
        assert {"400", "401", "403", "404", "429", "500"} <= set(responses), "responses"
        if method == "post":
            assert op["parameters"] == [KEY], "idempotency-key"
        if method == "patch":
            assert op["parameters"] == [IF_MATCH], "if-match"
            assert {"412", "422", "428", "503"} <= set(responses), "if-match"
            assert set(op["requestBody"]["content"]) == {"application/merge-patch+json"}, "media"
        if method == "get":
            unavailable = _response(contract, responses.get("503", {}))
            assert unavailable.get("headers", {}).get("Retry-After", {}).get("required"), (
                "unavailable"
            )
        else:
            busy = _response(contract, responses.get("503", {}))
            assert busy.get("headers", {}).get("Retry-After", {}).get("required"), "busy"
        if operation_id.startswith(("create", "patch")):
            assert "422" in responses, "validation"
        if method in ("get", "patch") or operation_id.startswith("create"):
            ok = responses["201" if operation_id.startswith("create") else "200"]
            etag = _response(contract, ok["headers"].get("ETag", {}), "headers")
            assert etag.get("required") is True, "etag"

    delete = contract["paths"][BASE + "/categories/{category_id}"]["delete"]
    assert "content" not in delete["responses"]["204"], "delete"
    assert [p["name"] for p in delete["parameters"]] == ["If-Match"], "delete"
    assert delete["parameters"][0]["required"] is False, "delete"
    assert {"409", "412"} <= set(delete["responses"]), "delete"
    reason = schemas["Problem"]["properties"]["reason"]["description"]
    for value in ("category_not_empty", "channel_limit", "channel_set_too_large"):
        assert f"`{value}`" in reason, "reason"
    for name in ("createChannel", "patchChannel", "patchChannelAccess", "archiveChannel"):
        path, method, _ = OPERATIONS[name]
        assert "409" in contract["paths"][path][method]["responses"], "reason"
    assert "No value is defined yet" not in reason, "reason"

    admin = contract["paths"][BASE + "/administration"]["get"]
    headers = admin["responses"]["200"]["headers"]
    assert headers["Cache-Control"]["schema"]["enum"] == ["no-store"], "admin-read"
    assert "rendered" in headers["ETag"]["description"], "admin-read"
    channel = schemas["WorkspaceAdminChannel"]
    assert {"etag", "lifecycle", "room_state", "access"} <= set(channel["required"]), "admin-read"
    assert schemas["ChannelRoomState"]["enum"] == ["pending", "ready", "failed"], "room-state"
    assert channel["properties"]["room_state"] == {
        "$ref": "#/components/schemas/ChannelRoomState"
    }, "room-state"
    read = schemas["WorkspaceChannel"]
    assert "room_state" in read["required"], "room-state"
    assert read["properties"]["room_state"]["$ref"] == "#/components/schemas/ChannelRoomState", (
        "room-state"
    )
    assert schemas["AppCode"]["enum"] == ["visio", "docs", "drive", "messaging", "grist"], (
        "app-code"
    )
    initialise = contract["paths"][BASE + "/actions/initialise"]["post"]["description"]
    assert "`lounge`" in initialise and "`template_version: 2`" in initialise, "template"
    for name in ("WorkspaceAdministration", "WorkspaceAdminCategory", "ChannelAccess"):
        assert schemas[name]["additionalProperties"] is False, "closed-schema"

    request = schemas["ChannelAccessPatchRequest"]
    assert set(request["required"]) == ACCESS_FIELDS == set(request["properties"]), "access-whole"
    assert request["additionalProperties"] is False, "access-whole"
    for name in ("CategoryPatchRequest", "ChannelPatchRequest"):
        assert schemas[name]["additionalProperties"] is False, "patch-shape"
        assert schemas[name].get("minProperties") == 1, "patch-shape"
    assert "kind" not in schemas["ChannelPatchRequest"]["properties"], "patch-shape"

    slug = schemas["OrganisationCreateRequest"]["properties"]["slug"]
    assert set(NEW_SLUGS) <= set(slug["not"]["enum"]), "slugs"
    patch = jsonschema_rs.validator_for(
        {**schemas["OrganisationPatchRequest"], "components": contract["components"]}
    )
    assert not patch.is_valid({"slug": "acme-sa"}), "slug-immutable"

    row = next((line for line in authz.splitlines() if line.startswith("| `Workspace`")), None)
    assert row is not None, "authz-row"
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    assert cells[1:3] == [AUTHZ_CELL] * 2, "authz-row"
    assert cells[3:5] == ["read own"] * 2, "authz-row"
    assert cells[5:] == ["—"] * 4, "authz-row"
    assert "is not granted by this row yet" not in authz, "authz-note"

    for action, target in AUDIT_ACTIONS.items():
        line = next((x for x in taxonomy.splitlines() if f"`{action}`" in x and "|" in x), "")
        assert f"| tenant | `{target}` |" in line, "audit"
    for urn in ("category", "channel"):
        assert re.search(rf"^\| `{urn}` \| UUIDv7 \|", taxonomy, re.MULTILINE), "audit-urn"


@pytest.fixture(scope="module")
def contract():
    return yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())


@pytest.fixture(scope="module")
def authz():
    return (ROOT / "docs/api/AUTHZ.md").read_text()


@pytest.fixture(scope="module")
def taxonomy():
    return (ROOT / "docs/domain/AUDIT_TAXONOMY.md").read_text()


def test_actual_contract(contract, authz, taxonomy):
    assert_contract(contract, authz, taxonomy)


def _op(c, name):
    path, method, _ = OPERATIONS[name]
    return c["paths"][path][method]


def widen(c):
    _op(c, "patchChannelAccess")["x-kodera-authz"]["roles"].append("org_member")


def rescope(c):
    _op(c, "archiveChannel")["x-kodera-scope"] = "workspace:update"


def drop_if_match(c):
    _op(c, "patchCategory")["parameters"] = []


def drop_key(c):
    _op(c, "createChannel")["parameters"] = []


def drop_busy(c):
    _op(c, "createCategory")["responses"].pop("503")


def drop_etag(c):
    _op(c, "getChannelAccess")["responses"]["200"]["headers"].pop("ETag")


def no_reason(c):
    reason = c["components"]["schemas"]["Problem"]["properties"]["reason"]
    reason["description"] = "No value is defined yet."


def cache_admin(c):
    headers = _op(c, "getWorkspaceAdministration")["responses"]["200"]["headers"]
    headers["Cache-Control"]["schema"]["enum"] = ["private"]


def grow_room_state(c):
    c["components"]["schemas"]["ChannelRoomState"]["enum"].append("unknown")


def partial_access(c):
    c["components"]["schemas"]["ChannelAccessPatchRequest"]["required"].remove("listen_only")


def kind_patchable(c):
    c["components"]["schemas"]["ChannelPatchRequest"]["properties"]["kind"] = {}


def drop_slug(c):
    slug = c["components"]["schemas"]["OrganisationCreateRequest"]["properties"]["slug"]
    slug["not"]["enum"].remove("matrix")


def patchable_slug(c):
    c["components"]["schemas"]["OrganisationPatchRequest"]["properties"]["slug"] = {}


def tchap(c):
    c["components"]["schemas"]["AppCode"]["enum"][3] = "tchap"


def unread_room_state(c):
    c["components"]["schemas"]["WorkspaceChannel"]["required"].remove("room_state")


def old_version(c):
    c["info"]["version"] = "0.21.0"


def rename_operation(c):
    _op(c, "patchChannel")["operationId"] = "updateChannel"


def drop_429(c):
    _op(c, "unarchiveChannel")["responses"].pop("429")


def plain_json_patch(c):
    _op(c, "patchChannelAccess")["requestBody"]["content"] = {
        "application/json": {"schema": {"$ref": "#/components/schemas/ChannelAccessPatchRequest"}}
    }


def required_delete_if_match(c):
    _op(c, "deleteCategory")["parameters"][0]["required"] = True


def drop_422(c):
    _op(c, "createChannel")["responses"].pop("422")


def drop_unavailable(c):
    _op(c, "getWorkspaceAdministration")["responses"].pop("503")


def template_one(c):
    op = c["paths"][BASE + "/actions/initialise"]["post"]
    op["description"] = op["description"].replace("`template_version: 2`", "`template_version: 1`")


def open_access(c):
    c["components"]["schemas"]["ChannelAccess"]["additionalProperties"] = True


MUTANTS = {
    "widen": (widen, "roles"),
    "rescope": (rescope, "scopes"),
    "if-match": (drop_if_match, "if-match"),
    "key": (drop_key, "idempotency-key"),
    "busy": (drop_busy, "busy"),
    "etag": (drop_etag, "etag"),
    "reason": (no_reason, "reason"),
    "cache": (cache_admin, "admin-read"),
    "room-state": (grow_room_state, "room-state"),
    "partial-access": (partial_access, "access-whole"),
    "kind": (kind_patchable, "patch-shape"),
    "slugs": (drop_slug, "slugs"),
    "slug-patch": (patchable_slug, "slug-immutable"),
    "open": (open_access, "closed-schema"),
    "tchap": (tchap, "app-code"),
    "version": (old_version, "version"),
    "operation": (rename_operation, "operations"),
    "no-429": (drop_429, "responses"),
    "media": (plain_json_patch, "media"),
    "delete": (required_delete_if_match, "delete"),
    "validation": (drop_422, "validation"),
    "unavailable": (drop_unavailable, "unavailable"),
    "template": (template_one, "template"),
    "unread-room-state": (unread_room_state, "room-state"),
}


@pytest.mark.parametrize("name", sorted(MUTANTS))
def test_each_mutant_is_refused_by_its_check(contract, authz, taxonomy, name):
    mutate, message = MUTANTS[name]
    damaged = copy.deepcopy(contract)
    mutate(damaged)
    with pytest.raises(AssertionError, match=re.escape(message)):
        assert_contract(damaged, authz, taxonomy)


@pytest.mark.parametrize(
    ("document", "old", "new", "message"),
    [
        ("authz", AUTHZ_CELL, "read own, act own (initialise)", "authz-row"),
        ("taxonomy", "| `workspace.channel_access_changed` | tenant |", "| x |", "audit"),
        ("taxonomy", "| `channel` | UUIDv7 |", "| `chan` | UUIDv7 |", "audit-urn"),
        (
            "authz",
            "Every one of those writes needs an `active` organisation (§2 step 8).",
            "Administering structure is not granted by this row yet.",
            "authz-note",
        ),
    ],
)
def test_document_mutants_are_refused(contract, authz, taxonomy, document, old, new, message):
    texts = {"authz": authz, "taxonomy": taxonomy}
    assert old in texts[document]
    texts[document] = texts[document].replace(old, new, 1)
    with pytest.raises(AssertionError, match=re.escape(message)):
        assert_contract(contract, texts["authz"], texts["taxonomy"])
