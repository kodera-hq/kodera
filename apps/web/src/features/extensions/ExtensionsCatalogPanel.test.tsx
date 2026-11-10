import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionsCatalogPanel } from './ExtensionsCatalogPanel'
import {
  EXTENSION_CATEGORY_FILTERS,
  EXTENSION_SCHEMA_VERSION,
  OFFICIAL_EXTENSIONS,
  OFFICIAL_EXTENSIONS_CATALOG,
  isAllowedExtensionWebhookUrl,
} from './catalog'

describe('ExtensionsCatalogPanel & catalog', () => {
  it('defines the ten official kodera.extension.v1 extensions, their slash commands, and categories', () => {
    expect(EXTENSION_SCHEMA_VERSION).toBe('kodera.extension.v1')
    expect(OFFICIAL_EXTENSIONS).toBe(OFFICIAL_EXTENSIONS_CATALOG)
    expect(OFFICIAL_EXTENSIONS_CATALOG).toHaveLength(10)

    expect(
      OFFICIAL_EXTENSIONS_CATALOG.map((ext) => ({
        id: ext.id,
        slashCommand: ext.slashCommand,
        category: ext.category,
      }))
    ).toEqual([
      {
        id: 'io.kodera.ext.frameio-review-bridge',
        slashCommand: '/frameio-review',
        category: 'productivity',
      },
      { id: 'io.kodera.ext.hello-webhook', slashCommand: '/hello', category: 'devops' },
      {
        id: 'io.kodera.ext.github-release-notifier',
        slashCommand: '/release-notes',
        category: 'devops',
      },
      {
        id: 'io.kodera.ext.uptime-incident-bridge',
        slashCommand: '/incident',
        category: 'devops',
      },
      {
        id: 'io.kodera.ext.docs-collab-announcer',
        slashCommand: '/doc-pad',
        category: 'productivity',
      },
      {
        id: 'io.kodera.ext.github-repo-tracker',
        slashCommand: '/github-track',
        category: 'devops',
      },
      {
        id: 'io.kodera.ext.qonto-treasury-feed',
        slashCommand: '/qonto-feed',
        category: 'finance',
      },
      {
        id: 'io.kodera.ext.notion-workspace-bridge',
        slashCommand: '/notion-page',
        category: 'productivity',
      },
      {
        id: 'io.kodera.ext.gdrive-document-share',
        slashCommand: '/gdrive-share',
        category: 'productivity',
      },
      {
        id: 'io.kodera.ext.social-pulse-bridge',
        slashCommand: '/social-post',
        category: 'social',
      },
    ])

    for (const ext of OFFICIAL_EXTENSIONS_CATALOG) {
      expect(ext.schemaVersion).toBe('kodera.extension.v1')
      expect(ext.scopes).toContain('messages:write')
      expect(ext.scopes).toContain('commands:register')
      expect(ext.scopes).toContain('webhooks:incoming')
    }
  })

  it('enforces pure HTTPS and anti-SSRF rules in isAllowedExtensionWebhookUrl', () => {
    expect(isAllowedExtensionWebhookUrl('https://hooks.exemple-organisation.fr/kodera/hello')).toBe(
      true
    )
    expect(isAllowedExtensionWebhookUrl('https://93.184.216.34/webhook')).toBe(true)

    const forbiddenUrls = [
      'http://hooks.exemple-organisation.fr/kodera/hello',
      'https://user:secret@hooks.exemple-organisation.fr/kodera/hello',
      'https://localhost/webhook',
      'https://bot.localhost/webhook',
      'https://bot.local/webhook',
      'https://bot.internal/webhook',
      'https://127.0.0.1/webhook',
      'https://10.0.0.42/webhook',
      'https://172.16.10.5/webhook',
      'https://192.168.1.20/webhook',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.10/webhook',
      'https://[::1]/webhook',
      'https://[fe80::1]/webhook',
      'https://[fd12:3456:789a::1]/webhook',
      'https://[::ffff:127.0.0.1]/webhook',
      'https://[::ffff:169.254.169.254]/webhook',
      'https://redis/webhook',
    ]

    for (const badUrl of forbiddenUrls) {
      expect(isAllowedExtensionWebhookUrl(badUrl)).toBe(false)
    }
  })

  it('renders all 10 official extensions, filters by category pills, switches inspected extension, and fails closed on http:// or private IPs', async () => {
    const user = userEvent.setup()
    const onWebhookValidated = vi.fn()

    render(<ExtensionsCatalogPanel onWebhookValidated={onWebhookValidated} />)

    expect(
      screen.getByRole('heading', { name: "Catalogue d'extensions Kodera v1" })
    ).toBeInTheDocument()
    expect(screen.getByText('10 extensions officielles')).toBeInTheDocument()

    // Verify all 5 category filter pills are rendered
    const filterGroup = screen.getByRole('group', { name: "Filtrer par catégorie d'extension" })
    for (const filter of EXTENSION_CATEGORY_FILTERS) {
      expect(within(filterGroup).getByRole('button', { name: filter.label })).toBeInTheDocument()
    }

    for (const ext of OFFICIAL_EXTENSIONS_CATALOG) {
      expect(screen.getAllByText(new RegExp(ext.id)).length).toBeGreaterThanOrEqual(1)
    }

    // Filter by Finance (Qonto)
    await user.click(within(filterGroup).getByRole('button', { name: 'Finance (Qonto)' }))
    expect(within(filterGroup).getByRole('button', { name: 'Finance (Qonto)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.getAllByText(/io\.kodera\.ext\.qonto-treasury-feed/).length
    ).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('io.kodera.ext.hello-webhook')).toBeNull()

    // Filter by Productivité (Docs / Notion / GDrive)
    await user.click(
      within(filterGroup).getByRole('button', { name: 'Productivité (Docs / Notion / GDrive)' })
    )
    expect(
      screen.getAllByText(/io\.kodera\.ext\.docs-collab-announcer/).length
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getAllByText(/io\.kodera\.ext\.notion-workspace-bridge/).length
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getAllByText(/io\.kodera\.ext\.gdrive-document-share/).length
    ).toBeGreaterThanOrEqual(1)

    // Filter by Réseaux Sociaux (X / Mastodon / Insta)
    await user.click(
      within(filterGroup).getByRole('button', { name: 'Réseaux Sociaux (X / Mastodon / Insta)' })
    )
    expect(
      screen.getAllByText(/io\.kodera\.ext\.social-pulse-bridge/).length
    ).toBeGreaterThanOrEqual(1)

    // Reset filter to Toutes
    await user.click(within(filterGroup).getByRole('button', { name: 'Toutes' }))
    expect(within(filterGroup).getByRole('button', { name: 'Toutes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    for (const scope of ['messages:write', 'commands:register', 'webhooks:incoming']) {
      expect(screen.getAllByText(scope).length).toBeGreaterThanOrEqual(1)
    }

    await user.type(
      screen.getByLabelText('Secret de signature de test'),
      'whsec_temporary_test_value'
    )
    await user.click(screen.getByRole('button', { name: /Pont d'incidents & supervision/i }))
    expect(screen.getByLabelText('Secret de signature de test')).toHaveValue('')
    expect(screen.getByText(/\/incident \[open\|ack\|resolve\] <titre>/i)).toBeInTheDocument()

    const urlInput = screen.getByLabelText(/URL de destination du webhook/i)
    const verifyBtn = screen.getByRole('button', { name: "Vérifier l'URL du webhook" })

    await user.type(urlInput, 'http://hooks.exemple.fr/insecure')
    await user.click(verifyBtn)

    expect(screen.getByRole('alert')).toHaveTextContent(/SSRF_INSECURE_PROTOCOL/i)
    expect(onWebhookValidated).not.toHaveBeenCalled()

    await user.clear(urlInput)
    await user.type(urlInput, 'https://169.254.169.254/latest/meta-data')
    await user.click(verifyBtn)

    expect(screen.getByRole('alert')).toHaveTextContent(/SSRF_FORBIDDEN_IP/i)
    expect(onWebhookValidated).not.toHaveBeenCalled()

    await user.clear(urlInput)
    await user.type(urlInput, 'https://hooks.exemple-organisation.fr/kodera/incidents')
    await user.click(verifyBtn)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(
      'https://hooks.exemple-organisation.fr/kodera/incidents'
    )
    expect(onWebhookValidated).toHaveBeenCalledWith(
      'io.kodera.ext.uptime-incident-bridge',
      'https://hooks.exemple-organisation.fr/kodera/incidents'
    )
    await user.type(urlInput, '/changed')
    expect(screen.queryByTestId('extension-webhook-valid')).toBeNull()
  })
})
