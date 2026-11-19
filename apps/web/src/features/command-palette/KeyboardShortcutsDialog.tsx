import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../ui/Dialog/Dialog'
import { KoderaIcon, type KoderaIconName } from '../../ui/icons/KoderaIcons'
import { isMac, withdrawn } from '../workspace/ChannelSearch'

export const shortcutsCopy = {
  fr: {
    title: 'Raccourcis clavier',
    close: 'Fermer',
    search: 'Rechercher et naviguer',
    help: 'Afficher les raccourcis',
    escape: 'Effacer la recherche ou fermer',
    navigate: 'Parcourir les résultats',
    open: 'Ouvrir le résultat',
    preview: 'Fichier précédent / suivant',
  },
  en: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    search: 'Search and navigate',
    help: 'Show shortcuts',
    escape: 'Clear search or close',
    navigate: 'Browse results',
    open: 'Open result',
    preview: 'Previous / next file',
  },
} as const
export function KeyboardShortcutsDialog({ request }: { request?: number } = {}) {
  const { i18n } = useTranslation()
  const copy = shortcutsCopy[i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr']
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (request !== undefined) {
      if (request === 0) return
      const frame = requestAnimationFrame(() => {
        if (withdrawn(root.current) || document.querySelector('[role="dialog"]')) return
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setOpen(true)
      })
      return () => cancelAnimationFrame(frame)
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key !== '/' ||
        withdrawn(root.current) ||
        document.querySelector('[role="dialog"]')
      )
        return
      event.preventDefault()
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [request])
  const modifier = isMac() ? '⌘' : 'Ctrl+'
  const rows: [KoderaIconName, string, string][] = [
    ['search', copy.search, `${modifier}K`],
    ['command', copy.help, `${modifier}/`],
    ['list', copy.navigate, '↑ ↓'],
    ['spark', copy.open, '↵'],
    ['files', copy.preview, '← →'],
    ['left', copy.escape, 'Esc'],
  ]
  return (
    <div ref={root}>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={copy.title}
        closeLabel={copy.close}
        returnFocusTo={opener}
      >
        <dl className="flex flex-col gap-3">
          {rows.map(([icon, label, keys]) => (
            <div key={icon} className="flex items-center gap-3">
              <KoderaIcon name={icon} />
              <dt className="flex-1 text-sm text-c-ink">{label}</dt>
              <dd>
                <kbd className="rounded-sm border border-c-border px-2 py-1 text-xs text-c-ink-3">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </div>
  )
}
