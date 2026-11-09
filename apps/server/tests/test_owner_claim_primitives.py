"""Owner claim primitive behavior, with no database or provider access."""

import base64
import importlib.util
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
from io import StringIO
from pathlib import Path

CANDIDATE = Path(__file__).resolve().parents[1]


def proposed_module(name):
    path = CANDIDATE / "apps/orgs" / (name + ".py")
    assert path.is_file(), "specified K8a service is missing: " + name
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader, "specified K8a service cannot load"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Primitives(unittest.TestCase):
    def test_owner_approved_expiry_preserves_terminal_states(self):
        # The served selector's pure state decision is shared by its database-backed
        # expiry path; real row/audit/clock integration stays in lifecycle acceptance.
        path = CANDIDATE / "apps/orgs/claim_readiness.py"
        self.assertTrue(path.is_file(), "specified K8a issued-only expiry selector is missing")
        python = Path(sys.executable)
        code = """import django
from datetime import datetime, timedelta, timezone
django.setup()
from apps.orgs.claim_readiness import expiry_transition_for
expires = datetime(2000, 1, 1, tzinfo=timezone.utc)
for state in ('consumed', 'revoked', 'expired'):
    for now in (expires - timedelta(seconds=1), expires, expires + timedelta(seconds=1)):
        assert expiry_transition_for(state, expires_at=expires, now=now) == state
assert expiry_transition_for('issued', expires_at=expires, now=expires - timedelta(microseconds=1)) == 'issued'
assert expiry_transition_for('issued', expires_at=expires, now=expires) == 'expired'
assert expiry_transition_for('issued', expires_at=expires, now=expires + timedelta(seconds=1)) == 'expired'
"""
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "PYTHONPATH": os.pathsep.join(
                filter(None, (str(CANDIDATE), os.environ.get("K8_DEPENDENCY_TARGET")))
            ),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.e2e_operator",
        }
        result = subprocess.run(  # noqa: S603 — fixed interpreter and literal credential-free probe
            [str(python), "-c", code],
            cwd=CANDIDATE,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(
            result.returncode, 0, "ratified issued-only expiry and terminal-state history must hold"
        )
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_contact_comparison_preserves_local_part_and_folds_domain(self):
        contact = proposed_module("claim_contact")
        self.assertEqual(
            contact.normalise_contact("  First.Owner@CUSTOMER.Test \n"), "First.Owner@customer.test"
        )
        self.assertNotEqual(
            contact.normalise_contact("first.owner@customer.test"),
            contact.normalise_contact("First.Owner@customer.test"),
        )
        output = StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            for invalid in ("", "plain", "a@b@customer.test", "a\n@customer.test"):
                with self.assertRaises(contact.ContactRefusedError):
                    contact.normalise_contact(invalid)
        self.assertEqual(output.getvalue(), "")

    def test_configurable_lifetime_has_finite_validated_default_and_maximum(self):
        configuration = proposed_module("claim_configuration")
        self.assertEqual(configuration.claim_lifetime({}), timedelta(hours=72))
        self.assertEqual(
            configuration.claim_lifetime({"KODERA_OWNER_CLAIM_LIFETIME_SECONDS": "86400"}),
            timedelta(days=1),
        )
        self.assertEqual(
            configuration.claim_lifetime({"KODERA_OWNER_CLAIM_LIFETIME_SECONDS": "604800"}),
            timedelta(days=7),
        )
        for invalid in ("0", "-1", "604801", "not-an-integer", "1.0"):
            with self.assertRaises(configuration.ClaimConfigurationError):
                configuration.claim_lifetime({"KODERA_OWNER_CLAIM_LIFETIME_SECONDS": invalid})

    def test_claim_link_is_optional_until_explicit_issuance_validation(self):
        # Merely loading this module with no claim inputs must remain safe for K7/sweep profiles.
        configuration = proposed_module("claim_configuration")
        with self.assertRaises(configuration.ClaimConfigurationError):
            configuration.claim_link({}, frozenset({"https://app.localhost"}))
        link = {"KODERA_OWNER_CLAIM_LINK": "https://app.localhost/claim"}
        self.assertEqual(
            configuration.claim_link(link, frozenset({"https://app.localhost"})),
            link["KODERA_OWNER_CLAIM_LINK"],
        )
        for origins in (frozenset(), frozenset({"https://different.localhost"})):
            with self.assertRaises(configuration.ClaimConfigurationError):
                configuration.claim_link(link, origins)
        for invalid in (
            "",
            "/claim",
            "https://app.localhost/claim#secret",
            "https://user:password@app.localhost/claim",
        ):
            with self.assertRaises(configuration.ClaimConfigurationError):
                configuration.claim_link(
                    {"KODERA_OWNER_CLAIM_LINK": invalid}, frozenset({"https://app.localhost"})
                )

    def test_existing_operator_and_sweep_start_without_claim_only_inputs(self):
        python = Path(sys.executable)
        self.assertTrue(python.is_file(), "specified project interpreter is missing")
        code = """import django
from django.core.management import get_commands, load_command_class
django.setup()
for name in ('start_realm_bootstrap', 'complete_realm_bootstrap', 'requeue_realm_bootstrap', 'sweep_jobs'):
    command = load_command_class(get_commands()[name], name)
    command.create_parser('manage.py', name)
"""
        for profile in ("config.settings.job_queue", "config.settings.e2e_operator"):
            # No host credentials, link, lifetime, trust, seal key or database connection inherited.
            environment = {
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "PYTHONPATH": os.pathsep.join(
                    filter(None, (str(CANDIDATE), os.environ.get("K8_DEPENDENCY_TARGET")))
                ),
                "PYTHONDONTWRITEBYTECODE": "1",
                "DJANGO_SETTINGS_MODULE": profile,
            }
            result = subprocess.run(  # noqa: S603 — fixed interpreter and literal credential-free probe
                [str(python), "-c", code],
                cwd=CANDIDATE,
                env=environment,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            self.assertEqual(
                result.returncode,
                0,
                "existing profile/command parser must load without claim inputs",
            )
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")

    def test_opaque_claim_uuid_locator_and_whole_token_verifier(self):
        from uuid import UUID

        tokens = proposed_module("claim_tokens")
        claim_id = UUID("018f1234-5678-7abc-8def-0123456789ab")
        other_id = UUID("018f1234-5678-7abc-8def-0123456789ac")
        secret = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
        token = tokens.format_claim_token(claim_id, secret)
        self.assertEqual(token, "oc1_" + str(claim_id) + "_" + secret)
        self.assertEqual(len(token), 84)
        self.assertEqual(tokens.claim_id_for_token(token), claim_id)
        verifier = tokens.hash_claim_secret(token)
        self.assertTrue(tokens.verify_claim_secret(token, verifier))
        self.assertFalse(
            tokens.verify_claim_secret(tokens.format_claim_token(other_id, secret), verifier)
        )
        self.assertFalse(tokens.verify_claim_secret(secret, verifier))
        for invalid in (
            "",
            secret,
            token.upper(),
            " " + token,
            token + " ",
            token + ".extra",
            token.replace("oc1_", "OC1_", 1),
            token.replace(str(claim_id), "018f1234-5678-4abc-8def-0123456789ab", 1),
            "oc1_" + str(claim_id) + "_" + "!" * 43,
            "oc1_" + str(claim_id) + "_" + "A" * 42 + "B",
            token + "=",
        ):
            self.assertIsNone(tokens.claim_id_for_token(invalid))
        output = StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            for invalid_secret in ("", "A" * 42, "A" * 42 + "B", "!" * 43):
                with self.assertRaises(tokens.ClaimTokenError) as refusal:
                    tokens.format_claim_token(claim_id, invalid_secret)
                self.assertEqual(str(refusal.exception), "owner claim token refused")
            with self.assertRaises(tokens.ClaimTokenError):
                tokens.format_claim_token(UUID("018f1234-5678-4abc-8def-0123456789ab"), secret)
        self.assertEqual(output.getvalue(), "")

    def test_sender_compatible_locator_handles_secret_underscores(self):
        from uuid import UUID

        from apps.outbox.sender import SECRET

        tokens = proposed_module("claim_tokens")
        claim_id = UUID("018f1234-5678-7abc-8def-0123456789ab")
        secret = base64.urlsafe_b64encode(b"\xff" * 32).decode().rstrip("=")
        self.assertIn("_", secret)
        token = tokens.format_claim_token(claim_id, secret)
        self.assertIsNotNone(SECRET.fullmatch(token))
        self.assertEqual(tokens.claim_id_for_token(token), claim_id)
        self.assertIsNone(tokens.claim_id_for_token("oc1." + str(claim_id) + "." + secret))
        self.assertIsNone(tokens.claim_id_for_token(token[:40] + "." + token[41:]))

    def test_nonprofile_verifiers_never_reach_expensive_argon(self):
        from unittest.mock import patch

        tokens = proposed_module("claim_tokens")
        secret = "public verifier admission vector".ljust(43, "-")
        verifier = tokens.hash_claim_secret(secret)
        parts = verifier.split(b"$")
        invalid = [
            None,
            memoryview(verifier),
            b"",
            b"$argon2id$invalid",
            verifier.replace(b"m=65536", b"m=2147483647"),
            verifier.replace(b"t=3", b"t=2147483647"),
            verifier.replace(b"m=65536,t=3,p=4", b"m=8,t=1,p=1"),
            verifier.replace(b"argon2id", b"argon2i"),
            verifier.replace(b"v=19", b"v=16"),
            b"$".join(parts[:4] + [base64.b64encode(b"s" * 15).rstrip(b"="), parts[5]]),
            b"$".join(parts[:5] + [base64.b64encode(b"h" * 31).rstrip(b"=")]),
        ]
        with patch.object(type(tokens._HASHER), "verify", return_value=True) as expensive:
            for bad in invalid:
                self.assertFalse(tokens.verify_claim_secret(secret, bad))
            expensive.assert_not_called()

    def test_operator_secret_creation_is_outside_served_verifier_closure(self):
        path = CANDIDATE / "apps/orgs/owner_claims.py"
        self.assertTrue(path.is_file(), "specified excluded owner issuance service is missing")
        python = Path(sys.executable)
        code = """import django
import base64
django.setup()
from apps.orgs.owner_claims import new_claim_secret
first, second = new_claim_secret(), new_claim_secret()
assert first != second
for secret in (first, second):
    assert isinstance(secret, str) and len(secret) == 43
    raw = base64.b64decode(secret + '=', altchars=b'-_', validate=True)
    assert len(raw) == 32
    assert base64.urlsafe_b64encode(raw).decode().rstrip('=') == secret
"""
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "PYTHONPATH": os.pathsep.join(
                filter(None, (str(CANDIDATE), os.environ.get("K8_DEPENDENCY_TARGET")))
            ),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.e2e_operator",
        }
        result = subprocess.run(  # noqa: S603 — fixed interpreter and literal credential-free probe
            [str(python), "-c", code],
            cwd=CANDIDATE,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(
            result.returncode, 0, "excluded operator service creates fresh canonical32-byte secrets"
        )
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_only_randomised_argon2id_verifier_is_returned(self):
        tokens = proposed_module("claim_tokens")
        output = StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            first = (
                base64.urlsafe_b64encode(b"public first token vector".ljust(32, b"-"))
                .decode()
                .rstrip("=")
            )
            second = (
                base64.urlsafe_b64encode(b"public second token vector".ljust(32, b"-"))
                .decode()
                .rstrip("=")
            )
            self.assertNotEqual(first, second)
            for secret in (first, second):
                self.assertEqual(
                    len(base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))), 32
                )
            verifier = tokens.hash_claim_secret(first)
            self.assertIsInstance(verifier, bytes)
            self.assertTrue(verifier.startswith(b"$argon2id$v=19$m=65536,t=3,p=4$"))
            self.assertNotIn(first.encode(), verifier)
            self.assertNotEqual(verifier, tokens.hash_claim_secret(first))
            self.assertTrue(tokens.verify_claim_secret(first, verifier))
            self.assertFalse(tokens.verify_claim_secret(second, verifier))
            for malformed in (b"", b"unrecognized", b"$argon2id$invalid"):
                self.assertFalse(tokens.verify_claim_secret(first, malformed))
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
