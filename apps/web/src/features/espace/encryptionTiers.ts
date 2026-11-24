// Founder-locked 3-tier E2EE conversation model (`Track 7`, `H4.3a`):
//
// - Tier 1 (`tier-1-default-e2ee`): `1:1` DMs, private group DMs, and private calls default to
//   end-to-end encryption (`MLS + SFrame + KVKB1 + local search`) at creation (`true`).
// - Tier 2 (`tier-2-opt-in-confidential`): Workspace/team text channels are opt-in confidential
//   (`false` at creation; when opted into `isConfidential = true`, enforce strict Zero-Knowledge,
//   `403` on server AI/Scheduled Messages/Reminders, `KDE1` encrypted Yjs collab, and `SFrame`).
// - Tier 3 (`tier-3-standard-channel`): Standard workspace channels (`#arrivals`, `#general`,
//   public/team channels without confidential opt-in) remain standard by default (`false`) so
//   newcomers retain instant history, connectors, and opt-in AI with zero fake E2EE padlock.

export type ConversationSurfaceKind =
  | 'direct_message'
  | 'private_group_dm'
  | 'private_call'
  | 'team_channel'
  | 'public_channel'

export type ConversationEncryptionTier =
  | 'tier-1-default-e2ee'
  | 'tier-2-opt-in-confidential'
  | 'tier-3-standard-channel'

export function defaultE2eeForConversationSurface(surface: ConversationSurfaceKind): boolean {
  switch (surface) {
    case 'direct_message':
    case 'private_group_dm':
    case 'private_call':
      return true
    case 'team_channel':
    case 'public_channel':
      return false
  }
}

export function classifyConversationEncryptionTier(input: {
  readonly surface: ConversationSurfaceKind
  readonly isConfidential?: boolean | undefined
  readonly encrypted?: boolean | undefined
}): ConversationEncryptionTier {
  if (
    input.surface === 'direct_message' ||
    input.surface === 'private_group_dm' ||
    input.surface === 'private_call'
  ) {
    return input.encrypted === false ? 'tier-3-standard-channel' : 'tier-1-default-e2ee'
  }
  if (input.isConfidential === true) {
    return 'tier-2-opt-in-confidential'
  }
  return 'tier-3-standard-channel'
}

export function shouldDisplayConfidentialPadlock(input: {
  readonly isDirect?: boolean | undefined
  readonly isConfidential?: boolean | undefined
  readonly isVerifiedE2eeSession?: boolean | undefined
}): boolean {
  if (input.isConfidential === true) return true
  if (input.isDirect === true && input.isVerifiedE2eeSession === true) return true
  // Tier 3 standard channels (#arrivals, #general, standard team channels) never render a fake padlock.
  return false
}
