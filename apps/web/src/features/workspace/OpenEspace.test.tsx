// `useAutoOpenEspace` on its own: what it says of a start still to come, which the screen draws as
// « Ouverture de vos messages… ».

import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAutoOpenEspace } from './OpenEspace'

const AUTO_OPEN_KEY = 'kodera.espace.auto-open.v1'

afterEach(() => sessionStorage.removeItem(AUTO_OPEN_KEY))

function entry() {
  return { opening: false, problem: undefined, open: vi.fn(async () => {}) }
}

it('says no start is coming, and starts none, where the way in is not offered', () => {
  const espace = entry()
  const { result } = renderHook(() => useAutoOpenEspace(espace, false))
  expect(result.current).toBe(false)
  expect(espace.open).not.toHaveBeenCalled()
})

it('says a start is coming from the first draw where it is offered and due', () => {
  const espace = entry()
  const seen: boolean[] = []
  renderHook(() => {
    const starting = useAutoOpenEspace(espace, true, '/acme-sa/workspace/welcome')
    seen.push(starting)
    return starting
  })
  expect(seen[0]).toBe(true)
  expect(espace.open).toHaveBeenCalledWith({
    replace: true,
    returnTo: '/acme-sa/workspace/welcome',
  })
})

it('keeps automatic opening disabled on a bundled desktop mount', async () => {
  const desktop = await import('../../auth/desktopOidc')
  vi.spyOn(desktop, 'isDesktopBundledOrigin').mockReturnValue(true)
  const espace = entry()
  const { result, rerender } = renderHook(() => useAutoOpenEspace(espace, true))
  expect(result.current).toBe(false)
  rerender()
  expect(espace.open).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(AUTO_OPEN_KEY)).toBeNull()
})

it('opens Matrix SSO only after the desktop button is clicked and stays in place', async () => {
  const { act, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
  const { OpenEspaceButton, useOpenEspace } = await import('./OpenEspace')
  const desktop = await import('../../auth/desktopOidc')
  const matrix = await import('../../auth/matrix')
  const homeserver = await import('../espace/homeserver')
  const config = await import('../../config')
  const { authAdapter } = await import('../../auth/oidc')
  vi.spyOn(desktop, 'isDesktopBundledOrigin').mockReturnValue(true)
  vi.spyOn(config, 'matrixDomain').mockReturnValue('kodera.io')
  vi.spyOn(homeserver, 'resolveHomeserver').mockResolvedValue({
    baseUrl: 'https://community.kodera.io',
    serverName: 'community.kodera.io',
  })
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: {
      realm: 'community',
      identity: { issuer: 'https://auth.kodera.io/realms/community', subject: 'member' },
    },
  })
  const signin = vi.spyOn(matrix, 'signInToMatrixDesktop').mockResolvedValue({
    returnTo: '/',
    session: {
      baseUrl: 'https://community.kodera.io',
      userId: '@member:community.kodera.io',
      deviceId: 'device',
      accessToken: 'access',
      refreshToken: 'refresh',
      refresh: vi.fn(),
    },
  })
  const browserSignin = vi.spyOn(matrix, 'beginMatrixSignIn')
  function DesktopEntry() {
    const current = useOpenEspace('community')
    const automatic = useAutoOpenEspace(current, true)
    return <OpenEspaceButton entry={current} opening={automatic || current.opening} />
  }
  const before = window.location.href
  render(<DesktopEntry />)
  expect(signin).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('button'))
  })
  await waitFor(() =>
    expect(signin).toHaveBeenCalledWith('https://community.kodera.io', expect.any(String), 'member')
  )
  expect(browserSignin).not.toHaveBeenCalled()
  expect(window.location.href).toBe(before)
  expect(screen.getByRole('button')).not.toBeDisabled()
})
