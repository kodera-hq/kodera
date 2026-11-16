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
import re
import subprocess
import sys

# Any change to the orchestrator, the plan or the aggregate check runs everything.
SHARED = r"\.github/workflows/ci\.yml$|scripts/ci/ci-plan\.py$|scripts/ci/check-ci-aggregate\.py$"

AREAS: dict[str, str] = {
    "server": r"apps/server/|packages/api-contract/|packages/synapse-policy/|deploy/community/|ee/"
    r"|scripts/ci/check-community-deploy\.py$|scripts/ci/check-publish-images-workflow\.py$"
    r"|\.github/workflows/(ci-server|publish-images)\.yml$|\.nvmrc$",
    "web": r"\.nvmrc$|package\.json$|package-lock\.json$|apps/web/|apps/server/|packages/design-tokens/"
    r"|packages/api-contract/|packages/create-kodera/|packages/extension-sdk/|packages/kodera-rs/vectors/"
    r"|extensions/|\.github/workflows/ci-web\.yml$",
    "rust": r"Cargo\.toml$|Cargo\.lock$|rust-toolchain(\.toml)?$|packages/kodera-rs/|apps/desktop/"
    r"|security/backports/glib-0\.18\.5/|scripts/ci/qualify-glib-iterator\.py$"
    r"|apps/web/tests/wasm/|apps/web/src/features/confidential/(local-state|device-http-record|device-cas-host)\.ts$"
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
        ["git", "diff", "--name-only", base, head], capture_output=True, text=True, check=False
    )
    if diff.returncode != 0:
        return None
    return [line for line in diff.stdout.splitlines() if line]


def selftest() -> None:
    cases: list[tuple[str, list[str] | None, dict[str, bool]]] = [
        ("scaffolder reaches web", ["packages/create-kodera/index.mjs"],
         {"server": False, "web": True, "rust": False, "mobile": False}),
        ("canonical contract reaches server and web", ["packages/api-contract/core-api.openapi.yaml"],
         {"server": True, "web": True, "rust": False, "mobile": False}),
        ("contract checker reaches server and consumer", ["apps/server/contracts/check-contract-change.sh"],
         {"server": True, "web": True, "rust": False, "mobile": False}),
        ("unknown base runs all", None, dict.fromkeys(AREAS, True)),
        ("orchestrator runs all", [".github/workflows/ci.yml"], dict.fromkeys(AREAS, True)),
        ("plan runs all", ["scripts/ci/ci-plan.py"], dict.fromkeys(AREAS, True)),
        ("GLib backport-only change runs Rust", ["security/backports/glib-0.18.5/src/variant_iter.rs"],
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
