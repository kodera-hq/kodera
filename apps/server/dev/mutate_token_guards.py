#!/usr/bin/env python3
"""Prove selected refusal guards fail when weakened, in disposable source copies."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = "services/identity/access_tokens.py"
FIXTURE = "dev/identity_fixture.py"
# Each mutation targets a specific assertion, not merely pytest's exit code.
MUTATIONS = [
    (
        "issuer-binding",
        MODULE,
        ['_require(payload.get("iss") == admitted.issuer)', "issuer=admitted.issuer"],
        ["_require(True)", 'issuer=payload["iss"]'],
        "test_signed_invalid_claims_refuse",
    ),
    (
        "audience-binding",
        MODULE,
        ["audience=AUDIENCE", "and AUDIENCE in audience"],
        ['audience=payload["aud"]', "and True"],
        "test_signed_invalid_claims_refuse",
    ),
    (
        "signature",
        MODULE,
        '"require": ["iss", "sub", "aud", "iat", "exp", "typ"]',
        '"verify_signature": False, "require": ["iss", "sub", "aud", "iat", "exp", "typ"]',
        "test_wrong_signature_fails",
    ),
    (
        "duplicate-json",
        MODULE,
        "_require(name not in result)",
        "_require(True)",
        "test_strict_compact_json_refuses and duplicate",
    ),
    (
        "access-type",
        MODULE,
        '_require(payload["typ"] == "Bearer")',
        "_require(True)",
        "test_signed_invalid_claims_refuse",
    ),
    (
        "integer-time",
        MODULE,
        "type(iat) is int and type(exp) is int",
        "isinstance(iat, (int, float)) and isinstance(exp, (int, float))",
        "test_time_coercion_refuses",
    ),
    (
        "snapshot-expiry",
        MODULE,
        "_require(admitted.expires_at > now)",
        "_require(True)",
        "test_expiry_and_explicit_rotation_have_no_hidden_cache",
    ),
    (
        "unique-key-id",
        MODULE,
        "and kid not in seen",
        "and True",
        "test_duplicate_kid_and_bounded_jwks_refuse",
    ),
    (
        "token-size",
        MODULE,
        "MAX_TOKEN = 16 * 1024",
        "MAX_TOKEN = 1024 * 1024",
        "test_strict_compact_json_refuses and oversize",
    ),
    (
        "jwks-size",
        MODULE,
        "MAX_JWKS = 256 * 1024",
        "MAX_JWKS = 1024 * 1024",
        "test_oversized_valid_jwks_refuses",
    ),
    (
        "key-count",
        MODULE,
        "MAX_KEYS = 32",
        "MAX_KEYS = 100",
        "test_duplicate_kid_and_bounded_jwks_refuse",
    ),
    ("key-id-size", MODULE, "{1,128}", "{1,1024}", "test_oversized_matching_key_id_refuses"),
    (
        "encryption-metadata",
        MODULE,
        'and set(operations) <= {"encrypt", "wrapKey"}',
        "and True",
        "test_mixed_jwks_never_selects_encryption_key_or_reclassifies_metadata",
    ),
    (
        "response-size",
        FIXTURE,
        "MAX_RESPONSE = 256 * 1024",
        "MAX_RESPONSE = 1024 * 1024",
        "test_local_jwks_transport_bounds_and_refuses_redirect and oversize",
    ),
    (
        "deadline-interruption",
        FIXTURE,
        "connection_socket.shutdown(socket.SHUT_RDWR)",
        "pass",
        "test_local_jwks_transport_bounds_and_refuses_redirect and slow_body",
    ),
    (
        "pkce-error",
        FIXTURE,
        'and error.get("error") == "invalid_grant"',
        "and True",
        "test_pkce_refusal_requires_precise_closed_provider_error",
    ),
]


def main():
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    }
    results = []
    environment["DJANGO_SETTINGS_MODULE"] = "config.settings.dev"
    with tempfile.TemporaryDirectory(prefix="core-token-mutations-") as temporary:
        for name, path, original, weakened, selection in MUTATIONS:
            target = Path(temporary) / name
            target.mkdir()
            for directory in ("services", "tests", "config", "core", "dev"):
                shutil.copytree(
                    ROOT / directory,
                    target / directory,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
            shutil.copyfile(ROOT / "pyproject.toml", target / "pyproject.toml")
            source = target / path
            text = source.read_text()
            originals = [original] if isinstance(original, str) else original
            replacements = [weakened] if isinstance(weakened, str) else weakened
            for anchor, replacement in zip(originals, replacements, strict=True):
                if text.count(anchor) != 1:
                    raise RuntimeError("Mutation anchor is not unique: " + name)
                text = text.replace(anchor, replacement)
            source.write_text(text)
            test_file = (
                "tests/test_token_fixture.py" if path == FIXTURE else "tests/test_access_tokens.py"
            )
            result = subprocess.run(  # noqa: S603
                [sys.executable, "-m", "pytest", test_file, "-k", selection, "-q", "--tb=short"],
                cwd=target,
                env=environment,
                capture_output=True,
                text=True,
                timeout=45,
            )
            # Do not persist test output or signed fixture material. Publish only
            # the expected assertion category and named-test failure evidence.
            selected_test = selection.split()[0]
            failures = [line for line in result.stdout.splitlines() if line.startswith("FAILED ")]
            selected_only = bool(failures) and all(
                line.startswith("FAILED " + test_file + "::" + selected_test + "[")
                or line.startswith("FAILED " + test_file + "::" + selected_test + " -")
                or line == "FAILED " + test_file + "::" + selected_test
                for line in failures
            )
            # Pytest may omit assertion text from a long summary line. Require
            # that ALL failures name the selected function, then its call report
            # must contain the expected assertion category (never collection errors).
            assertion = (
                "DID NOT RAISE" in result.stdout
                or "slow peer defeated overall deadline" in result.stdout
            )
            intended = result.returncode == 1 and selected_only and assertion
            results.append({"mutation": name, "caught": intended, "pytest_exit": result.returncode})
            print(json.dumps(results[-1]), flush=True)
            if not intended:
                raise RuntimeError("Mutation did not reach its intended assertion: " + name)
    print(f"PASS: {len(results)} selected guard weakenings refused by their counterexamples")


if __name__ == "__main__":
    main()
