import { describe, expect, it } from 'vitest'
import {
  classifyConversationEncryptionTier,
  defaultE2eeForConversationSurface,
  shouldDisplayConfidentialPadlock,
} from './encryptionTiers'

describe('Founder-locked 3-tier E2EE conversation model (Track 7)', () => {
  it('Tier 1: enables E2EE by default on 1:1 DMs, private group DMs, and private calls', () => {
    expect(defaultE2eeForConversationSurface('direct_message')).toBe(true)
    expect(defaultE2eeForConversationSurface('private_group_dm')).toBe(true)
    expect(defaultE2eeForConversationSurface('private_call')).toBe(true)

    expect(classifyConversationEncryptionTier({ surface: 'direct_message' })).toBe(
      'tier-1-default-e2ee'
    )
    expect(classifyConversationEncryptionTier({ surface: 'private_group_dm' })).toBe(
      'tier-1-default-e2ee'
    )
    expect(classifyConversationEncryptionTier({ surface: 'private_call' })).toBe(
      'tier-1-default-e2ee'
    )
  })

  it('Tier 2: keeps workspace/team channels opt-in confidential (🔒)', () => {
    expect(defaultE2eeForConversationSurface('team_channel')).toBe(false)
    expect(
      classifyConversationEncryptionTier({ surface: 'team_channel', isConfidential: false })
    ).toBe('tier-3-standard-channel')
    expect(
      classifyConversationEncryptionTier({ surface: 'team_channel', isConfidential: true })
    ).toBe('tier-2-opt-in-confidential')
    expect(shouldDisplayConfidentialPadlock({ isConfidential: true })).toBe(true)
  })

  it('Tier 3: keeps standard/public channels (#arrivals, #general) standard with zero fake E2EE padlock', () => {
    expect(defaultE2eeForConversationSurface('public_channel')).toBe(false)
    expect(classifyConversationEncryptionTier({ surface: 'public_channel' })).toBe(
      'tier-3-standard-channel'
    )
    expect(
      shouldDisplayConfidentialPadlock({
        isDirect: false,
        isConfidential: false,
        isVerifiedE2eeSession: false,
      })
    ).toBe(false)
    expect(
      shouldDisplayConfidentialPadlock({
        isDirect: true,
        isConfidential: false,
        isVerifiedE2eeSession: false,
      })
    ).toBe(false)
    expect(
      shouldDisplayConfidentialPadlock({
        isDirect: true,
        isConfidential: false,
        isVerifiedE2eeSession: true,
      })
    ).toBe(true)
  })
})
