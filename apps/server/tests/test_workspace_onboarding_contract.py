"""Contract 0.13.0: the workspace read and initialise operations, and the replay declarations.

Source assertions over contracts/core-api.openapi.yaml and docs/api/AUTHZ.md, not proof that
either operation is implemented (docs/specs/PILOT_WORKSPACE_ONBOARDING.md §7 is K9's).
Every check fails with a fixed message, and a mutation proves each message can be produced.
"""

import copy
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
TENANT_ROLES = ["org_owner", "org_admin", "org_billing", "org_member"]
KEY_REF = "#/components/parameters/IdempotencyKey"
REPLAYED_REF = {"$ref": "#/components/headers/IdempotencyReplayed"}
REPLAYABLE_SHARED = (
    "MalformedRequest",
    "NotFound",
    "Conflict",
    "ValidationError",
    "PayloadTooLarge",
    "UnsupportedMediaType",
)
STARTER_KEYS = ("general", "team", "welcome")
CLOSED_SCHEMAS = (
    "Workspace",
    "WorkspaceSetup",
    "WorkspaceCategory",
    "WorkspaceChannel",
    "WorkspaceInitialisation",
)
CONTENT_WORDS = ("message", "file", "occupan", "member", "rule", "position", "revision")


def operation(contract, path, method):
    return contract["paths"][path][method]


def keyed_posts(contract):
    for path, item in contract["paths"].items():
        op = item.get("post")
        if op and {"$ref": KEY_REF} in op.get("parameters", []):
            yield path, op


def schema_ref(response):
    return response["content"]["application/json"]["schema"]


def check_example(example, schema, schemas, where):
    """Required members present and no member the schema does not declare, recursively."""
    if "$ref" in schema:
        schema = schemas[schema["$ref"].rsplit("/", 1)[-1]]
    if "oneOf" in schema:
        return
    if schema.get("type") == "object" or "properties" in schema:
        assert isinstance(example, dict), where
        assert set(schema.get("required", [])) <= example.keys(), where
        assert example.keys() <= schema["properties"].keys(), where
        for key, value in example.items():
            check_example(value, schema["properties"][key], schemas, f"{where}.{key}")
    elif schema.get("type") == "array":
        for index, item in enumerate(example):
            check_example(item, schema["items"], schemas, f"{where}[{index}]")
    elif "enum" in schema:
        assert example in schema["enum"], where
    elif "pattern" in schema and example is not None:
        assert re.search(schema["pattern"], example), where


def assert_contract(contract, authz):
    version = tuple(int(part) for part in contract["info"]["version"].split("."))
    assert version >= (0, 13, 0), "version"
    schemas = contract["components"]["schemas"]

    get = operation(contract, "/organisations/{organisation_id}/workspace", "get")
    assert get["operationId"] == "getWorkspace", "get-shape"
    assert get["x-kodera-scope"] == "workspace:read", "get-scope"
    assert get["x-kodera-authz"]["roles"] == TENANT_ROLES, "get-roles"
    assert [p["name"] for p in get.get("parameters", [])] == ["If-None-Match"], "get-shape"
    assert "requestBody" not in get, "get-shape"
    assert set(get["responses"]) == {"200", "304", "400", "401", "403", "404", "429", "500"}, (
        "get-shape"
    )
    for status in ("200", "304"):
        headers = get["responses"][status]["headers"]
        assert headers["ETag"]["required"] is True, "get-etag"
        assert "rendered view" in headers["ETag"]["description"], "get-etag"
        assert headers["Cache-Control"]["schema"]["enum"] == ["no-store"], "get-etag"
    assert schema_ref(get["responses"]["200"]) == {"$ref": "#/components/schemas/Workspace"}, (
        "get-shape"
    )

    init = operation(
        contract, "/organisations/{organisation_id}/workspace/actions/initialise", "post"
    )
    assert init["operationId"] == "initialiseWorkspace", "init-shape"
    assert init["x-kodera-scope"] == "workspace:act", "init-scope"
    assert init["x-kodera-authz"]["roles"] == ["org_owner", "org_admin"], "init-roles"
    assert init["parameters"] == [{"$ref": KEY_REF}], "init-key"
    assert "requestBody" not in init, "init-shape"
    assert {"200", "201", "400", "409"} <= set(init["responses"]), "init-shape"
    for status in ("200", "201"):
        assert schema_ref(init["responses"][status]) == {
            "$ref": "#/components/schemas/WorkspaceInitialisation"
        }, "init-no-structure"
        assert init["responses"][status]["headers"].get("Location", {}).get("required") is True, (
            "init-location"
        )
    assert schemas["WorkspaceInitialisation"]["properties"] == {
        "state": {"type": "string", "const": "initialised"}
    }, "init-no-structure"
    assert "202" not in init["responses"], "init-synchronous"

    for name in CLOSED_SCHEMAS:
        assert schemas[name]["additionalProperties"] is False, "closed-schema"
        for prop in schemas[name]["properties"]:
            assert not any(word in prop for word in CONTENT_WORDS), "structure-only"
    assert schemas["WorkspaceState"]["enum"] == ["not_initialised", "initialised"], "enums"
    assert schemas["WorkspaceSetupState"]["enum"] == ["pending", "running", "ready", "failed"], (
        "enums"
    )
    assert schemas["WorkspaceSetupReason"]["enum"] == [
        "awaiting_owner_confirmation",
        "issuer_untrusted",
        "realm_job_failed",
    ], "enums"
    assert schemas["WorkspaceChannel"]["properties"]["lifecycle"]["enum"] == [
        "active",
        "archived",
    ], "enums"
    pattern = schemas["WorkspaceTemplateKey"]["pattern"]
    for key in STARTER_KEYS:
        assert re.search(pattern, key), "template-keys"
    for refused in ("General", "", "x" * 33, "welcome\n"):
        assert not re.search(pattern, refused), "template-keys"
    for index, example in enumerate(schemas["Workspace"]["examples"]):
        check_example(example, schemas["Workspace"], schemas, f"examples-{index}")

    headers = contract["components"]["headers"]
    assert headers["IdempotencyReplayed"]["schema"] == {"type": "string", "const": "true"}, (
        "replay-header"
    )
    count = 0
    for _, op in keyed_posts(contract):
        count += 1
        for status, response in op["responses"].items():
            if "$ref" in response:
                continue  # a shared response: REPLAYABLE_SHARED is checked below
            replayable = status.startswith("2") or (
                status.startswith("4") and status not in {"401", "408", "429"}
            )
            if replayable:
                assert response["headers"].get("Idempotency-Replayed") == REPLAYED_REF, (
                    "replay-header"
                )
    assert count >= 28, "replay-header"
    for name in REPLAYABLE_SHARED:
        assert (
            contract["components"]["responses"][name]["headers"].get("Idempotency-Replayed")
            == REPLAYED_REF
        ), "replay-header"

    first_seen = schemas["Problem"]["properties"].get("first_seen_at", {})
    assert first_seen, "first-seen"
    assert first_seen["format"] == "date-time", "first-seen"
    assert "idempotency-key-reuse" in first_seen["description"], "first-seen"

    key = contract["components"]["parameters"]["IdempotencyKey"]
    assert "malformed-request" in key["description"], "key-malformed"
    assert "only after a `5xx` or a network" in key["description"], "key-retry"
    assert "after any `4xx`" in key["description"], "key-retry"
    assert not re.search(r"\b\d+ `POST`", key["description"]), "key-count"
    vectors = [
        ("k" * 16, True),
        ("k" * 255, True),
        ("00000000-0000-4000-8000-000000000001", True),
        ("k" * 15, False),
        ("k" * 256, False),
        ("k" * 8 + " " + "k" * 8, False),
        ("k" * 16 + "\n", False),
        ("é" * 16, False),
    ]
    for value, valid in vectors:
        assert bool(re.search(key["schema"]["pattern"], value)) is valid, "key-pattern"

    row = next((line for line in authz.splitlines() if line.startswith("| `Workspace`")), None)
    assert row is not None, "authz-row"
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    assert (
        cells[1:3]
        == ["read own, create own, update own, delete own, act own (initialise, archive)"] * 2
    ), "authz-row"
    assert cells[3:5] == ["read own"] * 2, "authz-row"
    assert cells[5:] == ["—"] * 4, "authz-row"


@pytest.fixture(scope="module")
def contract():
    return yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())


@pytest.fixture(scope="module")
def authz():
    return (ROOT / "docs/api/AUTHZ.md").read_text()


def test_actual_contract(contract, authz):
    assert_contract(contract, authz)


GET = ("/organisations/{organisation_id}/workspace", "get")
INIT = ("/organisations/{organisation_id}/workspace/actions/initialise", "post")


def widen_get(c):
    c["paths"][GET[0]][GET[1]]["x-kodera-authz"]["roles"].append("staff_support")


def widen_init(c):
    c["paths"][INIT[0]][INIT[1]]["x-kodera-authz"]["roles"].append("org_member")


def drop_key(c):
    c["paths"][INIT[0]][INIT[1]]["parameters"] = []


def make_async(c):
    c["paths"][INIT[0]][INIT[1]]["responses"]["202"] = {"description": "accepted"}


def open_schema(c):
    c["components"]["schemas"]["WorkspaceChannel"]["additionalProperties"] = True


def add_content(c):
    c["components"]["schemas"]["WorkspaceChannel"]["properties"]["last_message"] = {}


def add_position(c):
    c["components"]["schemas"]["WorkspaceCategory"]["properties"]["position"] = {}


def grow_reason(c):
    c["components"]["schemas"]["WorkspaceSetupReason"]["enum"].append("other")


def narrow_template(c):
    c["components"]["schemas"]["WorkspaceTemplateKey"]["pattern"] = "^[a-z]{1,4}$"


def bad_example(c):
    c["components"]["schemas"]["Workspace"]["examples"][0]["extra"] = 1


def unmark_replay(c):
    op = c["paths"]["/organisations"]["post"]
    op["responses"]["201"]["headers"].pop("Idempotency-Replayed")


def unmark_quota_replay(c):
    op = next(op for _, op in keyed_posts(c) if op["operationId"] == "createWorkspaceCollection")
    op["responses"]["402"]["headers"].pop("Idempotency-Replayed")


def unmark_shared(c):
    c["components"]["responses"]["Conflict"]["headers"].pop("Idempotency-Replayed")


def drop_first_seen(c):
    c["components"]["schemas"]["Problem"]["properties"].pop("first_seen_at")


def recount(c):
    key = c["components"]["parameters"]["IdempotencyKey"]
    key["description"] += "\nAll 29 `POST` methods."


def loosen_pattern(c):
    c["components"]["parameters"]["IdempotencyKey"]["schema"]["pattern"] = "^.{16,255}$"


def init_returns_workspace(c):
    op = c["paths"][INIT[0]][INIT[1]]
    op["responses"]["200"]["content"]["application/json"]["schema"] = {
        "$ref": "#/components/schemas/Workspace"
    }


def init_body_grows(c):
    c["components"]["schemas"]["WorkspaceInitialisation"]["properties"]["categories"] = {}


def drop_location(c):
    c["paths"][INIT[0]][INIT[1]]["responses"]["200"]["headers"].pop("Location")


def add_revision(c):
    c["components"]["schemas"]["Workspace"]["properties"]["structure_revision"] = {}


def drop_429(c):
    c["paths"][GET[0]][GET[1]]["responses"].pop("429")


def store_etag(c):
    etag = c["paths"][GET[0]][GET[1]]["responses"]["200"]["headers"]["ETag"]
    etag["description"] = "Strong tag of the stored workspace."


def same_key_after_4xx(c):
    key = c["components"]["parameters"]["IdempotencyKey"]
    key["description"] = key["description"].replace("after any `4xx`", "after a `409`")


MUTANTS = {
    "init-workspace": (init_returns_workspace, "init-no-structure"),
    "init-body": (init_body_grows, "init-no-structure"),
    "location": (drop_location, "init-location"),
    "revision": (add_revision, "structure-only"),
    "no-429": (drop_429, "get-shape"),
    "store-etag": (store_etag, "get-etag"),
    "key-retry": (same_key_after_4xx, "key-retry"),
    "widen-get": (widen_get, "get-roles"),
    "widen-init": (widen_init, "init-roles"),
    "drop-key": (drop_key, "init-key"),
    "async": (make_async, "init-synchronous"),
    "open-schema": (open_schema, "closed-schema"),
    "content": (add_content, "structure-only"),
    "position": (add_position, "structure-only"),
    "reason": (grow_reason, "enums"),
    "template": (narrow_template, "template-keys"),
    "example": (bad_example, "examples-0"),
    "unmark-inline": (unmark_replay, "replay-header"),
    "unmark-shared": (unmark_shared, "replay-header"),
    "unmark-quota": (unmark_quota_replay, "replay-header"),
    "first-seen": (drop_first_seen, "first-seen"),
    "count": (recount, "key-count"),
    "pattern": (loosen_pattern, "key-pattern"),
}


@pytest.mark.parametrize("name", sorted(MUTANTS))
def test_each_mutant_is_refused_by_its_check(contract, authz, name):
    mutate, message = MUTANTS[name]
    damaged = copy.deepcopy(contract)
    mutate(damaged)
    with pytest.raises(AssertionError, match=re.escape(message)):
        assert_contract(damaged, authz)


@pytest.mark.parametrize(
    "old,new",
    [
        (
            "| read own | read own | — | — | — | — |",
            "| read own | read own | read all | — | — | — |",
        ),
        ("| `Workspace`, `Category`, `Channel` |", "| `Workspaces` |"),
    ],
)
def test_authz_row_mutants_are_refused(contract, authz, old, new):
    assert old in authz
    with pytest.raises(AssertionError, match="authz-row"):
        assert_contract(contract, authz.replace(old, new, 1))
