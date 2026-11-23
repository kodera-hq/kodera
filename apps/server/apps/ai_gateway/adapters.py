"""Sovereign AI model provider adapters pinned over SSRF-guarded outbound HTTPS."""

from __future__ import annotations

import ipaddress
import json
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urljoin
from uuid import UUID

from apps.media import outbound
from apps.media.outbound import BlockedTargetError, FetchError, Target
from core.sealing import SealError

from .sealing import unseal_byom_config

MISTRAL_EU_BASE_URL = "https://api.mistral.ai"
DEFAULT_TIMEOUT_S = 10.0
MAX_RESPONSE_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024
NON_EU_KNOWN_HOSTS = frozenset(
    {
        "api.openai.com",
        "us.api.openai.com",
        "generativelanguage.googleapis.com",
    }
)


class AiGatewayRefusalError(ValueError):
    """Fail-closed refusal from the AI gateway or its provider boundary."""

    def __init__(
        self,
        status: int,
        reason: str | None = None,
        kind: str | None = None,
    ) -> None:
        super().__init__(reason or "ai-gateway-refused")
        self.status = status
        self.reason = reason
        self.kind = kind


@dataclass(frozen=True)
class ApiBearerSecret:
    api_key: str = field(repr=False)

    def __post_init__(self) -> None:
        if (
            not isinstance(self.api_key, str)
            or not 1 <= len(self.api_key) <= 512
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in self.api_key)
        ):
            raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")


@dataclass(frozen=True)
class AiCompletionRequest:
    prompt: str
    model: str
    max_tokens: int = 512


@dataclass(frozen=True)
class AiCompletionResult:
    text: str
    provider: str
    model: str


@dataclass(frozen=True)
class AiTranscriptionRequest:
    audio_bytes: bytes = field(repr=False)
    filename: str = "voice-note.ogg"
    content_type: str = "audio/ogg"
    language: str | None = None
    model: str = "voxtral-mini-latest"


@dataclass(frozen=True)
class AiTranscriptionResult:
    text: str
    language: str
    provider: str
    model: str


@runtime_checkable
class ModelProviderAdapter(Protocol):
    @property
    def provider_id(self) -> str: ...

    @property
    def is_eu_sovereign(self) -> bool: ...

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult: ...

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult: ...


def _post_json(
    destination: Target,
    *,
    payload: dict[str, Any],
    bearer: ApiBearerSecret | None,
    scope_key: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    nameservers: Sequence[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    raw_body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer.api_key}"
    deadline = time.monotonic() + timeout_s
    try:
        conn, response = outbound.request(
            destination,
            deadline=deadline,
            method="POST",
            body=raw_body,
            headers=headers,
            scope_key=scope_key,
            nameservers=nameservers,
        )
    except BlockedTargetError as exc:
        raise AiGatewayRefusalError(403, "ai_endpoint_ssrf_blocked") from exc
    except FetchError as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc

    try:
        status = response.status
        data = response.read(MAX_RESPONSE_BYTES + 1)
    except (FetchError, OSError) as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc
    finally:
        conn.close()

    if status != 200 or not data or len(data) > MAX_RESPONSE_BYTES:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc
    if not isinstance(parsed, dict):
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    return parsed


def _build_multipart_audio(
    request: AiTranscriptionRequest,
    *,
    boundary: str = "koderaAiVoiceBoundary7f9a2c",
) -> tuple[bytes, str]:
    if not 1 <= len(request.audio_bytes) <= MAX_AUDIO_BYTES:
        raise AiGatewayRefusalError(422, "invalid_audio_size", "validation-error")
    safe_name = (
        "".join(
            ch for ch in request.filename if 32 <= ord(ch) < 127 and ch not in {'"', "\\", ";"}
        )[:120]
        or "voice-note.ogg"
    )
    parts: list[bytes] = [
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="model"\r\n\r\n'
            f"{request.model}\r\n"
        ).encode()
    ]
    if request.language:
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="language"\r\n\r\n'
                f"{request.language}\r\n"
            ).encode()
        )
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: {request.content_type}\r\n\r\n"
        ).encode()
        + request.audio_bytes
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _post_multipart_transcription(
    destination: Target,
    *,
    request: AiTranscriptionRequest,
    bearer: ApiBearerSecret | None,
    provider_label: str,
    scope_key: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    nameservers: Sequence[tuple[str, int]] | None = None,
) -> AiTranscriptionResult:
    raw_body, content_type = _build_multipart_audio(request)
    headers = {
        "Content-Type": content_type,
        "Accept": "application/json",
    }
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer.api_key}"
    deadline = time.monotonic() + timeout_s
    try:
        conn, response = outbound.request(
            destination,
            deadline=deadline,
            method="POST",
            body=raw_body,
            headers=headers,
            scope_key=scope_key,
            nameservers=nameservers,
        )
    except BlockedTargetError as exc:
        raise AiGatewayRefusalError(403, "ai_endpoint_ssrf_blocked") from exc
    except FetchError as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc

    try:
        status = response.status
        data = response.read(MAX_RESPONSE_BYTES + 1)
    except (FetchError, OSError) as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc
    finally:
        conn.close()

    if status != 200 or not data or len(data) > MAX_RESPONSE_BYTES:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable") from exc
    text = parsed.get("text") if isinstance(parsed, dict) else None
    if not isinstance(text, str):
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    language = parsed.get("language") if isinstance(parsed, dict) else None
    return AiTranscriptionResult(
        text=text.strip(),
        language=language if isinstance(language, str) and language else (request.language or "fr"),
        provider=provider_label,
        model=request.model,
    )


def _extract_chat_text(parsed: dict[str, Any]) -> str:
    choices = parsed.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return str(message["content"]).strip()
    raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")


def _resolve_endpoint(base_url: str, suffix: str) -> Target:
    stripped_base = base_url.rstrip("/")
    rel_suffix = suffix.lstrip("/")
    if stripped_base.endswith("/v1") and rel_suffix.startswith("v1/"):
        rel_suffix = rel_suffix[3:]
    joined = urljoin(stripped_base + "/", rel_suffix)
    try:
        dest = outbound.target(joined, https_only=True)
        try:
            ipaddress.ip_address(dest.host)
        except ValueError:
            pass
        else:
            outbound.public_address(dest.host)
        return dest
    except BlockedTargetError as exc:
        raise AiGatewayRefusalError(403, "ai_endpoint_ssrf_blocked") from exc


@dataclass(frozen=True)
class MistralAdapter:
    """EU-sovereign Mistral adapter pinned over `apps.media.outbound` (`https://api.mistral.ai`)."""

    credential: ApiBearerSecret | None = field(default=None, repr=False)
    base_url: str = MISTRAL_EU_BASE_URL
    timeout_s: float = DEFAULT_TIMEOUT_S
    nameservers: Sequence[tuple[str, int]] | None = None

    def __post_init__(self) -> None:
        dest = _resolve_endpoint(self.base_url, "/v1/chat/completions")
        if dest.host != "api.mistral.ai":
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")

    @property
    def provider_id(self) -> str:
        return "mistral"

    @property
    def is_eu_sovereign(self) -> bool:
        return True

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult:
        if self.credential is None:
            raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
        destination = _resolve_endpoint(self.base_url, "/v1/chat/completions")
        parsed = _post_json(
            destination,
            payload={
                "model": request.model,
                "messages": [{"role": "user", "content": request.prompt}],
                "max_tokens": request.max_tokens,
            },
            bearer=self.credential,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )
        return AiCompletionResult(
            text=_extract_chat_text(parsed),
            provider=self.provider_id,
            model=request.model,
        )

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult:
        if self.credential is None:
            raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
        destination = _resolve_endpoint(self.base_url, "/v1/audio/transcriptions")
        return _post_multipart_transcription(
            destination,
            request=request,
            bearer=self.credential,
            provider_label=self.provider_id,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )


@dataclass(frozen=True)
class OpenAICompatibleSelfHostedAdapter:
    """Self-hosted OpenAI-compatible HTTPS adapter blocking private/loopback/link-local SSRF."""

    endpoint: str
    region: str = "eu"
    eu_sovereign_only: bool = True
    credential: ApiBearerSecret | None = field(default=None, repr=False)
    timeout_s: float = DEFAULT_TIMEOUT_S
    nameservers: Sequence[tuple[str, int]] | None = None

    def __post_init__(self) -> None:
        dest = _resolve_endpoint(self.endpoint, "/v1/chat/completions")
        if self.eu_sovereign_only and (self.region != "eu" or dest.host in NON_EU_KNOWN_HOSTS):
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")

    @property
    def provider_id(self) -> str:
        return "self_hosted"

    @property
    def is_eu_sovereign(self) -> bool:
        return self.region == "eu"

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult:
        if self.eu_sovereign_only and not self.is_eu_sovereign:
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        destination = _resolve_endpoint(self.endpoint, "/v1/chat/completions")
        parsed = _post_json(
            destination,
            payload={
                "model": request.model,
                "messages": [{"role": "user", "content": request.prompt}],
                "max_tokens": request.max_tokens,
            },
            bearer=self.credential,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )
        return AiCompletionResult(
            text=_extract_chat_text(parsed),
            provider=self.provider_id,
            model=request.model,
        )

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult:
        if self.eu_sovereign_only and not self.is_eu_sovereign:
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        destination = _resolve_endpoint(self.endpoint, "/v1/audio/transcriptions")
        return _post_multipart_transcription(
            destination,
            request=request,
            bearer=self.credential,
            provider_label=self.provider_id,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )


@dataclass(frozen=True)
class ByomAdapter:
    """Bring-Your-Own-Model adapter unsealing HKDF-sealed tenant config in-memory per call."""

    master_key: bytes = field(repr=False)
    organisation_id: UUID
    workspace_id: UUID
    sealed_config: bytes = field(repr=False)
    eu_sovereign_only: bool = True
    timeout_s: float = DEFAULT_TIMEOUT_S
    nameservers: Sequence[tuple[str, int]] | None = None

    @property
    def provider_id(self) -> str:
        return "byom"

    @property
    def is_eu_sovereign(self) -> bool:
        cfg = self._unseal()
        dest = _resolve_endpoint(cfg.endpoint, "/v1/chat/completions")
        return cfg.region == "eu" and dest.host not in NON_EU_KNOWN_HOSTS

    def _unseal(self) -> Any:
        try:
            cfg = unseal_byom_config(
                self.master_key,
                organisation_id=self.organisation_id,
                workspace_id=self.workspace_id,
                sealed_value=self.sealed_config,
            )
        except SealError as exc:
            raise AiGatewayRefusalError(403, "ai_byom_seal_invalid") from exc
        dest = _resolve_endpoint(cfg.endpoint, "/v1/chat/completions")
        if self.eu_sovereign_only and (cfg.region != "eu" or dest.host in NON_EU_KNOWN_HOSTS):
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        return cfg

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult:
        cfg = self._unseal()
        destination = _resolve_endpoint(cfg.endpoint, "/v1/chat/completions")
        bearer = ApiBearerSecret(api_key=cfg.api_key)
        parsed = _post_json(
            destination,
            payload={
                "model": cfg.model or request.model,
                "messages": [{"role": "user", "content": request.prompt}],
                "max_tokens": request.max_tokens,
            },
            bearer=bearer,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )
        return AiCompletionResult(
            text=_extract_chat_text(parsed),
            provider=self.provider_id,
            model=cfg.model or request.model,
        )

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult:
        cfg = self._unseal()
        destination = _resolve_endpoint(cfg.endpoint, "/v1/audio/transcriptions")
        bearer = ApiBearerSecret(api_key=cfg.api_key)
        effective_request = AiTranscriptionRequest(
            audio_bytes=request.audio_bytes,
            filename=request.filename,
            content_type=request.content_type,
            language=request.language,
            model=cfg.model or request.model,
        )
        return _post_multipart_transcription(
            destination,
            request=effective_request,
            bearer=bearer,
            provider_label=self.provider_id,
            scope_key=scope_key,
            timeout_s=self.timeout_s,
            nameservers=self.nameservers,
        )
