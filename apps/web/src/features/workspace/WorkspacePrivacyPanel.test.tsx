import { registerSecuritySessionCleanup } from '../security/localSecuritySession'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import {
  hasTelemetryConsent,
  setTelemetryConsent,
  setTelemetryScope,
} from '../../analytics/telemetry/consent'
import { ApiProblem } from '../../api/client'
import type * as PrivacyApiModule from './privacyApi'
import { WorkspacePrivacyPanel } from './WorkspacePrivacyPanel'

const apiMocks = vi.hoisted(() => ({
  requestAccountExport: vi.fn(),
  getAccountExport: vi.fn(),
  getAccountExportDownloadLink: vi.fn(),
  requestWorkspaceExport: vi.fn(),
  getWorkspaceExport: vi.fn(),
  getWorkspaceExportDownloadLink: vi.fn(),
  requestWorkspaceDeletion: vi.fn(),
  getWorkspaceDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
  getAccountDeletion: vi.fn(),
}))

vi.mock('./privacyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof PrivacyApiModule>()
  return {
    ...actual,
    ...apiMocks,
  }
})

const ownerRole = 'org_owner' as const
const memberRole = 'org_member' as const

beforeEach(async () => {
  await i18n.changeLanguage('fr')
  vi.spyOn(window, 'open').mockReturnValue(null)
  for (const fn of Object.values(apiMocks)) fn.mockReset()
})

afterEach(async () => {
  act(() => {
    setTelemetryScope(undefined)
  })
  localStorage.clear()
  vi.unstubAllEnvs()
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
  vi.restoreAllMocks()
})

describe('WorkspacePrivacyPanel GDPR Art. 20 exports & Art. 17 erasure', () => {
  it('progresses GDPR export from queued -> ready -> download and surfaces 503 / legal_hold states', async () => {
    const user = userEvent.setup()
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString()

    apiMocks.requestWorkspaceExport.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000010',
      scope: 'workspace',
      kind: 'export',
      status: 'queued',
      requestedAt: '2026-11-13T12:00:00Z',
      updatedAt: '2026-11-13T12:00:00Z',
      expiresAt: null,
      purgeAfter: null,
      failureCode: null,
    })

    apiMocks.getWorkspaceExport.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000010',
      scope: 'workspace',
      kind: 'export',
      status: 'ready',
      requestedAt: '2026-11-13T12:00:00Z',
      updatedAt: '2026-11-13T12:02:00Z',
      expiresAt: futureExpiry,
      purgeAfter: null,
      failureCode: null,
    })

    apiMocks.getWorkspaceExportDownloadLink.mockResolvedValueOnce({
      url: 'https://storage.example.test/privacy/workspace-export.zip',
      expires_at: futureExpiry,
      content_type: 'application/zip',
    })

    const { container } = render(
      <WorkspacePrivacyPanel org="acme-sa" organisationId="org-1" role={ownerRole} />
    )

    await user.click(screen.getByRole('button', { name: 'Préparer l’export de l’espace' }))
    expect(apiMocks.requestWorkspaceExport).toHaveBeenCalledWith('org-1', { includeMedia: true })
    expect(await screen.findByText('En file d’attente')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Actualiser l’état' }))
    expect(await screen.findByText('Prêt au téléchargement')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Télécharger l’archive ZIP signée' }))
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://storage.example.test/privacy/workspace-export.zip',
        '_blank',
        'noopener,noreferrer'
      )
    )

    // Verify 503 proof-unavailable hold state on account export
    apiMocks.requestAccountExport.mockRejectedValueOnce(
      new ApiProblem({
        type: 'https://kodera.io/problems/service-unavailable',
        title: 'Proof unavailable',
        status: 503,
      })
    )
    await user.click(screen.getByRole('button', { name: 'Préparer mon export personnel' }))
    expect(
      await screen.findByText(/En attente \(HTTP 503 — preuve ou stockage indisponible\)/)
    ).toBeVisible()

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('enforces exact slug re-entry confirmation and discloses Code de commerce L123-22 statutory retention in FR and EN', async () => {
    const user = userEvent.setup()

    apiMocks.requestWorkspaceDeletion.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000020',
      scope: 'workspace',
      kind: 'deletion',
      status: 'retention_pending',
      requestedAt: '2026-11-13T12:10:00Z',
      updatedAt: '2026-11-13T12:11:00Z',
      expiresAt: null,
      purgeAfter: '2036-11-13T12:10:00Z',
      failureCode: null,
    })

    const { container, rerender } = render(
      <WorkspacePrivacyPanel
        org="acme-sa"
        organisationId="org-1"
        role={ownerRole}
        initialAccountExport={{
          id: '00000000-0000-7000-8000-000000000099',
          scope: 'account',
          kind: 'export',
          status: 'failed',
          requestedAt: '2026-11-13T12:00:00Z',
          updatedAt: '2026-11-13T12:05:00Z',
          expiresAt: null,
          purgeAfter: null,
          failureCode: 'legal_hold',
        }}
      />
    )

    // Legal hold is explicitly disclosed
    expect(screen.getByText(/Conservation légale active \(legal hold\)/)).toBeVisible()

    // Statutory retention notice names Invoice, CreditNote, Payment, LegalDocument / Dpa, purge_after, and L123-22
    expect(screen.getByText(/Code de commerce L123-22/)).toBeVisible()
    expect(
      screen.getByText(
        /`Invoice`, `CreditNote`, `Payment`.*`LegalDocument` \/ `Dpa`.*`purge_after`/
      )
    ).toBeVisible()

    const confirmButton = screen.getByRole('button', {
      name: 'Confirmer la suppression de l’espace',
    })
    expect(confirmButton).toBeDisabled()

    const slugInputs = screen.getAllByLabelText(
      'Saisissez « acme-sa » pour confirmer la suppression'
    )
    await user.type(slugInputs[0]!, 'wrong-slug')
    expect(confirmButton).toBeDisabled()

    await user.clear(slugInputs[0]!)
    await user.type(slugInputs[0]!, 'acme-sa')
    expect(confirmButton).toBeEnabled()

    await user.click(confirmButton)
    await waitFor(() => expect(apiMocks.requestWorkspaceDeletion).toHaveBeenCalledWith('org-1', {}))
    expect(
      await screen.findByText('Contenu purgé · Rétention légale comptable active')
    ).toBeVisible()
    expect(screen.getByText(/2036/)).toBeVisible()

    // Non-owner member sees owner-only restriction for workspace scope + full EN parity
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    rerender(<WorkspacePrivacyPanel org="acme-sa" organisationId="org-1" role={memberRole} />)

    expect(
      screen.getByText(/Mandatory statutory accounting retention \(Code de commerce L123-22\)/)
    ).toBeVisible()
    expect(
      screen.getAllByText(/Only the current organisation owner \(`org_owner`\)/).length
    ).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('button', { name: 'Confirm workspace deletion' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm my account deletion' })).toBeDisabled()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('revokes active telemetry consent and purges localStorage consent keys on GDPR Art. 17 workspace or account deletion', async () => {
    const user = userEvent.setup()
    vi.stubEnv('VITE_POSTHOG_KEY', 'public-project-key')
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com')

    setTelemetryScope({ person: 'person-1', workspace: 'org-1', slug: 'acme-sa' })
    setTelemetryConsent(true)
    setTelemetryScope({ person: 'person-2', workspace: 'org-1', slug: 'acme-sa' })
    setTelemetryConsent(true)
    setTelemetryScope({ person: 'person-1', workspace: 'org-2', slug: 'beta-btp' })
    setTelemetryConsent(true)
    setTelemetryScope({ person: 'person-1', workspace: 'org-1', slug: 'acme-sa' })
    expect(hasTelemetryConsent()).toBe(true)

    const { unmount } = render(
      <WorkspacePrivacyPanel
        org="acme-sa"
        organisationId="org-1"
        personId="person-1"
        role={ownerRole}
      />
    )

    const toggle = screen.getByRole('switch', {
      name: 'Autoriser les diagnostics facultatifs pour cet espace',
    })
    expect(toggle).toBeChecked()

    const retireSecurity = vi.fn()
    const unregisterSecurity = registerSecuritySessionCleanup(retireSecurity)

    // Rejected deletion (HTTP 409) does not purge consent
    apiMocks.requestWorkspaceDeletion.mockRejectedValueOnce(
      new ApiProblem({
        type: 'https://kodera.io/problems/conflict',
        title: 'Last owner',
        status: 409,
      })
    )
    const slugInputs = screen.getAllByLabelText(
      'Saisissez « acme-sa » pour confirmer la suppression'
    )
    await user.type(slugInputs[0]!, 'acme-sa')
    await user.click(screen.getByRole('button', { name: 'Confirmer la suppression de l’espace' }))
    expect(await screen.findByText(/Suppression refusée \(HTTP 409\)/)).toBeVisible()
    expect(hasTelemetryConsent()).toBe(true)
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-1","org-1"]')).toBe('yes')

    expect(retireSecurity).not.toHaveBeenCalled()

    // Accepted workspace deletion revokes active consent and purges all org-1 consent keys
    apiMocks.requestWorkspaceDeletion.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000030',
      scope: 'workspace',
      kind: 'deletion',
      status: 'queued',
      requestedAt: '2026-11-13T12:10:00Z',
      updatedAt: '2026-11-13T12:10:00Z',
      expiresAt: null,
      purgeAfter: null,
      failureCode: null,
    })
    await user.click(screen.getByRole('button', { name: 'Confirmer la suppression de l’espace' }))
    await waitFor(() => expect(hasTelemetryConsent()).toBe(false))
    expect(retireSecurity).toHaveBeenCalledTimes(1)
    expect(toggle).not.toBeChecked()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-1","org-1"]')).toBeNull()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-2","org-1"]')).toBeNull()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-1","org-2"]')).toBe('yes')

    unmount()

    // Accepted account deletion purges all workspaces for person-1 while preserving person-2
    setTelemetryScope({ person: 'person-1', workspace: 'org-1', slug: 'acme-sa' })
    setTelemetryConsent(true)
    setTelemetryScope({ person: 'person-2', workspace: 'org-2', slug: 'beta-btp' })
    setTelemetryConsent(true)
    setTelemetryScope({ person: 'person-1', workspace: 'org-1', slug: 'acme-sa' })
    expect(hasTelemetryConsent()).toBe(true)

    apiMocks.requestAccountDeletion.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000031',
      scope: 'account',
      kind: 'deletion',
      status: 'queued',
      requestedAt: '2026-11-13T12:15:00Z',
      updatedAt: '2026-11-13T12:15:00Z',
      expiresAt: null,
      purgeAfter: null,
      failureCode: null,
    })

    render(
      <WorkspacePrivacyPanel
        org="acme-sa"
        organisationId="org-1"
        personId="person-1"
        role={memberRole}
      />
    )

    await user.type(
      screen.getByLabelText('Saisissez « acme-sa » pour confirmer la suppression'),
      'acme-sa'
    )
    await user.click(screen.getByRole('button', { name: 'Confirmer la suppression de mon compte' }))
    await waitFor(() => expect(hasTelemetryConsent()).toBe(false))
    expect(retireSecurity).toHaveBeenCalledTimes(2)
    unregisterSecurity()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-1","org-1"]')).toBeNull()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-1","org-2"]')).toBeNull()
    expect(localStorage.getItem('kodera.telemetry.consent.v1:["person-2","org-2"]')).toBe('yes')
  })
})

it.each(['fr', 'en'])('gives a direct GDPR contact for held requests in %s', async (locale) => {
  await i18n.changeLanguage(locale)
  apiMocks.requestAccountExport.mockRejectedValueOnce(
    new ApiProblem({
      type: 'https://kodera.io/problems/service-unavailable',
      title: 'Service unavailable',
      status: 503,
      requestId: 'privacy-hold-test',
    })
  )
  const user = userEvent.setup()
  render(
    <WorkspacePrivacyPanel
      organisationId="00000000-0000-7000-8000-000000000001"
      org="example"
      role={memberRole}
    />
  )
  await user.click(
    screen.getByRole('button', {
      name: locale === 'fr' ? 'Préparer mon export personnel' : 'Request my account export',
    })
  )
  expect(await screen.findByText(/support@kodera.io/)).toHaveTextContent(
    locale === 'fr' ? /actuellement suspendues/ : /currently on hold/
  )
})
