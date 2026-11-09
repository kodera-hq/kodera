// Applies the theme before the first paint, so a dark page never flashes light.
// A classic script on purpose: modules are deferred and would run after the
// paint. An external file, not inline, so a Content-Security-Policy of
// `script-src 'self'` allows it as it stands. `src/theme/theme.ts` stores the
// choice; `src/theme/theme.test.ts` runs this file against every theme that
// module lists, so a theme added there alone fails a test.
;(() => {
  const KEY = 'console:theme'
  const THEMES = ['light', 'dark', 'black']
  let device = null
  try {
    device = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    // No `matchMedia`: the device cannot be asked, so « Automatique » is light.
  }
  let chosen = null
  try {
    chosen = window.localStorage.getItem(KEY)
  } catch {
    // Storage refused: follow the device.
  }
  // Anything but a known theme — "system", nothing, a stale or foreign value —
  // follows the device, and only then does a device change repaint the page.
  const apply = () => {
    window.document.documentElement.dataset.theme = THEMES.includes(chosen)
      ? chosen
      : device !== null && device.matches
        ? 'dark'
        : 'light'
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
