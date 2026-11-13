"""Bounded offline check of the repository's declared pagination inventory."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

MAX_BYTES = 2 * 1024 * 1024
MAX_STEPS = 10000
MAX_DEPTH = 32
METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
PAGE = "#/components/schemas/CursorPage"
PARAMETERS = {
    "Cursor": ("cursor", {"type": "string", "maxLength": 512}),
    "Limit": ("limit", {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}),
}
ERROR_OPERATIONS = {"listLegalDocuments", "listEntitlements", "listTenantAvailability"}
ERRORS = {"400": "MalformedRequest", "422": "ValidationError"}
# Reviewed source inventory, independent of whatever page declarations survive.
INVENTORY = {
    ("get", "/organisations/{organisation_id}/workspace/reports"): "listAbuseReports",
    ("get", "/organisations/{organisation_id}/workspace/invite-links"): "listWorkspaceInviteLinks",
    ("get", "/notifications"): "listNotifications",
    ("get", "/organisations/{organisation_id}/workspace/documents"): "listWorkspaceDocuments",
    (
        "get",
        "/organisations/{organisation_id}/workspace/documents/{document_id}/backlinks",
    ): "listDocumentBacklinks",
    ("get", "/organisations/{organisation_id}/workspace/search"): "searchWorkspace",
    ("get", "/organisations/{organisation_id}/workspace/collections"): "listWorkspaceCollections",
    (
        "post",
        "/organisations/{organisation_id}/workspace/collections/{collection_id}/query",
    ): "queryWorkspaceCollection",
    ("get", "/organisations"): "listOrganisations",
    ("get", "/organisations/{organisation_id}/memberships"): "listMemberships",
    ("get", "/organisations/{organisation_id}/invitations"): "listInvitations",
    ("get", "/organisations/{organisation_id}/enrolment-tokens"): "listEnrolmentTokens",
    ("get", "/catalog/plans"): "listPlans",
    ("get", "/catalog/packs"): "listPacks",
    ("get", "/catalog/capacity-tiers"): "listCapacityTiers",
    ("get", "/catalog/prices"): "listPrices",
    ("get", "/organisations/{organisation_id}/orders"): "listOrders",
    ("get", "/organisations/{organisation_id}/subscriptions"): "listSubscriptions",
    ("get", "/organisations/{organisation_id}/invoices"): "listInvoices",
    ("get", "/organisations/{organisation_id}/credit-notes"): "listCreditNotes",
    ("get", "/organisations/{organisation_id}/tenants"): "listTenants",
    ("get", "/tenants/{tenant_id}/domains"): "listDomains",
    ("get", "/support/tickets"): "listSupportTickets",
    ("get", "/status/components"): "listStatusComponents",
    ("get", "/jobs"): "listJobs",
    ("get", "/instances/{instance_id}/logs"): "getInstanceLogs",
    ("get", "/audit-events"): "listAuditEvents",
    ("get", "/legal-documents"): "listLegalDocuments",
    ("get", "/organisations/{organisation_id}/entitlements"): "listEntitlements",
    ("get", "/organisations/{organisation_id}/member-imports"): "listMemberImports",
    ("get", "/tenants/{tenant_id}/availability"): "listTenantAvailability",
    ("get", "/status/incidents"): "listIncidents",
    ("get", "/support/tickets/{ticket_id}/messages"): "listTicketMessages",
    ("get", "/tenants/{tenant_id}/federation-providers"): "listFederationProviders",
    ("get", "/federation-providers/{federation_provider_id}/tests"): "listFederationTests",
}


class InputError(ValueError):
    """Refusal of an input whose meaning the checker cannot safely determine."""


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        self.flatten_mapping(node)
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise InputError("PAG-INPUT: mapping keys must be unique strings")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InputError("PAG-INPUT: expected an object")
    return value


def load_contract(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise InputError("PAG-INPUT: document exceeds input limit")
        text = raw.decode("utf-8")
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(text)):
            raise InputError("PAG-INPUT: YAML aliases are unsupported")
        result = mapping(yaml.load(text, Loader=UniqueLoader))  # noqa: S506 - SafeLoader subclass
        json.dumps(result, allow_nan=False)
        mapping(result.get("paths"))
        if result.get("openapi") != "3.1.0":
            raise InputError("PAG-INPUT: expected the supported OpenAPI version")
        return result
    except InputError:
        raise
    except (OSError, UnicodeError, yaml.YAMLError, TypeError, ValueError, RecursionError) as error:
        raise InputError("PAG-INPUT: unreadable or ambiguous contract") from error


class Reader:
    def __init__(self, document: dict[str, Any]) -> None:
        self.document = document
        self.steps = 0

    def step(self, depth: int) -> None:
        self.steps += 1
        if self.steps > MAX_STEPS or depth > MAX_DEPTH:
            raise InputError("PAG-INPUT: reference traversal exceeds budget")

    def resolve(
        self, value: Any, kind: str, trail: tuple[str, ...] = ()
    ) -> tuple[dict[str, Any], tuple[str, ...]]:
        self.step(len(trail))
        node = mapping(value)
        if "$ref" not in node:
            return node, trail
        allowed = (
            {"$ref", "description", "title"}
            if kind == "schemas"
            else {"$ref", "description", "summary"}
        )
        if set(node) - allowed:
            raise InputError("PAG-INPUT: unsupported reference siblings")
        ref = node["$ref"]
        if not isinstance(ref, str) or not ref.startswith(f"#/components/{kind}/"):
            raise InputError("PAG-INPUT: reference must be local and match its context")
        if ref in trail or re.search(r"~(?![01])", ref):
            raise InputError("PAG-INPUT: cyclic or malformed reference")
        target: Any = self.document
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, dict) or part not in target:
                raise InputError("PAG-INPUT: unresolved reference")
            target = target[part]
        return self.resolve(target, kind, (*trail, ref))

    def page(self, value: Any, trail: tuple[str, ...] = (), depth: int = 0) -> bool:
        self.step(depth)
        node, refs = self.resolve(value, "schemas", trail)
        if PAGE in refs:
            return True
        for union in ("anyOf", "oneOf"):
            if union in node:
                if not isinstance(node[union], list):
                    raise InputError("PAG-INPUT: unsupported schema union")
                if any(self.page(branch, refs, depth + 1) for branch in node[union]):
                    raise InputError("PAG-INPUT: page unions require an explicit contract decision")
        if "allOf" not in node:
            # Unions, nested properties, examples and extensions do not prove
            # that every successful response is the required outer envelope.
            return False
        if not isinstance(node["allOf"], list):
            raise InputError("PAG-INPUT: unsupported schema composition")
        branches = [self.page(branch, refs, depth + 1) for branch in node["allOf"]]
        if not any(branches):
            return False
        if set(node) - {"allOf", "description", "title"}:
            raise InputError("PAG-INPUT: unsupported page composition")
        for branch, is_page in zip(node["allOf"], branches, strict=True):
            if is_page:
                continue
            overlay, _ = self.resolve(branch, "schemas", refs)
            if set(overlay) != {"type", "properties"} or overlay.get("type") != "object":
                raise InputError("PAG-INPUT: unsupported page overlay")
            properties = mapping(overlay["properties"])
            data = mapping(properties.get("data"))
            if (
                set(properties) != {"data"}
                or set(data) != {"type", "items"}
                or data["type"] != "array"
            ):
                raise InputError("PAG-INPUT: conflicting page overlay")
            # Item identity is the entity contract's responsibility, but its
            # declaration must resolve locally instead of loading caller URLs.
            self.resolve(data["items"], "schemas")
        return True

    def response_page(self, value: Any) -> bool:
        node, _ = self.resolve(value, "responses")
        content = mapping(node.get("content", {}))
        media = content.get("application/json")
        return media is not None and self.page(mapping(media).get("schema"))

    def parameters(self, values: Any) -> dict[tuple[str, str], dict[str, Any]]:
        if not isinstance(values, list):
            raise InputError("PAG-INPUT: parameters must be a list")
        result: dict[tuple[str, str], dict[str, Any]] = {}
        for value in values:
            node, _ = self.resolve(value, "parameters")
            location, name = node.get("in"), node.get("name")
            if not isinstance(location, str) or not isinstance(name, str):
                raise InputError("PAG-INPUT: ambiguous parameter declaration")
            key = (location, name)
            if key in result:
                raise InputError("PAG-INPUT: ambiguous parameter declaration")
            result[key] = node
        return result


def parameter_matches(
    reader: Reader, parameter: dict[str, Any], name: str, schema: dict[str, Any]
) -> bool:
    allowed = {
        "name",
        "in",
        "required",
        "description",
        "schema",
        "example",
        "examples",
        "deprecated",
    }
    if set(parameter) - allowed or parameter.get("required", False) is not False:
        return False
    if parameter.get("name") != name or parameter.get("in") != "query":
        return False
    actual, _ = reader.resolve(parameter.get("schema"), "schemas")
    actual = dict(actual)
    for annotation in ("description", "title"):
        if annotation in actual and not isinstance(actual[annotation], str):
            return False
        actual.pop(annotation, None)
    for key, expected in schema.items():
        value = actual.get(key)
        if (
            isinstance(expected, int)
            and not isinstance(value, bool)
            and isinstance(value, (int, float))
            and value == expected
        ):
            actual[key] = expected
    # JSON equality keeps booleans distinct from integer limits.
    return json.dumps(actual, sort_keys=True) == json.dumps(schema, sort_keys=True)


def validate(document: dict[str, Any]) -> list[str]:
    reader = Reader(document)
    errors = []
    components = mapping(document.get("components"))
    definitions = mapping(components.get("parameters"))
    for component, (expected_name, schema) in PARAMETERS.items():
        definition = definitions.get(component)
        if definition is None or not parameter_matches(
            reader, mapping(definition), expected_name, schema
        ):
            errors.append(f"PAG-PARAMETER: shared {component} definition differs from the contract")
    page, _ = reader.resolve({"$ref": PAGE}, "schemas")
    properties = mapping(page.get("properties", {}))
    required = page.get("required", [])
    # Preserve the existing wire definition, including its still-optional
    # next_cursor. Requiring continuation is a separate consumer-reviewed fix.
    canonical_page = (
        page.get("type") == "object"
        and not set(page) - {"type", "title", "description", "examples", "required", "properties"}
        and isinstance(required, list)
        and all(isinstance(key, str) for key in required)
        and len(required) == len(set(required))
        and {"data", "has_more"}.issubset(required)
        and set(required).issubset({"data", "has_more", "next_cursor"})
        and set(properties) == {"data", "has_more", "next_cursor"}
        and all(
            not set(mapping(properties.get(key, {}))) - allowed
            for key, allowed in (
                ("data", {"type", "description", "items"}),
                ("has_more", {"type", "description"}),
                ("next_cursor", {"type", "description", "maxLength"}),
            )
        )
        and mapping(properties.get("data", {})).get("items") == {}
        and mapping(properties.get("data", {})).get("type") == "array"
        and mapping(properties.get("has_more", {})).get("type") == "boolean"
        and mapping(properties.get("next_cursor", {})).get("type")
        in (["string", "null"], ["null", "string"])
        and mapping(properties.get("next_cursor", {})).get("maxLength") == 512
    )
    if not canonical_page:
        errors.append("PAG-RESPONSE: shared CursorPage definition is incomplete")
    seen_ids: set[str] = set()
    found: set[tuple[str, str]] = set()
    for path, path_value in mapping(document["paths"]).items():
        path_item, _ = reader.resolve(path_value, "pathItems")
        for method, operation_value in path_item.items():
            if method not in METHODS:
                continue
            operation = mapping(operation_value)
            identity = (method, path)
            name = operation.get("operationId")
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name)
                or name in seen_ids
            ):
                errors.append("PAG-INVENTORY: missing or duplicate operation identity")
                continue
            seen_ids.add(name)
            responses = mapping(operation.get("responses"))
            success_pages = [
                reader.response_page(value)
                for code, value in responses.items()
                if re.fullmatch(r"2[0-9]{2}|2XX", code)
            ]
            is_page = bool(success_pages) and all(success_pages)
            expected = INVENTORY.get(identity)
            if expected is not None:
                found.add(identity)
                if name != expected or not is_page:
                    errors.append(f"PAG-INVENTORY: {expected} requires its declared page response")
            elif any(success_pages):
                errors.append(f"PAG-INVENTORY: {name} is a page absent from the inventory")
            if expected is None and not any(success_pages):
                continue
            effective = reader.parameters(path_item.get("parameters", []))
            # Operation-level declarations override path-level parameters.
            effective.update(reader.parameters(operation.get("parameters", [])))
            for component, (parameter_name, schema) in PARAMETERS.items():
                parameter = effective.get(("query", parameter_name))
                if parameter is None or not parameter_matches(
                    reader, parameter, parameter_name, schema
                ):
                    errors.append(f"PAG-PARAMETER: {name} requires effective {component}")
            if name in ERROR_OPERATIONS:
                for code, component in ERRORS.items():
                    value = responses.get(code)
                    if value is None:
                        errors.append(f"PAG-RESPONSE: {name} requires {code} {component}")
                        continue
                    response, refs = reader.resolve(value, "responses")
                    problem = mapping(response.get("content", {})).get("application/problem+json")
                    proper_body = False
                    if problem is not None:
                        _, schema_refs = reader.resolve(mapping(problem).get("schema"), "schemas")
                        proper_body = "#/components/schemas/Problem" in schema_refs
                    if f"#/components/responses/{component}" not in refs or not proper_body:
                        errors.append(f"PAG-RESPONSE: {name} requires {code} {component}")
    for identity in INVENTORY.keys() - found:
        errors.append(f"PAG-INVENTORY: missing {INVENTORY[identity]}")
    return errors


def main() -> int:
    args = sys.argv[1:]
    self_test = bool(args and args[0] == "--self-test")
    if self_test:
        args = args[1:]
    if len(args) > 1:
        print("usage: check-cursor-pagination.sh [--self-test] [contract]", file=sys.stderr)
        return 2
    path = Path(args[0]) if args else Path("contracts/core-api.openapi.yaml")
    try:
        errors = validate(load_contract(path))
    except (InputError, RecursionError):
        print("PAG-INPUT: unreadable, ambiguous or unsupported contract", file=sys.stderr)
        return 2
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    if self_test:
        bash = shutil.which("bash")
        if bash is None:
            print("PAG-INPUT: bash is required for acceptance", file=sys.stderr)
            return 2
        return subprocess.run(  # noqa: S603 - fixed adjacent helper, separate path argument
            [
                bash,
                str(Path(__file__).with_name("check-cursor-pagination.acceptance.sh")),
                str(path),
            ],
            env=dict(os.environ, PYTHON=sys.executable),
            check=False,
        ).returncode
    print(
        f"{len(INVENTORY)} operations validated; static pagination inventory, runtime and wire gaps unchecked"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
