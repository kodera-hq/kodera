"""`manage.py dispatch_bug_reports`: operator/worker command dispatching zero-PII bug reports to a
private GitHub triage repository using a scoped GitHub App installation token (ADR-0003)."""

from __future__ import annotations

import json
import struct
import zlib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.orgs.management.operator import require_operator_profile
from apps.support.bug_reports import (
    PNG_SIGNATURE,
    scrub_bug_report_note,
    verify_png_clean,
    verify_webp_clean,
)
from apps.support.github_triage import (
    GitHubTriageConfigError,
    GitHubUpstreamError,
    build_zero_pii_github_issue,
    dispatch_pending_bug_reports,
    exchange_scoped_installation_token,
    load_github_app_private_key,
    mint_github_app_jwt,
    purge_expired_bug_report_data,
)
from apps.support.models import BugReport


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def _minimal_png(*, extra_chunk: tuple[bytes, bytes] | None = None) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\x10\x20\x30")
    parts = [PNG_SIGNATURE, _png_chunk(b"IHDR", ihdr)]
    if extra_chunk is not None:
        parts.append(_png_chunk(extra_chunk[0], extra_chunk[1]))
    parts.extend([_png_chunk(b"IDAT", idat), _png_chunk(b"IEND", b"")])
    return b"".join(parts)


def _minimal_webp(*, extra_chunk: tuple[bytes, bytes] | None = None) -> bytes:
    vp8_payload = b"\x2f\x00\x00\x00"
    chunks = bytearray(b"VP8L" + struct.pack("<I", len(vp8_payload)) + vp8_payload)
    if extra_chunk is not None:
        tag, payload = extra_chunk
        chunks.extend(tag + struct.pack("<I", len(payload)) + payload)
        if len(payload) % 2 == 1:
            chunks.append(0)
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WEBP" + bytes(chunks)


def run_dispatch_selftest() -> dict[str, Any]:
    """Deterministic in-memory self-test of RS256 App JWT, scoped token exchange, and guards."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now_epoch = 1_795_000_000
    app_jwt = mint_github_app_jwt(
        app_id="123456",
        private_key=private_key,
        now_epoch=now_epoch,
    )
    decoded = jwt.decode(
        app_jwt,
        private_key.public_key(),
        algorithms=["RS256"],
        options={"verify_exp": False},
    )
    if decoded != {"iat": now_epoch - 30, "exp": now_epoch + 300, "iss": "123456"}:
        raise CommandError("selftest failed: unexpected RS256 GitHub App JWT claims")

    captured: list[tuple[str, dict[str, Any]]] = []

    expected_grant = "".join(("ghs_", "SelftestInstallationGrant"))

    def fake_ok(
        url: str, body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        captured.append((url, json.loads(body.decode("utf-8"))))
        resp = {
            "token": expected_grant,
            "permissions": {"issues": "write", "metadata": "read"},
            "repositories": [{"name": "private-triage"}],
        }
        return 201, {}, json.dumps(resp).encode("utf-8")

    scoped_grant = exchange_scoped_installation_token(
        app_id="123456",
        installation_id="987654",
        private_key=private_key,
        repo_name="private-triage",
        now_epoch=now_epoch,
        transport=fake_ok,
    )
    if scoped_grant != expected_grant or captured != [
        (
            "https://api.github.com/app/installations/987654/access_tokens",
            {"repositories": ["private-triage"], "permissions": {"issues": "write"}},
        )
    ]:
        raise CommandError("selftest failed: installation token scope mismatch")

    # Mutation 1: HTTP redirect must be refused.
    def fake_redirect(
        _url: str, _body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return 302, {"location": "https://evil.invalid"}, b"{}"

    try:
        exchange_scoped_installation_token(
            app_id="123456",
            installation_id="987654",
            private_key=private_key,
            repo_name="private-triage",
            now_epoch=now_epoch,
            transport=fake_redirect,
        )
    except GitHubUpstreamError as err:
        if err.code != "redirect_refused":
            raise CommandError(f"selftest failed: wrong redirect refusal {err.code}") from None
    else:
        raise CommandError("selftest failed: redirect was not refused")

    # Mutation 2: PNG/WebP metadata chunks must be rejected while clean bytes pass.
    if verify_png_clean(_minimal_png()) is not None:
        raise CommandError("selftest failed: clean PNG rejected")
    if (
        verify_png_clean(_minimal_png(extra_chunk=(b"tEXt", b"Author\x00Alice")))
        != "metadata_chunk_forbidden"
    ):
        raise CommandError("selftest failed: PNG tEXt chunk survived")
    if verify_webp_clean(_minimal_webp()) is not None:
        raise CommandError("selftest failed: clean WebP rejected")
    if (
        verify_webp_clean(_minimal_webp(extra_chunk=(b"EXIF", b"camera")))
        != "metadata_chunk_forbidden"
    ):
        raise CommandError("selftest failed: WebP EXIF chunk survived")

    # Mutation 3: Zero-PII Markdown issue builder scrubs residual PII.
    sample = BugReport(
        id=UUID("01900000-0000-7000-8000-000000000042"),
        build_id="web-0.52.0",
        component="calls",
        error_code="LIVEKIT_ICE_TIMEOUT",
        device_class="web-desktop",
        consent=True,
        sanitized_note=scrub_bug_report_note(
            "Room !abc:acme-sa.kodera.io failed for alice@acme.fr on acme-sa",
            organisation_slug_value="acme-sa",
            tenant_slug_value="acme-visio",
        ),
        dedup_fingerprint="a" * 64,
        occurrences=3,
        created_at=datetime(2026, 11, 23, 0, 0, tzinfo=UTC),
    )
    issue = build_zero_pii_github_issue(sample)
    for leaked in ("alice@acme.fr", "!abc:acme-sa.kodera.io", "acme-sa"):
        if leaked in issue["body"] or leaked in issue["title"]:
            raise CommandError(f"selftest failed: leaked {leaked!r}")

    return {"status": "ok", "mutations_verified": 4}


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--app-id", default="")
        parser.add_argument("--installation-id", default="")
        parser.add_argument("--key-file", type=Path, default=None)
        parser.add_argument("--repo", default="")
        parser.add_argument("--max-jobs", type=int, default=25)
        parser.add_argument("--json", action="store_true")
        parser.add_argument("--purge-only", action="store_true")
        parser.add_argument("--selftest", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        if options["selftest"]:
            verdict = run_dispatch_selftest()
            if options["json"]:
                self.stdout.write(json.dumps(verdict, sort_keys=True))
            else:
                self.stdout.write(
                    f"selftest={verdict['status']} mutations_verified={verdict['mutations_verified']}"
                )
            return

        if options["purge_only"]:
            purged = purge_expired_bug_report_data()
            purge_payload = {
                "purged_dispatched": purged.dispatched_deleted,
                "purged_undispatched": purged.undispatched_deleted,
                "purged_rate_events": purged.rate_events_deleted,
            }
            if options["json"]:
                self.stdout.write(json.dumps(purge_payload, sort_keys=True))
            else:
                self.stdout.write(
                    f"purged_dispatched={purged.dispatched_deleted} "
                    f"purged_undispatched={purged.undispatched_deleted} "
                    f"purged_rate_events={purged.rate_events_deleted}"
                )
            return

        if not 1 <= options["max_jobs"] <= 500:
            raise CommandError("--max-jobs must be between 1 and 500")
        if (
            not options["app_id"]
            or not options["installation_id"]
            or options["key_file"] is None
            or not options["repo"]
        ):
            raise CommandError("--app-id, --installation-id, --key-file, and --repo are required")

        try:
            signer = load_github_app_private_key(options["key_file"])
            try:
                summary = dispatch_pending_bug_reports(
                    app_id=options["app_id"],
                    installation_id=options["installation_id"],
                    private_key=signer,
                    repo=options["repo"],
                    max_jobs=options["max_jobs"],
                )
            finally:
                del signer
        except GitHubTriageConfigError as exc:
            raise CommandError(str(exc)) from None

        payload = {
            "dispatched": summary.dispatched,
            "failed": summary.failed,
            "circuit_open": summary.circuit_open,
            "cooldown_remaining_s": summary.cooldown_remaining_s,
            "issue_numbers": list(summary.issue_numbers),
            "purged_dispatched": summary.purged_dispatched,
            "purged_undispatched": summary.purged_undispatched,
            "purged_rate_events": summary.purged_rate_events,
        }
        if options["json"]:
            self.stdout.write(json.dumps(payload, sort_keys=True))
        else:
            self.stdout.write(
                f"dispatched={summary.dispatched} failed={summary.failed} "
                f"circuit_open={str(summary.circuit_open).lower()} "
                f"cooldown_remaining_s={summary.cooldown_remaining_s}"
            )


__all__ = ["Command", "run_dispatch_selftest"]
