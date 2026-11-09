import { webcrypto } from 'node:crypto'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { WebhookSignatureTester } from './WebhookSignatureTester'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('signs and verifies locally, reports tampering, and clears the ephemeral secret', async () => {
  const user = userEvent.setup()
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
  render(<WebhookSignatureTester extensionId="io.kodera.ext.hello-webhook" />)
  await user.click(screen.getByRole('button', { name: 'Générer un secret de test' }))
  const secret = screen.getByLabelText('Secret de signature de test')
  expect(secret).toHaveAttribute('type', 'password')
  expect((secret as HTMLInputElement).value).toMatch(/^whsec_[0-9a-f]{64}$/)
  await user.click(screen.getByRole('button', { name: 'Signer l’exemple' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Exemple signé')
  expect((screen.getByLabelText('x-kodera-signature-256') as HTMLInputElement).value).toMatch(
    /^v1=[0-9a-f]{64}$/
  )
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Signature vérifiée')
  await user.type(screen.getByLabelText('Corps JSON brut'), ' ')
  expect(screen.queryByRole('status')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Vérifier la signature' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('La signature ne correspond pas')
  await user.click(screen.getByRole('button', { name: 'Effacer le test' }))
  expect(secret).toHaveValue('')
  expect(screen.getByLabelText('x-kodera-signature-256')).toHaveValue('')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(storageSpy).not.toHaveBeenCalled()
})
