// The installed SDK's own popup, with a synthetic window the person closes. The adapter's suites
// replace the navigator, so only this file shows what `popupAbortOnClose` does: with it a closed
// popup ends the sign-in, and without it the sign-in never settles.
import { UserManager } from 'oidc-client-ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://id.example/realms/acme-sa'

function manager(): UserManager {
  return new UserManager({
    authority: ISSUER,
    client_id: 'console',
    redirect_uri: `${window.location.origin}/auth/callback`,
    popup_redirect_uri: `${window.location.origin}/auth/claim-callback`,
    metadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth` },
  })
}

/** A popup that opens, is sent to the provider, and is then closed by the person. */
function closablePopup() {
  const popup = { closed: false, focus: () => {}, close: () => {}, location: { replace: vi.fn() } }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  return popup
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the SDK popup closed by the person', () => {
  it('ends the sign-in with popupAbortOnClose', async () => {
    const popup = closablePopup()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const signIn = manager().signinPopup({ popupAbortOnClose: true })
    const settled = signIn.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce())
    popup.closed = true
    await vi.advanceTimersByTimeAsync(600)
    await expect(settled).resolves.toBe('Popup closed by user')
  })

  it('never ends the sign-in without it', async () => {
    const popup = closablePopup()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let settled = false
    const signIn = manager().signinPopup()
    void signIn.then(
      () => (settled = true),
      () => (settled = true)
    )
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce())
    popup.closed = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(settled).toBe(false)
  })
})
