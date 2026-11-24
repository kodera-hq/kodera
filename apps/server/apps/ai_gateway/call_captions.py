"""Strict multi-party consent state machine and bounded chunk pipeline for live call captions."""

from __future__ import annotations

import base64
import binascii
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import connection, transaction
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.identity.selectors import realm_subjects
from apps.media import outbound
from apps.media.context import RefusalError as MediaRefusalError, caller, read_caller
from apps.media.outbound import BlockedTargetError
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.selectors import (
    active_membership_ids_by_user,
    current_members,
    organisation_authority_revision,
)
from apps.tenancy.selectors import newest_tenant_not_deleted
from apps.workspaces.ai_policy import (
    ChannelAiSnapshot,
    get_active_member_ai_consents_for_memberships,
    get_member_ai_consent_snapshot,
    get_workspace_ai_policy_snapshot,
    reconcile_workspace_ai_budget,
    refund_workspace_ai_budget,
    reserve_workspace_ai_budget,
)
from apps.workspaces.channel_access import may_view, resolve
from apps.workspaces.channel_sets import lock_workspace
from apps.workspaces.structure import WorkspaceUnavailableError
from services.identity.access_tokens import VerifiedAccessToken

from .adapters import AiCompletionRequest, AiGatewayRefusalError, AiTranscriptionRequest
from .models import (
    NON_TERMINAL_CALL_SESSION_STATES,
    LiveCallCaptionSession,
    LiveCallParticipantConsent,
)
from .services import (
    MAX_TRANSLATION_TEXT_CHARS,
    VOICE_NOTE_MIME_TYPES,
    AdmittedAiExecution,
    _actual_prompt_cost_micros,
    _actual_transcription_cost_micros,
    _caller_readable_channel,
    _estimate_prompt_cost_micros,
    _estimate_transcription_cost_micros,
    _has_valid_audio_magic,
    _is_channel_confidential,
    _require_workspace_id,
    _translate_media_refusal,
    build_hardened_translation_prompt,
    evaluate_ai_gate,
    sanitize_translated_output,
    validate_iso_target_language,
)

MAX_CALL_CHUNK_BYTES = 1_048_576  # Strict 1 MiB audio chunk bound.
MAX_CALL_CHUNK_TRANSLATION_MAX_TOKENS = 1024
MAX_CALL_CAPTION_OUTPUT_CHARS = 4096
MAX_CALL_ROSTER_PARTICIPANTS = 64
CALL_CAPTION_SESSION_TTL = timedelta(minutes=5)
CALL_INSTANCE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}\Z")
UNRESOLVED_ROSTER_PREFIX = "ext:"
SESSION_ACTIONS = frozenset(
    {"start", "consent", "sync_roster", "leave", "withdraw", "end", "set_language"}
)


class LiveCallCaptionsUnavailableError(AiGatewayRefusalError):
    """Fail-closed 503 refusal when authoritative LiveKit/Synapse roster verification is unavailable."""

    def __init__(self, reason: str = "ai_livekit_roster_unavailable") -> None:
        super().__init__(503, reason, "service-unavailable")


@dataclass(frozen=True)
class ResolvedCallRoster:
    membership_ids: tuple[UUID, ...]
    external_tokens: tuple[str, ...]

    @property
    def unresolved_count(self) -> int:
        return len(self.external_tokens)


@dataclass(frozen=True)
class PreparedLiveCallSession:
    action: str
    call_instance_id: str | None
    authoritative_roster: ResolvedCallRoster | None


@dataclass
class PreparedLiveCallChunk:
    organisation_id: UUID
    workspace_id: UUID
    channel_id: UUID
    session_id: UUID
    call_instance_id: str
    expected_generation: int
    body: dict[str, Any] = field(repr=False)
    post_authoritative_roster: ResolvedCallRoster | None = None
    source_text: str = field(default="", repr=False)
    translated_text: str = field(default="", repr=False)
    source_language: str = "fr"
    target_language: str = "fr"
    provider: str = "mistral"
    model: str = "voxtral-mini-latest"
    reserved_micros: int = 0
    actual_micros: int = 0
    settled: bool = False


def _parse_optional_uuid(raw: Any, *, field_name: str) -> UUID | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise AiGatewayRefusalError(422, f"invalid_{field_name}", "validation-error")
    try:
        return UUID(raw)
    except ValueError:
        raise AiGatewayRefusalError(422, f"invalid_{field_name}", "validation-error") from None


def _parse_required_uuid(raw: Any, *, field_name: str) -> UUID:
    parsed = _parse_optional_uuid(raw, field_name=field_name)
    if parsed is None:
        raise AiGatewayRefusalError(422, f"invalid_{field_name}", "validation-error")
    return parsed


def _validate_optional_call_instance_id(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or CALL_INSTANCE_ID_RE.fullmatch(raw) is None:
        raise AiGatewayRefusalError(422, "invalid_call_instance_id", "validation-error")
    return raw


def _validate_required_call_instance_id(raw: Any) -> str:
    validated = _validate_optional_call_instance_id(raw)
    if validated is None:
        raise AiGatewayRefusalError(422, "invalid_call_instance_id", "validation-error")
    return validated


def _validate_required_generation(raw: Any) -> int:
    if type(raw) is not int or raw < 1:
        raise AiGatewayRefusalError(422, "invalid_generation", "validation-error")
    return raw


def _parse_matrix_mxid(raw_user_id: str) -> tuple[str, str] | None:
    if (
        not isinstance(raw_user_id, str)
        or not 4 <= len(raw_user_id) <= 255
        or not raw_user_id.startswith("@")
        or ":" not in raw_user_id
        or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in raw_user_id)
    ):
        return None
    localpart, _, server = raw_user_id[1:].partition(":")
    server_clean = server.strip().lower()
    if not localpart or not server_clean:
        return None
    return localpart, server_clean


_TENANT_APP_SUBDOMAIN_LABELS = frozenset({"visio", "docs", "drive", "messaging", "grist"})


def _authoritative_matrix_domains(organisation_id: UUID) -> frozenset[str]:
    """Return the exact authoritative Matrix homeserver domains owned by `organisation_id`'s tenant.

    Per ADR-0023, ONLY the tenant slug names a tenant's Matrix homeserver (`{tenant.slug}.*`),
    never `organisation.slug`. Supports production (`kodera.io`), configured
    `KODERA_MATRIX_DOMAIN_SUFFIX`, staging `KODERA_TENANT_APP_URLS` templates, and community
    self-hosted `KODERA_CONSOLE_ORIGINS`.
    """
    domains: set[str] = set()
    configured_server = getattr(settings, "KODERA_SYNAPSE_SERVER_NAME", "")
    if isinstance(configured_server, str) and configured_server.strip():
        domains.add(configured_server.strip().lower())

    domain_suffix = getattr(settings, "KODERA_MATRIX_DOMAIN_SUFFIX", "kodera.io")
    clean_suffix = (
        domain_suffix.strip().lower().lstrip(".")
        if isinstance(domain_suffix, str) and domain_suffix.strip()
        else "kodera.io"
    )

    tenant = newest_tenant_not_deleted(organisation_id)
    tenant_slug = getattr(tenant, "slug", "") if tenant is not None else ""
    if not isinstance(tenant_slug, str) or not tenant_slug.strip():
        return frozenset(domains)

    clean_slug = tenant_slug.strip().lower()
    candidate_suffixes: set[str] = {clean_suffix}

    app_urls = getattr(settings, "KODERA_TENANT_APP_URLS", None)
    if isinstance(app_urls, dict):
        for template in app_urls.values():
            if not isinstance(template, str) or "{slug}" not in template:
                continue
            rendered_host = (
                (urlsplit(template.replace("{slug}", clean_slug)).hostname or "").strip().lower()
            )
            rest = ""
            if rendered_host.startswith(f"{clean_slug}."):
                rest = rendered_host.removeprefix(f"{clean_slug}.")
            elif rendered_host.startswith(f"{clean_slug}-"):
                _prefix, _, after_first_dot = rendered_host.partition(".")
                rest = after_first_dot
            if not rest:
                continue
            first_label, _, parent_zone = rest.partition(".")
            if first_label in _TENANT_APP_SUBDOMAIN_LABELS and "." in parent_zone:
                candidate_suffixes.add(parent_zone)
            else:
                candidate_suffixes.add(rest)

    console_origins = getattr(settings, "KODERA_CONSOLE_ORIGINS", None)
    if isinstance(console_origins, str) and console_origins.strip():
        for raw_origin in console_origins.split(","):
            origin = raw_origin.strip()
            if not origin:
                continue
            origin_host = (urlsplit(origin).hostname or "").strip().lower()
            if origin_host.startswith(f"{clean_slug}."):
                rest = origin_host.removeprefix(f"{clean_slug}.")
                if rest:
                    candidate_suffixes.add(rest)

    for suffix in candidate_suffixes:
        domains.add(f"{clean_slug}.{suffix}")
        domains.add(f"matrix.{clean_slug}.{suffix}")

    return frozenset(domains)


def _resolve_call_roster(
    *,
    organisation_id: UUID,
    channel_id: UUID,
    raw_membership_ids: Any,
    raw_user_ids: Any,
    default_caller_membership_id: UUID | None = None,
) -> ResolvedCallRoster:
    if raw_membership_ids is not None and not isinstance(raw_membership_ids, list):
        raise AiGatewayRefusalError(422, "invalid_participant_roster", "validation-error")
    if raw_user_ids is not None and not isinstance(raw_user_ids, list):
        raise AiGatewayRefusalError(422, "invalid_participant_roster", "validation-error")

    supplied_memberships = list(raw_membership_ids or [])
    supplied_users = list(raw_user_ids or [])
    if len(supplied_memberships) + len(supplied_users) > MAX_CALL_ROSTER_PARTICIPANTS:
        raise AiGatewayRefusalError(422, "call_roster_too_large", "validation-error")

    if not supplied_memberships and not supplied_users:
        if default_caller_membership_id is None:
            return ResolvedCallRoster(membership_ids=(), external_tokens=())
        supplied_memberships = [str(default_caller_membership_id)]

    active_org_members = current_members(organisation_id=organisation_id)
    authority_rev = organisation_authority_revision(organisation_id=organisation_id)
    try:
        access = resolve(channel_id)
    except (ObjectDoesNotExist, WorkspaceUnavailableError):
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled") from None

    subject_to_membership: dict[str, UUID] = {}
    authoritative_domains: frozenset[str] = frozenset()
    if supplied_users:
        authoritative_domains = _authoritative_matrix_domains(organisation_id)
        user_to_membership = active_membership_ids_by_user(organisation_id=organisation_id)
        for user_id, subject, usable in realm_subjects(organisation_id=organisation_id):
            if not usable:
                continue
            mem_id = user_to_membership.get(user_id)
            if mem_id is not None:
                subject_to_membership[subject] = mem_id
                subject_to_membership[subject.lower()] = mem_id

    resolved: set[UUID] = set()
    external_tokens: set[str] = set()

    for idx, item in enumerate(supplied_memberships):
        if not isinstance(item, str):
            raise AiGatewayRefusalError(422, "invalid_participant_roster", "validation-error")
        try:
            candidate_id = UUID(item)
        except ValueError:
            external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}invalid-mem:{idx}:{item[:64]}")
            continue
        if candidate_id not in active_org_members or not may_view(
            access,
            organisation_id=organisation_id,
            membership_id=candidate_id,
            authority_revision=authority_rev,
        ):
            external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}unauthorized-mem:{candidate_id}")
            continue
        resolved.add(candidate_id)

    for idx, raw_uid in enumerate(supplied_users):
        if not isinstance(raw_uid, str):
            raise AiGatewayRefusalError(422, "invalid_participant_roster", "validation-error")
        parsed_mxid = _parse_matrix_mxid(raw_uid)
        if parsed_mxid is None:
            external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}invalid-mxid:{idx}:{raw_uid[:64]}")
            continue
        localpart, server_domain = parsed_mxid
        # Strict authoritative tenant homeserver check: `@alice:evil.example` NEVER resolves to
        # local member `alice` on `<tenant>.kodera.io`.
        if server_domain not in authoritative_domains:
            external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}@{localpart.lower()}:{server_domain}")
            continue
        matched_id = subject_to_membership.get(localpart) or subject_to_membership.get(
            localpart.lower()
        )
        if (
            matched_id is None
            or matched_id not in active_org_members
            or not may_view(
                access,
                organisation_id=organisation_id,
                membership_id=matched_id,
                authority_revision=authority_rev,
            )
        ):
            external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}@{localpart.lower()}:{server_domain}")
            continue
        resolved.add(matched_id)

    ordered = tuple(sorted(resolved, key=str))
    ordered_ext = tuple(sorted(external_tokens))
    return ResolvedCallRoster(membership_ids=ordered, external_tokens=ordered_ext)


def _split_stored_roster(
    session: LiveCallCaptionSession,
) -> tuple[tuple[UUID, ...], tuple[str, ...]]:
    resolved: list[UUID] = []
    external: list[str] = []
    raw_items = session.roster_membership_ids
    if not isinstance(raw_items, list):
        return (), ()
    for item in raw_items:
        if not isinstance(item, str):
            continue
        if item.startswith(UNRESOLVED_ROSTER_PREFIX):
            external.append(item)
            continue
        try:
            resolved.append(UUID(item))
        except ValueError:
            external.append(f"{UNRESOLVED_ROSTER_PREFIX}{item[:64]}")
    return tuple(sorted(set(resolved), key=str)), tuple(sorted(set(external)))


def _encode_stored_roster(roster: ResolvedCallRoster) -> list[str]:
    return [*(str(item) for item in roster.membership_ids), *roster.external_tokens]


def _merge_session_roster(
    existing: LiveCallCaptionSession, incoming: ResolvedCallRoster
) -> ResolvedCallRoster:
    """Monotonically union observed participants into the active session roster.

    Prevents any caller from omitting participants in `sync_roster` or `consent` to bypass missing
    consents; participants are removed ONLY via their own authenticated `action="leave"`.
    """
    existing_members, existing_ext = _split_stored_roster(existing)
    merged_members = tuple(sorted({*existing_members, *incoming.membership_ids}, key=str))
    merged_ext = tuple(sorted({*existing_ext, *incoming.external_tokens}))
    if len(merged_members) + len(merged_ext) > MAX_CALL_ROSTER_PARTICIPANTS:
        raise AiGatewayRefusalError(422, "call_roster_too_large", "validation-error")
    return ResolvedCallRoster(membership_ids=merged_members, external_tokens=merged_ext)


def _merge_rosters(left: ResolvedCallRoster, right: ResolvedCallRoster) -> ResolvedCallRoster:
    merged_members = tuple(sorted({*left.membership_ids, *right.membership_ids}, key=str))
    merged_ext = tuple(sorted({*left.external_tokens, *right.external_tokens}))
    if len(merged_members) + len(merged_ext) > MAX_CALL_ROSTER_PARTICIPANTS:
        raise AiGatewayRefusalError(422, "call_roster_too_large", "validation-error")
    return ResolvedCallRoster(membership_ids=merged_members, external_tokens=merged_ext)


LIVEKIT_ROOM_SERVICE_TIMEOUT_S = 3.0
MAX_LIVEKIT_RESPONSE_BYTES = 262_144
LIVEKIT_TOKEN_TTL_S = 60


class _LiveKitNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_LIVEKIT_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _LiveKitNoRedirect()
)


def _validate_livekit_service_url(raw_url: str, *, allow_internal: bool) -> str:
    if (
        not isinstance(raw_url, str)
        or not 1 <= len(raw_url) <= 2048
        or any(ord(ch) <= 32 or ord(ch) == 127 for ch in raw_url)
    ):
        raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except ValueError:
        raise AiGatewayRefusalError(
            503, "ai_livekit_roster_unavailable", "service-unavailable"
        ) from None
    allowed_schemes = {"http", "https"} if allow_internal else {"https"}
    if (
        parsed.scheme not in allowed_schemes
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or (port is not None and not 1 <= port <= 65535)
        or "\\" in parsed.netloc
    ):
        raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")

    if not allow_internal:
        host = parsed.hostname
        try:
            literal_ip = ipaddress.ip_address(host)
        except ValueError:
            try:
                infos = socket.getaddrinfo(
                    host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM
                )
            except OSError:
                raise AiGatewayRefusalError(
                    503, "ai_livekit_roster_unavailable", "service-unavailable"
                ) from None
            if not infos:
                raise AiGatewayRefusalError(
                    503, "ai_livekit_roster_unavailable", "service-unavailable"
                ) from None
            for info in infos:
                addr_str = str(info[4][0]).split("%", 1)[0]
                try:
                    outbound.public_address(addr_str)
                except (BlockedTargetError, ValueError):
                    raise AiGatewayRefusalError(
                        503, "ai_livekit_roster_unavailable", "service-unavailable"
                    ) from None
        else:
            try:
                outbound.public_address(str(literal_ip))
            except (BlockedTargetError, ValueError):
                raise AiGatewayRefusalError(
                    503, "ai_livekit_roster_unavailable", "service-unavailable"
                ) from None

    return raw_url.rstrip("/")


def _mint_livekit_server_token(*, api_key: str, api_secret: str, video: dict[str, Any]) -> str:
    now = int(time.time())
    claims = {
        "iss": api_key,
        "sub": "kodera-ai-gateway",
        "nbf": now - 5,
        "exp": now + LIVEKIT_TOKEN_TTL_S,
        "video": video,
    }
    return jwt.encode(claims, api_secret, algorithm="HS256")


def _default_livekit_twirp_post(
    url: str, headers: dict[str, str], body: dict[str, Any], timeout: float
) -> dict[str, Any]:
    req = urllib.request.Request(  # noqa: S310 - validated RoomService endpoint, no redirects/proxy
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with _LIVEKIT_OPENER.open(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise AiGatewayRefusalError(
                    503, "ai_livekit_roster_unavailable", "service-unavailable"
                )
            raw = resp.read(MAX_LIVEKIT_RESPONSE_BYTES + 1)
    except AiGatewayRefusalError:
        raise
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError):
        raise AiGatewayRefusalError(
            503, "ai_livekit_roster_unavailable", "service-unavailable"
        ) from None
    if not raw or len(raw) > MAX_LIVEKIT_RESPONSE_BYTES:
        raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise AiGatewayRefusalError(
            503, "ai_livekit_roster_unavailable", "service-unavailable"
        ) from None
    if not isinstance(decoded, dict):
        raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")
    return decoded


def _default_synapse_directory_get(
    url: str, headers: dict[str, str], timeout: float
) -> dict[str, Any]:
    req = urllib.request.Request(  # noqa: S310 - validated internal Synapse directory endpoint
        url,
        headers=headers,
        method="GET",
    )
    try:
        with _LIVEKIT_OPENER.open(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise LiveCallCaptionsUnavailableError()
            raw = resp.read(MAX_LIVEKIT_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        exc.close()
        if exc.code == 404:
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict") from None
        raise LiveCallCaptionsUnavailableError() from None
    except LiveCallCaptionsUnavailableError:
        raise
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError):
        raise LiveCallCaptionsUnavailableError() from None

    if not raw or len(raw) > MAX_LIVEKIT_RESPONSE_BYTES:
        raise LiveCallCaptionsUnavailableError()
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise LiveCallCaptionsUnavailableError() from None
    if not isinstance(decoded, dict):
        raise LiveCallCaptionsUnavailableError()
    return decoded


_LIVEKIT_TWIRP_POST: Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]] = (
    _default_livekit_twirp_post
)
_SYNAPSE_DIRECTORY_GET: Callable[[str, dict[str, str], float], dict[str, Any]] = (
    _default_synapse_directory_get
)


def _validate_synapse_base_url(raw_url: str) -> str:
    if (
        not isinstance(raw_url, str)
        or not 1 <= len(raw_url) <= 2048
        or any(ord(ch) <= 32 or ord(ch) == 127 for ch in raw_url)
    ):
        raise LiveCallCaptionsUnavailableError()
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except ValueError:
        raise LiveCallCaptionsUnavailableError() from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or (port is not None and not 1 <= port <= 65535)
        or "\\" in parsed.netloc
    ):
        raise LiveCallCaptionsUnavailableError()
    return raw_url.rstrip("/")


def _canonical_channel_matrix_domain(organisation_id: UUID) -> str:
    configured_server = getattr(settings, "KODERA_SYNAPSE_SERVER_NAME", "")
    if isinstance(configured_server, str) and configured_server.strip():
        return configured_server.strip().lower()

    tenant = newest_tenant_not_deleted(organisation_id)
    tenant_slug = getattr(tenant, "slug", "") if tenant is not None else ""
    if not isinstance(tenant_slug, str) or not tenant_slug.strip():
        raise LiveCallCaptionsUnavailableError()

    domain_suffix = getattr(settings, "KODERA_MATRIX_DOMAIN_SUFFIX", "kodera.io")
    clean_suffix = (
        domain_suffix.strip().lower().lstrip(".")
        if isinstance(domain_suffix, str) and domain_suffix.strip()
        else "kodera.io"
    )
    return f"{tenant_slug.strip().lower()}.{clean_suffix}"


def _resolve_channel_livekit_room_name(
    *, organisation_id: UUID, channel_id: UUID
) -> str:
    """Resolve the channel's canonical LiveKit room name strictly via Synapse's room directory.

    Matches `tenant_agent/synapse.py:110` (`#kodera-ch-{channel_id}:{matrix_domain}`) and
    `room_access/rooms.py:18` (`"kodera-" + sha256(matrix_room_id)[:32]`). Never falls back to
    caller-supplied `callInstanceId` or synthetic channel strings.
    """
    synapse_url = getattr(settings, "KODERA_SYNAPSE_URL", None)
    synapse_token = getattr(settings, "KODERA_SYNAPSE_ADMIN_TOKEN", None)
    if (
        not isinstance(synapse_url, str)
        or not synapse_url.strip()
        or not isinstance(synapse_token, str)
        or not synapse_token.strip()
    ):
        raise LiveCallCaptionsUnavailableError()

    clean_synapse_url = _validate_synapse_base_url(synapse_url.strip())
    matrix_domain = _canonical_channel_matrix_domain(organisation_id)
    alias = urllib.parse.quote(f"#kodera-ch-{channel_id}:{matrix_domain}", safe="")
    payload = _SYNAPSE_DIRECTORY_GET(
        f"{clean_synapse_url}/_matrix/client/v3/directory/room/{alias}",
        {"Authorization": f"Bearer {synapse_token.strip()}"},
        LIVEKIT_ROOM_SERVICE_TIMEOUT_S,
    )
    room_id = payload.get("room_id")
    if not isinstance(room_id, str) or not room_id.startswith("!") or len(room_id) > 255:
        raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
    return "kodera-" + hashlib.sha256(room_id.encode("utf-8")).hexdigest()[:32]


def _extract_livekit_identities_and_roster(
    *,
    organisation_id: UUID,
    channel_id: UUID,
    participants_payload: Any,
) -> ResolvedCallRoster:
    if not isinstance(participants_payload, list):
        raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")

    raw_user_ids: list[str] = []
    raw_membership_ids: list[str] = []
    extra_external_tokens: set[str] = set()
    active_seen = 0

    for idx, entry in enumerate(participants_payload):
        if isinstance(entry, str):
            raw_identity = entry.strip()
            state_val: Any = "ACTIVE"
        elif isinstance(entry, dict):
            state_val = entry.get("state", "ACTIVE")
            raw_identity_val = entry.get("identity")
            if not isinstance(raw_identity_val, str):
                extra_external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}lk-anon:{idx}")
                active_seen += 1
                continue
            raw_identity = raw_identity_val.strip()
        else:
            raise AiGatewayRefusalError(503, "ai_livekit_roster_unavailable", "service-unavailable")

        if state_val in ("DISCONNECTED", 3):
            continue
        if not raw_identity:
            extra_external_tokens.add(f"{UNRESOLVED_ROSTER_PREFIX}lk-empty:{idx}")
            active_seen += 1
            continue

        active_seen += 1
        user_part = raw_identity.split("|", 1)[0].strip()
        if user_part.startswith("@"):
            raw_user_ids.append(user_part)
        else:
            try:
                UUID(user_part)
            except ValueError:
                extra_external_tokens.add(
                    f"{UNRESOLVED_ROSTER_PREFIX}lk-ext:{user_part[:64]}"
                )
            else:
                raw_membership_ids.append(user_part)

    if active_seen == 0:
        raise AiGatewayRefusalError(409, "ai_call_no_active_livekit_participants", "conflict")
    if active_seen > MAX_CALL_ROSTER_PARTICIPANTS:
        raise AiGatewayRefusalError(422, "call_roster_too_large", "validation-error")

    base_roster = (
        _resolve_call_roster(
            organisation_id=organisation_id,
            channel_id=channel_id,
            raw_membership_ids=raw_membership_ids or None,
            raw_user_ids=raw_user_ids or None,
        )
        if (raw_membership_ids or raw_user_ids)
        else ResolvedCallRoster(membership_ids=(), external_tokens=())
    )
    merged_ext = tuple(sorted({*base_roster.external_tokens, *extra_external_tokens}))
    if len(base_roster.membership_ids) + len(merged_ext) > MAX_CALL_ROSTER_PARTICIPANTS:
        raise AiGatewayRefusalError(422, "call_roster_too_large", "validation-error")
    return ResolvedCallRoster(membership_ids=base_roster.membership_ids, external_tokens=merged_ext)


def _require_livekit_roster_configured() -> None:
    if getattr(settings, "KODERA_LIVEKIT_ROSTER_RESOLVER", None) is not None:
        return
    raw_url = getattr(settings, "KODERA_LIVEKIT_ROOM_SERVICE_URL", None)
    api_key = getattr(settings, "KODERA_LIVEKIT_API_KEY", None)
    api_secret = getattr(settings, "KODERA_LIVEKIT_API_SECRET", None)
    if (
        not isinstance(raw_url, str)
        or not raw_url.strip()
        or not isinstance(api_key, str)
        or not api_key.strip()
        or not isinstance(api_secret, str)
        or not api_secret.strip()
    ):
        raise LiveCallCaptionsUnavailableError()


def resolve_authoritative_livekit_roster(
    *,
    organisation_id: UUID,
    channel_id: UUID,
    required_call_instance_id: str,
) -> ResolvedCallRoster:
    """Resolve the live call's authoritative participant roster from LiveKit `RoomService`.

    Always fails closed (`503` `LiveCallCaptionsUnavailableError` / `409`) when LiveKit or Synapse
    directory verification is unconfigured, unreachable, empty, or mismatched on `sid`. Never
    executes outbound Synapse/LiveKit HTTP inside an active database transaction.
    """
    hook = getattr(settings, "KODERA_LIVEKIT_ROSTER_RESOLVER", None)
    if hook is not None:
        if not callable(hook):
            raise LiveCallCaptionsUnavailableError()
        try:
            hook_result = hook(
                organisation_id=organisation_id,
                channel_id=channel_id,
                required_call_instance_id=required_call_instance_id,
            )
        except AiGatewayRefusalError:
            raise
        except Exception:
            raise LiveCallCaptionsUnavailableError() from None
        if hook_result is None:
            raise LiveCallCaptionsUnavailableError()
        if isinstance(hook_result, ResolvedCallRoster):
            if not hook_result.membership_ids and not hook_result.external_tokens:
                raise AiGatewayRefusalError(
                    409, "ai_call_no_active_livekit_participants", "conflict"
                )
            return hook_result
        if isinstance(hook_result, dict):
            hook_sid = (
                hook_result.get("sid")
                or hook_result.get("roomSid")
                or hook_result.get("room_sid")
            )
            if hook_sid is not None and (
                not isinstance(hook_sid, str) or hook_sid.strip() != required_call_instance_id
            ):
                raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
            return _extract_livekit_identities_and_roster(
                organisation_id=organisation_id,
                channel_id=channel_id,
                participants_payload=hook_result.get("participants"),
            )
        if isinstance(hook_result, (list, tuple)):
            return _extract_livekit_identities_and_roster(
                organisation_id=organisation_id,
                channel_id=channel_id,
                participants_payload=list(hook_result),
            )
        raise LiveCallCaptionsUnavailableError()

    if connection.in_atomic_block:
        raise RuntimeError("LiveKit/Synapse HTTP forbidden inside atomic block")

    raw_url = getattr(settings, "KODERA_LIVEKIT_ROOM_SERVICE_URL", None)
    api_key = getattr(settings, "KODERA_LIVEKIT_API_KEY", None)
    api_secret = getattr(settings, "KODERA_LIVEKIT_API_SECRET", None)
    if (
        not isinstance(raw_url, str)
        or not raw_url.strip()
        or not isinstance(api_key, str)
        or not api_key.strip()
        or not isinstance(api_secret, str)
        or not api_secret.strip()
    ):
        raise LiveCallCaptionsUnavailableError()

    allow_internal = getattr(settings, "KODERA_LIVEKIT_ALLOW_INTERNAL_URL", False) is True
    base_url = _validate_livekit_service_url(raw_url.strip(), allow_internal=allow_internal)
    canonical_room_name = _resolve_channel_livekit_room_name(
        organisation_id=organisation_id,
        channel_id=channel_id,
    )

    list_jwt = _mint_livekit_server_token(
        api_key=api_key,
        api_secret=api_secret,
        video={"roomList": True},
    )
    rooms_ans = _LIVEKIT_TWIRP_POST(
        f"{base_url}/twirp/livekit.RoomService/ListRooms",
        {"Authorization": f"Bearer {list_jwt}"},
        {"names": [canonical_room_name]},
        LIVEKIT_ROOM_SERVICE_TIMEOUT_S,
    )
    rooms_list = rooms_ans.get("rooms")
    if not isinstance(rooms_list, list):
        raise LiveCallCaptionsUnavailableError()
    matched_room = next(
        (
            candidate
            for candidate in rooms_list
            if isinstance(candidate, dict) and candidate.get("name") == canonical_room_name
        ),
        None,
    )
    if matched_room is None:
        raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
    reported_sid = matched_room.get("sid")
    if (
        not isinstance(reported_sid, str)
        or not reported_sid.strip()
        or reported_sid.strip() != required_call_instance_id
    ):
        raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")

    admin_jwt = _mint_livekit_server_token(
        api_key=api_key,
        api_secret=api_secret,
        video={"roomAdmin": True, "room": canonical_room_name},
    )
    answer = _LIVEKIT_TWIRP_POST(
        f"{base_url}/twirp/livekit.RoomService/ListParticipants",
        {"Authorization": f"Bearer {admin_jwt}"},
        {"room": canonical_room_name},
        LIVEKIT_ROOM_SERVICE_TIMEOUT_S,
    )

    return _extract_livekit_identities_and_roster(
        organisation_id=organisation_id,
        channel_id=channel_id,
        participants_payload=answer.get("participants"),
    )


def _evaluate_roster_consents(
    *,
    session: LiveCallCaptionSession,
    roster_memberships: tuple[UUID, ...],
    unresolved_count: int,
    for_update: bool = False,
    ingested_at: datetime | None = None,
) -> tuple[int, int, bool]:
    """Return `(consented_count, unconsented_count, any_withdrawn)` for `roster_memberships`."""
    consent_qs = (
        LiveCallParticipantConsent.objects.select_for_update()
        if for_update
        else LiveCallParticipantConsent.objects
    )
    rows = list(consent_qs.filter(session_id=session.id).order_by("id"))
    any_withdrawn = any(row.state == "withdrawn" for row in rows)
    call_consents = {
        row.membership_id: row
        for row in rows
        if row.state == "consented"
        and row.consented_at is not None
        and row.withdrawn_at is None
        and (ingested_at is None or row.consented_at <= ingested_at)
    }

    member_consents = get_active_member_ai_consents_for_memberships(
        organisation_id=session.organisation_id,
        workspace_id=session.workspace_id,
        membership_ids=roster_memberships,
        for_update=for_update,
    )
    consented_count = 0
    missing_for_resolved = 0
    for mem_id in roster_memberships:
        member_consent = member_consents.get(mem_id)
        member_ok = (
            member_consent is not None
            and member_consent.enabled
            and member_consent.revoked_at is None
            and member_consent.consented_at is not None
            and (ingested_at is None or member_consent.consented_at <= ingested_at)
        )
        if member_ok and mem_id in call_consents:
            consented_count += 1
        else:
            missing_for_resolved += 1

    unconsented_count = unresolved_count + missing_for_resolved
    return consented_count, unconsented_count, any_withdrawn


def _abort_inflight_and_refund_locked_session(session: LiveCallCaptionSession) -> int:
    """Refund any in-flight reserved budget on a locked session."""
    refunded = int(session.in_flight_reserved_micros)
    if refunded > 0:
        refund_workspace_ai_budget(
            organisation_id=session.organisation_id,
            workspace_id=session.workspace_id,
            reserved_micros=refunded,
        )
    return refunded


def _expire_stale_locked_session(session: LiveCallCaptionSession, *, now: datetime) -> bool:
    """Auto-expire a non-terminal session whose bounded TTL has elapsed."""
    if session.state not in NON_TERMINAL_CALL_SESSION_STATES:
        return False
    if session.expires_at > now:
        return False
    _abort_inflight_and_refund_locked_session(session)
    LiveCallCaptionSession.objects.filter(pk=session.id).update(
        state="ended",
        buffered_chunks_count=0,
        in_flight_reserved_micros=0,
        generation=int(session.generation) + 1,
        ended_at=now,
        updated_at=now,
    )
    session.refresh_from_db()
    return True


def _serialize_session(
    *,
    session: LiveCallCaptionSession,
    principal: TenantCaller,
) -> dict[str, Any]:
    roster, external_tokens = _split_stored_roster(session)
    consented_count, live_unconsented, _ = _evaluate_roster_consents(
        session=session,
        roster_memberships=roster,
        unresolved_count=len(external_tokens),
        for_update=False,
    )
    effective_unconsented = max(int(session.unconsented_count), live_unconsented)
    total_roster = len(roster) + len(external_tokens)
    caller_row = LiveCallParticipantConsent.objects.filter(
        session_id=session.id,
        membership_id=principal.membership_id,
    ).first()
    caller_member_consent = get_member_ai_consent_snapshot(
        organisation_id=principal.organisation_id,
        workspace_id=session.workspace_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
    )
    caller_member_enabled = bool(
        caller_member_consent
        and caller_member_consent.enabled
        and caller_member_consent.revoked_at is None
    )
    return {
        "sessionId": str(session.id),
        "callInstanceId": session.call_instance_id,
        "channelId": str(session.channel_id),
        "state": session.state,
        "targetLanguage": session.target_language,
        "rosterCount": total_roster,
        "consentedCount": consented_count,
        "unconsentedCount": effective_unconsented,
        "allConsented": (
            session.state == "active"
            and total_roster >= 1
            and effective_unconsented == 0
            and consented_count == total_roster
        ),
        "callerConsentState": caller_row.state if caller_row is not None else "pending",
        "callerMemberAiConsent": caller_member_enabled,
        "sessionEpoch": int(session.generation),
        "expiresAt": session.expires_at.isoformat(),
    }


def _require_non_confidential_call_channel(
    *,
    principal: TenantCaller,
    workspace_id: UUID,
    channel_id: UUID,
    raw_room_id: Any = None,
    for_update: bool = False,
) -> ChannelAiSnapshot:
    if raw_room_id is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
    channel = _caller_readable_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
        for_update=for_update,
    )
    if channel is None:
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled")
    if _is_channel_confidential(organisation_id=principal.organisation_id, channel=channel):
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
    return channel


def _require_org_and_channel_ai_enabled(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    channel: ChannelAiSnapshot,
    for_update: bool = False,
) -> None:
    if getattr(settings, "KODERA_AI_GATEWAY_ENABLED", False) is not True:
        raise AiGatewayRefusalError(403, "ai_gateway_disabled")
    org_policy = get_workspace_ai_policy_snapshot(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        for_update=for_update,
    )
    if org_policy is None or not org_policy.enabled:
        raise AiGatewayRefusalError(403, "ai_org_policy_disabled")
    if org_policy.eu_sovereign_only and org_policy.provider_region != "eu":
        raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
    if not channel.ai_enabled:
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled")


@transaction.atomic
def get_live_call_caption_session(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    session_id: UUID | None = None,
    call_instance_id: str | None = None,
) -> dict[str, Any]:
    validated_call_instance = _validate_optional_call_instance_id(call_instance_id)
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    workspace_id = _require_workspace_id(principal.organisation_id)
    channel = _require_non_confidential_call_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
    )
    now = timezone.now()
    instance_filter = (
        {"call_instance_id": validated_call_instance} if validated_call_instance is not None else {}
    )
    if session_id is not None:
        session = (
            LiveCallCaptionSession.objects.select_for_update()
            .filter(
                id=session_id,
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                **instance_filter,
            )
            .first()
        )
        if session is None:
            return {"session": None}
        _expire_stale_locked_session(session, now=now)
        return {"session": _serialize_session(session=session, principal=principal)}

    session = (
        LiveCallCaptionSession.objects.select_for_update()
        .filter(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel_id=channel.id,
            state__in=list(NON_TERMINAL_CALL_SESSION_STATES),
            **instance_filter,
        )
        .order_by("-created_at")
        .first()
    )
    if session is None:
        return {"session": None}
    if _expire_stale_locked_session(session, now=now):
        return {"session": None}
    return {"session": _serialize_session(session=session, principal=principal)}


def _reconcile_session_roster_and_state(
    *,
    session: LiveCallCaptionSession,
    roster: ResolvedCallRoster,
    now: datetime,
) -> tuple[str, int]:
    """Update a locked non-terminal session's roster and return `(next_state, refunded_micros)`."""
    _, unconsented_count, any_withdrawn = _evaluate_roster_consents(
        session=session,
        roster_memberships=roster.membership_ids,
        unresolved_count=roster.unresolved_count,
        for_update=True,
    )
    all_consented = (
        len(roster.membership_ids) >= 1
        and roster.unresolved_count == 0
        and unconsented_count == 0
        and not any_withdrawn
    )

    refunded = 0
    next_state = session.state
    next_generation = int(session.generation)
    next_buffered = int(session.buffered_chunks_count)
    next_inflight = int(session.in_flight_reserved_micros)
    next_paused_at = session.paused_at

    if any_withdrawn:
        refunded = _abort_inflight_and_refund_locked_session(session)
        next_state = "stopped_withdrawn"
        next_generation += 1
        next_buffered = 0
        next_inflight = 0
    elif all_consented:
        if session.state in {"awaiting_all_consents", "paused_unconsented_participant"}:
            next_state = "active"
            next_paused_at = None
    elif session.state == "active":
        # Auto-pause immediately on non-consenting participant join or consent loss!
        refunded = _abort_inflight_and_refund_locked_session(session)
        next_state = "paused_unconsented_participant"
        next_generation += 1
        next_buffered = 0
        next_inflight = 0
        next_paused_at = now

    LiveCallCaptionSession.objects.filter(pk=session.id).update(
        state=next_state,
        roster_membership_ids=_encode_stored_roster(roster),
        unconsented_count=unconsented_count,
        buffered_chunks_count=next_buffered,
        in_flight_reserved_micros=next_inflight,
        generation=next_generation,
        expires_at=now + CALL_CAPTION_SESSION_TTL,
        paused_at=next_paused_at,
        stopped_at=(
            now
            if next_state == "stopped_withdrawn" and session.stopped_at is None
            else session.stopped_at
        ),
        updated_at=now,
    )
    session.refresh_from_db()
    return next_state, refunded


def authorize_live_call_session_replay(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
) -> None:
    if body.get("roomId") is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    workspace_id = _require_workspace_id(principal.organisation_id)
    _require_non_confidential_call_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
        for_update=False,
    )


def prepare_live_call_caption_session(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
) -> PreparedLiveCallSession:
    """Resolve authoritative LiveKit roster outside any DB transaction for `POST /call-captions/session`."""
    if connection.in_atomic_block:
        raise RuntimeError("Live call caption session preparation requires no enclosing transaction")

    if body.get("roomId") is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    action = body.get("action")
    if not isinstance(action, str) or action not in SESSION_ACTIONS:
        raise AiGatewayRefusalError(422, "invalid_call_caption_action", "validation-error")

    requested_session_id = _parse_optional_uuid(body.get("sessionId"), field_name="session_id")
    requested_call_instance_id = _validate_optional_call_instance_id(body.get("callInstanceId"))
    raw_target_lang = body.get("targetLanguage")
    if raw_target_lang is not None:
        validate_iso_target_language(raw_target_lang)
    grant_call_consent = body.get("grantCallConsent", False)
    if type(grant_call_consent) is not bool:
        raise AiGatewayRefusalError(422, "invalid_grant_call_consent", "validation-error")

    if action in {"withdraw", "leave", "end", "set_language"}:
        return PreparedLiveCallSession(
            action=action,
            call_instance_id=requested_call_instance_id,
            authoritative_roster=None,
        )

    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    workspace_id = _require_workspace_id(principal.organisation_id)
    channel = _require_non_confidential_call_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
        for_update=False,
    )
    now = timezone.now()

    if action == "sync_roster":
        _require_org_and_channel_ai_enabled(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel=channel,
            for_update=False,
        )
        _require_livekit_roster_configured()
        session_row = (
            LiveCallCaptionSession.objects.filter(
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                **(
                    {"id": requested_session_id}
                    if requested_session_id is not None
                    else {"state__in": list(NON_TERMINAL_CALL_SESSION_STATES)}
                ),
            ).first()
        )
        if (
            session_row is None
            or session_row.state not in NON_TERMINAL_CALL_SESSION_STATES
            or session_row.expires_at <= now
        ):
            return PreparedLiveCallSession(
                action=action,
                call_instance_id=None,
                authoritative_roster=None,
            )
        if (
            requested_call_instance_id is not None
            and session_row.call_instance_id != requested_call_instance_id
        ):
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
        auth_roster = resolve_authoritative_livekit_roster(
            organisation_id=principal.organisation_id,
            channel_id=channel.id,
            required_call_instance_id=session_row.call_instance_id,
        )
        return PreparedLiveCallSession(
            action=action,
            call_instance_id=session_row.call_instance_id,
            authoritative_roster=auth_roster,
        )

    evaluate_ai_gate(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel.id,
        room_id=None,
        for_update=False,
    )
    required_call_instance_id = _validate_required_call_instance_id(body.get("callInstanceId"))
    _require_livekit_roster_configured()

    if requested_session_id is not None:
        existing = LiveCallCaptionSession.objects.filter(
            id=requested_session_id,
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel_id=channel.id,
        ).first()
        if existing is None:
            raise AiGatewayRefusalError(404, None, "not-found")
        if existing.expires_at <= now:
            return PreparedLiveCallSession(
                action=action,
                call_instance_id=required_call_instance_id,
                authoritative_roster=None,
            )
        if existing.state not in NON_TERMINAL_CALL_SESSION_STATES:
            raise AiGatewayRefusalError(409, "call_session_stopped", "conflict")
        if existing.call_instance_id != required_call_instance_id:
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")

    auth_roster = resolve_authoritative_livekit_roster(
        organisation_id=principal.organisation_id,
        channel_id=channel.id,
        required_call_instance_id=required_call_instance_id,
    )
    return PreparedLiveCallSession(
        action=action,
        call_instance_id=required_call_instance_id,
        authoritative_roster=auth_roster,
    )


@transaction.atomic
def _commit_live_call_caption_session(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
    request_id: str,
    prepared_session: PreparedLiveCallSession,
) -> dict[str, Any]:
    raw_room_id = body.get("roomId")
    if raw_room_id is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    action = body.get("action")
    if not isinstance(action, str) or action not in SESSION_ACTIONS:
        raise AiGatewayRefusalError(422, "invalid_call_caption_action", "validation-error")

    requested_session_id = _parse_optional_uuid(body.get("sessionId"), field_name="session_id")
    requested_call_instance_id = _validate_optional_call_instance_id(body.get("callInstanceId"))
    raw_target_lang = body.get("targetLanguage")
    target_language = (
        validate_iso_target_language(raw_target_lang) if raw_target_lang is not None else None
    )
    grant_call_consent = body.get("grantCallConsent", False)
    if type(grant_call_consent) is not bool:
        raise AiGatewayRefusalError(422, "invalid_grant_call_consent", "validation-error")

    try:
        principal = caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None

    workspace_id = lock_workspace(principal.organisation_id)
    if workspace_id is None:
        raise AiGatewayRefusalError(404, None, "not-found")

    channel = _require_non_confidential_call_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
        for_update=True,
    )
    now = timezone.now()

    # Withdrawal, self-leave, and call-end are always allowed regardless of whether org/member AI
    # policy was concurrently toggled off: revoking consent or leaving a call must never be blocked.
    if action in {"withdraw", "leave", "end"}:
        if requested_session_id is not None:
            session = (
                LiveCallCaptionSession.objects.select_for_update()
                .filter(
                    id=requested_session_id,
                    organisation_id=principal.organisation_id,
                    workspace_id=workspace_id,
                    channel_id=channel.id,
                )
                .first()
            )
        else:
            session = (
                LiveCallCaptionSession.objects.select_for_update()
                .filter(
                    organisation_id=principal.organisation_id,
                    workspace_id=workspace_id,
                    channel_id=channel.id,
                    state__in=list(NON_TERMINAL_CALL_SESSION_STATES),
                )
                .first()
            )
        if session is None:
            return {"session": None}

        if action == "withdraw":
            existing_consent = (
                LiveCallParticipantConsent.objects.select_for_update()
                .filter(session_id=session.id, membership_id=principal.membership_id)
                .first()
            )
            if existing_consent is None:
                LiveCallParticipantConsent.objects.create(
                    organisation_id=principal.organisation_id,
                    workspace_id=workspace_id,
                    channel_id=channel.id,
                    session_id=session.id,
                    membership_id=principal.membership_id,
                    identity_id=principal.identity_id,
                    state="withdrawn",
                    consented_at=None,
                    withdrawn_at=now,
                )
            else:
                LiveCallParticipantConsent.objects.filter(pk=existing_consent.id).update(
                    state="withdrawn",
                    withdrawn_at=now,
                    updated_at=now,
                )
            if session.state in NON_TERMINAL_CALL_SESSION_STATES:
                _abort_inflight_and_refund_locked_session(session)
                LiveCallCaptionSession.objects.filter(pk=session.id).update(
                    state="stopped_withdrawn",
                    buffered_chunks_count=0,
                    in_flight_reserved_micros=0,
                    generation=int(session.generation) + 1,
                    stopped_at=now,
                    updated_at=now,
                )
                session.refresh_from_db()
            record_workspace_resource_event(
                action="workspace.call_captions.consent_withdrawn",
                organisation_id=principal.organisation_id,
                target_id=session.id,
                actor_id=principal.identity_id,
                request_id=request_id,
                metadata={"channel_id": str(channel.id), "state": "stopped_withdrawn"},
            )
            return {"session": _serialize_session(session=session, principal=principal)}

        if action == "leave":
            if _expire_stale_locked_session(session, now=now):
                return {"session": _serialize_session(session=session, principal=principal)}
            if session.state not in NON_TERMINAL_CALL_SESSION_STATES:
                return {"session": _serialize_session(session=session, principal=principal)}
            existing_members, existing_ext = _split_stored_roster(session)
            remaining_members = tuple(
                mem_id for mem_id in existing_members if mem_id != principal.membership_id
            )
            if not remaining_members:
                _abort_inflight_and_refund_locked_session(session)
                LiveCallCaptionSession.objects.filter(pk=session.id).update(
                    state="ended",
                    roster_membership_ids=list(existing_ext),
                    unconsented_count=len(existing_ext),
                    buffered_chunks_count=0,
                    in_flight_reserved_micros=0,
                    generation=int(session.generation) + 1,
                    ended_at=now,
                    updated_at=now,
                )
                session.refresh_from_db()
                record_workspace_resource_event(
                    action="workspace.call_captions.ended",
                    organisation_id=principal.organisation_id,
                    target_id=session.id,
                    actor_id=principal.identity_id,
                    request_id=request_id,
                    metadata={"channel_id": str(channel.id), "state": "ended"},
                )
                return {"session": _serialize_session(session=session, principal=principal)}

            _reconcile_session_roster_and_state(
                session=session,
                roster=ResolvedCallRoster(
                    membership_ids=remaining_members,
                    external_tokens=existing_ext,
                ),
                now=now,
            )
            return {"session": _serialize_session(session=session, principal=principal)}

        if session.state in NON_TERMINAL_CALL_SESSION_STATES:
            _abort_inflight_and_refund_locked_session(session)
            LiveCallCaptionSession.objects.filter(pk=session.id).update(
                state="ended",
                buffered_chunks_count=0,
                in_flight_reserved_micros=0,
                generation=int(session.generation) + 1,
                ended_at=now,
                updated_at=now,
            )
            session.refresh_from_db()
            record_workspace_resource_event(
                action="workspace.call_captions.ended",
                organisation_id=principal.organisation_id,
                target_id=session.id,
                actor_id=principal.identity_id,
                request_id=request_id,
                metadata={"channel_id": str(channel.id), "state": "ended"},
            )
        return {"session": _serialize_session(session=session, principal=principal)}

    if action == "sync_roster":
        _require_org_and_channel_ai_enabled(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel=channel,
            for_update=True,
        )
        _require_livekit_roster_configured()
        session = (
            LiveCallCaptionSession.objects.select_for_update()
            .filter(
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                **(
                    {"id": requested_session_id}
                    if requested_session_id is not None
                    else {"state__in": list(NON_TERMINAL_CALL_SESSION_STATES)}
                ),
            )
            .first()
        )
        if session is None:
            return {"session": None}
        if _expire_stale_locked_session(session, now=now):
            return {"session": _serialize_session(session=session, principal=principal)}
        if session.state not in NON_TERMINAL_CALL_SESSION_STATES:
            return {"session": _serialize_session(session=session, principal=principal)}
        if (
            requested_call_instance_id is not None
            and session.call_instance_id != requested_call_instance_id
        ):
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
        if (
            prepared_session.authoritative_roster is None
            or prepared_session.call_instance_id != session.call_instance_id
        ):
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")

        observed = _resolve_call_roster(
            organisation_id=principal.organisation_id,
            channel_id=channel.id,
            raw_membership_ids=body.get("participantMembershipIds"),
            raw_user_ids=body.get("participantUserIds"),
            default_caller_membership_id=principal.membership_id,
        )
        observed = _merge_rosters(observed, prepared_session.authoritative_roster)
        merged_roster = _merge_session_roster(session, observed)
        previous_state = session.state
        next_state, refunded = _reconcile_session_roster_and_state(
            session=session, roster=merged_roster, now=now
        )
        if previous_state == "active" and next_state == "paused_unconsented_participant":
            record_workspace_resource_event(
                action="workspace.call_captions.paused",
                organisation_id=principal.organisation_id,
                target_id=session.id,
                actor_id=principal.identity_id,
                request_id=request_id,
                metadata={
                    "channel_id": str(channel.id),
                    "state": next_state,
                    "refunded_micros": refunded,
                },
            )
        return {"session": _serialize_session(session=session, principal=principal)}

    # `start`, `consent`, and `set_language` require the full 3-tier AI gate (org -> channel -> member).
    evaluate_ai_gate(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel.id,
        room_id=None,
        for_update=True,
    )

    if action == "set_language":
        if target_language is None:
            raise AiGatewayRefusalError(422, "invalid_target_language", "validation-error")
        session = (
            LiveCallCaptionSession.objects.select_for_update()
            .filter(
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                **(
                    {"id": requested_session_id}
                    if requested_session_id is not None
                    else {"state__in": list(NON_TERMINAL_CALL_SESSION_STATES)}
                ),
            )
            .first()
        )
        if session is None:
            raise AiGatewayRefusalError(404, None, "not-found")
        if _expire_stale_locked_session(session, now=now):
            raise AiGatewayRefusalError(409, "call_session_expired", "conflict")
        if session.state not in NON_TERMINAL_CALL_SESSION_STATES:
            raise AiGatewayRefusalError(409, "call_session_stopped", "conflict")
        LiveCallCaptionSession.objects.filter(pk=session.id).update(
            target_language=target_language,
            expires_at=now + CALL_CAPTION_SESSION_TTL,
            updated_at=now,
        )
        session.refresh_from_db()
        return {"session": _serialize_session(session=session, principal=principal)}

    # `start` and `consent` require an explicit per-call `callInstanceId` so consents bind strictly
    # to the active call instance and never carry over across distinct calls on the same channel.
    required_call_instance_id = _validate_required_call_instance_id(body.get("callInstanceId"))
    _require_livekit_roster_configured()

    if requested_session_id is not None:
        session = (
            LiveCallCaptionSession.objects.select_for_update()
            .filter(
                id=requested_session_id,
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
            )
            .first()
        )
        if session is None:
            raise AiGatewayRefusalError(404, None, "not-found")
        if _expire_stale_locked_session(session, now=now):
            raise AiGatewayRefusalError(409, "call_session_expired", "conflict")
        if session.state not in NON_TERMINAL_CALL_SESSION_STATES:
            raise AiGatewayRefusalError(409, "call_session_stopped", "conflict")
        if session.call_instance_id != required_call_instance_id:
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
    else:
        session = (
            LiveCallCaptionSession.objects.select_for_update()
            .filter(
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                state__in=list(NON_TERMINAL_CALL_SESSION_STATES),
            )
            .first()
        )
        if session is not None and _expire_stale_locked_session(session, now=now):
            session = None
        if (
            session is not None
            and action == "start"
            and session.call_instance_id != required_call_instance_id
        ):
            # Starting a new call instance on the channel terminates the prior session so consents
            # never carry over across distinct calls.
            _abort_inflight_and_refund_locked_session(session)
            LiveCallCaptionSession.objects.filter(pk=session.id).update(
                state="ended",
                buffered_chunks_count=0,
                in_flight_reserved_micros=0,
                generation=int(session.generation) + 1,
                ended_at=now,
                updated_at=now,
            )
            session = None
        elif session is not None and session.call_instance_id != required_call_instance_id:
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")

    if (
        prepared_session.authoritative_roster is None
        or prepared_session.call_instance_id != required_call_instance_id
    ):
        raise LiveCallCaptionsUnavailableError()

    observed_roster = _resolve_call_roster(
        organisation_id=principal.organisation_id,
        channel_id=channel.id,
        raw_membership_ids=body.get("participantMembershipIds"),
        raw_user_ids=body.get("participantUserIds"),
        default_caller_membership_id=principal.membership_id,
    )
    observed_roster = _merge_rosters(observed_roster, prepared_session.authoritative_roster)
    if principal.membership_id not in observed_roster.membership_ids:
        observed_roster = ResolvedCallRoster(
            membership_ids=tuple(
                sorted({*observed_roster.membership_ids, principal.membership_id}, key=str)
            ),
            external_tokens=observed_roster.external_tokens,
        )

    created_new = False
    if session is None:
        session = LiveCallCaptionSession.objects.create(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel_id=channel.id,
            started_by_id=principal.membership_id,
            call_instance_id=required_call_instance_id,
            state="awaiting_all_consents",
            target_language=target_language or "fr",
            roster_membership_ids=_encode_stored_roster(observed_roster),
            unconsented_count=max(
                1, len(observed_roster.membership_ids) + observed_roster.unresolved_count
            ),
            expires_at=now + CALL_CAPTION_SESSION_TTL,
        )
        created_new = True
        roster = observed_roster
    else:
        roster = _merge_session_roster(session, observed_roster)

    if target_language is not None and session.target_language != target_language:
        LiveCallCaptionSession.objects.filter(pk=session.id).update(
            target_language=target_language,
            updated_at=now,
        )
        session.refresh_from_db()

    if action == "consent" or grant_call_consent:
        existing_consent = (
            LiveCallParticipantConsent.objects.select_for_update()
            .filter(session_id=session.id, membership_id=principal.membership_id)
            .first()
        )
        if existing_consent is None:
            LiveCallParticipantConsent.objects.create(
                organisation_id=principal.organisation_id,
                workspace_id=workspace_id,
                channel_id=channel.id,
                session_id=session.id,
                membership_id=principal.membership_id,
                identity_id=principal.identity_id,
                state="consented",
                consented_at=now,
                withdrawn_at=None,
            )
        else:
            LiveCallParticipantConsent.objects.filter(pk=existing_consent.id).update(
                state="consented",
                consented_at=now,
                withdrawn_at=None,
                updated_at=now,
            )
    elif created_new:
        LiveCallParticipantConsent.objects.create(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            channel_id=channel.id,
            session_id=session.id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
            state="pending",
            consented_at=None,
            withdrawn_at=None,
        )

    _reconcile_session_roster_and_state(session=session, roster=roster, now=now)

    audit_action = (
        "workspace.call_captions.consented"
        if (action == "consent" or grant_call_consent)
        else "workspace.call_captions.started"
    )
    record_workspace_resource_event(
        action=audit_action,
        organisation_id=principal.organisation_id,
        target_id=session.id,
        actor_id=principal.identity_id,
        request_id=request_id,
        metadata={
            "channel_id": str(channel.id),
            "call_instance_id": session.call_instance_id,
            "state": session.state,
            "target_language": session.target_language,
        },
    )
    return {"session": _serialize_session(session=session, principal=principal)}


def update_live_call_caption_session(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
    request_id: str,
    prepared_session: PreparedLiveCallSession | None = None,
) -> dict[str, Any]:
    if prepared_session is None:
        prepared_session = prepare_live_call_caption_session(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            body=body,
        )
    return _commit_live_call_caption_session(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel_id,
        body=body,
        request_id=request_id,
        prepared_session=prepared_session,
    )


def _decode_and_validate_chunk_audio(body: dict[str, Any]) -> tuple[bytes, str, str]:
    raw_b64 = body.get("audioBase64")
    if not isinstance(raw_b64, str) or not raw_b64.strip():
        raise AiGatewayRefusalError(422, "invalid_audio_chunk_size", "validation-error")
    compact = "".join(raw_b64.split())
    if len(compact) > ((MAX_CALL_CHUNK_BYTES + 2) // 3) * 4 + 16:
        raise AiGatewayRefusalError(422, "invalid_audio_chunk_size", "validation-error")
    try:
        audio_bytes = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        raise AiGatewayRefusalError(422, "invalid_audio_encoding", "validation-error") from None

    if not 1 <= len(audio_bytes) <= MAX_CALL_CHUNK_BYTES:
        raise AiGatewayRefusalError(422, "invalid_audio_chunk_size", "validation-error")
    if not _has_valid_audio_magic(audio_bytes):
        raise AiGatewayRefusalError(422, "invalid_audio_container", "validation-error")

    content_type = body.get("contentType", "audio/ogg")
    if not isinstance(content_type, str) or content_type not in VOICE_NOTE_MIME_TYPES:
        raise AiGatewayRefusalError(422, "unsupported_audio_chunk_type", "validation-error")

    filename = body.get("filename", "call-chunk.ogg")
    if (
        not isinstance(filename, str)
        or not 1 <= len(filename) <= 120
        or any(ord(ch) < 32 or ord(ch) >= 127 for ch in filename)
    ):
        raise AiGatewayRefusalError(422, "invalid_filename", "validation-error")

    return audio_bytes, content_type, filename


@transaction.atomic
def authorize_live_call_chunk(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
    for_update: bool = False,
    ingested_at: datetime | None = None,
    authoritative_roster: ResolvedCallRoster | None = None,
) -> tuple[AdmittedAiExecution, LiveCallCaptionSession, bytes, str, str, str]:
    if body.get("roomId") is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    admitted = evaluate_ai_gate(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel_id,
        room_id=None,
        for_update=for_update,
    )

    requested_session_id = _parse_required_uuid(body.get("sessionId"), field_name="session_id")
    requested_generation = _validate_required_generation(body.get("sessionEpoch"))
    audio_bytes, content_type, filename = _decode_and_validate_chunk_audio(body)
    raw_target = body.get("targetLanguage")
    explicit_target = validate_iso_target_language(raw_target) if raw_target is not None else None

    session_qs = (
        LiveCallCaptionSession.objects.select_for_update()
        if for_update
        else LiveCallCaptionSession.objects
    )
    session = session_qs.filter(
        id=requested_session_id,
        organisation_id=admitted.principal.organisation_id,
        workspace_id=admitted.workspace_id,
        channel_id=admitted.channel_id,
    ).first()

    if session is None:
        raise AiGatewayRefusalError(403, "ai_call_all_party_consent_required")

    check_time = ingested_at or timezone.now()
    if for_update and _expire_stale_locked_session(session, now=check_time):
        raise AiGatewayRefusalError(409, "call_session_expired", "conflict")
    if session.expires_at <= check_time:
        raise AiGatewayRefusalError(409, "call_session_expired", "conflict")

    if session.state == "stopped_withdrawn":
        raise AiGatewayRefusalError(403, "ai_call_consent_withdrawn")

    if session.state == "paused_unconsented_participant":
        raise AiGatewayRefusalError(403, "ai_call_unconsented_participant")
    if session.state != "active":
        raise AiGatewayRefusalError(403, "ai_call_all_party_consent_required")
    if int(session.generation) != requested_generation:
        raise AiGatewayRefusalError(409, "call_session_generation_mismatch", "conflict")

    if authoritative_roster is None:
        raise LiveCallCaptionsUnavailableError()
    livekit_roster = authoritative_roster

    stored_members, stored_ext = _split_stored_roster(session)
    if (
        body.get("participantMembershipIds") is not None
        or body.get("participantUserIds") is not None
    ):
        supplied_roster = _resolve_call_roster(
            organisation_id=admitted.principal.organisation_id,
            channel_id=admitted.channel_id,
            raw_membership_ids=body.get("participantMembershipIds"),
            raw_user_ids=body.get("participantUserIds"),
        )
        # Union with server-tracked roster so omitting a participant never bypasses their consent.
        roster_memberships = tuple(
            sorted({*stored_members, *supplied_roster.membership_ids}, key=str)
        )
        ext_set = {*stored_ext, *supplied_roster.external_tokens}
        unresolved_count = len(ext_set)
    else:
        roster_memberships = stored_members
        ext_set = set(stored_ext)
        unresolved_count = max(len(ext_set), int(session.unconsented_count))

    roster_memberships = tuple(
        sorted({*roster_memberships, *livekit_roster.membership_ids}, key=str)
    )
    ext_set.update(livekit_roster.external_tokens)
    unresolved_count = max(unresolved_count, len(ext_set))

    if (
        not 1 <= len(roster_memberships) <= MAX_CALL_ROSTER_PARTICIPANTS
        or admitted.principal.membership_id not in roster_memberships
    ):
        raise AiGatewayRefusalError(403, "ai_call_participant_required")

    active_org_members = current_members(organisation_id=admitted.principal.organisation_id)
    authority_rev = organisation_authority_revision(
        organisation_id=admitted.principal.organisation_id
    )
    try:
        access = resolve(admitted.channel_id)
    except (ObjectDoesNotExist, WorkspaceUnavailableError):
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled") from None

    for mem_id in roster_memberships:
        if mem_id not in active_org_members or not may_view(
            access,
            organisation_id=admitted.principal.organisation_id,
            membership_id=mem_id,
            authority_revision=authority_rev,
        ):
            raise AiGatewayRefusalError(403, "ai_call_all_party_consent_required")

    consented_count, unconsented_count, any_withdrawn = _evaluate_roster_consents(
        session=session,
        roster_memberships=roster_memberships,
        unresolved_count=unresolved_count,
        for_update=for_update,
        ingested_at=check_time,
    )
    if any_withdrawn:
        raise AiGatewayRefusalError(403, "ai_call_consent_withdrawn")
    if (
        int(session.unconsented_count) > 0
        or unconsented_count > 0
        or consented_count != len(roster_memberships)
    ):
        if len(roster_memberships) > len(stored_members) or unresolved_count > 0:
            raise AiGatewayRefusalError(409, "ai_call_unconsented_participant", "conflict")
        raise AiGatewayRefusalError(409, "ai_call_all_party_consent_required", "conflict")

    effective_target_lang = explicit_target or session.target_language
    return admitted, session, audio_bytes, content_type, filename, effective_target_lang


def _settle_chunk_reservation_on_session(
    *,
    session_id: UUID,
    expected_generation: int,
    reserved_micros: int,
    actual_micros: int,
    refund_only: bool,
    refresh_expiry: bool = False,
) -> None:
    if reserved_micros <= 0:
        return
    session = LiveCallCaptionSession.objects.select_for_update().filter(id=session_id).first()
    if session is None:
        return
    if int(session.generation) != expected_generation:
        # A concurrent pause/withdraw/end/expiry already refunded `in_flight_reserved_micros` and
        # incremented `generation`; never double-refund.
        return
    now = timezone.now()
    next_inflight = max(0, int(session.in_flight_reserved_micros) - reserved_micros)
    next_buffered = max(0, int(session.buffered_chunks_count) - 1)
    update_fields: dict[str, Any] = {
        "in_flight_reserved_micros": next_inflight,
        "buffered_chunks_count": next_buffered,
        "updated_at": now,
    }
    if refresh_expiry and session.state in NON_TERMINAL_CALL_SESSION_STATES:
        update_fields["expires_at"] = now + CALL_CAPTION_SESSION_TTL
    LiveCallCaptionSession.objects.filter(pk=session.id).update(**update_fields)
    if refund_only:
        refund_workspace_ai_budget(
            organisation_id=session.organisation_id,
            workspace_id=session.workspace_id,
            reserved_micros=reserved_micros,
        )
    else:
        reconcile_workspace_ai_budget(
            organisation_id=session.organisation_id,
            workspace_id=session.workspace_id,
            reserved_micros=reserved_micros,
            actual_micros=actual_micros,
        )


def release_uncommitted_call_chunk_budget(prepared: PreparedLiveCallChunk) -> None:
    if prepared.settled or prepared.reserved_micros <= 0:
        return
    with transaction.atomic():
        _settle_chunk_reservation_on_session(
            session_id=prepared.session_id,
            expected_generation=prepared.expected_generation,
            reserved_micros=prepared.reserved_micros,
            actual_micros=0,
            refund_only=True,
        )
    prepared.settled = True


def prepare_live_call_chunk(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
) -> PreparedLiveCallChunk:
    if connection.in_atomic_block:
        raise RuntimeError("Live call caption chunk I/O requires no enclosing transaction")

    if body.get("roomId") is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    # Fast deterministic admission & payload validation before any outbound LiveKit/Synapse I/O.
    preflight_admitted = evaluate_ai_gate(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel_id,
        room_id=None,
        for_update=False,
    )
    requested_session_id = _parse_required_uuid(body.get("sessionId"), field_name="session_id")
    requested_generation = _validate_required_generation(body.get("sessionEpoch"))
    _decode_and_validate_chunk_audio(body)
    raw_target = body.get("targetLanguage")
    if raw_target is not None:
        validate_iso_target_language(raw_target)

    _require_livekit_roster_configured()

    ingested_at = timezone.now()
    prefetched_row = LiveCallCaptionSession.objects.filter(
        id=requested_session_id,
        organisation_id=preflight_admitted.principal.organisation_id,
        workspace_id=preflight_admitted.workspace_id,
        channel_id=preflight_admitted.channel_id,
    ).first()
    if prefetched_row is None:
        raise AiGatewayRefusalError(403, "ai_call_all_party_consent_required")
    if prefetched_row.expires_at <= ingested_at:
        with transaction.atomic():
            locked = (
                LiveCallCaptionSession.objects.select_for_update()
                .filter(pk=prefetched_row.id)
                .first()
            )
            if locked is not None:
                _expire_stale_locked_session(locked, now=ingested_at)
        raise AiGatewayRefusalError(409, "call_session_expired", "conflict")
    if prefetched_row.state == "stopped_withdrawn":
        raise AiGatewayRefusalError(403, "ai_call_consent_withdrawn")
    if prefetched_row.state == "paused_unconsented_participant":
        raise AiGatewayRefusalError(403, "ai_call_unconsented_participant")
    if prefetched_row.state != "active":
        raise AiGatewayRefusalError(403, "ai_call_all_party_consent_required")
    if int(prefetched_row.generation) != requested_generation:
        raise AiGatewayRefusalError(409, "call_session_generation_mismatch", "conflict")

    prefetched_livekit_roster = resolve_authoritative_livekit_roster(
        organisation_id=preflight_admitted.principal.organisation_id,
        channel_id=preflight_admitted.channel_id,
        required_call_instance_id=prefetched_row.call_instance_id,
    )

    with transaction.atomic():
        admitted, session, audio_bytes, content_type, filename, target_language = (
            authorize_live_call_chunk(
                verified=verified,
                organisation_id=organisation_id,
                channel_id=channel_id,
                body=body,
                for_update=True,
                ingested_at=ingested_at,
                authoritative_roster=prefetched_livekit_roster,
            )
        )
        if session.call_instance_id != prefetched_row.call_instance_id:
            raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
        # Reserve against the true mathematical worst-case upper bound across BOTH full-chunk
        # transcription (`MAX_CALL_CHUNK_BYTES` + `MAX_TRANSLATION_TEXT_CHARS` transcript chars) and
        # translation (`MAX_TRANSLATION_TEXT_CHARS` hardened prompt + `MAX_CALL_CAPTION_OUTPUT_CHARS`
        # translated output) so `reserved_micros >= actual_micros` holds without silent clamping.
        worst_case_prompt, _ = build_hardened_translation_prompt(
            source_text="x" * MAX_TRANSLATION_TEXT_CHARS,
            target_language=target_language,
            source_language="auto",
        )
        reserved_transcription_micros = (
            _estimate_transcription_cost_micros(MAX_CALL_CHUNK_BYTES)
            + MAX_TRANSLATION_TEXT_CHARS * 2
        )
        reserved_translation_micros = _estimate_prompt_cost_micros(
            worst_case_prompt, max_tokens=MAX_CALL_CAPTION_OUTPUT_CHARS
        )
        reserved_micros = reserved_transcription_micros + reserved_translation_micros
        if not reserve_workspace_ai_budget(
            organisation_id=admitted.principal.organisation_id,
            workspace_id=admitted.workspace_id,
            reserve_micros=reserved_micros,
        ):
            raise AiGatewayRefusalError(429, "ai_budget_exhausted", "rate-limited")

        expected_generation = int(session.generation)
        bound_call_instance_id = session.call_instance_id
        LiveCallCaptionSession.objects.filter(pk=session.id).update(
            buffered_chunks_count=int(session.buffered_chunks_count) + 1,
            in_flight_reserved_micros=int(session.in_flight_reserved_micros) + reserved_micros,
            updated_at=ingested_at,
        )

    try:
        transcription = admitted.adapter.transcribe(
            AiTranscriptionRequest(
                audio_bytes=audio_bytes,
                filename=filename,
                content_type=content_type,
                language=None,
                model=admitted.model,
            ),
            scope_key=str(admitted.principal.organisation_id),
        )
        source_text = transcription.text.strip()[:MAX_TRANSLATION_TEXT_CHARS]
        detected_lang = (transcription.language or "fr").strip().lower().split("-")[0]
        actual_micros = _actual_transcription_cost_micros(len(audio_bytes), source_text)
        translated_text = source_text

        if source_text and detected_lang != target_language:
            prompt, nonce = build_hardened_translation_prompt(
                source_text=source_text,
                target_language=target_language,
                source_language="auto",
            )
            max_tokens = min(MAX_CALL_CHUNK_TRANSLATION_MAX_TOKENS, max(128, len(source_text) + 64))
            completion = admitted.adapter.complete(
                AiCompletionRequest(prompt=prompt, model=admitted.model, max_tokens=max_tokens),
                scope_key=str(admitted.principal.organisation_id),
            )
            translated_text = sanitize_translated_output(completion.text, nonce=nonce)
            if len(translated_text) > MAX_CALL_CAPTION_OUTPUT_CHARS:
                raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
            actual_micros += _actual_prompt_cost_micros(prompt, translated_text)

        # Re-verify authoritative LiveKit room roster AFTER provider I/O completes and BEFORE
        # entering `respond_once`'s DB transaction, so zero HTTP ever executes inside a transaction.
        post_authoritative_roster = resolve_authoritative_livekit_roster(
            organisation_id=admitted.principal.organisation_id,
            channel_id=admitted.channel_id,
            required_call_instance_id=bound_call_instance_id,
        )
    except BaseException:
        with transaction.atomic():
            _settle_chunk_reservation_on_session(
                session_id=session.id,
                expected_generation=expected_generation,
                reserved_micros=reserved_micros,
                actual_micros=0,
                refund_only=True,
            )
        raise

    return PreparedLiveCallChunk(
        organisation_id=admitted.principal.organisation_id,
        workspace_id=admitted.workspace_id,
        channel_id=admitted.channel_id,
        session_id=session.id,
        call_instance_id=bound_call_instance_id,
        expected_generation=expected_generation,
        body={
            **dict(body),
            "sessionId": str(session.id),
            "sessionEpoch": expected_generation,
        },
        post_authoritative_roster=post_authoritative_roster,
        source_text=source_text,
        translated_text=translated_text,
        source_language=detected_lang or "fr",
        target_language=target_language,
        provider=transcription.provider,
        model=transcription.model,
        reserved_micros=reserved_micros,
        actual_micros=actual_micros,
    )


def commit_live_call_chunk(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    prepared: PreparedLiveCallChunk,
    request_id: str,
) -> dict[str, Any]:
    refusal: AiGatewayRefusalError | None = None
    admitted: AdmittedAiExecution | None = None
    session: LiveCallCaptionSession | None = None

    def _mark_settled() -> None:
        prepared.settled = True

    if prepared.post_authoritative_roster is None:
        refusal = LiveCallCaptionsUnavailableError()

    with transaction.atomic():
        if refusal is not None:
            if not prepared.settled:
                _settle_chunk_reservation_on_session(
                    session_id=prepared.session_id,
                    expected_generation=prepared.expected_generation,
                    reserved_micros=prepared.reserved_micros,
                    actual_micros=0,
                    refund_only=True,
                )
                transaction.on_commit(_mark_settled)
        else:
            try:
                with transaction.atomic():
                    admitted, session, _, _, _, _ = authorize_live_call_chunk(
                        verified=verified,
                        organisation_id=organisation_id,
                        channel_id=prepared.channel_id,
                        body=prepared.body,
                        for_update=True,
                        authoritative_roster=prepared.post_authoritative_roster,
                    )
                    if session.call_instance_id != prepared.call_instance_id:
                        raise AiGatewayRefusalError(409, "call_instance_mismatch", "conflict")
            except AiGatewayRefusalError as exc:
                refusal = exc
                if not prepared.settled:
                    _settle_chunk_reservation_on_session(
                        session_id=prepared.session_id,
                        expected_generation=prepared.expected_generation,
                        reserved_micros=prepared.reserved_micros,
                        actual_micros=0,
                        refund_only=True,
                    )
                    transaction.on_commit(_mark_settled)
            except BaseException:
                if not prepared.settled:
                    _settle_chunk_reservation_on_session(
                        session_id=prepared.session_id,
                        expected_generation=prepared.expected_generation,
                        reserved_micros=prepared.reserved_micros,
                        actual_micros=0,
                        refund_only=True,
                    )
                raise
            else:
                if not prepared.settled:
                    _settle_chunk_reservation_on_session(
                        session_id=prepared.session_id,
                        expected_generation=prepared.expected_generation,
                        reserved_micros=prepared.reserved_micros,
                        actual_micros=prepared.actual_micros,
                        refund_only=False,
                        refresh_expiry=True,
                    )
                    transaction.on_commit(_mark_settled)
                if admitted is None or session is None:
                    raise AiGatewayRefusalError(
                        503, "ai_provider_unavailable", "service-unavailable"
                    )
                record_workspace_resource_event(
                    action="workspace.call_captions.chunk_transcribed",
                    organisation_id=admitted.principal.organisation_id,
                    target_id=session.id,
                    actor_id=admitted.principal.identity_id,
                    request_id=request_id,
                    metadata={
                        "channel_id": str(admitted.channel_id),
                        "target_language": prepared.target_language,
                        "provider": prepared.provider,
                    },
                )

    if refusal is not None:
        # Discard any in-flight text; never return transcripts after pause, expiry, or withdrawal.
        prepared.source_text = ""
        prepared.translated_text = ""
        raise refusal
    if admitted is None or session is None:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    return {
        "sessionId": str(session.id),
        "channelId": str(admitted.channel_id),
        "sourceText": prepared.source_text,
        "translatedText": prepared.translated_text,
        "sourceLanguage": prepared.source_language,
        "targetLanguage": prepared.target_language,
        "provider": prepared.provider,
        "model": prepared.model,
        "ephemeral": True,
    }


def transcribe_live_call_chunk(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    prepared = prepare_live_call_chunk(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=channel_id,
        body=body,
    )
    try:
        return commit_live_call_chunk(
            verified=verified,
            organisation_id=organisation_id,
            prepared=prepared,
            request_id=request_id,
        )
    finally:
        if not connection.in_atomic_block:
            release_uncommitted_call_chunk_budget(prepared)
