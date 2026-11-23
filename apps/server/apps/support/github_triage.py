"""Worker-only scoped GitHub App private triage queue dispatcher (ADR-0003).

Never imported by the HTTP API image. Mints a short-lived RS256 GitHub App JWT (`exp = now + 300`),
exchanges a repository- and permission-scoped installation token (`issues: write` on one private
triage repository only) over SSRF-pinned `apps.media.outbound` (`https://api.github.com`, no
redirects, 5 s deadline), and posts sanitized zero-PII Markdown issues with a 5-failure / 300 s
upstream circuit breaker.
"""

from __future__ import annotations

import json
import math
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.media import outbound

from .bug_reports import (
    RATE_EVENT_RETENTION,
    find_forbidden_note_reasons,
    is_safe_build_id,
    is_safe_error_code,
    scrub_bug_report_note,
)
from .models import (
    BUG_COMPONENTS,
    BUG_DEVICE_CLASSES,
    BugReport,
    BugReportCircuitState,
    BugReportRateEvent,
)

GITHUB_API_HOST = "api.github.com"
GITHUB_API_ORIGIN = "https://api.github.com"
OUTBOUND_DEADLINE_SECONDS = 5.0
APP_JWT_EXP_SECONDS = 300
APP_JWT_CLOCK_SKEW_SECONDS = 30
CLAIM_LEASE_SECONDS = 300
CIRCUIT_FAILURE_THRESHOLD = 5
CIRCUIT_COOLDOWN_SECONDS = 300
DISPATCHED_RETENTION = timedelta(days=7)
UNDISPATCHED_RETENTION = timedelta(days=14)
MARKER_SEARCH_PAGE_SIZE = 100
MARKER_SEARCH_MAX_PAGES = 10
MARKER_SEARCH_CLOCK_SKEW = timedelta(seconds=60)
MAX_KEY_FILE_BYTES = 16384
MAX_GITHUB_RESPONSE_BYTES = 256 * 1024

NUMERIC_ID_RE = re.compile(r"^[1-9][0-9]{0,19}\Z")
REPO_FULL_NAME_RE = re.compile(
    r"^(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/(?P<repo>[A-Za-z0-9._-]{1,100})\Z"
)

OutboundPostFn = Callable[[str, bytes, dict[str, str]], tuple[int, dict[str, str], bytes]]
OutboundGetFn = Callable[[str, dict[str, str]], tuple[int, dict[str, str], bytes]]


class GitHubTriageConfigError(ValueError):
    """Invalid worker flag, key file, or repository coordinate."""


class GitHubUpstreamError(RuntimeError):
    """Transient or upstream refusal from GitHub REST API."""

    def __init__(self, code: str) -> None:
        super().__init__(f"GitHub upstream error: {code}")
        self.code = code


@dataclass(frozen=True, slots=True)
class BugReportPurgeSummary:
    dispatched_deleted: int
    undispatched_deleted: int
    rate_events_deleted: int


@dataclass(frozen=True, slots=True)
class DispatchBatchSummary:
    dispatched: int
    failed: int
    circuit_open: bool
    cooldown_remaining_s: int
    issue_numbers: tuple[int, ...]
    purged_dispatched: int = 0
    purged_undispatched: int = 0
    purged_rate_events: int = 0


def parse_triage_repo(repo: str) -> tuple[str, str]:
    """Validate `owner/repo` and return `(owner, repo_name)`."""
    match = REPO_FULL_NAME_RE.fullmatch(repo.strip())
    if match is None or match.group("repo") in {".", ".."}:
        raise GitHubTriageConfigError("repository must match owner/repo")
    return match.group("owner"), match.group("repo")


def validate_numeric_id(value: str, label: str) -> str:
    cleaned = value.strip()
    if NUMERIC_ID_RE.fullmatch(cleaned) is None:
        raise GitHubTriageConfigError(f"{label} must be a positive decimal integer")
    return cleaned


def load_github_app_private_key(key_file: Path) -> rsa.RSAPrivateKey:
    """Load and validate a worker-mounted RSA >= 2048-bit PEM private key."""
    try:
        with key_file.open("rb") as handle:
            raw = handle.read(MAX_KEY_FILE_BYTES + 1)
        if len(raw) > MAX_KEY_FILE_BYTES:
            raise ValueError("key file too large")
        loaded = serialization.load_pem_private_key(raw, password=None)
        del raw
    except (OSError, ValueError, TypeError):
        raise GitHubTriageConfigError("worker GitHub App RSA private key is unavailable") from None
    if not isinstance(loaded, rsa.RSAPrivateKey) or loaded.key_size < 2048:
        raise GitHubTriageConfigError("worker GitHub App key must be an RSA >= 2048-bit key")
    return loaded


def mint_github_app_jwt(
    *,
    app_id: str,
    private_key: rsa.RSAPrivateKey,
    now_epoch: int | None = None,
) -> str:
    """Mint a short-lived RS256 GitHub App JWT (`exp = now + 300`)."""
    issuer = validate_numeric_id(app_id, "app_id")
    now_s = int(time.time()) if now_epoch is None else int(now_epoch)
    claims = {
        "iat": now_s - APP_JWT_CLOCK_SKEW_SECONDS,
        "exp": now_s + APP_JWT_EXP_SECONDS,
        "iss": issuer,
    }
    return jwt.encode(claims, private_key, algorithm="RS256")


def _pinned_github_request(
    method: str, url: str, body: bytes | None, headers: dict[str, str]
) -> tuple[int, dict[str, str], bytes]:
    """Execute one HTTPS-only, DNS-pinned, 5 s-bounded request to `api.github.com`."""
    try:
        destination = outbound.target(url, https_only=True)
    except outbound.BlockedTargetError as blocked:
        raise GitHubUpstreamError(blocked.reason) from None

    if (
        destination.scheme != "https"
        or destination.host != GITHUB_API_HOST
        or destination.port != 443
    ):
        raise GitHubUpstreamError("unexpected_host")

    deadline = time.monotonic() + OUTBOUND_DEADLINE_SECONDS
    try:
        conn, response = outbound.request(
            destination,
            deadline=deadline,
            method=method,
            body=body,
            headers=headers,
            pool="webhook",
            scope_key="github-bug-triage",
        )
    except outbound.BlockedTargetError as blocked:
        raise GitHubUpstreamError(blocked.reason) from None
    except outbound.FetchError as failed:
        raise GitHubUpstreamError(failed.reason) from None

    try:
        status = int(response.status)
        resp_headers = {k.lower(): v for k, v in response.getheaders()}
        raw = response.read(MAX_GITHUB_RESPONSE_BYTES + 1)
        if len(raw) > MAX_GITHUB_RESPONSE_BYTES:
            raise GitHubUpstreamError("response_too_large")
        return status, resp_headers, raw
    except outbound.FetchError as failed:
        raise GitHubUpstreamError(failed.reason) from None
    except OSError:
        raise GitHubUpstreamError("read_failed") from None
    finally:
        conn.close()


def _pinned_github_post(
    url: str, body: bytes, headers: dict[str, str]
) -> tuple[int, dict[str, str], bytes]:
    return _pinned_github_request("POST", url, body, headers)


def _pinned_github_get(url: str, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    return _pinned_github_request("GET", url, None, headers)


def _get_github_json_list(
    *,
    path: str,
    bearer_token: str,
    get_transport: OutboundGetFn | None = None,
) -> list[Any]:
    if not path.startswith("/"):
        raise GitHubTriageConfigError("GitHub API path must start with '/'")
    url = f"{GITHUB_API_ORIGIN}{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {bearer_token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kodera-bug-triage-worker/1.0",
    }
    reader = _pinned_github_get if get_transport is None else get_transport
    status, _resp_headers, raw = reader(url, headers)
    if 300 <= status < 400:
        raise GitHubUpstreamError("redirect_refused")
    if status != 200:
        raise GitHubUpstreamError(f"http_{status}")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise GitHubUpstreamError("invalid_json") from None
    if not isinstance(parsed, list):
        raise GitHubUpstreamError("invalid_json")
    return parsed


def _post_github_json(
    *,
    path: str,
    bearer_token: str,
    payload: dict[str, Any],
    transport: OutboundPostFn | None = None,
) -> dict[str, Any]:
    if not path.startswith("/"):
        raise GitHubTriageConfigError("GitHub API path must start with '/'")
    url = f"{GITHUB_API_ORIGIN}{path}"
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {bearer_token}",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kodera-bug-triage-worker/1.0",
    }
    sender = _pinned_github_post if transport is None else transport
    status, _resp_headers, raw = sender(url, encoded, headers)

    # Refuse all redirects explicitly: never follow Location headers.
    if 300 <= status < 400:
        raise GitHubUpstreamError("redirect_refused")
    if status not in {200, 201}:
        raise GitHubUpstreamError(f"http_{status}")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise GitHubUpstreamError("invalid_json") from None
    if not isinstance(parsed, dict):
        raise GitHubUpstreamError("invalid_json")
    return parsed


def exchange_scoped_installation_token(
    *,
    app_id: str,
    installation_id: str,
    private_key: rsa.RSAPrivateKey,
    repo_name: str,
    now_epoch: int | None = None,
    transport: OutboundPostFn | None = None,
) -> str:
    """Exchange an RS256 App JWT for an installation token scoped strictly to one repository
    and `issues: write`."""
    inst_id = validate_numeric_id(installation_id, "installation_id")
    if not repo_name or "/" in repo_name:
        raise GitHubTriageConfigError("repo_name must be a single repository name")
    app_jwt = mint_github_app_jwt(
        app_id=app_id,
        private_key=private_key,
        now_epoch=now_epoch,
    )
    scoped_request = {
        "repositories": [repo_name],
        "permissions": {"issues": "write"},
    }
    data = _post_github_json(
        path=f"/app/installations/{inst_id}/access_tokens",
        bearer_token=app_jwt,
        payload=scoped_request,
        transport=transport,
    )
    token = data.get("token")
    if not isinstance(token, str) or not token.strip():
        raise GitHubUpstreamError("missing_installation_token")

    permissions = data.get("permissions")
    if permissions is not None:
        if not isinstance(permissions, dict):
            raise GitHubUpstreamError("invalid_token_permissions")
        if set(permissions) - {"issues", "metadata"} or permissions.get("issues") != "write":
            raise GitHubUpstreamError("excess_token_permissions")

    repositories = data.get("repositories")
    if repositories is not None:
        if not isinstance(repositories, list) or len(repositories) != 1:
            raise GitHubUpstreamError("unexpected_repository_scope")
        entry = repositories[0]
        if isinstance(entry, dict) and entry.get("name") not in {None, repo_name}:
            raise GitHubUpstreamError("unexpected_repository_scope")

    return token


def bug_report_issue_marker(report_id: UUID) -> str:
    """Deterministic zero-PII HTML comment marker preventing duplicate GitHub issues on retry."""
    return f"<!-- kodera-bug-report-id: {report_id} -->"


def build_zero_pii_github_issue(report: BugReport) -> dict[str, Any]:
    """Construct a zero-PII Markdown GitHub issue payload from a queued `BugReport`."""
    component = report.component if report.component in BUG_COMPONENTS else "other"
    device_class = (
        report.device_class if report.device_class in BUG_DEVICE_CLASSES else "web-desktop"
    )
    build_id = report.build_id if is_safe_build_id(report.build_id) else "redacted-build"
    error_code = (
        report.error_code if is_safe_error_code(report.error_code) else "REDACTED_ERROR_CODE"
    )

    lines = [
        bug_report_issue_marker(report.id),
        "",
        "## Zero-PII In-App Bug Report",
        "",
        f"- **report_id**: `{report.id}`",
        f"- **build_id**: `{build_id}`",
        f"- **component**: `{component}`",
        f"- **error_code**: `{error_code}`",
        f"- **device_class**: `{device_class}`",
        f"- **dedup_fingerprint**: `{report.dedup_fingerprint}`",
        f"- **occurrences**: `{report.occurrences}`",
        f"- **consent**: `{str(bool(report.consent)).lower()}`",
        f"- **queued_at**: `{report.created_at.isoformat().replace('+00:00', 'Z')}`",
    ]

    if report.consent and report.screenshot_bytes and report.screenshot_content_type:
        byte_len = len(bytes(report.screenshot_bytes))
        lines.extend(
            [
                "",
                "### Blurred Screenshot Attachment (Stored in Triage Queue)",
                f"- **content_type**: `{report.screenshot_content_type}`",
                f"- **size_bytes**: `{byte_len}`",
                f"- **sha256**: `{report.screenshot_sha256 or ''}`",
                "- **blurred**: `true`",
            ]
        )

    if report.consent and report.sanitized_note:
        if find_forbidden_note_reasons(report.sanitized_note):
            safe_note = "[OMITTED_FORBIDDEN_PATTERN]"
        else:
            safe_note = scrub_bug_report_note(report.sanitized_note)
        safe_fence_body = safe_note.replace("~~~", "~ ~ ~").replace("```", "` ` `")
        lines.extend(
            [
                "",
                "### Sanitized Diagnostic Note",
                "~~~text",
                safe_fence_body,
                "~~~",
            ]
        )

    return {
        "title": f"[Bug] {component}: {error_code} ({device_class})",
        "body": "\n".join(lines),
        "labels": [
            f"component:{component}",
            f"device:{device_class}",
            "source:zero-pii-bug-report",
        ],
    }


def _record_circuit_failure(reason: str) -> tuple[bool, int]:
    """Increment consecutive upstream failures and open the circuit at 5 failures."""
    with transaction.atomic():
        now = timezone.now()
        circuit, _ = BugReportCircuitState.objects.select_for_update().get_or_create(singleton=True)
        circuit.consecutive_failures += 1
        circuit.last_failure_at = now
        circuit.last_error_code = reason[:80]
        tripped = circuit.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD
        if tripped:
            cooldown_end = now + timedelta(seconds=CIRCUIT_COOLDOWN_SECONDS)
            if circuit.opened_until is None or circuit.opened_until < cooldown_end:
                circuit.opened_until = cooldown_end
        circuit.save(
            update_fields=[
                "consecutive_failures",
                "last_failure_at",
                "last_error_code",
                "opened_until",
                "updated_at",
            ]
        )
        remaining = (
            max(1, math.ceil((circuit.opened_until - now).total_seconds()))
            if circuit.opened_until is not None and circuit.opened_until > now
            else 0
        )
        return tripped, remaining


def _reset_circuit() -> None:
    with transaction.atomic():
        circuit, _ = BugReportCircuitState.objects.select_for_update().get_or_create(singleton=True)
        if (
            circuit.consecutive_failures != 0
            or circuit.opened_until is not None
            or circuit.last_error_code != ""
        ):
            circuit.consecutive_failures = 0
            circuit.opened_until = None
            circuit.last_error_code = ""
            circuit.save(
                update_fields=[
                    "consecutive_failures",
                    "opened_until",
                    "last_error_code",
                    "updated_at",
                ]
            )


def _check_circuit_open() -> tuple[bool, int]:
    with transaction.atomic():
        now = timezone.now()
        circuit, _ = BugReportCircuitState.objects.select_for_update().get_or_create(singleton=True)
        if circuit.opened_until is not None and circuit.opened_until > now:
            remaining = max(1, math.ceil((circuit.opened_until - now).total_seconds()))
            return True, remaining
        return False, 0


def purge_expired_bug_report_data(*, now: datetime | None = None) -> BugReportPurgeSummary:
    """Enforce bounded retention across dispatched reports (7d), abandoned reports (14d), and rate events (2h)."""
    with transaction.atomic():
        ref_now = timezone.now() if now is None else now
        dispatched_cutoff = ref_now - DISPATCHED_RETENTION
        undispatched_cutoff = ref_now - UNDISPATCHED_RETENTION
        rate_cutoff = ref_now - RATE_EVENT_RETENTION

        dispatched_deleted, _ = (
            BugReport.objects.filter(dispatched_at__isnull=False)
            .filter(Q(dispatched_at__lt=dispatched_cutoff) | Q(created_at__lt=dispatched_cutoff))
            .delete()
        )
        undispatched_deleted, _ = BugReport.objects.filter(
            dispatched_at__isnull=True,
            created_at__lt=undispatched_cutoff,
        ).delete()
        rate_events_deleted, _ = BugReportRateEvent.objects.filter(
            created_at__lt=rate_cutoff
        ).delete()
        return BugReportPurgeSummary(
            dispatched_deleted=dispatched_deleted,
            undispatched_deleted=undispatched_deleted,
            rate_events_deleted=rate_events_deleted,
        )


def _find_existing_issue_by_marker(
    *,
    owner: str,
    repo_name: str,
    bearer_token: str,
    report_id: UUID,
    report_created_at: datetime,
    get_transport: OutboundGetFn | None,
    has_custom_post_transport: bool,
) -> int | None:
    """Paginate `state=all&since=...` triage issues for `report_id`'s deterministic marker.

    Inspects both open and closed issues created/updated since `report_created_at - 60s` across up
    to `MARKER_SEARCH_MAX_PAGES` pages; fails closed rather than risking duplicate issue creation
    if pagination reaches the safety ceiling unexhausted.
    """
    if has_custom_post_transport and get_transport is None:
        return None
    marker = bug_report_issue_marker(report_id)
    since_iso = (
        (report_created_at - MARKER_SEARCH_CLOCK_SKEW)
        .astimezone(UTC)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    for page in range(1, MARKER_SEARCH_MAX_PAGES + 1):
        issues = _get_github_json_list(
            path=(
                f"/repos/{owner}/{repo_name}/issues"
                f"?state=all&since={since_iso}&per_page={MARKER_SEARCH_PAGE_SIZE}&page={page}"
            ),
            bearer_token=bearer_token,
            get_transport=get_transport,
        )
        for item in issues:
            if not isinstance(item, dict):
                continue
            body = item.get("body")
            number = item.get("number")
            if isinstance(body, str) and marker in body and isinstance(number, int) and number >= 1:
                return number
        if len(issues) < MARKER_SEARCH_PAGE_SIZE:
            return None
    raise GitHubUpstreamError("marker_search_pagination_unexhausted")


def dispatch_pending_bug_reports(
    *,
    app_id: str,
    installation_id: str,
    private_key: rsa.RSAPrivateKey,
    repo: str,
    max_jobs: int = 25,
    transport: OutboundPostFn | None = None,
    get_transport: OutboundGetFn | None = None,
) -> DispatchBatchSummary:
    """Dispatch up to `max_jobs` undispatched `BugReport` rows to the private triage repository."""
    if not 1 <= max_jobs <= 500:
        raise GitHubTriageConfigError("max_jobs must be between 1 and 500")
    owner, repo_name = parse_triage_repo(repo)
    validate_numeric_id(app_id, "app_id")
    validate_numeric_id(installation_id, "installation_id")

    purged = purge_expired_bug_report_data()

    is_open, cooldown_s = _check_circuit_open()
    if is_open:
        return DispatchBatchSummary(
            dispatched=0,
            failed=0,
            circuit_open=True,
            cooldown_remaining_s=cooldown_s,
            issue_numbers=(),
            purged_dispatched=purged.dispatched_deleted,
            purged_undispatched=purged.undispatched_deleted,
            purged_rate_events=purged.rate_events_deleted,
        )

    stale_probe = timezone.now() - timedelta(seconds=CLAIM_LEASE_SECONDS)
    if not (
        BugReport.objects.filter(dispatched_at__isnull=True)
        .filter(Q(claimed_at__isnull=True) | Q(claimed_at__lt=stale_probe))
        .exists()
    ):
        return DispatchBatchSummary(
            dispatched=0,
            failed=0,
            circuit_open=False,
            cooldown_remaining_s=0,
            issue_numbers=(),
            purged_dispatched=purged.dispatched_deleted,
            purged_undispatched=purged.undispatched_deleted,
            purged_rate_events=purged.rate_events_deleted,
        )

    try:
        installation_token = exchange_scoped_installation_token(
            app_id=app_id,
            installation_id=installation_id,
            private_key=private_key,
            repo_name=repo_name,
            transport=transport,
        )
    except GitHubUpstreamError as error:
        tripped, remaining = _record_circuit_failure(error.code)
        return DispatchBatchSummary(
            dispatched=0,
            failed=1,
            circuit_open=tripped,
            cooldown_remaining_s=remaining,
            issue_numbers=(),
            purged_dispatched=purged.dispatched_deleted,
            purged_undispatched=purged.undispatched_deleted,
            purged_rate_events=purged.rate_events_deleted,
        )

    dispatched = 0
    failed = 0
    created_numbers: list[int] = []
    attempted_ids: set[UUID] = set()

    for _ in range(max_jobs):
        is_open, cooldown_s = _check_circuit_open()
        if is_open:
            return DispatchBatchSummary(
                dispatched=dispatched,
                failed=failed,
                circuit_open=True,
                cooldown_remaining_s=cooldown_s,
                issue_numbers=tuple(created_numbers),
                purged_dispatched=purged.dispatched_deleted,
                purged_undispatched=purged.undispatched_deleted,
                purged_rate_events=purged.rate_events_deleted,
            )

        with transaction.atomic():
            claim_now = timezone.now()
            stale_cutoff = claim_now - timedelta(seconds=CLAIM_LEASE_SECONDS)
            report = (
                BugReport.objects.select_for_update(skip_locked=True)
                .filter(dispatched_at__isnull=True)
                .filter(Q(claimed_at__isnull=True) | Q(claimed_at__lt=stale_cutoff))
                .exclude(pk__in=attempted_ids)
                .order_by("created_at")
                .first()
            )
            if report is None:
                break
            attempted_ids.add(report.id)
            prior_attempt_may_have_posted = (
                report.claimed_at is not None or report.dispatch_attempts > 0
            )
            lease_id = secrets.token_hex(16)
            report.claimed_at = claim_now
            report.claim_token = lease_id
            report.save(update_fields=["claimed_at", "claim_token", "updated_at"])
            issue_payload = build_zero_pii_github_issue(report)

        try:
            existing_issue_number: int | None = None
            if prior_attempt_may_have_posted:
                existing_issue_number = _find_existing_issue_by_marker(
                    owner=owner,
                    repo_name=repo_name,
                    bearer_token=installation_token,
                    report_id=report.id,
                    report_created_at=report.created_at,
                    get_transport=get_transport,
                    has_custom_post_transport=transport is not None,
                )
            if existing_issue_number is not None:
                issue_number = existing_issue_number
            else:
                created = _post_github_json(
                    path=f"/repos/{owner}/{repo_name}/issues",
                    bearer_token=installation_token,
                    payload=issue_payload,
                    transport=transport,
                )
                raw_number = created.get("number")
                if not isinstance(raw_number, int) or raw_number < 1:
                    raise GitHubUpstreamError("missing_issue_number")
                issue_number = raw_number
        except GitHubUpstreamError as error:
            failed += 1
            ambiguous_delivery = error.code in {
                "read_failed",
                "timeout",
                "marker_search_pagination_unexhausted",
            }
            with transaction.atomic():
                update_kwargs: dict[str, Any] = {
                    "dispatch_attempts": F("dispatch_attempts") + 1,
                    "last_dispatch_error": error.code[:80],
                    "updated_at": timezone.now(),
                }
                if not ambiguous_delivery:
                    update_kwargs["claimed_at"] = None
                    update_kwargs["claim_token"] = ""
                BugReport.objects.filter(
                    pk=report.id,
                    dispatched_at__isnull=True,
                    claim_token=lease_id,
                ).update(**update_kwargs)
            tripped, remaining = _record_circuit_failure(error.code)
            if tripped:
                return DispatchBatchSummary(
                    dispatched=dispatched,
                    failed=failed,
                    circuit_open=True,
                    cooldown_remaining_s=remaining,
                    issue_numbers=tuple(created_numbers),
                    purged_dispatched=purged.dispatched_deleted,
                    purged_undispatched=purged.undispatched_deleted,
                    purged_rate_events=purged.rate_events_deleted,
                )
            continue

        now = timezone.now()
        with transaction.atomic():
            finalized = BugReport.objects.filter(
                pk=report.id,
                dispatched_at__isnull=True,
                claim_token=lease_id,
            ).update(
                dispatched_at=now,
                github_issue_number=issue_number,
                dispatch_attempts=F("dispatch_attempts") + 1,
                sanitized_note="",
                screenshot_content_type=None,
                screenshot_bytes=None,
                screenshot_sha256=None,
                claimed_at=None,
                claim_token="",
                last_dispatch_error="",
                updated_at=now,
            )
        if finalized:
            _reset_circuit()
            dispatched += 1
            created_numbers.append(issue_number)

    return DispatchBatchSummary(
        dispatched=dispatched,
        failed=failed,
        circuit_open=False,
        cooldown_remaining_s=0,
        issue_numbers=tuple(created_numbers),
        purged_dispatched=purged.dispatched_deleted,
        purged_undispatched=purged.undispatched_deleted,
        purged_rate_events=purged.rate_events_deleted,
    )
