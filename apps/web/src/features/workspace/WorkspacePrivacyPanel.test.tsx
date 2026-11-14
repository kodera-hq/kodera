import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
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
  await i18n.changeLanguage('fr')
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
      screen.getByText(/`Invoice`, `CreditNote`, `Payment`.*`LegalDocument` \/ `Dpa`.*`purge_after`/)
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
    await waitFor(() =>
      expect(apiMocks.requestWorkspaceDeletion).toHaveBeenCalledWith('org-1', {})
    )
    expect(
      await screen.findByText('Contenu purgé · Rétention légale comptable active')
    ).toBeVisible()
    expect(screen.getByText(/2036/)).toBeVisible()

    // Non-owner member sees owner-only restriction for workspace scope + full EN parity
    await i18n.changeLanguage('en')
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
})
