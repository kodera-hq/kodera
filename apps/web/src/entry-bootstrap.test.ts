import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_ENABLE_MSW', '1')
  vi.stubEnv('VITE_AUTH_MODE', 'mock')
  document.body.innerHTML =
    '<div id="root"></div><template id="entry-recovery"><h1>Recovery</h1></template>'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  history.replaceState(null, '', '/')
})

it('cleans a framed callback and posts only to its own origin without releasing the application', async () => {
  history.replaceState(null, '', '/auth/callback?code=synthetic&state=transaction#discard')
  const postMessage = vi.fn()
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
  const append = vi.spyOn(document.head, 'append')
  await import('./entry-bootstrap')
  expect(location.hash).toBe('')
  expect(postMessage).toHaveBeenCalledExactlyOnceWith(
    {
      source: 'oidc-client',
      url: `${location.origin}/auth/callback?code=synthetic&state=transaction`,
      keepOpen: false,
    },
    location.origin
  )
  expect(append).not.toHaveBeenCalled()
  expect(document.getElementById('root')).toBeEmptyDOMElement()
})

it('never posts or releases resources when framed callback cleanup fails', async () => {
  history.replaceState(null, '', '/auth/callback?error=login_required#discard')
  vi.spyOn(history, 'replaceState').mockImplementation(() => {})
  const postMessage = vi.fn()
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
  const append = vi.spyOn(document.head, 'append')
  await import('./entry-bootstrap')
  expect(postMessage).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  expect(document.getElementById('root')).toHaveTextContent('Recovery')
})
