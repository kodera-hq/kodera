import {
  ACOUSTIC_PACK_IDS,
  CROWD_ATTENUATED_GAIN,
  CROWD_ATTENUATED_MAX,
  CROWD_FULL_MAX,
  DEFAULT_SOUND_PACK,
  MENTION_COOLDOWN_MS,
  MENTION_VARIANT_IDS,
  PEER_BURST_COALESCING_MS,
  SILENCIEUX_SAFETY_PACK,
  SOUND_CHANGE_EVENT,
  SOUND_PACK_IDS,
  SOUND_STORAGE_KEY,
  VOICE_CALL_DUCK_GAIN,
  createDefaultSoundPreferences,
  resolveSoundTrigger,
} from './manifest'
import { createCueAudioBuffer } from './synth'
import type {
  AcousticPackId,
  MasterSoundMode,
  MentionVariantId,
  SemanticTriggerId,
  SoundCategory,
  SoundDecision,
  SoundPackId,
  SoundPlaybackContext,
  SoundPreferences,
  SoundTriggerInput,
  UserPresenceStatus,
} from './types'

export interface SinkCapableAudioContext extends BaseAudioContext {
  resume?: () => Promise<void>
  close?: () => Promise<void>
  setSinkId?: (sinkId: string) => Promise<void>
  sinkId?: string
}

export interface SoundEngineOptions {
  audioContextFactory?: () => SinkCapableAudioContext | null
  now?: () => number
  reducedMotionQuery?: () => boolean
  documentHiddenQuery?: () => boolean
}

function queryReducedMotionDefault(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

function queryDocumentHiddenDefault(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(document.hidden || document.visibilityState === 'hidden')
}

function defaultAudioContextFactory(): SinkCapableAudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (typeof Ctor !== 'function') return null
  try {
    return new Ctor() as unknown as SinkCapableAudioContext
  } catch {
    return null
  }
}

function isValidSoundPack(value: unknown): value is SoundPackId {
  return typeof value === 'string' && (SOUND_PACK_IDS as readonly string[]).includes(value)
}

function isValidMasterMode(value: unknown): value is MasterSoundMode {
  return value === 'on' || value === 'essential' || value === 'off'
}

function isValidMentionVariant(value: unknown): value is MentionVariantId {
  return typeof value === 'string' && (MENTION_VARIANT_IDS as readonly string[]).includes(value)
}

function clampVolume(value: unknown, fallback = 0.8): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

interface ActiveLoopHandle {
  readonly triggerId: SemanticTriggerId
  readonly timerId: ReturnType<typeof setInterval>
  activeSource: AudioBufferSourceNode | null
}

export class SoundEngine {
  private preferences: SoundPreferences
  private storageKept = true
  private explicitWorkspaceCategory = false
  private userStatus: UserPresenceStatus = 'online'
  private activeVoiceCall = false
  private participantCount = 1
  private currentUserId: string | null = null
  private audioCtx: SinkCapableAudioContext | null = null
  private readonly bufferCache = new Map<string, AudioBuffer>()
  private readonly lastPeerBurstByRoom = new Map<string, number>()
  private readonly lastMentionByChannel = new Map<string, number>()
  private readonly lastCuePlayedAt = new Map<string, number>()
  private readonly activeLoops = new Map<SemanticTriggerId, ActiveLoopHandle>()
  private readonly listeners = new Set<(prefs: SoundPreferences) => void>()

  private readonly audioContextFactory: () => SinkCapableAudioContext | null
  private readonly now: () => number
  private readonly isReducedMotion: () => boolean
  private readonly isDocumentHidden: () => boolean

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== SOUND_STORAGE_KEY) return
    this.reloadFromStorage()
    this.notifyListeners()
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.isDocumentHidden()) {
      this.stopAllLoops()
    }
  }

  constructor(options: SoundEngineOptions = {}) {
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory
    this.now = options.now ?? (() => Date.now())
    this.isReducedMotion = options.reducedMotionQuery ?? queryReducedMotionDefault
    this.isDocumentHidden = options.documentHiddenQuery ?? queryDocumentHiddenDefault
    this.preferences = this.loadPreferencesFromStorage()

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', this.handleStorageEvent)
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
  }

  private loadPreferencesFromStorage(): SoundPreferences {
    const reduced = this.isReducedMotion()
    const defaults = createDefaultSoundPreferences(reduced)
    this.explicitWorkspaceCategory = false

    if (typeof localStorage === 'undefined') {
      return defaults
    }

    try {
      const raw = localStorage.getItem(SOUND_STORAGE_KEY)
      this.storageKept = true
      if (!raw) return defaults
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') return defaults

      const rawCategories =
        parsed.categories && typeof parsed.categories === 'object'
          ? (parsed.categories as Record<string, unknown>)
          : {}

      const hasExplicitWorkspace = typeof rawCategories.workspace === 'boolean'
      this.explicitWorkspaceCategory = hasExplicitWorkspace

      const pack: SoundPackId = isValidSoundPack(parsed.pack) ? parsed.pack : DEFAULT_SOUND_PACK
      const masterMode: MasterSoundMode = isValidMasterMode(parsed.masterMode)
        ? parsed.masterMode
        : pack === 'silencieux'
          ? 'off'
          : 'on'

      return {
        pack,
        masterMode,
        masterVolume: clampVolume(parsed.masterVolume, defaults.masterVolume),
        categories: {
          voice: typeof rawCategories.voice === 'boolean' ? rawCategories.voice : defaults.categories.voice,
          calls: typeof rawCategories.calls === 'boolean' ? rawCategories.calls : defaults.categories.calls,
          messages:
            typeof rawCategories.messages === 'boolean'
              ? rawCategories.messages
              : defaults.categories.messages,
          workspace: hasExplicitWorkspace ? Boolean(rawCategories.workspace) : !reduced,
        },
        mentionVariant: isValidMentionVariant(parsed.mentionVariant)
          ? parsed.mentionVariant
          : defaults.mentionVariant,
        vipEnriched:
          typeof parsed.vipEnriched === 'boolean' ? parsed.vipEnriched : defaults.vipEnriched,
        selfActionsOnly:
          typeof parsed.selfActionsOnly === 'boolean'
            ? parsed.selfActionsOnly
            : defaults.selfActionsOnly,
        softenedHighs:
          typeof parsed.softenedHighs === 'boolean' ? parsed.softenedHighs : defaults.softenedHighs,
        outputDeviceId:
          typeof parsed.outputDeviceId === 'string' && parsed.outputDeviceId.trim() !== ''
            ? parsed.outputDeviceId
            : null,
      }
    } catch {
      this.storageKept = false
      return defaults
    }
  }

  private persistPreferences(): boolean {
    if (typeof localStorage === 'undefined') {
      this.storageKept = false
      return false
    }
    try {
      const payload = {
        ...this.preferences,
        categories: {
          ...this.preferences.categories,
        },
      }
      localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(payload))
      this.storageKept = true
    } catch {
      this.storageKept = false
    }
    this.notifyListeners()
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent(SOUND_CHANGE_EVENT, { detail: this.getPreferences() })
      )
    }
    return this.storageKept
  }

  private notifyListeners(): void {
    const snap = this.getPreferences()
    for (const listener of this.listeners) {
      listener(snap)
    }
  }

  public reloadFromStorage(): SoundPreferences {
    this.preferences = this.loadPreferencesFromStorage()
    return this.getPreferences()
  }

  public isPreferenceKept(): boolean {
    if (typeof localStorage === 'undefined') return false
    try {
      void localStorage.getItem(SOUND_STORAGE_KEY)
      return this.storageKept
    } catch {
      this.storageKept = false
      return false
    }
  }

  public getPreferences(): SoundPreferences {
    const reduced = this.isReducedMotion()
    return {
      ...this.preferences,
      categories: {
        ...this.preferences.categories,
        workspace: this.explicitWorkspaceCategory
          ? this.preferences.categories.workspace
          : reduced
            ? false
            : this.preferences.categories.workspace,
      },
    }
  }

  public updatePreferences(partial: Partial<SoundPreferences>): boolean {
    const next: SoundPreferences = {
      ...this.preferences,
      ...partial,
      categories: {
        ...this.preferences.categories,
        ...(partial.categories ?? {}),
      },
    }

    if (partial.categories && typeof partial.categories.workspace === 'boolean') {
      this.explicitWorkspaceCategory = true
    }

    if (partial.pack === 'silencieux' && partial.masterMode === undefined) {
      next.masterMode = 'off'
    } else if (
      partial.pack !== undefined &&
      partial.pack !== 'silencieux' &&
      this.preferences.pack === 'silencieux' &&
      partial.masterMode === undefined &&
      this.preferences.masterMode === 'off'
    ) {
      next.masterMode = 'on'
    }

    if (partial.masterVolume !== undefined) {
      next.masterVolume = clampVolume(partial.masterVolume, this.preferences.masterVolume)
    }

    this.preferences = next
    if (next.masterMode === 'off' || next.pack === 'silencieux') {
      this.stopAllLoops()
    }
    return this.persistPreferences()
  }

  public setPack(pack: SoundPackId): boolean {
    if (!isValidSoundPack(pack)) return this.storageKept
    return this.updatePreferences({ pack })
  }

  public setMasterMode(masterMode: MasterSoundMode): boolean {
    if (!isValidMasterMode(masterMode)) return this.storageKept
    return this.updatePreferences({ masterMode })
  }

  public setMasterVolume(masterVolume: number): boolean {
    return this.updatePreferences({ masterVolume: clampVolume(masterVolume, 0.8) })
  }

  public setCategoryEnabled(category: SoundCategory, enabled: boolean): boolean {
    if (category === 'workspace') {
      this.explicitWorkspaceCategory = true
    }
    return this.updatePreferences({
      categories: {
        ...this.preferences.categories,
        [category]: Boolean(enabled),
      },
    })
  }

  public setMentionVariant(mentionVariant: MentionVariantId): boolean {
    if (!isValidMentionVariant(mentionVariant)) return this.storageKept
    return this.updatePreferences({ mentionVariant })
  }

  public setUserStatus(status: UserPresenceStatus): void {
    this.userStatus = status
    if (status === 'dnd') {
      this.stopAllLoops()
    }
  }

  public getUserStatus(): UserPresenceStatus {
    return this.userStatus
  }

  public setActiveVoiceCall(active: boolean): void {
    this.activeVoiceCall = Boolean(active)
  }

  public isActiveVoiceCall(): boolean {
    return this.activeVoiceCall
  }

  public setParticipantCount(count: number): void {
    this.participantCount = Math.max(0, Math.floor(count))
  }

  public getParticipantCount(): number {
    return this.participantCount
  }

  public setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId
  }

  public getCurrentUserId(): string | null {
    return this.currentUserId
  }

  public async setOutputDevice(deviceId: string | null): Promise<boolean> {
    const normalized = deviceId && deviceId.trim() !== '' ? deviceId.trim() : null
    this.updatePreferences({ outputDeviceId: normalized })
    const ctx = this.ensureAudioContext()
    if (!ctx || typeof ctx.setSinkId !== 'function') {
      return false
    }
    try {
      await ctx.setSinkId(normalized ?? '')
      return true
    } catch {
      return false
    }
  }

  public subscribe(listener: (prefs: SoundPreferences) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public evaluate(
    trigger: SoundTriggerInput | string,
    context: SoundPlaybackContext = {}
  ): SoundDecision {
    const prefs = this.getPreferences()
    const isVip = context.isVip ?? prefs.vipEnriched
    const resolved = resolveSoundTrigger(trigger, prefs.mentionVariant, isVip)

    if (!resolved) {
      return {
        allowed: false,
        reason: 'unknown-trigger',
        effectivePack: 'givre',
        cueSlug: 'room-self-join',
        triggerId: 'voice_self_join',
        category: 'voice',
        tier: 2,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: 0,
        loopIntervalMs: null,
      }
    }

    const { triggerId, cue } = resolved
    const reducedMotion = this.isReducedMotion()
    const chosenPack = context.packOverride ?? prefs.pack
    const effectivePack: AcousticPackId =
      chosenPack === 'silencieux'
        ? SILENCIEUX_SAFETY_PACK
        : ACOUSTIC_PACK_IDS.includes(chosenPack as AcousticPackId)
          ? (chosenPack as AcousticPackId)
          : 'givre'

    const basePan = reducedMotion
      ? 0
      : Math.max(-1, Math.min(1, context.pan ?? cue.defaultPan ?? 0))

    // Explicit settings preview or speaker test click
    if (context.forcePreview) {
      if (chosenPack === 'silencieux' && triggerId !== 'workspace_speaker_test') {
        return {
          allowed: false,
          reason: 'pack-silencieux',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }
      const previewGain = prefs.masterVolume > 0 ? prefs.masterVolume : 0.25
      return {
        allowed: true,
        reason: 'none',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: previewGain,
        pan: basePan,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 1. Silencieux pack / masterMode === 'off'
    if (chosenPack === 'silencieux') {
      return {
        allowed: false,
        reason: 'pack-silencieux',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    if (prefs.masterMode === 'off') {
      return {
        allowed: false,
        reason: 'master-off',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 2. Master volume 0
    if (prefs.masterVolume <= 0) {
      return {
        allowed: false,
        reason: 'zero-volume',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 3. Self-message anti-echo (senderId === currentUserId never triggers msg_*)
    const senderId = context.senderId
    const currentUserId = context.currentUserId ?? this.currentUserId
    const isMessageTrigger =
      cue.category === 'messages' ||
      triggerId.startsWith('msg_') ||
      cue.slug.startsWith('msg-')
    if (isMessageTrigger && senderId && currentUserId && senderId === currentUserId) {
      return {
        allowed: false,
        reason: 'self-message',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 4. User status === 'dnd' -> only Tier 0 allowed
    const effStatus = context.userStatus ?? this.userStatus
    if (effStatus === 'dnd' && cue.tier !== 0) {
      return {
        allowed: false,
        reason: 'dnd',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 5. masterMode === 'essential' -> only Tier 0 and Tier 1 allowed
    if (prefs.masterMode === 'essential' && cue.tier > 1) {
      return {
        allowed: false,
        reason: 'essential-mode',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 6. Category toggle check
    if (!prefs.categories[cue.category]) {
      return {
        allowed: false,
        reason: 'category-disabled',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 7. document.hidden && category === 'workspace' -> suppressed
    if (this.isDocumentHidden() && cue.category === 'workspace') {
      return {
        allowed: false,
        reason: 'document-hidden',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 8. Deafened state check
    if (
      context.deafened &&
      triggerId !== 'voice_deafen_on' &&
      triggerId !== 'voice_deafen_off' &&
      triggerId !== 'voice_self_leave' &&
      triggerId !== 'call_end' &&
      triggerId !== 'voice_permission_denied'
    ) {
      return {
        allowed: false,
        reason: 'deafened',
        effectivePack,
        cueSlug: cue.slug,
        triggerId,
        category: cue.category,
        tier: cue.tier,
        gain: 0,
        pan: 0,
        ducked: false,
        durationMs: cue.durationMs,
        loopIntervalMs: cue.loopIntervalMs ?? null,
      }
    }

    // 9. Active voice call ducking (-6 dB on Tier 2) and suppression (Tier 3)
    const inVoiceCall = context.activeVoiceCall ?? this.activeVoiceCall
    let gain = prefs.masterVolume
    let ducked = false

    if (inVoiceCall) {
      if (cue.tier === 3) {
        return {
          allowed: false,
          reason: 'active-call-suppressed',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }
      if (cue.tier === 2) {
        gain *= VOICE_CALL_DUCK_GAIN
        ducked = true
      }
    }

    // 10. Peer presence discipline: selfActionsOnly, crowd scaling (1..4 0 dB, 5..8 -3 dB, >= 9 silent), and 2500 ms burst coalescing
    const isPeerPresence =
      triggerId === 'voice_peer_join' || triggerId === 'voice_peer_leave'
    if (isPeerPresence) {
      if (prefs.selfActionsOnly) {
        return {
          allowed: false,
          reason: 'self-actions-only',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }

      const participants = context.participantCount ?? this.participantCount
      if (participants > CROWD_ATTENUATED_MAX) {
        return {
          allowed: false,
          reason: 'crowd-limit',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }

      if (participants > CROWD_FULL_MAX) {
        gain *= CROWD_ATTENUATED_GAIN
      }

      const roomKey = context.roomId ?? 'default'
      const lastBurst = this.lastPeerBurstByRoom.get(roomKey)
      const now = this.now()
      if (lastBurst !== undefined && now - lastBurst < PEER_BURST_COALESCING_MS) {
        return {
          allowed: false,
          reason: 'peer-burst-coalesced',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }
    }

    // 11. Mention 3000 ms per-channel cooldown
    const isMentionTrigger =
      triggerId === 'msg_mention' || triggerId === 'msg_dm' || Boolean(cue.isMention)
    if (isMentionTrigger) {
      const channelKey = context.channelId ?? 'default'
      const lastMention = this.lastMentionByChannel.get(channelKey)
      const now = this.now()
      if (lastMention !== undefined && now - lastMention < MENTION_COOLDOWN_MS) {
        return {
          allowed: false,
          reason: 'mention-cooldown',
          effectivePack,
          cueSlug: cue.slug,
          triggerId,
          category: cue.category,
          tier: cue.tier,
          gain: 0,
          pan: 0,
          ducked: false,
          durationMs: cue.durationMs,
          loopIntervalMs: cue.loopIntervalMs ?? null,
        }
      }
    }

    return {
      allowed: true,
      reason: 'none',
      effectivePack,
      cueSlug: cue.slug,
      triggerId,
      category: cue.category,
      tier: cue.tier,
      gain: Number(gain.toFixed(6)),
      pan: basePan,
      ducked,
      durationMs: cue.durationMs,
      loopIntervalMs: cue.loopIntervalMs ?? null,
    }
  }

  /**
   * Non-blocking fire-and-forget playback.
   * Never delays or blocks mute/deafen/leave actions.
   */
  public play(
    trigger: SoundTriggerInput | string,
    context: SoundPlaybackContext = {}
  ): SoundDecision {
    const resolved = resolveSoundTrigger(trigger)
    if (
      resolved &&
      (resolved.triggerId === 'call_end' || resolved.triggerId === 'voice_self_leave')
    ) {
      this.stopAllLoops()
    }

    const decision = this.evaluate(trigger, context)
    if (!decision.allowed) {
      return decision
    }

    const now = this.now()
    if (
      decision.triggerId === 'voice_peer_join' ||
      decision.triggerId === 'voice_peer_leave'
    ) {
      this.lastPeerBurstByRoom.set(context.roomId ?? 'default', now)
    }
    if (
      decision.triggerId === 'msg_mention' ||
      decision.triggerId === 'msg_dm' ||
      decision.cueSlug.startsWith('msg-mention-')
    ) {
      this.lastMentionByChannel.set(context.channelId ?? 'default', now)
    }
    this.lastCuePlayedAt.set(decision.triggerId, now)

    this.dispatchWebAudio(decision)
    return decision
  }

  public previewPack(pack: SoundPackId): SoundDecision {
    return this.play('voice_self_join', {
      forcePreview: true,
      packOverride: pack,
    })
  }

  public playSpeakerTest(): SoundDecision {
    return this.play('workspace_speaker_test', {
      forcePreview: true,
    })
  }

  public startLoop(
    trigger: SoundTriggerInput | string,
    context: SoundPlaybackContext = {}
  ): boolean {
    const decision = this.evaluate(trigger, context)
    if (!decision.allowed) {
      return false
    }

    this.stopLoop(decision.triggerId)
    this.play(trigger, context)

    const intervalMs = decision.loopIntervalMs ?? 3000
    const timerId = setInterval(() => {
      if (this.isDocumentHidden()) {
        this.stopLoop(decision.triggerId)
        return
      }
      const nextDecision = this.evaluate(trigger, context)
      if (!nextDecision.allowed) {
        this.stopLoop(decision.triggerId)
        return
      }
      this.dispatchWebAudio(nextDecision)
    }, intervalMs)

    this.activeLoops.set(decision.triggerId, {
      triggerId: decision.triggerId,
      timerId,
      activeSource: null,
    })
    return true
  }

  public stopLoop(trigger?: SoundTriggerInput | string): void {
    if (trigger === undefined) {
      this.stopAllLoops()
      return
    }
    const resolved = resolveSoundTrigger(trigger)
    const key = resolved?.triggerId ?? (trigger as SemanticTriggerId)
    const handle = this.activeLoops.get(key)
    if (!handle) return
    clearInterval(handle.timerId)
    try {
      handle.activeSource?.stop()
    } catch {
      // Ignore already-stopped source nodes
    }
    this.activeLoops.delete(key)
  }

  public stopAllLoops(): void {
    for (const handle of this.activeLoops.values()) {
      clearInterval(handle.timerId)
      try {
        handle.activeSource?.stop()
      } catch {
        // Ignore already-stopped source nodes
      }
    }
    this.activeLoops.clear()
  }

  public isLoopActive(trigger?: SoundTriggerInput | string): boolean {
    if (trigger === undefined) {
      return this.activeLoops.size > 0
    }
    const resolved = resolveSoundTrigger(trigger)
    const key = resolved?.triggerId ?? (trigger as SemanticTriggerId)
    return this.activeLoops.has(key)
  }

  public resetCooldowns(): void {
    this.lastPeerBurstByRoom.clear()
    this.lastMentionByChannel.clear()
    this.lastCuePlayedAt.clear()
  }

  public destroy(): void {
    this.stopAllLoops()
    this.listeners.clear()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('storage', this.handleStorageEvent)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
  }

  private ensureAudioContext(): SinkCapableAudioContext | null {
    if (this.audioCtx) return this.audioCtx
    this.audioCtx = this.audioContextFactory()
    if (
      this.audioCtx &&
      this.preferences.outputDeviceId &&
      typeof this.audioCtx.setSinkId === 'function'
    ) {
      void this.audioCtx.setSinkId(this.preferences.outputDeviceId).catch(() => {})
    }
    return this.audioCtx
  }

  private dispatchWebAudio(decision: SoundDecision): void {
    try {
      const ctx = this.ensureAudioContext()
      if (!ctx) return
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        void ctx.resume().catch(() => {})
      }

      const prefs = this.getPreferences()
      const cacheKey = `${decision.effectivePack}:${decision.cueSlug}:${prefs.softenedHighs ? 'soft' : 'std'}`
      let buffer = this.bufferCache.get(cacheKey)
      if (!buffer) {
        buffer = createCueAudioBuffer(ctx, decision.effectivePack, decision.cueSlug, {
          softenedHighs: prefs.softenedHighs,
          mentionVariant: prefs.mentionVariant,
          vip: prefs.vipEnriched,
        })
        this.bufferCache.set(cacheKey, buffer)
      }

      const source = ctx.createBufferSource()
      source.buffer = buffer

      const gainNode = ctx.createGain()
      gainNode.gain.value = decision.gain

      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner()
        panner.pan.value = decision.pan
        source.connect(gainNode)
        gainNode.connect(panner)
        panner.connect(ctx.destination)
      } else {
        source.connect(gainNode)
        gainNode.connect(ctx.destination)
      }

      const loopHandle = this.activeLoops.get(decision.triggerId)
      if (loopHandle) {
        loopHandle.activeSource = source
      }

      source.start(0)
    } catch {
      // Never propagate WebAudio errors into caller flows
    }
  }
}

export const soundEngine = new SoundEngine()
