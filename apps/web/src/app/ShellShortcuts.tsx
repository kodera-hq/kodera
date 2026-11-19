import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react'
import { OPEN_PALETTE } from '../features/command-palette/PaletteContext'

const GlobalUniversalSearch = lazy(() =>
  import('../features/command-palette/UniversalSearch').then((module) => ({
    default: module.GlobalUniversalSearch,
  }))
)
const KeyboardShortcutsDialog = lazy(() =>
  import('../features/command-palette/KeyboardShortcutsDialog').then((module) => ({
    default: module.KeyboardShortcutsDialog,
  }))
)

/** Keep the first key press while either lazy dialog is still being fetched. */
export function ShellShortcuts({ org }: { org: string }) {
  const [paletteRequest, setPaletteRequest] = useState(0)
  const [shortcutsRequest, setShortcutsRequest] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const available = () =>
      root.current !== null &&
      root.current.closest('[hidden],[aria-hidden="true"],[inert]') === null &&
      !document.querySelector('[role="dialog"]')
    const showPalette = () => {
      if (available()) setPaletteRequest((value) => value + 1)
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        !available()
      )
        return
      if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault()
        showPalette()
      } else if (event.key === '/') {
        event.preventDefault()
        setShortcutsRequest((value) => value + 1)
      }
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener(OPEN_PALETTE, showPalette)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener(OPEN_PALETTE, showPalette)
    }
  }, [])
  return (
    <div ref={root}>
      <Suspense fallback={null}>
        <GlobalUniversalSearch org={org} request={paletteRequest} />
      </Suspense>
      <Suspense fallback={null}>
        <KeyboardShortcutsDialog request={shortcutsRequest} />
      </Suspense>
    </div>
  )
}
