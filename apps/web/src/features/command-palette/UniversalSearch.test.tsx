import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import '../../i18n'
import { OrganisationSwitchContext } from '../../app/organisationSwitch'
import { UniversalSearch } from './UniversalSearch'
import { OPEN_PALETTE, PaletteProvider } from './PaletteContext'
import { fuzzyEntries } from './search'
import { WORKSPACE_COMMAND_EVENT } from '../workspace/WorkspaceMenu'
import type { AdminSection } from '../workspace/admin/sections'
const entries = [
  { id: 'general', label: 'Général', kind: 'text' as const },
  { id: 'audio', label: 'Daily team', kind: 'audio' as const },
]
describe('universal workspace palette', () => {
  it('labels the registered trigger with its visible text and exposes the shortcut separately', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    window.addEventListener(OPEN_PALETTE, open)
    try {
      render(
        <PaletteProvider>
          <UniversalSearch entries={entries} shortcut onChoose={() => null} />
        </PaletteProvider>
      )
      const trigger = screen.getByRole('button', { name: 'Rechercher' })
      expect(trigger).toHaveAccessibleName('Rechercher')
      expect(trigger).not.toHaveAttribute('aria-label')
      expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K')
      expect(screen.getByText('Ctrl+K')).toHaveAttribute('aria-hidden', 'true')
      await user.click(trigger)
      expect(open).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(OPEN_PALETTE, open)
    }
  })
  it('ranks names ahead of fuzzy subsequences and accepts accent-insensitive input safely', () => {
    expect(fuzzyEntries(entries, 'gnrl').map((entry) => entry.id)).toEqual(['general'])
    expect(fuzzyEntries(entries, 'GENÉRAL').map((entry) => entry.id)).toEqual(['general'])
    expect(fuzzyEntries(entries, '[(.*')).toEqual([])
  })
  it('opens with Ctrl K, activates actual documents and restores focus on Escape', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    render(
      <>
        <button>Origin</button>
        <UniversalSearch
          entries={entries}
          shortcut
          onChoose={() => null}
          documents={[{ id: 'doc1', label: 'Architecture decisions', open }]}
        />
      </>
    )
    await user.click(screen.getByRole('button', { name: 'Origin' }))
    await user.keyboard('{Control>}k{/Control}')
    const field = screen.getByRole('combobox')
    expect(field).toHaveFocus()
    await user.type(field, 'archd')
    await user.keyboard('{Enter}')
    expect(open).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Origin' }))
    await user.keyboard('{Control>}k{/Control}{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveFocus())
  })
  it('searches and keyboard-navigates across channels, direct messages, members, and workspace documents', async () => {
    const user = userEvent.setup()
    const chooseChannel = vi.fn(() => null)
    const openDm = vi.fn()
    const mentionMember = vi.fn()
    const openDoc = vi.fn()

    render(
      <UniversalSearch
        entries={entries}
        shortcut
        onChoose={chooseChannel}
        directMessages={[{ id: '!dm-1:kodera.io', label: 'Camille Laurent', open: openDm }]}
        members={[{ id: '@nadia:kodera.io', label: '@Nadia Benali', open: mentionMember }]}
        documents={[{ id: 'doc-runbook', label: 'Database Failover Runbook', open: openDoc }]}
      />
    )

    // 1. Direct message target
    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByText(/Aucune conversation directe/)).toBeNull()
    await user.type(screen.getByRole('combobox'), 'Camille')
    await user.keyboard('{Enter}')
    expect(openDm).toHaveBeenCalledOnce()

    // 2. Member target
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Nadia')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(mentionMember).toHaveBeenCalledOnce())

    // 3. Workspace document target
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Failover Runbook')
    await user.keyboard('{Enter}')
    expect(openDoc).toHaveBeenCalledOnce()

    // 4. Channel target
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Daily team')
    await user.keyboard('{Enter}')
    expect(chooseChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'audio' }))
  })
  it('changes themes and delegates workspace navigation to the authorized switcher', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    render(
      <OrganisationSwitchContext.Provider
        value={{ memberships: [{ name: 'My studio', slug: 'studio', current: true }], onSwitch }}
      >
        <UniversalSearch entries={entries} shortcut onChoose={() => null} />
      </OrganisationSwitchContext.Provider>
    )
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'OLED')
    await user.keyboard('{Enter}')
    expect(localStorage.getItem('console:theme')).toBe('black')
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'My studio')
    await user.keyboard('{Enter}')
    expect(onSwitch).toHaveBeenCalledWith('studio')
  })
  it('opens the selected settings section and lists no invented direct conversations', async () => {
    const user = userEvent.setup()
    const command = vi.fn()
    window.addEventListener(WORKSPACE_COMMAND_EVENT, command)
    render(<UniversalSearch entries={entries} shortcut onChoose={() => null} />)
    await user.keyboard('{Control>}k{/Control}')
    expect(screen.getByText(/Aucune conversation directe/)).toBeVisible()
    await user.type(screen.getByRole('combobox'), 'Voix')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect((command.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      command: 'settings',
      section: 'audio',
    })
    window.removeEventListener(WORKSPACE_COMMAND_EVENT, command)
  })
  it('offers administration commands only to callers whose admin sections allow them', async () => {
    const user = userEvent.setup()
    const renderPalette = (adminSections?: readonly AdminSection[]) =>
      render(
        <OrganisationSwitchContext.Provider
          value={{
            memberships: [{ name: 'My studio', slug: 'studio', current: true }],
            onSwitch: vi.fn(),
            ...(adminSections === undefined ? {} : { adminSections }),
          }}
        >
          <UniversalSearch entries={entries} shortcut onChoose={() => null} />
        </OrganisationSwitchContext.Provider>
      )
    // A plain member with zero delegated permissions: no members/extensions/hosting commands.
    const first = renderPalette([])
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Membres')
    expect(screen.queryByText('Membres', { exact: true })).toBeNull()
    await user.type(screen.getByRole('combobox'), '{Control>}a{/Control}Connecteurs')
    expect(screen.queryByText('Connecteurs & extensions')).toBeNull()
    await user.keyboard('{Escape}')
    first.unmount()
    // A delegated manager with the members section: the command is offered, personal ones too.
    const second = renderPalette(['members'])
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Membres')
    expect(await screen.findByText('Membres', { exact: true })).toBeVisible()
    await user.keyboard('{Escape}')
    second.unmount()
    // Without a switcher at all the palette fails closed: personal commands only.
    const third = render(<UniversalSearch entries={entries} shortcut onChoose={() => null} />)
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Hébergement')
    expect(screen.queryByText('Hébergement et administration')).toBeNull()
    await user.type(screen.getByRole('combobox'), '{Control>}a{/Control}Voix')
    expect(await screen.findByText('Voix et audio')).toBeVisible()
    await user.keyboard('{Escape}{Escape}')
    third.unmount()
    // A switcher that carries no computed sections fails closed too.
    render(
      <OrganisationSwitchContext.Provider
        value={{
          memberships: [{ name: 'My studio', slug: 'studio', current: true }],
          onSwitch: vi.fn(),
        }}
      >
        <UniversalSearch entries={entries} shortcut onChoose={() => null} />
      </OrganisationSwitchContext.Provider>
    )
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'Journal')
    expect(screen.queryByText('Journal d’audit')).toBeNull()
  })
  it('offers each IAM administration section only when its section is allowed', async () => {
    const user = userEvent.setup()
    const command = vi.fn()
    window.addEventListener(WORKSPACE_COMMAND_EVENT, command)
    const labels: Record<string, string> = {
      roles: 'Rôles et permissions',
      channels: 'Salons et dérogations de permissions',
      invites: 'Invitations',
      moderation: 'Modération',
      audit: 'Journal d’audit',
    }
    try {
      // A delegated manager with roles + audit: those two, never invites, moderation or channels.
      const view = render(
        <OrganisationSwitchContext.Provider
          value={{
            memberships: [{ name: 'My studio', slug: 'studio', current: true }],
            onSwitch: vi.fn(),
            adminSections: ['roles', 'audit'],
          }}
        >
          <UniversalSearch entries={entries} shortcut onChoose={() => null} />
        </OrganisationSwitchContext.Provider>
      )
      await user.keyboard('{Control>}k{/Control}')
      const field = screen.getByRole('combobox')
      for (const [section, label] of Object.entries(labels)) {
        await user.type(field, `{Control>}a{/Control}${label}`)
        if (section === 'roles' || section === 'audit')
          expect(await screen.findByText(label, { exact: true }), section).toBeVisible()
        else expect(screen.queryByText(label, { exact: true }), section).toBeNull()
      }
      await user.type(field, '{Control>}a{/Control}Journal d’audit')
      await user.keyboard('{Enter}')
      await waitFor(() => expect(command).toHaveBeenCalled())
      expect((command.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        command: 'settings',
        section: 'audit',
      })
      view.unmount()
    } finally {
      window.removeEventListener(WORKSPACE_COMMAND_EVENT, command)
    }
  })
  it('lists workspace files in their own group and opens them', async () => {
    const user = userEvent.setup()
    const openFile = vi.fn()
    render(
      <UniversalSearch
        entries={entries}
        files={[{ id: 'f1', label: 'budget-2027.csv', open: openFile }]}
        shortcut
        onChoose={() => null}
      />
    )
    await user.keyboard('{Control>}k{/Control}')
    await user.type(screen.getByRole('combobox'), 'budget')
    expect(await screen.findByText('budget-2027.csv')).toBeVisible()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(openFile).toHaveBeenCalledOnce())
  })
  it('keeps personal settings commands for an ordinary member while omitting administration ones', async () => {
    const user = userEvent.setup()
    render(
      <OrganisationSwitchContext.Provider
        value={{
          memberships: [{ name: 'My studio', slug: 'studio', current: true }],
          onSwitch: vi.fn(),
          adminSections: [],
        }}
      >
        <UniversalSearch entries={entries} shortcut onChoose={() => null} />
      </OrganisationSwitchContext.Provider>
    )
    await user.keyboard('{Control>}k{/Control}')
    const field = screen.getByRole('combobox')
    // Personal settings commands are offered to every member, whatever their admin sections.
    await user.type(field, 'profil')
    expect(await screen.findByText('Mon profil et mon statut')).toBeVisible()
    await user.type(field, '{Control>}a{/Control}apparence')
    expect(await screen.findByText('Apparence et thèmes')).toBeVisible()
    await user.type(field, '{Control>}a{/Control}voix')
    expect(await screen.findByText('Voix et audio')).toBeVisible()
    // Administration commands stay hidden without a delegated section.
    await user.type(field, '{Control>}a{/Control}membres')
    expect(screen.queryByText('Membres', { exact: true })).toBeNull()
    await user.type(field, '{Control>}a{/Control}connecteurs')
    expect(screen.queryByText('Connecteurs et extensions')).toBeNull()
    await user.type(field, '{Control>}a{/Control}hébergement')
    expect(screen.queryByText('Hébergement et administration')).toBeNull()
  })
})

it('clears a nonempty query before closing and exposes group headers', async () => {
  const user = userEvent.setup()
  render(<UniversalSearch entries={entries} shortcut onChoose={() => null} />)
  await user.keyboard('{Control>}k{/Control}')
  expect(screen.getAllByText('Salons')[0]).toBeVisible()
  await user.type(screen.getByRole('combobox'), 'gen')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('combobox')).toHaveValue('')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
})
