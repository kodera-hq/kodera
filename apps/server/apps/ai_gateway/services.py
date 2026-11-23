"""Three-tier OFF-by-default AI policy evaluation and confidential/E2EE room guardrails."""

from __future__ import annotations

import hashlib
import ipaddress
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import connection, transaction

from apps.audit.services import record_workspace_resource_event
from apps.e2ee.services import (
    has_confidential_room,
    is_ai_or_service_actor as is_ai_or_service_actor,
)
from apps.media import outbound, services as media_services
from apps.media.context import RefusalError as MediaRefusalError, caller, read_caller
from apps.media.outbound import BlockedTargetError, FetchError
from apps.media.services import (
    CompletedAttachmentSnapshot,
    get_completed_attachment,
    quota_replay_policy as quota_replay_policy,
)
from apps.media.storage import ObjectDescriptor, StorageRefusedError
from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.ai_policy import (
    AI_PROVIDER_REGIONS,
    AI_PROVIDERS,
    DEFAULT_MONTHLY_AI_BUDGET_MICROS,
    ChannelAiSnapshot,
    MemberAiConsentSnapshot,
    WorkspaceAiPolicySnapshot,
    get_channel_ai_snapshot,
    get_member_ai_consent_snapshot,
    get_workspace_ai_policy_snapshot,
    reconcile_workspace_ai_budget,
    refund_workspace_ai_budget,
    reserve_workspace_ai_budget,
    set_channel_ai_enabled,
    upsert_member_ai_consent,
    upsert_workspace_ai_policy,
)
from apps.workspaces.channel_access import may_perform, may_view, resolve
from apps.workspaces.channel_sets import lock_workspace
from apps.workspaces.selectors import workspace_id_for
from apps.workspaces.structure import WorkspaceUnavailableError
from core.sealing import SealError
from services.identity.access_tokens import VerifiedAccessToken

from .adapters import (
    MAX_AUDIO_BYTES,
    NON_EU_KNOWN_HOSTS,
    AiCompletionRequest,
    AiCompletionResult,
    AiGatewayRefusalError,
    AiTranscriptionRequest,
    AiTranscriptionResult,
    ApiBearerSecret,
    ByomAdapter,
    MistralAdapter,
    ModelProviderAdapter,
    OpenAICompatibleSelfHostedAdapter,
)
from .sealing import ByomConfigError, ByomSecretConfig, seal_byom_config, unseal_byom_config

ADMINS = frozenset({"org_owner", "org_admin"})
VOICE_NOTE_MIME_TYPES = frozenset(
    {"audio/ogg", "audio/webm", "audio/mp4", "audio/wav", "audio/x-wav"}
)
MAX_MONTHLY_AI_BUDGET_MICROS = 1_000_000_000_000
PROMPT_BASE_COST_MICROS = 1_000
VOICE_TRANSCRIPTION_MIN_COST_MICROS = 5_000
STREAM_CHUNK_BYTES = 65_536
STORAGE_WIRE_HEADER_OVERHEAD = 65_536


@dataclass(frozen=True)
class AdmittedAiExecution:
    principal: TenantCaller
    workspace_id: UUID
    channel_id: UUID
    adapter: ModelProviderAdapter
    model: str


@dataclass
class PreparedVoiceNoteTranscription:
    organisation_id: UUID
    workspace_id: UUID
    attachment_id: UUID
    channel_id: UUID
    body: dict[str, Any]
    result: AiTranscriptionResult = field(repr=False)
    reserved_micros: int = 0
    actual_micros: int = 0
    settled: bool = False


def _estimate_prompt_cost_micros(prompt: str, *, max_tokens: int) -> int:
    return PROMPT_BASE_COST_MICROS + max(1, len(prompt)) * 2 + max(1, max_tokens) * 4


def _actual_prompt_cost_micros(prompt: str, completion: str) -> int:
    return PROMPT_BASE_COST_MICROS + max(1, len(prompt)) * 2 + len(completion) * 4


def _estimate_transcription_cost_micros(size_bytes: int) -> int:
    return max(VOICE_TRANSCRIPTION_MIN_COST_MICROS, (max(1, size_bytes) // 1024) * 50)


def _actual_transcription_cost_micros(size_bytes: int, transcript: str) -> int:
    return max(
        VOICE_TRANSCRIPTION_MIN_COST_MICROS,
        (max(1, size_bytes) // 1024) * 40 + len(transcript) * 2,
    )


def _translate_media_refusal(exc: MediaRefusalError) -> AiGatewayRefusalError:
    return AiGatewayRefusalError(exc.status, exc.reason, exc.kind)


def _require_workspace_id(organisation_id: UUID) -> UUID:
    ws_id = workspace_id_for(organisation_id=organisation_id)
    if ws_id is None:
        raise AiGatewayRefusalError(404, None, "not-found")
    return ws_id


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    try:
        read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None


def _caller_readable_channel(
    *,
    principal: TenantCaller,
    workspace_id: UUID,
    channel_id: UUID,
    required_action: str | None = None,
    for_update: bool = False,
) -> ChannelAiSnapshot | None:
    channel = get_channel_ai_snapshot(
        channel_id=channel_id,
        workspace_id=workspace_id,
        for_update=for_update,
    )
    if channel is None or channel.lifecycle != "active":
        return None
    try:
        access = resolve(channel.id)
    except (ObjectDoesNotExist, WorkspaceUnavailableError):
        return None
    if not may_view(
        access,
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        authority_revision=principal.authority_revision,
    ):
        return None
    if required_action is not None and not may_perform(
        access,
        action=required_action,
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        member_org_role=principal.role,
        authority_revision=principal.authority_revision,
    ):
        return None
    return channel


def _is_channel_confidential(*, organisation_id: UUID, channel: ChannelAiSnapshot) -> bool:
    return bool(channel.is_confidential) or has_confidential_room(
        channel_id=channel.id,
        organisation_id=organisation_id,
    )


def _validate_public_https_endpoint(raw_url: str, *, eu_sovereign_only: bool) -> str:
    try:
        dest = outbound.target(raw_url, https_only=True)
        try:
            ipaddress.ip_address(dest.host)
        except ValueError:
            pass
        else:
            outbound.public_address(dest.host)
    except BlockedTargetError as exc:
        raise AiGatewayRefusalError(403, "ai_endpoint_ssrf_blocked") from exc
    if eu_sovereign_only and dest.host in NON_EU_KNOWN_HOSTS:
        raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
    return dest.url


def _build_adapter(
    policy: WorkspaceAiPolicySnapshot,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
) -> ModelProviderAdapter:
    override = getattr(settings, "KODERA_AI_PROVIDER_ADAPTER", None)
    if isinstance(override, ModelProviderAdapter):
        if policy.eu_sovereign_only and not override.is_eu_sovereign:
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        return override
    if callable(override):
        built = override(policy=policy, organisation_id=organisation_id, workspace_id=workspace_id)
        if not isinstance(built, ModelProviderAdapter):
            raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
        if policy.eu_sovereign_only and not built.is_eu_sovereign:
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        return built

    if policy.eu_sovereign_only and policy.provider_region != "eu":
        raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")

    if policy.provider == "mistral":
        master_key = getattr(settings, "KODERA_AI_SEAL_KEY", None)
        if policy.sealed_byom_config and isinstance(master_key, bytes):
            try:
                cfg = unseal_byom_config(
                    master_key,
                    organisation_id=organisation_id,
                    workspace_id=workspace_id,
                    sealed_value=policy.sealed_byom_config,
                )
            except SealError as exc:
                raise AiGatewayRefusalError(403, "ai_byom_seal_invalid") from exc
            if policy.eu_sovereign_only and cfg.region != "eu":
                raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
            return MistralAdapter(credential=ApiBearerSecret(api_key=cfg.api_key))
        operator_key = getattr(settings, "KODERA_AI_MISTRAL_API_KEY", None)
        if isinstance(operator_key, str) and operator_key:
            return MistralAdapter(credential=ApiBearerSecret(api_key=operator_key))
        return MistralAdapter()

    if policy.provider == "self_hosted":
        if not policy.self_hosted_endpoint:
            raise AiGatewayRefusalError(403, "ai_self_hosted_endpoint_missing")
        return OpenAICompatibleSelfHostedAdapter(
            endpoint=policy.self_hosted_endpoint,
            region=policy.provider_region,
            eu_sovereign_only=policy.eu_sovereign_only,
        )
    if policy.provider == "byom":
        master_key = getattr(settings, "KODERA_AI_SEAL_KEY", None)
        if not isinstance(master_key, bytes) or not policy.sealed_byom_config:
            raise AiGatewayRefusalError(403, "ai_byom_not_configured")
        adapter = ByomAdapter(
            master_key=master_key,
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            sealed_config=policy.sealed_byom_config,
            eu_sovereign_only=policy.eu_sovereign_only,
        )
        if policy.eu_sovereign_only and not adapter.is_eu_sovereign:
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
        return adapter

    raise AiGatewayRefusalError(403, "ai_org_policy_disabled")


@transaction.atomic
def evaluate_ai_gate(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID | None,
    room_id: str | None = None,
    required_channel_action: str | None = None,
    for_update: bool = False,
) -> AdmittedAiExecution:
    """Evaluate all 3 OFF-by-default tiers (`org -> channel -> member`) and room confidentiality."""
    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None

    workspace_id = _require_workspace_id(principal.organisation_id)
    if channel_id is None or room_id is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    # Enforce caller channel visibility & action RBAC BEFORE revealing confidential vs ordinary state.
    channel = _caller_readable_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel_id,
        required_action=required_channel_action,
        for_update=for_update,
    )
    if channel is None:
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled")

    if _is_channel_confidential(organisation_id=principal.organisation_id, channel=channel):
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    if getattr(settings, "KODERA_AI_GATEWAY_ENABLED", False) is not True:
        raise AiGatewayRefusalError(403, "ai_gateway_disabled")

    org_policy = get_workspace_ai_policy_snapshot(
        organisation_id=principal.organisation_id,
        workspace_id=workspace_id,
        for_update=for_update,
    )
    if org_policy is None or not org_policy.enabled:
        raise AiGatewayRefusalError(403, "ai_org_policy_disabled")

    if org_policy.eu_sovereign_only and org_policy.provider_region != "eu":
        raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")

    if not channel.ai_enabled:
        raise AiGatewayRefusalError(403, "ai_channel_policy_disabled")

    consent = get_member_ai_consent_snapshot(
        organisation_id=principal.organisation_id,
        workspace_id=workspace_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
        for_update=for_update,
    )
    if consent is None or not consent.enabled or consent.revoked_at is not None:
        raise AiGatewayRefusalError(403, "ai_member_consent_required")

    adapter = _build_adapter(
        org_policy,
        organisation_id=principal.organisation_id,
        workspace_id=workspace_id,
    )
    return AdmittedAiExecution(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=channel.id,
        adapter=adapter,
        model=org_policy.model,
    )


def complete_channel_prompt(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID | None,
    prompt: str,
    room_id: str | None = None,
    max_tokens: int = 512,
) -> AiCompletionResult:
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 16384:
        raise AiGatewayRefusalError(422, "invalid_prompt", "validation-error")
    cleaned_prompt = prompt.strip()
    reserved_micros = _estimate_prompt_cost_micros(cleaned_prompt, max_tokens=max_tokens)

    with transaction.atomic():
        admitted = evaluate_ai_gate(
            verified=verified,
            organisation_id=organisation_id,
            channel_id=channel_id,
            room_id=room_id,
            for_update=True,
        )
        if not reserve_workspace_ai_budget(
            organisation_id=admitted.principal.organisation_id,
            workspace_id=admitted.workspace_id,
            reserve_micros=reserved_micros,
        ):
            raise AiGatewayRefusalError(429, "ai_budget_exhausted", "rate-limited")

    try:
        result = admitted.adapter.complete(
            AiCompletionRequest(prompt=cleaned_prompt, model=admitted.model, max_tokens=max_tokens),
            scope_key=str(admitted.principal.organisation_id),
        )
    except BaseException:
        with transaction.atomic():
            refund_workspace_ai_budget(
                organisation_id=admitted.principal.organisation_id,
                workspace_id=admitted.workspace_id,
                reserved_micros=reserved_micros,
            )
        raise

    actual_micros = _actual_prompt_cost_micros(cleaned_prompt, result.text)
    refusal: AiGatewayRefusalError | None = None
    with transaction.atomic():
        try:
            with transaction.atomic():
                evaluate_ai_gate(
                    verified=verified,
                    organisation_id=organisation_id,
                    channel_id=channel_id,
                    room_id=room_id,
                    for_update=True,
                )
        except AiGatewayRefusalError as exc:
            refusal = exc
            refund_workspace_ai_budget(
                organisation_id=admitted.principal.organisation_id,
                workspace_id=admitted.workspace_id,
                reserved_micros=reserved_micros,
            )
        except BaseException:
            refund_workspace_ai_budget(
                organisation_id=admitted.principal.organisation_id,
                workspace_id=admitted.workspace_id,
                reserved_micros=reserved_micros,
            )
            raise
        else:
            reconcile_workspace_ai_budget(
                organisation_id=admitted.principal.organisation_id,
                workspace_id=admitted.workspace_id,
                reserved_micros=reserved_micros,
                actual_micros=actual_micros,
            )
    if refusal is not None:
        raise refusal
    return result


def _serialize_policy(
    *,
    policy: WorkspaceAiPolicySnapshot | None,
    consent: MemberAiConsentSnapshot | None,
) -> dict[str, Any]:
    return {
        "gatewayEnabled": getattr(settings, "KODERA_AI_GATEWAY_ENABLED", False) is True,
        "enabled": bool(policy.enabled) if policy is not None else False,
        "provider": policy.provider if policy is not None else "mistral",
        "providerRegion": policy.provider_region if policy is not None else "eu",
        "euSovereignOnly": policy.eu_sovereign_only if policy is not None else True,
        "selfHostedEndpoint": policy.self_hosted_endpoint if policy is not None else "",
        "model": policy.model if policy is not None else "mistral-small-latest",
        "hasByomConfig": bool(policy and policy.sealed_byom_config),
        "monthlyBudgetMicros": (
            policy.monthly_budget_micros if policy is not None else DEFAULT_MONTHLY_AI_BUDGET_MICROS
        ),
        "monthlySpentMicros": policy.monthly_spent_micros if policy is not None else 0,
        "memberConsent": {
            "enabled": bool(consent and consent.enabled and consent.revoked_at is None),
            "consentedAt": (
                consent.consented_at.strftime("%Y-%m-%dT%H:%M:%SZ")
                if consent and consent.consented_at is not None
                else None
            ),
            "revokedAt": (
                consent.revoked_at.strftime("%Y-%m-%dT%H:%M:%SZ")
                if consent and consent.revoked_at is not None
                else None
            ),
        },
    }


def get_ai_policy(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    with transaction.atomic():
        try:
            principal = read_caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        workspace_id = _require_workspace_id(principal.organisation_id)
        policy = get_workspace_ai_policy_snapshot(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
        )
        consent = get_member_ai_consent_snapshot(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
        )
        return _serialize_policy(policy=policy, consent=consent)


def update_workspace_ai_policy(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    with transaction.atomic():
        try:
            principal = caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        if principal.role not in ADMINS:
            raise AiGatewayRefusalError(403, "admin_required")
        workspace_id = lock_workspace(principal.organisation_id)
        if workspace_id is None:
            raise AiGatewayRefusalError(404, None, "not-found")

        policy = get_workspace_ai_policy_snapshot(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            for_update=True,
        )

        enabled = body.get("enabled", policy.enabled if policy is not None else False)
        provider = body.get("provider", policy.provider if policy is not None else "mistral")
        provider_region = body.get(
            "providerRegion", policy.provider_region if policy is not None else "eu"
        )
        eu_sovereign_only = body.get(
            "euSovereignOnly", policy.eu_sovereign_only if policy is not None else True
        )
        endpoint = body.get(
            "selfHostedEndpoint", policy.self_hosted_endpoint if policy is not None else ""
        )
        model = body.get("model", policy.model if policy is not None else "mistral-small-latest")
        monthly_budget_micros = body.get(
            "monthlyBudgetMicros",
            policy.monthly_budget_micros
            if policy is not None
            else DEFAULT_MONTHLY_AI_BUDGET_MICROS,
        )
        clear_byom = body.get("clearByomConfig", False)

        if (
            type(enabled) is not bool
            or type(eu_sovereign_only) is not bool
            or type(clear_byom) is not bool
            or type(monthly_budget_micros) is not int
            or not 0 <= monthly_budget_micros <= MAX_MONTHLY_AI_BUDGET_MICROS
            or not isinstance(provider, str)
            or provider not in AI_PROVIDERS
            or not isinstance(provider_region, str)
            or provider_region not in AI_PROVIDER_REGIONS
            or not isinstance(endpoint, str)
            or len(endpoint) > 2048
            or not isinstance(model, str)
            or not 1 <= len(model) <= 128
            or any(ord(ch) <= 32 or ord(ch) == 127 for ch in model)
        ):
            raise AiGatewayRefusalError(422, "invalid_ai_policy", "validation-error")

        if clear_byom and body.get("byomConfig") is not None:
            raise AiGatewayRefusalError(422, "invalid_byom_config", "validation-error")

        if eu_sovereign_only and provider_region != "eu":
            raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")

        if endpoint:
            endpoint = _validate_public_https_endpoint(
                endpoint, eu_sovereign_only=eu_sovereign_only
            )

        sealed_bytes = policy.sealed_byom_config if policy is not None else b""
        if clear_byom or ("byomConfig" in body and body["byomConfig"] is None):
            sealed_bytes = b""
        elif "byomConfig" in body and body["byomConfig"] is not None:
            raw_byom = body["byomConfig"]
            if (
                not isinstance(raw_byom, dict)
                or not {"endpoint", "model", "apiKey"} <= set(raw_byom)
                or set(raw_byom) - {"endpoint", "model", "apiKey", "region"}
                or not isinstance(raw_byom["endpoint"], str)
            ):
                raise AiGatewayRefusalError(422, "invalid_byom_config", "validation-error")
            byom_region = raw_byom.get("region", provider_region)
            if eu_sovereign_only and byom_region != "eu":
                raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
            validated_byom_endpoint = _validate_public_https_endpoint(
                raw_byom["endpoint"], eu_sovereign_only=eu_sovereign_only
            )
            master_key = getattr(settings, "KODERA_AI_SEAL_KEY", None)
            if not isinstance(master_key, bytes):
                raise AiGatewayRefusalError(503, "ai_seal_key_unconfigured", "service-unavailable")
            try:
                secret_cfg = ByomSecretConfig(
                    endpoint=validated_byom_endpoint,
                    model=raw_byom["model"],
                    api_key=raw_byom["apiKey"],
                    region=byom_region,
                )
                sealed_bytes = seal_byom_config(
                    master_key,
                    organisation_id=principal.organisation_id,
                    workspace_id=workspace_id,
                    config=secret_cfg,
                )
            except (ByomConfigError, SealError) as exc:
                raise AiGatewayRefusalError(422, "invalid_byom_config", "validation-error") from exc
        elif eu_sovereign_only and sealed_bytes:
            master_key = getattr(settings, "KODERA_AI_SEAL_KEY", None)
            if isinstance(master_key, bytes):
                try:
                    existing_cfg = unseal_byom_config(
                        master_key,
                        organisation_id=principal.organisation_id,
                        workspace_id=workspace_id,
                        sealed_value=sealed_bytes,
                    )
                except SealError as exc:
                    raise AiGatewayRefusalError(403, "ai_byom_seal_invalid") from exc
                if existing_cfg.region != "eu":
                    raise AiGatewayRefusalError(403, "ai_provider_non_eu_forbidden")
                _validate_public_https_endpoint(existing_cfg.endpoint, eu_sovereign_only=True)

        policy = upsert_workspace_ai_policy(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            enabled=enabled,
            provider=provider,
            provider_region=provider_region,
            eu_sovereign_only=eu_sovereign_only,
            self_hosted_endpoint=endpoint,
            model=model,
            sealed_byom_config=sealed_bytes,
            monthly_budget_micros=monthly_budget_micros,
        )

        record_workspace_resource_event(
            action="workspace.ai_policy.updated",
            organisation_id=principal.organisation_id,
            target_id=policy.id,
            actor_id=principal.identity_id,
            request_id=request_id,
        )
        consent = get_member_ai_consent_snapshot(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
        )
        return _serialize_policy(policy=policy, consent=consent)


def update_channel_ai_policy(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    ai_enabled = body.get("aiEnabled")
    if type(ai_enabled) is not bool:
        raise AiGatewayRefusalError(422, "invalid_channel_ai_policy", "validation-error")
    with transaction.atomic():
        try:
            principal = caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        if principal.role not in ADMINS:
            raise AiGatewayRefusalError(403, "admin_required")
        workspace_id = lock_workspace(principal.organisation_id)
        if workspace_id is None:
            raise AiGatewayRefusalError(404, None, "not-found")
        channel = get_channel_ai_snapshot(
            channel_id=channel_id,
            workspace_id=workspace_id,
            for_update=True,
        )
        if channel is None or channel.lifecycle == "deleted":
            raise AiGatewayRefusalError(404, None, "not-found")
        if _is_channel_confidential(organisation_id=principal.organisation_id, channel=channel):
            raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
        set_channel_ai_enabled(channel_id=channel.id, ai_enabled=ai_enabled)
        record_workspace_resource_event(
            action="workspace.channel_ai.updated",
            organisation_id=principal.organisation_id,
            target_id=channel.id,
            actor_id=principal.identity_id,
            request_id=request_id,
        )
        return {"channelId": str(channel.id), "aiEnabled": ai_enabled}


def update_member_ai_consent(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    enabled = body.get("enabled")
    if type(enabled) is not bool:
        raise AiGatewayRefusalError(422, "invalid_member_ai_consent", "validation-error")
    with transaction.atomic():
        try:
            principal = caller(verified, organisation_id)
        except MediaRefusalError as exc:
            raise _translate_media_refusal(exc) from None
        workspace_id = _require_workspace_id(principal.organisation_id)
        consent = upsert_member_ai_consent(
            organisation_id=principal.organisation_id,
            workspace_id=workspace_id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
            enabled=enabled,
        )
        record_workspace_resource_event(
            action="workspace.member_ai_consent.updated",
            organisation_id=principal.organisation_id,
            target_id=consent.id,
            actor_id=principal.identity_id,
            request_id=request_id,
        )
        return {
            "enabled": bool(consent.enabled and consent.revoked_at is None),
            "consentedAt": (
                consent.consented_at.strftime("%Y-%m-%dT%H:%M:%SZ")
                if consent.consented_at is not None
                else None
            ),
            "revokedAt": (
                consent.revoked_at.strftime("%Y-%m-%dT%H:%M:%SZ")
                if consent.revoked_at is not None
                else None
            ),
        }


def _has_valid_audio_magic(data: bytes) -> bool:
    if data.startswith(b"OggS"):
        return True
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return True
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return True
    return len(data) >= 8 and data[4:8] == b"ftyp"


def _verify_attachment_audio_payload(row: CompletedAttachmentSnapshot, data: bytes) -> bytes:
    if not isinstance(data, bytes) or len(data) != row.size_bytes:
        raise AiGatewayRefusalError(503, "ai_storage_unavailable", "service-unavailable")
    if hashlib.sha256(data).hexdigest().lower() != row.sha256.lower():
        raise AiGatewayRefusalError(503, "ai_storage_integrity_failed", "service-unavailable")
    if not _has_valid_audio_magic(data):
        raise AiGatewayRefusalError(422, "invalid_audio_container", "validation-error")
    return data


def _fetch_attachment_audio_bytes(row: CompletedAttachmentSnapshot) -> bytes:
    if not 1 <= row.size_bytes <= MAX_AUDIO_BYTES:
        raise AiGatewayRefusalError(422, "invalid_audio_size", "validation-error")

    test_loader = getattr(settings, "KODERA_AI_ATTACHMENT_BYTES_LOADER", None)
    if callable(test_loader):
        return _verify_attachment_audio_payload(row, test_loader(row))

    try:
        gateway = media_services._gateway()
        descriptor = ObjectDescriptor(
            row.organisation_id,
            row.id,
            row.filename,
            row.content_type,
            row.size_bytes,
            row.sha256,
        )
        presigned = gateway.call("download", descriptor)
        destination = outbound.target(presigned["url"], https_only=True)
        try:
            ipaddress.ip_address(destination.host)
        except ValueError:
            pass
        else:
            outbound.public_address(destination.host)
        conn, response = outbound.request(
            destination,
            deadline=time.monotonic() + 30.0,
            method="GET",
            pool="storage",
            scope_key=str(row.organisation_id),
            max_wire=row.size_bytes + STORAGE_WIRE_HEADER_OVERHEAD,
        )
    except (StorageRefusedError, BlockedTargetError, FetchError) as exc:
        raise AiGatewayRefusalError(503, "ai_storage_unavailable", "service-unavailable") from exc

    chunks: list[bytes] = []
    total = 0
    try:
        if response.status != 200:
            raise AiGatewayRefusalError(503, "ai_storage_unavailable", "service-unavailable")
        while True:
            remaining_cap = row.size_bytes - total + 1
            chunk = response.read(min(STREAM_CHUNK_BYTES, max(1, remaining_cap)))
            if not chunk:
                break
            total += len(chunk)
            if total > row.size_bytes:
                raise AiGatewayRefusalError(503, "ai_storage_unavailable", "service-unavailable")
            chunks.append(chunk)
    except (FetchError, OSError) as exc:
        raise AiGatewayRefusalError(503, "ai_storage_unavailable", "service-unavailable") from exc
    finally:
        conn.close()

    return _verify_attachment_audio_payload(row, b"".join(chunks))


@transaction.atomic
def authorize_voice_note_transcription(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    attachment_id: UUID,
    body: dict[str, Any],
    for_update: bool = False,
) -> tuple[AdmittedAiExecution, CompletedAttachmentSnapshot, str | None]:
    raw_room = body.get("roomId")
    if raw_room is not None:
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
    raw_channel = body.get("channelId")
    requested_channel_id: UUID | None = None
    if raw_channel is not None:
        if not isinstance(raw_channel, str):
            raise AiGatewayRefusalError(422, "invalid_channel_id", "validation-error")
        try:
            requested_channel_id = UUID(raw_channel)
        except ValueError:
            raise AiGatewayRefusalError(422, "invalid_channel_id", "validation-error") from None

    language = body.get("language")
    if language is not None and (
        not isinstance(language, str)
        or not 2 <= len(language) <= 16
        or not all(ch.isalnum() or ch == "-" for ch in language)
    ):
        raise AiGatewayRefusalError(422, "invalid_language", "validation-error")

    try:
        principal = read_caller(verified, organisation_id)
    except MediaRefusalError as exc:
        raise _translate_media_refusal(exc) from None
    workspace_id = _require_workspace_id(principal.organisation_id)

    req_channel: ChannelAiSnapshot | None = None
    if requested_channel_id is not None:
        req_channel = _caller_readable_channel(
            principal=principal,
            workspace_id=workspace_id,
            channel_id=requested_channel_id,
            required_action="file.read",
            for_update=for_update,
        )
        if req_channel is None:
            raise AiGatewayRefusalError(404, None, "not-found")

    row = get_completed_attachment(
        attachment_id=attachment_id, organisation_id=principal.organisation_id
    )
    if row is None:
        if req_channel is not None and _is_channel_confidential(
            organisation_id=principal.organisation_id, channel=req_channel
        ):
            raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")
        raise AiGatewayRefusalError(404, None, "not-found")

    if row.room_id is not None or row.channel_id is None:
        if row.uploader_id != principal.membership_id:
            raise AiGatewayRefusalError(404, None, "not-found")
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    # Enforce caller channel `may_view` + `may_perform("file.read")` on the attachment's own channel
    # BEFORE checking channel mismatch, confidentiality, or MIME type so inaccessible attachments
    # uniformly return 404 without leaking existence, channel membership, or content type.
    row_channel = _caller_readable_channel(
        principal=principal,
        workspace_id=workspace_id,
        channel_id=row.channel_id,
        required_action="file.read",
        for_update=for_update,
    )
    if row_channel is None:
        raise AiGatewayRefusalError(404, None, "not-found")

    if (
        _is_channel_confidential(organisation_id=principal.organisation_id, channel=row_channel)
        or (
            req_channel is not None
            and _is_channel_confidential(
                organisation_id=principal.organisation_id, channel=req_channel
            )
        )
        or (requested_channel_id is not None and requested_channel_id != row.channel_id)
    ):
        raise AiGatewayRefusalError(403, "ai_confidential_or_unclassified_room_forbidden")

    if row.content_type not in VOICE_NOTE_MIME_TYPES:
        raise AiGatewayRefusalError(422, "unsupported_voice_note_type", "validation-error")
    if not 1 <= row.size_bytes <= MAX_AUDIO_BYTES:
        raise AiGatewayRefusalError(422, "invalid_audio_size", "validation-error")

    admitted = evaluate_ai_gate(
        verified=verified,
        organisation_id=organisation_id,
        channel_id=row.channel_id,
        required_channel_action="file.read",
        for_update=for_update,
    )
    return admitted, row, language


def release_uncommitted_transcription_budget(prepared: PreparedVoiceNoteTranscription) -> None:
    if prepared.settled or prepared.reserved_micros <= 0:
        return
    with transaction.atomic():
        refund_workspace_ai_budget(
            organisation_id=prepared.organisation_id,
            workspace_id=prepared.workspace_id,
            reserved_micros=prepared.reserved_micros,
        )
    prepared.settled = True


def prepare_voice_note_transcription(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    attachment_id: UUID,
    body: dict[str, Any],
) -> PreparedVoiceNoteTranscription:
    if connection.in_atomic_block:
        raise RuntimeError("Voice note transcription I/O requires no enclosing transaction")
    with transaction.atomic():
        admitted, row, language = authorize_voice_note_transcription(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
            body=body,
            for_update=True,
        )
        reserved_micros = _estimate_transcription_cost_micros(row.size_bytes)
        if not reserve_workspace_ai_budget(
            organisation_id=admitted.principal.organisation_id,
            workspace_id=admitted.workspace_id,
            reserve_micros=reserved_micros,
        ):
            raise AiGatewayRefusalError(429, "ai_budget_exhausted", "rate-limited")

    try:
        audio_bytes = _fetch_attachment_audio_bytes(row)
        result = admitted.adapter.transcribe(
            AiTranscriptionRequest(
                audio_bytes=audio_bytes,
                filename=row.filename,
                content_type=row.content_type,
                language=language,
                model=admitted.model,
            ),
            scope_key=str(admitted.principal.organisation_id),
        )
    except BaseException:
        with transaction.atomic():
            refund_workspace_ai_budget(
                organisation_id=admitted.principal.organisation_id,
                workspace_id=admitted.workspace_id,
                reserved_micros=reserved_micros,
            )
        raise

    return PreparedVoiceNoteTranscription(
        organisation_id=admitted.principal.organisation_id,
        workspace_id=admitted.workspace_id,
        attachment_id=row.id,
        channel_id=admitted.channel_id,
        body=dict(body),
        result=result,
        reserved_micros=reserved_micros,
        actual_micros=_actual_transcription_cost_micros(row.size_bytes, result.text),
    )


def commit_voice_note_transcription(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    prepared: PreparedVoiceNoteTranscription,
    request_id: str,
) -> dict[str, Any]:
    refusal: AiGatewayRefusalError | None = None
    admitted: AdmittedAiExecution | None = None
    row: CompletedAttachmentSnapshot | None = None

    with transaction.atomic():
        try:
            with transaction.atomic():
                admitted, row, _ = authorize_voice_note_transcription(
                    verified=verified,
                    organisation_id=organisation_id,
                    attachment_id=prepared.attachment_id,
                    body=prepared.body,
                    for_update=True,
                )
        except AiGatewayRefusalError as exc:
            refusal = exc
            if not prepared.settled and prepared.reserved_micros > 0:
                refund_workspace_ai_budget(
                    organisation_id=prepared.organisation_id,
                    workspace_id=prepared.workspace_id,
                    reserved_micros=prepared.reserved_micros,
                )
                prepared.settled = True
        except BaseException:
            if not prepared.settled and prepared.reserved_micros > 0:
                refund_workspace_ai_budget(
                    organisation_id=prepared.organisation_id,
                    workspace_id=prepared.workspace_id,
                    reserved_micros=prepared.reserved_micros,
                )
                prepared.settled = True
            raise
        else:
            if not prepared.settled and prepared.reserved_micros > 0:
                reconcile_workspace_ai_budget(
                    organisation_id=prepared.organisation_id,
                    workspace_id=prepared.workspace_id,
                    reserved_micros=prepared.reserved_micros,
                    actual_micros=prepared.actual_micros,
                )
                prepared.settled = True
            if admitted is None or row is None:
                raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
            record_workspace_resource_event(
                action="workspace.attachment.transcribed",
                organisation_id=admitted.principal.organisation_id,
                target_id=row.id,
                actor_id=admitted.principal.identity_id,
                request_id=request_id,
            )

    if refusal is not None:
        raise refusal
    if admitted is None or row is None:
        raise AiGatewayRefusalError(503, "ai_provider_unavailable", "service-unavailable")
    return {
        "attachmentId": str(row.id),
        "channelId": str(admitted.channel_id),
        "text": prepared.result.text,
        "language": prepared.result.language,
        "provider": prepared.result.provider,
        "model": prepared.result.model,
    }


def transcribe_voice_note(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    attachment_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    prepared = prepare_voice_note_transcription(
        verified=verified,
        organisation_id=organisation_id,
        attachment_id=attachment_id,
        body=body,
    )
    try:
        return commit_voice_note_transcription(
            verified=verified,
            organisation_id=organisation_id,
            prepared=prepared,
            request_id=request_id,
        )
    finally:
        if not connection.in_atomic_block:
            release_uncommitted_transcription_budget(prepared)
