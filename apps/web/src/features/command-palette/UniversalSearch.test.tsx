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
