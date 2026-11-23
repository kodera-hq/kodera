"""Zero-PII in-app bug report collector and scoped GitHub App triage worker acceptance tests."""

from __future__ import annotations

import base64
import json
import secrets
import struct
import threading
import uuid
import zlib
from datetime import timedelta
from io import StringIO
from pathlib import Path
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from customer_http_fixtures import http_signer as http_signer
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import (
    DatabaseError,
    IntegrityError,
    close_old_connections,
    connection,
    connections,
    transaction,
)
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_api_database_boundary import database_url
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_support_tickets_http import tenant
from test_workspace_onboarding import call, conformance_errors, w as w

from apps.support import bug_reports
from apps.support.github_triage import (
    CIRCUIT_COOLDOWN_SECONDS,
    CIRCUIT_FAILURE_THRESHOLD,
    bug_report_issue_marker,
    build_zero_pii_github_issue,
    dispatch_pending_bug_reports,
    exchange_scoped_installation_token,
    mint_github_app_jwt,
    purge_expired_bug_report_data,
)
from apps.support.models import BugReport, BugReportCircuitState, BugReportRateEvent
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements
from dev.image_context import image_files

pytestmark = pytest.mark.django_db(transaction=True)

CONTRACT_PATH = "/organisations/{organisation_id}/support/bug-reports"
PROBLEMS = "https://kodera.io/problems/"


def _keys():
    for index in range(1, 20_000):
        yield f"bug-report-{index:05d}-0123456789abcdef"


KEY = iter(_keys())


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def make_png(*, extra_chunk: tuple[bytes, bytes] | None = None, payload_bytes: int = 4) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    raw_scanlines = b"\x00" + (b"\x40\x60\x80" * max(2, payload_bytes))
    idat = zlib.compress(raw_scanlines)
    chunks = [bug_reports.PNG_SIGNATURE, _png_chunk(b"IHDR", ihdr)]
    if extra_chunk is not None:
        chunks.append(_png_chunk(extra_chunk[0], extra_chunk[1]))
    chunks.extend([_png_chunk(b"IDAT", idat), _png_chunk(b"IEND", b"")])
    return b"".join(chunks)


def make_webp(
    *, extra_chunk: tuple[bytes, bytes] | None = None, vp8x_flags: int | None = None
) -> bytes:
    chunks = bytearray()
    if vp8x_flags is not None:
        vp8x = bytes([vp8x_flags, 0, 0, 0]) + (1).to_bytes(3, "little") + (1).to_bytes(3, "little")
        chunks.extend(b"VP8X" + struct.pack("<I", len(vp8x)) + vp8x)
    vp8l = b"\x2f\x00\x00\x00"
    chunks.extend(b"VP8L" + struct.pack("<I", len(vp8l)) + vp8l)
    if extra_chunk is not None:
        tag, data = extra_chunk
        chunks.extend(tag + struct.pack("<I", len(data)) + data)
        if len(data) % 2 == 1:
            chunks.append(0)
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WEBP" + bytes(chunks)


def default_body(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "build_id": "web-0.52.0",
        "component": "calls",
        "error_code": "LIVEKIT_ICE_TIMEOUT",
        "device_class": "web-desktop",
        "consent": False,
    }
    base.update(overrides)
    return base


def post_bug(
    w,
    who,
    body: dict[str, Any] | None = None,
    *,
    org_id=None,
    key: str | None = None,
    raw: bytes | str | None = None,
    content_type: str = "application/json",
):
    target_org = w.alpha.id if org_id is None else org_id
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    headers["HTTP_IDEMPOTENCY_KEY"] = key or next(KEY)
    data = raw if raw is not None else json.dumps(default_body() if body is None else body)
    return w.client.post(
        f"/api/v1/organisations/{target_org}/support/bug-reports",
        data=data,
        content_type=content_type,
        **headers,
    )


def assert_created(response) -> dict[str, Any]:
    errors = conformance_errors(response, CONTRACT_PATH, "post")
    assert response.status_code == 201, response.content
    assert errors == [], errors
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def assert_problem(response, status: int, kind: str) -> dict[str, Any]:
    call(response, CONTRACT_PATH, "post")
    assert response.status_code == status, response.content
    assert response.headers["Cache-Control"] == "no-store"
    parsed = json.loads(response.content)
    assert parsed["type"] == PROBLEMS + kind
    return parsed


@pytest.fixture
def writer(w):
    role = f"bug_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_zero_pii_models_have_zero_foreign_keys_and_zero_identifier_columns():
    forbidden_substrings = ("user", "identity", "member", "org", "tenant", "email", "ip", "slug")
    for model in (BugReport, BugReportRateEvent, BugReportCircuitState):
        for field in model._meta.get_fields():
            assert not field.is_relation, f"{model.__name__}.{field.name} introduces a relation"
            lowered = field.name.lower()
            if lowered == "github_issue_number":
                continue
            for token in forbidden_substrings:
                assert token not in lowered, f"{model.__name__}.{field.name} carries {token}"

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM information_schema.table_constraints "
            "WHERE table_schema = current_schema() "
            "AND table_name IN ('support_bugreport', 'support_bugreportrateevent', 'support_bugreportcircuitstate') "
            "AND constraint_type = 'FOREIGN KEY'"
        )
        assert cursor.fetchone() == (0,)


def test_worker_github_triage_modules_stay_outside_the_api_image():
    root = Path(__file__).resolve().parents[1]
    carried = image_files(root)
    assert "apps/support/bug_reports.py" in carried
    assert "apps/support/github_triage.py" not in carried
    assert "apps/support/management/commands/dispatch_bug_reports.py" not in carried


@pytest.mark.parametrize("role", ["owner", "admin", "billing", "member"])
def test_every_tenant_role_submits_allowlisted_report_and_outsiders_are_refused(w, role):
    who = getattr(w, role)
    receipt = assert_created(post_bug(w, who, default_body(error_code=f"ERR_{role.upper()}")))
    assert receipt["status"] == "queued"
    assert receipt["occurrences"] == 1
    assert len(receipt["dedup_fingerprint"]) == 64

    # Unauthenticated, staff, non-members, and cross-organisation callers are refused cleanly.
    assert_problem(post_bug(w, None), 401, "unauthenticated")
    assert_problem(post_bug(w, w.staff), 403, "forbidden")
    assert_problem(post_bug(w, w.stranger, org_id=w.alpha.id), 404, "not-found")
    assert_problem(post_bug(w, w.foreigner, org_id=w.alpha.id), 404, "not-found")


@pytest.mark.parametrize(
    ("injected_secret", "expected_code"),
    [
        ("Header Authorization: Bearer " + "secret_access_token_xyz", "bearer_token"),
        (
            "Token "
            + "eyJhbGciOiJIUzI1NiJ9."
            + "eyJzdWIiOiIxMjMifQ."
            + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            "jwt_token",
        ),
        ("Key " + "rk_" + "live_SyntheticRestrictedKey99", "api_credential"),
        ("Key " + "sk_" + "test_SyntheticSecretKey99", "api_credential"),
        ("Token " + "ghp_" + "SyntheticGitHubToken0123456789", "api_credential"),
        ("Token " + "github_pat_" + "11ABCDEF_SyntheticFineGrained", "api_credential"),
        ("Synapse " + "access_token=syt_" + "YWxpY2U_SyntheticMatrixToken", "api_credential"),
        ("Synapse refresh " + "syr_" + "YWxpY2U_SyntheticRefresh", "api_credential"),
        ("Synapse media " + "mda_" + "YWxpY2U_SyntheticMedia", "api_credential"),
        ("Bare assignment password=SyntheticPassword99", "api_credential"),
        ("Bare tok" + "en=" + "SyntheticSecret", "api_credential"),
        ("Header x-api-" + "key=" + "SyntheticKey", "api_credential"),
        ("Cookie coo" + "kie: " + "sid_sample_123", "api_credential"),
        ("Telemetry " + "phc_" + "SyntheticProjectKey123456", "api_credential"),
        ("Cloud " + "SCW" + "ABCDEFGHJKMNPQRST", "api_credential"),
        ("Key block -----BEGIN " + "PRIVATE KEY-----", "pem_material"),
        ("Link /invitations/accept?id=123", "invite_or_auth_link"),
        ("Link /invite/join-room", "invite_or_auth_link"),
        ("Path /claim/owner", "invite_or_auth_link"),
        ("Path /magic/verify", "invite_or_auth_link"),
        ("Query ?token=secretvalue", "invite_or_auth_link"),
        ("Query ?code=oauthcode123", "invite_or_auth_link"),
        ("Fragment #token=hashsecret", "invite_or_auth_link"),
        ("Visit https://console.kodera.io/alpha/workspace", "url_forbidden"),
        ("Visit http://10.0.0.5:8080/internal", "url_forbidden"),
        ("Archive ftp://files.kodera.io/dump.tar", "url_forbidden"),
        ("Archive ftps://files.kodera.io/dump.tar", "url_forbidden"),
        ("Local file:///etc/hosts", "url_forbidden"),
        ("Protocol relative //evil.example/path", "url_forbidden"),
        ("Protocol relative //alice:" + "SyntheticPassword@localhost/private", "url_forbidden"),
        ("Open //alice:" + "SyntheticPassword@localhost now", "url_forbidden"),
        ("Open //alice:" + "SyntheticPassword@[::1] now", "url_forbidden"),
        ("Visit //example.com.", "url_forbidden"),
    ],
)
def test_hard_refusal_blocks_credentials_tokens_pem_invites_and_urls_without_echo_or_storage(
    w, injected_secret, expected_code
):
    response = post_bug(
        w,
        w.member,
        default_body(consent=True, note=f"Crash observed: {injected_secret}"),
    )
    problem = assert_problem(response, 422, "validation-error")
    assert {"pointer": "/note", "code": expected_code} in problem["errors"]
    # Never echo the secret back in the HTTP response and never persist any row.
    raw_text = response.content.decode("utf-8")
    for fragment in (
        "secret_access_token_xyz",
        "eyJhbGciOiJIUzI1NiJ9",
        "SyntheticMatrixToken",
        "PRIVATE KEY",
        "kodera.io/alpha",
        "evil.example",
    ):
        assert fragment not in raw_text
    assert BugReport.objects.count() == 0


@pytest.mark.parametrize(
    ("field_name", "bad_value", "expected_code"),
    [
        ("build_id", "ghp_" + "SyntheticToken1234567890", "api_credential"),
        ("build_id", "syt_" + "YWxpY2U_SyntheticMatrix", "api_credential"),
        ("build_id", "018f1234-5678-7000-8000-000000000077", "pii_or_identifier_forbidden"),
        ("build_id", "192.0.2.44", "pii_or_identifier_forbidden"),
        ("build_id", "alpha", "pii_or_identifier_forbidden"),
        ("error_code", "ghp_" + "SyntheticToken1234567890", "api_credential"),
        ("error_code", "GHP_" + "SYNTHETICTOKEN1234567890", "api_credential"),
        ("error_code", "SYT_" + "SYNTHETICMATRIX12345", "api_credential"),
        ("error_code", "018F1234-5678-7000-8000-000000000077", "pii_or_identifier_forbidden"),
        ("error_code", "ERR_018F1234-5678-7000-8000-000000000077", "pii_or_identifier_forbidden"),
        ("error_code", "192.0.2.44", "pii_or_identifier_forbidden"),
        ("error_code", "ERR_192.0.2.44", "pii_or_identifier_forbidden"),
        ("error_code", "ERR_12025550142", "pii_or_identifier_forbidden"),
        ("error_code", "ERR_98765", "pii_or_identifier_forbidden"),
        ("error_code", "ERR_ALPHA", "pii_or_identifier_forbidden"),
    ],
)
def test_build_id_and_error_code_refuse_tokens_uuids_ips_and_slugs_with_consent_false(
    w, field_name, bad_value, expected_code
):
    response = post_bug(w, w.member, default_body(consent=False, **{field_name: bad_value}))
    problem = assert_problem(response, 422, "validation-error")
    assert {"pointer": f"/{field_name}", "code": expected_code} in problem["errors"]
    assert BugReport.objects.count() == 0

    # Defense-in-depth: GitHub exporter also re-verifies and redacts tampered diagnostic fields.
    for bad_note in (
        "Open //alice:" + "SyntheticPassword@localhost now",
        "Open //alice:" + "SyntheticPassword@[::1] now",
        "Leak tok" + "en=SyntheticSecret",
    ):
        tampered = BugReport(
            id=uuid.UUID("01900000-0000-7000-8000-000000000088"),
            build_id="ghp_" + "TamperedToken9999",
            component="calls",
            error_code="ERR_12025550142",
            device_class="web-desktop",
            consent=True,
            sanitized_note=bad_note,
            dedup_fingerprint="b" * 64,
            occurrences=1,
            created_at=timezone.now(),
        )
        exported = build_zero_pii_github_issue(tampered)
        assert "TamperedToken9999" not in exported["body"]
        assert "12025550142" not in exported["title"] and "12025550142" not in exported["body"]
        assert "SyntheticSecret" not in exported["body"]
        assert "SyntheticPassword" not in exported["body"]
        assert "`redacted-build`" in exported["body"]
        assert "REDACTED_ERROR_CODE" in exported["title"]
        assert "[OMITTED_FORBIDDEN_PATTERN]" in exported["body"]


def test_scrubber_strips_emails_uuids_ips_matrix_ids_phones_and_org_or_tenant_slugs(w):
    tenant(w.alpha, "alpha-visio")
    org_slug = w.alpha.slug
    raw_note = (
        f"Audio drop for alice.martin@production.fr in !room42:{org_slug}.kodera.io "
        f"with @bob:{org_slug}.kodera.io and event $ev987654321 on {org_slug} / alpha-visio "
        "from 192.168.10.55 and 2001:db8::abcd:1234, session "
        "018f1234-5678-7000-8000-000000000077, tel +33 6 11 22 33 44."
    )
    receipt = assert_created(post_bug(w, w.member, default_body(consent=True, note=raw_note)))
    stored = BugReport.objects.get(pk=receipt["id"])

    forbidden_pii = (
        "alice.martin@production.fr",
        f"!room42:{org_slug}.kodera.io",
        f"@bob:{org_slug}.kodera.io",
        "$ev987654321",
        org_slug,
        "alpha-visio",
        "192.168.10.55",
        "2001:db8::abcd:1234",
        "018f1234-5678-7000-8000-000000000077",
        "+33 6 11 22 33 44",
    )
    for item in forbidden_pii:
        assert item not in stored.sanitized_note
        assert item not in json.dumps(receipt)

    assert "[REDACTED_EMAIL]" in stored.sanitized_note
    assert "[REDACTED_MATRIX_ID]" in stored.sanitized_note
    assert "[REDACTED_ORG]" in stored.sanitized_note
    assert "[REDACTED_TENANT]" in stored.sanitized_note
    assert "[REDACTED_IP]" in stored.sanitized_note
    assert "[REDACTED_UUID]" in stored.sanitized_note
    assert "[REDACTED_PHONE]" in stored.sanitized_note


def test_consent_false_refuses_note_or_screenshot_at_http_and_sql_boundaries(w):
    png_b64 = base64.b64encode(make_png()).decode("ascii")

    resp_note = post_bug(w, w.member, default_body(consent=False, note="Symptom description"))
    prob_note = assert_problem(resp_note, 422, "validation-error")
    assert {"pointer": "/consent", "code": "consent_required"} in prob_note["errors"]

    resp_shot = post_bug(
        w,
        w.member,
        default_body(
            consent=False,
            screenshot={"contentType": "image/png", "blurred": True, "dataBase64": png_b64},
        ),
    )
    prob_shot = assert_problem(resp_shot, 422, "validation-error")
    assert {"pointer": "/consent", "code": "consent_required"} in prob_shot["errors"]
    assert BugReport.objects.count() == 0

    with pytest.raises(IntegrityError), transaction.atomic():
        BugReport.objects.create(
            build_id="web-0.52.0",
            component="workspace",
            error_code="ERR_SQL",
            device_class="web-desktop",
            consent=False,
            sanitized_note="unconsented text",
            dedup_fingerprint="f" * 64,
        )


@pytest.mark.parametrize(
    ("content_type", "raw_bytes", "expected_code"),
    [
        ("image/png", b"\xff\xd8\xff\xe0not-a-png-at-all-123456", "invalid_magic"),
        (
            "image/png",
            make_png(extra_chunk=(b"tEXt", b"Author\x00Alice Dupont")),
            "metadata_chunk_forbidden",
        ),
        (
            "image/png",
            make_png(extra_chunk=(b"iTXt", b"Comment\x00\x00\x00\x00\x00Secret")),
            "metadata_chunk_forbidden",
        ),
        (
            "image/png",
            make_png(extra_chunk=(b"zTXt", b"Software\x00\x78\x9c\x03\x00\x00\x00\x00\x01")),
            "metadata_chunk_forbidden",
        ),
        (
            "image/png",
            make_png(extra_chunk=(b"eXIf", b"MM\x00*\x00\x00\x00\x08")),
            "metadata_chunk_forbidden",
        ),
        (
            "image/webp",
            make_webp(extra_chunk=(b"EXIF", b"Exif\x00\x00CameraSerial")),
            "metadata_chunk_forbidden",
        ),
        (
            "image/webp",
            make_webp(extra_chunk=(b"XMP ", b"<x:xmpmeta>Alice</x:xmpmeta>")),
            "metadata_chunk_forbidden",
        ),
        ("image/webp", make_webp(vp8x_flags=0x08), "metadata_chunk_forbidden"),
    ],
)
def test_screenshot_rejects_magic_mismatch_and_embedded_png_or_webp_metadata_chunks(
    w, content_type, raw_bytes, expected_code
):
    encoded = base64.b64encode(raw_bytes).decode("ascii")
    resp = post_bug(
        w,
        w.member,
        default_body(
            consent=True,
            screenshot={"contentType": content_type, "blurred": True, "dataBase64": encoded},
        ),
    )
    problem = assert_problem(resp, 422, "validation-error")
    assert {"pointer": "/screenshot/dataBase64", "code": expected_code} in problem["errors"]
    assert BugReport.objects.count() == 0


def test_screenshot_accepts_clean_blurred_png_and_webp_and_enforces_blur_and_256kib_cap(w):
    for mime, clean_bytes in (("image/png", make_png()), ("image/webp", make_webp())):
        b64 = base64.b64encode(clean_bytes).decode("ascii")
        receipt = assert_created(
            post_bug(
                w,
                w.member,
                default_body(
                    error_code=f"CLEAN_{mime.split('/')[1].upper()}",
                    consent=True,
                    screenshot={"contentType": mime, "blurred": True, "dataBase64": b64},
                ),
            )
        )
        stored = BugReport.objects.get(pk=receipt["id"])
        assert stored.screenshot_content_type == mime
        assert bytes(stored.screenshot_bytes) == clean_bytes
        assert len(stored.screenshot_sha256 or "") == 64

    # Unblurred flag is rejected.
    unblurred = post_bug(
        w,
        w.member,
        default_body(
            consent=True,
            screenshot={
                "contentType": "image/png",
                "blurred": False,
                "dataBase64": base64.b64encode(make_png()).decode("ascii"),
            },
        ),
    )
    prob_blur = assert_problem(unblurred, 422, "validation-error")
    assert {"pointer": "/screenshot/blurred", "code": "blur_required"} in prob_blur["errors"]

    # Oversized (> 256 KiB decoded, still < 384 KiB request body) is rejected 422.
    oversized_bytes = b"\x89PNG\r\n\x1a\n" + (b"\x00" * (256 * 1024 + 32))
    oversized_b64 = base64.b64encode(oversized_bytes).decode("ascii")
    prob_size = assert_problem(
        post_bug(
            w,
            w.member,
            default_body(
                consent=True,
                screenshot={
                    "contentType": "image/png",
                    "blurred": True,
                    "dataBase64": oversized_b64,
                },
            ),
        ),
        422,
        "validation-error",
    )
    assert {"pointer": "/screenshot/dataBase64", "code": "size_out_of_bounds"} in prob_size[
        "errors"
    ]


def test_idempotency_replay_24h_deduplication_three_tier_hmac_limits_and_queue_depth_cap(
    w, monkeypatch
):
    first = assert_created(
        post_bug(
            w,
            w.member,
            default_body(consent=True, note="Frame drop for alice@acme.fr"),
            key="bug-idem-replay-0001",
        )
    )
    assert first["status"] == "queued" and first["occurrences"] == 1

    # Same Idempotency-Key replays stored 201 without incrementing occurrences or rate events.
    replayed = post_bug(
        w,
        w.member,
        default_body(consent=True, note="Frame drop for alice@acme.fr"),
        key="bug-idem-replay-0001",
    )
    assert replayed.status_code == 201
    assert replayed.headers.get("Idempotency-Replayed") == "true"
    assert BugReport.objects.get(pk=first["id"]).occurrences == 1
    assert BugReportRateEvent.objects.count() == 3

    # Distinct caller email in note scrubs to identical normalized note and coalesces within 24h!
    second = assert_created(
        post_bug(
            w,
            w.admin,
            default_body(consent=True, note="Frame drop for bob@other.org"),
        )
    )
    assert second["id"] == first["id"]
    assert second["status"] == "deduplicated"
    assert second["occurrences"] == 2

    # Rate-event buckets store only 64-char keyed-HMAC hex digests, never raw UUIDs.
    digests = list(BugReportRateEvent.objects.values_list("bucket_digest", flat=True))
    assert all(len(d) == 64 and str(w.alpha.id) not in d for d in digests)

    # Tier 1: member limit (5/h -> already 1 from member; 4 more succeed, 6th returns 429).
    for idx in range(4):
        assert_created(post_bug(w, w.member, default_body(error_code=f"MEMBER_CAP_{idx}")))
    limited_member = post_bug(w, w.member, default_body(error_code="MEMBER_OVERFLOW"))
    assert_problem(limited_member, 429, "rate-limited")
    assert int(limited_member.headers["Retry-After"]) >= 1

    # Tier 2: organisation limit.
    monkeypatch.setattr(bug_reports, "PER_MEMBER_LIMIT", 50)
    monkeypatch.setattr(bug_reports, "PER_ORG_LIMIT", 7)
    assert_created(post_bug(w, w.owner, default_body(error_code="ORG_SEVENTH")))
    limited_org = post_bug(w, w.owner, default_body(error_code="ORG_OVERFLOW"))
    assert_problem(limited_org, 429, "rate-limited")
    assert int(limited_org.headers["Retry-After"]) >= 1

    # Tier 3: global limit.
    monkeypatch.setattr(bug_reports, "PER_ORG_LIMIT", 100)
    monkeypatch.setattr(bug_reports, "GLOBAL_LIMIT", 7)
    limited_global = post_bug(w, w.billing, default_body(error_code="GLOBAL_OVERFLOW"))
    assert_problem(limited_global, 429, "rate-limited")
    assert int(limited_global.headers["Retry-After"]) >= 1

    # Queue depth cap (<= 500 undispatched -> 503 Retry-After: 60).
    monkeypatch.setattr(bug_reports, "GLOBAL_LIMIT", 1000)
    monkeypatch.setattr(bug_reports, "MAX_UNDISPATCHED_QUEUE_DEPTH", 3)
    queue_full = post_bug(w, w.billing, default_body(error_code="QUEUE_OVERFLOW"))
    prob_full = assert_problem(queue_full, 503, "service-unavailable")
    assert queue_full.headers["Retry-After"] == "60"
    assert prob_full["retry_after_s"] == 60


def test_api_writer_role_queues_coalesces_and_cannot_touch_worker_columns_or_circuit(w, writer):
    with acting_as(writer):
        first = assert_created(post_bug(w, w.member, default_body(error_code="WRITER_ROLE_OK")))
        second = assert_created(post_bug(w, w.owner, default_body(error_code="WRITER_ROLE_OK")))
        assert second["id"] == first["id"] and second["occurrences"] == 2

        for forbidden_sql in (
            "UPDATE support_bugreport SET dispatched_at = now()",
            "UPDATE support_bugreport SET github_issue_number = 1",
            "UPDATE support_bugreport SET dispatch_attempts = 9",
            "UPDATE support_bugreport SET claimed_at = now()",
            "UPDATE support_bugreport SET sanitized_note = 'tampered'",
            (
                "INSERT INTO support_bugreport "
                "(id, created_at, updated_at, build_id, component, error_code, device_class, "
                "consent, sanitized_note, dedup_fingerprint, occurrences, dispatched_at) "
                "VALUES (gen_random_uuid(), now(), now(), 'web-0.52.0', 'calls', 'ERR_FORGED', "
                "'web-desktop', false, '', repeat('c', 64), 1, now())"
            ),
            (
                "INSERT INTO support_bugreport "
                "(id, created_at, updated_at, build_id, component, error_code, device_class, "
                "consent, sanitized_note, dedup_fingerprint, occurrences, github_issue_number) "
                "VALUES (gen_random_uuid(), now(), now(), 'web-0.52.0', 'calls', 'ERR_FORGED', "
                "'web-desktop', false, '', repeat('c', 64), 1, 999)"
            ),
            (
                "INSERT INTO support_bugreport "
                "(id, created_at, updated_at, build_id, component, error_code, device_class, "
                "consent, sanitized_note, dedup_fingerprint, occurrences, claimed_at) "
                "VALUES (gen_random_uuid(), now(), now(), 'web-0.52.0', 'calls', 'ERR_FORGED', "
                "'web-desktop', false, '', repeat('c', 64), 1, now())"
            ),
            "DELETE FROM support_bugreport",
            "SELECT count(*) FROM support_bugreportcircuitstate",
        ):
            assert refused(forbidden_sql) == INSUFFICIENT_PRIVILEGE


def test_github_app_worker_exchanges_scoped_token_posts_zero_pii_issues_and_trips_circuit(
    w, tmp_path, settings
):
    # Selftest passes cleanly under operator-capable test profile.
    selftest_out = StringIO()
    call_command("dispatch_bug_reports", "--selftest", "--json", stdout=selftest_out)
    assert json.loads(selftest_out.getvalue())["status"] == "ok"

    # Non-operator profile is refused before touching keys or database.
    original_apps = list(settings.INSTALLED_APPS)
    settings.INSTALLED_APPS = [app for app in original_apps if app != "apps.outbox"]
    try:
        with pytest.raises(CommandError, match="config.settings.job_queue"):
            call_command("dispatch_bug_reports", "--selftest")
    finally:
        settings.INSTALLED_APPS = original_apps

    tenant(w.alpha, "alpha-visio")
    receipt = assert_created(
        post_bug(
            w,
            w.member,
            default_body(
                consent=True,
                note="Disconnect for camille@acme.fr in !room:alpha.kodera.io on alpha-visio",
                screenshot={
                    "contentType": "image/png",
                    "blurred": True,
                    "dataBase64": base64.b64encode(make_png()).decode("ascii"),
                },
            ),
        )
    )

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem_path = tmp_path / "github-app.pem"
    pem_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )

    # Verify RS256 App JWT expiry bound (exp = now + 300).
    minted = mint_github_app_jwt(app_id="424242", private_key=private_key, now_epoch=1_800_000_000)
    claims = jwt.decode(
        minted,
        private_key.public_key(),
        algorithms=["RS256"],
        options={"verify_exp": False},
    )
    assert claims == {"iat": 1_800_000_000 - 30, "exp": 1_800_000_000 + 300, "iss": "424242"}

    # Over-privileged installation token (`contents: write`) is refused.
    def overprivileged_transport(url: str, body: bytes, headers: dict[str, str]):
        return (
            201,
            {},
            json.dumps(
                {
                    "token": "ghs_OverPrivileged",
                    "permissions": {"issues": "write", "contents": "write"},
                    "repositories": [{"name": "private-triage"}],
                }
            ).encode(),
        )

    with pytest.raises(Exception, match="excess_token_permissions"):
        exchange_scoped_installation_token(
            app_id="424242",
            installation_id="999111",
            private_key=private_key,
            repo_name="private-triage",
            transport=overprivileged_transport,
        )

    calls: list[tuple[str, dict[str, str], dict[str, Any]]] = []

    def scoped_transport(url: str, body: bytes, headers: dict[str, str]):
        payload = json.loads(body.decode("utf-8"))
        calls.append((url, headers, payload))
        if url.endswith("/access_tokens"):
            return (
                201,
                {},
                json.dumps(
                    {
                        "token": "ghs_ScopedInstallationToken",
                        "permissions": {"issues": "write", "metadata": "read"},
                        "repositories": [{"name": "private-triage"}],
                    }
                ).encode(),
            )
        return 201, {}, json.dumps({"number": 77}).encode()

    summary = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        max_jobs=10,
        transport=scoped_transport,
    )
    assert summary.dispatched == 1 and summary.failed == 0 and summary.issue_numbers == (77,)
    assert len(calls) == 2

    token_url, token_headers, token_body = calls[0]
    assert token_url == "https://api.github.com/app/installations/999111/access_tokens"
    assert token_body == {"repositories": ["private-triage"], "permissions": {"issues": "write"}}
    assert token_headers["Authorization"].startswith("Bearer eyJ")

    issue_url, issue_headers, issue_body = calls[1]
    assert issue_url == "https://api.github.com/repos/kodera-hq/private-triage/issues"
    assert issue_headers["Authorization"] == "Bearer ghs_ScopedInstallationToken"
    for pii in ("camille@acme.fr", "!room:alpha.kodera.io", "alpha-visio", str(w.alpha.id)):
        assert pii not in issue_body["title"] and pii not in issue_body["body"]

    dispatched_row = BugReport.objects.get(pk=receipt["id"])
    assert dispatched_row.dispatched_at is not None
    assert dispatched_row.github_issue_number == 77
    assert bug_report_issue_marker(dispatched_row.id) in issue_body["body"]
    # Immediately wiped upon GitHub creation while preserving dedup_fingerprint for 24h coalescing.
    assert dispatched_row.sanitized_note == ""
    assert dispatched_row.screenshot_bytes is None
    assert dispatched_row.screenshot_content_type is None
    assert dispatched_row.screenshot_sha256 is None
    assert dispatched_row.claimed_at is None
    assert dispatched_row.claim_token == ""

    coalesced_after_wipe = assert_created(
        post_bug(
            w,
            w.owner,
            default_body(
                consent=True,
                note="Disconnect for camille@acme.fr in !room:alpha.kodera.io on alpha-visio",
            ),
        )
    )
    assert coalesced_after_wipe["id"] == receipt["id"]
    assert coalesced_after_wipe["status"] == "deduplicated"
    assert coalesced_after_wipe["occurrences"] == 2

    # Upstream circuit breaker: 5 consecutive failures open cooldown >= 300 s and halt further calls.
    assert_created(post_bug(w, w.member, default_body(error_code="UPSTREAM_DOWN")))
    upstream_hits = 0

    def failing_transport(_url: str, _body: bytes, _headers: dict[str, str]):
        nonlocal upstream_hits
        upstream_hits += 1
        return 502, {}, b'{"message":"bad gateway"}'

    for attempt in range(CIRCUIT_FAILURE_THRESHOLD):
        res = dispatch_pending_bug_reports(
            app_id="424242",
            installation_id="999111",
            private_key=private_key,
            repo="kodera-hq/private-triage",
            transport=failing_transport,
        )
        assert res.circuit_open is (attempt == CIRCUIT_FAILURE_THRESHOLD - 1)

    assert upstream_hits == CIRCUIT_FAILURE_THRESHOLD
    circuit = BugReportCircuitState.objects.get(singleton=True)
    assert circuit.consecutive_failures == CIRCUIT_FAILURE_THRESHOLD
    assert circuit.opened_until is not None

    # 6th call while circuit is open makes ZERO outbound HTTP calls.
    blocked = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        transport=failing_transport,
    )
    assert blocked.circuit_open is True
    assert blocked.cooldown_remaining_s >= CIRCUIT_COOLDOWN_SECONDS - 5
    assert upstream_hits == CIRCUIT_FAILURE_THRESHOLD

    # Once cooldown expires, healthy upstream dispatches and resets circuit state.
    BugReportCircuitState.objects.filter(singleton=True).update(
        opened_until=timezone.now() - timedelta(seconds=1)
    )
    recovered = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        transport=scoped_transport,
    )
    assert recovered.dispatched == 1 and not recovered.circuit_open
    circuit.refresh_from_db()
    assert circuit.consecutive_failures == 0 and circuit.opened_until is None


def test_two_concurrent_workers_claim_exclusively_and_stale_claim_recovers_without_duplicates(w):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    queued = assert_created(post_bug(w, w.member, default_body(error_code="CONCURRENT_CLAIM_RACE")))
    report_id = uuid.UUID(queued["id"])

    worker1_in_flight = threading.Event()
    allow_worker1_finish = threading.Event()
    issue_posts: list[dict[str, Any]] = []
    post_lock = threading.Lock()

    def slow_worker1_transport(url: str, body: bytes, _headers: dict[str, str]):
        payload = json.loads(body.decode("utf-8"))
        if url.endswith("/access_tokens"):
            return (
                201,
                {},
                json.dumps(
                    {
                        "token": "".join(("ghs_", "WorkerOneGrant")),
                        "permissions": {"issues": "write", "metadata": "read"},
                        "repositories": [{"name": "private-triage"}],
                    }
                ).encode(),
            )
        worker1_in_flight.set()
        assert allow_worker1_finish.wait(timeout=5.0)
        with post_lock:
            issue_posts.append(payload)
        return 201, {}, json.dumps({"number": 301}).encode()

    def fast_worker2_transport(url: str, body: bytes, _headers: dict[str, str]):
        payload = json.loads(body.decode("utf-8"))
        if url.endswith("/access_tokens"):
            return (
                201,
                {},
                json.dumps(
                    {
                        "token": "".join(("ghs_", "WorkerTwoGrant")),
                        "permissions": {"issues": "write", "metadata": "read"},
                        "repositories": [{"name": "private-triage"}],
                    }
                ).encode(),
            )
        with post_lock:
            issue_posts.append(payload)
        return 201, {}, json.dumps({"number": 302}).encode()

    results: dict[str, Any] = {}

    def run_worker_one() -> None:
        close_old_connections()
        try:
            results["one"] = dispatch_pending_bug_reports(
                app_id="424242",
                installation_id="999111",
                private_key=private_key,
                repo="kodera-hq/private-triage",
                transport=slow_worker1_transport,
            )
        finally:
            connections.close_all()

    t1 = threading.Thread(target=run_worker_one)
    t1.start()
    assert worker1_in_flight.wait(timeout=5.0)

    # While Worker 1 is mid-POST, `claimed_at` is persisted; Worker 2 skips it cleanly!
    summary_two = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        transport=fast_worker2_transport,
    )
    allow_worker1_finish.set()
    t1.join(timeout=5.0)

    assert summary_two.dispatched == 0
    assert results["one"].dispatched == 1
    assert results["one"].issue_numbers == (301,)
    assert len(issue_posts) == 1
    assert BugReport.objects.get(pk=report_id).github_issue_number == 301

    # Stale claim recovery (> 300s): paginates `state=all&since=...` across pages so a closed
    # issue on page 2 is still discovered and adopted without a duplicate POST.
    stale_receipt = assert_created(
        post_bug(
            w,
            w.owner,
            default_body(consent=True, error_code="STALE_TIMEOUT_RECOVERY", note="Retry check"),
        )
    )
    stale_id = uuid.UUID(stale_receipt["id"])
    BugReport.objects.filter(pk=stale_id).update(
        claimed_at=timezone.now() - timedelta(seconds=360),
        claim_token=uuid.uuid4().hex,
        dispatch_attempts=1,
    )

    recovery_posts = 0
    seen_get_urls: list[str] = []

    def stale_post_transport(url: str, _body: bytes, _headers: dict[str, str]):
        nonlocal recovery_posts
        if url.endswith("/access_tokens"):
            return (
                201,
                {},
                json.dumps(
                    {
                        "token": "".join(("ghs_", "RecoveryGrant")),
                        "permissions": {"issues": "write", "metadata": "read"},
                        "repositories": [{"name": "private-triage"}],
                    }
                ).encode(),
            )
        recovery_posts += 1
        return 201, {}, json.dumps({"number": 999}).encode()

    def stale_page2_closed_get_transport(url: str, _headers: dict[str, str]):
        seen_get_urls.append(url)
        assert "state=all" in url and "since=" in url and "per_page=100" in url
        if url.endswith("&page=1"):
            page1 = [{"number": idx, "state": "open", "body": "Unrelated"} for idx in range(1, 101)]
            return 200, {}, json.dumps(page1).encode("utf-8")
        page2 = [
            {
                "number": 604,
                "state": "closed",
                "body": f"{bug_report_issue_marker(stale_id)}\n\n## Zero-PII In-App Bug Report",
            }
        ]
        return 200, {}, json.dumps(page2).encode("utf-8")

    recovered_stale = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        transport=stale_post_transport,
        get_transport=stale_page2_closed_get_transport,
    )
    assert recovered_stale.dispatched == 1
    assert recovered_stale.issue_numbers == (604,)
    assert recovery_posts == 0
    assert len(seen_get_urls) == 2
    reconciled = BugReport.objects.get(pk=stale_id)
    assert reconciled.github_issue_number == 604
    assert reconciled.sanitized_note == ""
    assert reconciled.claimed_at is None and reconciled.claim_token == ""

    # Unexhausted pagination ceiling (10 full pages without finding marker) fails closed with 0 POSTs.
    ceiling_receipt = assert_created(
        post_bug(w, w.admin, default_body(error_code="STALE_PAGINATION_CEILING"))
    )
    ceiling_id = uuid.UUID(ceiling_receipt["id"])
    BugReport.objects.filter(pk=ceiling_id).update(
        claimed_at=timezone.now() - timedelta(seconds=360),
        claim_token=uuid.uuid4().hex,
        dispatch_attempts=1,
    )

    ceiling_pages_requested = 0

    def unexhausted_get_transport(_url: str, _headers: dict[str, str]):
        nonlocal ceiling_pages_requested
        ceiling_pages_requested += 1
        full_page = [{"number": idx, "state": "closed", "body": "Other"} for idx in range(1, 101)]
        return 200, {}, json.dumps(full_page).encode("utf-8")

    aborted = dispatch_pending_bug_reports(
        app_id="424242",
        installation_id="999111",
        private_key=private_key,
        repo="kodera-hq/private-triage",
        transport=stale_post_transport,
        get_transport=unexhausted_get_transport,
    )
    assert aborted.dispatched == 0 and aborted.failed == 1
    assert ceiling_pages_requested == 10
    assert recovery_posts == 0
    ceiling_row = BugReport.objects.get(pk=ceiling_id)
    assert ceiling_row.dispatched_at is None
    assert ceiling_row.last_dispatch_error == "marker_search_pagination_unexhausted"


def test_configure_api_role_revokes_broad_insert_and_assert_writer_grants_enforces_insert_columns(
    monkeypatch,
):
    api_pwd = secrets.token_urlsafe(32)
    collab_pwd = secrets.token_urlsafe(32)
    monkeypatch.setenv("KODERA_API_DATABASE_URL", database_url("kodera_api", api_pwd))
    monkeypatch.setenv("KODERA_COLLAB_DATABASE_URL", database_url("kodera_collab", collab_pwd))
    try:
        call_command("configure_api_role", stdout=StringIO())
        with connection.cursor() as cursor:
            assert_writer_grants(cursor, "kodera_api")
            # Granting broad table-wide INSERT exposes worker columns and MUST fail assert_writer_grants.
            cursor.execute('GRANT INSERT ON TABLE "support_bugreport" TO "kodera_api"')
            with pytest.raises(DatabaseError, match="API database role refused"):
                assert_writer_grants(cursor, "kodera_api")

        # Re-running configure_api_role revokes broad INSERT and restores strict column-level grants.
        call_command("configure_api_role", stdout=StringIO())
        with connection.cursor() as cursor:
            assert_writer_grants(cursor, "kodera_api")

        with acting_as("kodera_api"):
            assert (
                refused(
                    "INSERT INTO support_bugreport "
                    "(id, created_at, updated_at, build_id, component, error_code, device_class, "
                    "consent, sanitized_note, dedup_fingerprint, occurrences, dispatched_at) "
                    "VALUES (gen_random_uuid(), now(), now(), 'web-0.52.0', 'calls', 'ERR_FORGED', "
                    "'web-desktop', false, '', repeat('d', 64), 1, now())"
                )
                == INSUFFICIENT_PRIVILEGE
            )
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = 'kodera_api'")
            if cursor.fetchone() is not None:
                cursor.execute('DROP OWNED BY "kodera_api"')
                cursor.execute('DROP ROLE "kodera_api"')


def test_bounded_ttl_cleanup_purges_aged_dispatched_abandoned_and_rate_events(w):
    now = timezone.now()

    old_dispatched = BugReport.objects.create(
        build_id="web-0.52.0",
        component="calls",
        error_code="AGED_DISPATCHED",
        device_class="web-desktop",
        consent=False,
        sanitized_note="",
        dedup_fingerprint="1" * 64,
        occurrences=1,
        dispatched_at=now - timedelta(days=8),
        github_issue_number=10,
    )
    BugReport.objects.filter(pk=old_dispatched.pk).update(created_at=now - timedelta(days=8))

    fresh_dispatched = BugReport.objects.create(
        build_id="web-0.52.0",
        component="calls",
        error_code="FRESH_DISPATCHED",
        device_class="web-desktop",
        consent=False,
        sanitized_note="",
        dedup_fingerprint="2" * 64,
        occurrences=1,
        dispatched_at=now - timedelta(days=2),
        github_issue_number=11,
    )

    abandoned = BugReport.objects.create(
        build_id="web-0.52.0",
        component="workspace",
        error_code="ABANDONED_UNDISPATCHED",
        device_class="web-desktop",
        consent=True,
        sanitized_note="Old undispatched note",
        dedup_fingerprint="3" * 64,
        occurrences=1,
        dispatch_attempts=5,
        last_dispatch_error="http_502",
    )
    BugReport.objects.filter(pk=abandoned.pk).update(created_at=now - timedelta(days=15))

    fresh_pending = BugReport.objects.create(
        build_id="web-0.52.0",
        component="workspace",
        error_code="FRESH_PENDING",
        device_class="web-desktop",
        consent=False,
        sanitized_note="",
        dedup_fingerprint="4" * 64,
        occurrences=1,
    )

    expired_rate = BugReportRateEvent.objects.create(tier="global", bucket_digest="5" * 64)
    BugReportRateEvent.objects.filter(pk=expired_rate.pk).update(
        created_at=now - timedelta(hours=3)
    )
    active_rate = BugReportRateEvent.objects.create(tier="global", bucket_digest="6" * 64)

    purge_out = StringIO()
    call_command("dispatch_bug_reports", "--purge-only", "--json", stdout=purge_out)
    parsed = json.loads(purge_out.getvalue())
    assert parsed == {
        "purged_dispatched": 1,
        "purged_undispatched": 1,
        "purged_rate_events": 1,
    }

    assert not BugReport.objects.filter(pk=old_dispatched.pk).exists()
    assert not BugReport.objects.filter(pk=abandoned.pk).exists()
    assert not BugReportRateEvent.objects.filter(pk=expired_rate.pk).exists()
    assert BugReport.objects.filter(pk=fresh_dispatched.pk).exists()
    assert BugReport.objects.filter(pk=fresh_pending.pk).exists()
    assert BugReportRateEvent.objects.filter(pk=active_rate.pk).exists()

    # Calling `purge_expired_bug_report_data` directly when nothing is expired deletes 0 rows.
    second_pass = purge_expired_bug_report_data(now=now)
    assert (
        second_pass.dispatched_deleted == 0
        and second_pass.undispatched_deleted == 0
        and second_pass.rate_events_deleted == 0
    )
