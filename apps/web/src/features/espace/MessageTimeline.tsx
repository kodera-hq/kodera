// A channel's message log: how far back it reaches, its day and « new messages » dividers, what
// is drawn between the messages (polls), and one `MessageRow` per message. Memoised, and it reads
// the store itself: it is drawn again when the room's messages, its members' presence or its
// threads change, never when the member types, when a call's sound level moves or when a sidebar
// is resized. Each row then draws only if its own message, or what is said about it, changed.
//
// Virtual (docs/specs/espace-timeline-scale.md): of a room's thousands of messages, only the rows
// on screen and a margin around them are in the page, at most `MAX_DRAWN_ROWS`; two spacers hold
// the others' place (`timelineVirtualizer.ts`). Each row carries its own top gap, so a row's
// measured height is all the room it takes.

import { memo, useCallback, useImperativeHandle, useSyncExternalStore } from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { demoMessages } from '../../app/demoMessages'
import { calendarDay, formatDayDivider, previousCalendarDay } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { TimelineDivider } from '../../ui/TimelineDivider/TimelineDivider'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { MemberProfile } from '../profile/UserProfilePopover'
import {
  mergeTimelineInserts,
  NO_MESSAGES,
  profileRoleIn,
  type EspaceStoreLike,
  type TimelineInsert,
} from './liveViewModel'
import type { History } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { MessageRow, type MessageRowActions } from './MessageRow'
import { quarterHourDays, timelineRows, type TimelineRow } from './timelineRows'
import { ROW_KEY_ATTRIBUTE, useTimelineVirtualizer } from './timelineVirtualizer'
import { useCalendarToday } from './useCalendarToday'

/** What the view can ask of the log: bring a message into sight, drawing it first. */
export interface MessageTimelineHandle {
  /** Scrolls to the message with this event id; false when it is not in the loaded history. */
  showMessage: (eventId: string) => boolean
}

type LogRow = TimelineRow | { kind: 'insert'; key: string; node: ReactNode }

/** A row's height before the browser has laid it out, its 8 px top gap included. */
function estimateOf(row: LogRow | undefined): number {
  if (row === undefined || row.kind === 'message') return 72
  if (row.kind === 'insert') return 160
  return 40
}

/** The calendar day of a moment, remembered per quarter hour across every log drawn. */
const dayOfMessage = quarterHourDays(calendarDay)

/** How long a message brought into sight stays marked. */
const SHOWN_MARK_MS = 1600

/** The top of the message log: how far back it reaches, and the way to read further. */
function HistoryEdge({
  history,
  channel,
  onLoadOlder,
}: {
  history: History
  channel: string
  onLoadOlder: () => void
}) {
  const { t } = useTranslation()
  if (history === 'start') {
    return (
      <p className="py-2 text-center text-xs text-c-ink-3">
        {t('console.workspace.channel.label-history-start', { channel })}
      </p>
    )
  }
  if (history === 'loading') {
    return (
      <p className="py-2 text-center text-xs text-c-ink-3">
        {t('console.workspace.channel.status-loading-older')}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 py-2 text-xs text-c-ink-3">
      {history === 'failed' ? <span>{t('console.workspace.channel.error-load-older')}</span> : null}
      <Button variant="secondary" size="sm" onClick={onLoadOlder}>
        {history === 'failed'
          ? t('console.common.action-retry')
          : t('console.workspace.channel.action-load-older')}
      </Button>
    </div>
  )
}

const NO_PINS: readonly string[] = []
const pinSets = new WeakMap<readonly string[], ReadonlySet<string>>()

/** The room's pins as a set, built once per list. */
function pinSetOf(pins: readonly string[]): ReadonlySet<string> {
  let set = pinSets.get(pins)
  if (set === undefined) {
    set = new Set(pins)
    pinSets.set(pins, set)
  }
  return set
}

/** Each loaded message by event id, the first that carries it; built once per timeline. */
const eventIndexes = new WeakMap<
  readonly MessageView[],
  { length: number; index: Map<string, MessageView> }
>()

/** The message a reply answers, among the loaded ones: the first that carries each event id. */
function firstByEventId(timeline: readonly MessageView[]): ReadonlyMap<string, MessageView> {
  const cached = eventIndexes.get(timeline)
  // A store that changed its array in place changed its length too: built again.
  if (cached !== undefined && cached.length === timeline.length) return cached.index
  const found = new Map<string, MessageView>()
  for (const message of timeline) {
    if (!found.has(message.eventId)) found.set(message.eventId, message)
  }
  eventIndexes.set(timeline, { length: timeline.length, index: found })
  return found
}

export interface MessageTimelineProps {
  store: EspaceStoreLike
  /** The room shown; none while the channel's room is not found, when the log is empty. */
  roomId: string | null
  channelId: string
  /** The channel as the sidebar labels it: the log's name and its welcome. */
  channelName: string
  viewerId: string
  archived: boolean
  simulation: boolean
  /** The message whose thread is open beside the log. */
  expandedEventId: string | null
  /** The first message the member has not read: « Nouveaux messages » is drawn before it. */
  unreadFrom: string | null
  /** What a message's menu belongs to (the session, the member, the room): another closes it. */
  menuContext: string
  documents: readonly ChannelDoc[]
  onOpenDocument: ((doc: ChannelDoc) => void) | undefined
  inserts: readonly TimelineInsert[]
  /** « Mentionner », from an author's profile; none where the member cannot write. */
  onMention: ((member: MemberProfile) => void) | undefined
  actions: MessageRowActions
  /** The log's scrolling (`useTimelineScroll`), which the view keeps across the log's absences. */
  logRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  onLoadOlder: () => void
  /** Filled with what the view can ask of the log (`MessageTimelineHandle`). */
  handleRef?: Ref<MessageTimelineHandle> | undefined
}

function MessageTimelineView({
  store,
  roomId,
  channelId,
  channelName,
  viewerId,
  archived,
  simulation,
  expandedEventId,
  unreadFrom,
  menuContext,
  documents,
  onOpenDocument,
  inserts,
  onMention,
  actions,
  logRef,
  onScroll,
  onLoadOlder,
  handleRef,
}: MessageTimelineProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const demoCopy = demoMessages[locale]
  // The snapshot is the token for the store's getters: each one below is read again with it.
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  const timeline = roomId !== null ? store.getTimeline(roomId) : NO_MESSAGES
  const history = roomId !== null ? store.getHistory?.(roomId) : undefined
  /** A day divider's label: « Aujourd’hui », « Hier », or the date, with its year if not this one. */
  const today = useCalendarToday()
  function dayLabel(day: string, ts: number): string {
    if (day === today) return t('console.workspace.channel.label-day-today')
    if (day === previousCalendarDay(today))
      return t('console.workspace.channel.label-day-yesterday')
    return formatDayDivider(ts, locale, day.slice(0, 4) !== today.slice(0, 4))
  }
  // Read again at every draw, not memoised on the array: a store may hand back the same array
  // changed in place, and the log must draw what it holds now.
  const byEventId = firstByEventId(timeline)
  const pins = pinSetOf(roomId !== null ? (store.getPinned?.(roomId) ?? NO_PINS) : NO_PINS)
  const canPin = roomId !== null && !archived && store.canPin?.(roomId) === true
  const pin = useCallback(
    (eventId: string, pinned: boolean) => {
      if (roomId === null) return
      // Refused (no right, no network): the pins stay as the room has them, which is what shows.
      store.setPinned?.(roomId, eventId, pinned).catch(() => undefined)
    },
    [store, roomId]
  )
  const shown =
    timeline.length === 0
      ? []
      : timelineRows(timeline, { dayOf: dayOfMessage, unreadFrom, me: viewerId })
  const rows: readonly LogRow[] =
    shown.length === 0 && inserts.length === 0 ? [] : mergeTimelineInserts(shown, inserts)
  const keys = rows.map((row) => row.key)
  const estimate = (index: number) => estimateOf(rows[index])
  const { window, listRef, beforeRef, afterRef, layout } = useTimelineVirtualizer({
    keys,
    estimate,
    scrollRef: logRef,
  })
  useImperativeHandle(
    handleRef,
    () => ({
      showMessage(eventId) {
        // Read when asked, not when drawn: the message may have arrived since.
        const loaded = roomId === null ? NO_MESSAGES : store.getTimeline(roomId)
        const message = firstByEventId(loaded).get(eventId)
        if (message === undefined || !layout.scrollToKey(message.key)) return false
        const element = layout.rowElement(message.key)
        if (element !== undefined) {
          element.dataset.shown = 'true'
          setTimeout(() => delete element.dataset.shown, SHOWN_MARK_MS)
          // The row itself takes the focus, out of the tab order: the next Tab reaches its controls.
          element.tabIndex = -1
          element.focus({ preventScroll: true })
        }
        return true
      },
    }),
    [layout, store, roomId]
  )

  return (
    <div
      ref={logRef}
      onScroll={onScroll}
      role="log"
      aria-label={t('console.workspace.channel.log-label', {
        channel: channelName,
      })}
      aria-busy={history === 'loading' ? true : undefined}
      // Conversation history begins under the header, matching the document canvas.
      className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-2 [overflow-anchor:none]"
    >
      {history === undefined || (history === 'start' && timeline.length === 0) ? null : (
        <HistoryEdge history={history} channel={channelName} onLoadOlder={onLoadOlder} />
      )}
      {history === 'start' || (timeline.length === 0 && history === undefined) ? (
        <div className="flex flex-col gap-2 py-8">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-c-muted text-xl text-c-ink-3"
          >
            #
          </span>
          <h2 className="text-xl font-bold text-c-ink">
            {t('console.workspace.channel.welcome-title', { channel: channelName })}
          </h2>
          {timeline.length === 0 ? (
            <p className="text-sm text-c-ink-3">
              {t('console.workspace.channel.live-empty', { channel: channelName })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div ref={listRef} className="flex flex-col">
        <div ref={beforeRef} aria-hidden="true" data-timeline-spacer="before" />
        {rows.slice(window.start, window.end).map((row, offset) => (
          <div
            key={row.key}
            {...{ [ROW_KEY_ATTRIBUTE]: row.key }}
            {...(row.kind === 'insert' ? { 'data-testid': 'espace-timeline-insert' } : {})}
            // The log's 8 px gap, carried by the row so its measured height is the room it takes.
            className={`rounded-md transition-colors data-[shown=true]:bg-c-muted ${
              window.start + offset === 0 ? '' : 'pt-2'
            }`}
          >
            {row.kind === 'insert' ? (
              row.node
            ) : row.kind === 'day' ? (
              <TimelineDivider>{dayLabel(row.day, row.ts)}</TimelineDivider>
            ) : row.kind === 'new' ? (
              <TimelineDivider tone="new">
                {t('console.workspace.channel.label-new-messages')}
              </TimelineDivider>
            ) : (
              <MessageRow
                profileRole={profileRoleIn(store, roomId, row.message.sender)}
                onMention={onMention}
                onlineLabel={
                  store.isOnline?.(row.message.sender)
                    ? simulation
                      ? demoCopy.presence
                      : t('console.workspace.presence.online')
                    : undefined
                }
                document={documents.find(
                  (doc) => doc.id === row.message.document?.id && doc.channelId === channelId
                )}
                onOpenDocument={onOpenDocument}
                message={row.message}
                placement="timeline"
                viewerId={viewerId}
                archived={archived}
                expanded={expandedEventId === row.message.eventId}
                repliedMessage={
                  row.message.replyTo === null ? undefined : byEventId.get(row.message.replyTo)
                }
                threadReplies={
                  roomId === null ? NO_MESSAGES : store.getThread(roomId, row.message.eventId)
                }
                menuContextKey={`${menuContext}:${row.message.key}`}
                pinned={pins.has(row.message.eventId)}
                onPin={canPin ? pin : undefined}
                onRetry={actions.onRetry}
                onReaction={actions.onReaction}
                onReply={actions.onReply}
                onEdit={actions.onEdit}
                onRemove={actions.onRemove}
                onOpenThread={actions.onOpenThread}
              />
            )}
          </div>
        ))}
        <div ref={afterRef} aria-hidden="true" data-timeline-spacer="after" />
      </div>
    </div>
  )
}

export const MessageTimeline = memo(MessageTimelineView)
