# Horizon 3 `H3.2` — Written channel translation and consent-gated live call captions

Status: Implemented in contract 0.58.0

## Overview

`H3.2` delivers two strictly opt-in, ephemeral sovereign AI capabilities on top of the three-tier OFF-by-default AI policy engine (`organisation -> channel -> member`):

1. **Written channel message translation (`translateChannelMessage`)**: on-demand, viewer-ephemeral translation of a bounded channel message (`1..8192` characters) into one of eight European ISO languages (`fr`, `en`, `de`, `es`, `it`, `nl`, `pt`, `pl`) via the workspace's EU-sovereign provider (`MistralAdapter`, `OpenAICompatibleSelfHostedAdapter`, or HKDF-sealed `ByomAdapter`), without mutating or persisting Matrix timeline events.
2. **Consent-gated live call captions and subtitle translation (`getLiveCallCaptionSession`, `updateLiveCallCaptionSession`, `transcribeLiveCallChunk`)**: a durable multi-party consent state machine (`LiveCallCaptionSession` and `LiveCallParticipantConsent` in `apps/server/apps/ai_gateway/models.py`) enforcing pre-subscription 100% participant consent, automatic pause when an unconsented participant joins, and immediate atomic stop on consent withdrawal.

## Security and privacy invariants

- **Zero persistence of ephemeral translations and transcripts**: `translate_message` and `call_captions_chunks` serve ephemeral 2xx payloads strictly from process memory while recording only a content-free `409 ephemeral_output_not_replayed` receipt in `idempotency_record`, ensuring zero bytes of `sourceText` or `translatedText` ever reach PostgreSQL.
- **Confidential and E2EE room wall (`403`)**: confidential channels (`Channel.is_confidential`), E2EE rooms (`apps/server/apps/e2ee`), direct messages (`roomId` supplied), and unclassified rooms (`channel_id` absent) fail closed with `403 ai_confidential_or_unclassified_room_forbidden` across every translation, session, and audio-chunk operation, reinforced by the PostgreSQL scope trigger `ai_call_caption_scope_guard()` (checking both `workspaces_channel.is_confidential` and `e2ee_room`) and client-side `permitsPlaintext` gating.
- **Per-call instance binding, bounded TTL, and monotonic roster integrity**: each `LiveCallCaptionSession` binds to an immutable `call_instance_id` and a bounded 5-minute `expires_at` TTL refreshed on active call heartbeats; Matrix MXIDs validate the authoritative tenant homeserver domain (`{slug}.kodera.io` / `matrix.{slug}.kodera.io` / `KODERA_SYNAPSE_SERVER_NAME`), observed participants union monotonically into the session roster so callers cannot omit participants to bypass consent, and only an explicit `action="leave"` authenticated by the departing member removes that member from the roster.
- **Pre-subscription all-party call consent and generation-fenced chunks**: audio chunk ingestion (`<= 1 MiB`, requiring explicit `sessionId` and current `generation`) reserves against the worst-case transcription + translation upper bound and is refused unless the session is non-expired, `active`, matching `generation`, and 100% of call roster participants hold both an active `MemberAiConsent` and an explicit per-call `LiveCallParticipantConsent(state="consented")` recorded prior to chunk ingestion.
- **Auto-pause on non-consenting join and immediate stop on withdrawal**: `action="sync_roster"` transitions `active -> paused_unconsented_participant` whenever any participant lacking active workspace and per-call consent joins, while `action="withdraw"` transitions immediately to `stopped_withdrawn`; both advance `generation`, discard buffered chunk counters, and refund `in_flight_reserved_micros` without double-refunding.
- **Prompt-injection isolation**: `build_hardened_translation_prompt` wraps untrusted message or transcript text inside a per-call random cryptographic boundary tag (`<untrusted_source_<nonce>>`), neutralizes spoofed closing tags, and strips control characters and boundary markers on output.
- **Database least privilege and GDPR erasure**: `apps/server/core/db/api_writer_role.py` grants `SELECT`, `INSERT`, and narrow column-level `UPDATE` only (never `DELETE` or binding-column `UPDATE`), while `0001_live_call_caption_sessions.py` installs `a_resource_binding`, `aa_privacy_cutoff`, `aa_06_workspace_ai_call_captions_erasure`, and `aa_06_account_ai_call_captions_erasure` (refunding any in-flight reserved micros on `workspaces_workspaceaipolicy` prior to zeroing session reservations).

## OpenAPI contract registration block

To avoid cross-lane lockfile and generated client conflicts prior to train integration, the views in `apps/server/apps/ai_gateway/api/views.py` carry `@declares(...)` for the four operations below, and `apps/server/apps/ai_gateway/api/urls.py` defines `H3_2_LIVE_TRANSLATION_URLS`. During unified train integration, merge the following paths and schemas into `packages/api-contract/core-api.openapi.yaml`, append `*H3_2_LIVE_TRANSLATION_URLS` unconditionally in `apps/server/apps/ai_gateway/api/urls.py`, and run `dev/served_operations.py` and `npm run api:generate`.

```yaml
  /organisations/{organisation_id}/workspace/channels/{channel_id}/actions/translate-message:
    post:
      operationId: translateChannelMessage
      summary: Ephemerally translate a written channel message
      description: 'Evaluates all three OFF-by-default AI consent tiers (org -> channel -> member), refuses confidential, E2EE, and DM/unclassified rooms with 403, and returns ephemeral translated text without mutating Matrix events.'
      tags:
      - Workspace
      x-kodera-scope: workspace_ai:act
      x-kodera-authz:
        roles:
        - org_owner
        - org_admin
        - org_billing
        - org_member
  /organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/session:
    get:
      operationId: getLiveCallCaptionSession
      summary: Read current live call caption consent session for a channel
      tags:
      - Workspace
      x-kodera-scope: workspace_ai:read
      x-kodera-authz:
        roles:
        - org_owner
        - org_admin
        - org_billing
        - org_member
    post:
      operationId: updateLiveCallCaptionSession
      summary: Start, consent, sync roster, pause, withdraw, or end a live call caption session
      tags:
      - Workspace
      x-kodera-scope: workspace_ai:act
      x-kodera-authz:
        roles:
        - org_owner
        - org_admin
        - org_billing
        - org_member
  /organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/chunks:
    post:
      operationId: transcribeLiveCallChunk
      summary: Transcribe and translate a bounded live call audio chunk under all-party consent
      tags:
      - Workspace
      x-kodera-scope: workspace_ai:act
      x-kodera-authz:
        roles:
        - org_owner
        - org_admin
        - org_billing
        - org_member
```
