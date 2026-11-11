import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { authAdapter } from '../../auth/oidc'
import { CommunityWelcome } from './CommunityWelcome'

vi.mock('../../auth/oidc', () => ({ authAdapter: { signIn: vi.fn() } }))
beforeEach(async () => {
  sessionStorage.clear()
  vi.mocked(authAdapter.signIn).mockReset().mockResolvedValue(undefined)
  await i18n.changeLanguage('fr')
})
it.each([
  ['fr', 'Se connecter', false],
  ['fr', 'Créer un compte', true],
  ['en', 'Sign in', false],
  ['en', 'Create an account', true],
] as const)(
  'starts %s %s with a community return destination',
  async (locale, name, registration) => {
    await i18n.changeLanguage(locale)
    render(<CommunityWelcome />)
    expect(screen.getByRole('heading', { name: 'Kodera Community' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name }))
    expect(authAdapter.signIn).toHaveBeenCalledWith('community', { registration })
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/community/workspace')
    expect(screen.getByRole('status')).toBeVisible()
  }
)
it('offers a retry after an auth setup failure without leaking the error', async () => {
  vi.mocked(authAdapter.signIn).mockRejectedValueOnce(new Error('sensitive upstream text'))
  render(<CommunityWelcome />)
  await userEvent.click(screen.getByRole('button', { name: 'Créer un compte' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
  expect(screen.queryByText('sensitive upstream text')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled()
})
it('switches locale without leaving the welcome screen', async () => {
  render(<CommunityWelcome />)
  await userEvent.click(screen.getByRole('button', { name: 'EN' }))
  expect(screen.getByRole('button', { name: 'Create an account' })).toBeVisible()
  expect(sessionStorage.getItem('console:language')).toBe('en')
})
