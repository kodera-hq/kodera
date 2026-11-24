"""Confidential Core wire boundaries and independently mutated refusal controls."""

import base64
from copy import deepcopy
from functools import partial
from pathlib import Path

import jsonschema_rs
import pytest
import yaml

_load_yaml = partial(yaml.load, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))


ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "packages/api-contract/core-api.openapi.yaml"
BASE = "/organisations/{organisation_id}/confidential/"
ROOM = BASE + "rooms/{room_id}/"
OPERATIONS = {
    (BASE + "devices", "post"): ("registerConfidentialDevice", "confidential_device:create"),
    (BASE + "devices/revoke", "post"): ("revokeConfidentialDevice", "confidential_device:act"),
    (BASE + "key-packages", "post"): (
        "publishConfidentialKeyPackage",
        "confidential_key_package:create",
    ),
    (BASE + "rooms", "post"): ("createConfidentialRoom", "confidential_room:create"),
    (ROOM + "key-packages/claims", "post"): (
        "claimConfidentialKeyPackage",
        "confidential_key_package:act",
    ),
    (ROOM + "commits", "post"): ("commitConfidentialEpoch", "confidential_room:act"),
    (ROOM + "participants/retire", "post"): (
        "retireConfidentialParticipant",
        "confidential_room:act",
    ),
    (ROOM + "envelopes", "post"): ("sendConfidentialEnvelope", "confidential_envelope:create"),
    (ROOM + "envelopes", "get"): ("listConfidentialEnvelopes", "confidential_envelope:read"),
}
ADMINS = {"createConfidentialRoom", "claimConfidentialKeyPackage"}
ROLES = {"org_owner", "org_admin", "org_member", "org_billing"}
IDENTIFIER = "01950000-0000-7000-8000-0000000000a1"


def document():
    return _load_yaml(CONTRACT.read_text())


def guard(value):
    assert value["info"]["version"] == "0.57.0"
    for (path, method), (name, scope) in OPERATIONS.items():
        operation = value["paths"][path][method]
        assert operation["operationId"] == name and operation["x-kodera-scope"] == scope
        assert operation["security"] == [{"keycloakTenant": []}]
        assert set(operation["x-kodera-authz"]["roles"]) == (
            {"org_owner", "org_admin"} if name in ADMINS else ROLES
        )
        assert {"400", "401", "403", "404", "409", "422", "429", "503"} <= operation[
            "responses"
        ].keys()
        if method == "post":
            assert {"$ref": "#/components/parameters/IdempotencyKey"} in operation["parameters"]
            reference = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
            schema = value["components"]["schemas"][reference.rsplit("/", 1)[1]]
            assert schema["additionalProperties"] is False
            assert "signature" in schema["required"]
            if name in {"claimConfidentialKeyPackage", "retireConfidentialParticipant"}:
                assert reference == "#/components/schemas/ConfidentialEpochTargetDevice"
                assert "epoch" in schema["required"]
                assert {
                    key: schema["properties"]["epoch"][key]
                    for key in ("type", "minimum", "maximum")
                } == {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2**53 - 1,
                }
    guard_commit_marker(value)
    schemas = value["components"]["schemas"]
    assert schemas["ConfidentialApplication"]["properties"]["epoch"]["maximum"] == 2**53 - 1
    assert schemas["ConfidentialEpochCommit"]["properties"]["deviceIds"]["maxItems"] == 128
    assert schemas["ConfidentialEpochCommit"]["properties"]["deviceIds"]["uniqueItems"] is True
    assert schemas["ConfidentialEnvelopePage"]["properties"]["envelopes"]["maxItems"] == 100
    assert schemas["ConfidentialApplication"]["properties"]["ciphertext"]["maxLength"] == 4 * (
        (81920 + 2) // 3
    )


def validator(name, value=None):
    value = value or document()
    return jsonschema_rs.validator_for(
        {
            "$ref": "#/components/schemas/" + name,
            "components": value["components"],
        }
    )


def application():
    return {
        "deviceId": IDENTIFIER,
        "epoch": 1,
        "ciphertext": base64.b64encode(bytes(32)).decode(),
        "signature": base64.b64encode(bytes(64)).decode(),
    }


def test_canonical_operations_are_closed_and_every_mirror_matches():
    value = document()
    guard(value)
    for name, schema in value["components"]["schemas"].items():
        if name.startswith("Confidential"):
            assert schema["examples"]
            for example in schema["examples"]:
                assert validator(name, value).is_valid(example), name
    for target in ("apps/server/contracts", "apps/web/contracts"):
        assert (ROOT / target / CONTRACT.name).read_bytes() == CONTRACT.read_bytes()
    assert not any(
        isinstance(token, yaml.tokens.AliasToken)
        for token in yaml.scan(
            CONTRACT.read_text(), Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader)
        )
    )


@pytest.mark.parametrize(
    "field", ["plaintext", "body", "privateKey", "mediaKey", "membershipId", "role"]
)
def test_application_does_not_admit_plaintext_private_material_or_caller_authority(field):
    wire = application()
    assert validator("ConfidentialApplication").is_valid(wire)
    wire[field] = "untrusted"
    assert not validator("ConfidentialApplication").is_valid(wire)


@pytest.mark.parametrize("epoch", [-1, 2**53, 1.5, "1", True])
def test_epochs_are_exact_bounded_json_integers(epoch):
    wire = application()
    wire["epoch"] = epoch
    assert not validator("ConfidentialApplication").is_valid(wire)


@pytest.mark.parametrize("path", [ROOM + "key-packages/claims", ROOM + "participants/retire"])
def test_claim_and_retirement_require_the_signed_current_epoch(path):
    value = document()
    reference = value["paths"][path]["post"]["requestBody"]["content"]["application/json"][
        "schema"
    ]["$ref"]
    name = reference.rsplit("/", 1)[1]
    check = validator(name, value)
    wire = deepcopy(value["components"]["schemas"][name]["examples"][0])
    assert check.is_valid(wire)
    for epoch in (0, 2**53 - 1):
        assert check.is_valid({**wire, "epoch": epoch})
    for epoch in (-1, 2**53, 1.5, "1", True):
        assert not check.is_valid({**wire, "epoch": epoch})
    wire.pop("epoch")
    assert not check.is_valid(wire)
    # Permanent device revocation has no room epoch and keeps its original body.
    revoke = validator("ConfidentialTargetDevice", value)
    assert revoke.is_valid(wire)
    assert not revoke.is_valid({**wire, "epoch": 0})


def test_binary_fields_have_standard_padding_and_size_boundaries():
    schema = validator("ConfidentialApplication")
    for encoded in ("", "not base64", "AA", "AA-_", base64.b64encode(bytes(81924)).decode()):
        wire = {**application(), "ciphertext": encoded}
        assert not schema.is_valid(wire)
    wire = application()
    for size in (0, 32, 63, 65):
        wire["signature"] = base64.b64encode(bytes(size)).decode()
        assert not schema.is_valid(wire)


@pytest.mark.parametrize(
    "mutation",
    [
        "staff",
        "anonymous",
        "member-admin",
        "missing-replay",
        "open-request",
        "optional-proof",
        "unbounded-epoch",
        "optional-target-epoch",
        "unbounded-target-epoch",
        "duplicate-roster",
        "unbounded-page",
        "no-unavailable",
    ],
)
def test_contract_refusal_guards_reject_independent_mutations(mutation):
    value = deepcopy(document())
    operation = value["paths"][BASE + "devices"]["post"]
    schemas = value["components"]["schemas"]
    if mutation == "staff":
        operation["x-kodera-authz"]["roles"].append("staff_operator")
    elif mutation == "anonymous":
        operation["security"] = []
    elif mutation == "member-admin":
        value["paths"][BASE + "rooms"]["post"]["x-kodera-authz"]["roles"].append("org_member")
    elif mutation == "missing-replay":
        operation["parameters"] = [
            p for p in operation["parameters"] if not p.get("$ref", "").endswith("/IdempotencyKey")
        ]
    elif mutation == "open-request":
        schemas["ConfidentialDeviceRegistration"]["additionalProperties"] = True
    elif mutation == "optional-proof":
        schemas["ConfidentialDeviceRegistration"]["required"].remove("signature")
    elif mutation == "unbounded-epoch":
        schemas["ConfidentialApplication"]["properties"]["epoch"].pop("maximum")
    elif mutation == "optional-target-epoch":
        schemas["ConfidentialEpochTargetDevice"]["required"].remove("epoch")
    elif mutation == "unbounded-target-epoch":
        schemas["ConfidentialEpochTargetDevice"]["properties"]["epoch"].pop("maximum")
    elif mutation == "duplicate-roster":
        schemas["ConfidentialEpochCommit"]["properties"]["deviceIds"]["uniqueItems"] = False
    elif mutation == "unbounded-page":
        schemas["ConfidentialEnvelopePage"]["properties"]["envelopes"]["maxItems"] = 10000
    elif mutation == "no-unavailable":
        operation["responses"].pop("503")
    with pytest.raises((AssertionError, KeyError)):
        guard(value)


# The exact marker is the actual Commit row, never the later stream head.
COMMIT_UUID_PATTERN = (
    r"^(?!00000000-0000-0000-0000-000000000000)"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])"
)


def guard_commit_marker(value):
    response = value["paths"][ROOM + "commits"]["post"]["responses"]["201"]
    assert response["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ConfidentialEpochCommitted"
    }
    schema = value["components"]["schemas"]["ConfidentialEpochCommitted"]
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    assert set(schema["required"]) == {
        "epoch",
        "commitEnvelopeId",
        "commitSequence",
        "headSequence",
        "deviceIds",
    }
    assert schema["properties"]["commitEnvelopeId"] == {
        "type": "string",
        "format": "uuid",
        "minLength": 36,
        "maxLength": 36,
        "pattern": COMMIT_UUID_PATTERN,
    }
    assert schema["properties"]["commitSequence"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991,
    }


def committed():
    return {
        "epoch": 1,
        "commitEnvelopeId": IDENTIFIER,
        "commitSequence": 1,
        "headSequence": 1,
        "deviceIds": [IDENTIFIER],
    }


@pytest.mark.parametrize("field", ["commitEnvelopeId", "commitSequence"])
def test_exact_commit_marker_is_required(field):
    wire = committed()
    wire.pop(field)
    assert not validator("ConfidentialEpochCommitted").is_valid(wire)


@pytest.mark.parametrize(
    "identifier, accepted",
    [
        (IDENTIFIER, True),
        ("00000000-0000-0000-0000-000000000001", True),
        ("00000000-0000-0000-0000-000000000000", False),
        (IDENTIFIER.upper(), False),
        (IDENTIFIER + "\n", False),
        (IDENTIFIER + "x", False),
        (IDENTIFIER.replace("-", ""), False),
        (1, False),
        (True, False),
        (None, False),
    ],
)
def test_commit_envelope_id_has_a_canonical_non_nil_uuid_domain(identifier, accepted):
    wire = {**committed(), "commitEnvelopeId": identifier}
    assert validator("ConfidentialEpochCommitted").is_valid(wire) is accepted


@pytest.mark.parametrize(
    "sequence, accepted",
    [
        (1, True),
        (9007199254740991, True),
        (0, False),
        (-1, False),
        (9007199254740992, False),
        (1.5, False),
        ("1", False),
        (True, False),
        (None, False),
    ],
)
def test_commit_sequence_is_a_positive_safe_json_integer(sequence, accepted):
    wire = {**committed(), "commitSequence": sequence}
    assert validator("ConfidentialEpochCommitted").is_valid(wire) is accepted


@pytest.mark.parametrize(
    "mutation",
    [
        "wrong-reference",
        "open-response",
        "missing-id",
        "optional-id",
        "missing-sequence",
        "optional-sequence",
        "nil-id",
        "uppercase-id",
        "newline-id",
        "wrong-id-shape",
        "zero-sequence",
        "overflow-sequence",
        "fraction-sequence",
        "string-sequence",
        "boolean-sequence",
    ],
)
def test_commit_marker_guard_rejects_independent_schema_mutations(mutation):
    value = deepcopy(document())
    schema = value["components"]["schemas"]["ConfidentialEpochCommitted"]
    properties = schema["properties"]
    if mutation == "wrong-reference":
        value["paths"][ROOM + "commits"]["post"]["responses"]["201"]["content"]["application/json"][
            "schema"
        ]["$ref"] = "#/components/schemas/ConfidentialRoomCreated"
    elif mutation == "open-response":
        schema["additionalProperties"] = True
    elif mutation.startswith("missing-"):
        properties.pop("commitEnvelopeId" if mutation == "missing-id" else "commitSequence")
    elif mutation.startswith("optional-"):
        schema["required"].remove(
            "commitEnvelopeId" if mutation == "optional-id" else "commitSequence"
        )
    elif mutation == "nil-id":
        properties["commitEnvelopeId"]["pattern"] = COMMIT_UUID_PATTERN.replace(
            "(?!00000000-0000-0000-0000-000000000000)", ""
        )
    elif mutation == "uppercase-id":
        properties["commitEnvelopeId"]["pattern"] = COMMIT_UUID_PATTERN.replace(
            "[0-9a-f]", "[0-9a-fA-F]"
        )
    elif mutation == "newline-id":
        properties["commitEnvelopeId"]["pattern"] = COMMIT_UUID_PATTERN.replace(r"(?![\s\S])", "$")
        properties["commitEnvelopeId"].pop("maxLength")
    elif mutation == "wrong-id-shape":
        properties["commitEnvelopeId"]["pattern"] = r"^.{36}(?![\s\S])"
    elif mutation == "zero-sequence":
        properties["commitSequence"]["minimum"] = 0
    elif mutation == "overflow-sequence":
        properties["commitSequence"]["maximum"] = 2**53
    elif mutation == "fraction-sequence":
        properties["commitSequence"]["type"] = "number"
    elif mutation == "string-sequence":
        properties["commitSequence"]["type"] = "string"
    elif mutation == "boolean-sequence":
        properties["commitSequence"]["type"] = "boolean"
    with pytest.raises((AssertionError, KeyError)):
        guard(value)


def test_commit_base_example_and_later_welcome_keep_exact_marker():
    examples = document()["components"]["schemas"]["ConfidentialEpochCommitted"]["examples"]
    # One neutral example keeps base mocks deterministic without choosing by order.
    assert len(examples) == 1
    base = examples[0]
    assert base["headSequence"] == base["commitSequence"]
    assert validator("ConfidentialEpochCommitted").is_valid(base)
    # A later Welcome changes the stream head, never the exact Commit marker.
    with_welcome = {
        **base,
        "headSequence": base["commitSequence"] + 1,
        "deviceIds": [*base["deviceIds"], "01950000-0000-7000-8000-0000000000a3"],
    }
    assert with_welcome["headSequence"] > with_welcome["commitSequence"]
    assert with_welcome["commitEnvelopeId"] == base["commitEnvelopeId"]
    assert with_welcome["commitSequence"] == base["commitSequence"]
    assert validator("ConfidentialEpochCommitted").is_valid(with_welcome)
