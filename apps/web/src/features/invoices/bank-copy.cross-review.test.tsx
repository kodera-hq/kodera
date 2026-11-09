import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { authAdapter } from '../../auth/oidc'
import { BankDetailsDialog } from './BankDetailsDialog'
beforeEach(() => {
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
})
it('does not claim a payment reference copied while the clipboard write is pending', async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(new Promise(() => {}))
  render(
    <BankDetailsDialog
      invoiceNumber="SYNTHETIC-REF"
      open
      pdfAvailable={false}
      onDownloadPdf={vi.fn()}
      onOpenChange={vi.fn()}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  expect(write).toHaveBeenCalledWith('SYNTHETIC-REF')
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
})

const props = {
  invoiceNumber: 'FIRST-REF',
  open: true,
  pdfAvailable: false,
  onDownloadPdf: vi.fn(),
  onOpenChange: vi.fn(),
}
it('confirms only a completed clipboard write for the current reference', async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  render(<BankDetailsDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  expect(write).toHaveBeenCalledWith('FIRST-REF')
  expect(await screen.findByRole('button', { name: 'Copié' })).toBeInTheDocument()
})
it('explains clipboard refusal without reporting a copy', async () => {
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  render(<BankDetailsDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  expect(
    await screen.findByText(
      'La copie a échoué. Sélectionnez la référence pour la copier manuellement.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
})
it('does not transfer an old pending copy result to a replacement invoice', async () => {
  const user = userEvent.setup()
  let finish!: () => void
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const { rerender } = render(<BankDetailsDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  rerender(<BankDetailsDialog {...props} invoiceNumber="SECOND-REF" />)
  await act(async () => finish())
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
})
