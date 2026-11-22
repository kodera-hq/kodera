// Applies the theme before the first paint, so a dark page never flashes light.
// A classic script on purpose: modules are deferred and would run after the
// paint. An external file, not inline, so a Content-Security-Policy of
// `script-src 'self'` allows it as it stands. `src/theme/theme.ts` stores the
// choice; `src/theme/theme.test.ts` runs this file against every theme that
// module lists, so a theme added there alone fails a test.
;(() => {
  const KEY = 'console:theme'
  const THEMES = ['light', 'dark', 'black', 'ciel', 'ciel-nuit']
  // « Automatique » follows the device: Light Givre on a light device, or Dark Precision
  // (`dark`, the tokens package default) on a dark device or when `matchMedia` is unavailable.
  // Stored legacy `ciel` and `ciel-nuit` values remain accepted without breaking.
  const DEVICE_LIGHT = 'light'
  const DEVICE_DARK = 'dark'
  let device = null
  try {
    device = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    // No `matchMedia`: the device cannot be asked, so « Automatique » falls back to `dark`.
  }
  let chosen = null
  try {
    chosen = window.localStorage.getItem(KEY)
  } catch {
    // Storage refused: follow the device.
  }
  // Anything but a known theme — "system", nothing, a stale or foreign value —
  // follows the device, and only then does a device change repaint the page.
  const LIGHT = ['ciel', 'light']
  const apply = () => {
    const theme = THEMES.includes(chosen)
      ? chosen
      : device === null || device.matches
        ? DEVICE_DARK
        : DEVICE_LIGHT
    window.document.documentElement.dataset.theme = theme
    // The canvas follows the theme before any stylesheet loads: a dark theme on a light device
    // (a return through `/auth/callback`, say) never paints a white page first. The meta tag,
    // not an inline style, so `style-src-attr 'none'` still holds.
    try {
      window.document
        .querySelector('meta[name="color-scheme"]')
        .setAttribute('content', LIGHT.includes(theme) ? 'light' : 'dark')
    } catch {
      // No meta tag on this document: the stylesheet's `color-scheme` rule still applies.
    }
  }
  // First, so nothing below can leave the page without a theme.
  apply()
  try {
    device.addEventListener('change', apply)
  } catch {
    // No device, or a list without `addEventListener`: followed at load only.
  }
  window.addEventListener(KEY, (event) => {
    chosen = event.detail
    apply()
  })
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) {
      chosen = event.newValue
      apply()
    }
  })
})()
