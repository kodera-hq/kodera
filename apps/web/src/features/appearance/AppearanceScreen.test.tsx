import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY, saveThemePreference } from '../../theme/theme'
import { AppearanceScreen } from './AppearanceScreen'

afterEach(() => {
  vi.restoreAllMocks()
  // A stored choice forgets a refused one kept for the page (`src/theme/theme.ts`), so each case
  // starts from storage alone.
  saveThemePreference('system')
  localStorage.clear()
})

function cards() {
  return within(screen.getByRole('radiogroup', { name: 'Thème' })).getAllByRole('radio')
}

describe('AppearanceScreen', () => {
  it('offers the four themes in order, « Automatique » chosen when nothing is stored', () => {
    render(<AppearanceScreen />)

    expect(screen.getByRole('heading', { level: 1, name: 'Apparence' })).toBeInTheDocument()
    expect(cards()).toEqual(
      ['Automatique', 'Clair', 'Sombre', 'Noir'].map((name) => screen.getByRole('radio', { name }))
    )
    expect(screen.getByRole('radio', { name: 'Automatique' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    // Named by its label alone; the mock's hint is its description, not part of its name.
    expect(screen.getByRole('radio', { name: 'Clair' })).toHaveAccessibleDescription(
      'bureau, plein jour'
    )
    expect(screen.getByText(/enregistré dans ce navigateur seulement/)).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Thème' })).toHaveAccessibleDescription(
      /enregistré dans ce navigateur seulement/
    )
  })

  it('shows the stored choice as chosen, and a value it does not know as « Automatique »', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'black')
    const { unmount } = render(<AppearanceScreen />)
    expect(screen.getByRole('radio', { name: 'Noir' })).toHaveAttribute('aria-checked', 'true')
    unmount()

    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    render(<AppearanceScreen />)
    expect(screen.getByRole('radio', { name: 'Automatique' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('stores and announces a choice at once, and edges the chosen card', async () => {
    const user = userEvent.setup()
    const announced = vi.fn()
    window.addEventListener(THEME_CHANGE_EVENT, announced)
    render(<AppearanceScreen />)

    await user.click(screen.getByRole('radio', { name: 'Sombre' }))
    window.removeEventListener(THEME_CHANGE_EVENT, announced)

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(announced.mock.calls[0]?.[0]).toMatchObject({ detail: 'dark' })
    const chosen = screen.getByRole('radio', { name: 'Sombre' })
    expect(chosen).toHaveAttribute('aria-checked', 'true')
    expect(chosen).toHaveClass('border-2', 'border-c-accent-ink')
    expect(screen.getByRole('radio', { name: 'Automatique' })).toHaveClass('border-c-border')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('is one Tab stop landing on the chosen card, and the arrows choose', async () => {
    const user = userEvent.setup()
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(<AppearanceScreen />)

    await user.tab()
    expect(screen.getByRole('radio', { name: 'Clair' })).toHaveFocus()
    // Held until Radix's roving move lands: it chooses only while the key is down
    // (see `src/ui/RadioGroup/RadioGroup.test.tsx`).
    await user.keyboard('{ArrowRight>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Sombre' })).toHaveFocus())
    await user.keyboard('{/ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Sombre' })).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    await user.tab()
    expect(cards().some((card) => card === document.activeElement)).toBe(false)
  })

  it('says the choice applies to this page only when the browser refuses to keep it', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const announced = vi.fn()
    window.addEventListener(THEME_CHANGE_EVENT, announced)
    render(<AppearanceScreen />)
    // The live region is there, empty, before anything goes wrong: a polite region inserted with
    // its message already in it is often not announced at all.
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()

    await user.click(screen.getByRole('radio', { name: 'Noir' }))
    window.removeEventListener(THEME_CHANGE_EVENT, announced)

    expect(announced).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('radio', { name: 'Noir' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByRole('status')).toEqual([region])
    expect(region).toHaveTextContent(
      /n’a pas enregistré votre choix.*autorisez ce site à enregistrer des données/
    )
  })

  it('shows « Automatique » when the browser refuses to read storage at all', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    render(<AppearanceScreen />)
    expect(screen.getByRole('radio', { name: 'Automatique' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('follows a choice made in another tab', () => {
    render(<AppearanceScreen />)

    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark')
      window.dispatchEvent(
        new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' })
      )
    })

    expect(screen.getByRole('radio', { name: 'Sombre' })).toHaveAttribute('aria-checked', 'true')
  })

  it('previews each theme with its own roles, « Automatique » half light and half dark', () => {
    render(<AppearanceScreen />)

    const previews = cards().map((card) =>
      [...card.querySelectorAll('[aria-hidden="true"] [data-theme]')].map((node) =>
        node.getAttribute('data-theme')
      )
    )
    expect(previews).toEqual([['light', 'dark'], ['light'], ['dark'], ['black']])
  })
})

// The page and `public/theme.js` together, on this window: the real boot script applies the theme,
// the page shows the choice. After a refused write they must still agree when the page is opened
// again, or the page shows « Automatique » over a black page and choosing it does nothing.
describe('AppearanceScreen with the boot script', () => {
  const BOOT = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'public', 'theme.js'),
    'utf8'
  )

  beforeAll(() => {
    const device = Object.assign(new EventTarget(), { matches: false })
    vi.stubGlobal('matchMedia', () => device)
    new Function('window', BOOT)(window)
    vi.unstubAllGlobals()
  })

  const html = () => document.documentElement.dataset.theme

  it('shows the refused choice and its warning again when the page is opened again', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const user = userEvent.setup()
    const first = render(<AppearanceScreen />)
    await user.click(screen.getByRole('radio', { name: 'Noir' }))
    expect(html()).toBe('black')
    first.unmount()

    render(<AppearanceScreen />)
    expect(html()).toBe('black')
    expect(screen.getByRole('radio', { name: 'Noir' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/n’a pas enregistré votre choix/)

    // And « Automatique » is a choice again, not the checked card that does nothing.
    await user.click(screen.getByRole('radio', { name: 'Automatique' }))
    expect(html()).toBe('light')
    expect(screen.getByRole('radio', { name: 'Automatique' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    setItem.mockRestore()
  })

  it('drops the warning when another tab stores a choice after a refusal', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const user = userEvent.setup()
    render(<AppearanceScreen />)
    await user.click(screen.getByRole('radio', { name: 'Noir' }))
    expect(screen.getByRole('status')).toHaveTextContent(/n’a pas enregistré votre choix/)
    setItem.mockRestore()

    // Another tab stores « Clair »: this page wears it now, and it will survive a reload.
    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light')
      window.dispatchEvent(
        new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' })
      )
    })
    expect(html()).toBe('light')
    expect(screen.getByRole('radio', { name: 'Clair' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('shows the refused choice, not the older stored one, when the page is opened again', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const user = userEvent.setup()
    const first = render(<AppearanceScreen />)
    await user.click(screen.getByRole('radio', { name: 'Noir' }))
    first.unmount()

    render(<AppearanceScreen />)
    expect(html()).toBe('black')
    expect(screen.getByRole('radio', { name: 'Noir' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/n’a pas enregistré votre choix/)
  })
})
