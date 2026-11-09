#!/usr/bin/env python3
"""Bind two historical public fixture findings without hiding future secret shapes."""

import ast
import hashlib
import json
import os
import re
import string
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path("/tmp/gitleaks")  # noqa: S108 - fixed pinned binary installed by the hosted job
PROBE_ALPHABET = "".join(
    ch for ch in (string.ascii_letters + string.digits) if ch.lower() not in "aeiouy01"
)
ORIGINAL = "586dcd794dc7e50b5de9ac4b230b0b5598fa6d90"
FIXTURE = "tests/test_owner_claim_consume_fixture.py"
LEDGER = ".github/gitleaks-historical-fingerprints.txt"
FALLBACK_LEDGER = "scripts/ci/gitleaks-historical-fingerprints.txt"
EXPECTED = tuple(f"{ORIGINAL}:{FIXTURE}:generic-api-key:{line}" for line in (72, 552))
BLOB_SHA256 = "adbd590fe19c1dfcb7501e6ab11057b097d87e6d89769cd42ebdb9f1ab5b68b3"
CONFIG_SHA256 = "c77766cb9d0178f946241d2e9e9b1dbdd07091f4523763f2ee50038eac1b2b11"
LITERAL_SHA256 = (
    "fef69f550822badc09d14fe8511988e14e65568d8e88c7636855d36c47dbefa5",
    "9e69d3d8d9ca63b43428fb82056bd4e312b67d100efc7b53bc83037d4021c149",
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def command(arguments, root, *, timeout=30, expected=0):
    result = subprocess.run(arguments, cwd=root, capture_output=True, timeout=timeout, check=False)  # noqa: S603 - closed Git and fixed scanner calls; owned fixtures only
    require(result.returncode == expected, "historical command refused")
    require(len(result.stdout) <= 2 * 1024 * 1024, "historical command bounds refused")
    return result.stdout


def git(arguments, root):
    return command(["git", *arguments], root)


def validate_ledger(text):
    require(text == "\n".join(EXPECTED) + "\n", "historical fingerprint ledger refused")
    return EXPECTED


def verify_binding(blob):
    require(hashlib.sha256(blob).hexdigest() == BLOB_SHA256, "historical source blob refused")
    tree = ast.parse(blob)
    request = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "request"
    )
    key = request.args.kw_defaults[1]
    headers = [
        keyword
        for node in ast.walk(request)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
        if keyword.arg == "HTTP_IDEMPOTENCY_KEY"
    ]
    expiry = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "test_actual_scoped_database_clock_expiry_is_single_and_audited"
    )
    expiry_keys = [
        keyword.value
        for node in ast.walk(expiry)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
        if keyword.arg == "HTTP_IDEMPOTENCY_KEY"
    ]
    require(
        request.lineno == 72
        and request.args.kwonlyargs[1].arg == "key"
        and isinstance(key, ast.Constant)
        and type(key.value) is str
        and len(headers) == 1
        and isinstance(headers[0].value, ast.Name)
        and headers[0].value.id == "key"
        and len(expiry_keys) == 1
        and isinstance(expiry_keys[0], ast.Constant)
        and type(expiry_keys[0].value) is str
        and expiry_keys[0].lineno == 552,
        "historical public key binding refused",
    )
    require(
        tuple(
            hashlib.sha256(value.encode()).hexdigest()
            for value in (key.value, expiry_keys[0].value)
        )
        == LITERAL_SHA256,
        "historical public key literal refused",
    )


def check_scope(root):
    require(
        not any(name in os.environ for name in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML")),
        "detector environment override refused",
    )
    require(not os.path.lexists(root / ".gitleaksignore"), "root ignore entry refused")
    ledger_file = root / LEDGER if (root / LEDGER).is_file() else root / FALLBACK_LEDGER
    validate_ledger(ledger_file.read_text())
    require(
        hashlib.sha256((root / ".gitleaks.toml").read_bytes()).hexdigest() == CONFIG_SHA256,
        "historical detector configuration refused",
    )
    require(
        git(["rev-parse", "--is-shallow-repository"], root) == b"false\n",
        "historical complete history refused",
    )
    head = git(["rev-parse", "HEAD"], root).decode().strip()
    history = git(["rev-list", "--full-history", "HEAD"], root).decode().splitlines()
    require(
        re.fullmatch(r"[0-9a-f]{40}", head) is not None
        and history
        and head in history
        and len(set(history)) == len(history)
        and all(re.fullmatch(r"[0-9a-f]{40}", commit) is not None for commit in history),
        "historical complete history refused",
    )
    if ORIGINAL in history:
        verify_binding(git(["show", ORIGINAL + ":" + FIXTURE], root))
        return {"history_mode": "active", "historical_source": "verified"}
    return {"history_mode": "inactive-not-scanned", "historical_source": "not-applicable"}


def commit_probe(root):
    git(["add", FIXTURE], root)
    git(
        [
            "-c",
            "user.name=Fixture acceptance",
            "-c",
            "user.email=fixture@synthetic.invalid",
            "commit",
            "-m",
            "Prove future secret shapes remain detected",
        ],
        root,
    )
    return git(["rev-parse", "HEAD"], root).decode().strip()


def probe_secret(line):
    stride = 7 if line == 72 else 11
    return "".join(
        PROBE_ALPHABET[(index * stride + line) % len(PROBE_ALPHABET)] for index in range(48)
    )


def assert_findings(rows, commit):
    require(isinstance(rows, list) and len(rows) == 2, "future secret findings refused")
    observed = {
        (
            row.get("RuleID"),
            row.get("File"),
            row.get("StartLine"),
            row.get("Commit"),
            row.get("Fingerprint"),
        )
        for row in rows
        if isinstance(row, dict)
    }
    expected = {
        ("generic-api-key", FIXTURE, line, commit, f"{commit}:{FIXTURE}:generic-api-key:{line}")
        for line in (72, 552)
    }
    require(commit != ORIGINAL and observed == expected, "future secret findings refused")


def future_proof(root, *, active):
    with tempfile.TemporaryDirectory(prefix="gitleaks-fingerprint-proof-") as temporary:
        scratch = Path(temporary) / "repository"
        if active:
            git(["clone", "--shared", "--no-checkout", str(root), str(scratch)], root)
            git(["checkout", "-b", "feat/fingerprint-active-probe", "HEAD"], scratch)
        else:
            scratch.mkdir()
            git(["init", "--initial-branch=feat/fingerprint-inactive-probe"], scratch)
        (scratch / LEDGER).parent.mkdir(exist_ok=True)
        (scratch / LEDGER).write_text("\n".join(EXPECTED) + "\n")
        (scratch / ".gitleaks.toml").write_bytes((root / ".gitleaks.toml").read_bytes())
        source = scratch / FIXTURE
        source.parent.mkdir(exist_ok=True)
        lines = source.read_text().splitlines() if active else ["# synthetic scanner fixture"] * 600
        require(len(lines) >= 552, "future secret fixture shape refused")
        if not active:
            source.write_text("\n".join(lines) + "\n")
            commit_probe(scratch)
        scope = check_scope(scratch)
        require((scope["history_mode"] == "active") == active, "future secret history mode refused")
        for line in (72, 552):
            # Deterministic vowel-free probe shape: never collides with gitleaks stopwords
            # and never stores a literal secret in the product repository.
            value = probe_secret(line)
            lines[line - 1] = 'api_key = "' + value + '"'
        source.write_text("\n".join(lines) + "\n")
        commit = commit_probe(scratch)
        report = Path(temporary) / "captured-report.json"
        command(
            [
                str(BINARY),
                "detect",
                "--source",
                str(scratch),
                "--log-opts=--full-history HEAD",
                "--gitleaks-ignore-path",
                str(scratch / LEDGER),
                "--config",
                str(scratch / ".gitleaks.toml"),
                "--redact",
                "--exit-code",
                "1",
                "--report-format",
                "json",
                "--report-path",
                str(report),
            ],
            scratch,
            timeout=90,
            expected=1,
        )
        require(report.is_file() and report.stat().st_size <= 32768, "future secret report refused")
        rows = json.loads(report.read_text())
        assert_findings(rows, commit)
        for added in (rows[0]["Fingerprint"], EXPECTED[0].split(":", 1)[1]):
            try:
                validate_ledger("\n".join((*EXPECTED, added)) + "\n")
            except AssertionError:
                pass
            else:
                raise AssertionError("future secret scope widening accepted")
        root_ignore = scratch / ".gitleaksignore"
        root_ignore.write_text(rows[0]["Fingerprint"] + "\n")
        try:
            check_scope(scratch)
        except AssertionError as error:
            require(str(error) == "root ignore entry refused", "root ignore control refused")
        else:
            raise AssertionError("root ignore control accepted")
    return "passed"


def qualify():
    require(len(sys.argv) == 1, "historical guard arguments refused")
    require(
        command([str(BINARY), "version"], ROOT).decode().strip() == "8.28.0",
        "pinned detector version refused",
    )
    scope = check_scope(ROOT)
    inactive = future_proof(ROOT, active=False)
    active = (
        future_proof(ROOT, active=True) if scope["history_mode"] == "active" else "not-applicable"
    )
    print(
        json.dumps(
            {
                "historical_fingerprint_guard": "passed",
                **scope,
                "inactive_future_secret_probe": inactive,
                "active_future_secret_probe": active,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        qualify()
    except Exception:
        print("historical fingerprint guard refused; captured values withheld", file=sys.stderr)
        raise SystemExit(1) from None
