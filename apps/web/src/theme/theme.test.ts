import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultTheme, themeFor, themeIds, themes } from '@kodera/design-tokens/themes'
import {
  THEME_CHANGE_EVENT,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  isThemePreferenceKept,
  readThemePreference,
  saveThemePreference,
} from './theme'

const ROOT = join(import.meta.dirname, '..', '..')
const BOOT = readFileSync(join(ROOT, 'public', 'theme.js'), 'utf8')
const INDEX_HTML = readFileSync(join(ROOT, 'index.html'), 'utf8')

/** Runs the boot script against a window of its own, so each case starts clean. */
function boot({ stored, dark }: { stored: string | null; dark: boolean }) {
  const events = new EventTarget()
  const system = Object.assign(new EventTarget(), { matches: dark })
  const root = { dataset: {} as Record<string, string> }
  const fakeWindow = {
    matchMedia: () => system,
    localStorage: { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) },
    document: { documentElement: root },
    addEventListener: events.addEventListener.bind(events),
  }
  new Function('window', BOOT)(fakeWindow)
  return {
    theme: () => root.dataset.theme,
    events,
    setDevice(next: boolean) {
      system.matches = next
      system.dispatchEvent(new Event('change'))
    },
  }
}

describe('public/theme.js', () => {
  it('follows the device in the Ciel family until a theme is chosen, and follows its changes', () => {
    const page = boot({ stored: null, dark: true })
    expect(page.theme()).toBe('ciel-nuit')
    page.setDevice(false)
    expect(page.theme()).toBe('ciel')
  })

  it('follows the device with the tokens package default and its dark twin', () => {
    // A default moved in the tokens package and not here would ship the old family by default.
    const family = themes.find((theme) => theme.id === defaultTheme)!.family
    expect(boot({ stored: null, dark: false }).theme()).toBe(defaultTheme)
    expect(boot({ stored: null, dark: true }).theme()).toBe(themeFor(family, 'dark')!.id)
  })

  it('offers every theme the tokens package ships', () => {
    expect([...THEME_PREFERENCES].filter((preference) => preference !== 'system').sort()).toEqual(
      [...themeIds].sort()
    )
  })

  it('applies a stored theme over the device', () => {
    expect(boot({ stored: 'black', dark: false }).theme()).toBe('black')
    expect(boot({ stored: 'light', dark: true }).theme()).toBe('light')
    expect(boot({ stored: 'system', dark: true }).theme()).toBe('ciel-nuit')
    expect(boot({ stored: 'ciel', dark: true }).theme()).toBe('ciel')
    expect(boot({ stored: 'ciel-nuit', dark: false }).theme()).toBe('ciel-nuit')
  })

  it('applies every theme the page offers, so a theme added to one list alone fails here', () => {
    for (const preference of THEME_PREFERENCES.filter((candidate) => candidate !== 'system')) {
      // Against the opposite device, so following the device cannot pass for applying it.
      const dark = preference === 'light' || preference === 'ciel'
      expect(boot({ stored: preference, dark }).theme(), preference).toBe(preference)
    }
  })

  it('still applies the stored theme when the device cannot be asked or followed', () => {
    const cases = {
      'no matchMedia': undefined,
      'a list without addEventListener': () => ({ matches: true }),
    }
    for (const [name, matchMedia] of Object.entries(cases)) {
      const root = { dataset: {} as Record<string, string> }
      const fakeWindow = {
        matchMedia,
        localStorage: { getItem: () => 'black' },
        document: { documentElement: root },
        addEventListener: () => {},
      }
      new Function('window', BOOT)(fakeWindow)
      expect(root.dataset.theme, name).toBe('black')
    }
  })

  it('reads Automatique as Ciel light when the device cannot be asked, and still takes a choice', () => {
    const events = new EventTarget()
    const root = { dataset: {} as Record<string, string> }
    const fakeWindow = {
      localStorage: { getItem: () => null },
      document: { documentElement: root },
      addEventListener: events.addEventListener.bind(events),
    }
    new Function('window', BOOT)(fakeWindow)
    expect(root.dataset.theme).toBe('ciel')
    // Its listeners were registered: the page can still change the theme without a reload.
    events.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'dark' }))
    expect(root.dataset.theme).toBe('dark')
  })

  it('treats a value it does not know as Automatique', () => {
    for (const stored of ['sepia', '', 'DARK', '"dark"']) {
      const page = boot({ stored, dark: true })
      expect(page.theme(), stored).toBe('ciel-nuit')
      page.setDevice(false)
      expect(page.theme(), stored).toBe('ciel')
    }
  })

  it('ignores a device change while a theme is chosen', () => {
    const page = boot({ stored: 'light', dark: false })
    page.setDevice(true)
    expect(page.theme()).toBe('light')
    page.events.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'system' }))
    expect(page.theme()).toBe('ciel-nuit')
  })

  it('re-applies on the change this module announces and on another tab’s choice', () => {
    const page = boot({ stored: null, dark: false })
    page.events.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'black' }))
    expect(page.theme()).toBe('black')
    page.events.dispatchEvent(
      new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' })
    )
    expect(page.theme()).toBe('dark')
    page.events.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'light' }))
    expect(page.theme()).toBe('dark')
  })

  it('still runs when storage is refused, following the device', () => {
    const system = Object.assign(new EventTarget(), { matches: true })
    const root = { dataset: {} as Record<string, string> }
    const fakeWindow = {
      matchMedia: () => system,
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError')
      },
      document: { documentElement: root },
      addEventListener: () => {},
    }
    new Function('window', BOOT)(fakeWindow)
    expect(root.dataset.theme).toBe('ciel-nuit')
  })
})

describe('index.html', () => {
  const scripts = [...INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]

  it('declares only the external bootstrap without an eager theme or inline script', () => {
    const assertEntry = (markup: string) => {
      const page = new DOMParser().parseFromString(markup, 'text/html')
      expect(page.querySelector('script[src="/theme.js"]'), 'ENTRY_EAGER_THEME').toBeNull()
      expect(page.querySelector('link[rel], style'), 'ENTRY_EAGER_LINK_OR_STYLE').toBeNull()
      expect(page.scripts.length, 'ENTRY_SCRIPT_COUNT').toBe(1)
      const entry = page.scripts.item(0)
      expect(entry?.getAttribute('src'), 'ENTRY_SOURCE').toBe('/src/entry-bootstrap.ts')
      expect(entry?.getAttribute('type'), 'ENTRY_TYPE').toBe('module')
      expect(entry?.textContent?.trim(), 'ENTRY_INLINE').toBe('')
    }
    assertEntry(INDEX_HTML)
    const controls: ReadonlyArray<readonly [string, string]> = [
      [
        'ENTRY_EAGER_THEME',
        INDEX_HTML.replace('</head>', '<script src="/theme.js"></script></head>'),
      ],
      ['ENTRY_SOURCE', INDEX_HTML.replace('/src/entry-bootstrap.ts', '/src/main.tsx')],
      [
        'ENTRY_SCRIPT_COUNT',
        INDEX_HTML.replace('</body>', '<script src="/unexpected.js"></script></body>'),
      ],
      [
        'ENTRY_INLINE',
        INDEX_HTML.replace(
          'src="/src/entry-bootstrap.ts"></script>',
          'src="/src/entry-bootstrap.ts">synthetic()</script>'
        ),
      ],
      [
        'ENTRY_EAGER_LINK_OR_STYLE',
        INDEX_HTML.replace('</head>', '<link rel="stylesheet" href="/unexpected.css" /></head>'),
      ],
      ['ENTRY_TYPE', INDEX_HTML.replace('type="module"', '')],
    ]
    for (const [marker, markup] of controls) {
      expect(markup).not.toBe(INDEX_HTML)
      expect(() => assertEntry(markup)).toThrow(marker)
      assertEntry(INDEX_HTML)
    }
  })

  it('carries no inline script, so a script-src of self alone still allows the page', () => {
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="/)
      expect(body?.trim()).toBe('')
    }
  })
})

describe('theme preference', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // A stored choice forgets an unsaved one: this module's state starts clean for the next case.
    saveThemePreference('system')
    localStorage.clear()
  })

  it('is Automatique until a theme is chosen, and for a value it does not know', () => {
    expect(readThemePreference()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readThemePreference()).toBe('system')
  })

  it('stores the choice and announces it with the value', () => {
    const announced = vi.fn()
    window.addEventListener(THEME_CHANGE_EVENT, announced)
    const stored = saveThemePreference('dark')
    window.removeEventListener(THEME_CHANGE_EVENT, announced)
    expect(stored).toBe(true)
    expect(readThemePreference()).toBe('dark')
    expect(announced.mock.calls[0]?.[0]).toMatchObject({ detail: 'dark' })
  })

  it('still announces when storage refuses the write, and says it was not kept', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const announced = vi.fn()
    window.addEventListener(THEME_CHANGE_EVENT, announced)
    const stored = saveThemePreference('black')
    window.removeEventListener(THEME_CHANGE_EVENT, announced)
    expect(stored).toBe(false)
    expect(announced).toHaveBeenCalledTimes(1)
  })

  it('reads a choice the browser refused as the one in effect until one is stored', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    saveThemePreference('black')
    // `public/theme.js` keeps black on this page, whatever storage still says.
    expect(readThemePreference()).toBe('black')
    expect(isThemePreferenceKept()).toBe(false)

    setItem.mockRestore()
    saveThemePreference('light')
    expect(readThemePreference()).toBe('light')
    expect(isThemePreferenceKept()).toBe(true)
  })

  it('gives way to another tab’s stored choice, as the boot script does', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    saveThemePreference('black')
    vi.restoreAllMocks()

    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }))
    expect(readThemePreference()).toBe('dark')
    expect(isThemePreferenceKept()).toBe(true)
    // Another key leaves an unsaved choice alone.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    saveThemePreference('black')
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }))
    expect(readThemePreference()).toBe('black')
  })

  it('is Automatique when the browser refuses to read storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readThemePreference()).toBe('system')
  })
})
