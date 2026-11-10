import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../ui/Dialog/Dialog'
import { StudioGlyph, type StudioGlyphName } from '../../ui/icons/StudioGlyph'
import { studioMessages } from './studioMessages'
import { openWorkspaceCommand } from './WorkspaceMenu'
import type { ChannelSearchEntry } from './ChannelSearch'

export function StudioNavigation({
  section,
  compact = false,
  mode,
  onChange,
  rooms,
  onChoose,
}: {
  compact?: boolean
  section: 'primary' | 'tools' | 'call-entry'
  mode: 'chat' | 'docs'
  onChange?: ((mode: 'chat' | 'docs') => void) | undefined
  rooms: readonly ChannelSearchEntry[]
  onChoose: (room: ChannelSearchEntry) => HTMLElement | null
}) {
  const { i18n } = useTranslation()
  const copy = studioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const inlinePanel = useRef<HTMLElement | null>(null)
  const [panel, setPanel] = useState<'notifications' | 'files' | 'calls' | null>(null)
  // The drawer handles Escape at document capture. Consume it first only when
  // focus is inside this nested inline panel; the next Escape belongs to the drawer.
  useEffect(() => {
    if (!compact || panel === null) return
    const close = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !(event.target instanceof Node) ||
        !inlinePanel.current?.contains(event.target)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      setPanel(null)
      returnFocusTo.current?.focus()
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [compact, panel])
  const entries: {
    name: 'notifications' | 'messages' | 'docs' | 'calls' | 'files' | 'integrations'
    icon: StudioGlyphName
    action: () => void
    selected?: boolean
    unavailable?: boolean
  }[] =
    section === 'call-entry'
      ? [{ name: 'calls', icon: 'calls', action: () => setPanel('calls') }]
      : section === 'primary'
        ? [
            {
              name: 'notifications',
              icon: 'bell',
              action: () => setPanel('notifications'),
              unavailable: true,
            },
            {
              name: 'messages',
              icon: 'message',
              action: () => onChange?.('chat'),
              selected: mode === 'chat',
            },
          ]
        : [
            {
              name: 'docs',
              icon: 'docs',
              action: () => onChange?.('docs'),
              selected: mode === 'docs',
            },
            { name: 'calls', icon: 'calls', action: () => setPanel('calls') },
            { name: 'files', icon: 'files', action: () => setPanel('files'), unavailable: true },
            {
              name: 'integrations',
              icon: 'integrations',
              action: () => openWorkspaceCommand('extensions'),
            },
          ]
  const panelContent = (
    <div className="flex flex-col gap-3 text-sm text-c-ink-2">
      <p>
        {panel === 'calls'
          ? copy.callsHint
          : panel === 'files'
            ? copy.fileGap
            : copy.notificationGap}
      </p>
      {panel === 'calls' ? (
        rooms.length ? (
          rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className="flex min-h-12 items-center gap-2 rounded-md border border-c-border px-3 text-c-ink focus-visible:ring"
              onClick={() => {
                setPanel(null)
                const target = onChoose(room)
                returnFocusTo.current = target ?? returnFocusTo.current
                if (compact) target?.focus()
              }}
            >
              <StudioGlyph name="calls" />
              {room.label}
            </button>
          ))
        ) : (
          <p>{copy.noCalls}</p>
        )
      ) : null}
    </div>
  )
  const closePanel = () => {
    setPanel(null)
    returnFocusTo.current?.focus()
  }
  return (
    <>
      <div
        className={
          section === 'tools'
            ? 'mt-3 flex flex-col gap-1 border-t border-c-border-soft pt-3'
            : 'flex flex-col gap-1'
        }
      >
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.name}
            onClick={(event) => {
              returnFocusTo.current = event.currentTarget
              entry.action()
            }}
            title={entry.unavailable ? copy.unavailable : undefined}
            aria-pressed={entry.selected}
            disabled={!onChange && (entry.name === 'docs' || entry.name === 'messages')}
            data-testid={
              entry.name === 'docs'
                ? 'workspace-docs-editor-toggle'
                : entry.name === 'messages'
                  ? 'espace-canvas-mode-chat'
                  : undefined
            }
            className={`flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-left text-sm focus-visible:ring focus-visible:outline-hidden narrow:min-h-12 ${entry.selected ? 'bg-c-ok-soft font-bold text-c-ink' : 'text-c-ink-2 hover:bg-c-muted'}`}
          >
            <StudioGlyph name={entry.icon} />
            <span>{section === 'call-entry' ? copy.audioOnly : copy[entry.name]}</span>
            {entry.unavailable ? (
              <span aria-hidden="true" className="ml-auto text-xs text-c-ink-3">
                —
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {compact ? (
        panel ? (
          <section
            aria-label={copy[panel]}
            ref={inlinePanel}
            className="my-2 rounded-md border border-c-border bg-c-surface p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <strong className="text-sm text-c-ink">{copy[panel]}</strong>
              <button
                type="button"
                className="min-h-12 rounded-sm px-2 text-sm text-c-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:ring focus-visible:outline-hidden"
                onClick={closePanel}
              >
                {copy.close}
              </button>
            </div>
            {panelContent}
          </section>
        ) : null
      ) : (
        <Dialog
          returnFocusTo={returnFocusTo}
          open={panel !== null}
          onOpenChange={(open) => {
            if (!open) setPanel(null)
          }}
          title={panel ? copy[panel] : ''}
          closeLabel={copy.close}
        >
          {panelContent}
        </Dialog>
      )}
    </>
  )
}
