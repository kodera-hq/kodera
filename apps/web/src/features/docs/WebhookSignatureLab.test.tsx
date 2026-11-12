import { webcrypto } from 'node:crypto'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { WebhookSignatureLab } from './WebhookSignatureLab'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
it('actually signs and verifies locally, then clears the result and refuses changed bytes', async () => {
  const user = userEvent.setup()
  const network = vi.spyOn(globalThis, 'fetch')
  render(<WebhookSignatureLab />)
  await user.click(screen.getByRole('button', { name: 'Signer l’exemple' }))
  const header = screen.getByRole('textbox', {
    name: 'En-tête de signature à vérifier',
  }) as HTMLInputElement
  // Signing is asynchronous: the header is filled once the digest resolves, not within the click.
  await waitFor(() => expect(header.value).toMatch(/^v1=[a-f0-9]{64}$/u))
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(await screen.findByText('Signature valide localement')).toBeInTheDocument()
  await user.type(screen.getByRole('textbox', { name: 'Payload JSON exact' }), ' ')
  expect(screen.queryByText('Signature valide localement')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(await screen.findByText('La signature ne correspond pas')).toBeInTheDocument()
  expect(network).not.toHaveBeenCalled()
})
it('reports timestamp expiry and uses the native GitHub transcript without pretending it has a clock guard', async () => {
  const user = userEvent.setup()
  render(<WebhookSignatureLab />)
  const timestamp = screen.getByRole('textbox', { name: 'Timestamp Unix (secondes)' })
  await user.clear(timestamp)
  await user.type(timestamp, '0')
  await user.click(screen.getByRole('button', { name: 'Signer l’exemple' }))
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(
    await screen.findByText('Le timestamp dépasse la fenêtre de 300 secondes.')
  ).toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Format de signature' }), 'github')
  expect(screen.queryByRole('textbox', { name: 'Timestamp Unix (secondes)' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Signer l’exemple' }))
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(await screen.findByText('Signature valide localement')).toBeInTheDocument()
})
