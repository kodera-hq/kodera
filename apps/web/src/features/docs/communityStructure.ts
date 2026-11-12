/** Shared display blueprint. Local demo metadata never grants real room access. */
export const COMMUNITY_CATEGORIES = [
  {
    id: 'community',
    name: 'Community',
    audience: 'audiencePublic',
    channels: [
      { id: 'announcements', name: 'announcements', description: 'releases', voice: false },
      {
        id: 'developers-community',
        name: 'developers-community',
        description: 'developers',
        voice: false,
      },
      { id: 'support', name: 'support', description: 'support', voice: false },
      { id: 'extensions', name: 'extensions', description: 'extensions', voice: false },
      { id: 'self-hosting', name: 'self-hosting', description: 'selfHost', voice: false },
      { id: 'show-and-tell', name: 'show-and-tell', description: 'showTell', voice: false },
      { id: 'office-hours', name: 'office-hours', description: 'office', voice: true },
    ],
  },
  {
    id: 'core-kodera',
    name: 'Core Kodera',
    audience: 'audienceCore',
    channels: [
      { id: 'dev', name: 'dev', description: 'engineering', voice: false },
      { id: 'strategy', name: 'strategy', description: 'strategy', voice: false },
      { id: 'ops-oncall', name: 'ops-oncall', description: 'operations', voice: false },
    ],
  },
  {
    id: 'design-partners',
    name: 'Design Partners',
    audience: 'audiencePartners',
    channels: [
      {
        id: 'partner-onboarding',
        name: 'partner-onboarding',
        description: 'partnerOnboarding',
        voice: false,
      },
      {
        id: 'partner-feedback',
        name: 'partner-feedback',
        description: 'partnerFeedback',
        voice: false,
      },
    ],
  },
] as const

export const COMMUNITY_CHANNELS = [
  ...COMMUNITY_CATEGORIES[0].channels,
  ...COMMUNITY_CATEGORIES[1].channels,
  ...COMMUNITY_CATEGORIES[2].channels,
] as const
export type CommunityChannelId = (typeof COMMUNITY_CHANNELS)[number]['id']
