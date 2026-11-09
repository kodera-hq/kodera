import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FileDrop } from './FileDrop'

const REJECTION_MESSAGE = (reason: 'type' | 'size') =>
  reason === 'type' ? 'Ce type de fichier n’est pas accepté.' : 'Le fichier dépasse 5 Mo.'

function makeFile(name: string, size: number, type: string) {
  const file = new File(['x'.repeat(size)], name, { type })
  return file
}

describe('FileDrop', () => {
  it('is reachable as a button by its visible label', () => {
    render(
      <FileDrop label="Justificatif" rejectionMessage={REJECTION_MESSAGE} removeLabel="Retirer" />
    )

    expect(screen.getByRole('button', { name: 'Justificatif' })).toBeVisible()
  })

  it('opens the file picker on click', async () => {
    const user = userEvent.setup()
    render(
      <FileDrop label="Justificatif" rejectionMessage={REJECTION_MESSAGE} removeLabel="Retirer" />
    )

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    await user.click(screen.getByRole('button', { name: 'Justificatif' }))

    expect(clickSpy).toHaveBeenCalled()
  })

  it('opens the file picker with the keyboard, Tab then Enter', async () => {
    const user = userEvent.setup()
    render(
      <FileDrop label="Justificatif" rejectionMessage={REJECTION_MESSAGE} removeLabel="Retirer" />
    )

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    await user.tab()
    expect(screen.getByRole('button', { name: 'Justificatif' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(clickSpy).toHaveBeenCalled()
  })

  it('lists the chosen file once selected, with a remove action', async () => {
    const onFileChange = vi.fn()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        onFileChange={onFileChange}
      />
    )

    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = makeFile('facture.pdf', 100, 'application/pdf')
    await userEvent.upload(input as HTMLInputElement, file)

    expect(screen.getByText('facture.pdf')).toBeVisible()
    expect(onFileChange).toHaveBeenCalledWith(file)
    expect(screen.queryByRole('button', { name: 'Justificatif' })).not.toBeInTheDocument()
  })

  it('removes the file on the remove action, and calls back with null', async () => {
    const user = userEvent.setup()
    const onFileChange = vi.fn()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer le fichier"
        onFileChange={onFileChange}
      />
    )

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, makeFile('facture.pdf', 100, 'application/pdf'))

    await user.click(screen.getByRole('button', { name: 'Retirer le fichier' }))

    expect(onFileChange).toHaveBeenCalledWith(null)
    expect(screen.getByRole('button', { name: 'Justificatif' })).toBeVisible()
  })

  it('moves focus to the drop zone when the remove action is activated with the keyboard', async () => {
    // The remove control unmounts itself: it is replaced by the drop zone that
    // was there before a file was chosen. Nothing claimed focus in its place,
    // so a keyboard user was returned to `<body>` and had to tab back from the
    // top of the document to the field they were filling in (WCAG 2.4.3).
    const user = userEvent.setup()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer le fichier"
      />
    )

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, makeFile('facture.pdf', 100, 'application/pdf'))

    const remove = screen.getByRole('button', { name: 'Retirer le fichier' })
    remove.focus()
    expect(remove).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(document.activeElement?.tagName).not.toBe('BODY')
    expect(screen.getByRole('button', { name: 'Justificatif' })).toHaveFocus()
  })

  it('rejects a file over maxSize, with the caller’s message', async () => {
    const onFileChange = vi.fn()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        maxSize={5}
        onFileChange={onFileChange}
      />
    )

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, makeFile('gros-fichier.pdf', 10, 'application/pdf'))

    expect(screen.getByRole('alert')).toHaveTextContent('Le fichier dépasse 5 Mo.')
    expect(onFileChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Justificatif' })).toBeVisible()
  })

  it('rejects a file of the wrong type dropped on the zone, with the caller’s message', () => {
    // Dropped, not selected: `userEvent.upload` enforces the native `accept`
    // filter itself and never lets a mismatched file through, the same way a
    // real file picker does — the drop path is exactly where that filter does
    // NOT apply, and where this component's own check has to.
    const onFileChange = vi.fn()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        accept="application/pdf"
        onFileChange={onFileChange}
      />
    )

    const dropzone = screen.getByRole('button', { name: 'Justificatif' })
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [makeFile('image.png', 100, 'image/png')] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Ce type de fichier n’est pas accepté.')
    expect(onFileChange).not.toHaveBeenCalled()
  })

  it('describes the drop zone with the rejection while it stands, and stops once it clears', () => {
    // Read off the DOM and resolved through `document.getElementById`, not
    // recomputed the way the component does: what is being checked is that a
    // screen reader following `aria-describedby` from the zone actually
    // arrives at the rejection text, and stops arriving there once it is gone.
    render(
      <FileDrop
        id="justificatif"
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer le fichier"
        help="PDF uniquement."
        accept="application/pdf"
      />
    )
    const zone = () => screen.getByRole('button', { name: 'Justificatif' })
    const textAt = (id: string) => document.getElementById(id)?.textContent

    expect(zone().getAttribute('aria-describedby')).toBe('justificatif-help')

    fireEvent.drop(zone(), {
      dataTransfer: { files: [makeFile('image.png', 100, 'image/png')] },
    })

    expect(zone().getAttribute('aria-describedby')).toBe('justificatif-help justificatif-error')
    expect(textAt('justificatif-help')).toBe('PDF uniquement.')
    expect(textAt('justificatif-error')).toBe('Ce type de fichier n’est pas accepté.')

    // A matching file clears the rejection and swaps the zone for the file
    // row; removing that file brings the zone back with nothing left to say.
    fireEvent.drop(zone(), {
      dataTransfer: { files: [makeFile('facture.pdf', 100, 'application/pdf')] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retirer le fichier' }))

    expect(zone().getAttribute('aria-describedby')).toBe('justificatif-help')
    expect(document.getElementById('justificatif-error')).toBeNull()
  })

  it('accepts a matching file dropped on the zone', () => {
    const onFileChange = vi.fn()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        accept="application/pdf"
        onFileChange={onFileChange}
      />
    )

    const dropzone = screen.getByRole('button', { name: 'Justificatif' })
    const file = makeFile('facture.pdf', 100, 'application/pdf')
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })

    expect(screen.getByText('facture.pdf')).toBeVisible()
    expect(onFileChange).toHaveBeenCalledWith(file)
  })

  it('marks the drop zone invalid and describes it with the caller’s error', () => {
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        error="Un justificatif est requis."
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Un justificatif est requis.')
  })

  it('is disabled when the caller disables it', () => {
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        disabled
      />
    )

    const dropzone = screen.getByRole('button', { name: 'Justificatif' })
    expect(dropzone).toHaveAttribute('aria-disabled', 'true')
    expect(dropzone).toHaveAttribute('tabindex', '-1')
  })

  it('forwards its ref to the drop zone, so a form can move focus to it', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={REJECTION_MESSAGE}
        removeLabel="Retirer"
        ref={ref}
      />
    )

    ref.current?.focus()

    expect(screen.getByRole('button', { name: 'Justificatif' })).toHaveFocus()
  })
})
