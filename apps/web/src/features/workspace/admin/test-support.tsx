// Test-only fixtures for the administration panels. Imported by tests only.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { WorkspaceRole } from '../iamApi'
import { ROLE_SWATCHES } from './WorkspaceProfilePanel'

/** A role colour from the design tokens: tests never write a colour of their own. */
export const SWATCH = ROLE_SWATCHES[0] ?? ''

export const ORG = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'

export function renderPanel(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) }
}

export function role(overrides: Partial<WorkspaceRole> & Pick<WorkspaceRole, 'id' | 'name'>) {
  return {
    slug: overrides.name.toLowerCase(),
    kind: 'role',
    color: SWATCH,
    icon: '',
    position: 1,
    is_hoisted: false,
    is_mentionable: false,
    permissions: [],
    member_count: 0,
    etag: `"${overrides.id}"`,
    ...overrides,
  } satisfies WorkspaceRole
}

export const OWNER = { owner: true, ceiling: -1, held: new Set<never>() }

export const WORKSPACE = {
  workspace: {
    organisation_id: ORG,
    id: 'w1',
    state: 'initialised',
    can_initialise: false,
    setup: {},
    categories: [
      {
        id: 'cat',
        name: 'Général',
        template_key: null,
        channels: [
          {
            id: 'c-arrivees',
            kind: 'text',
            name: 'arrivées',
            template_key: null,
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
          {
            id: 'c-general',
            kind: 'text',
            name: 'général',
            template_key: null,
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
          {
            id: 'c-salon',
            kind: 'audio',
            name: 'salon',
            template_key: null,
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
        ],
      },
    ],
    uncategorised_channels: [],
  },
  requestId: undefined,
}

export const PROFILE = {
  description: 'Atelier produit',
  banner_preset: 'ink',
  icon_mxc: '',
  traits: [{ icon: '💻', label: 'Tech' }],
  arrivals_channel_id: 'c-arrivees',
  rules_channel_id: null,
  moderator_updates_channel_id: null,
  security_alerts_channel_id: null,
  invites_paused: false,
}
