import { studioMessages } from '../workspace/studioMessages'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { DocsWorkspacePanel } from './DocsWorkspacePanel'
import type { ChannelDocsPadDescriptor } from './types'
import { buildChannelDocsPadUrl } from './url'

describe('DocsWorkspacePanel', () => {
  it('does not synthesize a dead docs.<host> external link when no channel pads are provided (issue 220)', () => {
    render(
      <DocsWorkspacePanel
        tenantSlug="acme-fr"
        channelId="chan-general-01"
        channelName="Général & Équipe"
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Docs — Documents collaboratifs' })
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Notes — Général & Équipe' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Ouvrir Notes/i })).toBeNull()
  })

  it('switches between linked channel pads and copies the canonical URL', async () => {
    const user = userEvent.setup()
    const onSelectPad = vi.fn()
    const onCopyPadLink = vi.fn()

    const pads: readonly ChannelDocsPadDescriptor[] = [
      {
        id: 'pad-1',
        title: 'Feuille de route Q4',
        channelId: 'chan-product',
        channelName: 'Produit',
        padSlug: 'feuille-de-route-q4',
        url: buildChannelDocsPadUrl({
          tenantSlug: 'acme-fr',
          channelId: 'chan-product',
          channelName: 'Feuille de route Q4',
          docId: 'pad-1',
        }),
        updatedAtLabel: '14:20',
      },
      {
        id: 'pad-2',
        title: 'Compte-rendu architecture',
        channelId: 'chan-product',
        channelName: 'Produit',
        padSlug: 'compte-rendu-architecture',
        url: buildChannelDocsPadUrl({
          tenantSlug: 'acme-fr',
          channelId: 'chan-product',
          channelName: 'Compte-rendu architecture',
          docId: 'pad-2',
        }),
        updatedAtLabel: 'Hier',
      },
    ]

    render(
      <DocsWorkspacePanel
        tenantSlug="acme-fr"
        channelId="chan-product"
        channelName="Produit"
        pads={pads}
        onSelectPad={onSelectPad}
        onCopyPadLink={onCopyPadLink}
      />
    )

    const secondPadBtn = screen.getByRole('button', { name: /Compte-rendu architecture/i })
    await user.click(secondPadBtn)

    expect(onSelectPad).toHaveBeenCalledWith('pad-2')
    expect(secondPadBtn).toHaveAttribute('aria-current', 'true')

    const copyBtn = screen.getByRole('button', {
      name: /Copier le lien du document Compte-rendu architecture/i,
    })
    await user.click(copyBtn)

    expect(onCopyPadLink).toHaveBeenCalledWith(pads[1]!.url)
    expect(screen.getByRole('button', { name: /Copier le lien/i })).toHaveTextContent('Lien copié')
  })

  it('falls back to the canonical channel pad URL if a provided pad URL targets an untrusted origin', () => {
    const maliciousPads: readonly ChannelDocsPadDescriptor[] = [
      {
        id: 'pad-untrusted',
        title: 'Doc Externe',
        channelId: 'chan-sec',
        channelName: 'Sécurité',
        padSlug: 'doc-externe',
        url: 'https://evil.example.com/pads/phishing',
      },
    ]

    render(
      <DocsWorkspacePanel
        tenantSlug="acme-fr"
        channelId="chan-sec"
        channelName="Sécurité"
        pads={maliciousPads}
      />
    )

    const openLink = screen.getByRole('link', { name: /Ouvrir Doc Externe dans Docs/i })
    expect(openLink.getAttribute('href')).toMatch(
      /^https:\/\/docs\.acme-fr\.kodera\.io\/pads\/securite-[0-9a-f]{8}$/
    )
  })

  it('creates a new collaborative pad for the active channel', async () => {
    const user = userEvent.setup()
    const onCreatePad = vi.fn()

    render(
      <DocsWorkspacePanel
        tenantSlug="acme-fr"
        channelId="chan-ops"
        channelName="Opérations"
        onCreatePad={onCreatePad}
      />
    )

    const input = screen.getByLabelText('Nouveau document collaboratif')
    const createBtn = screen.getByRole('button', { name: 'Créer le pad' })
    expect(createBtn).toBeDisabled()

    await user.type(input, 'Bilan Incident Production')
    expect(createBtn).not.toBeDisabled()

    await user.click(createBtn)

    expect(onCreatePad).toHaveBeenCalledTimes(1)
    const created = onCreatePad.mock.calls[0]?.[0] as ChannelDocsPadDescriptor
    expect(created.title).toBe('Bilan Incident Production')
    expect(created.padSlug).toBe('bilan-incident-production')
    expect(created.url).toMatch(
      /^https:\/\/docs\.acme-fr\.kodera\.io\/pads\/bilan-incident-production-[0-9a-f]{8}$/
    )
  })

  it('claims no live co-editing: the draft is labelled in development and local', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <DocsWorkspacePanel tenantSlug="acme-fr" channelId="chan-ops" channelName="Opérations" />
    )

    expect(container.textContent).not.toMatch(
      /Yjs|CRDT|temps réel|Instance dédiée|Modifié en direct/i
    )
    expect(screen.getByText('En développement')).toBeInTheDocument()
    expect(screen.getByTestId('docs-inline-notice')).toHaveTextContent(
      'La co-édition en direct est en développement'
    )
    expect(screen.getByTestId('docs-inline-save-badge')).toHaveTextContent(
      'Brouillon local, non partagé'
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Style de titre' }), 'h3')
    expect((screen.getByTestId('docs-inline-textarea') as HTMLTextAreaElement).value).toContain(
      '### '
    )
    expect(screen.getByTestId('docs-inline-save-badge')).toHaveTextContent(
      'Brouillon modifié, non partagé'
    )
    expect(screen.queryByRole('button', { name: 'Partager' })).toBeNull()
    // Redundant extra local disclaimers inside MarkdownDraftEditor are collapsed into the single banner
    expect(screen.queryByText(studioMessages.fr.shareGap)).toBeNull()
    expect(screen.queryByText(studioMessages.fr.local)).toBeNull()
    // Edit / Preview toggle switches cleanly without stacking both panes vertically
    await user.click(screen.getByTestId('docs-draft-mode-preview'))
    expect(screen.queryByTestId('docs-inline-textarea')).toBeNull()
    await user.click(screen.getByTestId('docs-draft-mode-edit'))
    expect(screen.getByTestId('docs-inline-textarea')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Yjs|CRDT/i)
  })
})
