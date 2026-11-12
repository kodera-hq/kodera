// The proximity template's two identifiers (contract 0.42.0, `WorkspaceTemplateId`): `proximity`
// is what this client sends; `crisis-cell`, the identifier before 0.42.0, is a permanent alias,
// read as `proximity` wherever an identifier comes back from: session storage, a link, an older
// peer. The last block drops the alias and requires the check to refuse it by name
// (docs/dev/TESTING.md §« Writing a test that can actually fail »).

import { describe, expect, it, vi } from 'vitest'
import {
  canonicalTemplateId,
  deployTemplateId,
  instantClaimWorkspace,
  localClaim,
  readTemplateId,
  TEMPLATE_ALIASES,
  TEMPLATE_CHANNELS,
  type CanonicalTemplateId,
  type InstantClaimPayload,
  type TemplateId,
} from './instantClaimClient'

const base: InstantClaimPayload = {
  organizationName: 'Atelier',
  slug: 'atelier',
  hostingMode: 'cloud',
  templateId: 'proximity',
  themeId: 'givre',
  soundPackId: 'silence',
  enabledConnectors: [],
}

const assigned = {
  response: { status: 201 },
  data: {
    workspaceId: 'workspace-1',
    workspaceUrl: 'https://atelier.kodera.io',
    invitationUrl: 'https://atelier.kodera.io/invite?signed=1',
    channels: [{ id: 'proximity', name: 'proximity', kind: 'text' }],
    enabledConnectors: [],
  },
}

async function sentFor(templateId: TemplateId) {
  const post = vi.fn().mockResolvedValue(assigned)
  const claimed = await instantClaimWorkspace({ ...base, templateId }, { post })
  const init = post.mock.calls[0]?.[1] as { body: InstantClaimPayload }
  return { sent: init.body.templateId, kept: claimed.payload.templateId }
}

type Reader = (value: unknown) => CanonicalTemplateId | undefined

/**
 * The alias is honoured: both identifiers are read as the one template, and nothing else is.
 * Each refusal has its own words.
 */
function assertAliasHonoured(read: Reader) {
  if (read('proximity') !== 'proximity')
    throw new Error('the canonical identifier `proximity` is not read as the proximity template')
  if (read('crisis-cell') !== 'proximity')
    throw new Error(
      `the alias \`crisis-cell\` is no longer read as \`proximity\` (read: ${String(read('crisis-cell'))})`
    )
  for (const foreign of ['crisis', 'Proximity', 'proximity ', '', 'urgence', 7, null, undefined])
    if (read(foreign) !== undefined)
      throw new Error(`a value that names no template is read as one (${String(foreign)})`)
}

describe('the proximity template and its alias', () => {
  it('sends `proximity` when asked for `proximity`', async () => {
    expect(await sentFor('proximity')).toEqual({ sent: 'proximity', kept: 'proximity' })
  })

  it('sends `proximity`, never the alias, when the identifier came back as `crisis-cell`', async () => {
    expect(await sentFor('crisis-cell')).toEqual({ sent: 'proximity', kept: 'proximity' })
  })

  it('reads both identifiers as the same template, and nothing else as one', () => {
    assertAliasHonoured(readTemplateId)
    expect(canonicalTemplateId('crisis-cell')).toBe('proximity')
    expect(canonicalTemplateId('proximity')).toBe('proximity')
    expect(canonicalTemplateId('tech-studio')).toBe('tech-studio')
    expect(TEMPLATE_ALIASES).toEqual({ 'crisis-cell': 'proximity' })
  })

  it('claims the same local workspace for a claim stored under either identifier', () => {
    const canonical = localClaim({ ...base, templateId: 'proximity' })
    const stored = localClaim({ ...base, templateId: 'crisis-cell' })
    expect(stored).toEqual(canonical)
    expect(stored.payload.templateId).toBe('proximity')
    expect(stored.channels.map((channel) => channel.name)).toContain('proximity')
    expect(stored.channels.map((channel) => channel.name)).not.toContain('urgence')
  })

  it('keeps a key for the alias where a stored identifier is looked up, with the same channels', () => {
    // `src/mocks/demo/localWorkspaces.ts` admits a stored claim by `Object.hasOwn` on this table.
    expect(Object.hasOwn(TEMPLATE_CHANNELS, 'crisis-cell')).toBe(true)
    expect(TEMPLATE_CHANNELS['crisis-cell']).toBe(TEMPLATE_CHANNELS.proximity)
  })

  it('refuses an identifier that names no template before anything is sent', async () => {
    const post = vi.fn().mockResolvedValue(assigned)
    for (const templateId of ['crisis', 'urgence', 'open-source-community', 'PROXIMITY'])
      await expect(
        instantClaimWorkspace({ ...base, templateId: templateId as TemplateId }, { post })
      ).rejects.toMatchObject({ kind: 'refused' })
    expect(post).not.toHaveBeenCalled()
  })

  it('names the proximity template to the self-host tooling by the alias its table holds', () => {
    expect(deployTemplateId('proximity')).toBe('crisis-cell')
    expect(deployTemplateId('crisis-cell')).toBe('crisis-cell')
    expect(deployTemplateId('tech-studio')).toBe('tech-studio')
  })

  it('accepts every theme identifier of the contract, the three older aliases included', async () => {
    const themes = ['light', 'dark', 'black', 'ciel', 'ciel-nuit', 'givre', 'ardoise', 'real-black']
    for (const themeId of themes) {
      const post = vi.fn().mockResolvedValue(assigned)
      await instantClaimWorkspace(
        { ...base, themeId: themeId as InstantClaimPayload['themeId'] },
        { post }
      )
      expect(post).toHaveBeenCalledTimes(1)
    }
    await expect(
      instantClaimWorkspace(
        { ...base, themeId: 'slate' as InstantClaimPayload['themeId'] },
        { post: vi.fn().mockResolvedValue(assigned) }
      )
    ).rejects.toMatchObject({ kind: 'refused' })
  })
})

describe('the alias check refuses a reader that dropped the alias', () => {
  it('control: the reader as shipped passes', () => {
    expect(() => assertAliasHonoured(readTemplateId)).not.toThrow()
  })

  it('mutant alias-dropped: `crisis-cell` names nothing any more', () => {
    const withoutAlias: Reader = (value) => readTemplateId(value, {})
    expect(withoutAlias('proximity')).toBe('proximity')
    expect(() => assertAliasHonoured(withoutAlias)).toThrow(
      'the alias `crisis-cell` is no longer read as `proximity`'
    )
  })

  it('mutant alias-kept-as-its-own-template: `crisis-cell` is read back unchanged', () => {
    const aliasAsItself: Reader = (value) =>
      value === 'crisis-cell' ? ('crisis-cell' as CanonicalTemplateId) : readTemplateId(value)
    expect(() => assertAliasHonoured(aliasAsItself)).toThrow(
      'the alias `crisis-cell` is no longer read as `proximity`'
    )
  })
})
