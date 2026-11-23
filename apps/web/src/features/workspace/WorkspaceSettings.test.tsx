import { act, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type * as IamApiModule from './iamApi'
import type * as MembersApiModule from './admin/membersApi'
import type * as ExtensionsCatalogModule from '../extensions/ExtensionsCatalogPanel'
import type { ExtensionsCatalogPanelProps } from '../extensions/ExtensionsCatalogPanel'
import type { ReactElement, ReactNode } from 'react'
import '../../i18n'
import WorkspaceSettings from './WorkspaceSettings'
import { getLocalProfile } from '../profile/localProfile'

const runtime = {
  org: 'community',
  userId: '@member:community.kodera.io',
  displayName: 'Member',
  members: [{ userId: '@member:community.kodera.io', name: 'Member' }],
  call: null,
  invite: vi.fn().mockResolvedValue(undefined),
  memberRole: () => 'member',
}
vi.mock('./settingsRuntime', () => ({ useWorkspaceSettingsRuntime: () => runtime }))
vi.mock('./queries', () => ({
  useWorkspaceQuery: () => ({ data: undefined }),
  useWorkspaceTenantQuery: () => ({ data: { hostingMode: 'community' } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    onClick,
  }: {
    children: ReactNode
    to: string
    params: { org: string }
    onClick?: () => void
  }) => (
    <a href={to.replace('$org', params.org)} onClick={onClick}>
      {children}
    </a>
  ),
}))
const iam = vi.hoisted(() => ({
  roles: {
    roles: [] as unknown[],
    assignments: [] as { membership_id: string; role_ids: string[] }[],
  },
}))
vi.mock('./iamApi', async (actual) => ({
  ...(await actual<typeof IamApiModule>()),
  listWorkspaceRoles: vi.fn(async () => iam.roles),
  getWorkspaceProfile: vi.fn(async () => ({
    value: {
      description: '',
      banner_preset: 'ink',
      icon_mxc: '',
      traits: [],
      arrivals_channel_id: null,
      rules_channel_id: null,
      moderator_updates_channel_id: null,
      security_alerts_channel_id: null,
      invites_paused: false,
    },
    etag: '"p1"',
  })),
}))
const directory = vi.hoisted(() => ({
  rows: [] as {
    id: string
    display_name: string | null
    email: string | null
    role: string
    state: string
  }[],
}))
vi.mock('./admin/membersApi', async (actual) => ({
  ...(await actual<typeof MembersApiModule>()),
  useDirectory: () => ({
    data: { pages: [{ data: directory.rows, has_more: false, next_cursor: null }] },
    hasNextPage: false,
    isError: false,
  }),
}))
vi.mock('./HostingOfferPanel', () => ({ HostingOfferPanel: () => <div>Hosting</div> }))
const extensionsSpy = vi.hoisted(() => ({ useRealPanel: false }))
vi.mock('../extensions/ExtensionsCatalogPanel', async (actual) => {
  const mod = await actual<typeof ExtensionsCatalogModule>()
  return {
    ...mod,
    ExtensionsCatalogPanel: (panelProps: ExtensionsCatalogPanelProps) =>
      extensionsSpy.useRealPanel ? (
        <mod.ExtensionsCatalogPanel {...panelProps} />
      ) : (
        <div data-testid="extensions-mock" data-org-id={panelProps.organisationId ?? ''}>
          Extensions
        </div>
      ),
  }
})
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const props = {
  org: 'community',
  membershipId: 'membership-self',
  organisationId: 'org-community',
  organisationName: 'Community',
  displayName: 'Member',
  role: 'org_member' as const,
  returnFocus: { current: null },
  onClose: vi.fn(),
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  iam.roles = { roles: [], assignments: [] }
  directory.rows = []
})

it('persists profile changes and allows clearing the display name before typing', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  const field = screen.getByRole('textbox', { name: 'Nom d’affichage' })
  await user.clear(field)
  expect(field).toHaveValue('')
  await user.type(field, 'Alex')
  await user.type(screen.getByRole('textbox', { name: 'Message de statut' }), 'Reviewing')
  await user.click(screen.getByRole('radio', { name: 'Concentré' }))
  expect(getLocalProfile(runtime.userId)).toEqual({
    displayName: 'Alex',
    status: 'Reviewing',
    presence: 'focused',
  })
  await user.click(screen.getByRole('button', { name: 'Copier l’ID Matrix' }))
  expect(await navigator.clipboard.readText()).toBe(runtime.userId)
  await user.keyboard('{Escape}')
  expect(props.onClose).toHaveBeenCalled()
})

it('opens the personal settings by default with only personal sections and no admin switch for a member', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  expect(screen.getByRole('heading', { level: 2, name: 'Mon profil & statut' })).toBeVisible()
  expect(screen.getByRole('dialog', { name: 'Paramètres personnels' })).toBeVisible()
  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Mon profil & statut',
    'Sécurité & connexion',
    'Apparence & thèmes',
    'Voix & audio',
    'Notifications',
    'Confidentialité & RGPD',
    'Raccourcis',
  ])
  await waitFor(() => expect(iam.roles).toBeDefined())
  expect(screen.queryByRole('button', { name: 'Administration de l’espace' })).toBeNull()
  expect(screen.queryByRole('tab', { name: 'Rôles & Tags' })).toBeNull()
  // The read-only shortcuts reference lists the core keys as key caps.
  await user.click(screen.getByRole('tab', { name: 'Raccourcis' }))
  expect(screen.getByRole('heading', { level: 2, name: 'Raccourcis' })).toBeVisible()
  expect(screen.getByText('Ctrl+K')).toBeVisible()
  expect(screen.getByText('Ctrl+/')).toBeVisible()
  expect(screen.getByText('Alt+↑/↓')).toBeVisible()
  expect(screen.getByText('Alt+Shift+↑/↓')).toBeVisible()
  // 'Échap' also names the header's own key hint, so the tab adds a second one.
  expect(screen.getAllByText('Échap').length).toBeGreaterThanOrEqual(2)
})

it('keeps appearance and audio available to a member', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  await user.click(screen.getByRole('tab', { name: 'Apparence & thèmes' }))
  // Every selectable theme the console offers, named as the appearance screen names them.
  for (const theme of ['Automatique', 'Clair', 'Sombre', 'Noir']) {
    expect(screen.getByRole('button', { name: theme })).toBeVisible()
  }
  await user.click(screen.getByRole('button', { name: 'Noir' }))
  expect(localStorage.getItem('console:theme')).toBe('black')
  await user.click(screen.getByRole('button', { name: 'Sombre' }))
  expect(localStorage.getItem('console:theme')).toBe('dark')
  await user.click(screen.getByRole('button', { name: 'Ouvrir Theme Studio' }))
  expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)
  await user.keyboard('{Escape}')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await user.click(screen.getByRole('tab', { name: 'Voix & audio' }))
  expect(await screen.findByRole('button', { name: 'Tester le son' })).toBeVisible()
  expect(await screen.findByRole('slider', { name: 'Volume principal' })).toBeVisible()
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  expect(screen.getByRole('heading', { level: 3, name: 'Ambiance sonore' })).toBeVisible()
  await user.click(screen.getByRole('tab', { name: 'Notifications' }))
  await user.click(screen.getByRole('button', { name: 'Régler les sons' }))
  expect(screen.getByRole('tab', { name: 'Voix & audio' })).toHaveAttribute('aria-selected', 'true')
  await user.click(screen.getByRole('tab', { name: 'Sécurité & connexion' }))
  expect(screen.getByRole('link', { name: 'Ouvrir la sécurité du compte' })).toHaveAttribute(
    'href',
    '/community/security'
  )
})

it('offers a 44px « Retour » at the top left and closes on Escape, in both modes', async () => {
  const user = userEvent.setup()
  const { unmount } = render(<WorkspaceSettings {...props} />)
  const back = screen.getByRole('button', { name: 'Retour' })
  expect(back.className).toContain('h-[44px]')
  expect(back.className).toContain('narrow:min-h-[44px]')
  await user.click(back)
  expect(props.onClose).toHaveBeenCalledTimes(1)
  unmount()
  render(<WorkspaceSettings {...{ ...props, role: 'org_owner' as const }} mode="admin" />)
  expect(screen.getByRole('dialog', { name: 'Administration de l’espace' })).toBeVisible()
  expect(screen.getByText('Échap')).toBeVisible()
  await user.keyboard('{Escape}')
  expect(props.onClose).toHaveBeenCalledTimes(2)
})

it('gives owners a categorized administration rail and a switch back to personal settings', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...{ ...props, role: 'org_owner' as const }} />)
  await user.click(screen.getByRole('button', { name: 'Administration de l’espace' }))
  expect(screen.getByRole('dialog', { name: 'Administration de l’espace' })).toBeVisible()
  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Profil de l’espace',
    'Communauté & #arrivées',
    'Salons & permissions',
    'Intégrations & extensions',
    'Membres',
    'Rôles & Tags',
    'Invitations',
    'Sécurité & modération',
    'Logs d’audit',
    'Quotas & ressources',
    'Hébergement',
  ])
  for (const group of ['Espace', 'Personnes', 'Sécurité', 'Plateforme']) {
    expect(within(screen.getByRole('tablist')).getByText(group)).toBeVisible()
  }
  expect(
    await screen.findByRole('figure', { name: 'Aperçu de la carte de l’espace' })
  ).toBeVisible()
  await user.click(screen.getByRole('tab', { name: 'Hébergement' }))
  expect(screen.getByRole('link', { name: 'Statut' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Facturation' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Paramètres personnels' }))
  expect(screen.getByRole('heading', { level: 2, name: 'Mon profil & statut' })).toBeVisible()
  expect(screen.getByText(/Rôle dans l’organisation\s*:\s*Propriétaire/u)).toBeVisible()
})

it('lets a delegated role manager open only the sections their roles grant', async () => {
  iam.roles = {
    roles: [
      {
        id: 'r-manager',
        name: 'Coordination',
        slug: 'coordination',
        kind: 'role',
        color: '',
        icon: '',
        position: 5,
        is_hoisted: false,
        is_mentionable: false,
        permissions: ['manage_roles'],
        member_count: 1,
        etag: '"r"',
      },
    ],
    assignments: [{ membership_id: 'membership-self', role_ids: ['r-manager'] }],
  }
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  await user.click(await screen.findByRole('button', { name: 'Administration de l’espace' }))
  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Salons & permissions',
    'Membres',
    'Rôles & Tags',
  ])
})

it('tells a member without delegation that the administration is reserved', async () => {
  render(<WorkspaceSettings {...props} mode="admin" />)
  expect(await screen.findByText(/réservée à ses propriétaires/u)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Paramètres personnels' })).toBeVisible()
})

it('validates Matrix invitations and waits for the room acknowledgement', async () => {
  const user = userEvent.setup()
  let resolve: () => void = () => undefined
  runtime.invite.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  render(
    <WorkspaceSettings {...{ ...props, role: 'org_owner' as const }} initialSection="members" />
  )
  await user.click(screen.getByRole('button', { name: 'Inviter dans cette conversation' }))
  expect(runtime.invite).not.toHaveBeenCalled()
  await user.type(
    screen.getByRole('textbox', { name: 'Identifiant Matrix à inviter' }),
    '@partner:example.org'
  )
  await user.click(screen.getByRole('button', { name: 'Inviter dans cette conversation' }))
  expect(runtime.invite).toHaveBeenCalledWith('@partner:example.org')
  expect(screen.queryByText('Invitation envoyée.')).toBeNull()
  await act(async () => resolve())
  await waitFor(() => expect(screen.getByText('Invitation envoyée.')).toBeVisible())
})

it('names members without raw Matrix addresses and says « Propriétaire », not a wire role', async () => {
  directory.rows = [
    {
      id: 'member-owner',
      display_name: 'Camille Dubois',
      email: 'camille@acme.fr',
      role: 'org_owner',
      state: 'active',
    },
    {
      id: 'member-raw',
      display_name: '@ce239589-a4bd-41db-9cfb-d06e66a77ff3:community.kodera.io',
      email: 'marc.petit@acme.fr',
      role: 'org_member',
      state: 'active',
    },
  ]
  render(
    <WorkspaceSettings {...{ ...props, role: 'org_owner' as const }} initialSection="members" />
  )
  const list = screen.getByRole('list', { name: 'Membres' })
  expect(within(list).getByText('Camille Dubois')).toBeVisible()
  expect(within(list).getByText('marc.petit')).toBeVisible()
  expect(
    within(list).getByRole('button', {
      name: 'Changer le rôle de Camille Dubois (rôle actuel : Propriétaire)',
    })
  ).toHaveTextContent('Propriétaire')
  expect(list.textContent).not.toMatch(/@[0-9a-f-]{36}:/u)
  expect(list.textContent).not.toMatch(/org_owner|Owner|HTTP|40\d|50\d/u)
})

it('holds busy until clearAvatar settles', async () => {
  const user = userEvent.setup()
  let finishClear: () => void = () => undefined
  const clearAvatar = vi.fn(
    () =>
      new Promise<void>((done) => {
        finishClear = done
      })
  )
  const createUrlSpy = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:https://console.test/avatar')
  const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  ;(runtime as { profile?: unknown }).profile = {
    matrixDisplayName: 'Member',
    avatarKey: 'mxc://community.kodera.io/pic1',
    fetchAvatar: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
    setDisplayName: vi.fn(async () => undefined),
    setAvatar: vi.fn(async () => undefined),
    clearAvatar,
  }
  try {
    render(<WorkspaceSettings {...props} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:https://console.test/avatar')
    )
    expect(screen.getAllByRole('img')).toHaveLength(1)
    const removeBtn = screen.getByRole('button', { name: 'Retirer la photo' })
    await user.click(removeBtn)
    expect(clearAvatar).toHaveBeenCalledTimes(1)
    expect(removeBtn).toBeDisabled()
    await act(async () => finishClear())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choisir une image' })).toBeEnabled()
    )
  } finally {
    delete (runtime as { profile?: unknown }).profile
    createUrlSpy.mockRestore()
    revokeUrlSpy.mockRestore()
  }
})

it('switches the open settings dialog between French and English', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  await user.click(screen.getByRole('tab', { name: 'Apparence & thèmes' }))
  expect(screen.getByRole('button', { name: 'Français' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: 'English' }))
  expect(screen.getByRole('group', { name: 'Language' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Français' })).toHaveAttribute('aria-pressed', 'false')
  await user.click(screen.getByRole('button', { name: 'Français' }))
  expect(screen.getByRole('group', { name: 'Langue' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Français' })).toHaveAttribute('aria-pressed', 'true')
})

it('wires organisationId into ExtensionsCatalogPanel so WorkspaceMigratorPanel controls are enabled', async () => {
  const user = userEvent.setup()
  extensionsSpy.useRealPanel = true
  const ownerProps = { ...props, role: 'org_owner' as const }
  try {
    render(<WorkspaceSettings {...ownerProps} />)
    await user.click(screen.getByRole('button', { name: 'Administration de l’espace' }))
    await user.click(screen.getByRole('tab', { name: /Extensions/i }))

    const toggle = await screen.findByRole('button', {
      name: /Migrateur & coexistence/i,
    })
    await user.click(toggle)

    const panel = await screen.findByTestId('workspace-migrator-panel')
    expect(within(panel).queryByTestId('migrator-no-org-hint')).toBeNull()
    expect(within(panel).getByRole('button', { name: /Simuler à blanc/i })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: /Exécuter un lot borné/i })).toBeEnabled()
  } finally {
    extensionsSpy.useRealPanel = false
  }
})
