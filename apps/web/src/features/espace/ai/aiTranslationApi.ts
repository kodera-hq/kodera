// Typed Core API wrapper for H3.2 written channel translation and consent-gated live call captions.
// Routes all requests through `coreApi()` so Bearer tokens, Idempotency-Key, X-Request-Id, and
// ADR-0003 single-origin enforcement remain identical to generated operations.

import { ApiProblem, coreApi } from '../../../api/client'
import type { SupportedTranslationLanguage } from './aiTranslationMessages'

export type LiveCallSessionState =
  | 'awaiting_all_consents'
  | 'active'
  | 'paused_unconsented_participant'
  | 'stopped_withdrawn'
  | 'ended'

export type LiveCallParticipantConsentState = 'pending' | 'consented' | 'withdrawn'

export interface ChannelMessageTranslationResult {
  readonly channelId: string
  readonly eventId: string | null
  readonly translatedText: string
  readonly targetLanguage: SupportedTranslationLanguage
  readonly sourceLanguage: string
  readonly provider: string
  readonly model: string
  readonly ephemeral: boolean
}

export interface LiveCallCaptionSessionView {
  readonly sessionId: string
  readonly callInstanceId?: string
  readonly channelId: string
  readonly state: LiveCallSessionState
  readonly targetLanguage: SupportedTranslationLanguage
  readonly rosterCount: number
  readonly consentedCount: number
  readonly unconsentedCount: number
  readonly allConsented: boolean
  readonly callerConsentState: LiveCallParticipantConsentState
  readonly callerMemberAiConsent: boolean
  readonly generation: number
  readonly expiresAt?: string
}

export interface LiveCallCaptionSessionEnvelope {
  readonly session: LiveCallCaptionSessionView | null
}

export interface LiveCallCaptionSessionUpdateBody {
  readonly action:
    'start' | 'consent' | 'sync_roster' | 'leave' | 'withdraw' | 'end' | 'set_language'
  readonly sessionId?: string
  readonly callInstanceId?: string
  readonly targetLanguage?: SupportedTranslationLanguage
  readonly participantMembershipIds?: readonly string[]
  readonly participantUserIds?: readonly string[]
  readonly grantCallConsent?: boolean
}

export interface LiveCallChunkTranscriptionBody {
  readonly sessionId: string
  readonly generation: number
  readonly audioBase64: string
  readonly contentType?: string
  readonly filename?: string
  readonly targetLanguage?: SupportedTranslationLanguage
  readonly participantMembershipIds?: readonly string[]
  readonly participantUserIds?: readonly string[]
}

export interface LiveCallChunkTranscriptionResult {
  readonly sessionId: string
  readonly channelId: string
  readonly sourceText: string
  readonly translatedText: string
  readonly sourceLanguage: string
  readonly targetLanguage: SupportedTranslationLanguage
  readonly provider: string
  readonly model: string
  readonly ephemeral: boolean
}

export { ApiProblem }

export async function requestChannelMessageTranslation(params: {
  readonly organisationId: string
  readonly channelId: string
  readonly text: string
  readonly targetLanguage: SupportedTranslationLanguage
  readonly eventId?: string
  readonly signal?: AbortSignal
}): Promise<ChannelMessageTranslationResult> {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/translate-message',
    {
      params: {
        path: { organisation_id: params.organisationId, channel_id: params.channelId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {
        text: params.text,
        targetLanguage: params.targetLanguage,
        ...(params.eventId === undefined ? {} : { eventId: params.eventId }),
      },
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    }
  )
  if (data === undefined) {
    throw new Error('empty-translation-response')
  }
  return data
}

export async function fetchLiveCallCaptionSession(params: {
  readonly organisationId: string
  readonly channelId: string
  readonly sessionId?: string
  readonly callInstanceId?: string
  readonly signal?: AbortSignal
}): Promise<LiveCallCaptionSessionView | null> {
  const query = {
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    ...(params.callInstanceId === undefined ? {} : { callInstanceId: params.callInstanceId }),
  }
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/session',
    {
      params: {
        path: { organisation_id: params.organisationId, channel_id: params.channelId },
        ...(Object.keys(query).length === 0 ? {} : { query }),
      },
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    }
  )
  return data?.session ?? null
}

export async function postLiveCallCaptionSession(params: {
  readonly organisationId: string
  readonly channelId: string
  readonly body: LiveCallCaptionSessionUpdateBody
  readonly signal?: AbortSignal
}): Promise<LiveCallCaptionSessionView | null> {
  const { participantMembershipIds, participantUserIds, ...restBody } = params.body
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/session',
    {
      params: {
        path: { organisation_id: params.organisationId, channel_id: params.channelId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {
        ...restBody,
        ...(participantMembershipIds === undefined
          ? {}
          : { participantMembershipIds: [...participantMembershipIds] }),
        ...(participantUserIds === undefined ? {} : { participantUserIds: [...participantUserIds] }),
      },
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    }
  )
  return data?.session ?? null
}

export async function postLiveCallCaptionChunk(params: {
  readonly organisationId: string
  readonly channelId: string
  readonly body: LiveCallChunkTranscriptionBody
  readonly signal?: AbortSignal
}): Promise<LiveCallChunkTranscriptionResult> {
  const { participantMembershipIds, participantUserIds, ...restBody } = params.body
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/chunks',
    {
      params: {
        path: { organisation_id: params.organisationId, channel_id: params.channelId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {
        ...restBody,
        ...(participantMembershipIds === undefined
          ? {}
          : { participantMembershipIds: [...participantMembershipIds] }),
        ...(participantUserIds === undefined ? {} : { participantUserIds: [...participantUserIds] }),
      },
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    }
  )
  if (data === undefined) {
    throw new Error('empty-call-caption-chunk-response')
  }
  return data
}

export async function grantMemberWorkspaceAiConsent(params: {
  readonly organisationId: string
  readonly signal?: AbortSignal
}): Promise<void> {
  await coreApi().PUT('/organisations/{organisation_id}/workspace/ai/consent', {
    params: { path: { organisation_id: params.organisationId } },
    body: { enabled: true },
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}
