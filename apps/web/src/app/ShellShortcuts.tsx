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

/** Input types without a text caret, where Control+K edits nothing. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * On a Mac, Control+K in a text field is the system's « delete to the end of the line »: the
 * palette opens there on Command+K only, and keeps Control+K everywhere else.
 */
function keepsNativeEditing(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.metaKey) return false
  if (typeof navigator === 'undefined' || !/Mac|iPhone|iPad/.test(navigator.userAgent)) return false
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)) ||
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

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
        if (keepsNativeEditing(event)) return
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
