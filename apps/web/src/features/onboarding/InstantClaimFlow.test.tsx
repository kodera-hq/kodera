import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { it, expect, vi, beforeEach } from 'vitest'
import '../../i18n'
import { FirstRunOnboardingModal } from './FirstRunOnboardingModal'
import { HostingOfferPanel, publicMigrationConfiguration } from '../workspace/HostingOfferPanel'
import { onboardingMessages } from './onboardingMessages'
import { localClaim } from './instantClaimClient'
import { terminalCommand } from './TerminalDeployCommand'
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../api/client', async () => ({
  ...(await vi.importActual('../../api/client')),
  coreApi: () => ({ POST: post }),
}))
beforeEach(() => post.mockReset())
it('keeps the selected template in both terminal commands and refuses shell injection', () => {
  for (const mode of ['script', 'package'] as const) {
    expect(
      terminalCommand(
        mode,
        'chat.example.org',
        'https://id.example.org/realms/studio',
        'console',
        'support@example.org',
        'crisis-cell'
      )
    ).toContain("--template 'crisis-cell'")
    expect(
      terminalCommand(
        mode,
        'chat.example.org; echo unsafe',
        'https://id.example.org',
        'console',
        'support@example.org',
        'crisis-cell'
      )
    ).toBeNull()
  }
})
async function finish() {
  const user = userEvent.setup()
  const modal = screen.getByRole('dialog')
  await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), 'Cinema')
  await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
  await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
  await user.click(within(modal).getByRole('button', { name: 'Ouvrir l’espace' }))
  return user
}
it('hydrates confirmed channels and signed invitation after a 201 response', async () => {
  const claimed = vi.fn()
  post.mockResolvedValue({
    response: { status: 201 },
    data: {
      workspaceId: 'assigned-1',
      workspaceUrl: 'https://cinema.kodera.io',
      invitationUrl: 'https://cinema.kodera.io/invite?signed=yes',
      channels: [{ id: 'production', name: 'production', kind: 'text' }],
      enabledConnectors: ['frameio-review-bridge'],
    },
  })
  render(
    <FirstRunOnboardingModal
      claimMode="cloud"
      open
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onClaimed={claimed}
      onDismiss={() => {}}
      onComplete={() => {}}
    />
  )
  const user = await finish()
  expect(await screen.findByText('Espace Cloud attribué')).toBeInTheDocument()
  expect(claimed).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'assigned-1' }))
  expect(screen.getByRole('button', { name: 'Copier l’invitation signée' })).toBeInTheDocument()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus()
  await user.tab({ shift: true })
  expect(screen.getByText('Hébergement & Offre')).toHaveFocus()
})
it('uses a truthful deterministic local fallback when the backend is unavailable', async () => {
  post.mockResolvedValue({ response: { status: 503 }, data: {} })
  function Flow() {
    const [open, setOpen] = useState(true)
    return (
      <FirstRunOnboardingModal
        claimMode="cloud"
        open={open}
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onDismiss={() => setOpen(false)}
        onComplete={() => setOpen(false)}
      />
    )
  }
  render(<Flow />)
  await finish()
  expect(
    await screen.findByText('Aperçu local dans ce navigateur — aucun espace Cloud attribué')
  ).toBeInTheDocument()
  expect(screen.queryByText('Espace Cloud attribué')).toBeNull()
})
it('keeps bilingual copy parity and exports no signed invitation or workspace identifiers', async () => {
  expect(Object.keys(onboardingMessages.fr).sort()).toEqual(
    Object.keys(onboardingMessages.en).sort()
  )
  const local = localClaim({
    organizationName: 'Cinema',
    slug: 'cinema',
    hostingMode: 'cloud',
    templateId: 'audiovisual-production',
    themeId: 'givre',
    soundPackId: 'givre',
    enabledConnectors: ['frameio-review-bridge'],
  })
  const config = publicMigrationConfiguration({
    ...local,
    invitationUrl: 'https://cinema.kodera.io/private-token',
  })
  expect(JSON.stringify(config)).not.toContain('private-token')
  expect(config).not.toHaveProperty('workspaceId')
  render(<HostingOfferPanel mode="community" workspace={local} />)
  await userEvent.setup().click(screen.getByText('Hébergement & Offre'))
  expect(screen.getAllByText(/Auto-Hébergement Community/).length).toBeGreaterThan(0)
})
it('does not disguise an authorization refusal as an offline preview', async () => {
  post.mockResolvedValue({ response: { status: 403 }, data: {} })
  const complete = vi.fn()
  render(
    <FirstRunOnboardingModal
      claimMode="cloud"
      open
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onDismiss={() => {}}
      onComplete={complete}
    />
  )
  await finish()
  expect(await screen.findByRole('alert')).toHaveTextContent('L’espace n’a pas pu être attribué')
  expect(complete).not.toHaveBeenCalled()
})

it.each(['A', '🌲🌲'])(
  'refuses an invalid local workspace name %s without claiming success',
  async (name) => {
    const complete = vi.fn()
    const claimed = vi.fn()
    render(
      <FirstRunOnboardingModal
        claimMode="preview"
        open
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onClaimed={claimed}
        onDismiss={() => {}}
        onComplete={complete}
      />
    )
    const user = userEvent.setup()
    const modal = screen.getByRole('dialog')
    await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), name)
    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choisissez un nom unique')
    expect(claimed).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  }
)
it('claims a community template with an edited slug and a voice lounge', async () => {
  const claimed = vi.fn()
  render(
    <FirstRunOnboardingModal
      open
      claimMode="preview"
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onClaimed={claimed}
      onDismiss={() => {}}
      onComplete={() => {}}
    />
  )
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), 'Open Source')
  const address = screen.getByRole('textbox', { name: 'Adresse de l’espace' })
  expect(address).toHaveValue('open-source')
  await user.clear(address)
  await user.type(address, 'community-team')
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  await user.selectOptions(screen.getByRole('combobox'), 'open-source')
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  await user.click(screen.getByRole('button', { name: 'Ouvrir l’espace' }))
  expect(claimed).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        slug: 'community-team',
        templateId: 'open-source-community',
      }),
      channels: expect.arrayContaining([
        expect.objectContaining({ name: 'community-lounge', kind: 'audio' }),
      ]),
    })
  )
})
it('keeps local creation open when the registry refuses a reserved or duplicate name', async () => {
  const complete = vi.fn()
  render(
    <FirstRunOnboardingModal
      claimMode="preview"
      open
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onClaimed={() => {
        throw new Error('duplicate')
      }}
      onDismiss={() => {}}
      onComplete={complete}
    />
  )
  await finish()
  expect(await screen.findByRole('alert')).toHaveTextContent('Choisissez un nom unique')
  expect(complete).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('keeps the community template inside preview mode, including after a mode change', async () => {
  const props = {
    open: true,
    isDarkTheme: false,
    onSelectTheme: () => {},
    onDismiss: () => {},
    onComplete: () => {},
  }
  const { rerender } = render(<FirstRunOnboardingModal {...props} claimMode="preview" />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), 'Studio')
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  await user.selectOptions(screen.getByRole('combobox'), 'open-source')
  rerender(<FirstRunOnboardingModal {...props} claimMode="cloud" />)
  expect(screen.queryByRole('option', { name: 'Communauté Open-Source' })).toBeNull()
  expect(screen.getByRole('combobox')).toHaveValue('audiovisual')
  await user.click(screen.getByRole('button', { name: 'Retour' }))
  await user.selectOptions(screen.getByRole('combobox', { name: 'Hébergement' }), 'selfhost')
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
  expect(screen.queryByRole('option', { name: 'Communauté Open-Source' })).toBeNull()
  expect(screen.getByRole('combobox')).toHaveValue('audiovisual')
})

it.each(['ABC', 'abcdefghijklmnopqrstuvwxyzabcdef'])(
  'preserves the cloud slug contract for %s',
  async (name) => {
    post.mockResolvedValue({ response: { status: 403 }, data: {} })
    render(
      <FirstRunOnboardingModal
        open
        claimMode="cloud"
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onDismiss={() => {}}
        onComplete={() => {}}
      />
    )
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), name)
    expect(screen.getByRole('textbox', { name: 'Adresse de l’espace' })).toHaveValue(
      name.toLowerCase()
    )
    await user.click(screen.getByRole('button', { name: 'Continuer' }))
    await user.click(screen.getByRole('button', { name: 'Continuer' }))
    await user.click(screen.getByRole('button', { name: 'Ouvrir l’espace' }))
    await screen.findByRole('alert')
    expect(post).toHaveBeenCalledWith(
      '/workspaces/instant-claim',
      expect.objectContaining({
        body: expect.objectContaining({
          slug: name.toLowerCase(),
          templateId: 'audiovisual-production',
        }),
      })
    )
  }
)
