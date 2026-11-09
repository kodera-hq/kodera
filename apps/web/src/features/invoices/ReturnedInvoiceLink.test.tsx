import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { ReturnedInvoiceLink } from './ReturnedInvoiceLink'

afterEach(() => vi.useRealTimers())
const action = () => ({
  url: 'https://payments.example.test/ready',
  expires_at: new Date(Date.now() + 1000).toISOString(),
  kind: 'payment' as const,
  isCurrent: () => true,
})
it('keeps a real link with opener isolation for the active action', () => {
  const value = action()
  render(<ReturnedInvoiceLink action={value} />)
  const link = screen.getByRole('link', { name: 'Ouvrir le paiement' })
  expect(link).toHaveAttribute('href', value.url)
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  expect(link).toHaveAttribute('target', '_blank')
})
it('refuses a retired session at activation even without a React rerender', () => {
  let current = true
  render(<ReturnedInvoiceLink action={{ ...action(), isCurrent: () => current }} />)
  const link = screen.getByRole('link')
  current = false
  expect(fireEvent.click(link)).toBe(false)
})
it('removes an expired link and refuses expired initial data', () => {
  vi.useFakeTimers()
  const value = action()
  const { rerender } = render(<ReturnedInvoiceLink action={value} />)
  expect(screen.getByRole('link')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1001))
  expect(screen.queryByRole('link')).toBeNull()
  rerender(<ReturnedInvoiceLink action={{ ...value, expires_at: 'invalid' }} />)
  expect(screen.queryByRole('link')).toBeNull()
})
it('uses a download action for PDF links', () => {
  render(<ReturnedInvoiceLink action={{ ...action(), kind: 'pdf' }} />)
  expect(screen.getByRole('link', { name: 'Télécharger le PDF' })).toBeInTheDocument()
})
it('does not display a late expired first result against an old mount clock', () => {
  vi.useFakeTimers()
  const value = action()
  const { rerender } = render(<ReturnedInvoiceLink action={undefined} />)
  act(() => vi.advanceTimersByTime(2000))
  rerender(<ReturnedInvoiceLink action={value} />)
  expect(screen.queryByRole('link')).toBeNull()
})
it('checks an expired replacement result against its own delivery time', () => {
  vi.useFakeTimers()
  const value = action()
  const replacement = {
    ...value,
    url: 'https://payments.example.test/replacement',
    expires_at: new Date(Date.now() + 1500).toISOString(),
  }
  const { rerender } = render(<ReturnedInvoiceLink action={value} />)
  act(() => vi.advanceTimersByTime(2000))
  rerender(<ReturnedInvoiceLink action={replacement} />)
  expect(screen.queryByRole('link')).toBeNull()
})
