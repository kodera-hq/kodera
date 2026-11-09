#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_command="${PYTHON:-python3}"
"$python_command" - "$script_dir" "$@" <<'PY'
import copy
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml

source = Path(sys.argv[1])
args = sys.argv[2:]
selected = None
if "--probe" in args:
    if len(args) != 3 or args[1] != "--probe":
        raise SystemExit("usage: check-cursor-pagination.acceptance.sh [contract [--probe name]]")
    selected = args[2]
    args = args[:1]
if len(args) > 1:
    raise SystemExit("usage: check-cursor-pagination.acceptance.sh [contract [--probe name]]")
contract = Path(args[0]) if args else source / "core-api.openapi.yaml"
bash = shutil.which("bash")
if bash is None:
    raise SystemExit("FAIL: bash is required")
baseline = yaml.safe_load(contract.read_text())
page_ref = "#/components/schemas/CursorPage"
cursor_ref = "#/components/parameters/Cursor"
limit_ref = "#/components/parameters/Limit"
failures = []
passed = 0


def operation(document, name):
    for item in document["paths"].values():
        for candidate in item.values():
            if isinstance(candidate, dict) and candidate.get("operationId") == name:
                return candidate
    raise RuntimeError("Synthetic probe operation missing")


def erase_pages(node):
    if isinstance(node, dict):
        if node.get("$ref") == page_ref:
            node.clear()
            node["type"] = "object"
        else:
            for value in node.values():
                erase_pages(value)
    elif isinstance(node, list):
        for value in node:
            erase_pages(value)


def remove_parameters(document):
    item = operation(document, "listLegalDocuments")
    item["parameters"] = [
        p for p in item["parameters"] if p.get("$ref") not in (cursor_ref, limit_ref)
    ]


def alias_response(document):
    item = operation(document, "listLegalDocuments")
    document["components"]["responses"]["SyntheticLegalPage"] = item["responses"]["200"]
    item["responses"]["200"] = {"$ref": "#/components/responses/SyntheticLegalPage"}


def shrink_population(document):
    keep = {"listLegalDocuments", "listEntitlements", "listTenantAvailability", "listOrganisations"}
    for item in document["paths"].values():
        for candidate in item.values():
            if isinstance(candidate, dict) and candidate.get("operationId") not in keep:
                erase_pages(candidate.get("responses"))


def counterfeit_error(document):
    operation(document, "listLegalDocuments")["responses"]["422"] = {
        "description": "Synthetic empty response",
        "x-audit-counterfeit": {"$ref": "#/components/responses/ValidationError"},
    }


def inline_parameters(document):
    item = operation(document, "listLegalDocuments")
    item["parameters"] = [
        copy.deepcopy(document["components"]["parameters"][p["$ref"].rsplit("/", 1)[1]])
        if p.get("$ref") in (cursor_ref, limit_ref)
        else p
        for p in item["parameters"]
    ]


probes: list[tuple[str, Callable[[Any], Any], int, str]] = [
    ("actual inventory", lambda d: None, 0, "27 operations validated"),
    ("equivalent response alias", alias_response, 0, "27 operations validated"),
    ("inline parameter equivalence", inline_parameters, 0, "27 operations validated"),
    ("population removal", shrink_population, 1, "PAG-INVENTORY"),
    (
        "alias cannot hide missing parameters",
        lambda d: (alias_response(d), remove_parameters(d)),
        1,
        "PAG-PARAMETER",
    ),
    ("extension cannot declare error", counterfeit_error, 1, "PAG-RESPONSE"),
    (
        "boolean limit",
        lambda d: d["components"]["parameters"]["Limit"].update(schema={"type": "boolean"}),
        1,
        "PAG-PARAMETER",
    ),
]
# Preserve the original 17 refusal scenarios, using named categories.
for operation_id in ("listLegalDocuments", "listEntitlements", "listTenantAvailability"):
    for ref in (cursor_ref, limit_ref):

        def missing_parameter(d, name=operation_id, reference=ref):
            op = operation(d, name)
            op["parameters"] = [item for item in op["parameters"] if item.get("$ref") != reference]
            op["description"] = "Counterfeit reference: " + reference

        probes.append(
            (
                "original missing " + operation_id + " " + ref.rsplit("/", 1)[1],
                missing_parameter,
                1,
                "PAG-PARAMETER",
            )
        )
    for status in ("400", "422"):

        def missing_response(d, name=operation_id, code=status):
            operation(d, name)["responses"].pop(code)

        probes.append(
            (
                "original missing response " + operation_id + " " + status,
                missing_response,
                1,
                "PAG-RESPONSE",
            )
        )
probes.append(
    (
        "original missing operation ID",
        lambda d: operation(d, "listOrganisations").pop("operationId"),
        1,
        "PAG-INVENTORY",
    )
)
for component in ("Cursor", "Limit"):
    for field in ("name", "in"):

        def wrong_component(d, c=component, f=field):
            d["components"]["parameters"][c].update({f: "synthetic"})

        probes.append(
            (
                "original component " + component + " " + field,
                wrong_component,
                1,
                "PAG-PARAMETER",
            )
        )


def path_parameters(d, override=False):
    path = d["paths"]["/legal-documents"]
    op = operation(d, "listLegalDocuments")
    path["parameters"] = [{"$ref": cursor_ref}, {"$ref": limit_ref}]
    remove_parameters(d)
    if override:
        op["parameters"].append({"name": "limit", "in": "query", "schema": {"type": "boolean"}})


def additional_page(d, union=False):
    extra = copy.deepcopy(operation(d, "listLegalDocuments"))
    extra["operationId"] = "syntheticPage"
    if union:
        extra["responses"]["200"]["content"]["application/json"]["schema"] = {
            "anyOf": [{"$ref": page_ref}, {"$ref": page_ref}]
        }
    d["paths"]["/synthetic-page"] = {"get": extra}


def nested_page(d):
    operation(d, "listLegalDocuments")["responses"]["200"]["content"]["application/json"][
        "schema"
    ] = {"type": "object", "properties": {"unrelated": {"$ref": page_ref}}}


def response_target(d, target):
    operation(d, "listLegalDocuments")["responses"]["200"] = {"$ref": target}


def cycle(d):
    alias_response(d)
    d["components"]["responses"]["SyntheticLegalPage"] = {
        "$ref": "#/components/responses/SyntheticLegalPage"
    }


def escaped_response(d):
    response = operation(d, "listLegalDocuments")["responses"]["200"]
    d["components"]["responses"]["Synthetic~/Page"] = response
    response_target(d, "#/components/responses/Synthetic~0~1Page")


def deep_response(d):
    response = operation(d, "listLegalDocuments")["responses"]["200"]
    for index in range(35):
        d["components"]["responses"][f"Synthetic{index}"] = response
        response = {"$ref": f"#/components/responses/Synthetic{index}"}
    operation(d, "listLegalDocuments")["responses"]["200"] = response


probes += [
    ("escaped response pointer", escaped_response, 0, "27 operations validated"),
    ("reference depth budget", deep_response, 2, "PAG-INPUT"),
    (
        "contradictory page constraint",
        lambda d: d["components"]["schemas"]["CursorPage"].update({"not": {}}),
        1,
        "PAG-RESPONSE",
    ),
    ("path parameter equivalence", path_parameters, 0, "27 operations validated"),
    ("effective override", lambda d: path_parameters(d, True), 1, "PAG-PARAMETER"),
    (
        "duplicate operation ID",
        lambda d: operation(d, "listLegalDocuments").update(operationId="listOrganisations"),
        1,
        "PAG-INVENTORY",
    ),
    (
        "missing inventory operation",
        lambda d: d["paths"].pop("/legal-documents"),
        1,
        "PAG-INVENTORY",
    ),
    ("new unregistered page", additional_page, 1, "PAG-INVENTORY"),
    ("unsupported page union cannot hide", lambda d: additional_page(d, True), 2, "PAG-INPUT"),
    ("nested unrelated page", nested_page, 1, "PAG-INVENTORY"),
    (
        "missing response target",
        lambda d: response_target(d, "#/components/responses/Missing"),
        2,
        "PAG-INPUT",
    ),
    (
        "external response target",
        lambda d: response_target(d, "https://example.test/forbidden"),
        2,
        "PAG-INPUT",
    ),
    (
        "file response target",
        lambda d: response_target(d, "file:///synthetic-private"),
        2,
        "PAG-INPUT",
    ),
    (
        "malformed pointer",
        lambda d: response_target(d, "#/components/responses/Synthetic~2"),
        2,
        "PAG-INPUT",
    ),
    ("cyclic response target", cycle, 2, "PAG-INPUT"),
    (
        "unsupported reference sibling",
        lambda d: operation(d, "listLegalDocuments")["responses"]["422"].update(content={}),
        2,
        "PAG-INPUT",
    ),
    (
        "limit boolean maximum",
        lambda d: d["components"]["parameters"]["Limit"]["schema"].update(maximum=True),
        1,
        "PAG-PARAMETER",
    ),
    (
        "limit wrong default",
        lambda d: d["components"]["parameters"]["Limit"]["schema"].update(default=201),
        1,
        "PAG-PARAMETER",
    ),
    (
        "cursor wrong length",
        lambda d: d["components"]["parameters"]["Cursor"]["schema"].update(maxLength=1024),
        1,
        "PAG-PARAMETER",
    ),
    (
        "cursor required",
        lambda d: d["components"]["parameters"]["Cursor"].update(required=True),
        1,
        "PAG-PARAMETER",
    ),
    (
        "unsupported parameter constraint",
        lambda d: d["components"]["parameters"]["Limit"]["schema"].update(not_={}),
        1,
        "PAG-PARAMETER",
    ),
    (
        "duplicate effective parameter",
        lambda d: operation(d, "listLegalDocuments")["parameters"].append({"$ref": limit_ref}),
        2,
        "PAG-INPUT",
    ),
    (
        "page definition removal",
        lambda d: d["components"]["schemas"].update(CursorPage={}),
        1,
        "PAG-RESPONSE",
    ),
    ("duplicate YAML key", lambda d: "openapi: 3.1.0\nopenapi: 3.1.0\npaths: {}", 2, "PAG-INPUT"),
    ("YAML alias", lambda d: "openapi: 3.1.0\npaths: &x {}\nx-copy: *x", 2, "PAG-INPUT"),
    ("oversized YAML", lambda d: "#" + "x" * (2 * 1024 * 1024), 2, "PAG-INPUT"),
    ("malformed YAML redaction", lambda d: "[SYNTHETIC_PRIVATE_MARKER", 2, "PAG-INPUT"),
]

def parameter_schema(document, component, inline=False):
    if not inline:
        return document["components"]["parameters"][component]["schema"]
    inline_parameters(document)
    return next(
        parameter["schema"]
        for parameter in operation(document, "listLegalDocuments")["parameters"]
        if parameter.get("name") == component.lower()
    )


# Equivalent declarations must pass without admitting new constraints or types.
for annotation in ("description", "title"):
    for component, inline in (("Cursor", False), ("Limit", True)):
        probes.append(
            (
                f"equivalent {component} schema {annotation}",
                lambda d, c=component, a=annotation, i=inline: parameter_schema(d, c, i).update(
                    {a: "Synthetic pagination annotation"}
                ),
                0,
                "27 operations validated",
            )
        )

probes += [
    (
        "equivalent numeric cursor length",
        lambda d: parameter_schema(d, "Cursor").update(maxLength=512.0),
        0,
        "27 operations validated",
    ),
    (
        "equivalent numeric limit bounds",
        lambda d: parameter_schema(d, "Limit", True).update(
            minimum=1.0, maximum=200.0, default=50.0
        ),
        0,
        "27 operations validated",
    ),
    (
        "equivalent nullable type order",
        lambda d: d["components"]["schemas"]["CursorPage"]["properties"]["next_cursor"].update(
            type=["null", "string"]
        ),
        0,
        "27 operations validated",
    ),
    (
        "boolean minimum cannot equal one",
        lambda d: parameter_schema(d, "Limit", True).update(minimum=True),
        1,
        "PAG-PARAMETER",
    ),
    (
        "numeric strings remain invalid",
        lambda d: parameter_schema(d, "Limit").update(maximum="200"),
        1,
        "PAG-PARAMETER",
    ),
    (
        "fractional bound remains different",
        lambda d: parameter_schema(d, "Limit").update(maximum=200.5),
        1,
        "PAG-PARAMETER",
    ),
    (
        "annotations cannot hide conflicting constraints",
        lambda d: parameter_schema(d, "Limit", True).update(
            title="Synthetic limit", description="Synthetic description", maximum=200.0, enum=[1]
        ),
        1,
        "PAG-PARAMETER",
    ),
    (
        "schema annotations must be strings",
        lambda d: parameter_schema(d, "Cursor").update(title={"type": "integer"}),
        1,
        "PAG-PARAMETER",
    ),
    (
        "nullable type duplicates remain invalid",
        lambda d: d["components"]["schemas"]["CursorPage"]["properties"]["next_cursor"].update(
            type=["null", "string", "string"]
        ),
        1,
        "PAG-RESPONSE",
    ),
    (
        "nullable extra type remains invalid",
        lambda d: d["components"]["schemas"]["CursorPage"]["properties"]["next_cursor"].update(
            type=["null", "string", "number"]
        ),
        1,
        "PAG-RESPONSE",
    ),
    (
        "nullable missing type remains invalid",
        lambda d: d["components"]["schemas"]["CursorPage"]["properties"]["next_cursor"].update(
            type=["string"]
        ),
        1,
        "PAG-RESPONSE",
    ),
    (
        "required continuation handling is unchanged",
        lambda d: d["components"]["schemas"]["CursorPage"]["required"].append("next_cursor"),
        0,
        "27 operations validated",
    ),
]

if selected is not None:
    probes = [probe for probe in probes if probe[0] == selected]
    if len(probes) != 1:
        raise SystemExit("FAIL: selected probe must identify exactly one assertion")

with tempfile.TemporaryDirectory(prefix="pagination-acceptance-") as temporary:
    target = Path(temporary) / "synthetic.yaml"
    for name, mutate, code, diagnostic in probes:
        candidate = copy.deepcopy(baseline)
        changed = mutate(candidate)
        target.write_text(
            changed
            if isinstance(changed, str) and changed.startswith(("openapi:", "#", "["))
            else yaml.safe_dump(candidate, sort_keys=False)
        )
        result = subprocess.run(  # noqa: S603
            [bash, str(source / "check-cursor-pagination.sh"), str(target)],
            env=dict(os.environ),
            capture_output=True,
            text=True,
            timeout=20,
        )
        output = result.stdout + result.stderr
        if (
            result.returncode != code
            or diagnostic not in output
            or "Traceback" in output
            or "SYNTHETIC_PRIVATE_MARKER" in output
        ):
            failures.append(name)
            print(f"FAIL {name}: expected {code}/{diagnostic}, got exit {result.returncode}")
        else:
            passed += 1
            print(f"PASS {name}")
label = "partial pagination acceptance" if selected is not None else "pagination acceptance"
print(f"{label}: {passed} passed, {len(failures)} failed")
raise SystemExit(bool(failures))
PY
