import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as IamApiModule from '../iamApi'
import '../../../i18n'
import { ApiProblem } from '../../../api/client'
import { MAX_TRAITS, ROLE_SWATCHES, WorkspaceProfilePanel } from './WorkspaceProfilePanel'
import { ORG, PROFILE, renderPanel } from './test-support'

const api = vi.hoisted(() => ({ getWorkspaceProfile: vi.fn(), updateWorkspaceProfile: vi.fn() }))
vi.mock('../iamApi', async (actual) => ({
  ...(await actual<typeof IamApiModule>()),
  ...api,
}))

beforeEach(() => {
  vi.clearAllMocks()
  api.getWorkspaceProfile.mockResolvedValue({ value: PROFILE, etag: '"p1"' })
  api.updateWorkspaceProfile.mockImplementation(async (_org, patch) => ({
    value: { ...PROFILE, ...patch },
    etag: '"p2"',
  }))
})

describe('Profil de l’espace', () => {
  it('updates the preview card live while the description, banner and traits change', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    const preview = await screen.findByRole('figure', { name: 'Aperçu de la carte de l’espace' })
    expect(within(preview).getByText('Acme')).toBeVisible()
    expect(within(preview).getByText('Atelier produit')).toBeVisible()
    const description = screen.getByRole('textbox', { name: 'Description' })
    await user.clear(description)
    await user.type(description, 'Chantiers & bureaux')
    expect(within(preview).getByText('Chantiers & bureaux')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Bannière cobalt' }))
    expect(screen.getByRole('button', { name: 'Bannière cobalt' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(preview).getByTestId('preview-banner')).toHaveAttribute('data-preset', 'cobalt')
    await user.click(screen.getByRole('button', { name: /R&D/u }))
    expect(within(preview).getByRole('list', { name: 'Traits de l’espace' })).toHaveTextContent(
      'R&D'
    )
  })

  it('caps traits at five and saves under the profile’s tag', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    await screen.findByRole('figure', { name: 'Aperçu de la carte de l’espace' })
    for (const name of [/R&D/u, /Design/u, /Marketing/u, /Communauté/u]) {
      await user.click(screen.getByRole('button', { name }))
    }
    expect(screen.getByText(`Traits de l’espace (${MAX_TRAITS}/${MAX_TRAITS})`)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Ajouter le trait' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retirer le trait Tech' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(api.updateWorkspaceProfile).toHaveBeenCalledTimes(1))
    const [, patch, etag] = api.updateWorkspaceProfile.mock.calls[0]!
    expect(etag).toBe('"p1"')
    expect(patch.traits.map((trait: { label: string }) => trait.label)).toEqual([
      'R&D',
      'Design',
      'Marketing',
      'Communauté',
    ])
    expect(await screen.findByText('Modifications enregistrées.')).toBeVisible()
  })

  it('explains a concurrent edit in words and never shows a status code', async () => {
    const user = userEvent.setup()
    api.updateWorkspaceProfile.mockRejectedValue(
      new ApiProblem({ status: 412, type: null, title: 'Precondition Failed' })
    )
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    await user.type(await screen.findByRole('textbox', { name: 'Description' }), '!')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    const notice = await screen.findByText(/Quelqu’un a modifié cet élément/u)
    expect(notice.textContent).not.toMatch(/412|HTTP|Precondition/u)
  })

  it('is read-only for someone who may not edit it', async () => {
    renderPanel(
      <WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit={false} />
    )
    expect(await screen.findByRole('textbox', { name: 'Description' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
  })

  it('draws role swatches from the design tokens only', () => {
    expect(ROLE_SWATCHES.length).toBeGreaterThanOrEqual(6)
    for (const swatch of ROLE_SWATCHES) expect(swatch).toMatch(/^#[0-9a-f]{6}$/u)
  })
})
