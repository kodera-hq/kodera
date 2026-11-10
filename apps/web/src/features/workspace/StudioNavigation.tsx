import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../ui/Dialog/Dialog'
import { StudioGlyph, type StudioGlyphName } from '../../ui/icons/StudioGlyph'
import { studioMessages } from './studioMessages'
import { openWorkspaceCommand } from './WorkspaceMenu'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchEntry } from './ChannelSearch'

export interface StudioActivity {
  channel: ChannelSearchEntry
  unread: number
  mentions: number
  body: string
}
export interface StudioFile {
  id: string
  title: string
  channel: ChannelSearchEntry
  document?: ChannelDoc
}

export function StudioNavigation({
  section,
  compact = false,
  mode,
  onChange,
  rooms,
  onChoose,
  activity = [],
  files = [],
  onOpenDocument,
}: {
  activity?: readonly StudioActivity[]
  files?: readonly StudioFile[]
  onOpenDocument?: ((doc: ChannelDoc) => HTMLElement | null) | undefined
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
  }[] =
    section === 'call-entry'
      ? [{ name: 'calls', icon: 'calls', action: () => setPanel('calls') }]
      : section === 'primary'
        ? [
            {
              name: 'notifications',
              icon: 'bell',
              action: () => setPanel('notifications'),
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
            { name: 'files', icon: 'files', action: () => setPanel('files') },
            {
              name: 'integrations',
              icon: 'integrations',
              action: () => openWorkspaceCommand('extensions'),
            },
          ]
  const choose = (entry: ChannelSearchEntry, doc?: ChannelDoc) => {
    setPanel(null)
    const target = doc && onOpenDocument ? onOpenDocument(doc) : onChoose(entry)
    returnFocusTo.current = target ?? returnFocusTo.current
    if (compact) target?.focus()
  }
  const itemClass =
    'flex min-h-12 items-center gap-3 rounded-md border border-c-border px-3 py-2 text-left text-c-ink hover:bg-c-muted focus-visible:ring'
  const panelContent = (
    <div className="flex max-h-shell-dock-width flex-col gap-3 overflow-y-auto text-sm text-c-ink-2">
      {panel === 'calls' ? (
        <>
          <p>{copy.callsHint}</p>
          {rooms.length ? (
            rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className={itemClass}
                onClick={() => choose(room)}
              >
                <StudioGlyph name="calls" />
                {room.label}
              </button>
            ))
          ) : (
            <p>{copy.noCalls}</p>
          )}
        </>
      ) : panel === 'notifications' ? (
        <>
          <p>{copy.activityHint}</p>
          {activity.length ? (
            activity.map((item) => (
              <button
                key={item.channel.id}
                type="button"
                className={itemClass}
                onClick={() => choose(item.channel)}
              >
                <StudioGlyph name="bell" />
                <span className="flex min-w-0 flex-col gap-1">
                  <strong>#{item.channel.label}</strong>
                  <span>
                    {item.unread ? `${copy.unread}: ${item.unread} · ` : ''}
                    {item.mentions ? `${copy.mentions}: ${item.mentions}` : copy.recent}
                  </span>
                  <span className="line-clamp-2 text-xs break-words text-c-ink-2">{item.body}</span>
                </span>
              </button>
            ))
          ) : (
            <p>{copy.noNotifications}</p>
          )}
        </>
      ) : panel === 'files' ? (
        <>
          {files.length ? (
            files.map((file) => (
              <button
                key={file.id}
                type="button"
                className={itemClass}
                onClick={() => choose(file.channel, file.document)}
              >
                <StudioGlyph name={file.document ? 'docs' : 'files'} />
                <span className="flex min-w-0 flex-col gap-1">
                  <strong className="break-words">{file.title}</strong>
                  <span className="text-xs text-c-ink-2">
                    #{file.channel.label}
                    {file.document ? ` · ${copy.openDocument}` : ''}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p>{copy.noFiles}</p>
          )}
        </>
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
