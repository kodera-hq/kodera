import type {
  AcousticPackId,
  CanonicalCueSlug,
  CueSynthSpec,
  MentionVariantId,
  SemanticTriggerId,
  SoundCategory,
  SoundPackDescriptor,
  SoundPackId,
  SoundPreferences,
  SoundTier,
  SoundTriggerInput,
} from './types'

export const SOUND_STORAGE_KEY = 'kodera:sound-preferences:v1'
export const SOUND_CHANGE_EVENT = 'kodera:sound-preferences-change'

export const ACOUSTIC_PACK_IDS: readonly AcousticPackId[] = [
  'givre',
  'atelier',
  'souffle',
  'cosmos',
  'luciole',
] as const

export const SOUND_PACK_IDS: readonly SoundPackId[] = [
  'givre',
  'atelier',
  'souffle',
  'cosmos',
  'luciole',
  'silencieux',
] as const

export const MENTION_VARIANT_IDS: readonly MentionVariantId[] = [
  'eclat',
  'goutte',
  'sillage',
] as const

export const DEFAULT_SOUND_PACK: SoundPackId = 'givre'
export const SILENCIEUX_SAFETY_PACK: AcousticPackId = 'souffle'
export const COBALT_PARTIAL_RATIO = 4.0

export const PEER_BURST_COALESCING_MS = 2500
export const MENTION_COOLDOWN_MS = 3000
export const VOICE_CALL_DUCK_GAIN = 0.5
export const CROWD_FULL_MAX = 4
export const CROWD_ATTENUATED_MAX = 8
export const CROWD_ATTENUATED_GAIN = 0.708

/**
 * Natural hexachordal spine F -> C -> G -> D -> A -> E (0 sharps, 0 flats, B omitted).
 */
export const HEXACHORD_PITCHES = {
  G3: 196.0,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
  D5: 587.33,
  E5: 659.26,
  A5: 880.0,
} as const

export interface PackDspProfile {
  readonly order: number
  readonly isDefault: boolean
  readonly hpf: number
  readonly valleyDb: number
  readonly lpf: number
  readonly erAlpha: number
  readonly lufsOffset: number
  readonly tpToggle: number
  readonly tpFull: number
}

export const PACK_PROFILES: Record<AcousticPackId, PackDspProfile> = {
  givre: {
    order: 1,
    isDefault: true,
    hpf: 148,
    valleyDb: -7.0,
    lpf: 4400,
    erAlpha: 0.12,
    lufsOffset: 0.0,
    tpToggle: 0.555,
    tpFull: 0.685,
  },
  atelier: {
    order: 2,
    isDefault: false,
    hpf: 115,
    valleyDb: -6.5,
    lpf: 3200,
    erAlpha: 0.08,
    lufsOffset: 0.0,
    tpToggle: 0.555,
    tpFull: 0.685,
  },
  souffle: {
    order: 3,
    isDefault: false,
    hpf: 140,
    valleyDb: -3.5,
    lpf: 3350,
    erAlpha: 0.05,
    lufsOffset: -3.5,
    tpToggle: 0.308,
    tpFull: 0.468,
  },
  cosmos: {
    order: 4,
    isDefault: false,
    hpf: 120,
    valleyDb: -6.0,
    lpf: 3850,
    erAlpha: 0.14,
    lufsOffset: -0.5,
    tpToggle: 0.525,
    tpFull: 0.67,
  },
  luciole: {
    order: 5,
    isDefault: false,
    hpf: 135,
    valleyDb: -6.0,
    lpf: 4200,
    erAlpha: 0.12,
    lufsOffset: 0.0,
    tpToggle: 0.555,
    tpFull: 0.685,
  },
}

export const SOUND_PACKS: readonly SoundPackDescriptor[] = [
  {
    id: 'givre',
    order: 1,
    isDefault: true,
    labelKey: 'console.shell.sounds.label-givre',
    hintKey: 'console.shell.sounds.hint-givre',
    badgeKey: 'console.shell.sounds.badge-givre',
    previewTrigger: 'voice_self_join',
  },
  {
    id: 'atelier',
    order: 2,
    isDefault: false,
    labelKey: 'console.shell.sounds.label-atelier',
    hintKey: 'console.shell.sounds.hint-atelier',
    previewTrigger: 'voice_self_join',
  },
  {
    id: 'souffle',
    order: 3,
    isDefault: false,
    labelKey: 'console.shell.sounds.label-souffle',
    hintKey: 'console.shell.sounds.hint-souffle',
    previewTrigger: 'voice_self_join',
  },
  {
    id: 'cosmos',
    order: 4,
    isDefault: false,
    labelKey: 'console.shell.sounds.label-cosmos',
    hintKey: 'console.shell.sounds.hint-cosmos',
    previewTrigger: 'voice_self_join',
  },
  {
    id: 'luciole',
    order: 5,
    isDefault: false,
    labelKey: 'console.shell.sounds.label-luciole',
    hintKey: 'console.shell.sounds.hint-luciole',
    previewTrigger: 'voice_self_join',
  },
  {
    id: 'silencieux',
    order: 6,
    isDefault: false,
    labelKey: 'console.shell.sounds.label-silencieux',
    hintKey: 'console.shell.sounds.hint-silencieux',
    previewTrigger: 'voice_self_join',
  },
] as const

const P = HEXACHORD_PITCHES

/**
 * All 31 canonical cues per pack from compile-sounds.mjs (26 semantic triggers + 5 mention/VIP variants).
 */
export const CANONICAL_CUES: readonly CueSynthSpec[] = [
  {
    slug: 'call-mute',
    semantic: 'semantic.sound.call.mute',
    description:
      'Local confirmation played once browser capture stop and LiveKit microphone mute are both confirmed.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -21.4,
    notes: [P.A4, P.E4],
    onsets: [0, 0.045],
    dur: 0.095,
    atk: 0.005,
    cobaltHz: null,
    damper: true,
    lpSweep: [2200, 820],
    durationMs: 120,
    cooldownMs: 80,
  },
  {
    slug: 'call-unmute',
    semantic: 'semantic.sound.call.unmute',
    description: 'Local confirmation of active microphone capture with Cobalt harmonic node.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -20.8,
    notes: [P.E4, P.A4],
    onsets: [0, 0.045],
    dur: 0.095,
    atk: 0.0045,
    cobaltHz: 1760.0,
    cobaltTrim: 0.65,
    lpSweep: [1500, 3800],
    durationMs: 120,
    cooldownMs: 80,
  },
  {
    slug: 'call-deafen',
    semantic: 'semantic.sound.call.deafen',
    description:
      'Low fifth confirmation played once atomic headphone and microphone silence is confirmed, suppressing duplicate mute tone.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -19.8,
    notes: [P.D4, P.G3],
    onsets: [0, 0.05],
    dur: 0.115,
    atk: 0.006,
    cobaltHz: null,
    damper: true,
    lpSweep: [2000, 440],
    durationMs: 150,
    cooldownMs: 100,
  },
  {
    slug: 'call-undeafen',
    semantic: 'semantic.sound.call.undeafen',
    description: 'Confirmation that headphone playback is restored and room audio is live again.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -19.2,
    notes: [P.G3, P.D4],
    extraNote: { f0: P.D5, onset: 0.05, gain: 0.34 },
    onsets: [0, 0.05],
    dur: 0.115,
    atk: 0.0055,
    cobaltHz: 2349.32,
    lpSweep: [460, 3600],
    durationMs: 150,
    cooldownMs: 100,
  },
  {
    slug: 'room-self-join',
    semantic: 'semantic.sound.room.self-join',
    description: 'Primary signature cue when the member connects to an audio or video room.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -17.2,
    notes: [P.D4, P.A4],
    onsets: [0, 0.065],
    dur: 0.255,
    atk: 0.006,
    cobaltHz: 1760.0,
    lpSweep: [1450, 4200],
    durationMs: 320,
    cooldownMs: 150,
  },
  {
    slug: 'room-self-leave',
    semantic: 'semantic.sound.room.self-leave',
    description:
      'Descending mirror cue when the member leaves a live room or disconnects after inactivity.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -17.8,
    notes: [P.A4, P.D4],
    onsets: [0, 0.065],
    dur: 0.255,
    atk: 0.007,
    cobaltHz: null,
    damper: true,
    lpSweep: [2400, 440],
    durationMs: 320,
    cooldownMs: 150,
  },
  {
    slug: 'room-listen-only',
    semantic: 'semantic.sound.room.listen-only',
    description:
      'Entry cue for a listen-only room grant with publish rights withheld (no Cobalt partial).',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -18.8,
    notes: [P.D4, P.G4],
    onsets: [0, 0.065],
    dur: 0.25,
    atk: 0.0065,
    cobaltHz: null,
    lpSweep: [1450, 1350],
    durationMs: 320,
    cooldownMs: 150,
  },
  {
    slug: 'room-peer-join',
    semantic: 'semantic.sound.room.peer-join',
    description:
      'Subtle arrival cue when another participant joins the active voice room the member occupies.',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'peer',
    nonMutable: false,
    toggle: true,
    lufs: -22.2,
    notes: [P.G4, P.A4],
    onsets: [0, 0.055],
    dur: 0.135,
    atk: 0.006,
    cobaltHz: null,
    lpSweep: [1500, 1850],
    durationMs: 180,
    cooldownMs: PEER_BURST_COALESCING_MS,
    defaultPan: -0.18,
  },
  {
    slug: 'room-peer-leave',
    semantic: 'semantic.sound.room.peer-leave',
    description:
      'Subtle departure cue when another participant leaves the active voice room the member occupies.',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'peer',
    nonMutable: false,
    toggle: true,
    lufs: -22.8,
    notes: [P.A4, P.G4],
    onsets: [0, 0.055],
    dur: 0.135,
    atk: 0.006,
    cobaltHz: null,
    damper: true,
    lpSweep: [1800, 950],
    durationMs: 180,
    cooldownMs: PEER_BURST_COALESCING_MS,
    defaultPan: 0.18,
  },
  {
    slug: 'visio-guest-knock',
    semantic: 'semantic.sound.visio.guest-knock',
    description:
      'Waiting-room knock played only to participants holding admission rights, coalesced over 15 seconds.',
    tier: 1,
    category: 'voice',
    blueprintCategory: 'presence',
    nonMutable: false,
    knock: true,
    lufs: -18.5,
    notes: [P.E4, P.E4, P.A4],
    onsets: [0, 0.095, 0.195],
    dur: 0.185,
    atk: 0.005,
    cobaltHz: 1760.0,
    durationMs: 320,
    cooldownMs: 15000,
    defaultPan: -0.25,
  },
  {
    slug: 'call-hand-raise',
    semantic: 'semantic.sound.call.hand-raise',
    description: 'Poised rising sixth cue when a participant raises a hand to request the floor.',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -19.5,
    notes: [P.C4, P.A4],
    onsets: [0, 0.058],
    dur: 0.155,
    atk: 0.006,
    cobaltHz: 1760.0,
    cobaltTrim: 0.5,
    durationMs: 200,
    cooldownMs: 1500,
    defaultPan: 0.15,
  },
  {
    slug: 'call-share-start',
    semantic: 'semantic.sound.call.share-start',
    description: 'Ascending octave cue confirming screen share capture has started.',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    lufs: -18.4,
    notes: [P.C4, P.C5],
    onsets: [0, 0.06],
    dur: 0.17,
    atk: 0.006,
    cobaltHz: 2093.0,
    lpSweep: [1600, 4100],
    durationMs: 220,
    cooldownMs: 500,
  },
  {
    slug: 'call-share-stop',
    semantic: 'semantic.sound.call.share-stop',
    description:
      'Descending octave cue confirming screen share capture has stopped, including browser-bar termination.',
    tier: 2,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    lufs: -19.0,
    notes: [P.C5, P.C4],
    onsets: [0, 0.06],
    dur: 0.17,
    atk: 0.0065,
    cobaltHz: null,
    damper: true,
    lpSweep: [2400, 700],
    durationMs: 220,
    cooldownMs: 500,
  },
  {
    slug: 'compliance-rec-start',
    semantic: 'semantic.sound.compliance.rec-start',
    description:
      'Non-mutable legal notice seal played to all participants when room recording or transcription starts.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'compliance',
    nonMutable: true,
    lufs: -16.8,
    notes: [P.D4, P.G4, P.D5],
    onsets: [0, 0.095, 0.19],
    dur: 0.21,
    atk: 0.008,
    cobaltHz: 2349.32,
    durationMs: 360,
    cooldownMs: 1000,
  },
  {
    slug: 'compliance-rec-stop',
    semantic: 'semantic.sound.compliance.rec-stop',
    description:
      'Non-mutable legal notice seal played to all participants when room recording or transcription stops.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'compliance',
    nonMutable: true,
    lufs: -17.4,
    notes: [P.D5, P.G4, P.D4],
    onsets: [0, 0.095, 0.19],
    dur: 0.21,
    atk: 0.008,
    cobaltHz: null,
    damper: true,
    lpSweep: [2600, 900],
    durationMs: 360,
    cooldownMs: 1000,
  },
  {
    slug: 'msg-mention-eclat',
    semantic: 'semantic.sound.msg.mention',
    description:
      'Default two-note notification for a direct mention or direct message while the target room is unfocused.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'eclat',
    vip: false,
    lufs: -18.4,
    dur: 0.17,
    atk: 0.006,
    cobaltHz: 2637.02,
    durationMs: 200,
    cooldownMs: MENTION_COOLDOWN_MS,
    defaultPan: 0.12,
  },
  {
    slug: 'msg-mention-eclat-vip',
    semantic: null,
    description: 'VIP-enriched two-note Eclat mention cue with inner quartal D5 voice.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'eclat',
    vip: true,
    lufs: -18.0,
    dur: 0.17,
    atk: 0.006,
    cobaltHz: 2637.02,
    durationMs: 200,
    cooldownMs: MENTION_COOLDOWN_MS,
    defaultPan: 0.12,
  },
  {
    slug: 'msg-mention-goutte',
    semantic: null,
    description: 'Focused single-note Goutte mention or direct message notification.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'goutte',
    vip: false,
    lufs: -18.8,
    dur: 0.13,
    atk: 0.0055,
    cobaltHz: 2349.32,
    durationMs: 120,
    cooldownMs: MENTION_COOLDOWN_MS,
  },
  {
    slug: 'msg-mention-goutte-vip',
    semantic: null,
    description: 'VIP-enriched Goutte mention cue with prepended A4 grace note.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'goutte',
    vip: true,
    lufs: -18.4,
    dur: 0.14,
    atk: 0.0055,
    cobaltHz: 2349.32,
    durationMs: 140,
    cooldownMs: MENTION_COOLDOWN_MS,
  },
  {
    slug: 'msg-mention-sillage',
    semantic: null,
    description: 'Expressive three-note ascending quintal Sillage mention notification.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'sillage',
    vip: false,
    lufs: -18.2,
    dur: 0.22,
    atk: 0.006,
    cobaltHz: 2637.02,
    durationMs: 280,
    cooldownMs: MENTION_COOLDOWN_MS,
    defaultPan: 0.12,
  },
  {
    slug: 'msg-mention-sillage-vip',
    semantic: null,
    description: 'VIP-enriched three-note Sillage mention cue with upper A5 octave halo.',
    tier: 1,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    isMention: true,
    variant: 'sillage',
    vip: true,
    lufs: -17.8,
    dur: 0.22,
    atk: 0.006,
    cobaltHz: 2637.02,
    durationMs: 280,
    cooldownMs: MENTION_COOLDOWN_MS,
    defaultPan: 0.12,
  },
  {
    slug: 'msg-thread-reply',
    semantic: 'semantic.sound.msg.thread-reply',
    description: 'Single-droplet notification for a reply in a followed thread while unfocused.',
    tier: 2,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    toggle: true,
    lufs: -23.0,
    notes: [P.A4],
    onsets: [0],
    dur: 0.115,
    atk: 0.0055,
    cobaltHz: null,
    lpSweep: [1900, 1500],
    durationMs: 120,
    cooldownMs: 1500,
    defaultPan: 0.1,
  },
  {
    slug: 'agenda-reminder',
    semantic: 'semantic.sound.agenda.reminder',
    description:
      'Horizon reminder five minutes before a scheduled meeting when not already in the room.',
    tier: 2,
    category: 'workspace',
    blueprintCategory: 'notify',
    nonMutable: false,
    lufs: -18.0,
    notes: [P.G4, P.A4, P.D5],
    onsets: [0, 0.08, 0.16],
    dur: 0.195,
    atk: 0.007,
    cobaltHz: 2349.32,
    durationMs: 320,
    cooldownMs: 5000,
  },
  {
    slug: 'call-ringtone-in',
    semantic: 'semantic.sound.call.ringtone-in',
    description:
      'Breathing musical phrase for an incoming direct call, respecting device Do Not Disturb.',
    tier: 1,
    category: 'calls',
    blueprintCategory: 'ring',
    nonMutable: true,
    lufs: -17.0,
    notes: [P.D4, P.A4, P.E5, P.D5],
    onsets: [0, 0.085, 0.17, 0.36],
    dur: 0.34,
    atk: 0.009,
    cobaltHz: 2637.02,
    durationMs: 680,
    cooldownMs: 500,
    loopIntervalMs: 3200,
  },
  {
    slug: 'call-ringback-out',
    semantic: 'semantic.sound.call.ringback-out',
    description:
      'Soft caller-side ringback fifth loop while waiting for an outgoing direct call to connect.',
    tier: 1,
    category: 'calls',
    blueprintCategory: 'ring',
    nonMutable: false,
    lufs: -21.5,
    notes: [P.D4, P.A4],
    onsets: [0, 0.055],
    dur: 0.38,
    atk: 0.01,
    cobaltHz: null,
    lpSweep: [1800, 1550],
    durationMs: 420,
    cooldownMs: 500,
    loopIntervalMs: 3000,
  },
  {
    slug: 'system-priority-alert',
    semantic: 'semantic.sound.system.priority-alert',
    description: 'Non-mutable audit-logged on-call priority alert permitted through quiet hours.',
    tier: 1,
    category: 'workspace',
    blueprintCategory: 'compliance',
    nonMutable: true,
    lufs: -16.2,
    notes: [P.A4, P.D5, P.A4, P.E5],
    onsets: [0, 0.07, 0.21, 0.28],
    dur: 0.18,
    atk: 0.006,
    cobaltHz: 2637.02,
    durationMs: 420,
    cooldownMs: 2000,
  },
  {
    slug: 'call-reconnecting',
    semantic: 'semantic.sound.call.reconnecting',
    description:
      'Hollow unresolved cue played after more than 1.5 seconds of sustained media transport loss.',
    tier: 1,
    category: 'calls',
    blueprintCategory: 'network',
    nonMutable: false,
    hollow: true,
    lufs: -19.6,
    notes: [P.D4, P.E4],
    onsets: [0, 0.08],
    dur: 0.175,
    atk: 0.007,
    cobaltHz: null,
    lpSweep: [1250, 1050],
    durationMs: 240,
    cooldownMs: 1500,
    loopIntervalMs: 2400,
  },
  {
    slug: 'call-restored',
    semantic: 'semantic.sound.call.restored',
    description: 'Resolving fourth cue confirming media transport recovery after reconnection.',
    tier: 1,
    category: 'calls',
    blueprintCategory: 'network',
    nonMutable: false,
    lufs: -18.6,
    notes: [P.E4, P.A4],
    onsets: [0, 0.065],
    dur: 0.185,
    atk: 0.006,
    cobaltHz: 1760.0,
    lpSweep: [1350, 3900],
    durationMs: 240,
    cooldownMs: 1000,
  },
  {
    slug: 'compliance-revoked',
    semantic: 'semantic.sound.compliance.revoked',
    description:
      'Non-mutable administrative seal played on immediate session revocation or unconfirmed-mute safety disconnect.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'compliance',
    nonMutable: true,
    lufs: -17.6,
    notes: [P.A4, P.F4, P.D4],
    onsets: [0, 0.08, 0.16],
    dur: 0.19,
    atk: 0.007,
    cobaltHz: null,
    lpSweep: [1700, 880],
    durationMs: 320,
    cooldownMs: 500,
  },
  {
    slug: 'settings-speaker-test',
    semantic: 'semantic.sound.settings.speaker-test',
    description:
      'Explicit Left, Right, and Center stereo diagnostic sequence triggered from sound settings.',
    tier: 0,
    category: 'workspace',
    blueprintCategory: 'diagnostic',
    nonMutable: true,
    stereoTest: true,
    lufs: -17.2,
    dur: 0.34,
    atk: 0.007,
    cobaltHz: 2349.32,
    durationMs: 960,
    cooldownMs: 250,
  },
  {
    slug: 'msg-send-failed',
    semantic: 'semantic.sound.msg.send-failed',
    description:
      'Subdued descending minor-third cue when an outbox message fails while the window is unfocused.',
    tier: 2,
    category: 'messages',
    blueprintCategory: 'notify',
    nonMutable: false,
    toggle: true,
    lufs: -20.2,
    notes: [P.F4, P.D4],
    onsets: [0, 0.058],
    dur: 0.135,
    atk: 0.006,
    cobaltHz: null,
    damper: true,
    lpSweep: [1300, 750],
    durationMs: 180,
    cooldownMs: 1000,
  },
] as const

/**
 * Additional runtime synthesis cue specs for direct ergonomic triggers
 * (PTT engage/release, direct call connect/end, ambient workspace/channel unread).
 */
export const SUPPLEMENTAL_CUES: readonly CueSynthSpec[] = [
  {
    slug: 'ptt-engage',
    semantic: null,
    description: 'Crisp tactile ascending fourth micro-cue when Push-to-Talk is pressed.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -21.0,
    notes: [P.D4, P.G4],
    onsets: [0, 0.032],
    dur: 0.075,
    atk: 0.004,
    cobaltHz: 1760.0,
    cobaltTrim: 0.55,
    lpSweep: [1600, 3600],
    durationMs: 90,
    cooldownMs: 40,
  },
  {
    slug: 'ptt-release',
    semantic: null,
    description: 'Soft damped descending fourth micro-cue when Push-to-Talk is released.',
    tier: 0,
    category: 'voice',
    blueprintCategory: 'control',
    nonMutable: false,
    toggle: true,
    lufs: -21.8,
    notes: [P.G4, P.D4],
    onsets: [0, 0.032],
    dur: 0.075,
    atk: 0.0045,
    cobaltHz: null,
    damper: true,
    lpSweep: [2000, 780],
    durationMs: 90,
    cooldownMs: 40,
  },
  {
    slug: 'call-connect',
    semantic: null,
    description: 'Warm ascending fifth confirmation when a direct call connects.',
    tier: 1,
    category: 'calls',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -17.6,
    notes: [P.C4, P.G4, P.D5],
    onsets: [0, 0.055, 0.115],
    dur: 0.21,
    atk: 0.006,
    cobaltHz: 2349.32,
    lpSweep: [1500, 4000],
    durationMs: 280,
    cooldownMs: 250,
  },
  {
    slug: 'call-end',
    semantic: null,
    description: 'Clean descending fifth closure when a direct call ends.',
    tier: 0,
    category: 'calls',
    blueprintCategory: 'presence',
    nonMutable: false,
    lufs: -18.2,
    notes: [P.G4, P.C4],
    onsets: [0, 0.06],
    dur: 0.21,
    atk: 0.0065,
    cobaltHz: null,
    damper: true,
    lpSweep: [2100, 520],
    durationMs: 260,
    cooldownMs: 200,
  },
  {
    slug: 'msg-channel-unread',
    semantic: null,
    description: 'Whisper-level ambient workspace indicator for background channel activity.',
    tier: 3,
    category: 'workspace',
    blueprintCategory: 'notify',
    nonMutable: false,
    toggle: true,
    lufs: -24.0,
    notes: [P.G4],
    onsets: [0],
    dur: 0.095,
    atk: 0.006,
    cobaltHz: null,
    lpSweep: [1600, 1200],
    durationMs: 110,
    cooldownMs: 2000,
    defaultPan: 0.15,
  },
] as const

export const ALL_CUE_SPECS: readonly CueSynthSpec[] = [
  ...CANONICAL_CUES,
  ...SUPPLEMENTAL_CUES,
] as const

export const CANONICAL_CUE_SLUGS: readonly CanonicalCueSlug[] = CANONICAL_CUES.map(
  (c) => c.slug as CanonicalCueSlug
)

const CUE_BY_SLUG = new Map<string, CueSynthSpec>(ALL_CUE_SPECS.map((c) => [c.slug, c]))
const CUE_BY_SEMANTIC = new Map<string, CueSynthSpec>(
  ALL_CUE_SPECS.filter((c) => c.semantic !== null).map((c) => [c.semantic as string, c])
)

export interface TriggerBinding {
  readonly triggerId: SemanticTriggerId
  readonly defaultSlug: string
  readonly tier: SoundTier
  readonly category: SoundCategory
}

export const TRIGGER_BINDINGS: Record<SemanticTriggerId, TriggerBinding> = {
  voice_self_join: {
    triggerId: 'voice_self_join',
    defaultSlug: 'room-self-join',
    tier: 0,
    category: 'voice',
  },
  voice_self_leave: {
    triggerId: 'voice_self_leave',
    defaultSlug: 'room-self-leave',
    tier: 0,
    category: 'voice',
  },
  voice_listen_only: {
    triggerId: 'voice_listen_only',
    defaultSlug: 'room-listen-only',
    tier: 2,
    category: 'voice',
  },
  voice_mute_on: {
    triggerId: 'voice_mute_on',
    defaultSlug: 'call-mute',
    tier: 0,
    category: 'voice',
  },
  voice_mute_off: {
    triggerId: 'voice_mute_off',
    defaultSlug: 'call-unmute',
    tier: 0,
    category: 'voice',
  },
  voice_deafen_on: {
    triggerId: 'voice_deafen_on',
    defaultSlug: 'call-deafen',
    tier: 0,
    category: 'voice',
  },
  voice_deafen_off: {
    triggerId: 'voice_deafen_off',
    defaultSlug: 'call-undeafen',
    tier: 0,
    category: 'voice',
  },
  voice_ptt_engage: {
    triggerId: 'voice_ptt_engage',
    defaultSlug: 'ptt-engage',
    tier: 0,
    category: 'voice',
  },
  voice_ptt_release: {
    triggerId: 'voice_ptt_release',
    defaultSlug: 'ptt-release',
    tier: 0,
    category: 'voice',
  },
  voice_permission_denied: {
    triggerId: 'voice_permission_denied',
    defaultSlug: 'compliance-revoked',
    tier: 0,
    category: 'voice',
  },
  voice_peer_join: {
    triggerId: 'voice_peer_join',
    defaultSlug: 'room-peer-join',
    tier: 2,
    category: 'voice',
  },
  voice_peer_leave: {
    triggerId: 'voice_peer_leave',
    defaultSlug: 'room-peer-leave',
    tier: 2,
    category: 'voice',
  },
  voice_guest_knock: {
    triggerId: 'voice_guest_knock',
    defaultSlug: 'visio-guest-knock',
    tier: 1,
    category: 'voice',
  },
  voice_hand_raise: {
    triggerId: 'voice_hand_raise',
    defaultSlug: 'call-hand-raise',
    tier: 2,
    category: 'voice',
  },
  voice_share_start: {
    triggerId: 'voice_share_start',
    defaultSlug: 'call-share-start',
    tier: 2,
    category: 'voice',
  },
  voice_share_stop: {
    triggerId: 'voice_share_stop',
    defaultSlug: 'call-share-stop',
    tier: 2,
    category: 'voice',
  },
  compliance_rec_start: {
    triggerId: 'compliance_rec_start',
    defaultSlug: 'compliance-rec-start',
    tier: 0,
    category: 'voice',
  },
  compliance_rec_stop: {
    triggerId: 'compliance_rec_stop',
    defaultSlug: 'compliance-rec-stop',
    tier: 0,
    category: 'voice',
  },
  call_ring_incoming_loop: {
    triggerId: 'call_ring_incoming_loop',
    defaultSlug: 'call-ringtone-in',
    tier: 1,
    category: 'calls',
  },
  call_ring_outgoing_loop: {
    triggerId: 'call_ring_outgoing_loop',
    defaultSlug: 'call-ringback-out',
    tier: 1,
    category: 'calls',
  },
  call_connect: {
    triggerId: 'call_connect',
    defaultSlug: 'call-connect',
    tier: 1,
    category: 'calls',
  },
  call_end: {
    triggerId: 'call_end',
    defaultSlug: 'call-end',
    tier: 0,
    category: 'calls',
  },
  call_reconnecting_pulse: {
    triggerId: 'call_reconnecting_pulse',
    defaultSlug: 'call-reconnecting',
    tier: 1,
    category: 'calls',
  },
  call_restored: {
    triggerId: 'call_restored',
    defaultSlug: 'call-restored',
    tier: 1,
    category: 'calls',
  },
  msg_mention: {
    triggerId: 'msg_mention',
    defaultSlug: 'msg-mention-eclat',
    tier: 1,
    category: 'messages',
  },
  msg_dm: {
    triggerId: 'msg_dm',
    defaultSlug: 'msg-mention-goutte',
    tier: 1,
    category: 'messages',
  },
  msg_thread_reply: {
    triggerId: 'msg_thread_reply',
    defaultSlug: 'msg-thread-reply',
    tier: 2,
    category: 'messages',
  },
  msg_send_failed: {
    triggerId: 'msg_send_failed',
    defaultSlug: 'msg-send-failed',
    tier: 2,
    category: 'messages',
  },
  msg_channel_unread: {
    triggerId: 'msg_channel_unread',
    defaultSlug: 'msg-channel-unread',
    tier: 3,
    category: 'workspace',
  },
  workspace_agenda_reminder: {
    triggerId: 'workspace_agenda_reminder',
    defaultSlug: 'agenda-reminder',
    tier: 2,
    category: 'workspace',
  },
  workspace_priority_alert: {
    triggerId: 'workspace_priority_alert',
    defaultSlug: 'system-priority-alert',
    tier: 1,
    category: 'workspace',
  },
  workspace_speaker_test: {
    triggerId: 'workspace_speaker_test',
    defaultSlug: 'settings-speaker-test',
    tier: 0,
    category: 'workspace',
  },
}

const SLUG_TO_TRIGGER: Record<string, SemanticTriggerId> = {
  'call-mute': 'voice_mute_on',
  'call-unmute': 'voice_mute_off',
  'call-deafen': 'voice_deafen_on',
  'call-undeafen': 'voice_deafen_off',
  'room-self-join': 'voice_self_join',
  'room-self-leave': 'voice_self_leave',
  'room-listen-only': 'voice_listen_only',
  'room-peer-join': 'voice_peer_join',
  'room-peer-leave': 'voice_peer_leave',
  'visio-guest-knock': 'voice_guest_knock',
  'call-hand-raise': 'voice_hand_raise',
  'call-share-start': 'voice_share_start',
  'call-share-stop': 'voice_share_stop',
  'compliance-rec-start': 'compliance_rec_start',
  'compliance-rec-stop': 'compliance_rec_stop',
  'msg-mention-eclat': 'msg_mention',
  'msg-mention-eclat-vip': 'msg_mention',
  'msg-mention-goutte': 'msg_dm',
  'msg-mention-goutte-vip': 'msg_dm',
  'msg-mention-sillage': 'msg_mention',
  'msg-mention-sillage-vip': 'msg_mention',
  'msg-thread-reply': 'msg_thread_reply',
  'agenda-reminder': 'workspace_agenda_reminder',
  'call-ringtone-in': 'call_ring_incoming_loop',
  'call-ringback-out': 'call_ring_outgoing_loop',
  'system-priority-alert': 'workspace_priority_alert',
  'call-reconnecting': 'call_reconnecting_pulse',
  'call-restored': 'call_restored',
  'compliance-revoked': 'voice_permission_denied',
  'settings-speaker-test': 'workspace_speaker_test',
  'msg-send-failed': 'msg_send_failed',
  'ptt-engage': 'voice_ptt_engage',
  'ptt-release': 'voice_ptt_release',
  'call-connect': 'call_connect',
  'call-end': 'call_end',
  'msg-channel-unread': 'msg_channel_unread',
}

export function getCueSpecBySlug(slug: string): CueSynthSpec | undefined {
  return CUE_BY_SLUG.get(slug)
}

export function resolveSoundTrigger(
  input: SoundTriggerInput | string,
  mentionVariant: MentionVariantId = 'eclat',
  vip = false
): { triggerId: SemanticTriggerId; cue: CueSynthSpec } | null {
  const normalized = input === 'ptt_engage' ? 'voice_ptt_engage' : input === 'ptt_release' ? 'voice_ptt_release' : input

  if (normalized in TRIGGER_BINDINGS) {
    const binding = TRIGGER_BINDINGS[normalized as SemanticTriggerId]
    let targetSlug = binding.defaultSlug
    if (binding.triggerId === 'msg_mention') {
      targetSlug = vip ? `msg-mention-${mentionVariant}-vip` : `msg-mention-${mentionVariant}`
    } else if (binding.triggerId === 'msg_dm' && vip) {
      targetSlug = 'msg-mention-goutte-vip'
    }
    const cue = CUE_BY_SLUG.get(targetSlug) ?? CUE_BY_SLUG.get(binding.defaultSlug)
    if (!cue) return null
    return { triggerId: binding.triggerId, cue }
  }

  const bySemantic = CUE_BY_SEMANTIC.get(normalized)
  if (bySemantic) {
    const triggerId = SLUG_TO_TRIGGER[bySemantic.slug] ?? 'voice_self_join'
    if (bySemantic.slug === 'msg-mention-eclat') {
      const slug = vip ? `msg-mention-${mentionVariant}-vip` : `msg-mention-${mentionVariant}`
      const variantCue = CUE_BY_SLUG.get(slug) ?? bySemantic
      return { triggerId, cue: variantCue }
    }
    return { triggerId, cue: bySemantic }
  }

  const bySlug = CUE_BY_SLUG.get(normalized)
  if (bySlug) {
    const triggerId = SLUG_TO_TRIGGER[bySlug.slug] ?? 'voice_self_join'
    return { triggerId, cue: bySlug }
  }

  return null
}

export function createDefaultSoundPreferences(reducedMotion = false): SoundPreferences {
  return {
    pack: DEFAULT_SOUND_PACK,
    masterMode: 'on',
    masterVolume: 0.8,
    categories: {
      voice: true,
      calls: true,
      messages: true,
      workspace: !reducedMotion,
    },
    mentionVariant: 'eclat',
    vipEnriched: false,
    selfActionsOnly: false,
    softenedHighs: false,
    outputDeviceId: null,
  }
}

/**
 * Canonical bilingual copy for SoundsScreen (SONIC_DESIGN_HANDOFF.md section E + category/mode controls).
 * Allows Phase 1 rendering without touching shared i18n JSON files while Lane 1 is active,
 * and delegates to i18next automatically once Phase 2 merges the keys into fr.json / en.json.
 */
export const SOUNDS_COPY_FR: Record<string, string> = {
  'console.shell.sounds.title': 'Ambiance sonore',
  'console.shell.sounds.subtitle':
    'Choisissez la signature sonore des salons, appels et notifications.',
  'console.shell.sounds.label-pack-group': 'Signature sonore',
  'console.shell.sounds.label-givre': 'Givre',
  'console.shell.sounds.badge-givre': 'Par défaut',
  'console.shell.sounds.hint-givre':
    'Clarté cristalline adoucie par le feutre. La signature sonore de Kodera.',
  'console.shell.sounds.label-atelier': 'Atelier',
  'console.shell.sounds.hint-atelier':
    'Cordes feutrées et mécanique douce, pensé pour les longues sessions en salon audio.',
  'console.shell.sounds.label-souffle': 'Souffle',
  'console.shell.sounds.hint-souffle':
    'Air laminaire soyeux et céramique mate, pensé pour travailler dans le calme.',
  'console.shell.sounds.label-cosmos': 'Cosmos',
  'console.shell.sounds.hint-cosmos':
    'Ruban d’Ondes Martenot, filtre liquide analogique et grain French Touch.',
  'console.shell.sounds.label-luciole': 'Luciole',
  'console.shell.sounds.hint-luciole':
    'Gouttes d’eau physiques, cordes de kora sur calebasse et bambou vivant.',
  'console.shell.sounds.label-silencieux': 'Silencieux',
  'console.shell.sounds.hint-silencieux':
    'Désactive les sons d’interface hors signaux d’enregistrement, de sécurité et d’appels entrants.',
  'console.shell.sounds.action-preview': 'Aperçu',
  'console.shell.sounds.action-preview-pack': 'Écouter un aperçu de {pack}',
  'console.shell.sounds.status-preview-playing': 'Aperçu sonore en cours : {pack}.',
  'console.shell.sounds.status-speaker-test': 'Test stéréo Gauche, Droite et Centre en cours.',
  'console.shell.sounds.label-master-mode': 'Mode sonore',
  'console.shell.sounds.mode-on': 'Tous les sons',
  'console.shell.sounds.mode-essential': 'Essentiels uniquement',
  'console.shell.sounds.mode-off': 'Silencieux',
  'console.shell.sounds.label-master-volume': 'Volume principal',
  'console.shell.sounds.label-categories': 'Catégories sonores',
  'console.shell.sounds.category-voice': 'Salons vocaux et présence',
  'console.shell.sounds.category-calls': 'Appels et sonneries',
  'console.shell.sounds.category-messages': 'Mentions et messages',
  'console.shell.sounds.category-workspace': 'Espace de travail et rappels',
  'console.shell.sounds.label-mention-variant': 'Signal de mention et message direct',
  'console.shell.sounds.option-mention-eclat': 'Éclat (2 notes · par défaut)',
  'console.shell.sounds.option-mention-goutte': 'Goutte (1 note · concentré)',
  'console.shell.sounds.option-mention-sillage': 'Sillage (3 notes · expressif)',
  'console.shell.sounds.label-vip': 'Enrichir les contacts et salons prioritaires',
  'console.shell.sounds.label-self-only': 'Mes actions uniquement dans les salons vocaux',
  'console.shell.sounds.label-softened': 'Sons adoucis (hautes fréquences atténuées)',
  'console.shell.sounds.action-speaker-test': 'Tester Gauche / Droite',
  'console.shell.sounds.note-compliance':
    'Les signaux d’enregistrement et de sécurité restent actifs dans Kodera même en mode Silencieux, sous réserve du volume et des réglages de votre appareil.',
  'console.shell.sounds.warning-not-kept':
    'Ce navigateur ne conserve pas ce réglage : il s’applique jusqu’à la fermeture de l’onglet.',
}

export const SOUNDS_COPY_EN: Record<string, string> = {
  'console.shell.sounds.title': 'Soundscape',
  'console.shell.sounds.subtitle':
    'Choose the sound signature for rooms, calls, and notifications.',
  'console.shell.sounds.label-pack-group': 'Sound signature',
  'console.shell.sounds.label-givre': 'Frost',
  'console.shell.sounds.badge-givre': 'Default',
  'console.shell.sounds.hint-givre':
    'Crystalline clarity softened by felt. The Kodera sound signature.',
  'console.shell.sounds.label-atelier': 'Studio',
  'console.shell.sounds.hint-atelier':
    'Felted strings and gentle mechanics, crafted for long audio room sessions.',
  'console.shell.sounds.label-souffle': 'Breath',
  'console.shell.sounds.hint-souffle':
    'Silky laminar air and matte ceramic, designed for quiet workspaces.',
  'console.shell.sounds.label-cosmos': 'Cosmos',
  'console.shell.sounds.hint-cosmos':
    'Ondes Martenot ribbon glide, liquid analog filter, and French Touch warmth.',
  'console.shell.sounds.label-luciole': 'Firefly',
  'console.shell.sounds.hint-luciole':
    'Physical water droplets, calabash kora strings, and living bamboo.',
  'console.shell.sounds.label-silencieux': 'Silent',
  'console.shell.sounds.hint-silencieux':
    'Turns off interface sounds except recording, safety, and incoming call signals.',
  'console.shell.sounds.action-preview': 'Preview',
  'console.shell.sounds.action-preview-pack': 'Preview {pack}',
  'console.shell.sounds.status-preview-playing': 'Playing sound preview: {pack}.',
  'console.shell.sounds.status-speaker-test': 'Playing Left, Right, and Center stereo test.',
  'console.shell.sounds.label-master-mode': 'Sound mode',
  'console.shell.sounds.mode-on': 'All sounds',
  'console.shell.sounds.mode-essential': 'Essential only',
  'console.shell.sounds.mode-off': 'Off',
  'console.shell.sounds.label-master-volume': 'Master volume',
  'console.shell.sounds.label-categories': 'Sound categories',
  'console.shell.sounds.category-voice': 'Voice rooms and presence',
  'console.shell.sounds.category-calls': 'Calls and ringtones',
  'console.shell.sounds.category-messages': 'Mentions and messages',
  'console.shell.sounds.category-workspace': 'Workspace and reminders',
  'console.shell.sounds.label-mention-variant': 'Mention and direct message tone',
  'console.shell.sounds.option-mention-eclat': 'Spark (2 notes · default)',
  'console.shell.sounds.option-mention-goutte': 'Droplet (1 note · focused)',
  'console.shell.sounds.option-mention-sillage': 'Wake (3 notes · expressive)',
  'console.shell.sounds.label-vip': 'Enrich priority contacts and channels',
  'console.shell.sounds.label-self-only': 'My actions only in voice rooms',
  'console.shell.sounds.label-softened': 'Softened sounds (attenuated high frequencies)',
  'console.shell.sounds.action-speaker-test': 'Test Left / Right',
  'console.shell.sounds.note-compliance':
    'Recording and safety signals remain active in Kodera even in Silent mode, subject to your device volume and system settings.',
  'console.shell.sounds.warning-not-kept':
    'This browser does not save this setting: it applies until the tab closes.',
}

export interface SoundCopyTranslator {
  readonly language?: string | undefined
  readonly resolvedLanguage?: string | undefined
  exists(key: string): boolean
  t: (...args: never[]) => unknown
}

export function translateSoundCopy(
  i18n: SoundCopyTranslator,
  key: string,
  vars?: Record<string, string>
): string {
  if (i18n.exists(key)) {
    const fn = i18n.t as unknown as (k: string, v?: Record<string, string>) => unknown
    return String(vars === undefined ? fn(key) : fn(key, vars))
  }
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'fr'
  const locale: 'fr' | 'en' = lang.startsWith('en') ? 'en' : 'fr'
  const table = locale === 'en' ? SOUNDS_COPY_EN : SOUNDS_COPY_FR
  let template = table[key] ?? SOUNDS_COPY_FR[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replace(`{${k}}`, v).replace(`{{${k}}}`, v)
    }
  }
  return template
}
