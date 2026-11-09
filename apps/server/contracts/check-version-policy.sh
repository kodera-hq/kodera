#!/usr/bin/env bash
set -euo pipefail
python_command="${PYTHON:-python3}"
"$python_command" - "$@" <<'PY'
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml

VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
MAX_BYTES = 2 * 1024 * 1024


class UniqueKeyLoader(yaml.SafeLoader):
    """Reject ambiguous mappings instead of silently trusting the last value."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        self.flatten_mapping(node)
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise ValueError("mapping keys must be unique strings")
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


def load_contract(path: Path) -> tuple[dict[str, Any], tuple[int, int, int], str]:
    try:
        with path.open("rb") as source:
            content = source.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise ValueError("document exceeds input limit")
        text = content.decode("utf-8")
        # Alias expansion can make canonical JSON exponentially larger than YAML.
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(text)):
            raise ValueError("aliases are unsupported")
        # This loader inherits SafeLoader; the override only rejects ambiguous keys.
        contract = yaml.load(text, Loader=UniqueKeyLoader)  # noqa: S506
        if not isinstance(contract, dict):
            raise ValueError("expected a mapping")
        if not isinstance(contract.get("openapi"), str) or not re.fullmatch(
            r"3\.[0-9]+\.[0-9]+", contract["openapi"]
        ):
            raise ValueError("expected OpenAPI 3.x")
        info = contract.get("info")
        if not isinstance(info, dict) or not isinstance(contract.get("paths"), dict):
            raise ValueError("expected info and paths mappings")
        if not isinstance(info.get("title"), str) or not info["title"].strip():
            raise ValueError("expected a nonempty API title")
        raw_version = info.get("version")
        if not isinstance(raw_version, str) or VERSION.fullmatch(raw_version) is None:
            raise ValueError("expected a stable X.Y.Z version")
        major, minor, patch = (int(part) for part in raw_version.split("."))
        # Canonical JSON preserves scalar types (unlike Python's True == 1).
        # It also rejects cycles, dates, non-finite floats and other non-JSON YAML.
        canonical = json.dumps(contract, sort_keys=True, allow_nan=False)
        return contract, (major, minor, patch), canonical
    except (OSError, UnicodeError, yaml.YAMLError, ValueError, TypeError, RecursionError) as error:
        # Parser exceptions can include entire source lines. Never print them.
        raise ValueError(
            "cannot read a valid, unambiguous OpenAPI document with stable version"
        ) from error


def validate(
    before: tuple[int, int, int],
    after: tuple[int, int, int],
    same_document: bool,
    change: str,
    labels: list[str],
) -> str | None:
    if change == "unchanged":
        return None if same_document else "unchanged classification requires equal documents"
    if after <= before:
        return "changed classification requires a strictly greater version"
    if change == "additive" and after[:2] <= before[:2]:
        return "additive classification requires at least a minor increase"
    if change == "breaking":
        if "contract:breaking" not in labels:
            return "breaking classification requires the contract:breaking label"
        if before[0] == 0 and after[:2] <= before[:2]:
            return "pre-launch breaking classification requires at least a minor increase"
        if before[0] != 0 and after[0] <= before[0]:
            return "frozen breaking classification requires a major increase"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Offline version policy; classification is caller supplied."
    )
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument(
        "--change", choices=("unchanged", "patch", "additive", "breaking"), required=True
    )
    parser.add_argument("--label", action="append", default=[])
    args = parser.parse_args()
    try:
        base, before, base_json = load_contract(args.base)
        candidate, after, candidate_json = load_contract(args.candidate)
        if base["info"]["title"] != candidate["info"]["title"]:
            raise ValueError("base and candidate must identify the same API title")
    except ValueError as error:
        print(f"INPUT: {error}", file=sys.stderr)
        return 2
    violation = validate(before, after, base_json == candidate_json, args.change, args.label)
    if violation:
        print(f"POLICY: {violation}", file=sys.stderr)
        return 1
    print(
        "PASS: version policy satisfied for supplied classification; compatibility and human approval unchecked"
    )
    return 0


raise SystemExit(main())
PY
