"""Canonical proximity operations, strict lease shape and refusal controls."""

from copy import deepcopy
from pathlib import Path
from typing import Any

import jsonschema_rs
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "packages/api-contract/core-api.openapi.yaml"
NAMES = {
    "bootstrap": ("post", "bootstrapProximity", "ProximityEpochLease"),
    "checkin": ("post", "checkInProximity", "ProximityRadioCheckIn"),
    "resolve": ("post", "resolveProximityTokens", "ProximityRadioResolved"),
    "nearby": ("get", "getNearbyProximity", "ProximityRadioNearby"),
    "checkout": ("post", "checkOutProximity", "ProximityRadioCheckout"),
}


def assert_contract(document: dict[str, Any]) -> None:
    assert document["info"]["version"] == "0.53.0"
    for name, (method, operation, schema) in NAMES.items():
        op = document["paths"][f"/proximity/{name}"][method]
        assert op["operationId"] == operation
        assert op["security"] == [{"keycloakTenant": []}]
        assert op["x-kodera-authz"] == {
            "roles": ["org_owner", "org_admin", "org_billing", "org_member"]
        }
        assert op["x-kodera-scope"] == "proximity:" + (
            "act" if name in {"checkin", "checkout"} else "read"
        )
        assert not any(
            p.get("$ref", "").endswith("/IdempotencyKey") for p in op.get("parameters", [])
        )
        assert {"401", "403", "404", "422", "503"} <= op["responses"].keys()
        success = op["responses"]["201" if name == "checkin" else "200"]
        assert success["content"]["application/json"]["schema"] == {
            "$ref": f"#/components/schemas/{schema}"
        }
    lease = document["components"]["schemas"]["ProximityEpochLease"]
    fields = {
        "workspace_id",
        "event_scope",
        "epoch",
        "epoch_mac_key",
        "epoch_expires_at",
        "epoch_rotation_seconds",
    }
    assert set(lease["required"]) == set(lease["properties"]) == fields
    assert lease["additionalProperties"] is False
    assert lease["properties"]["epoch_mac_key"]["pattern"] == "^[0-9a-f]{64}$"
    assert lease["properties"]["epoch_rotation_seconds"]["const"] == 900
    assert "workspace_beacon_key" not in lease["properties"]
    assert document["components"]["schemas"]["ProximityRadioProblem"]["properties"]["type"] == {
        "$ref": "#/components/schemas/ProblemType"
    }


def test_canonical_paths_and_each_response_example_validate() -> None:
    text = CONTRACT.read_text()
    assert not any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(text))
    document = yaml.safe_load(text)
    assert_contract(document)
    for _, _, name in NAMES.values():
        validator = jsonschema_rs.validator_for(
            {"$ref": f"#/components/schemas/{name}", "components": document["components"]}
        )
        for example in document["components"]["schemas"][name]["examples"]:
            assert validator.is_valid(example), name
    for mirror in ("apps/server/contracts", "apps/web/contracts"):
        assert (ROOT / mirror / CONTRACT.name).read_bytes() == CONTRACT.read_bytes()


@pytest.mark.parametrize(
    "mutation",
    [
        "staff",
        "anonymous",
        "missing-lease-field",
        "master-export",
        "uppercase",
        "skew",
        "open-shape",
        "no-unavailable",
        "unregistered-problem",
    ],
)
def test_each_proximity_contract_guard_refuses_its_mutation(mutation: str) -> None:
    document = deepcopy(yaml.safe_load(CONTRACT.read_text()))
    op = document["paths"]["/proximity/bootstrap"]["post"]
    lease = document["components"]["schemas"]["ProximityEpochLease"]
    if mutation == "staff":
        op["x-kodera-authz"]["roles"].append("staff_operator")
    elif mutation == "anonymous":
        op["security"] = []
    elif mutation == "missing-lease-field":
        lease["required"].remove("epoch_expires_at")
    elif mutation == "master-export":
        lease["properties"]["workspace_beacon_key"] = {"type": "string"}
    elif mutation == "uppercase":
        lease["properties"]["epoch_mac_key"]["pattern"] = "^[0-9a-fA-F]{64}$"
    elif mutation == "skew":
        lease["properties"]["epoch_rotation_seconds"]["const"] = 960
    elif mutation == "open-shape":
        lease["additionalProperties"] = True
    elif mutation == "unregistered-problem":
        document["components"]["schemas"]["ProximityRadioProblem"]["properties"]["type"] = {
            "type": "string"
        }
    else:
        op["responses"].pop("503")
    with pytest.raises(AssertionError):
        assert_contract(document)
