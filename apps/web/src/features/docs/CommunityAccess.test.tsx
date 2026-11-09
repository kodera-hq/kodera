import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { FirstRunOnboardingModal } from '../onboarding/FirstRunOnboardingModal'
import { CommunityAccess } from './CommunityAccess'
import { HostingOfferPanel } from '../workspace/HostingOfferPanel'
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../api/client', async () => ({
  ...(await vi.importActual('../../api/client')),
  coreApi: () => ({ POST: post }),
}))
beforeEach(() => {
  localStorage.clear()
  post.mockReset()
})
it('previews the three categories and twelve planned channels, preserves truthful status and returns focus on Escape', async () => {
  const user = userEvent.setup()
  render(<CommunityAccess />)
  const entry = screen.getByRole('button', { name: 'Communauté · community.kodera.io' })
  await user.click(entry)
  const dialog = screen.getByRole('dialog')
  const nav = within(dialog).getByRole('navigation', { name: 'Salons communautaires' })
  expect(within(nav).getAllByRole('button')).toHaveLength(12)
  await user.click(within(nav).getByRole('button', { name: '# extensions' }))
  expect(within(dialog).getByRole('heading', { name: '# extensions' })).toBeInTheDocument()
  expect(within(dialog).getByText(/Disponibilité du domaine/)).toBeInTheDocument()
  expect(
    within(dialog).getByRole('link', { name: 'Ouvrir l’adresse cible de la communauté' })
  ).toHaveAttribute('href', 'https://community.kodera.io/')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(entry).toHaveFocus()
})
it('opens the actual hub from Hosting & Offer and returns to its associated community preview', async () => {
  const user = userEvent.setup()
  render(<HostingOfferPanel />)
  await user.click(screen.getByText('Hébergement & Offre'))
  await user.click(screen.getByRole('button', { name: 'Communauté · community.kodera.io' }))
  await user.click(screen.getByRole('button', { name: 'Ouvrir la documentation développeur' }))
  expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Ouvrir le salon d’entraide associé' }))
  expect(screen.getByRole('heading', { name: '# self-hosting' })).toBeInTheDocument()
})
it('closes only the nested community dialog on Escape inside a confirmed onboarding summary', async () => {
  post.mockResolvedValue({
    response: { status: 201 },
    data: {
      workspaceId: 'assigned-1',
      workspaceUrl: 'https://cinema.kodera.io',
      invitationUrl: 'https://cinema.kodera.io/invite?signed=example',
      channels: [{ id: 'production', name: 'production', kind: 'text' }],
      enabledConnectors: [],
    },
  })
  const user = userEvent.setup()
  const dismiss = vi.fn()
  render(
    <FirstRunOnboardingModal
      claimMode="cloud"
      open
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onComplete={() => {}}
      onDismiss={dismiss}
    />
  )
  await user.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), 'Cinema')
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  await user.click(screen.getByRole('button', { name: 'Ouvrir l’espace' }))
  expect(await screen.findByText('Espace Cloud attribué')).toBeInTheDocument()
  await user.click(screen.getByText('Hébergement & Offre'))
  await user.click(screen.getByRole('button', { name: 'Communauté · community.kodera.io' }))
  await user.keyboard('{Escape}')
  expect(dismiss).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('dialog', { name: 'Communauté Open-Source, DevRel & Documentation Live' })
  ).toBeNull()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('shows exact category audiences, partner interoperability and the community voice room', async () => {
  const user = userEvent.setup()
  render(<CommunityAccess />)
  await user.click(screen.getByRole('button', { name: 'Communauté · community.kodera.io' }))
  const nav = within(screen.getByRole('dialog')).getByRole('navigation', {
    name: 'Salons communautaires',
  })
  expect(
    within(nav)
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
  ).toEqual(['Community', 'Core Kodera', 'Design Partners'])
  expect(within(nav).getByText('Ouverte à tous')).toBeInTheDocument()
  expect(within(nav).getByText('Équipe cœur Kodera')).toBeInTheDocument()
  expect(within(nav).getByRole('button', { name: '🔊 office-hours' })).toBeInTheDocument()
  for (const name of ['partner-dinum', 'partner-octo']) {
    await user.click(within(nav).getByRole('button', { name: `# ${name}` }))
    expect(screen.getByRole('heading', { name: `# ${name}` })).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Aperçu de discussion communautaire' })).getByText(
        /clients Matrix standards comme Element/
      )
    ).toBeInTheDocument()
  }
})
