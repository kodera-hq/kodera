import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '../../i18n'
import { OrganisationSwitchContext } from '../../app/organisationSwitch'
import { WorkspaceMenu, WORKSPACE_COMMAND_EVENT } from './WorkspaceMenu'

it('contains only workspaces, workspace creation, and settings', async () => {
  const user = userEvent.setup()
  const onSwitch = vi.fn()
  render(
    <OrganisationSwitchContext.Provider
      value={{
        memberships: [
          { name: 'Kodera Community', slug: 'community', current: true },
          { name: 'Product Team', slug: 'product', current: false },
        ],
        onSwitch,
      }}
    >
      <WorkspaceMenu
        name="Kodera Community"
        slug="community"
        trigger={<button>Workspace</button>}
      />
    </OrganisationSwitchContext.Provider>
  )
  await user.click(screen.getByRole('button', { name: 'Workspace' }))
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  expect(screen.getByRole('menuitemradio', { name: /Kodera Community/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  expect(screen.getByText('KC')).toHaveAttribute('aria-hidden', 'true')
  expect(screen.getByText('Communauté & Support')).toBeInTheDocument()
  expect(screen.queryByText('Theme Studio')).not.toBeInTheDocument()
  expect(screen.queryByText('Connecteurs & Extensions')).not.toBeInTheDocument()
  await user.click(screen.getByRole('menuitemradio', { name: /Product Team/ }))
  expect(onSwitch).toHaveBeenCalledWith('product')
})

it.each([
  ['+ Créer ou configurer un nouvel espace', 'configure'],
  ['Réglages de l’espace…', 'settings'],
])('dispatches the %s command', async (name, command) => {
  const listener = vi.fn()
  window.addEventListener(WORKSPACE_COMMAND_EVENT, listener)
  render(<WorkspaceMenu name="Community" slug="community" trigger={<button>Workspace</button>} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Workspace' }))
  await user.click(screen.getByRole('menuitem', { name }))
  expect(listener.mock.calls[0]?.[0].detail).toBe(command)
  window.removeEventListener(WORKSPACE_COMMAND_EVENT, listener)
})
