"""Ironclad AI gateway (OFF-by-default), HKDF BYOM sealing, triple-layer 403 guardrails, and voice notes."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import secrets
import threading
from dataclasses import replace
from typing import Any
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from customer_http_fixtures import http_signer as http_signer
from django.db import IntegrityError, connection, transaction
from django.test import override_settings
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_onboarding import call as assert_contract_response
from workspace_media.test_media_services import gateway as gateway
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

from apps.ai_gateway import services as ai_services
from apps.ai_gateway.adapters import (
    AiCompletionRequest,
    AiCompletionResult,
    AiGatewayRefusalError,
    AiTranscriptionRequest,
    AiTranscriptionResult,
    ApiBearerSecret,
    ByomAdapter,
    MistralAdapter,
    OpenAICompatibleSelfHostedAdapter,
)
from apps.ai_gateway.sealing import (
    AAD_PREFIX,
    HKDF_INFO,
    ByomConfigError,
    ByomSecretConfig,
    byom_aad,
    derive_byom_subkey,
    seal_byom_config,
    unseal_byom_config,
)
from apps.e2ee import services as e2ee_services
from apps.e2ee.models import Room as ConfidentialRoom
from apps.media import outbound, services as media_services
from apps.media.models import Attachment
from apps.workspaces.models import (
    Channel,
    MemberAiConsent,
    ResourcePolicy,
    ResourcePolicyRule,
    Workspace,
    WorkspaceAiPolicy,
)
from config.environment import ADMITTED_SECRET_NAMES, unadmitted_secret_names
from config.workspace_features import (
    ai_actor_subjects,
    ai_client_ids,
    ai_gateway_enabled,
    ai_seal_key,
)
from core.sealing import SealError, unseal
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)

OGG_VOICE_BYTES = b"OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00kodera-voice-note"
WEBM_VOICE_BYTES = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81kodera-webm-voice"
MP4_VOICE_BYTES = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00kodera-mp4-voice"


class FakeEuAdapter:
    provider_id = "mistral"

    def __init__(self, *, eu_sovereign: bool = True) -> None:
        self._eu = eu_sovereign
        self.completions: list[tuple[AiCompletionRequest, str]] = []
        self.transcriptions: list[tuple[AiTranscriptionRequest, str]] = []

    @property
    def is_eu_sovereign(self) -> bool:
        return self._eu

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult:
        self.completions.append((request, scope_key))
        return AiCompletionResult(
            text="Synthèse souveraine validée.",
            provider=self.provider_id,
            model=request.model,
        )

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult:
        self.transcriptions.append((request, scope_key))
        return AiTranscriptionResult(
            text="Point produit confirmé à 14h.",
            language=request.language or "fr",
            provider=self.provider_id,
            model=request.model,
        )


def _auth_headers(token: str, *, key: str | None = None) -> dict[str, str]:
    result = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
    if key is not None:
        result["HTTP_IDEMPOTENCY_KEY"] = key
    return result


def _create_channel(
    workspace: Workspace,
    *,
    name: str = "General AI",
    is_confidential: bool = False,
    ai_enabled: bool = False,
) -> Channel:
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    if workspace.default_policy_id is None:
        Workspace.objects.filter(pk=workspace.id).update(default_policy=policy)
    next_pos = Channel.objects.filter(workspace=workspace, category__isnull=True).count() + 1
    return Channel.objects.create(
        workspace=workspace,
        name=name,
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=next_pos,
        policy_mode="explicit",
        explicit_policy=policy,
        is_confidential=is_confidential,
        ai_enabled=ai_enabled,
    )


def test_adr_0003_admits_single_optional_seal_key_and_defaults_ai_gateway_off() -> None:
    assert "KODERA_AI_SEAL_KEY" in ADMITTED_SECRET_NAMES
    assert unadmitted_secret_names({"KODERA_AI_SEAL_KEY": "x"}) == []
    assert unadmitted_secret_names({"OPENAI_API_KEY": "x"}) == ["OPENAI_API_KEY"]
    assert ai_gateway_enabled({}) is False
    assert ai_gateway_enabled({"KODERA_AI_GATEWAY_ENABLED": "true"}) is True
    assert ai_seal_key({}) is None

    raw_master = secrets.token_bytes(32)
    encoded = base64.urlsafe_b64encode(raw_master).decode("ascii")
    assert ai_seal_key({"KODERA_AI_SEAL_KEY": encoded}) == raw_master


def test_hkdf_byom_sealing_redacts_repr_and_rejects_cross_tenant_aad_tamper() -> None:
    master_key = secrets.token_bytes(32)
    org_a, ws_a = uuid4(), uuid4()
    org_b, ws_b = uuid4(), uuid4()
    secret_api_key = "sk-live-super-secret-byom-token-987654"

    cfg = ByomSecretConfig(
        endpoint="https://llm.eu-west.acme.example/v1",
        model="mistral-large-eu",
        api_key=secret_api_key,
        region="eu",
    )
    bearer = ApiBearerSecret(api_key=secret_api_key)
    assert secret_api_key not in repr(cfg)
    assert secret_api_key not in str(cfg)
    assert secret_api_key not in repr(bearer)

    # Exact RFC 5869 HKDF-SHA256 derivation check (`salt=org_id.bytes, info=b"kodera-ai-byom-v1"`).
    expected_subkey = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=org_a.bytes,
        info=b"kodera-ai-byom-v1",
    ).derive(master_key)
    assert HKDF_INFO == b"kodera-ai-byom-v1"
    assert derive_byom_subkey(master_key, organisation_id=org_a) == expected_subkey
    assert byom_aad(organisation_id=org_a, workspace_id=ws_a) == (
        AAD_PREFIX + org_a.bytes + b":" + ws_a.bytes
    )

    sealed_blob = seal_byom_config(
        master_key,
        organisation_id=org_a,
        workspace_id=ws_a,
        config=cfg,
    )
    assert secret_api_key.encode("utf-8") not in sealed_blob

    # Direct core.sealing.unseal verification with exact AAD.
    raw_json = unseal(expected_subkey, b"ai-byom:" + org_a.bytes + b":" + ws_a.bytes, sealed_blob)
    assert json.loads(raw_json.decode("utf-8"))["api_key"] == secret_api_key

    roundtrip = unseal_byom_config(
        master_key,
        organisation_id=org_a,
        workspace_id=ws_a,
        sealed_value=sealed_blob,
    )
    assert roundtrip == cfg
    assert secret_api_key not in repr(roundtrip)

    # Cross-org or cross-workspace AAD mismatch MUST fail closed.
    for bad_org, bad_ws in ((org_b, ws_a), (org_a, ws_b), (org_b, ws_b)):
        with pytest.raises(SealError):
            unseal_byom_config(
                master_key,
                organisation_id=bad_org,
                workspace_id=bad_ws,
                sealed_value=sealed_blob,
            )

    # SSRF / non-HTTPS BYOM endpoints are rejected before sealing.
    for bad_url in (
        "http://llm.acme.example/v1",
        "https://127.0.0.1/v1",
        "https://169.254.169.254/v1",
    ):
        with pytest.raises(ByomConfigError):
            ByomSecretConfig(endpoint=bad_url, model="m1", api_key=secret_api_key, region="eu")


def test_mistral_self_hosted_and_byom_adapters_pin_outbound_https_and_block_ssrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[tuple[outbound.Target, dict[str, str], bytes]] = []

    class FakeConn:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    class FakeResp:
        def __init__(self, payload: dict[str, Any], status: int = 200) -> None:
            self.status = status
            self._buf = io.BytesIO(json.dumps(payload).encode("utf-8"))

        def read(self, n: int = -1) -> bytes:
            return self._buf.read(n)

    def fake_outbound_request(
        destination: outbound.Target,
        *,
        deadline: float,
        method: str = "GET",
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        **_: Any,
    ) -> tuple[FakeConn, FakeResp]:
        assert method == "POST"
        assert destination.scheme == "https"
        captured.append((destination, dict(headers or {}), body or b""))
        if destination.url.endswith("/audio/transcriptions"):
            return FakeConn(), FakeResp({"text": "Bonjour équipe", "language": "fr"})
        return FakeConn(), FakeResp({"choices": [{"message": {"content": "Réponse souveraine."}}]})

    monkeypatch.setattr(outbound, "request", fake_outbound_request)

    mistral = MistralAdapter(credential=ApiBearerSecret("mk-eu-secret"))
    assert mistral.is_eu_sovereign is True
    comp = mistral.complete(
        AiCompletionRequest(prompt="Résumé", model="mistral-small-latest"),
        scope_key="org-1",
    )
    assert comp.text == "Réponse souveraine." and comp.provider == "mistral"
    assert captured[-1][0].url == "https://api.mistral.ai/v1/chat/completions"
    assert captured[-1][1]["Authorization"] == "Bearer mk-eu-secret"

    tr = mistral.transcribe(
        AiTranscriptionRequest(audio_bytes=OGG_VOICE_BYTES, language="fr"),
        scope_key="org-1",
    )
    assert tr.text == "Bonjour équipe" and tr.language == "fr"
    assert captured[-1][0].url == "https://api.mistral.ai/v1/audio/transcriptions"

    # Base URLs already ending in `/v1` or `/v1/` resolve to exact `/v1/...` (never `/v1/v1/...`)!
    for sh_base in (
        "https://llm.eu.acme.example",
        "https://llm.eu.acme.example/v1",
        "https://llm.eu.acme.example/v1/",
    ):
        sh_adapter = OpenAICompatibleSelfHostedAdapter(
            endpoint=sh_base,
            region="eu",
            eu_sovereign_only=True,
            credential=ApiBearerSecret("sh-key"),
        )
        sh_adapter.complete(AiCompletionRequest(prompt="Hi", model="m1"), scope_key="org-sh")
        assert captured[-1][0].url == "https://llm.eu.acme.example/v1/chat/completions"
        sh_adapter.transcribe(
            AiTranscriptionRequest(audio_bytes=OGG_VOICE_BYTES, language="fr"),
            scope_key="org-sh",
        )
        assert captured[-1][0].url == "https://llm.eu.acme.example/v1/audio/transcriptions"

    # Self-hosted SSRF & HTTP targets fail closed with 403 ai_endpoint_ssrf_blocked.
    for ssrf_endpoint in (
        "http://selfhosted.internal/v1",
        "https://127.0.0.1:8443/v1",
        "https://10.0.0.8/v1",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/v1",
    ):
        with pytest.raises(AiGatewayRefusalError) as blocked:
            OpenAICompatibleSelfHostedAdapter(endpoint=ssrf_endpoint)
        assert blocked.value.status == 403
        assert blocked.value.reason == "ai_endpoint_ssrf_blocked"

    # Non-EU known hosts or non-EU regions fail closed when eu_sovereign_only=True.
    for non_eu_kwargs in (
        {"endpoint": "https://api.openai.com/v1", "region": "eu", "eu_sovereign_only": True},
        {"endpoint": "https://llm.acme.example/v1", "region": "non_eu", "eu_sovereign_only": True},
    ):
        with pytest.raises(AiGatewayRefusalError) as non_eu:
            OpenAICompatibleSelfHostedAdapter(**non_eu_kwargs)  # type: ignore[arg-type]
        assert non_eu.value.status == 403
        assert non_eu.value.reason == "ai_provider_non_eu_forbidden"

    # ByomAdapter unseals HKDF-sealed config in-memory per call and enforces eu_sovereign_only.
    master_key = secrets.token_bytes(32)
    org_id, ws_id = uuid4(), uuid4()
    sealed_eu = seal_byom_config(
        master_key,
        organisation_id=org_id,
        workspace_id=ws_id,
        config=ByomSecretConfig(
            endpoint="https://byom.eu.acme.example/v1",
            model="voxtral-mini-latest",
            api_key="byom-key-eu-123",
            region="eu",
        ),
    )
    byom_adapter = ByomAdapter(
        master_key=master_key,
        organisation_id=org_id,
        workspace_id=ws_id,
        sealed_config=sealed_eu,
        eu_sovereign_only=True,
    )
    assert byom_adapter.is_eu_sovereign is True
    byom_res = byom_adapter.complete(
        AiCompletionRequest(prompt="Ping", model="override-ignored"),
        scope_key=str(org_id),
    )
    assert byom_res.provider == "byom" and byom_res.model == "voxtral-mini-latest"
    assert captured[-1][0].url == "https://byom.eu.acme.example/v1/chat/completions"
    assert captured[-1][1]["Authorization"] == "Bearer byom-key-eu-123"


def test_three_tier_off_by_default_hierarchy_and_confidential_or_e2ee_refusals(
    world: Any,
) -> None:
    org, workspace, members, tokens = world
    owner_token = tokens[0]
    member_token = tokens[3]
    channel = _create_channel(
        workspace, name="Product Sync", is_confidential=False, ai_enabled=False
    )
    conf_channel = _create_channel(
        workspace, name="Board Secret", is_confidential=True, ai_enabled=False
    )

    # DB CheckConstraint `channel_confidential_no_ai`: confidential channel can NEVER set ai_enabled=True!
    with pytest.raises(IntegrityError), transaction.atomic():
        Channel.objects.filter(pk=conf_channel.id).update(ai_enabled=True)

    adapter = FakeEuAdapter()

    # Default state: KODERA_AI_GATEWAY_ENABLED is False -> 403 ai_gateway_disabled.
    with pytest.raises(AiGatewayRefusalError) as exc_info:
        ai_services.complete_channel_prompt(
            verified=member_token,
            organisation_id=org.id,
            channel_id=channel.id,
            prompt="Summarize",
        )
    assert exc_info.value.status == 403 and exc_info.value.reason == "ai_gateway_disabled"

    with override_settings(KODERA_AI_GATEWAY_ENABLED=True, KODERA_AI_PROVIDER_ADAPTER=adapter):
        # Tier 1 OFF (WorkspaceAiPolicy missing / enabled=False) -> 403 ai_org_policy_disabled.
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=channel.id,
                prompt="Summarize",
            )
        assert exc_info.value.status == 403 and exc_info.value.reason == "ai_org_policy_disabled"

        # Enable Tier 1 (org/workspace), keep Tier 2 (channel) OFF -> 403 ai_channel_policy_disabled.
        ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={
                "enabled": True,
                "provider": "mistral",
                "providerRegion": "eu",
                "euSovereignOnly": True,
            },
            request_id=str(uuid4()),
        )
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=channel.id,
                prompt="Summarize",
            )
        assert (
            exc_info.value.status == 403 and exc_info.value.reason == "ai_channel_policy_disabled"
        )

        # Enable Tier 2 (channel), keep Tier 3 (member consent) OFF -> 403 ai_member_consent_required.
        ai_services.update_channel_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            channel_id=channel.id,
            body={"aiEnabled": True},
            request_id=str(uuid4()),
        )
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=channel.id,
                prompt="Summarize",
            )
        assert (
            exc_info.value.status == 403 and exc_info.value.reason == "ai_member_consent_required"
        )

        # Enable Tier 3 (member consent) -> all 4 gates True -> succeeds!
        consent_view = ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )
        assert consent_view["enabled"] is True and consent_view["consentedAt"] is not None

        ok_result = ai_services.complete_channel_prompt(
            verified=member_token,
            organisation_id=org.id,
            channel_id=channel.id,
            prompt="Summarize sprint decisions",
        )
        assert ok_result.text == "Synthèse souveraine validée."
        assert len(adapter.completions) == 1

        # Revoking member consent immediately fails closed with 403 again!
        revoked_view = ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": False},
            request_id=str(uuid4()),
        )
        assert revoked_view["enabled"] is False and revoked_view["revokedAt"] is not None
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=channel.id,
                prompt="Summarize sprint decisions",
            )
        assert (
            exc_info.value.status == 403 and exc_info.value.reason == "ai_member_consent_required"
        )

        # Re-grant consent and verify Layer 1 confidential / DM / unclassified / E2EE 403 refusals!
        ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )

        # 1) Unclassified / DM (`channel_id=None` or `room_id` present) -> 403
        for chan_arg, room_arg in (
            (None, None),
            (channel.id, "!dm-room:acme.kodera.io"),
        ):
            with pytest.raises(AiGatewayRefusalError) as exc_info:
                ai_services.complete_channel_prompt(
                    verified=member_token,
                    organisation_id=org.id,
                    channel_id=chan_arg,
                    room_id=room_arg,
                    prompt="Leak DM",
                )
            assert (
                exc_info.value.status == 403
                and exc_info.value.reason == "ai_confidential_or_unclassified_room_forbidden"
            )

        # 2) Confidential channel (`Channel.is_confidential=True`) -> 403 on both update_channel_ai_policy and gate
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.update_channel_ai_policy(
                verified=owner_token,
                organisation_id=org.id,
                channel_id=conf_channel.id,
                body={"aiEnabled": True},
                request_id=str(uuid4()),
            )
        assert (
            exc_info.value.status == 403
            and exc_info.value.reason == "ai_confidential_or_unclassified_room_forbidden"
        )
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=conf_channel.id,
                prompt="Read confidential",
            )
        assert (
            exc_info.value.status == 403
            and exc_info.value.reason == "ai_confidential_or_unclassified_room_forbidden"
        )

        # 3) E2EE Room (`apps.e2ee.models.Room` bound to channel_id) -> 403!
        key = Ed25519PrivateKey.generate()
        sig_doc = {
            "signingKey": base64.b64encode(key.public_key().public_bytes_raw()).decode(),
        }
        sig_doc["signature"] = base64.b64encode(
            key.sign(
                e2ee_services.signed_statement(
                    "register-device", org.id, members[0].id, None, sig_doc
                )
            )
        ).decode()
        dev = e2ee_services.register_device(
            verified=owner_token,
            organisation_id=org.id,
            body=sig_doc,
            request_id=str(uuid4()),
        )
        room_doc = {
            "deviceId": dev["deviceId"],
            "channelId": str(conf_channel.id),
            "algorithm": "io.kodera.mls.v1",
        }
        room_doc["signature"] = base64.b64encode(
            key.sign(
                e2ee_services.signed_statement("create-room", org.id, members[0].id, None, room_doc)
            )
        ).decode()
        e2ee_services.create_room(
            verified=owner_token,
            organisation_id=org.id,
            body=room_doc,
            request_id=str(uuid4()),
        )
        assert ConfidentialRoom.objects.filter(channel_id=conf_channel.id).exists()
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.evaluate_ai_gate(
                verified=member_token,
                organisation_id=org.id,
                channel_id=conf_channel.id,
            )
        assert (
            exc_info.value.status == 403
            and exc_info.value.reason == "ai_confidential_or_unclassified_room_forbidden"
        )

        # 4) Non-EU provider when eu_sovereign_only=True -> 403 ai_provider_non_eu_forbidden
        with pytest.raises(AiGatewayRefusalError) as exc_info:
            ai_services.update_workspace_ai_policy(
                verified=owner_token,
                organisation_id=org.id,
                body={"providerRegion": "non_eu", "euSovereignOnly": True},
                request_id=str(uuid4()),
            )
        assert (
            exc_info.value.status == 403 and exc_info.value.reason == "ai_provider_non_eu_forbidden"
        )


def test_e2ee_context_refuses_ai_bot_and_service_actor_tokens(world: Any) -> None:
    org, _, _, tokens = world
    human_token = tokens[0]

    # Even with a valid org membership backing `tokens[0].subject`, any AI/bot/service claim is refused 403!
    for forged_ai_token in (
        replace(human_token, authorized_party="kodera-ai-worker"),
        replace(human_token, subject="@kodera-ai:acme.kodera.io"),
        replace(human_token, subject="service-account-ai-bot"),
        replace(human_token, email="kodera-ai@acme.kodera.io"),
    ):
        with pytest.raises(e2ee_services.RefusalError) as refused_err:
            e2ee_services.register_device(
                verified=forged_ai_token,
                organisation_id=org.id,
                body={},
                request_id=str(uuid4()),
            )
        assert refused_err.value.status == 403
        with pytest.raises(e2ee_services.RefusalError) as read_refused:
            e2ee_services.read_envelopes(
                verified=forged_ai_token,
                organisation_id=org.id,
                room_id=uuid4(),
                device_id=str(uuid4()),
            )
        assert read_refused.value.status == 403


@pytest.mark.parametrize(
    ("filename", "content_type", "payload"),
    [
        ("note.ogg", "audio/ogg", OGG_VOICE_BYTES),
        ("note.webm", "audio/webm", WEBM_VOICE_BYTES),
        ("note.m4a", "audio/mp4", MP4_VOICE_BYTES),
    ],
)
def test_audio_voice_note_mime_types_admitted_in_media_storage_and_db_constraints(
    world: Any,
    gateway: Any,
    filename: str,
    content_type: str,
    payload: bytes,
) -> None:
    org, workspace, _, tokens = world
    channel = _create_channel(workspace, name=f"Audio-{content_type}")
    ticket = media_services.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": filename,
            "contentType": content_type,
            "sizeBytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "channelId": str(channel.id),
        },
        request_id=str(uuid4()),
    )
    completed = media_services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=UUID(ticket["attachmentId"]),
        request_id=str(uuid4()),
    )
    assert completed["contentType"] == content_type
    assert completed["disposition"] == "attachment"


@override_settings(ROOT_URLCONF="config.customer_urls")
def test_http_ai_policy_byom_sealing_voice_note_transcription_and_writer_role_acl(
    world: Any,
    http: Any,
    gateway: Any,
) -> None:
    org, workspace, _, _ = world
    client, credentials = http
    owner_cred = credentials[0]
    member_cred = credentials[3]
    channel = _create_channel(workspace, name="Voice Notes")
    master_key = secrets.token_bytes(32)
    adapter = FakeEuAdapter()

    # Upload and complete an Ogg voice note on the channel.
    upload_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/attachments/uploads",
        data=json.dumps(
            {
                "filename": "standup.ogg",
                "contentType": "audio/ogg",
                "sizeBytes": len(OGG_VOICE_BYTES),
                "sha256": hashlib.sha256(OGG_VOICE_BYTES).hexdigest(),
                "channelId": str(channel.id),
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert upload_resp.status_code == 201
    attachment_id = upload_resp.json()["attachmentId"]
    complete_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/complete",
        data=b"",
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert complete_resp.status_code == 200

    # Create a least-privilege API writer role to prove core/db/api_writer_role.py grants work end-to-end!
    role = f"ai_api_writer_{uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)

    secret_byom_key = "sk-byom-never-persisted-plaintext-999"
    try:
        with (
            override_settings(
                KODERA_AI_GATEWAY_ENABLED=True,
                KODERA_AI_SEAL_KEY=master_key,
                KODERA_AI_PROVIDER_ADAPTER=adapter,
                KODERA_AI_ATTACHMENT_BYTES_LOADER=lambda _row: OGG_VOICE_BYTES,
            ),
            acting_as(role),
        ):
            # 1) GET default OFF policy matches OpenAPI contract.
            get_resp = client.get(
                f"/api/v1/organisations/{org.id}/workspace/ai/policy",
                **_auth_headers(member_cred),
            )
            assert_contract_response(
                get_resp, "/organisations/{organisation_id}/workspace/ai/policy", "get"
            )
            assert get_resp.status_code == 200
            assert get_resp.json()["enabled"] is False
            assert get_resp.json()["memberConsent"]["enabled"] is False

            # 2) Transcribe while policy is OFF -> 403 (contract-validated).
            denied_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/actions/transcribe",
                data=json.dumps({"language": "fr"}),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert_contract_response(
                denied_resp,
                "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/actions/transcribe",
                "post",
            )
            assert denied_resp.status_code == 403

            # 3) Non-admin cannot update org AI policy -> 403.
            non_admin_put = client.put(
                f"/api/v1/organisations/{org.id}/workspace/ai/policy",
                data=json.dumps({"enabled": True}),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert non_admin_put.status_code == 403

            # 4) Owner configures org policy with BYOM secret -> sealed at rest, never echoed!
            put_org = client.put(
                f"/api/v1/organisations/{org.id}/workspace/ai/policy",
                data=json.dumps(
                    {
                        "enabled": True,
                        "provider": "byom",
                        "providerRegion": "eu",
                        "euSovereignOnly": True,
                        "model": "voxtral-mini-latest",
                        "byomConfig": {
                            "endpoint": "https://byom.eu.acme.example/v1",
                            "model": "voxtral-mini-latest",
                            "apiKey": secret_byom_key,
                            "region": "eu",
                        },
                    }
                ),
                content_type="application/json",
                **_auth_headers(owner_cred, key=str(uuid4())),
            )
            assert_contract_response(
                put_org, "/organisations/{organisation_id}/workspace/ai/policy", "put"
            )
            assert put_org.status_code == 200
            assert put_org.json()["hasByomConfig"] is True
            assert secret_byom_key not in put_org.content.decode("utf-8")

            # 5) Owner enables channel AI policy; member grants personal AI consent.
            put_chan = client.put(
                f"/api/v1/organisations/{org.id}/workspace/channels/{channel.id}/ai",
                data=json.dumps({"aiEnabled": True}),
                content_type="application/json",
                **_auth_headers(owner_cred, key=str(uuid4())),
            )
            assert_contract_response(
                put_chan,
                "/organisations/{organisation_id}/workspace/channels/{channel_id}/ai",
                "put",
            )
            assert put_chan.status_code == 200 and put_chan.json()["aiEnabled"] is True

            put_consent = client.put(
                f"/api/v1/organisations/{org.id}/workspace/ai/consent",
                data=json.dumps({"enabled": True}),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert_contract_response(
                put_consent, "/organisations/{organisation_id}/workspace/ai/consent", "put"
            )
            assert put_consent.status_code == 200 and put_consent.json()["enabled"] is True

            # 6) Voice note transcription now succeeds (200) and replays idempotently;
            #    once member consent is revoked, even the same Idempotency-Key fails closed with 403!
            idem_key = str(uuid4())
            tx_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/actions/transcribe",
                data=json.dumps({"language": "fr"}),
                content_type="application/json",
                **_auth_headers(member_cred, key=idem_key),
            )
            assert_contract_response(
                tx_resp,
                "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/actions/transcribe",
                "post",
            )
            assert tx_resp.status_code == 200
            assert tx_resp.json()["text"] == "Point produit confirmé à 14h."

            replay_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/actions/transcribe",
                data=json.dumps({"language": "fr"}),
                content_type="application/json",
                **_auth_headers(member_cred, key=idem_key),
            )
            assert replay_resp.status_code == 200
            assert replay_resp["Idempotency-Replayed"] == "true"
            assert len(adapter.transcriptions) == 1

            # Revoke consent -> replay with the SAME Idempotency-Key re-authorizes and returns 403!
            client.put(
                f"/api/v1/organisations/{org.id}/workspace/ai/consent",
                data=json.dumps({"enabled": False}),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            revoked_replay = client.post(
                f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/actions/transcribe",
                data=json.dumps({"language": "fr"}),
                content_type="application/json",
                **_auth_headers(member_cred, key=idem_key),
            )
            assert revoked_replay.status_code == 403

            # Writer role cannot DELETE policy or consent rows (least-privilege ACL).
            assert refused("DELETE FROM workspaces_workspaceaipolicy") == INSUFFICIENT_PRIVILEGE
            assert refused("DELETE FROM workspaces_memberaiconsent") == INSUFFICIENT_PRIVILEGE

        # Verify raw bytes in PostgreSQL are AEAD-sealed and never contain the plaintext API key.
        stored_policy = WorkspaceAiPolicy.objects.get(organisation=org)
        assert bytes(stored_policy.sealed_byom_config)
        assert secret_byom_key.encode("utf-8") not in bytes(stored_policy.sealed_byom_config)
        assert MemberAiConsent.objects.filter(organisation=org).count() == 1
        assert Attachment.objects.filter(pk=attachment_id).exists()
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_configured_ai_actor_subjects_and_client_ids_refused_in_e2ee(world: Any) -> None:
    org, _, _, tokens = world
    human_token = tokens[0]

    assert ai_actor_subjects({}) == ()
    assert ai_client_ids({}) == ()
    assert ai_actor_subjects({"KODERA_AI_ACTOR_SUBJECTS": " svc-1 , svc-2 "}) == ("svc-1", "svc-2")
    assert ai_client_ids({"KODERA_AI_CLIENT_IDS": " custom-ai-client "}) == ("custom-ai-client",)

    with override_settings(
        KODERA_AI_ACTOR_SUBJECTS=(human_token.subject,),
    ):
        with pytest.raises(e2ee_services.RefusalError) as sub_refused:
            e2ee_services.register_device(
                verified=human_token,
                organisation_id=org.id,
                body={},
                request_id=str(uuid4()),
            )
        assert sub_refused.value.status == 403

    client_token = replace(human_token, authorized_party="custom-ai-client")
    with override_settings(
        KODERA_AI_CLIENT_IDS=("custom-ai-client",),
    ):
        with pytest.raises(e2ee_services.RefusalError) as azp_refused:
            e2ee_services.register_device(
                verified=client_token,
                organisation_id=org.id,
                body={},
                request_id=str(uuid4()),
            )
        assert azp_refused.value.status == 403


def test_ipv4_mapped_ipv6_and_3xx_redirects_refused_without_following(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) is rejected both at public_address and adapter init.
    with pytest.raises(outbound.BlockedTargetError):
        outbound.public_address("::ffff:127.0.0.1")
    with pytest.raises(AiGatewayRefusalError) as blocked:
        OpenAICompatibleSelfHostedAdapter(endpoint="https://[::ffff:127.0.0.1]/v1")
    assert blocked.value.status == 403 and blocked.value.reason == "ai_endpoint_ssrf_blocked"

    # Any 3xx response from an AI provider is refused fail-closed without following Location.
    class RedirectConn:
        def close(self) -> None:
            pass

    class RedirectResp:
        status = 302

        def read(self, n: int = -1) -> bytes:
            return b""

    calls = 0

    def fake_redirect(*_args: Any, **_kwargs: Any) -> tuple[RedirectConn, RedirectResp]:
        nonlocal calls
        calls += 1
        return RedirectConn(), RedirectResp()

    monkeypatch.setattr(outbound, "request", fake_redirect)
    adapter = MistralAdapter(credential=ApiBearerSecret("mk-eu-secret"))
    with pytest.raises(AiGatewayRefusalError) as redirect_err:
        adapter.complete(
            AiCompletionRequest(prompt="Test", model="mistral-small-latest"),
            scope_key="org-redirect",
        )
    assert redirect_err.value.status == 503
    assert calls == 1


def test_cross_channel_attachment_and_restricted_channel_rbac_refused_and_toctou_discards_transcript(
    world: Any,
    gateway: Any,
) -> None:
    org, workspace, _, tokens = world
    owner_token = tokens[0]
    member_token = tokens[3]

    open_channel = _create_channel(
        workspace, name="Open AI", is_confidential=False, ai_enabled=True
    )
    secret_channel = _create_channel(
        workspace, name="Confidential Room", is_confidential=True, ai_enabled=False
    )
    restricted_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    restricted_channel = Channel.objects.create(
        workspace=workspace,
        name="Exec Private",
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=50,
        policy_mode="explicit",
        explicit_policy=restricted_policy,
        is_confidential=False,
        ai_enabled=True,
    )

    # Upload an audio note inside `secret_channel` (confidential) by owner, and one in `open_channel` by member.
    secret_ticket = media_services.create_upload(
        verified=owner_token,
        organisation_id=org.id,
        body={
            "filename": "board.ogg",
            "contentType": "audio/ogg",
            "sizeBytes": len(OGG_VOICE_BYTES),
            "sha256": hashlib.sha256(OGG_VOICE_BYTES).hexdigest(),
            "channelId": str(secret_channel.id),
        },
        request_id=str(uuid4()),
    )
    media_services.complete_upload(
        verified=owner_token,
        organisation_id=org.id,
        attachment_id=UUID(secret_ticket["attachmentId"]),
        request_id=str(uuid4()),
    )

    open_ticket = media_services.create_upload(
        verified=member_token,
        organisation_id=org.id,
        body={
            "filename": "standup.ogg",
            "contentType": "audio/ogg",
            "sizeBytes": len(OGG_VOICE_BYTES),
            "sha256": hashlib.sha256(OGG_VOICE_BYTES).hexdigest(),
            "channelId": str(open_channel.id),
        },
        request_id=str(uuid4()),
    )
    media_services.complete_upload(
        verified=member_token,
        organisation_id=org.id,
        attachment_id=UUID(open_ticket["attachmentId"]),
        request_id=str(uuid4()),
    )

    adapter = FakeEuAdapter()
    with override_settings(
        KODERA_AI_GATEWAY_ENABLED=True,
        KODERA_AI_PROVIDER_ADAPTER=adapter,
        KODERA_AI_ATTACHMENT_BYTES_LOADER=lambda _row: OGG_VOICE_BYTES,
    ):
        ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={
                "enabled": True,
                "provider": "mistral",
                "providerRegion": "eu",
                "euSovereignOnly": True,
            },
            request_id=str(uuid4()),
        )
        ai_services.update_member_ai_consent(
            verified=owner_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )
        ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )

        # 1) Cross-channel oracle attempt: passing `channelId = open_channel` for `secret_ticket` -> 403!
        with pytest.raises(AiGatewayRefusalError) as cross_err:
            ai_services.transcribe_voice_note(
                verified=owner_token,
                organisation_id=org.id,
                attachment_id=UUID(secret_ticket["attachmentId"]),
                body={"channelId": str(open_channel.id), "language": "fr"},
                request_id=str(uuid4()),
            )
        assert (
            cross_err.value.status == 403
            and cross_err.value.reason == "ai_confidential_or_unclassified_room_forbidden"
        )
        assert len(adapter.transcriptions) == 0

        # 2) Channel RBAC (`may_view` denied on `restricted_channel` for `member_token`) -> 403!
        with pytest.raises(AiGatewayRefusalError) as rbac_err:
            ai_services.complete_channel_prompt(
                verified=member_token,
                organisation_id=org.id,
                channel_id=restricted_channel.id,
                prompt="Summarize private channel",
            )
        assert (
            rbac_err.value.status == 403 and rbac_err.value.reason == "ai_channel_policy_disabled"
        )
        assert len(adapter.completions) == 0

        # 3) Mid-flight TOCTOU revocation: consent revoked while external provider I/O is in flight -> 403,
        #    and plaintext transcript is discarded!
        prepared = ai_services.prepare_voice_note_transcription(
            verified=member_token,
            organisation_id=org.id,
            attachment_id=UUID(open_ticket["attachmentId"]),
            body={"language": "fr"},
        )
        assert len(adapter.transcriptions) == 1
        ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": False},
            request_id=str(uuid4()),
        )
        with pytest.raises(AiGatewayRefusalError) as toctou_err:
            ai_services.commit_voice_note_transcription(
                verified=member_token,
                organisation_id=org.id,
                prepared=prepared,
                request_id=str(uuid4()),
            )
        assert (
            toctou_err.value.status == 403
            and toctou_err.value.reason == "ai_member_consent_required"
        )
        # Reserved budget was refunded cleanly on mid-flight TOCTOU revocation!
        assert WorkspaceAiPolicy.objects.get(organisation=org).monthly_spent_micros == 0


def test_large_voice_note_streaming_sha256_magic_bytes_budget_ceiling_and_oracle_resistance(
    world: Any,
    gateway: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    org, workspace, members, tokens = world
    owner_token = tokens[0]
    member_token = tokens[3]

    open_channel = _create_channel(
        workspace, name="Open Voice", is_confidential=False, ai_enabled=True
    )
    priv_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    ResourcePolicyRule.objects.create(
        policy=priv_policy,
        kind="allow_member",
        membership=members[0],
    )
    priv_non_conf = Channel.objects.create(
        workspace=workspace,
        name="Exec Private Ordinary",
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=60,
        policy_mode="explicit",
        explicit_policy=priv_policy,
        is_confidential=False,
        ai_enabled=True,
    )
    priv_conf = Channel.objects.create(
        workspace=workspace,
        name="Exec Private Confidential",
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=61,
        policy_mode="explicit",
        explicit_policy=priv_policy,
        is_confidential=True,
        ai_enabled=False,
    )

    # 1) Upload a 512 KiB (> 320 KiB MAX_WIRE!) Ogg voice note and verify bounded streaming + SHA-256 + magic check.
    large_ogg = b"OggS\x00\x02\x00\x00" + (b"x" * (512 * 1024))
    large_sha = hashlib.sha256(large_ogg).hexdigest()
    large_ticket = media_services.create_upload(
        verified=member_token,
        organisation_id=org.id,
        body={
            "filename": "long-standup.ogg",
            "contentType": "audio/ogg",
            "sizeBytes": len(large_ogg),
            "sha256": large_sha,
            "channelId": str(open_channel.id),
        },
        request_id=str(uuid4()),
    )
    media_services.complete_upload(
        verified=member_token,
        organisation_id=org.id,
        attachment_id=UUID(large_ticket["attachmentId"]),
        request_id=str(uuid4()),
    )

    # Upload attachments inside private channels that `member_token` CANNOT view (`may_view=False`).
    pdf_bytes = b"%PDF-1.7 private doc"
    priv_pdf_ticket = media_services.create_upload(
        verified=owner_token,
        organisation_id=org.id,
        body={
            "filename": "exec.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(pdf_bytes),
            "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
            "channelId": str(priv_non_conf.id),
        },
        request_id=str(uuid4()),
    )
    media_services.complete_upload(
        verified=owner_token,
        organisation_id=org.id,
        attachment_id=UUID(priv_pdf_ticket["attachmentId"]),
        request_id=str(uuid4()),
    )

    priv_conf_ticket = media_services.create_upload(
        verified=owner_token,
        organisation_id=org.id,
        body={
            "filename": "secret.ogg",
            "contentType": "audio/ogg",
            "sizeBytes": len(OGG_VOICE_BYTES),
            "sha256": hashlib.sha256(OGG_VOICE_BYTES).hexdigest(),
            "channelId": str(priv_conf.id),
        },
        request_id=str(uuid4()),
    )
    media_services.complete_upload(
        verified=owner_token,
        organisation_id=org.id,
        attachment_id=UUID(priv_conf_ticket["attachmentId"]),
        request_id=str(uuid4()),
    )

    # Mock storage HTTPS response > 320 KiB verifying `max_wire` > 512 KiB is passed to `outbound.request`!
    saw_max_wire: list[int] = []

    class LargeConn:
        def close(self) -> None:
            pass

    class LargeResp:
        def __init__(self, body: bytes) -> None:
            self.status = 200
            self._buf = io.BytesIO(body)

        def read(self, n: int = -1) -> bytes:
            return self._buf.read(n)

    def fake_storage_request(
        destination: outbound.Target,
        *,
        max_wire: int = outbound.MAX_WIRE,
        **_: Any,
    ) -> tuple[LargeConn, LargeResp]:
        saw_max_wire.append(max_wire)
        assert max_wire > len(large_ogg) > outbound.MAX_WIRE
        return LargeConn(), LargeResp(large_ogg)

    monkeypatch.setattr(outbound, "request", fake_storage_request)

    adapter = FakeEuAdapter()
    with override_settings(
        KODERA_AI_GATEWAY_ENABLED=True,
        KODERA_AI_PROVIDER_ADAPTER=adapter,
    ):
        ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={
                "enabled": True,
                "provider": "mistral",
                "providerRegion": "eu",
                "euSovereignOnly": True,
                "monthlyBudgetMicros": 35_000,
            },
            request_id=str(uuid4()),
        )
        ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )

        # 512 KiB voice note streams cleanly past 320 KiB MAX_WIRE, validates SHA-256 + OggS magic, and reconciles budget!
        tx = ai_services.transcribe_voice_note(
            verified=member_token,
            organisation_id=org.id,
            attachment_id=UUID(large_ticket["attachmentId"]),
            body={"language": "fr"},
            request_id=str(uuid4()),
        )
        assert tx["text"] == "Point produit confirmé à 14h."
        assert len(saw_max_wire) == 1
        policy_row = WorkspaceAiPolicy.objects.get(organisation=org)
        assert 0 < policy_row.monthly_spent_micros <= 35_000

        # Second 512 KiB call exceeds remaining monthlyBudgetMicros (35_000) -> 429 ai_budget_exhausted!
        with pytest.raises(AiGatewayRefusalError) as budget_err:
            ai_services.transcribe_voice_note(
                verified=member_token,
                organisation_id=org.id,
                attachment_id=UUID(large_ticket["attachmentId"]),
                body={"language": "fr"},
                request_id=str(uuid4()),
            )
        assert budget_err.value.status == 429 and budget_err.value.reason == "ai_budget_exhausted"

        # Raise budget and test SHA-256 tampering (`503`) and non-audio magic bytes (`422`) + budget refund!
        ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={"monthlyBudgetMicros": 500_000},
            request_id=str(uuid4()),
        )
        spent_before = WorkspaceAiPolicy.objects.get(organisation=org).monthly_spent_micros

        with override_settings(
            KODERA_AI_ATTACHMENT_BYTES_LOADER=lambda _row: (
                b"OggS\x00\x02\x00\x00" + (b"y" * (512 * 1024))
            )
        ):
            with pytest.raises(AiGatewayRefusalError) as sha_err:
                ai_services.transcribe_voice_note(
                    verified=member_token,
                    organisation_id=org.id,
                    attachment_id=UUID(large_ticket["attachmentId"]),
                    body={"language": "fr"},
                    request_id=str(uuid4()),
                )
            assert (
                sha_err.value.status == 503
                and sha_err.value.reason == "ai_storage_integrity_failed"
            )
        assert WorkspaceAiPolicy.objects.get(organisation=org).monthly_spent_micros == spent_before

        spoof_bytes = b"NOTAUDIO-spoofed-header-bytes"
        spoof_ticket = media_services.create_upload(
            verified=member_token,
            organisation_id=org.id,
            body={
                "filename": "spoof.ogg",
                "contentType": "audio/ogg",
                "sizeBytes": len(spoof_bytes),
                "sha256": hashlib.sha256(spoof_bytes).hexdigest(),
                "channelId": str(open_channel.id),
            },
            request_id=str(uuid4()),
        )
        media_services.complete_upload(
            verified=member_token,
            organisation_id=org.id,
            attachment_id=UUID(spoof_ticket["attachmentId"]),
            request_id=str(uuid4()),
        )
        with override_settings(KODERA_AI_ATTACHMENT_BYTES_LOADER=lambda _row: spoof_bytes):
            with pytest.raises(AiGatewayRefusalError) as magic_err:
                ai_services.transcribe_voice_note(
                    verified=member_token,
                    organisation_id=org.id,
                    attachment_id=UUID(spoof_ticket["attachmentId"]),
                    body={"language": "fr"},
                    request_id=str(uuid4()),
                )
            assert (
                magic_err.value.status == 422
                and magic_err.value.reason == "invalid_audio_container"
            )
        assert WorkspaceAiPolicy.objects.get(organisation=org).monthly_spent_micros == spent_before

        # 2) Enumeration-oracle check: unprivileged `member_token` receives UNIFORM 404 across:
        #    - nonexistent attachment UUID
        #    - private non-confidential PDF attachment (with matching or mismatched channelId)
        #    - private confidential audio attachment
        for probe_att, probe_body in (
            (uuid4(), {"language": "fr"}),
            (UUID(priv_pdf_ticket["attachmentId"]), {"language": "fr"}),
            (UUID(priv_pdf_ticket["attachmentId"]), {"channelId": str(open_channel.id)}),
            (UUID(priv_pdf_ticket["attachmentId"]), {"channelId": str(priv_non_conf.id)}),
            (UUID(priv_conf_ticket["attachmentId"]), {"language": "fr"}),
        ):
            with pytest.raises(AiGatewayRefusalError) as probe_err:
                ai_services.authorize_voice_note_transcription(
                    verified=member_token,
                    organisation_id=org.id,
                    attachment_id=probe_att,
                    body=probe_body,
                )
            assert probe_err.value.status == 404 and probe_err.value.reason is None

        # And on `evaluate_ai_gate`, both private non-confidential and private confidential channels
        # return identical `403 ai_channel_policy_disabled` to non-members!
        for hidden_chan in (priv_non_conf, priv_conf):
            with pytest.raises(AiGatewayRefusalError) as gate_err:
                ai_services.evaluate_ai_gate(
                    verified=member_token,
                    organisation_id=org.id,
                    channel_id=hidden_chan.id,
                )
            assert (
                gate_err.value.status == 403
                and gate_err.value.reason == "ai_channel_policy_disabled"
            )


def test_mistral_operator_credential_revocable_byom_and_eager_non_eu_host_refusal(
    world: Any,
) -> None:
    org, workspace, _, tokens = world
    owner_token = tokens[0]
    member_token = tokens[3]
    channel = _create_channel(
        workspace, name="Sovereign Check", is_confidential=False, ai_enabled=True
    )
    master_key = secrets.token_bytes(32)

    with override_settings(
        KODERA_AI_GATEWAY_ENABLED=True,
        KODERA_AI_SEAL_KEY=master_key,
        KODERA_AI_MISTRAL_API_KEY="mistral-eu-operator-key-abc",
    ):
        ai_services.update_member_ai_consent(
            verified=member_token,
            organisation_id=org.id,
            body={"enabled": True},
            request_id=str(uuid4()),
        )

        # Eager NON_EU_KNOWN_HOSTS refusal on both selfHostedEndpoint and byomConfig.endpoint!
        for bad_body in (
            {
                "enabled": True,
                "provider": "self_hosted",
                "euSovereignOnly": True,
                "selfHostedEndpoint": "https://api.openai.com/v1",
            },
            {
                "enabled": True,
                "provider": "byom",
                "euSovereignOnly": True,
                "byomConfig": {
                    "endpoint": "https://api.openai.com/v1",
                    "model": "gpt-test",
                    "apiKey": "key-123",
                    "region": "eu",
                },
            },
        ):
            with pytest.raises(AiGatewayRefusalError) as non_eu:
                ai_services.update_workspace_ai_policy(
                    verified=owner_token,
                    organisation_id=org.id,
                    body=bad_body,
                    request_id=str(uuid4()),
                )
            assert (
                non_eu.value.status == 403 and non_eu.value.reason == "ai_provider_non_eu_forbidden"
            )

        # apiKey > 512 chars rejected with 422 (OpenAPI parity).
        with pytest.raises(AiGatewayRefusalError) as key_len_err:
            ai_services.update_workspace_ai_policy(
                verified=owner_token,
                organisation_id=org.id,
                body={
                    "byomConfig": {
                        "endpoint": "https://byom.eu.acme.example/v1",
                        "model": "voxtral-mini-latest",
                        "apiKey": "k" * 513,
                        "region": "eu",
                    }
                },
                request_id=str(uuid4()),
            )
        assert key_len_err.value.status == 422

        # Save valid BYOM config, then clear it via `clearByomConfig: true` and `byomConfig: null`!
        saved = ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={
                "enabled": True,
                "provider": "mistral",
                "byomConfig": {
                    "endpoint": "https://byom.eu.acme.example/v1",
                    "model": "mistral-small-latest",
                    "apiKey": "tenant-mistral-key",
                    "region": "eu",
                },
            },
            request_id=str(uuid4()),
        )
        assert saved["hasByomConfig"] is True

        cleared = ai_services.update_workspace_ai_policy(
            verified=owner_token,
            organisation_id=org.id,
            body={"clearByomConfig": True},
            request_id=str(uuid4()),
        )
        assert cleared["hasByomConfig"] is False
        assert bytes(WorkspaceAiPolicy.objects.get(organisation=org).sealed_byom_config) == b""

        # Operator KODERA_AI_MISTRAL_API_KEY powers MistralAdapter when sealed_byom_config is empty!
        admitted = ai_services.evaluate_ai_gate(
            verified=member_token,
            organisation_id=org.id,
            channel_id=channel.id,
        )
        assert isinstance(admitted.adapter, MistralAdapter)
        assert admitted.adapter.credential is not None
        assert "mistral-eu-operator-key-abc" not in repr(admitted.adapter)

    # Case-insensitive suffix & configured subject/client detection in e2ee.is_ai_or_service_actor.
    for suffixed_tok in (
        replace(tokens[0], subject="User-Bot"),
        replace(tokens[0], subject="transcriber_agent"),
        replace(tokens[0], authorized_party="Voice_Bot"),
    ):
        assert e2ee_services.is_ai_or_service_actor(suffixed_tok) is True


class _BlockingAdapter:
    """Provider adapter that parks inside `transcribe` until the test releases it, so a second
    concurrent request with the same Idempotency-Key is observable while the first is in flight."""

    provider_id = "mistral"

    def __init__(self) -> None:
        self.transcriptions: list[tuple[AiTranscriptionRequest, str]] = []
        self.entered = threading.Event()
        self.release = threading.Event()

    @property
    def is_eu_sovereign(self) -> bool:
        return True

    def complete(self, request: AiCompletionRequest, *, scope_key: str) -> AiCompletionResult:
        raise AssertionError("the concurrent fence test only transcribes")

    def transcribe(
        self, request: AiTranscriptionRequest, *, scope_key: str
    ) -> AiTranscriptionResult:
        self.transcriptions.append((request, scope_key))
        self.entered.set()
        assert self.release.wait(timeout=30), "the in-flight request was never released"
        return AiTranscriptionResult(
            text="Point produit confirmé à 14h.",
            language=request.language or "fr",
            provider=self.provider_id,
            model=request.model,
        )


def test_concurrent_same_key_transcription_fenced_before_second_provider_call(
    world: Any, http: Any, gateway: Any
) -> None:
    org, workspace, _, _ = world
    client, credentials = http
    owner_cred = credentials[0]
    member_cred = credentials[3]
    channel = _create_channel(workspace, name="Fenced Voice Notes", ai_enabled=True)
    adapter = _BlockingAdapter()

    upload_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/attachments/uploads",
        data=json.dumps(
            {
                "filename": "standup.ogg",
                "contentType": "audio/ogg",
                "sizeBytes": len(OGG_VOICE_BYTES),
                "sha256": hashlib.sha256(OGG_VOICE_BYTES).hexdigest(),
                "channelId": str(channel.id),
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert upload_resp.status_code == 201
    attachment_id = upload_resp.json()["attachmentId"]
    complete_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}/complete",
        data=b"",
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert complete_resp.status_code == 200

    with override_settings(
        KODERA_AI_GATEWAY_ENABLED=True,
        KODERA_AI_PROVIDER_ADAPTER=adapter,
        KODERA_AI_ATTACHMENT_BYTES_LOADER=lambda _row: OGG_VOICE_BYTES,
    ):
        put_org = client.put(
            f"/api/v1/organisations/{org.id}/workspace/ai/policy",
            data=json.dumps(
                {
                    "enabled": True,
                    "provider": "mistral",
                    "providerRegion": "eu",
                    "euSovereignOnly": True,
                    "model": "voxtral-mini-latest",
                }
            ),
            content_type="application/json",
            **_auth_headers(owner_cred, key=str(uuid4())),
        )
        assert put_org.status_code == 200
        put_consent = client.put(
            f"/api/v1/organisations/{org.id}/workspace/ai/consent",
            data=json.dumps({"enabled": True}),
            content_type="application/json",
            **_auth_headers(member_cred, key=str(uuid4())),
        )
        assert put_consent.status_code == 200

        idem_key = str(uuid4())
        url = (
            f"/api/v1/organisations/{org.id}/workspace/attachments/{attachment_id}"
            "/actions/transcribe"
        )
        body = json.dumps({"language": "fr"})
        outcome: list[Any] = []

        def first_request() -> None:
            try:
                outcome.append(
                    client.post(
                        url,
                        data=body,
                        content_type="application/json",
                        **_auth_headers(member_cred, key=idem_key),
                    )
                )
            finally:
                connection.close()

        worker = threading.Thread(target=first_request)
        worker.start()
        assert adapter.entered.wait(timeout=30), "the first request never reached the provider"

        # A concurrent duplicate with the SAME fresh Idempotency-Key is fenced with a 409
        # conflict BEFORE the provider transcription runs a second time.
        duplicate = client.post(
            url,
            data=body,
            content_type="application/json",
            **_auth_headers(member_cred, key=idem_key),
        )
        assert duplicate.status_code == 409
        assert duplicate["Content-Type"].startswith("application/problem+json")
        assert duplicate.json()["type"].endswith("/idempotency-key-in-flight")
        assert len(adapter.transcriptions) == 1

        adapter.release.set()
        worker.join(timeout=30)
        assert not worker.is_alive()
        assert outcome and outcome[0].status_code == 200
        # Provider I/O ran exactly once: the fence held before any second adapter call.
        assert len(adapter.transcriptions) == 1
