import { webcrypto } from 'node:crypto'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { DocsWorkspacePanel } from './DocsWorkspacePanel'
import { DeveloperDocsHub } from './DeveloperDocsHub'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
it('keeps the team draft when switching to developer docs and back', async () => {
  const user = userEvent.setup()
  render(<DocsWorkspacePanel tenantSlug="bureau" channelId="general" channelName="général" />)
  await user.type(screen.getByTestId('docs-inline-textarea'), '\nA draft to keep')
  const kept = (screen.getByTestId('docs-inline-textarea') as HTMLTextAreaElement).value
  await user.click(
    screen.getByRole('button', { name: 'Documentation développeur & API (Docs-as-Code)' })
  )
  expect(
    screen.getByRole('heading', { name: 'Quickstart & auto-hébergement', level: 2 })
  ).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Pads de l’équipe' }))
  expect(screen.getByTestId('docs-inline-textarea')).toHaveValue(kept)
  expect(kept).toContain('A draft to keep')
})
it('filters the reference, reports no result and opens the matching source-linked page', async () => {
  const user = userEvent.setup()
  render(<DeveloperDocsHub />)
  const search = screen.getByRole('searchbox', { name: 'Rechercher dans la documentation' })
  await user.type(search, 'qonto')
  await user.click(screen.getByRole('button', { name: 'Extension SDK & 22 connecteurs' }))
  expect(
    screen.getByRole('heading', { name: 'Extension SDK & 22 connecteurs', level: 2 })
  ).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /packages\/extension-sdk\/README.md/ })).toHaveAttribute(
    'href',
    'https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md'
  )
  await user.clear(search)
  await user.type(search, 'unfindable-reference')
  expect(screen.getByText('Aucune fiche ne correspond à votre recherche.')).toBeInTheDocument()
})
it('copies the full Markdown only after clipboard fulfillment and previews llms.txt', async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  render(<DeveloperDocsHub />)
  await user.click(screen.getByRole('button', { name: 'Copier le Markdown pour agent IA (LLM)' }))
  expect(write).toHaveBeenCalledWith(expect.stringContaining('# Quickstart & auto-hébergement'))
  expect(write.mock.calls[0]?.[0]).toContain('deploy/community/README.md')
  expect(await screen.findByText('Copié')).toBeInTheDocument()
  await user.click(screen.getByText('Aperçu de /llms.txt'))
  expect(screen.getByTestId('llms-preview')).toHaveTextContent('# Kodera')
})
it('never reports clipboard denial as success', async () => {
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'))
  render(<DeveloperDocsHub />)
  await user.click(screen.getByRole('button', { name: 'Copier le Markdown pour agent IA (LLM)' }))
  expect(
    await screen.findByText('Copie indisponible. Sélectionnez le texte pour le copier.')
  ).toBeInTheDocument()
  expect(screen.queryByText('Copié')).toBeNull()
})
it('opens the help discussion associated with the selected page', async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(<DeveloperDocsHub onOpenSupportChannel={open} />)
  await user.click(screen.getByRole('button', { name: 'Ouvrir le salon d’entraide associé' }))
  expect(open).toHaveBeenCalledWith('self-hosting')
})

it('renders both locales and exports the active language', async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  try {
    await i18n.changeLanguage('en')
    render(<DeveloperDocsHub />)
    expect(
      screen.getByRole('heading', { name: 'Quickstart & self-hosting', level: 2 })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy Markdown for a coding agent (LLM)' }))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('# Quickstart & self-hosting'))
  } finally {
    await i18n.changeLanguage('fr')
  }
})
