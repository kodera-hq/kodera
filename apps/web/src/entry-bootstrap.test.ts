import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_ENABLE_MSW', '1')
  vi.stubEnv('VITE_AUTH_MODE', 'mock')
  document.body.innerHTML =
    '<div id="root"></div><template id="entry-page-head"><meta name="x-kodera-head" content="1"></template><template id="entry-recovery"><h1>Recovery</h1></template>'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  document.head.innerHTML = ''
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

it('shows recovery instead of posting to an opaque null origin in a framed callback', async () => {
  const originalLocation = window.location
  const postMessage = vi.fn()
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: 'kodera-asset://localhost/auth/callback?code=synthetic&state=transaction',
      origin: 'null',
      protocol: 'kodera-asset:',
      host: 'localhost',
      hostname: 'localhost',
      pathname: '/auth/callback',
      search: '?code=synthetic&state=transaction',
      hash: '',
    },
  })
  try {
    await import('./entry-bootstrap')
    expect(postMessage).not.toHaveBeenCalled()
    expect(document.getElementById('root')).toHaveTextContent('Recovery')
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  }
})

it('boots cleanly on macOS/Linux WKWebView kodera-asset://localhost/index.html where origin is "null"', async () => {
  vi.stubEnv('VITE_ENABLE_MSW', '0')
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  const boot = vi.fn().mockResolvedValue(undefined)
  vi.doMock('./main', () => ({ boot }))

  const originalLocation = window.location
  const state = {
    href: 'kodera-asset://localhost/index.html',
    origin: 'null',
    protocol: 'kodera-asset:',
    host: 'localhost',
    hostname: 'localhost',
    pathname: '/index.html',
    search: '',
    hash: '',
  }
  Object.defineProperty(window, 'location', {
    configurable: true,
    get: () => state,
  })
  const replaceState = vi
    .spyOn(history, 'replaceState')
    .mockImplementation((_data, _unused, url) => {
      if (typeof url === 'string') {
        const parsed = new URL(url)
        state.href = parsed.href
        state.pathname = parsed.pathname
        state.search = parsed.search
        state.hash = parsed.hash
      }
    })
  const origAppend = document.head.append.bind(document.head)
  let loadedThemeSrc = ''
  vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
    origAppend(...nodes)
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) {
        loadedThemeSrc = node.src
        node.dispatchEvent(new Event('load'))
      }
    }
  })

  try {
    await import('./entry-bootstrap')
    await vi.waitFor(() => {
      expect(boot).toHaveBeenCalledExactlyOnceWith(undefined)
    })
    expect(loadedThemeSrc).toBe('kodera-asset://localhost/theme.js')
    expect(replaceState).toHaveBeenCalledWith(null, '', 'kodera-asset://localhost/')
    expect(state.pathname).toBe('/')
    expect(document.getElementById('root')).not.toHaveTextContent('Recovery')
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  }
})
