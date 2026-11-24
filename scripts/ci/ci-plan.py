#!/usr/bin/env python3
"""Decide which CI areas run for a change, from the paths it touches.

Prints `area=true|false` lines for $GITHUB_OUTPUT. When the base cannot be
resolved (an all-zero `before` on a new branch, a force-push, a shallow clone),
every area runs: a plan that cannot look must not skip.

    python3 scripts/ci/ci-plan.py --base SHA --head SHA
    python3 scripts/ci/ci-plan.py --selftest
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from unittest.mock import patch

# Any change to the orchestrator, the plan or the aggregate check runs everything.
SHARED = (
    r"\.github/workflows/ci\.yml$|scripts/ci/ci-plan\.py$"
    r"|scripts/ci/check-ci-aggregate\.py$|scripts/ci/check-licenses\.py$"
    r"|scripts/ci/check-zero-secret-pr-ci\.py$"
)

AREAS: dict[str, str] = {
    "server": r"apps/server/|packages/api-contract/|packages/synapse-policy/|deploy/community/|ee/"
    r"|scripts/ci/smoke-community-ingress\.py$|scripts/ci/check-community-deploy\.py$|scripts/ci/check-publish-images-workflow\.py$"
    r"|\.github/workflows/(ci-server|publish-images)\.yml$|\.nvmrc$",
    "web": r"\.nvmrc$|package\.json$|package-lock\.json$|apps/web/|apps/server/|packages/design-tokens/"
    r"|packages/api-contract/|packages/create-kodera/|packages/create-kodera-extension/|packages/extension-sdk/|packages/kodera-rs/vectors/"
    r"|extensions/|\.github/workflows/ci-web\.yml$",
    "rust": r"Cargo\.toml$|Cargo\.lock$|rust-toolchain(\.toml)?$|packages/kodera-rs/|apps/desktop/"
    r"|security/|scripts/ci/qualify-glib-iterator\.py$"
    r"|security/cargo-advisory-allowlist\.json$|scripts/ci/check-cargo-advisories\.py$"
    r"|apps/web/tests/wasm/|apps/web/src/features/confidential/local-state\.ts$"
    r"|apps/web/src/features/confidential/(?:native/|(?:device-http-record|device-cas-host|device-worker-protocol|device-worker-client|device\.worker)\.ts$)"
    r"|apps/web/native-generated/|apps/web/scripts/check-native-generated(\.selftest)?\.mjs$"
    r"|apps/web/tests/worker-device/"
    r"|scripts/ci/build-wasm-browser-proof(-selftest)?\.py$|package(-lock)?\.json$|apps/web/package\.json$"
    r"|scripts/ci/(check-release-workflow\.py|assemble-release-sbom\.py|package-desktop-release\.mjs)$"
    r"|\.nvmrc$|\.github/workflows/(ci-rust-desktop|release-binaries)\.yml$",
    "mobile": r"apps/ios/|apps/android/|packages/kodera-rs/|packages/design-tokens/"
    r"|scripts/ci/(check-native-tokens|check-release-workflow|package-android-release|assemble-release-sbom)\.py$"
    r"|scripts/ci/export-android-runtime\.init\.gradle\.kts$"
    r"|\.github/workflows/(ci-mobile|release-binaries)\.yml$",
}


def plan(paths: list[str] | None) -> dict[str, bool]:
    if paths is None:
        return {area: True for area in AREAS}
    shared = re.compile(f"^(?:{SHARED})")
    if any(shared.match(p) for p in paths):
        return {area: True for area in AREAS}
    return {
        area: any(re.match(f"^(?:{pattern})", p) for p in paths) for area, pattern in AREAS.items()
    }


def changed_paths(base: str, head: str) -> list[str] | None:
    if not base or set(base) == {"0"}:
        return None
    for ref in (base, head):
        probe = subprocess.run(
            ["git", "cat-file", "-e", f"{ref}^{{commit}}"], capture_output=True, check=False
        )
        if probe.returncode != 0:
            return None
    diff = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, head], capture_output=True, check=False
    )
    if diff.returncode != 0:
        return None
    return [os.fsdecode(path) for path in diff.stdout.split(b"\0") if path]


def selftest() -> None:
    # Exercise Git's actual quoting defaults, including deletes, tabs, newlines and Unicode.
    with tempfile.TemporaryDirectory() as folder:
        def git(*args):
            return subprocess.run(["git", "-C", folder, *args], check=True, capture_output=True).stdout
        git("init", "-q", "--initial-branch=fix/path-fixture")
        names = ["apps/server/migrations/0099_é\t\n.py", "apps/web/é.ts",
                 "packages/kodera-rs/é.rs", "apps/ios/é.swift", "apps/android/é.kt"]
        for name in names:
            path = os.path.join(folder, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as stream:
                stream.write(b"before")
        git("add", "--all")
        git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture")
        base = git("rev-parse", "HEAD").decode().strip()
        os.unlink(os.path.join(folder, names[0]))
        for name in names[1:]:
            with open(os.path.join(folder, name), "wb") as stream:
                stream.write(b"after")
        added = "apps/server/migrations/0100_新.py"
        with open(os.path.join(folder, added), "wb") as stream:
            stream.write(b"added")
        git("add", "--all")
        git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "change")
        head = git("rev-parse", "HEAD").decode().strip()
        original_run = subprocess.run
        with patch.object(subprocess, "run", side_effect=lambda args, **kw: original_run(
            ["git", "-C", folder, *args[1:]], **kw
        )):
            paths = changed_paths(base, head)
        if paths is None or set(paths) != set(names + [added]):
            raise SystemExit(f"ci-plan path fixture failed: {paths!r}")
        if not all(plan(paths).values()):
            raise SystemExit("ci-plan missed an area")
        if not plan([names[0]])["server"]:
            raise SystemExit("ci-plan missed deleted server file")

    with tempfile.TemporaryDirectory() as folder:
        def git(*args):
            return subprocess.run(["git", "-C", folder, *args], check=True, capture_output=True).stdout
        git("init", "-q", "--initial-branch=fix/rename-fixture")
        source = "apps/server/migrations/0099_move.py"
        destination = "notes/moved.py"
        os.makedirs(os.path.join(folder, "apps/server/migrations"))
        os.makedirs(os.path.join(folder, "notes"))
        with open(os.path.join(folder, source), "w") as stream:
            stream.write("migration fixture")
        def commit(message):
            git("add", "--all")
            git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                "commit", "-qm", message)
            return git("rev-parse", "HEAD").decode().strip()
        base = commit("source")
        git("mv", source, destination)
        head = commit("move")
        original_run = subprocess.run
        with patch.object(subprocess, "run", side_effect=lambda args, **kw: original_run(
            ["git", "-C", folder, *args[1:]], **kw
        )):
            paths = changed_paths(base, head)
        if paths is None or set(paths) != {source, destination}:
            raise SystemExit(f"ci-plan rename fixture failed: {paths!r}")
        if not plan(paths)["server"]:
            raise SystemExit("cross-area rename skipped source checks")

    raw = b"apps/server/migrations/invalid-\xff.py"
    with patch.object(subprocess, "run", side_effect=[
        subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
        subprocess.CompletedProcess([], 0, stdout=raw + b"\0"),
    ]):
        paths = changed_paths("base", "head")
    if not paths or os.fsencode(paths[0]) != raw or not plan(paths)["server"]:
        raise SystemExit("ci-plan raw path fixture failed")

    cases: list[tuple[str, list[str] | None, dict[str, bool]]] = [
        ("ingress smoke reaches server", ["scripts/ci/smoke-community-ingress.py"],
         {"server": True, "web": False, "rust": False, "mobile": False}),
        ("scaffolder reaches web", ["packages/create-kodera/index.mjs"],
         {"server": False, "web": True, "rust": False, "mobile": False}),
        ("extension scaffolder reaches web", ["packages/create-kodera-extension/src/cli.ts"],
         {"server": False, "web": True, "rust": False, "mobile": False}),
        ("canonical contract reaches server and web", ["packages/api-contract/core-api.openapi.yaml"],
         {"server": True, "web": True, "rust": False, "mobile": False}),
        ("contract checker reaches server and consumer", ["apps/server/contracts/check-contract-change.sh"],
         {"server": True, "web": True, "rust": False, "mobile": False}),
        ("unknown base runs all", None, dict.fromkeys(AREAS, True)),
        ("orchestrator runs all", [".github/workflows/ci.yml"], dict.fromkeys(AREAS, True)),
        ("plan runs all", ["scripts/ci/ci-plan.py"], dict.fromkeys(AREAS, True)),
        ("license checker runs all", ["scripts/ci/check-licenses.py"], dict.fromkeys(AREAS, True)),
        ("Cargo advisory checker runs Rust", ["scripts/ci/check-cargo-advisories.py"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("Cargo advisory allowlist runs Rust", ["security/cargo-advisory-allowlist.json"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("EE tree runs server", ["ee/billing/api.py"],
         {"server": True, "web": False, "rust": False, "mobile": False}),
        ("GLib backport-only change runs Rust", ["security/backports/glib-0.18.5/src/variant_iter.rs"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("new security backport runs Rust", ["security/backports/future-crate/verify.py"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("GLib qualifier-only change runs Rust", ["scripts/ci/qualify-glib-iterator.py"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("generated browser fixture reaches web and Rust", ["apps/web/tests/wasm/fixtures/host-adapter.mjs"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("generated build owner reaches Rust", ["scripts/ci/build-wasm-browser-proof.py"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("generated owner tests reach Rust", ["scripts/ci/build-wasm-browser-proof-selftest.py"],
         {"server": False, "web": False, "rust": True, "mobile": False}),
        ("real device store reaches the generated consumer", ["apps/web/src/features/confidential/local-state.ts"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("device HTTP record codec reaches the generated consumer", ["apps/web/src/features/confidential/device-http-record.ts"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("device CAS host reaches the generated consumer", ["apps/web/src/features/confidential/device-cas-host.ts"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("unrelated confidential spec does not run Rust", ["apps/web/src/features/confidential/device-http.spec.md"],
         {"server": False, "web": True, "rust": False, "mobile": False}),
        ("shared Rust vectors reach web, Rust and mobile", ["packages/kodera-rs/vectors/device-http-v1.json"],
         {"server": False, "web": True, "rust": True, "mobile": True}),
        ("browser dependency lock reaches the generated consumer", ["package-lock.json"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("browser workspace metadata reaches the generated consumer", ["apps/web/package.json"],
         {"server": False, "web": True, "rust": True, "mobile": False}),
        ("lookalike fixture path does not run Rust", ["apps/web/tests/wasm-other/file.mjs"],
         {"server": False, "web": True, "rust": False, "mobile": False}),
        ("docs only runs none", ["README.md", "docs/x.md"], dict.fromkeys(AREAS, False)),
        (
            "web only",
            ["apps/web/src/main.tsx"],
            {"server": False, "web": True, "rust": False, "mobile": False},
        ),
        (
            "server touches web (contract consumer)",
            ["apps/server/core/models.py"],
            {"server": True, "web": True, "rust": False, "mobile": False},
        ),
        (
            "rust core touches desktop and mobile",
            ["packages/kodera-rs/src/lib.rs"],
            {"server": False, "web": False, "rust": True, "mobile": True},
        ),
        (
            "ios only",
            ["apps/ios/App/KoderaApp.swift"],
            {"server": False, "web": False, "rust": False, "mobile": True},
        ),
        (
            "tokens reach web and mobile",
            ["packages/design-tokens/tokens.json"],
            {"server": False, "web": True, "rust": False, "mobile": True},
        ),
        (
            "release workflow reaches rust and mobile",
            [".github/workflows/release-binaries.yml"],
            {"server": False, "web": False, "rust": True, "mobile": True},
        ),
        (
            "a lookalike prefix does not match",
            ["apps/webhooks/x", "apps/serverless/y"],
            dict.fromkeys(AREAS, False),
        ),
    ]
    # These changed paths include deletion-only changes: absent generated inputs
    # still require verification rather than making the qualification disappear.
    for path in [
        "security/backports/openmls_basic_credential-0.6.0/src/lib.rs",
        "security/backports/openmls_rust_crypto-0.6.0/src/lib.rs",
    ]:
        cases.append((f"native backport reaches Rust: {path}", [path],
                      {"server": False, "web": False, "rust": True, "mobile": False}))
    for path in [
        "apps/web/src/features/confidential/native/kodera_rs_bg.wasm",
        "apps/web/src/features/confidential/native/snippets/kodera-rs-0123/inline0.js",
        "apps/web/native-generated/manifest.json",
        "apps/web/native-generated/provenance/result.json",
        "apps/web/scripts/check-native-generated.mjs",
        "apps/web/scripts/check-native-generated.selftest.mjs",
        "apps/web/src/features/confidential/device-http-record.ts",
        "apps/web/src/features/confidential/device-cas-host.ts",
        "apps/web/src/features/confidential/device-worker-protocol.ts",
        "apps/web/src/features/confidential/device-worker-client.ts",
        "apps/web/src/features/confidential/device.worker.ts",
        "apps/web/tests/worker-device/client.ts",
    ]:
        cases.append((f"checked native consumer reaches web and Rust: {path}", [path],
                      {"server": False, "web": True, "rust": True, "mobile": False}))
    for path in [
        "apps/web/src/features/confidential/native-other/file.js",
        "apps/web/native-generated-other/manifest.json",
        "apps/web/scripts/check-native-generated-other.mjs",
        "apps/web/src/features/confidential/device.worker.ts.backup",
        "apps/web/tests/worker-device-other/client.ts",
    ]:
        cases.append((f"native consumer lookalike stays web only: {path}", [path],
                      {"server": False, "web": True, "rust": False, "mobile": False}))
    failures = [name for name, paths, want in cases if plan(paths) != want]
    if changed_paths("0" * 40, "HEAD") is not None:
        failures.append("an all-zero base must be unknown")
    if changed_paths("", "HEAD") is not None:
        failures.append("an empty base must be unknown")
    if changed_paths("deadbeef" * 5, "HEAD") is not None:
        failures.append("an unresolvable base must be unknown")
    if failures:
        sys.exit("ci-plan selftest FAILED: " + "; ".join(failures))
    print(f"OK: ci-plan selftest, {len(cases) + 3} cases")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    for area, run in plan(changed_paths(args.base, args.head)).items():
        print(f"{area}={'true' if run else 'false'}")


if __name__ == "__main__":
    main()
