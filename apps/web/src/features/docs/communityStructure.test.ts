import { expect, it } from 'vitest'
import { COMMUNITY_CATEGORIES, COMMUNITY_CHANNELS } from './communityStructure'

it('preserves canonical category and channel ordering, including arrivals after general', () => {
  expect(
    COMMUNITY_CATEGORIES.map(({ id, name, channels }) => [id, name, channels.map((c) => c.id)])
  ).toEqual([
    [
      'community',
      'Community',
      [
        'announcements',
        'general',
        'arrivals',
        'developers-community',
        'support',
        'extensions',
        'self-hosting',
        'show-and-tell',
        'office-hours',
      ],
    ],
    ['core-kodera', 'Core Kodera', ['dev', 'strategy', 'ops-oncall', 'kodera-git-tracker']],
    ['design-partners', 'Design Partners', ['partner-onboarding', 'partner-feedback']],
  ])
  expect(COMMUNITY_CHANNELS).toHaveLength(15)
  expect(new Set(COMMUNITY_CHANNELS.map((c) => c.id)).size).toBe(15)
  expect(COMMUNITY_CHANNELS.every((c) => c.name === c.id)).toBe(true)
  expect(COMMUNITY_CHANNELS.filter((c) => c.voice).map((c) => c.id)).toEqual(['office-hours'])
})
