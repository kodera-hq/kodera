import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { KoderaPassportModal } from './KoderaPassportModal'
import { EMPTY_PASSPORT } from './passport'

function renderModal(onSave = vi.fn(async () => undefined), onDismiss = vi.fn()) {
  render(
    <KoderaPassportModal
      open
      userId="@32dc:kodera.test"
      initialName=""
      initialPassport={EMPTY_PASSPORT}
      roleLabel="Membre"
      onSave={onSave}
      onDismiss={onDismiss}
    />
  )
  return { onSave, onDismiss }
}

describe('KoderaPassportModal', () => {
  it('draws the passport others will see beside the form, as it is typed', async () => {
    const user = userEvent.setup()
    renderModal()
    const preview = screen.getByRole('region', { name: 'Aperçu de votre passeport' })
    expect(within(preview).getByRole('heading', { name: 'Votre nom' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Nom affiché'), 'Miguel Victoria')
    await user.type(screen.getByLabelText('Statut ou courte bio'), 'Design, sons et lumière')
    await user.type(screen.getByLabelText('Étiquettes, séparées par des virgules'), 'design, son')
    await user.click(screen.getByRole('radio', { name: 'Couleur 3' }))
    expect(within(preview).getByRole('heading', { name: 'Miguel Victoria' })).toBeInTheDocument()
    expect(within(preview).getByText('Design, sons et lumière')).toBeInTheDocument()
    expect(within(preview).getByText('design')).toBeInTheDocument()
    expect(within(preview).getByText('Membre')).toBeInTheDocument()
    expect(preview.querySelector('[data-passport-accent="t2"]')).not.toBeNull()
  })

  it('animates only a decorative monogram, hidden from assistive technology', () => {
    renderModal()
    const monogram = screen.getByTestId('passport-monogram')
    expect(monogram).toHaveAttribute('aria-hidden', 'true')
    expect(monogram).toHaveClass('passport-monogram')
    expect(monogram.getAttribute('style')).toBeNull()
  })

  it('refuses an empty name, then saves the passport as onboarded', async () => {
    const user = userEvent.setup()
    const { onSave } = renderModal()
    await user.click(screen.getByRole('button', { name: 'Enregistrer mon passeport' }))
    expect(screen.getByLabelText('Nom affiché')).toHaveAttribute('aria-invalid', 'true')
    expect(onSave).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Nom affiché'), '  Ana  ')
    await user.click(screen.getByRole('button', { name: 'Enregistrer mon passeport' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        displayName: 'Ana',
        avatar: null,
        passport: { accent: 'cobalt', bio: '', tags: [], onboarded: true },
      })
    )
  })

  it('says so when saving fails, and « Plus tard » dismisses it', async () => {
    const user = userEvent.setup()
    const { onDismiss } = renderModal(vi.fn(async () => Promise.reject(new Error('down'))))
    await user.type(screen.getByLabelText('Nom affiché'), 'Ana')
    await user.click(screen.getByRole('button', { name: 'Enregistrer mon passeport' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('n’a pas pu être enregistré')
    await user.click(screen.getAllByRole('button', { name: 'Plus tard' })[0]!)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('rejects disguised SVGs and >4096x4096 decompression bombs before URL.createObjectURL', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    try {
      renderModal()
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      const disguisedSvg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'evil.png', {
        type: 'image/png',
      })
      fireEvent.change(input, { target: { files: [disguisedSvg] } })
      expect(await screen.findByRole('alert')).toHaveTextContent('PNG, JPEG ou WebP')
      expect(createUrl).not.toHaveBeenCalled()

      // Craft a minimal PNG header claiming 8192 x 8192 pixels (> 4096 limit).
      const bomb = new Uint8Array(24)
      bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      const view = new DataView(bomb.buffer)
      view.setUint32(8, 13, false)
      bomb.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
      view.setUint32(16, 8192, false)
      view.setUint32(20, 8192, false)
      const bombFile = new File([bomb], 'bomb.png', { type: 'image/png' })
      fireEvent.change(input, { target: { files: [bombFile] } })
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('PNG, JPEG ou WebP'))
      expect(createUrl).not.toHaveBeenCalled()
    } finally {
      createUrl.mockRestore()
    }
  })
})
