import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CROWD_ATTENUATED_GAIN,
  MENTION_COOLDOWN_MS,
  PEER_BURST_COALESCING_MS,
  SOUND_STORAGE_KEY,
  SoundEngine,
  VOICE_CALL_DUCK_GAIN,
} from '../../../src/features/sounds'
import type { SinkCapableAudioContext } from '../../../src/features/sounds'

function createMockAudioContext() {
  const startedSources: Array<{ gain: number; pan: number; stopped: boolean }> = []
  const setSinkId = vi.fn(async (_id: string) => {})

  let lastGain = 1
  let lastPan = 0

  const ctx = {
    state: 'running' as AudioContextState,
    sampleRate: 48000,
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => {}),
    setSinkId,
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const channelArrays = Array.from({ length: channels }, () => new Float32Array(length))
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (ch: number) => channelArrays[ch] ?? channelArrays[0]!,
      } as unknown as AudioBuffer
    },
    createBufferSource: () => {
      const record = { gain: 1, pan: 0, stopped: false }
      return {
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        start: vi.fn(() => {
          record.gain = lastGain
          record.pan = lastPan
          startedSources.push(record)
        }),
        stop: vi.fn(() => {
          record.stopped = true
        }),
      } as unknown as AudioBufferSourceNode
    },
    createGain: () => {
      const gainParam = {
        get value() {
          return lastGain
        },
        set value(v: number) {
          lastGain = v
        },
      }
      return {
        gain: gainParam,
        connect: vi.fn(),
      } as unknown as GainNode
    },
    createStereoPanner: () => {
      const panParam = {
        get value() {
          return lastPan
        },
        set value(v: number) {
          lastPan = v
        },
      }
      return {
        pan: panParam,
        connect: vi.fn(),
      } as unknown as StereoPannerNode
    },
  }

  return {
    ctx: ctx as unknown as SinkCapableAudioContext,
    startedSources,
    setSinkId,
  }
}

describe('SoundEngine policy & precedence matrix (SoundEngine.ts)', () => {
  let fakeNow = 100_000
  let reducedMotion = false
  let documentHidden = false

  beforeEach(() => {
    localStorage.clear()
    fakeNow = 100_000
    reducedMotion = false
    documentHidden = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  function makeEngine() {
    const mock = createMockAudioContext()
    const engine = new SoundEngine({
      audioContextFactory: () => mock.ctx,
      now: () => fakeNow,
      reducedMotionQuery: () => reducedMotion,
      documentHiddenQuery: () => documentHidden,
    })
    return { engine, ...mock }
  }

  it('persists and loads preferences in localStorage under kodera:sound-preferences:v1', () => {
    const { engine } = makeEngine()
    expect(engine.getPreferences()).toEqual({
      pack: 'givre',
      masterMode: 'on',
      masterVolume: 0.8,
      categories: {
        voice: true,
        calls: true,
        messages: true,
        workspace: true,
      },
      mentionVariant: 'eclat',
      vipEnriched: false,
      selfActionsOnly: false,
      softenedHighs: false,
      outputDeviceId: null,
    })

    engine.setPack('atelier')
    engine.setMasterVolume(0.65)
    engine.setCategoryEnabled('workspace', false)

    const raw = localStorage.getItem(SOUND_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.pack).toBe('atelier')
    expect(parsed.masterVolume).toBe(0.65)
    expect(parsed.categories.workspace).toBe(false)

    const reloaded = makeEngine().engine
    expect(reloaded.getPreferences().pack).toBe('atelier')
    expect(reloaded.getPreferences().masterVolume).toBe(0.65)
    expect(reloaded.getPreferences().categories.workspace).toBe(false)
  })

  it('enforces dnd policy: allows only Tier 0 self/safety cues and suppresses Tiers 1..3', () => {
    const { engine } = makeEngine()
    engine.setUserStatus('dnd')

    const tier0Triggers = [
      'voice_self_join',
      'voice_self_leave',
      'voice_mute_on',
      'voice_mute_off',
      'voice_deafen_on',
      'voice_deafen_off',
      'voice_ptt_engage',
      'voice_ptt_release',
      'voice_permission_denied',
      'call_end',
    ] as const

    for (const trigger of tier0Triggers) {
      const res = engine.play(trigger)
      expect(res.allowed, `${trigger} should play in dnd`).toBe(true)
      expect(res.tier).toBe(0)
    }

    const blockedInDnd = [
      'call_ring_incoming_loop',
      'msg_mention',
      'msg_dm',
      'voice_peer_join',
      'msg_thread_reply',
      'workspace_agenda_reminder',
      'msg_channel_unread',
    ] as const

    for (const trigger of blockedInDnd) {
      const res = engine.play(trigger)
      expect(res.allowed, `${trigger} should be suppressed in dnd`).toBe(false)
      expect(res.reason).toBe('dnd')
    }
  })

  it('enforces masterMode === essential: allows Tier 0 and Tier 1, suppresses Tier 2 and Tier 3', () => {
    const { engine } = makeEngine()
    engine.setMasterMode('essential')

    expect(engine.play('voice_mute_on').allowed).toBe(true)
    expect(engine.play('call_ring_incoming_loop').allowed).toBe(true)
    expect(engine.play('msg_mention').allowed).toBe(true)

    const tier2 = engine.play('voice_peer_join')
    expect(tier2.allowed).toBe(false)
    expect(tier2.reason).toBe('essential-mode')

    const tier3 = engine.play('msg_channel_unread')
    expect(tier3.allowed).toBe(false)
    expect(tier3.reason).toBe('essential-mode')
  })

  it('ducks Tier 2 by -6 dB (0.5x) and suppresses Tier 3 when activeVoiceCall is true', () => {
    const { engine } = makeEngine()
    engine.setMasterVolume(0.8)
    engine.setActiveVoiceCall(true)

    const tier0 = engine.play('voice_mute_on')
    expect(tier0.allowed).toBe(true)
    expect(tier0.ducked).toBe(false)
    expect(tier0.gain).toBeCloseTo(0.8, 4)

    const tier1 = engine.play('msg_mention')
    expect(tier1.allowed).toBe(true)
    expect(tier1.ducked).toBe(false)
    expect(tier1.gain).toBeCloseTo(0.8, 4)

    const tier2 = engine.play('msg_thread_reply')
    expect(tier2.allowed).toBe(true)
    expect(tier2.ducked).toBe(true)
    expect(tier2.gain).toBeCloseTo(0.8 * VOICE_CALL_DUCK_GAIN, 4)

    const tier3 = engine.play('msg_channel_unread')
    expect(tier3.allowed).toBe(false)
    expect(tier3.reason).toBe('active-call-suppressed')
    expect(tier3.gain).toBe(0)
  })

  it('disables spatial pan and defaults workspace category to false under prefers-reduced-motion: reduce', () => {
    reducedMotion = true
    const { engine, startedSources } = makeEngine()

    expect(engine.getPreferences().categories.workspace).toBe(false)

    // Spatial pan on panned cues is forced to 0
    const res = engine.play('msg_mention', { pan: 0.65 })
    expect(res.allowed).toBe(true)
    expect(res.pan).toBe(0)
    expect(startedSources[0]?.pan).toBe(0)

    // Workspace cue suppressed by default when reduced-motion is active
    const ws = engine.play('workspace_agenda_reminder')
    expect(ws.allowed).toBe(false)
    expect(ws.reason).toBe('category-disabled')
  })

  it('applies crowd scaling (1..4 at 0 dB, 5..8 at -3 dB, >= 9 silent) and 2500 ms burst coalescing on peer join/leave', () => {
    const { engine } = makeEngine()
    engine.setMasterVolume(0.8)

    // 4 participants -> 0 dB (1.0x)
    const join4 = engine.play('voice_peer_join', { participantCount: 4, roomId: 'room-a' })
    expect(join4.allowed).toBe(true)
    expect(join4.gain).toBeCloseTo(0.8, 4)

    // Within 2500 ms in same room -> coalesced
    fakeNow += 1200
    const coalesced = engine.play('voice_peer_leave', { participantCount: 4, roomId: 'room-a' })
    expect(coalesced.allowed).toBe(false)
    expect(coalesced.reason).toBe('peer-burst-coalesced')

    // After 2500 ms with 6 participants -> -3 dB (0.708x)
    fakeNow += PEER_BURST_COALESCING_MS
    const join6 = engine.play('voice_peer_join', { participantCount: 6, roomId: 'room-a' })
    expect(join6.allowed).toBe(true)
    expect(join6.gain).toBeCloseTo(0.8 * CROWD_ATTENUATED_GAIN, 4)

    // 8 participants -> -3 dB (0.708x)
    fakeNow += PEER_BURST_COALESCING_MS
    const leave8 = engine.play('voice_peer_leave', { participantCount: 8, roomId: 'room-a' })
    expect(leave8.allowed).toBe(true)
    expect(leave8.gain).toBeCloseTo(0.8 * CROWD_ATTENUATED_GAIN, 4)

    // 9 participants -> silent
    fakeNow += PEER_BURST_COALESCING_MS
    const join9 = engine.play('voice_peer_join', { participantCount: 9, roomId: 'room-a' })
    expect(join9.allowed).toBe(false)
    expect(join9.reason).toBe('crowd-limit')
    expect(join9.gain).toBe(0)
  })

  it('enforces 3000 ms per-channel mention cooldown and self-message anti-echo', () => {
    const { engine } = makeEngine()
    engine.setCurrentUserId('user-self')

    // Self-authored message never triggers msg_*
    const selfEcho = engine.play('msg_mention', {
      senderId: 'user-self',
      channelId: 'chan-1',
    })
    expect(selfEcho.allowed).toBe(false)
    expect(selfEcho.reason).toBe('self-message')

    // Peer mention in chan-1 plays
    const firstMention = engine.play('msg_mention', {
      senderId: 'user-peer',
      channelId: 'chan-1',
    })
    expect(firstMention.allowed).toBe(true)

    // Second mention in chan-1 within 3000 ms is suppressed
    fakeNow += 1500
    const cooldownBlocked = engine.play('msg_mention', {
      senderId: 'user-peer-2',
      channelId: 'chan-1',
    })
    expect(cooldownBlocked.allowed).toBe(false)
    expect(cooldownBlocked.reason).toBe('mention-cooldown')

    // Mention in chan-2 is independent and plays immediately
    const otherChannel = engine.play('msg_mention', {
      senderId: 'user-peer-2',
      channelId: 'chan-2',
    })
    expect(otherChannel.allowed).toBe(true)

    // Mention in chan-1 after 3000 ms plays again
    fakeNow += MENTION_COOLDOWN_MS
    const afterCooldown = engine.play('msg_mention', {
      senderId: 'user-peer',
      channelId: 'chan-1',
    })
    expect(afterCooldown.allowed).toBe(true)
  })

  it('starts and stops ringing loops and automatically stops active loops on call_end or visibilitychange', () => {
    const { engine, startedSources } = makeEngine()

    const started = engine.startLoop('call_ring_incoming_loop')
    expect(started).toBe(true)
    expect(engine.isLoopActive('call_ring_incoming_loop')).toBe(true)
    expect(startedSources).toHaveLength(1)

    vi.advanceTimersByTime(3200)
    expect(startedSources).toHaveLength(2)

    // Playing call_end stops the active ring loop
    engine.play('call_end')
    expect(engine.isLoopActive('call_ring_incoming_loop')).toBe(false)

    const countAfterEnd = startedSources.length
    vi.advanceTimersByTime(6400)
    expect(startedSources).toHaveLength(countAfterEnd)

    // Restart outgoing loop and trigger visibilitychange -> hidden
    expect(engine.startLoop('call_ring_outgoing_loop')).toBe(true)
    expect(engine.isLoopActive('call_ring_outgoing_loop')).toBe(true)

    documentHidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.isLoopActive('call_ring_outgoing_loop')).toBe(false)
  })

  it('delegates setOutputDevice to AudioContext.setSinkId and persists outputDeviceId', async () => {
    const { engine, setSinkId } = makeEngine()
    const applied = await engine.setOutputDevice('usb-headset-42')
    expect(applied).toBe(true)
    expect(setSinkId).toHaveBeenCalledWith('usb-headset-42')
    expect(engine.getPreferences().outputDeviceId).toBe('usb-headset-42')
  })
})
