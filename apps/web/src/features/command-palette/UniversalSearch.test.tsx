import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import '../../i18n'
import { OrganisationSwitchContext } from '../../app/organisationSwitch'
import { UniversalSearch } from './UniversalSearch'
import { fuzzyEntries } from './search'
import { WORKSPACE_COMMAND_EVENT } from '../workspace/WorkspaceMenu'
const entries = [
  { id: 'general', label: 'Général', kind: 'text' as const },
  { id: 'audio', label: 'Daily team', kind: 'audio' as const },
]
describe('universal workspace palette', () => {
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
})
