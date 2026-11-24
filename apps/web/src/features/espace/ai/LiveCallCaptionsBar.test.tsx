import { act, createRef } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { MessagingOrganisation } from '../../messaging/organisationContext'
import type { CallCaptionPacket, CallSnapshot } from '../audio/call'
import type { AudioCallLike, CallChannel, EspaceStoreLike } from '../liveViewModel'
import type { EspaceSnapshot } from '../matrix/store'
import { VoiceCallDock } from '../VoiceCallDock'
import * as aiApi from './aiTranslationApi'
import type * as AiApiModule from './aiTranslationApi'
import {
  LiveCallCaptionsBar,
  type LiveCallAudioChunkPayload,
  type LiveCallChunkSource,
} from './LiveCallCaptionsBar'

vi.mock('./aiTranslationApi', async (importOriginal) => {
  const actual = await importOriginal<typeof AiApiModule>()
  return {
    ...actual,
    fetchLiveCallCaptionSession: vi.fn(),
    postLiveCallCaptionSession: vi.fn(),
    postLiveCallCaptionChunk: vi.fn(),
    grantMemberWorkspaceAiConsent: vi.fn(),
  }
})

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const ALICE = '@alice:acme.kodera.io'
const BOB = '@bob:acme.kodera.io'
const CAROL = '@carol:acme.kodera.io'
const SAMPLE_B64 = 'T2dnUwACAAAAAAAAAAA='

function createTestChunkSource() {
  const listeners = new Set<(chunk: LiveCallAudioChunkPayload) => void>()
  const source: LiveCallChunkSource = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    source,
    subscriberCount: () => listeners.size,
    emit: (audioBase64 = SAMPLE_B64) => {
      act(() => {
        for (const listener of listeners) {
          listener({ audioBase64, contentType: 'audio/ogg' })
        }
      })
    },
  }
}

describe('H3.2 consent-gated live call captions bar', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('fr')
    vi.mocked(aiApi.fetchLiveCallCaptionSession).mockResolvedValue(null)
  })

  it('disables captions completely and makes zero API calls when !permitsPlaintext (confidential/E2EE room)', () => {
    const chunks = createTestChunkSource()
    const { container } = render(
      <LiveCallCaptionsBar
        organisationId={ORG_ID}
        channelId={CHANNEL_ID}
        participants={[ALICE, BOB]}
        permitsPlaintext={false}
        chunkSource={chunks.source}
        defaultExpanded
      />
    )

    const disabledBtn = screen.getByTestId('live-captions-confidential-disabled')
    expect(disabledBtn).toBeDisabled()
    expect(disabledBtn).toHaveTextContent(
      'Sous-titres IA indisponibles (salon chiffré ou confidentiel)'
    )
    expect(screen.queryByTestId('live-captions-consent-banner')).toBeNull()
    expect(chunks.subscriberCount()).toBe(0)
    expect(aiApi.fetchLiveCallCaptionSession).not.toHaveBeenCalled()
    expect(aiApi.postLiveCallCaptionSession).not.toHaveBeenCalled()
    expect(aiApi.postLiveCallCaptionChunk).not.toHaveBeenCalled()
    expect(container.querySelector('[style]')).toBeNull()
  })

  it('gates audio chunk ingestion behind explicit all-party consent, renders rolling 2-line aria-live overlay, auto-pauses on non-consenting join, and stops on 1-click withdrawal', async () => {
    const user = userEvent.setup()
    const chunks = createTestChunkSource()
    const mockPostSession = vi.mocked(aiApi.postLiveCallCaptionSession)
    const mockPostChunk = vi.mocked(aiApi.postLiveCallCaptionChunk)
    const mockGrantMemberConsent = vi.mocked(aiApi.grantMemberWorkspaceAiConsent)

    // First start attempt returns 403 `forbidden` -> auto-grants member consent on click & retries!
    mockPostSession
      .mockRejectedValueOnce(
        new aiApi.ApiProblem({
          type: 'https://kodera.io/problems/forbidden',
          status: 403,
          title: 'Workspace AI request refused',
        })
      )
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        channelId: CHANNEL_ID,
        state: 'awaiting_all_consents',
        targetLanguage: 'fr',
        rosterCount: 2,
        consentedCount: 1,
        unconsentedCount: 1,
        allConsented: false,
        callerConsentState: 'consented',
        callerMemberAiConsent: true,
        sessionEpoch: 1,
      })

    mockGrantMemberConsent.mockResolvedValueOnce(undefined)

    const { rerender, container } = render(
      <LiveCallCaptionsBar
        organisationId={ORG_ID}
        channelId={CHANNEL_ID}
        callInstanceId="RM_shared_call_1"
        participants={[ALICE, BOB]}
        permitsPlaintext
        chunkSource={chunks.source}
        defaultExpanded
      />
    )

    // Pre-subscription banner shown; emitting chunks BEFORE consent does nothing!
    expect(screen.getByTestId('live-captions-consent-banner')).toBeInTheDocument()
    chunks.emit()
    expect(chunks.subscriberCount()).toBe(0)
    expect(mockPostChunk).not.toHaveBeenCalled()

    // Alice clicks "Donner mon consentement IA" -> still awaiting Bob (1/2)
    await user.click(screen.getByTestId('live-captions-grant-consent'))
    expect(await screen.findByTestId('live-captions-awaiting-pill')).toHaveTextContent(
      'En attente du consentement de tous (1/2)'
    )
    expect(mockGrantMemberConsent).toHaveBeenCalledOnce()
    // Still NOT active -> zero chunk subscription while awaiting all consents!
    expect(chunks.subscriberCount()).toBe(0)
    chunks.emit()
    expect(mockPostChunk).not.toHaveBeenCalled()

    // Switch target subtitle language to English (`en`) -> server now reports Bob also consented (`active`)!
    mockPostSession.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      state: 'active',
      targetLanguage: 'en',
      rosterCount: 2,
      consentedCount: 2,
      unconsentedCount: 0,
      allConsented: true,
      callerConsentState: 'consented',
      callerMemberAiConsent: true,
      sessionEpoch: 1,
    })

    await user.selectOptions(screen.getByTestId('live-captions-language'), 'en')

    const overlay = await screen.findByTestId('live-captions-overlay')
    expect(overlay).toHaveAttribute('role', 'region')
    expect(overlay).toHaveAttribute('aria-live', 'polite')
    expect(chunks.subscriberCount()).toBe(1)

    // Emit 3 chunks -> rolling window keeps strictly the latest 2 lines!
    mockPostChunk
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        channelId: CHANNEL_ID,
        sourceText: 'Première phrase',
        translatedText: 'First spoken line',
        sourceLanguage: 'fr',
        targetLanguage: 'en',
        provider: 'mistral',
        model: 'voxtral-mini-latest',
        ephemeral: true,
      })
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        channelId: CHANNEL_ID,
        sourceText: 'Deuxième phrase',
        translatedText: 'Second spoken line',
        sourceLanguage: 'fr',
        targetLanguage: 'en',
        provider: 'mistral',
        model: 'voxtral-mini-latest',
        ephemeral: true,
      })
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        channelId: CHANNEL_ID,
        sourceText: 'Troisième phrase',
        translatedText: 'Third spoken line',
        sourceLanguage: 'fr',
        targetLanguage: 'en',
        provider: 'mistral',
        model: 'voxtral-mini-latest',
        ephemeral: true,
      })

    chunks.emit()
    expect(await screen.findByText('First spoken line')).toBeInTheDocument()
    chunks.emit()
    expect(await screen.findByText('Second spoken line')).toBeInTheDocument()
    chunks.emit()
    await waitFor(() => {
      expect(screen.getByText('Third spoken line')).toBeInTheDocument()
    })
    const renderedLines = screen.getAllByTestId('live-captions-line')
    expect(renderedLines).toHaveLength(2)
    expect(renderedLines[0]).toHaveTextContent('Second spoken line')
    expect(renderedLines[1]).toHaveTextContent('Third spoken line')
    expect(screen.queryByText('First spoken line')).toBeNull()
    expect(mockPostChunk).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organisationId: ORG_ID,
        channelId: CHANNEL_ID,
        body: expect.objectContaining({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          targetLanguage: 'en',
        }),
      })
    )

    // Non-consenting participant Carol joins the call -> automatic reactive `sync_roster` -> paused!
    mockPostSession.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      state: 'paused_unconsented_participant',
      targetLanguage: 'en',
      rosterCount: 3,
      consentedCount: 2,
      unconsentedCount: 1,
      allConsented: false,
      callerConsentState: 'consented',
      callerMemberAiConsent: true,
      sessionEpoch: 2,
    })

    rerender(
      <LiveCallCaptionsBar
        organisationId={ORG_ID}
        channelId={CHANNEL_ID}
        callInstanceId="RM_shared_call_1"
        participants={[ALICE, BOB, CAROL]}
        permitsPlaintext
        chunkSource={chunks.source}
        defaultExpanded
      />
    )

    const pausedPill = await screen.findByTestId('live-captions-paused-pill')
    expect(pausedPill).toHaveTextContent("En pause : un participant n'a pas consenti")
    expect(screen.queryByTestId('live-captions-overlay')).toBeNull()
    expect(chunks.subscriberCount()).toBe(0)
    expect(mockPostSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organisationId: ORG_ID,
        channelId: CHANNEL_ID,
        body: {
          action: 'sync_roster',
          sessionId: SESSION_ID,
          callInstanceId: 'RM_shared_call_1',
          participantUserIds: [ALICE, BOB, CAROL],
        },
      })
    )

    // 1-click "Retirer mon consentement IA" -> immediate transition to `stopped_withdrawn`
    mockPostSession.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      state: 'stopped_withdrawn',
      targetLanguage: 'en',
      rosterCount: 3,
      consentedCount: 1,
      unconsentedCount: 2,
      allConsented: false,
      callerConsentState: 'withdrawn',
      callerMemberAiConsent: true,
      sessionEpoch: 3,
    })

    const withdrawBtn = screen.getByTestId('live-captions-withdraw-consent')
    expect(withdrawBtn).toHaveTextContent('Retirer mon consentement IA')
    await user.click(withdrawBtn)

    expect(await screen.findByTestId('live-captions-withdrawn-pill')).toHaveTextContent(
      'Sous-titres arrêtés : un participant a retiré son consentement.'
    )
    expect(chunks.subscriberCount()).toBe(0)
    expect(container.querySelector('[style]')).toBeNull()
  })

  it('polls consent transitions every 3s, cycles standalone MediaRecorder container segments, and sends leave on unmount', async () => {
    vi.useFakeTimers()
    const startCalls: unknown[][] = []
    const recorderInstances: Array<{
      state: 'inactive' | 'recording'
      ondataavailable: ((e: BlobEvent) => void) | null
      onstop: (() => void) | null
    }> = []

    class FakeMediaStream {
      readonly tracks: readonly MediaStreamTrack[]
      constructor(tracks: readonly MediaStreamTrack[]) {
        this.tracks = tracks
      }
    }

    class FakeMediaRecorder {
      static isTypeSupported(mime: string) {
        return mime === 'audio/webm'
      }
      state: 'inactive' | 'recording' = 'inactive'
      ondataavailable: ((e: BlobEvent) => void) | null = null
      onstop: (() => void) | null = null

      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        recorderInstances.push(this)
      }

      start(...args: unknown[]) {
        startCalls.push(args)
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02])], {
          type: 'audio/webm',
        })
        this.ondataavailable?.({ data: blob } as BlobEvent)
        this.onstop?.()
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    try {
      const mockFetchSession = vi.mocked(aiApi.fetchLiveCallCaptionSession)
      const mockPostSession = vi.mocked(aiApi.postLiveCallCaptionSession)
      const mockPostChunk = vi.mocked(aiApi.postLiveCallCaptionChunk)

      // Initial hydrate returns `awaiting_all_consents` (Alice consented, waiting on Bob).
      // Subsequent 3s polls return a FRESH object reference each time (`mockImplementation`)
      // to prove polling never cancels or tears down active 3s `MediaRecorder` segments!
      let pollCounter = 0
      mockFetchSession.mockImplementation(async () => {
        pollCounter += 1
        if (pollCounter === 1) {
          return {
            sessionId: SESSION_ID,
            callInstanceId: 'call-poll-1',
            channelId: CHANNEL_ID,
            state: 'awaiting_all_consents',
            targetLanguage: 'fr',
            rosterCount: 2,
            consentedCount: 1,
            unconsentedCount: 1,
            allConsented: false,
            callerConsentState: 'consented',
            callerMemberAiConsent: true,
            sessionEpoch: 1,
          }
        }
        return {
          sessionId: SESSION_ID,
          callInstanceId: 'call-poll-1',
          channelId: CHANNEL_ID,
          state: 'active',
          targetLanguage: 'fr',
          rosterCount: 2,
          consentedCount: 2,
          unconsentedCount: 0,
          allConsented: true,
          callerConsentState: 'consented',
          callerMemberAiConsent: true,
          sessionEpoch: 1,
        }
      })

      mockPostSession.mockResolvedValue({
        sessionId: SESSION_ID,
        callInstanceId: 'call-poll-1',
        channelId: CHANNEL_ID,
        state: 'awaiting_all_consents',
        targetLanguage: 'fr',
        rosterCount: 2,
        consentedCount: 1,
        unconsentedCount: 1,
        allConsented: false,
        callerConsentState: 'consented',
        callerMemberAiConsent: true,
        sessionEpoch: 1,
      })

      let uploadedCount = 0
      mockPostChunk.mockImplementation(async () => {
        uploadedCount += 1
        return {
          sessionId: SESSION_ID,
          channelId: CHANNEL_ID,
          sourceText: `Segment autonome ${String(uploadedCount)}`,
          translatedText: `Segment autonome ${String(uploadedCount)}`,
          sourceLanguage: 'fr',
          targetLanguage: 'fr',
          provider: 'mistral',
          model: 'voxtral-mini-latest',
          ephemeral: true,
        }
      })

      const fakeTrack = { readyState: 'live' } as unknown as MediaStreamTrack

      const { unmount } = render(
        <LiveCallCaptionsBar
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          callInstanceId="call-poll-1"
          participants={[ALICE, BOB]}
          permitsPlaintext
          localAudioTrack={fakeTrack}
          defaultExpanded
        />
      )

      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId('live-captions-awaiting-pill')).toBeInTheDocument()
      expect(recorderInstances).toHaveLength(0)

      // Advance 3s -> bounded poll transitions session to `active` and starts segment 1!
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })
      expect(screen.getByTestId('live-captions-overlay')).toBeInTheDocument()
      expect(recorderInstances).toHaveLength(1)
      expect(startCalls[0]).toEqual([])

      // Advance across 3 full consecutive 3s poll + segment cycles (6s, 9s, 12s):
      // Every 3s poll returns a brand-new `session` object reference, yet ZERO segments are
      // torn down prematurely and all 3 standalone WebM containers upload cleanly!
      for (const expectedUploads of [1, 2, 3]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000)
        })
        expect(mockPostChunk).toHaveBeenCalledTimes(expectedUploads)
        expect(recorderInstances).toHaveLength(expectedUploads + 1)
        expect(startCalls[expectedUploads]).toEqual([])
      }

      const renderedLines = screen.getAllByTestId('live-captions-line')
      expect(renderedLines).toHaveLength(2)
      expect(renderedLines[0]).toHaveTextContent('Segment autonome 2')
      expect(renderedLines[1]).toHaveTextContent('Segment autonome 3')

      // Unmounting while active dispatches explicit `action: 'leave'` teardown!
      unmount()
      expect(mockPostSession).toHaveBeenLastCalledWith({
        organisationId: ORG_ID,
        channelId: CHANNEL_ID,
        body: {
          action: 'leave',
          sessionId: SESSION_ID,
        },
      })
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('mounts cleanly inside VoiceCallDock stage and disables captions on confidential rooms', async () => {
    const roomId = '!audio:acme.kodera.io'
    const callSnapshot: CallSnapshot = {
      status: 'connected',
      roomId,
      callInstanceId: 'RM_dock_1',
      muted: false,
      deafened: false,
      listenOnly: false,
      speakers: [],
      participants: [ALICE, BOB],
      playbackBlocked: false,
      videos: [],
      camera: 'off',
      screen: 'off',
    }
    const call: AudioCallLike = {
      subscribe: () => () => undefined,
      getSnapshot: () => callSnapshot,
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => undefined),
      setDeafened: vi.fn(async () => undefined),
      startAudio: vi.fn(async () => undefined),
    }
    const channel: CallChannel = {
      channelId: CHANNEL_ID,
      roomId,
      roomName: 'Point produit',
      categoryName: 'Équipe',
    }
    const makeStore = (boundary: 'ordinary' | 'confidential-unavailable'): EspaceStoreLike => {
      const snapshot = {
        status: 'live',
        channels: new Map([[CHANNEL_ID, { state: 'resolved', roomId }]]),
        rooms: [
          {
            roomId,
            name: 'Point produit',
            alias: '#point:acme.kodera.io',
            kind: 'audio',
            unread: 0,
            mentions: 0,
            occupancy: { participants: [ALICE, BOB], screenShare: [] },
            names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
          },
        ],
        invites: [],
      } as unknown as EspaceSnapshot
      return {
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        getUserId: () => ALICE,
        getRoomBoundary: () => boundary,
        getTimeline: () => [],
        getThread: () => [],
        send: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        toggleReaction: vi.fn(async () => undefined),
        markRead: vi.fn(async () => undefined),
      }
    }

    const meterRef = createRef<HTMLSpanElement>()
    const panelMeterRef = createRef<HTMLSpanElement>()

    const { unmount } = render(
      <MessagingOrganisation value={ORG_ID}>
        <VoiceCallDock
          call={call}
          channel={channel}
          store={makeStore('ordinary')}
          viewerId={ALICE}
          deviceSettings={null}
          meterRef={meterRef}
          panelMeterRef={panelMeterRef}
          placement="stage"
        />
      </MessagingOrganisation>
    )
    expect(await screen.findByTestId('live-captions-toggle')).toHaveTextContent('Sous-titres IA')
    unmount()

    render(
      <MessagingOrganisation value={ORG_ID}>
        <VoiceCallDock
          call={call}
          channel={channel}
          store={makeStore('confidential-unavailable')}
          viewerId={ALICE}
          deviceSettings={null}
          meterRef={meterRef}
          panelMeterRef={panelMeterRef}
          placement="stage"
        />
      </MessagingOrganisation>
    )
    expect(await screen.findByTestId('live-captions-confidential-disabled')).toBeDisabled()
  })

  it('binds two VoiceCallDock participants to the same shared LiveKit callInstanceId (RM_...) and transitions 1/2 -> 2/2 active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const roomId = '!audio-multi:acme.kodera.io'
      const sharedSid = 'RM_shared_multi_42'

      const makeReactiveCall = (initial: CallSnapshot) => {
        let current = initial
        const listeners = new Set<() => void>()
        const call: AudioCallLike = {
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
          getSnapshot: () => current,
          join: vi.fn(async () => undefined),
          leave: vi.fn(async () => undefined),
          setMuted: vi.fn(async () => undefined),
          setDeafened: vi.fn(async () => undefined),
          startAudio: vi.fn(async () => undefined),
        }
        return {
          call,
          setSnapshot: (next: CallSnapshot) => {
            current = next
            for (const listener of listeners) listener()
          },
        }
      }

      const connectingSnapshot: CallSnapshot = {
        status: 'connecting',
        roomId,
        muted: false,
        deafened: false,
        listenOnly: false,
        speakers: [],
        participants: [],
        playbackBlocked: false,
        videos: [],
        camera: 'off',
        screen: 'off',
      }
      const connectedSnapshot: CallSnapshot = {
        ...connectingSnapshot,
        status: 'connected',
        callInstanceId: sharedSid,
        participants: [ALICE, BOB],
      }

      const aliceCall = makeReactiveCall(connectingSnapshot)
      const bobCall = makeReactiveCall(connectingSnapshot)

      const channel: CallChannel = {
        channelId: CHANNEL_ID,
        roomId,
        roomName: 'Point produit',
        categoryName: 'Équipe',
      }
      const snapshot = {
        status: 'live',
        channels: new Map([[CHANNEL_ID, { state: 'resolved', roomId }]]),
        rooms: [
          {
            roomId,
            name: 'Point produit',
            alias: '#point:acme.kodera.io',
            kind: 'audio',
            unread: 0,
            mentions: 0,
            occupancy: { participants: [ALICE, BOB], screenShare: [] },
            names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
          },
        ],
        invites: [],
      } as unknown as EspaceSnapshot
      const makeStoreFor = (viewer: string): EspaceStoreLike => ({
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        getUserId: () => viewer,
        getRoomBoundary: () => 'ordinary',
        getTimeline: () => [],
        getThread: () => [],
        send: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        toggleReaction: vi.fn(async () => undefined),
        markRead: vi.fn(async () => undefined),
      })

      let serverSession: aiApi.LiveCallCaptionSessionView | null = null
      const consentedUsers = new Set<string>()
      let nextFetchCaller = ALICE
      const mockFetchSession = vi.mocked(aiApi.fetchLiveCallCaptionSession)
      const mockPostSession = vi.mocked(aiApi.postLiveCallCaptionSession)

      const viewForCaller = (caller: string): aiApi.LiveCallCaptionSessionView | null => {
        if (serverSession === null) return null
        return {
          ...serverSession,
          callerConsentState: consentedUsers.has(caller) ? 'consented' : 'pending',
        }
      }

      mockFetchSession.mockImplementation(async ({ callInstanceId }) => {
        if (serverSession !== null && serverSession.callInstanceId === callInstanceId) {
          return viewForCaller(nextFetchCaller)
        }
        return null
      })

      mockPostSession.mockImplementation(async ({ body }) => {
        const caller = body.participantUserIds?.[0] ?? ALICE
        if (body.action === 'start') {
          consentedUsers.add(caller)
          const next: aiApi.LiveCallCaptionSessionView = {
            sessionId: SESSION_ID,
            ...(body.callInstanceId === undefined ? {} : { callInstanceId: body.callInstanceId }),
            channelId: CHANNEL_ID,
            state: 'awaiting_all_consents',
            targetLanguage: body.targetLanguage ?? 'fr',
            rosterCount: 2,
            consentedCount: consentedUsers.size,
            unconsentedCount: 2 - consentedUsers.size,
            allConsented: consentedUsers.size === 2,
            callerConsentState: 'consented',
            callerMemberAiConsent: true,
            sessionEpoch: 1,
          }
          serverSession = next
          return viewForCaller(caller)
        }
        if (body.action === 'consent') {
          consentedUsers.add(caller)
          const next: aiApi.LiveCallCaptionSessionView = {
            sessionId: SESSION_ID,
            ...(body.callInstanceId === undefined ? {} : { callInstanceId: body.callInstanceId }),
            channelId: CHANNEL_ID,
            state: 'active',
            targetLanguage: body.targetLanguage ?? 'fr',
            rosterCount: 2,
            consentedCount: consentedUsers.size,
            unconsentedCount: 2 - consentedUsers.size,
            allConsented: consentedUsers.size === 2,
            callerConsentState: 'consented',
            callerMemberAiConsent: true,
            sessionEpoch: 1,
          }
          serverSession = next
          return viewForCaller(caller)
        }
        return viewForCaller(caller)
      })

      const aliceHost = document.createElement('div')
      const bobHost = document.createElement('div')
      document.body.append(aliceHost, bobHost)

      const aliceView = render(
        <MessagingOrganisation value={ORG_ID}>
          <VoiceCallDock
            call={aliceCall.call}
            channel={channel}
            store={makeStoreFor(ALICE)}
            viewerId={ALICE}
            deviceSettings={null}
            meterRef={createRef<HTMLSpanElement>()}
            panelMeterRef={createRef<HTMLSpanElement>()}
            placement="stage"
          />
        </MessagingOrganisation>,
        { container: aliceHost }
      )
      const bobView = render(
        <MessagingOrganisation value={ORG_ID}>
          <VoiceCallDock
            call={bobCall.call}
            channel={channel}
            store={makeStoreFor(BOB)}
            viewerId={BOB}
            deviceSettings={null}
            meterRef={createRef<HTMLSpanElement>()}
            panelMeterRef={createRef<HTMLSpanElement>()}
            placement="stage"
          />
        </MessagingOrganisation>,
        { container: bobHost }
      )

      const aliceUI = within(aliceView.container)
      const bobUI = within(bobView.container)

      // While `connecting` (before LiveKit room SID arrives), expanding captions makes ZERO API
      // calls and keeps the consent button disabled rather than minting a random UUID!
      await user.click(aliceUI.getByTestId('live-captions-toggle'))
      expect(aliceUI.getByTestId('live-captions-grant-consent')).toBeDisabled()
      expect(mockFetchSession).not.toHaveBeenCalled()
      expect(mockPostSession).not.toHaveBeenCalled()

      // Both browsers connect to the LiveKit room and share `RM_shared_multi_42`.
      act(() => {
        aliceCall.setSnapshot(connectedSnapshot)
        bobCall.setSnapshot(connectedSnapshot)
      })

      await waitFor(() => {
        expect(aliceUI.getByTestId('live-captions-grant-consent')).not.toBeDisabled()
      })
      expect(mockFetchSession).toHaveBeenCalledWith(
        expect.objectContaining({
          organisationId: ORG_ID,
          channelId: CHANNEL_ID,
          callInstanceId: sharedSid,
        })
      )

      // Alice starts and grants consent -> 1/2 (`awaiting_all_consents`) bound to `RM_shared_multi_42`.
      await user.click(aliceUI.getByTestId('live-captions-grant-consent'))
      expect(await aliceUI.findByTestId('live-captions-awaiting-pill')).toHaveTextContent(
        'En attente du consentement de tous (1/2)'
      )
      expect(mockPostSession).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            action: 'start',
            callInstanceId: sharedSid,
          }),
        })
      )

      // Bob opens captions -> hydrates Alice's exact `RM_shared_multi_42` session (1/2) -> grants consent -> 2/2 (`active`)!
      nextFetchCaller = BOB
      await user.click(bobUI.getByTestId('live-captions-toggle'))
      expect(await bobUI.findByTestId('live-captions-awaiting-pill')).toHaveTextContent(
        'En attente du consentement de tous (1/2)'
      )

      nextFetchCaller = ALICE
      await user.click(bobUI.getByTestId('live-captions-grant-consent'))
      expect(await bobUI.findByTestId('live-captions-active-pill')).toBeInTheDocument()
      expect(mockPostSession).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            action: 'consent',
            sessionId: SESSION_ID,
            callInstanceId: sharedSid,
          }),
        })
      )

      // Alice's 3s poll observes Bob's consent on the shared `RM_shared_multi_42` session -> 2/2 (`active`)!
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })
      expect(await aliceUI.findByTestId('live-captions-active-pill')).toBeInTheDocument()
      expect(aliceUI.getByTestId('live-captions-overlay')).toBeInTheDocument()
      expect(bobUI.getByTestId('live-captions-overlay')).toBeInTheDocument()

      aliceView.unmount()
      bobView.unmount()
      aliceHost.remove()
      bobHost.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps LiveCallCaptionsBar and MediaRecorder mounted across stage, sidebar, and floating placements while connected, firing leave strictly on disconnect', async () => {
    vi.useFakeTimers()
    const recorderInstances: Array<{
      state: 'inactive' | 'recording'
      stopCount: number
      ondataavailable: ((e: BlobEvent) => void) | null
      onstop: (() => void) | null
    }> = []

    class FakeMediaStream {
      readonly tracks: readonly MediaStreamTrack[]
      constructor(tracks: readonly MediaStreamTrack[]) {
        this.tracks = tracks
      }
    }

    class FakeMediaRecorder {
      static isTypeSupported(mime: string) {
        return mime === 'audio/webm'
      }
      state: 'inactive' | 'recording' = 'inactive'
      stopCount = 0
      ondataavailable: ((e: BlobEvent) => void) | null = null
      onstop: (() => void) | null = null

      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        recorderInstances.push(this)
      }

      start() {
        this.state = 'recording'
      }

      stop() {
        this.stopCount += 1
        this.state = 'inactive'
        const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x05])], {
          type: 'audio/webm',
        })
        this.ondataavailable?.({ data: blob } as BlobEvent)
        this.onstop?.()
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    try {
      const roomId = '!audio-persist:acme.kodera.io'
      const sharedSid = 'RM_stage_persist_1'
      const fakeTrack = { readyState: 'live' } as unknown as MediaStreamTrack

      let currentSnapshot: CallSnapshot = {
        status: 'connected',
        roomId,
        callInstanceId: sharedSid,
        muted: false,
        deafened: false,
        listenOnly: false,
        speakers: [],
        participants: [ALICE, BOB],
        playbackBlocked: false,
        videos: [],
        camera: 'off',
        screen: 'off',
      }
      const callListeners = new Set<() => void>()
      const call: AudioCallLike = {
        subscribe: (listener) => {
          callListeners.add(listener)
          return () => {
            callListeners.delete(listener)
          }
        },
        getSnapshot: () => currentSnapshot,
        join: vi.fn(async () => undefined),
        leave: vi.fn(async () => undefined),
        setMuted: vi.fn(async () => undefined),
        setDeafened: vi.fn(async () => undefined),
        startAudio: vi.fn(async () => undefined),
        localMicTrack: () => fakeTrack,
      }

      const channel: CallChannel = {
        channelId: CHANNEL_ID,
        roomId,
        roomName: 'Point produit',
        categoryName: 'Équipe',
      }
      const snapshot = {
        status: 'live',
        channels: new Map([[CHANNEL_ID, { state: 'resolved', roomId }]]),
        rooms: [
          {
            roomId,
            name: 'Point produit',
            alias: '#point:acme.kodera.io',
            kind: 'audio',
            unread: 0,
            mentions: 0,
            occupancy: { participants: [ALICE, BOB], screenShare: [] },
            names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
          },
        ],
        invites: [],
      } as unknown as EspaceSnapshot
      const store: EspaceStoreLike = {
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        getUserId: () => ALICE,
        getRoomBoundary: () => 'ordinary',
        getTimeline: () => [],
        getThread: () => [],
        send: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        toggleReaction: vi.fn(async () => undefined),
        markRead: vi.fn(async () => undefined),
      }

      const activeSession: aiApi.LiveCallCaptionSessionView = {
        sessionId: SESSION_ID,
        callInstanceId: sharedSid,
        channelId: CHANNEL_ID,
        state: 'active',
        targetLanguage: 'fr',
        rosterCount: 2,
        consentedCount: 2,
        unconsentedCount: 0,
        allConsented: true,
        callerConsentState: 'consented',
        callerMemberAiConsent: true,
        sessionEpoch: 1,
      }

      const mockFetchSession = vi.mocked(aiApi.fetchLiveCallCaptionSession)
      const mockPostSession = vi.mocked(aiApi.postLiveCallCaptionSession)
      const mockPostChunk = vi.mocked(aiApi.postLiveCallCaptionChunk)

      mockFetchSession.mockImplementation(async () => ({ ...activeSession }))
      mockPostSession.mockImplementation(async () => ({ ...activeSession }))
      let chunkSeq = 0
      mockPostChunk.mockImplementation(async () => {
        chunkSeq += 1
        return {
          sessionId: SESSION_ID,
          channelId: CHANNEL_ID,
          sourceText: `Ligne persistante ${String(chunkSeq)}`,
          translatedText: `Ligne persistante ${String(chunkSeq)}`,
          sourceLanguage: 'fr',
          targetLanguage: 'fr',
          provider: 'mistral',
          model: 'voxtral-mini-latest',
          ephemeral: true,
        }
      })

      const meterRef = createRef<HTMLSpanElement>()
      const panelMeterRef = createRef<HTMLSpanElement>()

      const renderDock = (placement: 'stage' | 'sidebar' | 'floating') => (
        <MessagingOrganisation value={ORG_ID}>
          <VoiceCallDock
            call={call}
            channel={channel}
            store={store}
            viewerId={ALICE}
            deviceSettings={null}
            meterRef={meterRef}
            panelMeterRef={panelMeterRef}
            placement={placement}
          />
        </MessagingOrganisation>
      )

      const { rerender } = render(renderDock('stage'))
      await act(async () => {
        await import('./LiveCallCaptionsBar')
        await Promise.resolve()
      })

      // Open captions in `stage` -> hydrates `active` session and starts `MediaRecorder` segment 1!
      act(() => {
        screen.getByTestId('live-captions-toggle').click()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId('live-captions-overlay')).toBeInTheDocument()
      expect(recorderInstances).toHaveLength(1)
      const firstRecorder = recorderInstances[0]

      // Switch to a text channel (`placement="sidebar"`) mid-segment (after 1s):
      // Stage caption UI chrome hides, ZERO `leave` call is sent, and `firstRecorder` is NOT stopped!
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      rerender(renderDock('sidebar'))
      expect(screen.queryByTestId('live-captions-bar')).toBeNull()
      expect(firstRecorder?.state).toBe('recording')
      expect(firstRecorder?.stopCount).toBe(0)
      expect(mockPostSession).not.toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ action: 'leave' }),
        })
      )

      // Remaining 2s of segment 1 elapse while in `sidebar` -> uploads chunk 1 and starts segment 2!
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(mockPostChunk).toHaveBeenCalledTimes(1)
      expect(recorderInstances).toHaveLength(2)

      // Switch to `floating` pill -> still NO `leave`, and segment 2 uploads after 3s!
      rerender(renderDock('floating'))
      expect(screen.queryByTestId('live-captions-bar')).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })
      expect(mockPostChunk).toHaveBeenCalledTimes(2)
      expect(mockPostSession).not.toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ action: 'leave' }),
        })
      )

      // Return to `stage` -> rolling lines captured during `sidebar` and `floating` are immediately shown!
      rerender(renderDock('stage'))
      const lines = screen.getAllByTestId('live-captions-line')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toHaveTextContent('Ligne persistante 1')
      expect(lines[1]).toHaveTextContent('Ligne persistante 2')

      // Disconnect the call (`status: 'ended'`) -> `action: 'leave'` fires immediately!
      act(() => {
        currentSnapshot = {
          ...currentSnapshot,
          status: 'ended',
          participants: [],
        }
        delete (currentSnapshot as { callInstanceId?: string }).callInstanceId
        for (const listener of callListeners) listener()
      })

      expect(mockPostSession).toHaveBeenCalledWith({
        organisationId: ORG_ID,
        channelId: CHANNEL_ID,
        body: {
          action: 'leave',
          sessionId: SESSION_ID,
        },
      })
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('fans out transcribed segments over DataChannel to listenOnly/muted peers, deduplicates segmentId, and ignores wrong callInstanceId/epoch', async () => {
    const activeSession: aiApi.LiveCallCaptionSessionView = {
      sessionId: SESSION_ID,
      callInstanceId: 'RM_fanout_1',
      channelId: CHANNEL_ID,
      state: 'active',
      targetLanguage: 'fr',
      rosterCount: 2,
      consentedCount: 2,
      unconsentedCount: 0,
      allConsented: true,
      callerConsentState: 'consented',
      callerMemberAiConsent: true,
      sessionEpoch: 3,
    }
    vi.mocked(aiApi.fetchLiveCallCaptionSession).mockResolvedValue(activeSession)
    vi.mocked(aiApi.postLiveCallCaptionSession).mockResolvedValue(activeSession)
    vi.mocked(aiApi.postLiveCallCaptionChunk).mockResolvedValue({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      sourceText: 'Ready to ship',
      translatedText: 'Prêt à livrer',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      provider: 'mistral',
      model: 'voxtral-mini-latest',
      ephemeral: true,
    })

    const peerListeners = new Set<(pkt: CallCaptionPacket) => void>()
    const publishedPackets: CallCaptionPacket[] = []
    const publishCaptionPacket = vi.fn(async (pkt: CallCaptionPacket) => {
      publishedPackets.push(pkt)
      for (const listener of peerListeners) listener({ ...pkt, senderUserId: ALICE })
      return true
    })
    const subscribeCaptionPackets = (listener: (pkt: CallCaptionPacket) => void) => {
      peerListeners.add(listener)
      return () => {
        peerListeners.delete(listener)
      }
    }
    const resolveSpeakerName = (userId: string) =>
      userId === ALICE ? 'Alice' : userId === BOB ? 'Bob' : 'Mallory'

    let emitChunk!: (chunk: { audioBase64: string }) => void
    const chunkSource = {
      subscribe: (cb: (chunk: { audioBase64: string }) => void) => {
        emitChunk = cb
        return () => {}
      },
    }

    const aliceHost = document.createElement('div')
    const bobHost = document.createElement('div')
    document.body.append(aliceHost, bobHost)
    try {
      // Alice is speaking; Bob is muted/listenOnly (no localAudioTrack or chunkSource).
      const aliceView = render(
        <LiveCallCaptionsBar
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          callInstanceId="RM_fanout_1"
          participants={[ALICE, BOB]}
          permitsPlaintext
          defaultExpanded
          localSpeakerLabel="Alice"
          resolveSpeakerName={resolveSpeakerName}
          chunkSource={chunkSource}
          publishCaptionPacket={publishCaptionPacket}
          subscribeCaptionPackets={subscribeCaptionPackets}
        />,
        { container: aliceHost }
      )
      const bobView = render(
        <LiveCallCaptionsBar
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          callInstanceId="RM_fanout_1"
          participants={[ALICE, BOB]}
          permitsPlaintext
          defaultExpanded
          localSpeakerLabel="Bob"
          resolveSpeakerName={resolveSpeakerName}
          localAudioTrack={null}
          subscribeCaptionPackets={subscribeCaptionPackets}
        />,
        { container: bobHost }
      )

      await waitFor(() => {
        expect(within(aliceHost).getByTestId('live-captions-overlay')).toBeInTheDocument()
        expect(within(bobHost).getByTestId('live-captions-overlay')).toBeInTheDocument()
      })

      act(() => {
        emitChunk({ audioBase64: globalThis.btoa('OggS\u0000\u0002\u0000\u0000') })
      })

      await waitFor(() => {
        expect(within(bobHost).getByTestId('live-captions-line')).toHaveTextContent(
          'Alice: Prêt à livrer'
        )
      })
      // Alice does not duplicate her own echoed segmentId, and segmentId is a random UUID!
      expect(within(aliceHost).getAllByTestId('live-captions-line')).toHaveLength(1)
      expect(publishedPackets).toHaveLength(1)
      expect(publishedPackets[0]!.segmentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      )

      // Duplicate replay of same segmentId, wrong callInstanceId, and wrong sessionEpoch are all ignored by Bob!
      act(() => {
        for (const listener of peerListeners) {
          listener({ ...publishedPackets[0]!, senderUserId: ALICE })
          listener({
            ...publishedPackets[0]!,
            segmentId: 'other-call-seg',
            callInstanceId: 'RM_other',
            text: 'Spoofed call',
          })
          listener({
            ...publishedPackets[0]!,
            segmentId: 'stale-epoch-seg',
            sessionEpoch: 2,
            text: 'Stale epoch',
          })
          // Peer attempting to spoof Alice's speakerLabel under verified senderUserId `@mallory:...`
          // is attributed strictly to `resolveSpeakerName(senderUserId)` ('Mallory'), never 'Alice'!
          listener({
            ...publishedPackets[0]!,
            segmentId: globalThis.crypto.randomUUID(),
            senderUserId: '@mallory:acme.kodera.io',
            speakerLabel: 'Alice',
            text: 'Spoof attempt',
            translations: { fr: 'Tentative usurpation' },
          })
        }
      })
      const bobLines = within(bobHost).getAllByTestId('live-captions-line')
      expect(bobLines).toHaveLength(2)
      expect(bobLines[1]).toHaveTextContent('Mallory: Tentative usurpation')
      expect(bobLines[1]).not.toHaveTextContent('Alice:')

      aliceView.unmount()
      bobView.unmount()
    } finally {
      aliceHost.remove()
      bobHost.remove()
    }
  })
})
