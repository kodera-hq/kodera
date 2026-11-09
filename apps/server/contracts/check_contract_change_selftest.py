"""Prove the contract change gate refuses what it must and passes what it must.

Every case makes real commits in a throwaway Git repository seeded with the committed contracts
and with the severity levels file beside the gate under test, runs that gate with the real
oasdiff and the real version policy (or a stand-in where the case is about a broken tool), and
asserts the exit status AND a message. The status is the one bit CI consumes; the message says
which refusal produced it, because a gate that goes red for the wrong reason proves nothing
about the rule a case is named after.

Every severity override has a case of its own, `override-<check id>`: a minimal contract pair
that oasdiff reports at INFO by default, which the override must raise to a breaking change.

A case that finds the committed contracts no longer shaped the way it needs stops the whole run
with exit 2 rather than reporting a pass or a policy failure.
"""

from __future__ import annotations

import argparse
import copy
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
DUMPER = getattr(yaml, "CSafeDumper", yaml.SafeDumper)
CORE = "contracts/core-api.openapi.yaml"
AGENT = "contracts/agent-api.openapi.yaml"
ADDED = "contracts/selftest-api.openapi.yaml"
PROBE = "contracts/probe-api.openapi.yaml"
SEVERITY = "contracts/oasdiff-severity-levels.txt"
LABEL = "contract:breaking"
LABEL_REFUSAL = "POLICY: breaking classification requires the contract:breaking label"
NO_BUMP_REFUSAL = "POLICY: changed classification requires a strictly greater version"
Edit = Callable[[dict[str, Any]], None]


class FixtureError(Exception):
    """The committed contracts, or the tools, are not what a case depends on."""


@dataclass(frozen=True)
class Run:
    head: str
    base: tuple[str, ...]
    exit: int
    expect: tuple[str, ...]
    labels: tuple[str, ...] = ()
    extra: tuple[str, ...] = ()
    refuse: tuple[str, ...] = ()


def load(text: str) -> dict[str, Any]:
    document = yaml.load(text, Loader=LOADER)  # noqa: S506 - safe loader
    if not isinstance(document, dict):
        raise FixtureError("a committed contract is not a mapping")
    return document


def dump(document: dict[str, Any]) -> str:
    return str(yaml.dump(document, Dumper=DUMPER, sort_keys=False, allow_unicode=True, width=4096))


class Fixture:
    def __init__(self, root: Path, contracts: Path, severity: Path, pinned: str) -> None:
        executable = shutil.which("git")
        if executable is None:
            raise FixtureError("git is not on PATH")
        self.executable = executable
        self.root = root
        self.pinned = pinned
        self.stubs = root.parent / "stubs"
        self.env = dict(
            os.environ,
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_CONFIG_NOSYSTEM="1",
            GIT_AUTHOR_NAME="self-test",
            GIT_AUTHOR_EMAIL="self-test@example.invalid",
            GIT_COMMITTER_NAME="self-test",
            GIT_COMMITTER_EMAIL="self-test@example.invalid",
        )
        root.mkdir()
        self.git("init", "--quiet")
        self.git("checkout", "--quiet", "-b", "trunk")
        (root / "contracts").mkdir()
        self.texts: dict[str, str] = {}
        for path in (CORE, AGENT):
            source = contracts / Path(path).name
            if not source.is_file():
                raise FixtureError(f"{source} is missing")
            self.texts[path] = source.read_text(encoding="utf-8")
            self.write(path, self.texts[path])
        if not severity.is_file():
            raise FixtureError(f"{severity} is missing")
        self.severity_text = severity.read_text(encoding="utf-8")
        self.write(SEVERITY, self.severity_text)
        self.documents = {path: load(text) for path, text in self.texts.items()}
        self.write("notes.txt", "base\n")
        self.base = self.commit("base")

    def git(self, *args: str) -> str:
        result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
            [self.executable, "-C", str(self.root), *args],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
            timeout=60,
        )
        if result.returncode != 0:
            raise FixtureError(f"git {args[0]} failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def commit(self, message: str) -> str:
        self.git("add", "--all")
        self.git("commit", "--quiet", "--allow-empty", "--no-verify", "-m", message)
        return self.git("rev-parse", "HEAD")

    def start(self, branch: str, at: str | None = None) -> None:
        self.git("checkout", "--quiet", "--force", "-B", branch, at or self.base)

    def write(self, path: str, text: str) -> None:
        (self.root / path).write_text(text, encoding="utf-8")

    def document(self, path: str) -> dict[str, Any]:
        return copy.deepcopy(self.documents[path])

    def change(self, branch: str, path: str, *edits: Edit, at: str | None = None) -> str:
        """Start a branch, write one contract as the base's copy with edits applied, commit."""
        self.start(branch, at)
        document = self.document(path)
        for edit in edits:
            edit(document)
        self.write(path, dump(document))
        return self.commit(branch)

    def empty_commit(self, message: str, parent: str | None = None) -> str:
        tree = self.git("hash-object", "-w", "-t", "tree", os.devnull)
        arguments = ["commit-tree", tree, "-m", message]
        if parent is not None:
            arguments += ["-p", parent]
        return self.git(*arguments)

    def stub(self, name: str, body: str) -> str:
        self.stubs.mkdir(exist_ok=True)
        path = self.stubs / name
        path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return str(path)

    def breaking_bump_refusal(self) -> str:
        major = int(str(self.documents[CORE]["info"]["version"]).split(".")[0])
        if major == 0:
            return "POLICY: pre-launch breaking classification requires at least a minor increase"
        return "POLICY: frozen breaking classification requires a major increase"


def schema(document: dict[str, Any], name: str) -> dict[str, Any]:
    found = document.get("components", {}).get("schemas", {}).get(name)
    if not isinstance(found, dict) or not isinstance(found.get("properties"), dict):
        raise FixtureError(f"schema {name} with properties is gone from the contract")
    return found


def operation(document: dict[str, Any], path: str, method: str) -> dict[str, Any]:
    found = document.get("paths", {}).get(path, {}).get(method)
    if not isinstance(found, dict):
        raise FixtureError(f"{method.upper()} {path} is gone from the contract")
    return found


def bump(kind: str) -> Edit:
    def edit(document: dict[str, Any]) -> None:
        major, minor, patch = (int(part) for part in str(document["info"]["version"]).split("."))
        if kind == "patch":
            version = (major, minor, patch + 1)
        elif kind == "breaking" and major != 0:
            version = (major + 1, 0, 0)
        else:
            version = (major, minor + 1, 0)
        document["info"]["version"] = ".".join(str(part) for part in version)

    return edit


def remove_required_response_field(document: dict[str, Any]) -> None:
    organisation = schema(document, "Organisation")
    if "created_at" not in organisation.get("required", []):
        raise FixtureError("Organisation.created_at is no longer a required response field")
    organisation["required"].remove("created_at")
    organisation["properties"].pop("created_at")


def add_optional_response_field(document: dict[str, Any]) -> None:
    organisation = schema(document, "Organisation")
    organisation["properties"]["selftest_probe"] = {"type": "string", "maxLength": 16}


def optional_legal_name(document: dict[str, Any]) -> dict[str, Any]:
    organisation = schema(document, "Organisation")
    if "legal_name" not in organisation["properties"] or "legal_name" in organisation.get(
        "required", []
    ):
        raise FixtureError("Organisation.legal_name is no longer an optional response field")
    return organisation


def remove_optional_response_field(document: dict[str, Any]) -> None:
    optional_legal_name(document)["properties"].pop("legal_name")


def make_optional_response_field_write_only(document: dict[str, Any]) -> None:
    optional_legal_name(document)["properties"]["legal_name"]["writeOnly"] = True


def remove_optional_request_field(document: dict[str, Any]) -> None:
    request = schema(document, "OrganisationPatchRequest")
    if "locale" not in request["properties"] or "locale" in request.get("required", []):
        raise FixtureError("OrganisationPatchRequest.locale is no longer an optional field")
    request["properties"].pop("locale")


def add_request_enum_member(document: dict[str, Any]) -> None:
    for parameter in operation(document, "/catalog/plans", "get").get("parameters", []):
        if isinstance(parameter, dict) and parameter.get("name") == "state":
            members = parameter.get("schema", {}).get("enum")
            if isinstance(members, list):
                members.append("selftest_probe")
                return
    raise FixtureError("GET /catalog/plans no longer has a `state` enum parameter")


def remove_response_enum_member(document: dict[str, Any]) -> None:
    members = document.get("components", {}).get("schemas", {}).get("OrganisationState", {})
    members = members.get("enum") if isinstance(members, dict) else None
    if not isinstance(members, list) or "closed" not in members:
        raise FixtureError("OrganisationState no longer has a `closed` member")
    members.remove("closed")


def change_description(document: dict[str, Any]) -> None:
    document["info"]["description"] = (
        f"{document['info'].get('description', '')}\nSelf-test prose.\n"
    )


def add_external_reference(document: dict[str, Any]) -> None:
    organisation = schema(document, "Organisation")
    organisation["properties"]["selftest_probe"] = {"$ref": "selftest-missing.yaml#/Probe"}


def move_servers_to_v2(document: dict[str, Any]) -> None:
    servers = document.get("servers")
    if not isinstance(servers, list) or not any(
        isinstance(server, dict) and "/api/v1" in str(server.get("url")) for server in servers
    ):
        raise FixtureError("the core contract no longer lists an /api/v1 server")
    for server in servers:
        server["url"] = str(server["url"]).replace("/api/v1", "/api/v2")


def me_roles(document: dict[str, Any]) -> list[str]:
    authz = operation(document, "/me", "get").get("x-kodera-authz")
    roles = authz.get("roles") if isinstance(authz, dict) else None
    if not isinstance(roles, list) or len(roles) < 2:
        raise FixtureError("GET /me no longer lists several roles in x-kodera-authz")
    return roles


def narrow_authz(document: dict[str, Any]) -> None:
    me_roles(document).pop()


def widen_authz(document: dict[str, Any]) -> None:
    me_roles(document).append("selftest_probe_role")


def change_scope(document: dict[str, Any]) -> None:
    me = operation(document, "/me", "get")
    if not isinstance(me.get("x-kodera-scope"), str):
        raise FixtureError("GET /me no longer declares an x-kodera-scope")
    me["x-kodera-scope"] = "selftest:probe"


def require_security(document: dict[str, Any]) -> None:
    discover = operation(document, "/auth/discover", "post")
    if discover.get("security") != [] or not document.get("security"):
        raise FixtureError("POST /auth/discover is no longer anonymous")
    discover["security"] = copy.deepcopy(document["security"])


def remove_agent_required_response_field(document: dict[str, Any]) -> None:
    ack = schema(document, "HeartbeatAck")
    if "next_interval_s" not in ack.get("required", []):
        raise FixtureError("HeartbeatAck.next_interval_s is no longer a required response field")
    ack["required"].remove("next_interval_s")
    ack["properties"].pop("next_interval_s")


def probe_document() -> dict[str, Any]:
    """The smallest contract every override pair below edits."""
    return {
        "openapi": "3.1.0",
        "info": {"title": "Probe API", "version": "0.1.0"},
        "components": {"securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}},
        "paths": {
            "/things": {
                "get": {
                    "operationId": "listThings",
                    "security": [],
                    "parameters": [
                        {
                            "name": "state",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "string", "enum": ["a", "b"], "default": "a"},
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "kind": {
                                                "type": "string",
                                                "enum": ["a", "b"],
                                                "default": "a",
                                            },
                                            "note": {"type": "string"},
                                        },
                                    }
                                }
                            },
                        },
                        "404": {"description": "missing"},
                    },
                },
                "post": {
                    "operationId": "createThing",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "kind": {
                                            "type": "string",
                                            "enum": ["a", "b"],
                                            "default": "a",
                                        }
                                    },
                                }
                            }
                        },
                    },
                    "responses": {"201": {"description": "created"}},
                },
            }
        },
    }


def _get(d: dict[str, Any]) -> dict[str, Any]:
    return d["paths"]["/things"]["get"]


def _post(d: dict[str, Any]) -> dict[str, Any]:
    return d["paths"]["/things"]["post"]


def _response(d: dict[str, Any]) -> dict[str, Any]:
    return _get(d)["responses"]["200"]["content"]["application/json"]


def _body(d: dict[str, Any]) -> dict[str, Any]:
    return _post(d)["requestBody"]["content"]["application/json"]


def _parameter(d: dict[str, Any]) -> dict[str, Any]:
    return _get(d)["parameters"][0]


def _string_default(target: Callable[[dict[str, Any]], dict[str, Any]]) -> Edit:
    return lambda d: target(d).update(schema={"type": "string", "default": "a"})


def _require_note(d: dict[str, Any]) -> None:
    _response(d)["schema"]["required"] = ["note"]


def _write_only_note(d: dict[str, Any]) -> None:
    _response(d)["schema"]["properties"]["note"]["writeOnly"] = True


def _required_write_only_note(d: dict[str, Any]) -> None:
    _require_note(d)
    _write_only_note(d)


def _remove_required_note(d: dict[str, Any]) -> None:
    _response(d)["schema"]["properties"].pop("note")
    _response(d)["schema"]["required"] = []


# check id -> (edit to the probe before the base commit, or None; edit that makes the head)
OVERRIDE_PAIRS: dict[str, tuple[Edit | None, Edit]] = {
    "response-required-property-became-write-only": (_require_note, _write_only_note),
    "response-required-write-only-property-removed": (
        _required_write_only_note,
        _remove_required_note,
    ),
    "request-parameter-enum-value-added": (
        None,
        lambda d: _parameter(d)["schema"]["enum"].append("c"),
    ),
    "request-parameter-property-enum-value-added": (
        lambda d: _parameter(d).update(
            schema={
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": ["a", "b"]}},
            }
        ),
        lambda d: _parameter(d)["schema"]["properties"]["kind"]["enum"].append("c"),
    ),
    "request-property-enum-value-added": (
        None,
        lambda d: _body(d)["schema"]["properties"]["kind"]["enum"].append("c"),
    ),
    "response-property-enum-value-removed": (
        None,
        lambda d: _response(d)["schema"]["properties"]["kind"]["enum"].pop(),
    ),
    "response-mediatype-enum-value-removed": (
        lambda d: _response(d).update(schema={"type": "string", "enum": ["a", "b"]}),
        lambda d: _response(d)["schema"]["enum"].pop(),
    ),
    "response-optional-property-removed": (
        None,
        lambda d: _response(d)["schema"]["properties"].pop("note"),
    ),
    "response-non-success-status-removed": (None, lambda d: _get(d)["responses"].pop("404")),
    "request-parameter-default-value-changed": (
        None,
        lambda d: _parameter(d)["schema"].update(default="b"),
    ),
    "request-parameter-default-value-removed": (
        None,
        lambda d: _parameter(d)["schema"].pop("default"),
    ),
    "request-body-default-value-changed": (
        _string_default(_body),
        lambda d: _body(d)["schema"].update(default="b"),
    ),
    "request-body-default-value-removed": (
        _string_default(_body),
        lambda d: _body(d)["schema"].pop("default"),
    ),
    "request-property-default-value-changed": (
        None,
        lambda d: _body(d)["schema"]["properties"]["kind"].update(default="b"),
    ),
    "request-property-default-value-removed": (
        None,
        lambda d: _body(d)["schema"]["properties"]["kind"].pop("default"),
    ),
    "response-body-default-value-changed": (
        _string_default(_response),
        lambda d: _response(d)["schema"].update(default="b"),
    ),
    "response-body-default-value-removed": (
        _string_default(_response),
        lambda d: _response(d)["schema"].pop("default"),
    ),
    "response-property-default-value-changed": (
        None,
        lambda d: _response(d)["schema"]["properties"]["kind"].update(default="b"),
    ),
    "response-property-default-value-removed": (
        None,
        lambda d: _response(d)["schema"]["properties"]["kind"].pop("default"),
    ),
    "api-path-removed-with-deprecation": (
        lambda d: d["paths"].update(
            {
                "/old": {
                    "get": {
                        "operationId": "old",
                        "deprecated": True,
                        "responses": {"200": {"description": "ok"}},
                    }
                }
            }
        ),
        lambda d: d["paths"].pop("/old"),
    ),
    "api-removed-with-deprecation": (
        lambda d: d["paths"]["/things"].update(
            delete={
                "operationId": "deleteThings",
                "deprecated": True,
                "responses": {"204": {"description": "gone"}},
            }
        ),
        lambda d: d["paths"]["/things"].pop("delete"),
    ),
    "request-parameter-removed-with-deprecation": (
        lambda d: _parameter(d).update(deprecated=True),
        lambda d: _get(d).update(parameters=[]),
    ),
    "api-security-added": (None, lambda d: _get(d).update(security=[{"bearer": []}])),
    "response-optional-property-became-write-only": (
        None,
        lambda d: _response(d)["schema"]["properties"]["note"].update(writeOnly=True),
    ),
    "response-optional-write-only-property-removed": (
        lambda d: _response(d)["schema"]["properties"]["note"].update(writeOnly=True),
        lambda d: _response(d)["schema"]["properties"].pop("note"),
    ),
}


CASES: dict[str, Callable[[Fixture], Run]] = {}


def case(name: str) -> Callable[[Callable[[Fixture], Run]], Callable[[Fixture], Run]]:
    def register(build: Callable[[Fixture], Run]) -> Callable[[Fixture], Run]:
        if name in CASES:
            raise ValueError(f"duplicate case {name}")
        CASES[name] = build
        return build

    return register


PR = ("--target", "trunk")


def untouched_contracts(f: Fixture, branch: str) -> str:
    f.start(branch)
    f.write("notes.txt", f"{branch}: a change outside contracts/\n")
    return f.commit(branch)


@case("baseline")
def _baseline(f: Fixture) -> Run:
    head = untouched_contracts(f, "baseline")
    return Run(
        head,
        PR,
        0,
        (
            f"{CORE}: unchanged (same file)",
            f"{AGENT}: unchanged (same file)",
            "contract change gate passed: 2 contract(s) checked",
        ),
    )


@case("formatting-only")
def _formatting_only(f: Fixture) -> Run:
    head = f.change("formatting-only", CORE)
    return Run(head, PR, 0, (f"{CORE}: unchanged (formatting only",))


@case("breaking-without-bump")
def _breaking_without_bump(f: Fixture) -> Run:
    head = f.change("breaking-without-bump", CORE, remove_required_response_field)
    return Run(
        head,
        PR,
        1,
        (
            "classified breaking",
            "ERR  response-required-property-removed",
            NO_BUMP_REFUSAL,
            f"::error file={CORE}::breaking change (",
        ),
    )


@case("breaking-with-bump-and-label")
def _breaking_with_bump_and_label(f: Fixture) -> Run:
    head = f.change("breaking-bump-label", CORE, remove_required_response_field, bump("breaking"))
    return Run(head, PR, 0, ("classified breaking", "PASS:"), labels=(LABEL,))


@case("breaking-with-bump-without-label")
def _breaking_with_bump_without_label(f: Fixture) -> Run:
    head = f.change("breaking-bump", CORE, remove_required_response_field, bump("breaking"))
    return Run(head, PR, 1, ("classified breaking", LABEL_REFUSAL))


@case("breaking-with-patch-bump")
def _breaking_with_patch_bump(f: Fixture) -> Run:
    head = f.change("breaking-patch", CORE, remove_required_response_field, bump("patch"))
    return Run(head, PR, 1, ("classified breaking", f.breaking_bump_refusal()), labels=(LABEL,))


@case("additive-with-minor-bump")
def _additive_with_minor_bump(f: Fixture) -> Run:
    head = f.change("additive-minor", CORE, add_optional_response_field, bump("minor"))
    return Run(
        head,
        PR,
        0,
        ("classified additive", "INFO response-optional-property-added", "PASS:"),
        refuse=("classified breaking",),
    )


@case("additive-with-patch-bump")
def _additive_with_patch_bump(f: Fixture) -> Run:
    head = f.change("additive-patch", CORE, add_optional_response_field, bump("patch"))
    return Run(
        head,
        PR,
        1,
        (
            "classified additive",
            "POLICY: additive classification requires at least a minor increase",
        ),
    )


@case("prose-with-patch-bump")
def _prose_with_patch_bump(f: Fixture) -> Run:
    head = f.change("prose-patch", CORE, change_description, bump("patch"))
    return Run(head, PR, 0, ("classified patch", "PASS:"))


@case("prose-without-bump")
def _prose_without_bump(f: Fixture) -> Run:
    head = f.change("prose", CORE, change_description)
    return Run(head, PR, 1, ("classified patch", NO_BUMP_REFUSAL))


@case("request-enum-member-added")
def _request_enum_member_added(f: Fixture) -> Run:
    head = f.change("request-enum", CORE, add_request_enum_member, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("classified breaking", "ERR  request-parameter-enum-value-added", LABEL_REFUSAL),
    )


@case("optional-response-field-removed")
def _optional_response_field_removed(f: Fixture) -> Run:
    head = f.change("optional-removed", CORE, remove_optional_response_field, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("classified breaking", "ERR  response-optional-property-removed", LABEL_REFUSAL),
    )


@case("request-field-removed")
def _request_field_removed(f: Fixture) -> Run:
    head = f.change("request-field", CORE, remove_optional_request_field, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("classified breaking", "WARN request-property-removed", LABEL_REFUSAL),
    )


@case("servers-changed")
def _servers_changed(f: Fixture) -> Run:
    head = f.change("servers", CORE, move_servers_to_v2, bump("minor"))
    return Run(head, PR, 1, ("classified breaking", "ERR  servers-changed", LABEL_REFUSAL))


@case("authz-narrowed")
def _authz_narrowed(f: Fixture) -> Run:
    head = f.change("authz-narrowed", CORE, narrow_authz, bump("minor"))
    return Run(head, PR, 1, ("ERR  x-kodera-authz-changed  GET /me", LABEL_REFUSAL))


@case("authz-widened")
def _authz_widened(f: Fixture) -> Run:
    head = f.change("authz-widened", CORE, widen_authz, bump("minor"))
    return Run(head, PR, 1, ("ERR  x-kodera-authz-changed  GET /me", LABEL_REFUSAL))


@case("scope-changed")
def _scope_changed(f: Fixture) -> Run:
    head = f.change("scope", CORE, change_scope, bump("minor"))
    return Run(head, PR, 1, ("ERR  x-kodera-scope-changed  GET /me", LABEL_REFUSAL))


def reverse_authz(document: dict[str, Any]) -> None:
    me_roles(document).reverse()


def scope_as_list(document: dict[str, Any]) -> None:
    me = operation(document, "/me", "get")
    if not isinstance(me.get("x-kodera-scope"), str):
        raise FixtureError("GET /me no longer declares an x-kodera-scope")
    me["x-kodera-scope"] = [me["x-kodera-scope"], "selftest:probe"]


def reverse_scope(document: dict[str, Any]) -> None:
    operation(document, "/me", "get")["x-kodera-scope"].reverse()


@case("authz-reordered")
def _authz_reordered(f: Fixture) -> Run:
    head = f.change("authz-reordered", CORE, reverse_authz, bump("patch"))
    return Run(
        head,
        PR,
        0,
        ("classified patch", "PASS:"),
        refuse=("x-kodera-authz-changed", "classified breaking"),
    )


@case("scope-reordered")
def _scope_reordered(f: Fixture) -> Run:
    as_list = (scope_as_list, bump("patch"))
    target = f.change("scope-as-list", CORE, *as_list)
    head = f.change("scope-reordered", CORE, *as_list, reverse_scope, bump("patch"), at=target)
    return Run(
        head,
        ("--target", target),
        0,
        ("classified patch", "PASS:"),
        refuse=("x-kodera-scope-changed", "classified breaking"),
    )


def repeat_role(document: dict[str, Any]) -> None:
    roles = me_roles(document)
    roles.append(roles[0])


def add_path_servers(document: dict[str, Any]) -> None:
    item = document.get("paths", {}).get("/me")
    if not isinstance(item, dict) or "servers" in item:
        raise FixtureError("the /me path item is gone or already declares servers")
    item["servers"] = [{"url": "https://selftest.example.invalid/api/v1"}]


def add_operation_servers(document: dict[str, Any]) -> None:
    me = operation(document, "/me", "get")
    if "servers" in me:
        raise FixtureError("GET /me already declares servers")
    me["servers"] = [{"url": "https://selftest.example.invalid/api/v1"}]


def security_schemes(document: dict[str, Any]) -> dict[str, Any]:
    found = document.get("components", {}).get("securitySchemes")
    if not isinstance(found, dict) or not all(
        isinstance(found.get(name), dict) for name in ("keycloakStaff", "keycloakTenant")
    ):
        raise FixtureError("the keycloakStaff and keycloakTenant security schemes are gone")
    return found


def move_staff_realm(document: dict[str, Any]) -> None:
    staff = security_schemes(document)["keycloakStaff"]
    url = staff.get("openIdConnectUrl")
    if not isinstance(url, str) or "/realms/" not in url:
        raise FixtureError("keycloakStaff no longer has a realm openIdConnectUrl")
    staff["openIdConnectUrl"] = url.replace("/realms/", "/realms/selftest-")


def change_tenant_scheme_type(document: dict[str, Any]) -> None:
    security_schemes(document)["keycloakTenant"] = {"type": "http", "scheme": "bearer"}


def add_probe_scheme(document: dict[str, Any]) -> None:
    security_schemes(document)["selftestProbe"] = {"type": "http", "scheme": "bearer"}


def describe_staff_scheme(document: dict[str, Any]) -> None:
    staff = security_schemes(document)["keycloakStaff"]
    staff["description"] = f"{staff.get('description', '')}\nSelf-test prose.\n"


@case("authz-repeated-role")
def _authz_repeated_role(f: Fixture) -> Run:
    head = f.change("authz-repeated", CORE, repeat_role, bump("patch"))
    return Run(
        head,
        PR,
        0,
        ("classified patch", "PASS:"),
        refuse=("x-kodera-authz-changed", "classified breaking"),
    )


@case("path-servers-changed")
def _path_servers_changed(f: Fixture) -> Run:
    head = f.change("path-servers", CORE, add_path_servers, bump("minor"))
    return Run(
        head, PR, 1, ("ERR  servers-changed  /me: the path's servers changed", LABEL_REFUSAL)
    )


@case("operation-servers-changed")
def _operation_servers_changed(f: Fixture) -> Run:
    head = f.change("operation-servers", CORE, add_operation_servers, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("ERR  servers-changed  GET /me: the operation's servers changed", LABEL_REFUSAL),
    )


@case("security-scheme-url-changed")
def _security_scheme_url_changed(f: Fixture) -> Run:
    head = f.change("scheme-url", CORE, move_staff_realm, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("ERR  security-scheme-changed  components/securitySchemes/keycloakStaff", LABEL_REFUSAL),
    )


@case("security-scheme-type-changed")
def _security_scheme_type_changed(f: Fixture) -> Run:
    head = f.change("scheme-type", CORE, change_tenant_scheme_type, bump("minor"))
    return Run(
        head,
        PR,
        1,
        ("ERR  security-scheme-changed  components/securitySchemes/keycloakTenant", LABEL_REFUSAL),
    )


@case("security-scheme-removed")
def _security_scheme_removed(f: Fixture) -> Run:
    target = f.change("scheme-probe", CORE, add_probe_scheme, bump("minor"))
    head = f.change("scheme-removed", CORE, bump("minor"), bump("minor"), at=target)
    return Run(
        head,
        ("--target", target),
        1,
        ("ERR  security-scheme-removed  components/securitySchemes/selftestProbe", LABEL_REFUSAL),
    )


@case("security-scheme-added")
def _security_scheme_added(f: Fixture) -> Run:
    head = f.change("scheme-added", CORE, add_probe_scheme, bump("minor"))
    return Run(
        head,
        PR,
        0,
        ("classified additive", "INFO security-scheme-added", "PASS:"),
        refuse=("classified breaking",),
    )


@case("security-scheme-description-changed")
def _security_scheme_description_changed(f: Fixture) -> Run:
    head = f.change("scheme-description", CORE, describe_staff_scheme, bump("patch"))
    return Run(head, PR, 0, ("classified patch", "PASS:"), refuse=("security-scheme-changed",))


@case("base-equals-head")
def _base_equals_head(f: Fixture) -> Run:
    return Run(
        f.base,
        PR,
        0,
        ("no contract comparison performed: base equals head",),
        refuse=("gate passed",),
    )


def _probe_with_thing(document: dict[str, Any]) -> None:
    document["paths"]["/things/{thing_id}"] = {
        "get": {
            "operationId": "getThing",
            "x-kodera-authz": {"roles": ["a", "b"]},
            "x-kodera-scope": "things:read",
            "parameters": [
                {"name": "thing_id", "in": "path", "required": True, "schema": {"type": "string"}}
            ],
            "responses": {"200": {"description": "ok"}},
        }
    }


def _rename_thing_parameter(document: dict[str, Any]) -> None:
    item = document["paths"].pop("/things/{thing_id}")
    item["get"]["parameters"][0]["name"] = "id"
    document["paths"]["/things/{id}"] = item


def _widen_thing_roles(document: dict[str, Any]) -> None:
    document["paths"]["/things/{id}"]["get"]["x-kodera-authz"]["roles"].append("c")


def probe_pair(f: Fixture, branch: str, edits: tuple[Edit, ...], version: str) -> tuple[str, str]:
    """Commit a probe contract with a parameterised operation, then the probe with edits."""
    base = probe_document()
    _probe_with_thing(base)
    f.start(branch)
    f.write(PROBE, dump(base))
    target = f.commit(f"{branch}: probe before")
    head = copy.deepcopy(base)
    for edit in edits:
        edit(head)
    head["info"]["version"] = version
    f.write(PROBE, dump(head))
    return target, f.commit(f"{branch}: probe after")


@case("parameter-rename-alone")
def _parameter_rename_alone(f: Fixture) -> Run:
    target, head = probe_pair(f, "rename-alone", (_rename_thing_parameter,), "0.1.1")
    return Run(
        head,
        ("--target", target),
        0,
        ("classified patch", "PASS:"),
        refuse=("x-kodera-authz-changed",),
    )


@case("parameter-rename-widens-authz")
def _parameter_rename_widens_authz(f: Fixture) -> Run:
    edits = (_rename_thing_parameter, _widen_thing_roles)
    target, head = probe_pair(f, "rename-widens", edits, "0.2.0")
    return Run(
        head,
        ("--target", target),
        1,
        ("ERR  x-kodera-authz-changed  GET /things/{id}", LABEL_REFUSAL),
    )


@case("security-added")
def _security_added(f: Fixture) -> Run:
    head = f.change("security", CORE, require_security, bump("minor"))
    return Run(head, PR, 1, ("ERR  api-security-added", LABEL_REFUSAL))


@case("became-write-only")
def _became_write_only(f: Fixture) -> Run:
    head = f.change("write-only", CORE, make_optional_response_field_write_only, bump("minor"))
    return Run(head, PR, 1, ("ERR  response-optional-property-became-write-only", LABEL_REFUSAL))


@case("write-only-removed")
def _write_only_removed(f: Fixture) -> Run:
    first_step = (make_optional_response_field_write_only, bump("patch"))
    target = f.change("write-only-first-step", CORE, *first_step)
    head = f.change(
        "write-only-second-step",
        CORE,
        *first_step,
        remove_optional_response_field,
        bump("minor"),
        at=target,
    )
    return Run(
        head,
        ("--target", target),
        1,
        ("ERR  response-optional-write-only-property-removed", LABEL_REFUSAL),
    )


@case("head-weakens-severity")
def _head_weakens_severity(f: Fixture) -> Run:
    line = "response-property-enum-value-removed err\n"
    if line not in f.severity_text:
        raise FixtureError(f"the severity levels file no longer holds {line.strip()!r}")
    f.start("weakened-rules")
    document = f.document(CORE)
    remove_response_enum_member(document)
    bump("minor")(document)
    f.write(CORE, dump(document))
    f.write(SEVERITY, f.severity_text.replace(line, ""))
    head = f.commit("weaken the rules and use the weakening")
    return Run(
        head,
        PR,
        1,
        (
            "severity levels: contracts/oasdiff-severity-levels.txt as it is at the base",
            "ERR  response-property-enum-value-removed",
            LABEL_REFUSAL,
        ),
    )


@case("severity-not-at-base")
def _severity_not_at_base(f: Fixture) -> Run:
    f.start("no-rules")
    (f.root / SEVERITY).unlink()
    target = f.commit("no severity levels file")
    head = f.change("rules-bootstrapped", CORE, add_request_enum_member, bump("minor"), at=target)
    return Run(
        head,
        ("--target", target),
        1,
        (
            "is not at the base, so the copy beside the gate is used",
            "ERR  request-parameter-enum-value-added",
        ),
    )


@case("agent-contract-checked")
def _agent_contract_checked(f: Fixture) -> Run:
    head = f.change("agent", AGENT, remove_agent_required_response_field)
    return Run(
        head,
        PR,
        1,
        (
            f"{CORE}: unchanged (same file)",
            f"{AGENT}: modified",
            "ERR  response-required-property-removed",
            f"::error file={AGENT}::",
        ),
    )


@case("contract-added")
def _contract_added(f: Fixture) -> Run:
    f.start("added")
    f.write(ADDED, f.texts[AGENT])
    head = f.commit("added")
    return Run(
        head, PR, 0, (f"{ADDED}: added", "contract change gate passed: 3 contract(s) checked")
    )


@case("added-contract-invalid-version")
def _added_contract_invalid_version(f: Fixture) -> Run:
    f.start("added-invalid")
    document = f.document(AGENT)
    document["info"]["version"] = "1.0"
    f.write(ADDED, dump(document))
    head = f.commit("added with an unstable version")
    return Run(
        head,
        PR,
        2,
        (f"{ADDED}: could not be checked", "the version policy exited 2 without a verdict: INPUT:"),
        refuse=("gate passed",),
    )


@case("contract-deleted")
def _contract_deleted(f: Fixture) -> Run:
    f.start("deleted")
    (f.root / AGENT).unlink()
    head = f.commit("deleted")
    return Run(head, PR, 1, (f"{AGENT}: deleted", f"::error file={AGENT}::"))


@case("target-moved-after-branching")
def _target_moved_after_branching(f: Fixture) -> Run:
    f.change("moved-trunk", CORE, remove_required_response_field, bump("breaking"))
    head = untouched_contracts(f, "cut-before-the-move")
    return Run(
        head,
        ("--target", "moved-trunk"),
        0,
        ("merge-base of moved-trunk and the head", f"{CORE}: unchanged (same file)"),
    )


@case("breaking-below-the-tip")
def _breaking_below_the_tip(f: Fixture) -> Run:
    f.change("below-the-tip", CORE, remove_required_response_field, bump("breaking"))
    f.write("notes.txt", "the tip, one commit above the breaking change\n")
    head = f.commit("tip")
    return Run(head, PR, 1, ("merge-base of trunk and the head", LABEL_REFUSAL))


@case("push-compares-first-parent")
def _push_compares_first_parent(f: Fixture) -> Run:
    f.change("pushed", CORE, remove_required_response_field, bump("breaking"))
    f.write("notes.txt", "the next commit on the branch\n")
    head = f.commit("next")
    return Run(
        head, ("--parent",), 0, ("first parent of the head", f"{CORE}: unchanged (same file)")
    )


@case("push-checks-its-own-commit")
def _push_checks_its_own_commit(f: Fixture) -> Run:
    head = f.change("pushed-change", CORE, remove_required_response_field, bump("breaking"))
    return Run(head, ("--parent",), 1, ("first parent of the head", LABEL_REFUSAL))


@case("push-compares-with-given-base")
def _push_compares_with_given_base(f: Fixture) -> Run:
    f.change("pushed-twice", CORE, remove_required_response_field, bump("breaking"))
    f.write("notes.txt", "the second commit of the push\n")
    head = f.commit("second")
    return Run(head, ("--base", f.base), 1, (f"the given base {f.base}", LABEL_REFUSAL))


@case("no-contracts")
def _no_contracts(f: Fixture) -> Run:
    empty = f.empty_commit("no contracts")
    head = f.empty_commit("still no contracts", parent=empty)
    return Run(head, ("--parent",), 2, ("nothing was checked",), refuse=("gate passed",))


@case("no-merge-base")
def _no_merge_base(f: Fixture) -> Run:
    unrelated = f.empty_commit("an unrelated history")
    head = untouched_contracts(f, "no-merge-base")
    return Run(head, ("--target", unrelated), 2, ("git merge-base failed",))


@case("root-commit")
def _root_commit(f: Fixture) -> Run:
    return Run(f.base, ("--parent",), 2, ("has no parent",))


@case("unknown-revision")
def _unknown_revision(f: Fixture) -> Run:
    return Run("refs/heads/no-such-branch", PR, 2, ("git rev-parse failed",))


@case("oasdiff-unavailable")
def _oasdiff_unavailable(f: Fixture) -> Run:
    head = f.change("no-oasdiff", CORE, change_description, bump("patch"))
    missing = str(f.root / "no-such-oasdiff")
    return Run(head, PR, 2, ("cannot run oasdiff at",), extra=("--oasdiff", missing))


@case("oasdiff-version-fails")
def _oasdiff_version_fails(f: Fixture) -> Run:
    head = untouched_contracts(f, "oasdiff-version-fails")
    stub = f.stub("oasdiff-broken", "exit 3")
    return Run(head, PR, 2, ("--version exited 3",), extra=("--oasdiff", stub))


@case("oasdiff-wrong-version")
def _oasdiff_wrong_version(f: Fixture) -> Run:
    head = untouched_contracts(f, "oasdiff-wrong-version")
    stub = f.stub("oasdiff-old", 'echo "oasdiff version 0.0.1"')
    return Run(head, PR, 2, ("not the pinned version",), extra=("--oasdiff", stub))


@case("oasdiff-not-json")
def _oasdiff_not_json(f: Fixture) -> Run:
    head = f.change("oasdiff-not-json", CORE, change_description, bump("patch"))
    stub = f.stub(
        "oasdiff-garbage",
        f'if [ "$1" = "--version" ]; then echo "oasdiff version {f.pinned}"; exit 0; fi\n'
        'echo "this is not JSON"',
    )
    return Run(head, PR, 2, ("did not print a JSON changelog",), extra=("--oasdiff", stub))


@case("unreadable-contract")
def _unreadable_contract(f: Fixture) -> Run:
    f.start("unreadable")
    f.write(CORE, "openapi: 3.1.0\ninfo: [\n")
    head = f.commit("unreadable")
    return Run(head, PR, 2, (f"{CORE}: could not be checked", "cannot parse the document"))


@case("external-reference-refused")
def _external_reference_refused(f: Fixture) -> Run:
    head = f.change("external-ref", CORE, add_external_reference, bump("minor"))
    return Run(head, PR, 2, ("oasdiff exited", "disallowed external reference"))


@case("policy-without-verdict")
def _policy_without_verdict(f: Fixture) -> Run:
    head = f.change("silent-policy", CORE, change_description, bump("patch"))
    stub = f.stub("policy-silent", "exit 0")
    return Run(head, PR, 2, ("without a verdict",), extra=("--policy", stub))


def override_case(check: str) -> Callable[[Fixture], Run]:
    setup, change = OVERRIDE_PAIRS[check]

    def build(f: Fixture) -> Run:
        base = probe_document()
        if setup is not None:
            setup(base)
        f.start(f"override-{check}")
        f.write(PROBE, dump(base))
        target = f.commit(f"probe before {check}")
        head = copy.deepcopy(base)
        change(head)
        head["info"]["version"] = "0.2.0"
        f.write(PROBE, dump(head))
        commit = f.commit(f"probe after {check}")
        return Run(commit, ("--target", target), 1, (f"ERR  {check}", LABEL_REFUSAL))

    return build


for _check in OVERRIDE_PAIRS:
    case(f"override-{_check}")(override_case(_check))


def verify(
    fixture: Fixture, gate: Path, oasdiff: str, pinned: str, name: str, show: bool
) -> list[str]:
    run = CASES[name](fixture)
    arguments = [sys.executable, str(gate), "--repo", str(fixture.root), "--head", run.head]
    arguments += [*run.base, "--oasdiff", oasdiff, "--oasdiff-version", pinned]
    arguments += [f"--label={label}" for label in run.labels]
    arguments += list(run.extra)
    result = subprocess.run(  # noqa: S603 - fixed interpreter and gate, no shell
        arguments,
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
        env=dict(fixture.env, PYTHON=sys.executable),
    )
    output = result.stdout + result.stderr
    problems = []
    if "Traceback" in output:
        problems.append("the gate crashed")
    if result.returncode != run.exit:
        problems.append(f"expected exit {run.exit}, got {result.returncode}")
    problems += [f"missing {needle!r}" for needle in run.expect if needle not in output]
    problems += [f"unexpected {needle!r}" for needle in run.refuse if needle in output]
    if problems:
        print(f"FAIL {name}: {'; '.join(problems)}")
        print("\n".join(f"    | {line}" for line in output.splitlines()))
    else:
        print(f"PASS {name}: exit {result.returncode}")
        if show:
            print("\n".join(f"    | {line}" for line in output.splitlines()))
    return problems


def pinned_version(contracts: Path) -> str | None:
    workflow = contracts.parent / ".github" / "workflows" / "ci.yml"
    try:
        document = yaml.load(workflow.read_text(encoding="utf-8"), Loader=LOADER)  # noqa: S506 - safe loader
        pinned = document["env"]["OASDIFF_VERSION"]
    except (OSError, yaml.YAMLError, KeyError, TypeError):
        return None
    return pinned if isinstance(pinned, str) else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Prove the contract change gate.")
    parser.add_argument("--case", action="append", default=[], help="run only this case")
    parser.add_argument("--list", action="store_true", help="print every case name")
    parser.add_argument(
        "--show-output", action="store_true", help="print the gate output of passing cases too"
    )
    parser.add_argument("--gate", type=Path, default=HERE / "check_contract_change.py")
    parser.add_argument("--contracts", type=Path, default=HERE)
    parser.add_argument("--oasdiff", default=os.environ.get("OASDIFF") or shutil.which("oasdiff"))
    parser.add_argument("--oasdiff-version", default=os.environ.get("OASDIFF_VERSION"))
    arguments = parser.parse_args()
    if arguments.list:
        print("\n".join(CASES))
        return 0
    selected = arguments.case or list(CASES)
    unknown = [name for name in selected if name not in CASES]
    if unknown:
        print(f"FIXTURE: unknown case(s): {', '.join(unknown)}")
        return 2
    if not arguments.oasdiff:
        print("FIXTURE: oasdiff is not on PATH and neither --oasdiff nor OASDIFF names it")
        return 2
    pinned = arguments.oasdiff_version or pinned_version(arguments.contracts)
    if not pinned:
        print("FIXTURE: the pinned oasdiff version is unknown")
        return 2
    if not arguments.gate.is_file():
        print(f"FIXTURE: {arguments.gate} is missing")
        return 2
    severity = arguments.gate.parent / "oasdiff-severity-levels.txt"
    listed = [line.split()[0] for line in severity.read_text(encoding="utf-8").splitlines() if line]
    unowned = sorted(set(listed) - set(OVERRIDE_PAIRS))
    if unowned:
        print(f"FIXTURE: severity override(s) with no case: {', '.join(unowned)}")
        return 2
    failed = ran = 0
    with tempfile.TemporaryDirectory(prefix="contract-change-selftest-") as directory:
        try:
            fixture = Fixture(Path(directory) / "repo", arguments.contracts, severity, pinned)
            for name in selected:
                problems = verify(
                    fixture, arguments.gate, arguments.oasdiff, pinned, name, arguments.show_output
                )
                failed += bool(problems)
                ran += 1
        except FixtureError as error:
            print(f"FIXTURE: {error}")
            return 2
    if ran != len(selected) or ran == 0:
        print(f"FIXTURE: ran {ran} of {len(selected)} selected case(s)")
        return 2
    if failed:
        print(f"contract change self-test FAILED: {failed} of {ran} case(s)")
        return 1
    print(f"contract change self-test passed: {ran} case(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
