"""Offline Wave 4 wire acceptance and named refusal mutations; no runtime claims."""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
from typing import Any

import jsonschema_rs
import yaml

COLLECTION = "/organisations/{organisation_id}/workspace/collections"
MEMBERS = ["org_owner", "org_admin", "org_billing", "org_member"]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate(document: dict[str, Any]) -> None:
    require(document["info"]["version"] in {"0.44.0", "0.44.1", "0.44.2"}, "wave4 version")
    schemas = document["components"]["schemas"]
    operations = {
        op["operationId"]: (method, op)
        for item in document["paths"].values()
        for method, op in item.items()
        if isinstance(op, dict) and "operationId" in op
    }
    expected = {
        "listWorkspaceCollections",
        "createWorkspaceCollection",
        "getWorkspaceCollection",
        "updateWorkspaceCollection",
        "deleteWorkspaceCollection",
        "queryWorkspaceCollection",
        "putWorkspaceCollectionRow",
        "getWorkspaceCollectionRow",
        "deleteWorkspaceCollectionRow",
        "getWorkspaceQuotaUsage",
        "getWorkspaceQuotaLimits",
        "getInvoiceDownloadLink",
        "getCreditNoteDownloadLink",
        "getBillingVatStatus",
        "validateBillingVat",
    }
    for scope in ("Account", "Workspace"):
        expected |= {
            f"request{scope}Export",
            f"get{scope}Export",
            f"get{scope}ExportDownloadLink",
            f"request{scope}Deletion",
            f"get{scope}Deletion",
        }
    require(expected <= operations.keys(), "wave4 operation inventory")
    for name in expected:
        method, operation = operations[name]
        require(bool(operation.get("x-kodera-scope")), "wave4 scope")
        roles = operation.get("x-kodera-authz", {}).get("roles", [])
        require(bool(roles), "wave4 authorization")
        if name.startswith(("requestWorkspace", "getWorkspaceExport", "getWorkspaceDeletion")):
            require(roles == ["org_owner"], "workspace privacy owner boundary")
        if name.startswith(("requestAccount", "getAccount")):
            require(roles == MEMBERS, "account privacy subject boundary")
        require({"401", "403", "404"} <= operation["responses"].keys(), "wave4 refusals")
        if method == "post":
            require(
                {"$ref": "#/components/parameters/IdempotencyKey"} in operation["parameters"],
                "wave4 idempotency",
            )
        if method == "patch":
            require(
                {"$ref": "#/components/parameters/IfMatch"} in operation["parameters"],
                "wave4 precondition",
            )
    row_put = document["paths"][COLLECTION + "/{collection_id}/rows/{document_id}"]["put"]
    headers = {p.get("name"): p for p in row_put["parameters"]}
    require(
        row_put.get("x-kodera-one-of-preconditions") is True
        and "201" in row_put["responses"]
        and set(headers) == {"If-Match", "If-None-Match"}
        and all(p.get("required") is False for p in headers.values())
        and headers["If-None-Match"]["schema"] == {"type": "string", "const": "*"},
        "conditional row preconditions",
    )
    for path, item in document["paths"].items():
        if "/privacy/" in path:
            for op in item.values():
                if isinstance(op, dict) and "responses" in op:
                    require("503" in op["responses"], "privacy configuration refusal")
    for name in ("CollectionProperty", "CollectionValue"):
        branches = schemas[name]["oneOf"]
        kinds = [
            schemas[b["$ref"].rsplit("/", 1)[1]]["properties"]["type"]["const"] for b in branches
        ]
        require(
            set(kinds)
            == {"text", "number", "checkbox", "date", "url", "select", "multi_select", "person"}
            and len(kinds) == 8,
            "typed collection union",
        )
        require(
            all(
                schemas[b["$ref"].rsplit("/", 1)[1]].get("additionalProperties") is False
                for b in branches
            ),
            "closed collection values",
        )
    views = schemas["CollectionView"]["oneOf"]
    require(
        {schemas[b["$ref"].rsplit("/", 1)[1]]["properties"]["type"]["const"] for b in views}
        == {"table", "board", "list"},
        "collection views",
    )
    require(
        schemas["WorkspaceCollectionPatch"].get("minProperties") == 1, "nonempty collection patch"
    )
    require(
        schemas["CollectionQuery"]["properties"]["filters"].get("maxItems") == 50,
        "bounded collection query",
    )
    for name, code in (("Invoice", "380"), ("CreditNote", "381")):
        require(
            schemas[name]["properties"]["facturx_type_code"] == {"type": "string", "const": code},
            "Factur-X document code",
        )
    for name in ("getInvoiceDownloadLink", "getCreditNoteDownloadLink"):
        formats = [p for p in operations[name][1]["parameters"] if p.get("name") == "format"]
        require(
            len(formats) == 1
            and formats[0]["schema"]
            == {"type": "string", "enum": ["pdf", "xml"], "default": "pdf"},
            "billing download format",
        )
    require(
        schemas["BillingVatStatus"]["properties"]["status"]["enum"]
        == ["not_checked", "valid", "invalid", "unavailable"],
        "VIES unavailable outcome",
    )
    for counter in ("seats", "mediaBytes", "pages"):
        require(
            schemas["WorkspaceQuotaLimits"]["properties"][counter]
            == {"type": ["integer", "null"], "minimum": 0},
            "explicit quota limits",
        )
    for scope in ("Account", "Workspace"):
        for kind in ("Export", "Deletion"):
            props = schemas[f"Privacy{scope}{kind}"]["properties"]
            require(
                props["scope"] == {"type": "string", "const": scope.lower()}
                and props["kind"] == {"type": "string", "const": kind.lower()},
                "privacy scope binding",
            )
            statuses = props["status"]["enum"]
            require(
                ("ready" in statuses) == (kind == "Export")
                and ("retention_pending" in statuses) == (kind == "Deletion"),
                "privacy lifecycle separation",
            )
    for name, schema in schemas.items():
        if name.startswith(
            (
                "Collection",
                "WorkspaceCollection",
                "WorkspaceQuota",
                "BillingArtifact",
                "BillingVat",
                "Privacy",
            )
        ):
            validator = jsonschema_rs.validator_for(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$ref": f"#/components/schemas/{name}",
                    "components": document["components"],
                }
            )
            for example in schema.get("examples", []):
                require(validator.is_valid(example), f"invalid wave4 example: {name}")
    fixtures = [
        ("CollectionValue", {"type": "number", "value": "twelve"}),
        ("CollectionValue", {"type": "checkbox", "value": 1}),
        ("CollectionValue", {"type": "text", "value": "ok", "sql": "unexpected"}),
        ("CollectionView", {"id": "v", "name": "view", "type": "board"}),
        (
            "PrivacyWorkspaceDeletion",
            {**schemas["PrivacyWorkspaceDeletion"]["examples"][0], "scope": "account"},
        ),
        (
            "PrivacyAccountExport",
            {**schemas["PrivacyAccountExport"]["examples"][0], "status": "completed"},
        ),
    ]
    for name, value in fixtures:
        validator = jsonschema_rs.validator_for(
            {"$ref": f"#/components/schemas/{name}", "components": document["components"]}
        )
        require(not validator.is_valid(value), f"refused wire value: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    document = yaml.safe_load(Path(__file__).with_name("core-api.openapi.yaml").read_text())
    validate(document)
    print("PASS: Wave 4 operations, typed schemas, examples and six invalid wire values")
    if args.selftest:
        mutations = [
            ("wave4 version", lambda d: d["info"].update(version="0.43.0")),
            ("wave4 operation inventory", lambda d: d["paths"].pop(COLLECTION)),
            (
                "workspace privacy owner boundary",
                lambda d: d["paths"]["/organisations/{organisation_id}/workspace/privacy/exports"][
                    "post"
                ]["x-kodera-authz"]["roles"].append("org_member"),
            ),
            ("wave4 idempotency", lambda d: d["paths"][COLLECTION]["post"].update(parameters=[])),
            (
                "typed collection union",
                lambda d: d["components"]["schemas"]["CollectionValue"]["oneOf"].pop(),
            ),
            (
                "closed collection values",
                lambda d: d["components"]["schemas"]["CollectionTextValue"].update(
                    additionalProperties=True
                ),
            ),
            (
                "collection views",
                lambda d: d["components"]["schemas"]["CollectionView"]["oneOf"].pop(),
            ),
            (
                "bounded collection query",
                lambda d: d["components"]["schemas"]["CollectionQuery"]["properties"][
                    "filters"
                ].pop("maxItems"),
            ),
            (
                "Factur-X document code",
                lambda d: d["components"]["schemas"]["CreditNote"]["properties"][
                    "facturx_type_code"
                ].update(const="380"),
            ),
            (
                "VIES unavailable outcome",
                lambda d: d["components"]["schemas"]["BillingVatStatus"]["properties"]["status"][
                    "enum"
                ].remove("unavailable"),
            ),
            (
                "explicit quota limits",
                lambda d: d["components"]["schemas"]["WorkspaceQuotaLimits"]["properties"][
                    "seats"
                ].pop("minimum"),
            ),
            (
                "privacy scope binding",
                lambda d: d["components"]["schemas"]["PrivacyWorkspaceDeletion"]["properties"][
                    "scope"
                ].update(const="account"),
            ),
            (
                "privacy lifecycle separation",
                lambda d: d["components"]["schemas"]["PrivacyAccountDeletion"]["properties"][
                    "status"
                ]["enum"].append("ready"),
            ),
        ]
        mutations.extend(
            [
                (
                    "conditional row preconditions",
                    lambda d: d["paths"][COLLECTION + "/{collection_id}/rows/{document_id}"][
                        "put"
                    ].pop("x-kodera-one-of-preconditions"),
                ),
                (
                    "privacy configuration refusal",
                    lambda d: d["paths"]["/me/privacy/exports"]["post"]["responses"].pop("503"),
                ),
            ]
        )
        for expected, mutate in mutations:
            changed = copy.deepcopy(document)
            mutate(changed)
            try:
                validate(changed)
            except ValueError as error:
                require(str(error) == expected, f"wrong refusal: expected {expected}, got {error}")
                print(f"PASS refusal: {expected}")
            else:
                raise SystemExit(f"mutation survived: {expected}")


if __name__ == "__main__":
    main()
