import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'

const { handleCallback, navigate } = vi.hoisted(() => ({
  handleCallback: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ handleCallback }) }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouter: () => ({ navigate }),
}))
import { callbackRoute } from './callback-route'
const Callback = callbackRoute.options.component!

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home?preserve=1')
})

describe('callback route under StrictMode', () => {
  it('does not navigate or consume the parent destination after silent notification', async () => {
    handleCallback.mockResolvedValue('silent')
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(handleCallback).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe(
      '/acme-sa/home?preserve=1'
    )
  })

  it('navigates only once after interactive completion', async () => {
    handleCallback.mockResolvedValue('interactive')
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenCalledWith({ href: '/acme-sa/home?preserve=1' })
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  })

  it('keeps a failed callback truthful and leaves the destination untouched', async () => {
    handleCallback.mockRejectedValue(new Error('Invalid transaction'))
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        i18n.t('console.shell._.error-load-failed')
      )
    )
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe(
      '/acme-sa/home?preserve=1'
    )
  })
})
