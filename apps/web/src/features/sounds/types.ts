export type AcousticPackId = 'givre' | 'atelier' | 'souffle' | 'cosmos' | 'luciole'

export type SoundPackId = AcousticPackId | 'silencieux'

export type SoundCategory = 'voice' | 'calls' | 'messages' | 'workspace'

export type BlueprintCueCategory =
  | 'control'
  | 'presence'
  | 'peer'
  | 'compliance'
  | 'notify'
  | 'ring'
  | 'network'
  | 'diagnostic'

export type SoundTier = 0 | 1 | 2 | 3

export type MasterSoundMode = 'on' | 'essential' | 'off'

export type UserPresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible'

export type MentionVariantId = 'eclat' | 'goutte' | 'sillage'

export type CanonicalCueSlug =
  | 'call-mute'
  | 'call-unmute'
  | 'call-deafen'
  | 'call-undeafen'
  | 'room-self-join'
  | 'room-self-leave'
  | 'room-listen-only'
  | 'room-peer-join'
  | 'room-peer-leave'
  | 'visio-guest-knock'
  | 'call-hand-raise'
  | 'call-share-start'
  | 'call-share-stop'
  | 'compliance-rec-start'
  | 'compliance-rec-stop'
  | 'msg-mention-eclat'
  | 'msg-mention-eclat-vip'
  | 'msg-mention-goutte'
  | 'msg-mention-goutte-vip'
  | 'msg-mention-sillage'
  | 'msg-mention-sillage-vip'
  | 'msg-thread-reply'
  | 'agenda-reminder'
  | 'call-ringtone-in'
  | 'call-ringback-out'
  | 'system-priority-alert'
  | 'call-reconnecting'
  | 'call-restored'
  | 'compliance-revoked'
  | 'settings-speaker-test'
  | 'msg-send-failed'

export type SemanticTriggerId =
  | 'voice_self_join'
  | 'voice_self_leave'
  | 'voice_listen_only'
  | 'voice_mute_on'
  | 'voice_mute_off'
  | 'voice_deafen_on'
  | 'voice_deafen_off'
  | 'voice_ptt_engage'
  | 'voice_ptt_release'
  | 'voice_permission_denied'
  | 'voice_peer_join'
  | 'voice_peer_leave'
  | 'voice_guest_knock'
  | 'voice_hand_raise'
  | 'voice_share_start'
  | 'voice_share_stop'
  | 'compliance_rec_start'
  | 'compliance_rec_stop'
  | 'call_ring_incoming_loop'
  | 'call_ring_outgoing_loop'
  | 'call_connect'
  | 'call_end'
  | 'call_reconnecting_pulse'
  | 'call_restored'
  | 'msg_mention'
  | 'msg_dm'
  | 'msg_thread_reply'
  | 'msg_send_failed'
  | 'msg_channel_unread'
  | 'workspace_agenda_reminder'
  | 'workspace_priority_alert'
  | 'workspace_speaker_test'

export type SoundTriggerInput =
  | SemanticTriggerId
  | CanonicalCueSlug
  | `semantic.sound.${string}`
  | 'ptt_engage'
  | 'ptt_release'

export interface SoundPackDescriptor {
  readonly id: SoundPackId
  readonly order: number
  readonly isDefault: boolean
  readonly labelKey: string
  readonly hintKey: string
  readonly badgeKey?: string
  readonly previewTrigger: SemanticTriggerId
}

export interface CueSynthSpec {
  readonly slug: string
  readonly semantic: string | null
  readonly description: string
  readonly tier: SoundTier
  readonly category: SoundCategory
  readonly blueprintCategory: BlueprintCueCategory
  readonly nonMutable: boolean
  readonly toggle?: boolean
  readonly knock?: boolean
  readonly hollow?: boolean
  readonly stereoTest?: boolean
  readonly isMention?: boolean
  readonly variant?: MentionVariantId
  readonly vip?: boolean
  readonly lufs: number
  readonly notes?: readonly number[]
  readonly extraNote?: {
    readonly f0: number
    readonly onset: number
    readonly gain: number
  }
  readonly onsets?: readonly number[]
  readonly dur: number
  readonly atk: number
  readonly cobaltHz: number | null
  readonly cobaltTrim?: number
  readonly damper?: boolean
  readonly lpSweep?: readonly [number, number]
  readonly durationMs: number
  readonly cooldownMs: number
  readonly loopIntervalMs?: number
  readonly defaultPan?: number
}

export interface SoundCategoryPreferences {
  voice: boolean
  calls: boolean
  messages: boolean
  workspace: boolean
}

export interface SoundPreferences {
  pack: SoundPackId
  masterMode: MasterSoundMode
  masterVolume: number
  categories: SoundCategoryPreferences
  mentionVariant: MentionVariantId
  vipEnriched: boolean
  selfActionsOnly: boolean
  softenedHighs: boolean
  outputDeviceId: string | null
}

export interface SoundPlaybackContext {
  userStatus?: UserPresenceStatus
  activeVoiceCall?: boolean
  participantCount?: number
  senderId?: string
  currentUserId?: string
  channelId?: string
  roomId?: string
  isVip?: boolean
  pan?: number
  forcePreview?: boolean
  packOverride?: SoundPackId
  deafened?: boolean
  quietHours?: boolean
}

export type SuppressionReason =
  | 'none'
  | 'master-off'
  | 'pack-silencieux'
  | 'zero-volume'
  | 'dnd'
  | 'essential-mode'
  | 'category-disabled'
  | 'active-call-suppressed'
  | 'document-hidden'
  | 'self-actions-only'
  | 'deafened'
  | 'quiet-hours'
  | 'crowd-limit'
  | 'peer-burst-coalesced'
  | 'mention-cooldown'
  | 'self-message'
  | 'unknown-trigger'
  | 'audio-unavailable'

export interface SoundDecision {
  readonly allowed: boolean
  readonly reason: SuppressionReason
  readonly effectivePack: AcousticPackId
  readonly cueSlug: string
  readonly triggerId: SemanticTriggerId
  readonly category: SoundCategory
  readonly tier: SoundTier
  readonly gain: number
  readonly pan: number
  readonly ducked: boolean
  readonly durationMs: number
  readonly loopIntervalMs: number | null
}
