#!/usr/bin/env python3
"""Verify paired unsigned native packages, bound build evidence and a CycloneDX inventory.

This checks supplied bytes and declarations, not builder authenticity, device
acceptance, signing, notarisation, store approval or permission to release.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import struct
import sys
import uuid
import zipfile
import zlib
from contextlib import ExitStack
from pathlib import Path, PurePosixPath

MAX_JSON = 16 * 1024 * 1024
MAX_PACKAGE = 1024 * 1024 * 1024
MAX_EXPANDED = 2 * MAX_PACKAGE
HEX = re.compile(r"[0-9a-f]{64}\Z")
REVISION = re.compile(r"[0-9a-f]{40}\Z")
PERMISSIVE = frozenset(
    {
        "Apache-2.0",
        "MIT",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "0BSD",
        "Zlib",
        "BSL-1.0",
        "CC0-1.0",
        "Unlicense",
    }
)
# Recognised alternatives remain non-admitted unless an OR branch supplies a
# reviewed permissive choice. Unknown IDs cannot hide behind an admitted branch.
KNOWN_NONPERMISSIVE = frozenset(
    {
        "GPL-2.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0-only",
        "GPL-3.0-or-later",
        "LGPL-2.0-only",
        "LGPL-2.0-or-later",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "AGPL-3.0-only",
        "AGPL-3.0-or-later",
    }
)
TARGETS = {
    "android-apk": {"AndroidManifest.xml": None, "classes.dex": b"dex\n"},
    "android-aab": {
        "BundleConfig.pb": None,
        "base/manifest/AndroidManifest.xml": None,
        "base/dex/classes.dex": b"dex\n",
    },
    "ios-ipa": {"Payload/Kodera.app/Info.plist": None, "Payload/Kodera.app/Kodera": "macho"},
    "desktop-macos": {
        "Kodera.app/Contents/Info.plist": None,
        "Kodera.app/Contents/MacOS/kodera": "macho",
    },
    "desktop-windows": {"kodera.exe": b"MZ"},
    "desktop-linux": {"kodera": b"\x7fELF"},
}
MACHO = (
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
)


class Refused(Exception):
    """A required packaging invariant has not been established."""


def need(condition, message):
    if not condition:
        raise Refused(message)


def text(value, maximum=512):
    return isinstance(value, str) and 0 < len(value) <= maximum and all(ord(c) >= 32 for c in value)


def sha(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def digest(handle):
    handle.seek(0)
    hashed = hashlib.sha256()
    total = 0
    while chunk := handle.read(1024 * 1024):
        total += len(chunk)
        need(total <= MAX_PACKAGE, "native package exceeded its size limit during verification")
        hashed.update(chunk)
    return hashed.hexdigest()


def regular(path, maximum):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        handle = os.fdopen(descriptor, "rb")
        info = os.fstat(handle.fileno())
    except OSError as error:
        raise Refused("input must be a readable regular file, never a symlink") from error
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
        handle.close()
        raise Refused("input must be a nonempty regular file within its size limit")
    return handle


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, "JSON contains duplicate keys")
        result[key] = value
    return result


def document(path):
    with regular(path, MAX_JSON) as handle:
        raw = handle.read(MAX_JSON + 1)
    need(len(raw) <= MAX_JSON, "JSON exceeds its size limit")
    try:
        result = json.loads(
            raw,
            object_pairs_hook=unique_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(Refused("nonfinite JSON number")),
        )
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Refused("input is not bounded UTF-8 JSON") from error
    need(isinstance(result, dict), "JSON document must be an object")
    return result, hashlib.sha256(raw).hexdigest()


def acceptable_license(expression):
    if not text(expression) or len(expression) > 512:
        return False
    tokens = re.findall(r"\(|\)|[^\s()]+", expression)
    if len(tokens) > 128:
        return False
    index = 0

    def primary(depth):
        nonlocal index
        if depth > 16 or index == len(tokens):
            raise ValueError
        token = tokens[index]
        index += 1
        if token == "(":
            result = either(depth + 1)
            if index == len(tokens) or tokens[index] != ")":
                raise ValueError
            index += 1
            return result
        if token in {"AND", "OR", "WITH", ")"}:
            raise ValueError
        if token not in PERMISSIVE and token not in KNOWN_NONPERMISSIVE:
            raise ValueError
        return token in PERMISSIVE

    def both(depth):
        nonlocal index
        result = primary(depth)
        while index < len(tokens) and tokens[index] == "AND":
            index += 1
            right = primary(depth)
            result = result and right
        return result

    def either(depth):
        nonlocal index
        result = both(depth)
        while index < len(tokens) and tokens[index] == "OR":
            index += 1
            right = both(depth)
            result = result or right
        return result

    try:
        result = either(0)
        return index == len(tokens) and result
    except ValueError:
        return False


def hash_field(component):
    hashes = component.get("hashes")
    need(isinstance(hashes, list), "SBOM component requires hashes")
    values = [
        item.get("content")
        for item in hashes
        if isinstance(item, dict) and item.get("alg") == "SHA-256"
    ]
    need(len(values) == 1 and sha(values[0]), "SBOM requires one unambiguous SHA-256 per component")
    return values[0]


def license_field(component):
    choices = component.get("licenses")
    need(
        isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict),
        "SBOM component requires one explicit SPDX licence choice",
    )
    choice = choices[0]
    if set(choice) == {"expression"}:
        expression = choice["expression"]
    elif (
        set(choice) == {"license"}
        and isinstance(choice["license"], dict)
        and set(choice["license"]) == {"id"}
    ):
        expression = choice["license"].get("id")
    else:
        expression = None
    need(acceptable_license(expression), "SBOM licence is absent, unreviewed or not permissive")
    return expression


def package_structure(handle, target):
    try:
        with zipfile.ZipFile(handle) as archive:
            entries = archive.infolist()
            need(0 < len(entries) <= 50_000, "package member count is outside its bound")
            total = 0
            names = set()
            content = {}
            for entry in entries:
                name = entry.filename
                parts = name.rstrip("/").split("/")
                need(
                    not PurePosixPath(name).is_absolute()
                    and "\\" not in name
                    and all(part not in {"", ".", ".."} for part in parts)
                    and ":" not in parts[0]
                    and entry.orig_filename == name
                    and all(ord(c) >= 32 for c in name),
                    "package contains an unsafe member path",
                )
                need(
                    name.casefold() not in names,
                    "package contains duplicate or case-colliding members",
                )
                names.add(name.casefold())
                need(not stat.S_ISLNK(entry.external_attr >> 16), "package contains a symlink")
                need(not entry.flag_bits & 1, "package contains an encrypted member")
                total += entry.file_size
                need(
                    entry.file_size <= MAX_PACKAGE and total <= MAX_EXPANDED,
                    "package expansion exceeds its bound",
                )
                if entry.is_dir():
                    continue
                with archive.open(entry) as source:
                    prefix = source.read(8)
                    while source.read(1024 * 1024):
                        pass  # Read to EOF so the ZIP CRC is checked without extraction.
                content[name] = prefix
            for name, magic in TARGETS[target].items():
                need(name in content and content[name], "package lacks a required native member")
                prefix = content[name]
                need(
                    magic is None
                    or (prefix[:4] in MACHO if magic == "macho" else prefix.startswith(magic)),
                    "package native member has the wrong binary format",
                )
    except (
        zipfile.BadZipFile,
        RuntimeError,
        EOFError,
        NotImplementedError,
        OSError,
        UnicodeError,
        ValueError,
        struct.error,
        zlib.error,
    ) as error:
        raise Refused("package is not a readable, CRC-valid ZIP container") from error


def inventory(bom, expected_hash, revision, target):
    need(
        bom.get("bomFormat") == "CycloneDX" and bom.get("specVersion") == "1.6",
        "SBOM must use CycloneDX JSON 1.6",
    )
    need(type(bom.get("version")) is int and bom["version"] > 0, "SBOM version must be positive")
    metadata = bom.get("metadata")
    need(
        isinstance(metadata, dict) and isinstance(metadata.get("component"), dict),
        "SBOM subject is missing",
    )
    subject = metadata["component"]
    need(
        subject.get("type") == "application"
        and isinstance(subject.get("name"), str)
        and subject["name"] in {"Kodera", "kodera"},
        "SBOM subject must identify the Kodera application",
    )
    need(
        hash_field(subject) == expected_hash, "SBOM subject hash does not match the native package"
    )
    need(
        license_field(subject) == "Apache-2.0", "native application subject must declare Apache-2.0"
    )
    properties = subject.get("properties")
    need(
        isinstance(properties, list) and all(isinstance(p, dict) for p in properties),
        "SBOM subject properties are missing",
    )
    values = {}
    for prop in properties:
        name = prop.get("name")
        need(text(name) and name not in values, "SBOM subject properties are ambiguous")
        values[name] = prop.get("value")
    need(
        values.get("kodera:source-revision") == revision and values.get("kodera:target") == target,
        "SBOM subject revision or target differs from the expected package",
    )
    subject_ref = subject.get("bom-ref")
    need(text(subject_ref), "SBOM subject requires a bom-ref")
    result = {}

    def walk(components, depth=0):
        need(isinstance(components, list) and depth <= 16, "SBOM component nesting is invalid")
        for component in components:
            need(isinstance(component, dict), "SBOM component must be an object")
            need(
                isinstance(component.get("type"), str)
                and component["type"]
                in {"application", "framework", "library", "file", "platform", "operating-system"},
                "SBOM component type is unsupported for native packages",
            )
            ref = component.get("bom-ref")
            need(
                text(ref) and ref != subject_ref and ref not in result,
                "SBOM bom-ref is absent or duplicated",
            )
            need(
                text(component.get("name")) and text(component.get("version")),
                "SBOM component identity is incomplete",
            )
            result[ref] = {
                "ref": ref,
                "name": component["name"],
                "version": component["version"],
                "sha256": hash_field(component),
                "license": license_field(component),
            }
            need(len(result) <= 50_000, "SBOM component count exceeds its bound")
            if "components" in component:
                walk(component["components"], depth + 1)

    walk(bom.get("components"))
    need(result, "SBOM dependency inventory must not be empty")
    known = {subject_ref, *result}
    graph = {}
    dependencies = bom.get("dependencies")
    need(isinstance(dependencies, list), "SBOM dependency graph is missing")
    for row in dependencies:
        need(isinstance(row, dict), "SBOM dependency graph row must be an object")
        ref, targets = row.get("ref"), row.get("dependsOn")
        need(
            isinstance(ref, str) and ref in known and ref not in graph,
            "SBOM dependency graph ref is unknown or duplicated",
        )
        need(
            isinstance(targets, list)
            and all(isinstance(t, str) and t in known for t in targets)
            and len(set(targets)) == len(targets),
            "SBOM dependency graph has unknown or duplicate targets",
        )
        graph[ref] = targets
    need(set(graph) == known, "SBOM dependency graph must cover every component")
    pending, reached = [subject_ref], set()
    while pending:
        ref = pending.pop()
        if ref not in reached:
            reached.add(ref)
            pending.extend(graph[ref])
    need(reached == known, "SBOM dependency graph contains unconnected components")
    return [result[key] for key in sorted(result)]


def verify(first, second, sbom, evidence, toolchain, revision, target):
    need(
        isinstance(revision, str) and REVISION.fullmatch(revision),
        "expected revision must be a full commit SHA",
    )
    need(target in TARGETS, "unsupported native package target")
    bom, bom_hash = document(sbom)
    record, _ = document(evidence)
    tools, tools_hash = document(toolchain)
    need(
        set(tools) == {"schema_version", "environment_sha256", "tools"}
        and type(tools["schema_version"]) is int
        and tools["schema_version"] == 1
        and sha(tools["environment_sha256"]),
        "toolchain requires a versioned pinned environment",
    )
    versions = tools["tools"]
    need(isinstance(versions, list) and versions, "toolchain version inventory is missing")
    names = set()
    for tool in versions:
        need(
            isinstance(tool, dict)
            and set(tool) == {"name", "version"}
            and isinstance(tool["name"], str)
            and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,63}", tool["name"])
            and tool["name"] not in names
            and isinstance(tool["version"], str)
            and re.fullmatch(r"[0-9][0-9A-Za-z.+_-]{0,127}", tool["version"]),
            "toolchain tools require distinct names and exact numeric versions",
        )
        names.add(tool["name"])
    required = (
        {"java", "gradle", "android-gradle-plugin", "kotlin"}
        if target.startswith("android-")
        else {"xcode", "swift", "sdk"}
        if target == "ios-ipa"
        else {"rustc", "cargo", "tauri"}
    )
    need(required <= names, "toolchain inventory omits a required native build tool")
    need(
        set(record)
        == {
            "schema_version",
            "revision",
            "target",
            "source_date_epoch",
            "toolchain_sha256",
            "sbom_sha256",
            "builds",
            "inventory",
        },
        "build evidence fields are incomplete or unknown",
    )
    need(
        type(record["schema_version"]) is int and record["schema_version"] == 1,
        "unsupported build evidence version",
    )
    need(
        record["revision"] == revision and record["target"] == target,
        "build evidence revision or target differs",
    )
    need(
        type(record["source_date_epoch"]) is int and 0 < record["source_date_epoch"] < 2**63,
        "build evidence requires a positive SOURCE_DATE_EPOCH",
    )
    need(
        sha(record["toolchain_sha256"]) and record["toolchain_sha256"] == tools_hash,
        "build evidence requires the matching pinned toolchain digest",
    )
    need(record["sbom_sha256"] == bom_hash, "build evidence SBOM digest differs")
    builds = record["builds"]
    need(
        isinstance(builds, list) and len(builds) == 2,
        "build evidence requires exactly two build records",
    )
    ids = set()
    with ExitStack() as stack:
        handles = [stack.enter_context(regular(path, MAX_PACKAGE)) for path in (first, second)]
        infos = [os.fstat(handle.fileno()) for handle in handles]
        need(
            (infos[0].st_dev, infos[0].st_ino) != (infos[1].st_dev, infos[1].st_ino),
            "two distinct physical package files are required",
        )
        hashes = [digest(handle) for handle in handles]
        need(hashes[0] == hashes[1], "paired candidate package bytes are not reproducible")
        for build, handle, info, hashed in zip(builds, handles, infos, hashes, strict=True):
            need(
                isinstance(build, dict)
                and set(build) == {"invocation_id", "artifact_sha256", "artifact_size"},
                "build record fields are incomplete or unknown",
            )
            identity = build["invocation_id"]
            try:
                parsed = uuid.UUID(identity) if isinstance(identity, str) else None
            except ValueError:
                parsed = None
            need(
                parsed is not None
                and parsed.int != 0
                and str(parsed) == identity
                and identity not in ids,
                "build invocation IDs must be distinct canonical non-nil UUIDs",
            )
            ids.add(identity)
            need(
                build["artifact_sha256"] == hashed
                and type(build["artifact_size"]) is int
                and build["artifact_size"] == info.st_size,
                "build record does not bind its package bytes",
            )
            handle.seek(0)
            package_structure(handle, target)
        components = inventory(bom, hashes[0], revision, target)
        need(
            record["inventory"] == components,
            "build inventory differs from the bound SBOM components",
        )
        need(
            all(digest(handle) == hashed for handle, hashed in zip(handles, hashes, strict=True)),
            "native package changed during verification",
        )
    return {
        "schema_version": 1,
        "validation_profile": "kodera-native-inventory-v1",
        "cyclonedx_full_schema_validated": False,
        "revision": revision,
        "target": target,
        "artifact_sha256": hashes[0],
        "sbom_sha256": bom_hash,
        "components": len(components),
        "reproducible_bytes": True,
        "distinct_declared_builds": True,
        "builder_authenticity_verified": False,
        "release_approved": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ("first", "second", "sbom", "evidence", "toolchain"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args(argv)
    try:
        result = verify(
            args.first,
            args.second,
            args.sbom,
            args.evidence,
            args.toolchain,
            args.revision,
            args.target,
        )
    except Refused as error:
        print(f"native packaging refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
