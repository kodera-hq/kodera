// The proximity template's one default channel, from the claim to its label.
//
// Core answers a claim of the `proximity` template with one channel, `{ name: "proximity", kind:
// "text" }`, whose row key is `proximity`. The client's own table (`TEMPLATE_CHANNELS`), the local
// claim and the demo workspace built from it must say the same and nothing more: a second channel
// is one its members add afterwards, through the ordinary creation and invitation screens
// (`tests/e2e/core-workspace-journey.spec.ts` walks that).
//
// The label is « proximité » in French and « proximity » in English. It is a label only: it is
// read from the row key the template gave, never from the name, and the name is never translated.

import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { TEMPLATE_CHANNELS, localClaim, type InstantClaimPayload } from './instantClaimClient'
import { channelLabel } from '../workspace/workspace'
import {
  localWorkspace,
  registerLocalWorkspace,
  resetLocalWorkspaces,
} from '../../mocks/demo/localWorkspaces'

const base: InstantClaimPayload = {
  organizationName: 'Field Team',
  slug: 'field-team',
  hostingMode: 'cloud',
  templateId: 'proximity',
  themeId: 'givre',
  soundPackId: 'silence',
  enabledConnectors: [],
}

/** Every channel of the workspace the demo builds for a claim, as the sidebar would list them. */
function demoChannels(payload: InstantClaimPayload) {
  const claim = localClaim(payload)
  registerLocalWorkspace(claim)
  const workspace = localWorkspace(claim)
  return [
    ...workspace.categories.flatMap((category) => category.channels),
    ...workspace.uncategorised_channels,
  ]
}

afterEach(() => resetLocalWorkspaces())

describe('the proximity template starts with one channel', () => {
  it('lists exactly `proximity`, under the canonical identifier and under its alias', () => {
    expect(TEMPLATE_CHANNELS.proximity).toEqual(['proximity'])
    expect(TEMPLATE_CHANNELS['crisis-cell']).toEqual(['proximity'])
  })

  it('claims one text channel named `proximity`, as the server answers', () => {
    expect(localClaim(base).channels).toEqual([
      { id: 'local-proximity', name: 'proximity', kind: 'text' },
    ])
  })

  it('builds a demo workspace with that one channel, carrying the template row key', () => {
    const channels = demoChannels(base)
    expect(channels.map(({ name, kind, template_key }) => ({ name, kind, template_key }))).toEqual([
      { name: 'proximity', kind: 'text', template_key: 'proximity' },
    ])
  })

  it('gives the row key to no channel of another template', () => {
    const channels = demoChannels({ ...base, slug: 'tech-team', templateId: 'tech-studio' })
    expect(channels.length).toBeGreaterThan(1)
    expect(channels.map((channel) => channel.template_key)).toEqual(channels.map(() => null))
  })
})

describe('the channel is labelled « proximité », a label only', () => {
  const [channel] = (() => {
    const claim = localClaim(base)
    registerLocalWorkspace(claim)
    const workspace = localWorkspace(claim)
    resetLocalWorkspaces()
    return workspace.categories[0]!.channels
  })()

  it('reads « proximité » in French and « proximity » in English from the row key', () => {
    expect(channelLabel(channel!, i18n.getFixedT('fr'))).toBe('proximité')
    expect(channelLabel(channel!, i18n.getFixedT('en'))).toBe('proximity')
    // The identifier is untouched by the label, in either language.
    expect(channel!.name).toBe('proximity')
  })

  it('leaves a channel a member named « proximity » under its own name', () => {
    const own = { ...channel!, id: 'local-own', template_key: null }
    expect(channelLabel(own, i18n.getFixedT('fr'))).toBe('proximity')
    const second = { ...own, name: 'proximity-north' }
    expect(channelLabel(second, i18n.getFixedT('fr'))).toBe('proximity-north')
  })
})
