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
  it('edits identity, previews and removes a bounded raster logo, and saves preferences atomically', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace-logo')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    const name = await screen.findByRole('textbox', { name: 'Nom de l’espace' })
    await user.clear(name)
    await user.type(name, 'Workshop')
    const preview = screen.getByRole('figure', { name: 'Aperçu de la carte de l’espace' })
    expect(within(preview).getByText('Workshop')).toBeVisible()
    const upload = screen.getByLabelText('Logo de l’espace')
    await user.upload(upload, new File(['raster bytes'], 'logo.png', { type: 'image/png' }))
    await waitFor(() =>
      expect(preview.querySelector('img')).toHaveAttribute('src', 'blob:workspace-logo')
    )
    await user.selectOptions(screen.getByLabelText('Mode d’affichage par défaut'), 'messages')
    await user.click(screen.getByLabelText('Aperçus de liens'))
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(api.updateWorkspaceProfile).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          display_name: 'Workshop',
          logo_url: expect.stringMatching(/^data:image\/png;base64,/),
          default_ui_mode: 'messages',
          allow_link_previews: false,
        }),
        '"p1"'
      )
    )
    await user.click(screen.getByRole('button', { name: 'Supprimer le logo' }))
    expect(preview.querySelector('img')).toBeNull()
    create.mockRestore()
    revoke.mockRestore()
  })

  it('refuses oversized logos before reading or saving them', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    await screen.findByRole('textbox', { name: 'Nom de l’espace' })
    await user.upload(
      screen.getByLabelText('Logo de l’espace'),
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
    )
    expect(await screen.findByText(/Choisissez une image/)).toBeVisible()
    expect(api.updateWorkspaceProfile).not.toHaveBeenCalled()
  })

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
    expect(patch.display_name).toBe('')
    expect(patch.traits.map((trait: { label: string }) => trait.label)).toEqual([
      'R&D',
      'Design',
      'Marketing',
      'Communauté',
    ])
    expect(await screen.findByText('Modifications enregistrées.')).toBeVisible()
  })

  it('allows clearing a custom display name back to follow the organisation name', async () => {
    const user = userEvent.setup()
    api.getWorkspaceProfile.mockResolvedValue({
      value: { ...PROFILE, display_name: 'Studio' },
      etag: '"etag-custom"',
    })
    renderPanel(<WorkspaceProfilePanel organisationId={ORG} organisationName="Acme" canEdit />)
    const name = await screen.findByRole('textbox', { name: 'Nom de l’espace' })
    expect(name).toHaveValue('Studio')
    await user.clear(name)
    const preview = screen.getByRole('figure', { name: 'Aperçu de la carte de l’espace' })
    expect(within(preview).getByText('Acme')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(api.updateWorkspaceProfile).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ display_name: '' }),
        '"etag-custom"'
      )
    )
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
