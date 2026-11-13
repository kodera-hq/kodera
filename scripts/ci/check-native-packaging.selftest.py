#!/usr/bin/env python3
"""Synthetic package proofs: each named refusal asserts its own diagnostic."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import warnings
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-native-packaging.py")
SPEC = importlib.util.spec_from_file_location("native_packaging", SCRIPT)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
REVISION = "1" * 40


class Fixture:
    def __init__(self, root, target="android-apk"):
        self.first, self.second = root / "first.zip", root / "second.zip"
        self.sbom, self.manifest = root / "sbom.json", root / "evidence.json"
        self.target = target
        self.toolchain = root / "toolchain.json"
        required = (
            {"java", "gradle", "android-gradle-plugin", "kotlin"}
            if target.startswith("android-")
            else {"xcode", "swift", "sdk"}
            if target == "ios-ipa"
            else {"rustc", "cargo", "tauri"}
        )
        self.tools = {
            "schema_version": 1,
            "environment_sha256": "c" * 64,
            "tools": [{"name": name, "version": "1.0.0"} for name in sorted(required)],
        }
        self.bom = {
            "bomFormat": "CycloneDX",
            "specVersion": "1.6",
            "version": 1,
            "metadata": {
                "component": {
                    "type": "application",
                    "name": "Kodera",
                    "version": "fixture",
                    "bom-ref": "application",
                    "licenses": [{"license": {"id": "Apache-2.0"}}],
                    "hashes": [{"alg": "SHA-256", "content": ""}],
                    "properties": [
                        {"name": "kodera:source-revision", "value": REVISION},
                        {"name": "kodera:target", "value": target},
                    ],
                }
            },
            "components": [
                {
                    "type": "library",
                    "name": "synthetic-library",
                    "version": "1.0",
                    "bom-ref": "library",
                    "licenses": [{"license": {"id": "MIT"}}],
                    "hashes": [{"alg": "SHA-256", "content": "a" * 64}],
                }
            ],
            "dependencies": [
                {"ref": "application", "dependsOn": ["library"]},
                {"ref": "library", "dependsOn": []},
            ],
        }
        self.evidence = {
            "schema_version": 1,
            "revision": REVISION,
            "target": target,
            "source_date_epoch": 1_700_000_000,
            "toolchain_sha256": "",
            "sbom_sha256": "",
            "builds": [
                {
                    "invocation_id": "00000000-0000-4000-8000-000000000001",
                    "artifact_sha256": "",
                    "artifact_size": 0,
                },
                {
                    "invocation_id": "00000000-0000-4000-8000-000000000002",
                    "artifact_sha256": "",
                    "artifact_size": 0,
                },
            ],
            "inventory": [
                {
                    "ref": "library",
                    "name": "synthetic-library",
                    "version": "1.0",
                    "sha256": "a" * 64,
                    "license": "MIT",
                }
            ],
        }
        self.toolchain.write_text(json.dumps(self.tools))
        self.evidence["toolchain_sha256"] = hashlib.sha256(self.toolchain.read_bytes()).hexdigest()
        self.packages()

    def packages(self, extra=(), wrong_magic=False):
        for path in (self.first, self.second):
            with warnings.catch_warnings(), zipfile.ZipFile(path, "w") as archive:
                warnings.simplefilter("ignore", UserWarning)
                for name, magic in gate.TARGETS[self.target].items():
                    prefix = b"\xcf\xfa\xed\xfe" if magic == "macho" else magic or b"fixture"
                    if wrong_magic and magic is not None:
                        prefix = b"invalid"
                    archive.writestr(
                        zipfile.ZipInfo(name, (2023, 11, 14, 22, 13, 20)),
                        prefix + b" fixture bytes",
                    )
                for name, value in extra:
                    archive.writestr(name, value)
        self.seal()

    def seal(self):
        hashes = [
            hashlib.sha256(path.read_bytes()).hexdigest() for path in (self.first, self.second)
        ]
        self.bom["metadata"]["component"]["hashes"][0]["content"] = hashes[0]
        for path, record, hashed in zip(
            (self.first, self.second), self.evidence["builds"], hashes, strict=True
        ):
            record["artifact_sha256"], record["artifact_size"] = hashed, path.stat().st_size

    def write(self, bind_sbom=True):
        self.sbom.write_text(json.dumps(self.bom), encoding="utf-8")
        if bind_sbom:
            self.evidence["sbom_sha256"] = hashlib.sha256(self.sbom.read_bytes()).hexdigest()
        self.manifest.write_text(json.dumps(self.evidence), encoding="utf-8")

    def verify(self):
        return gate.verify(
            self.first, self.second, self.sbom, self.manifest, self.toolchain, REVISION, self.target
        )

    def argv(self):
        return [
            "--first",
            str(self.first),
            "--second",
            str(self.second),
            "--sbom",
            str(self.sbom),
            "--evidence",
            str(self.manifest),
            "--toolchain",
            str(self.toolchain),
            "--revision",
            REVISION,
            "--target",
            self.target,
        ]


def field(parent, key, value):
    return lambda f: parent(f).__setitem__(key, value)


def remove_second(f):
    f.second.unlink()
    os.link(f.first, f.second)


def duplicate_json(f):
    f.manifest.write_text('{"schema_version":1,"schema_version":1}')


def invalid_zip(f):
    f.first.write_bytes(b"not a ZIP package")
    f.second.write_bytes(f.first.read_bytes())
    f.seal()
    f.write()


def encrypted_zip(f):
    raw = bytearray(f.first.read_bytes())
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = 0
        while (position := raw.find(signature, start)) >= 0:
            raw[position + offset] |= 1
            start = position + 4
    f.first.write_bytes(raw)
    f.second.write_bytes(raw)
    f.seal()
    f.write()


def damaged_member(f):
    raw = bytearray(f.first.read_bytes())
    with zipfile.ZipFile(f.first) as archive:
        first = archive.infolist()[0]
        offset = first.header_offset + 30 + len(first.filename.encode()) + len(first.extra)
    raw[offset] ^= 1
    f.first.write_bytes(raw)
    f.second.write_bytes(raw)
    f.seal()
    f.write()


def invalid_compression(f):
    raw = bytearray(f.first.read_bytes())
    for signature, offset in ((b"PK\x03\x04", 8), (b"PK\x01\x02", 10)):
        start = 0
        while (position := raw.find(signature, start)) >= 0:
            raw[position + offset] = 8
            start = position + 4
    f.first.write_bytes(raw)
    f.second.write_bytes(raw)
    f.seal()
    f.write()


def symlink_input(f):
    f.first.unlink()
    f.first.symlink_to(f.second)


def symlink_member(f):
    entry = zipfile.ZipInfo("linked-member")
    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
    f.packages([(entry, b"target")])
    f.write()


def missing_member(f):
    for path in (f.first, f.second):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("unrelated", b"fixture")
    f.seal()
    f.write()


def moving_toolchain(f):
    f.tools["tools"][0]["version"] = "stable"
    f.toolchain.write_text(json.dumps(f.tools))


def run():
    passed = 0
    for target in gate.TARGETS:
        with tempfile.TemporaryDirectory(prefix="native-package-proof-") as scratch:
            f = Fixture(Path(scratch), target)
            f.write()
            result = f.verify()
            assert result["reproducible_bytes"] and result["distinct_declared_builds"]
            assert not result["builder_authenticity_verified"] and not result["release_approved"]
            assert result["validation_profile"] == "kodera-native-inventory-v1"
            assert not result["cyclonedx_full_schema_validated"]
            output, error = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(error):
                status = gate.main(f.argv())
            assert (
                status == 0 and json.loads(output.getvalue()) == result and error.getvalue() == ""
            )
            print("  ok accepted structural fixture:", target)
            passed += 1
    cases = [
        (
            "different package bytes",
            lambda f: f.second.write_bytes(f.second.read_bytes() + b"changed"),
            "candidate package bytes are not reproducible",
        ),
        ("same physical package", remove_second, "two distinct physical package files"),
        ("symlink input", symlink_input, "regular file, never a symlink"),
        ("empty package", lambda f: f.first.write_bytes(b""), "nonempty regular file"),
        (
            "revision mismatch",
            field(lambda f: f.evidence, "revision", "2" * 40),
            "evidence revision or target differs",
        ),
        (
            "target mismatch",
            field(lambda f: f.evidence, "target", "ios-ipa"),
            "evidence revision or target differs",
        ),
        (
            "boolean epoch",
            field(lambda f: f.evidence, "source_date_epoch", True),
            "positive SOURCE_DATE_EPOCH",
        ),
        (
            "absent toolchain digest",
            field(lambda f: f.evidence, "toolchain_sha256", ""),
            "pinned toolchain digest",
        ),
        (
            "unknown evidence field",
            field(lambda f: f.evidence, "release_approved", True),
            "fields are incomplete or unknown",
        ),
        (
            "same build invocation",
            field(
                lambda f: f.evidence["builds"][1],
                "invocation_id",
                "00000000-0000-4000-8000-000000000001",
            ),
            "distinct canonical non-nil UUIDs",
        ),
        (
            "wrong artifact hash",
            field(lambda f: f.evidence["builds"][0], "artifact_sha256", "f" * 64),
            "does not bind its package bytes",
        ),
        (
            "boolean artifact size",
            field(lambda f: f.evidence["builds"][0], "artifact_size", True),
            "does not bind its package bytes",
        ),
        ("unsupported SBOM", field(lambda f: f.bom, "specVersion", "1.5"), "CycloneDX JSON 1.6"),
        (
            "boolean SBOM version",
            field(lambda f: f.bom, "version", True),
            "SBOM version must be positive",
        ),
        (
            "wrong subject hash",
            field(lambda f: f.bom["metadata"]["component"]["hashes"][0], "content", "f" * 64),
            "subject hash does not match",
        ),
        (
            "wrong subject revision",
            field(lambda f: f.bom["metadata"]["component"]["properties"][0], "value", "2" * 40),
            "subject revision or target differs",
        ),
        (
            "malformed component type",
            field(lambda f: f.bom["components"][0], "type", []),
            "component type is unsupported",
        ),
        (
            "malformed application name",
            field(lambda f: f.bom["metadata"]["component"], "name", []),
            "subject must identify the Kodera application",
        ),
        (
            "empty components",
            field(lambda f: f.bom, "components", []),
            "dependency inventory must not be empty",
        ),
        (
            "GPL dependency",
            field(
                lambda f: f.bom["components"][0], "licenses", [{"license": {"id": "GPL-3.0-only"}}]
            ),
            "licence is absent, unreviewed or not permissive",
        ),
        (
            "unknown licence",
            field(
                lambda f: f.bom["components"][0],
                "licenses",
                [{"license": {"id": "LicenseRef-Unknown"}}],
            ),
            "licence is absent, unreviewed or not permissive",
        ),
        (
            "invalid SPDX hidden by permissive OR",
            field(
                lambda f: f.bom["components"][0], "licenses", [{"expression": "MIT OR garbage!!!"}]
            ),
            "licence is absent, unreviewed or not permissive",
        ),
        (
            "unreviewed SPDX branch hidden by permissive OR",
            field(
                lambda f: f.bom["components"][0],
                "licenses",
                [{"expression": "MIT OR LicenseRef-unreviewed"}],
            ),
            "licence is absent, unreviewed or not permissive",
        ),
        (
            "missing licence",
            field(lambda f: f.bom["components"][0], "licenses", []),
            "explicit SPDX licence choice",
        ),
        (
            "weak or malformed component hash",
            field(lambda f: f.bom["components"][0]["hashes"][0], "content", "bad"),
            "unambiguous SHA-256",
        ),
        (
            "duplicate component ref",
            lambda f: f.bom["components"].append(f.bom["components"][0].copy()),
            "bom-ref is absent or duplicated",
        ),
        (
            "graph missing component",
            field(
                lambda f: f.bom, "dependencies", [{"ref": "application", "dependsOn": ["library"]}]
            ),
            "graph must cover every component",
        ),
        (
            "unknown graph target",
            field(lambda f: f.bom["dependencies"][0], "dependsOn", ["missing"]),
            "unknown or duplicate targets",
        ),
        (
            "unconnected component",
            field(lambda f: f.bom["dependencies"][0], "dependsOn", []),
            "unconnected components",
        ),
        (
            "inventory omission",
            field(lambda f: f.evidence, "inventory", []),
            "inventory differs from the bound SBOM",
        ),
    ]
    # These mutations rewrite or replace input files after their digests are sealed.
    file_cases = [
        ("duplicate JSON key", duplicate_json, "JSON contains duplicate keys"),
        ("broken ZIP", invalid_zip, "CRC-valid ZIP container"),
        ("CRC mismatch", damaged_member, "CRC-valid ZIP container"),
        ("corrupt compression", invalid_compression, "CRC-valid ZIP container"),
        ("encrypted ZIP", encrypted_zip, "encrypted member"),
        ("archive symlink", symlink_member, "contains a symlink"),
        (
            "archive traversal",
            lambda f: (f.packages([("../outside", b"bad")]), f.write()),
            "unsafe member path",
        ),
        (
            "archive duplicate",
            lambda f: (f.packages([("AndroidManifest.xml", b"duplicate")]), f.write()),
            "case-colliding members",
        ),
        (
            "wrong executable format",
            lambda f: (f.packages(wrong_magic=True), f.write()),
            "wrong binary format",
        ),
        ("missing package member", missing_member, "lacks a required native member"),
        ("moving toolchain alias", moving_toolchain, "exact numeric versions"),
        (
            "unbound toolchain replacement",
            lambda f: f.toolchain.write_bytes(f.toolchain.read_bytes() + b" "),
            "matching pinned toolchain digest",
        ),
        (
            "Windows drive escape",
            lambda f: (f.packages([("C:/outside", b"bad")]), f.write()),
            "unsafe member path",
        ),
        (
            "unbound SBOM replacement",
            lambda f: f.sbom.write_bytes(f.sbom.read_bytes() + b" "),
            "SBOM digest differs",
        ),
    ]
    for cases_group, rewrite in ((cases, True), (file_cases, False)):
        for name, mutate, marker in cases_group:
            with tempfile.TemporaryDirectory(prefix="native-package-refusal-") as scratch:
                f = Fixture(Path(scratch))
                f.write()
                mutate(f)
                if rewrite:
                    f.write()
                try:
                    f.verify()
                except gate.Refused as error:
                    assert marker in str(error), (name, marker, str(error))
                else:
                    raise AssertionError("mutation accepted: " + name)
                output, error = io.StringIO(), io.StringIO()
                with redirect_stdout(output), redirect_stderr(error):
                    status = gate.main(f.argv())
                assert status == 1 and marker in error.getvalue() and output.getvalue() == "", name
                print("  ok refused:", name, "(", marker, ")")
                passed += 1
    for expression in ("MIT", "MIT OR Apache-2.0", "(MIT OR GPL-3.0-only) AND BSD-3-Clause"):
        assert gate.acceptable_license(expression), expression
    for expression in (
        "GPL-3.0-only",
        "MIT AND LGPL-2.1-only",
        "MIT OR",
        "MIT WITH unknown-exception",
        "LicenseRef-Unknown",
        "MIT )",
        "()",
        "MIT AND (Apache-2.0 OR)",
    ):
        assert not gate.acceptable_license(expression), expression
    print(f"native packaging self-test passed: {passed} artifact/CLI cases and 11 SPDX expressions")


if __name__ == "__main__":
    run()
