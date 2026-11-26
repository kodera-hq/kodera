import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { OrganisationSwitchContext } from '../../app/organisationSwitch'
import { WorkspaceMenu, WORKSPACE_COMMAND_EVENT } from './WorkspaceMenu'

it('contains only workspaces, workspace creation, administration and personal settings', async () => {
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
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
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
  ['Administration de l’espace…', 'admin'],
  ['Paramètres personnels…', 'settings'],
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

it('hides the administration entry point when the caller cannot administer the workspace', async () => {
  const user = userEvent.setup()
  render(
    <OrganisationSwitchContext.Provider
      value={{
        memberships: [{ name: 'Kodera Community', slug: 'community', current: true }],
        onSwitch: vi.fn(),
        canAdminister: false,
        adminSections: [],
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
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  expect(screen.queryByRole('menuitem', { name: 'Administration de l’espace…' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Paramètres personnels…' })).toBeVisible()
})

it('keeps the administration entry point for a delegated manager and an administrator', async () => {
  const user = userEvent.setup()
  for (const canAdminister of [true, undefined]) {
    const { unmount } = render(
      <OrganisationSwitchContext.Provider
        value={{
          memberships: [{ name: 'Kodera Community', slug: 'community', current: true }],
          onSwitch: vi.fn(),
          ...(canAdminister === undefined
            ? {}
            : { canAdminister, adminSections: ['members', 'roles'] as const }),
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
    expect(screen.getByRole('menuitem', { name: 'Administration de l’espace…' })).toBeVisible()
    await user.keyboard('{Escape}')
    unmount()
  }
})

it.each([
  ['fr', 'Créer mon espace'],
  ['en', 'Create my workspace'],
])('gives a Community member a fresh app entry in %s', async (locale, label) => {
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
  const communityWindow = Object.create(window) as Window
  Object.defineProperty(communityWindow, 'location', {
    value: new URL('https://community.kodera.io/community/workspace'),
  })
  vi.stubGlobal('window', communityWindow)
  try {
    await i18n.changeLanguage(locale)
    render(<WorkspaceMenu name="Community" slug="community" trigger={<button>Workspace</button>} />)
    await userEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    const entry = screen.getByRole('menuitem', { name: label })
    expect(entry.tagName).toBe('A')
    expect(entry).toHaveAttribute('href', 'https://app.kodera.io/workspaces/new#community-sign-in')
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await i18n.changeLanguage('fr')
  }
})
