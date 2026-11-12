import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { EspaceLiveView, type EspaceStoreLike } from '../espace/EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView } from '../espace/matrix/store'
import type { MessageView } from '../espace/matrix/timeline'
import {
  MENTION_COOLDOWN_MS,
  SYNTH_SAMPLE_RATE,
   SoundEngine,
  VOICE_CALL_DUCK_GAIN,
  clearSynthCache,
  measurePeak,
  measureRms,
  soundEngine,
  synthesizeCue,
  waveformSignature,
} from '../sounds'
import { SoundsScreen } from '../sounds/SoundsScreen'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import { DocsWorkspacePanel } from './DocsWorkspacePanel'
import {
  buildChannelDocsPadUrl,
  buildTenantDocsOrigin,
  parseDocsPostMessageEvent,
  validateExternalDocsUrl,
} from './url'

const GENERAL_ID = 'a1111111-1111-4111-8111-000000000001'
const PROXIMITY_ID = 'a1111111-1111-4111-8111-000000000911'
const GENERAL_ROOM = '!general:matrix.acme.kodera.io'
const PROXIMITY_ROOM = '!proximity:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@henri.duflot:matrix.acme.kodera.io'

const GENERAL_CHANNEL: WorkspaceChannel = {
  id: GENERAL_ID,
  kind: 'text',
  name: 'general',
  template_key: 'general',
  topic: 'Discussions générales et pads Docs',
  lifecycle: 'active',
  room_state: 'ready',
}

const PROXIMITY_CHANNEL: WorkspaceChannel = {
  id: PROXIMITY_ID,
  kind: 'text',
  name: 'proximity',
  template_key: null,
  topic: 'Présence de proximité, pointage volontaire',
  lifecycle: 'active',
  room_state: 'ready',
}

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-general',
      name: 'General',
      template_key: 'general',
      channels: [GENERAL_CHANNEL, PROXIMITY_CHANNEL],
    },
  ],
  uncategorised_channels: [],
}

function resolveChannelDocUrl(options: {
  readonly tenantSlug: string
  readonly channelId: string
  readonly channelName: string
  readonly candidateUrl?: string | undefined
  readonly baseDomain?: string | undefined
}): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string } {
  const expectedOrigin = buildTenantDocsOrigin(options.tenantSlug, options.baseDomain)
  const targetUrl =
    options.candidateUrl ??
    buildChannelDocsPadUrl({
      tenantSlug: options.tenantSlug,
      channelId: options.channelId,
      channelName: options.channelName,
      baseDomain: options.baseDomain,
    })
  const validation = validateExternalDocsUrl(targetUrl, expectedOrigin)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  return { ok: true, url: validation.normalizedUrl }
}

function GuardedDocsSurface({
  tenantSlug,
  channelId,
  channelName,
  candidateUrl,
}: {
  readonly tenantSlug: string
  readonly channelId: string
  readonly channelName: string
  readonly candidateUrl?: string | undefined
}) {
  const resolved = resolveChannelDocUrl({
    tenantSlug,
    channelId,
    channelName,
    candidateUrl,
  })
  if (!resolved.ok) {
    return (
      <InlineAlert kind="error">
        {`Adresse Docs refusée par la politique de sécurité (${resolved.reason}).`}
      </InlineAlert>
    )
  }
  return (
    <DocsWorkspacePanel
      tenantSlug={tenantSlug}
      channelId={channelId}
      channelName={channelName}
    />
  )
}

describe('DocsSonicIntegration — Sonic Identity DSP + Call Ducking + Docs + Espace #proximity', () => {
  beforeEach(() => {
    localStorage.clear()
    clearSynthCache()
    soundEngine.resetCooldowns()
    soundEngine.setActiveVoiceCall(false)
    soundEngine.setUserStatus('online')
    soundEngine.setPack('givre')
    soundEngine.setMasterVolume(1)
  })

  afterEach(() => {
    soundEngine.resetCooldowns()
    soundEngine.setActiveVoiceCall(false)
    soundEngine.setUserStatus('online')
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('switches sound packs (givre -> atelier -> silencieux) via SoundsScreen, synthesizes deterministic 48,000 Hz PCM buffers, applies -6 dB call ducking, and suppresses playback in silencieux or dnd', async () => {
    const user = userEvent.setup()
    const fakeNowMs = 1_762_520_100_000
    const engine = new SoundEngine({
      audioContextFactory: () => null,
      now: () => fakeNowMs,
      reducedMotionQuery: () => false,
      documentHiddenQuery: () => false,
    })
    engine.setMasterVolume(1)

    render(<SoundsScreen engine={engine} />)

    // 1. Default pack is givre
    expect(engine.getPreferences().pack).toBe('givre')
    expect(screen.getByRole('radio', { name: 'Givre' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    const givreMention = synthesizeCue('givre', 'msg_mention')
    const givreJoin = synthesizeCue('givre', 'voice_self_join')
    expect(givreMention.sampleRate).toBe(SYNTH_SAMPLE_RATE)
    expect(givreMention.sampleRate).toBe(48_000)
    expect(givreJoin.sampleRate).toBe(48_000)
    expect(measurePeak(givreMention.mono)).toBeGreaterThan(0.05)
    expect(measureRms(givreMention.mono)).toBeGreaterThan(0.005)
    expect(measurePeak(givreJoin.mono)).toBeGreaterThan(0.05)

    // Determinism across repeated synthesis
    const givreMentionRepeat = synthesizeCue('givre', 'msg_mention')
    expect(waveformSignature(givreMention.mono)).toBe(
      waveformSignature(givreMentionRepeat.mono)
    )

    // 2. Switch to Atelier via SoundsScreen radio card
    await user.click(screen.getByRole('radio', { name: 'Atelier' }))
    expect(engine.getPreferences().pack).toBe('atelier')
    expect(screen.getByRole('radio', { name: 'Atelier' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    const atelierMention = synthesizeCue('atelier', 'msg_mention')
    const atelierJoin = synthesizeCue('atelier', 'voice_self_join')
    expect(atelierMention.sampleRate).toBe(48_000)
    expect(atelierJoin.sampleRate).toBe(48_000)
    expect(measurePeak(atelierMention.mono)).toBeGreaterThan(0.05)
    expect(measurePeak(atelierJoin.mono)).toBeGreaterThan(0.05)
    expect(waveformSignature(atelierMention.mono)).not.toBe(
      waveformSignature(givreMention.mono)
    )

    // 3. Verify call ducking hierarchy when an active voice call is flagged on SoundEngine:
    // Tier 0 (voice_self_join) and Tier 1 (msg_mention) remain un-ducked, Tier 2 (voice_peer_join) ducks by -6 dB, Tier 3 (msg_channel_unread) is suppressed
    const normalPeerJoinDecision = engine.evaluate('voice_peer_join')
    expect(normalPeerJoinDecision.allowed).toBe(true)
    expect(normalPeerJoinDecision.effectivePack).toBe('atelier')
    expect(normalPeerJoinDecision.ducked).toBe(false)
    expect(normalPeerJoinDecision.gain).toBeCloseTo(1, 6)

    engine.setActiveVoiceCall(true)
    expect(VOICE_CALL_DUCK_GAIN).toBeCloseTo(0.501187, 2)

    const mentionInCall = engine.evaluate('msg_mention', {
      channelId: GENERAL_ID,
      senderId: ALICE,
      currentUserId: ME,
    })
    expect(mentionInCall.allowed).toBe(true)
    expect(mentionInCall.tier).toBe(1)
    expect(mentionInCall.ducked).toBe(false)
    expect(mentionInCall.gain).toBeCloseTo(1, 6)

    const duckedPeerJoin = engine.evaluate('voice_peer_join')
    expect(duckedPeerJoin.allowed).toBe(true)
    expect(duckedPeerJoin.tier).toBe(2)
    expect(duckedPeerJoin.ducked).toBe(true)
    expect(duckedPeerJoin.gain).toBe(VOICE_CALL_DUCK_GAIN)
    expect(duckedPeerJoin.gain).toBeCloseTo(0.501187, 2)

    const suppressedChannelMsg = engine.evaluate('msg_channel_unread', {
      channelId: GENERAL_ID,
      senderId: ALICE,
      currentUserId: ME,
    })
    expect(suppressedChannelMsg.allowed).toBe(false)
    expect(suppressedChannelMsg.tier).toBe(3)
    expect(suppressedChannelMsg.reason).toBe('active-call-suppressed')

    // 4. Verify DND suppresses non-Tier-0 playback completely
    engine.setUserStatus('dnd')
    const dndDecision = engine.play('msg_mention', {
      channelId: GENERAL_ID,
      senderId: ALICE,
      currentUserId: ME,
    })
    expect(dndDecision.allowed).toBe(false)
    expect(dndDecision.reason).toBe('dnd')
    expect(dndDecision.gain).toBe(0)
    engine.setUserStatus('online')

    // 5. Switch to Silencieux via SoundsScreen -> suppresses playback completely
    const packGroup = screen.getByRole('radiogroup', { name: 'Signature sonore' })
    await user.click(within(packGroup).getByRole('radio', { name: 'Silencieux' }))
    expect(engine.getPreferences().pack).toBe('silencieux')
    expect(engine.getPreferences().masterMode).toBe('off')

    const silentMentionDecision = engine.play('msg_mention', {
      channelId: GENERAL_ID,
      senderId: ALICE,
      currentUserId: ME,
    })
    expect(silentMentionDecision.allowed).toBe(false)
    expect(silentMentionDecision.reason).toBe('pack-silencieux')
    expect(silentMentionDecision.gain).toBe(0)

    const silentSynth = synthesizeCue('silencieux', 'msg_mention')
    expect(silentSynth.sampleRate).toBe(48_000)
    expect(silentSynth.peakLinear).toBe(0)

    engine.destroy()
  })

  it('coalesces rapid live mentions in EspaceLiveView within the 3,000 ms cooldown window and ducks cues during an active voice call', () => {
    const playSpy = vi.spyOn(soundEngine, 'play')
    soundEngine.setPack('givre')
    soundEngine.setMasterVolume(1)
    soundEngine.setActiveVoiceCall(true)

    const listeners = new Set<() => void>()
    const members: readonly MemberView[] = [{ userId: ALICE, name: 'Henri Duflot' }]
    let currentTimeline: readonly MessageView[] = [
      {
        key: '$m0',
        eventId: '$m0',
        sender: ALICE,
        body: 'Initialisation du salon',
        ts: 1_762_520_100_000,
        edited: false,
        redacted: false,
        delivery: 'sent',
        replyTo: null,
        reactions: [],
      },
    ]

    let snapshot: EspaceSnapshot = {
      status: 'live',
      channels: new Map<string, ChannelRoom>([
        [GENERAL_ID, { state: 'resolved', roomId: GENERAL_ROOM }],
        [PROXIMITY_ID, { state: 'resolved', roomId: PROXIMITY_ROOM }],
      ]),
      rooms: [
        {
          roomId: GENERAL_ROOM,
          name: 'general',
          alias: null,
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
        {
          roomId: PROXIMITY_ROOM,
          name: 'proximity',
          alias: null,
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
      ],
      invites: [],
    }

    const store: EspaceStoreLike = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      getUserId: () => ME,
      getTimeline: (roomId) => (roomId === GENERAL_ROOM ? currentTimeline : []),
      getThread: () => [],
      getMembers: () => members,
      loadMembers: vi.fn(),
      send: vi.fn(async () => undefined),
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
    }

    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL_ID}
        store={store}
      />
    )

    expect(playSpy).not.toHaveBeenCalled()

    // Deliver two rapid @me mentions and one self-authored mention in the same live timeline batch
    act(() => {
      currentTimeline = [
        ...currentTimeline,
        {
          key: '$m1',
          eventId: '$m1',
          sender: ALICE,
          body: 'Salut @me, peux-tu vérifier le pad Docs ?',
          ts: 1_762_520_101_000,
          edited: false,
          redacted: false,
          delivery: 'sent',
          replyTo: null,
          reactions: [],
          mentionsMe: true,
        },
        {
          key: '$m2',
          eventId: '$m2',
          sender: ALICE,
          body: 'Deuxième mention immédiate @me dans les 3000 ms',
          ts: 1_762_520_101_200,
          edited: false,
          redacted: false,
          delivery: 'sent',
          replyTo: null,
          reactions: [],
          mentionsMe: true,
        },
        {
          key: '$m3',
          eventId: '$m3',
          sender: ME,
          body: 'Auto-mention @me ignorée',
          ts: 1_762_520_101_300,
          edited: false,
          redacted: false,
          delivery: 'sent',
          replyTo: null,
          reactions: [],
          mentionsMe: true,
        },
      ]
      snapshot = { ...snapshot, rooms: [...snapshot.rooms] }
      for (const listener of listeners) listener()
    })

    expect(MENTION_COOLDOWN_MS).toBe(3000)
    expect(playSpy).toHaveBeenCalledTimes(2)

    const firstDecision = playSpy.mock.results[0]?.value
    const secondDecision = playSpy.mock.results[1]?.value

    expect(firstDecision).toMatchObject({
      allowed: true,
      triggerId: 'msg_mention',
      tier: 1,
      ducked: false,
      gain: 1,
    })
    expect(secondDecision).toMatchObject({
      allowed: false,
      triggerId: 'msg_mention',
      reason: 'mention-cooldown',
      gain: 0,
    })

    // Tier 2 voice cue evaluated during the same active call is ducked by -6 dB
    expect(soundEngine.evaluate('voice_peer_join')).toMatchObject({
      allowed: true,
      triggerId: 'voice_peer_join',
      tier: 2,
      ducked: true,
      gain: VOICE_CALL_DUCK_GAIN,
    })
  })

  it('renders the sovereign Docs collaboration surface for https://docs.acme.kodera.io, builds deterministic channel-bound URLs, and fails closed (role="alert") on http://, credentialed, or localhost URLs alongside #proximity', async () => {
    const user = userEvent.setup()
    const docsOrigin = buildTenantDocsOrigin('acme')
    expect(docsOrigin).toBe('https://docs.acme.kodera.io')

    const resolvedFirst = resolveChannelDocUrl({
      tenantSlug: 'acme',
      channelId: GENERAL_ID,
      channelName: 'Architecture & Sécurité',
    })
    const resolvedSecond = resolveChannelDocUrl({
      tenantSlug: 'acme',
      channelId: GENERAL_ID,
      channelName: 'Architecture & Sécurité',
    })
    expect(resolvedFirst.ok).toBe(true)
    expect(resolvedFirst).toEqual(resolvedSecond)
    if (resolvedFirst.ok) {
      expect(resolvedFirst.url).toMatch(
        /^https:\/\/docs\.acme\.kodera\.io\/pads\/architecture-securite-[0-9a-f]{8}$/
      )
    }

    // Verify valid HTTPS tenant Docs surface coexists with Espace #proximity
    const { rerender } = render(
      <div>
        <GuardedDocsSurface
          tenantSlug="acme"
          channelId={GENERAL_ID}
          channelName="Architecture & Sécurité"
        />
      </div>
    )

    expect(
      screen.getByRole('heading', { name: 'Docs — Documents collaboratifs' })
    ).toBeInTheDocument()
    const docsLink = screen.getByRole('link', {
      name: /Ouvrir Notes — Architecture & Sécurité dans Docs/i,
    })
    expect(docsLink).toHaveAttribute(
      'href',
      resolvedFirst.ok ? resolvedFirst.url : ''
    )
    expect(screen.queryByRole('alert')).toBeNull()

    // Verify postMessage handoff accepts only exact https://docs.acme.kodera.io origin
    expect(
      parseDocsPostMessageEvent(
        {
          origin: 'https://docs.acme.kodera.io',
          data: {
            type: 'docs:pad:ready',
            padId: 'pad-arch-01',
            title: 'Architecture Réseau',
            padUrl: 'https://docs.acme.kodera.io/pads/architecture-reseau',
          },
        },
        docsOrigin
      )
    ).toEqual({
      type: 'docs:pad:ready',
      padId: 'pad-arch-01',
      title: 'Architecture Réseau',
      padUrl: 'https://docs.acme.kodera.io/pads/architecture-reseau',
    })

    // Fail closed with role="alert" on http:// (cleartext protocol)
    rerender(
      <GuardedDocsSurface
        tenantSlug="acme"
        channelId={GENERAL_ID}
        channelName="Architecture & Sécurité"
        candidateUrl="http://docs.acme.kodera.io/pads/cleartext"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/disallowed_protocol/i)
    expect(screen.queryByRole('link', { name: /Ouvrir/i })).toBeNull()

    // Fail closed with role="alert" on credentialed URL
    rerender(
      <GuardedDocsSurface
        tenantSlug="acme"
        channelId={GENERAL_ID}
        channelName="Architecture & Sécurité"
        candidateUrl="https://admin:secret@docs.acme.kodera.io/pads/secret"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/credentials_forbidden/i)
    expect(screen.queryByRole('link', { name: /Ouvrir/i })).toBeNull()

    // Fail closed with role="alert" on localhost / loopback URL
    rerender(
      <GuardedDocsSurface
        tenantSlug="acme"
        channelId={GENERAL_ID}
        channelName="Architecture & Sécurité"
        candidateUrl="https://localhost:3000/pads/internal"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/origin_mismatch/i)
    expect(screen.queryByRole('link', { name: /Ouvrir/i })).toBeNull()

    // Also verify switching to #proximity in EspaceLiveView while DocsWorkspacePanel is mounted
    const snapshot: EspaceSnapshot = {
      status: 'live',
      channels: new Map<string, ChannelRoom>([
        [GENERAL_ID, { state: 'resolved', roomId: GENERAL_ROOM }],
        [PROXIMITY_ID, { state: 'resolved', roomId: PROXIMITY_ROOM }],
      ]),
      rooms: [
        {
          roomId: GENERAL_ROOM,
          name: 'general',
          alias: null,
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
        {
          roomId: PROXIMITY_ROOM,
          name: 'proximity',
          alias: null,
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
      ],
      invites: [],
    }
    const store: EspaceStoreLike = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getUserId: () => ME,
      getTimeline: () => [],
      getThread: () => [],
      getMembers: () => [],
      loadMembers: vi.fn(),
      send: vi.fn(async () => undefined),
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
    }

    rerender(
      <div>
        <GuardedDocsSurface
          tenantSlug="acme"
          channelId={PROXIMITY_ID}
          channelName="proximity"
        />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL_ID}
          store={store}
        />
      </div>
    )

    const proximityLink = screen.getByRole('link', { name: 'proximity' })
    await user.click(proximityLink)

    // A channel named « proximity » is an ordinary channel until the server flags it.
    expect(screen.queryByTestId('proximity-room-panel')).toBeNull()
  })
})
