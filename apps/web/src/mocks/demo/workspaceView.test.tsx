import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import '../../i18n'
import { registerInteractiveDemo } from '../../app/interactiveDemo'
import { EspaceLiveView } from '../../features/espace/EspaceLiveView'
import { EspaceDraftProvider } from '../../features/espace/EspaceDraftProvider'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import { createLocalWorkspaceStore } from './workspaceStore'

vi.mock('../../auth/AuthProvider', () => ({
  useAuthLifetime: () => ({
    getSnapshot: () => ({ status: 'ready' }),
    subscribe: () => () => undefined,
    hasUsableCredential: () => true,
  }),
}))
afterEach(() => registerInteractiveDemo(undefined))

function showLocalWorkspace(readyAudio = false) {
  const base = readyWorkspace()
  const workspace = {
    ...base,
    categories: base.categories.map((category) => ({
      ...category,
      channels: category.channels.map((channel) =>
        readyAudio && channel.kind === 'audio'
          ? { ...channel, room_state: 'ready' as const }
          : channel
      ),
    })),
  }
  const store = createLocalWorkspaceStore(workspace)
  render(
    <EspaceDraftProvider
      org="vercelli"
      organisationId={workspace.organisation_id}
      meGeneration={1}
      meCredentialGeneration={1}
      tenantSlugFor={() => 'vercelli'}
    >
      <EspaceLiveView
        org="vercelli"
        organisationName="Groupe Vercelli"
        workspace={workspace}
        channelId={undefined}
        store={store}
      />
    </EspaceDraftProvider>
  )
}

it('allows local conversations inside the authenticated shell without issuing Matrix credentials', async () => {
  registerInteractiveDemo({ slug: 'vercelli', createStore: createLocalWorkspaceStore })
  const user = userEvent.setup()
  showLocalWorkspace()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  const composer = screen.getByRole('combobox')
  await user.type(composer, 'Local shell message{Enter}')
  expect(within(screen.getByRole('log')).getByText('Local shell message')).toBeInTheDocument()
})

it('keeps the Matrix admission guard for unregistered organisations', () => {
  registerInteractiveDemo({ slug: 'other', createStore: createLocalWorkspaceStore })
  showLocalWorkspace()
  expect(screen.getByRole('alert')).toHaveTextContent('La messagerie ne peut pas s’ouvrir')
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
})

it('joins a clearly labelled local voice preview and operates mute, deafen and leave', async () => {
  registerInteractiveDemo({ slug: 'vercelli', createStore: createLocalWorkspaceStore })
  const user = userEvent.setup()
  showLocalWorkspace(true)
  const voice = screen.getByRole('button', { name: /Rejoindre détente/ })
  await user.click(voice)
  expect(
    await screen.findByText('Simulation locale · aucun son capté ni transmis.')
  ).toBeInTheDocument()
  const mute = screen.getByRole('button', { name: 'Couper le micro' })
  await user.click(mute)
  expect(mute).toHaveAttribute('aria-pressed', 'true')
  const deafen = screen.getByRole('button', { name: 'Couper le son' })
  await user.click(deafen)
  expect(deafen).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: 'Quitter' }))
  expect(screen.queryByText('Simulation locale · aucun son capté ni transmis.')).toBeNull()
})
