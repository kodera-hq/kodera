// « Rechercher » at the head of the workspace's channel column, and the dialog it opens
// (docs/specs/11-workspace.md §4.1): a jump to a channel or an audio room by its name. It searches
// names only, never messages.
//
// `Ctrl K` (`⌘ K` on a Mac) opens it from anywhere on the surface, unless the surface is withdrawn
// behind a modal or the session-expiry screen. The field is a combobox over a
// listbox: arrows move the highlight, `Enter` chooses, `Escape` closes. Choosing a text channel
// opens it, and focus lands on its heading, the element `RouteFocus` focuses after the
// navigation, so the two agree. Choosing an audio room only moves focus to its row in the column:
// joining stays the row's own action, so a search never turns a microphone on.

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog/Dialog'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'

export interface ChannelSearchEntry {
  id: string
  label: string
  kind: 'text' | 'audio'
  /** The category's label, read after the name to tell two channels of the same name apart. */
  category?: string
}

export interface ChannelSearchProps {
  entries: readonly ChannelSearchEntry[]
  /** Opens the entry, and answers where focus goes once the dialog has closed: `null` keeps it
   * on « Rechercher ». */
  onChoose: (entry: ChannelSearchEntry) => HTMLElement | null
  /** Whether `Ctrl K` opens this search. Only one search on a screen listens. */
  shortcut: boolean
}

/** Lower case, accents dropped: « general » finds « Général ». */
function folded(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function matchingEntries(
  entries: readonly ChannelSearchEntry[],
  query: string
): ChannelSearchEntry[] {
  const needle = folded(query.trim())
  if (needle === '') return [...entries]
  return entries.filter((entry) => folded(entry.label).includes(needle))
}

/** A Mac takes `⌘ K`; everything else `Ctrl K`. On a Mac, `Ctrl K` stays the text field's own
 * "delete to the end of the line". */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
}

function isShortcut(event: globalThis.KeyboardEvent, mac: boolean): boolean {
  return (
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  )
}

/** Whether the search sits in a part of the page withdrawn from the person: behind a modal, or
 * behind the session-expiry screen (`org-route.tsx`), which keeps the page mounted but hidden. */
export function withdrawn(element: HTMLElement | null): boolean {
  return element === null || element.closest('[hidden],[aria-hidden="true"],[inert]') !== null
}

function SearchIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 shrink-0 text-c-ink-3"
    >
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  )
}

export function ChannelSearch({ entries, onChoose, shortcut }: ChannelSearchProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [mac] = useState(isMac)
  // Where focus goes as the dialog closes: what had it when the dialog opened, or the place the
  // chosen entry names. A dialog with no trigger of its own leaves focus on `body` otherwise.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const listId = useId()
  const optionId = (index: number) => `${listId}-${index}`
  const found = useMemo(() => matchingEntries(entries, query), [entries, query])
  const highlighted = Math.min(active, Math.max(found.length - 1, 0))

  function show(opener: Element | null) {
    returnFocusTo.current = opener instanceof HTMLElement ? opener : null
    setQuery('')
    setActive(0)
    setOpen(true)
  }

  // Read at the key press, so the listener is not re-added on every render.
  const onShortcut = useEffectEvent(() => {
    if (!open) show(document.activeElement)
  })

  useEffect(() => {
    if (!shortcut) return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isShortcut(event, mac) || event.defaultPrevented) return
      // Withdrawn, the page answers nothing: the key keeps its usual meaning.
      if (withdrawn(button.current)) return
      event.preventDefault()
      onShortcut()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcut, mac])

  function choose(entry: ChannelSearchEntry | undefined) {
    if (entry === undefined) return
    // A place that cannot take focus — a disabled control, or one no longer in the page — would
    // leave focus on `body`; « Rechercher » takes it instead.
    const target = onChoose(entry)
    returnFocusTo.current =
      target !== null && target.isConnected && !target.matches(':disabled')
        ? target
        : button.current
    setOpen(false)
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (found.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = (highlighted + step + found.length) % found.length
      setActive(next)
      // A long list scrolls with the highlight, so the highlighted option stays in view.
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(found[highlighted])
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        {...(shortcut ? { 'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K' } : {})}
        onClick={(event) => show(event.currentTarget)}
        className={cx(
          // The dark workspace reference's search: a muted well with no border, named by its
          // word and glyph (docs/specs/workspace-dark-roles.md). It deepens on hover.
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-sm border border-transparent bg-c-muted px-2 text-left text-sm text-c-placeholder',
          TOUCH_TARGET_HEIGHT,
          'transition-colors duration-fast hover:bg-c-muted-2',
          'focus-visible:ring focus-visible:outline-hidden'
        )}
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('console.workspace.search.action-open')}</span>
        {shortcut ? (
          <kbd
            aria-hidden="true"
            className="shrink-0 rounded-sm border border-c-border px-1 py-1 font-mono text-xs leading-none whitespace-nowrap text-c-ink-3"
          >
            {t(
              mac
                ? 'console.workspace.search.label-shortcut-mac'
                : 'console.workspace.search.label-shortcut'
            )}
          </kbd>
        ) : null}
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('console.workspace.search.title')}
        closeLabel={t('console.common.action-close')}
        initialFocus={field}
        returnFocusTo={returnFocusTo}
      >
        <div className="flex flex-col gap-3">
          <div className="flex h-10 items-center gap-2 rounded-md border border-c-border-input bg-c-surface px-3 focus-within:ring">
            <SearchIcon className="h-4 w-4 shrink-0 text-c-ink-3" />
            <input
              ref={field}
              type="text"
              role="combobox"
              aria-label={t('console.workspace.search.label-query')}
              aria-autocomplete="list"
              aria-expanded={found.length > 0}
              aria-controls={listId}
              {...(found.length > 0 ? { 'aria-activedescendant': optionId(highlighted) } : {})}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onFieldKeyDown}
              className="min-w-0 flex-1 bg-transparent text-md text-c-ink outline-hidden placeholder:text-c-placeholder"
            />
          </div>
          {/* Hidden while empty: a listbox with no option is not one, and the status below
              says why. */}
          <ul
            id={listId}
            role="listbox"
            hidden={found.length === 0}
            aria-label={t('console.workspace.search.label-results')}
            className={cx(
              found.length === 0 ? 'hidden' : 'flex',
              'max-h-[320px] flex-col gap-1 overflow-y-auto'
            )}
          >
            {found.map((entry, index) => (
              // The keyboard is handled on the field above (arrows move the highlight, `Enter`
              // chooses); this `onClick` is the pointer path onto the same `choose`, as in
              // `Combobox`. `onMouseDown` keeps focus on the field, as the pattern requires.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={entry.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
                onMouseMove={() => setActive(index)}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm',
                  TOUCH_TARGET_HEIGHT,
                  // Told apart by more than its colour: the highlight also draws an edge.
                  index === highlighted
                    ? 'bg-c-accent-soft text-c-accent-ink ring-1 ring-c-accent-ink ring-inset'
                    : 'text-c-ink-2'
                )}
              >
                {entry.kind === 'text' ? (
                  <span aria-hidden="true" className="w-4 shrink-0 text-center text-c-ink-3">
                    #
                  </span>
                ) : (
                  <SpeakerIcon />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{entry.label}</span>
                <span className="shrink-0 truncate text-xs text-c-ink-3">
                  {entry.kind === 'audio'
                    ? t('console.workspace.search.label-audio')
                    : (entry.category ?? '')}
                </span>
              </li>
            ))}
          </ul>
          {/* Mounted with the dialog and kept in the accessibility tree while empty (`sr-only`,
              not `hidden`), so a screen reader hears the words when they come. */}
          <p role="status" className="px-2 text-sm text-c-ink-3 empty:sr-only">
            {found.length === 0 ? t('console.workspace.search.label-empty') : null}
          </p>
        </div>
      </Dialog>
    </>
  )
}
