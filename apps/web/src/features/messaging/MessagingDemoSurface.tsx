// Demonstration only: imported exclusively by the explicit mock/MSW build,
// through the dynamic `import()` in `src/app/routeTree.ts`.
//
// WHAT THIS IS. A picture of Tchap — the French state's Matrix-based
// messaging service, part of La Suite — as it looks inside a kodera.io
// instance. kodera.io *integrates* Tchap (`contracts/core-api.openapi.yaml`,
// `TenantApp.app` `enum: [visio, docs, drive, tchap, grist]`); this repository
// implements no messenger, and nothing here talks to one. The surface renders
// a fixed fixture and sends nothing anywhere, which the copy on the page says
// in the customer's own words rather than leaving to a reader's inference.
//
// Layout follows the product design handoff: a contextual sidebar of channels
// and then the permanent audio/video rooms with their occupants, the
// conversation with a day separator and messages carrying author, role chip
// and time, a composer, and a member list on the right. Widths are the shell
// geometry tokens (`--shell-sidebar-width`, `--shell-document-min-width`,
// `--shell-dock-width`), never numbers invented here.

import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime, formatWeekdayDate } from '../../i18n/format'
import type { Locale } from '../../i18n/format'
import { initialsOf } from '../../ui/Avatar/Avatar'
import { cx } from '../../ui/cx'
import {
  DEMO_CHANNELS,
  DEMO_MEMBERS,
  DEMO_MESSAGES,
  DEMO_ORGANISATION,
  DEMO_ROOMS,
  DEMO_SEEDED_CHANNEL_ID,
  DEMO_WORKSPACE,
  demoChannel,
  demoPerson,
} from './demo-fixture'
import type {
  DemoOccupantState,
  DemoPerson,
  DemoRoom,
  DemoRoomKind,
  DemoTint,
} from './demo-fixture'
import { PAGE_TITLE } from '../../ui/pageTitle'

/** The six themed tint pairs, written as literal class names. Tailwind scans
 * source text, so a class assembled at runtime from a template string and the
 * tint name would emit no CSS rule and no error — the exact silent failure
 * ADR-0004's token guard exists to catch. (Writing that template out even in
 * a comment fails the guard, which does not strip comments before scanning,
 * deliberately: a missed colour costs a palette, a reworded comment costs
 * nothing.) */
const TINT_CLASS = {
  t1: 'bg-c-t1-bg text-c-t1-fg',
  t2: 'bg-c-t2-bg text-c-t2-fg',
  t3: 'bg-c-t3-bg text-c-t3-fg',
  t4: 'bg-c-t4-bg text-c-t4-fg',
  t5: 'bg-c-t5-bg text-c-t5-fg',
  t6: 'bg-c-t6-bg text-c-t6-fg',
} as const satisfies Record<DemoTint, string>

const ROOM_KIND_KEY = {
  audio: 'console.messaging.demo.room-kind-audio',
  video: 'console.messaging.demo.room-kind-video',
  screen: 'console.messaging.demo.room-kind-screen',
} as const satisfies Record<DemoRoomKind, string>

const OCCUPANT_STATE_KEY = {
  speaking: 'console.messaging.demo.state-speaking',
  muted: 'console.messaging.demo.state-muted',
  sharing: 'console.messaging.demo.state-sharing',
  available: 'console.messaging.demo.state-available',
  listening: 'console.messaging.demo.state-listening',
} as const satisfies Record<DemoOccupantState, string>

/** Initials on a tinted square. `aria-hidden`: every one of these sits beside
 * the person's name in text, so announcing "SE" before "Sylvain Ellenstein" would
 * read the same person twice.
 *
 * `className` sets the size, never the radius: two radius utilities on one
 * element are resolved by the order Tailwind emits them in, not by the order
 * they are written, so a caller's `rounded-full` here was silently losing to
 * the `rounded-md` below — a dead class that looks like a decision. One
 * radius, decided in one place. */
function DemoAvatar({ person, className }: { person: DemoPerson; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex flex-none items-center justify-center rounded-md font-semibold',
        TINT_CLASS[person.tint],
        className ?? 'h-8 w-8 text-xs'
      )}
    >
      {initialsOf(person.name)}
    </span>
  )
}

function RoomItem({ room }: { room: DemoRoom }) {
  const { t } = useTranslation()
  const occupied = room.occupants.length > 0
  return (
    <li className="flex flex-col gap-1 py-1">
      <p className="truncate px-2 py-1 text-sm font-medium text-c-ink-2">{room.name}</p>
      {/* Two independent labels on one line, separated the way the rest of the
          console separates metadata — not a sentence built by concatenation,
          which docs/dev/I18N.md forbids because it only ever reads correctly
          in the language it was written in. */}
      <p className="px-2 text-xs text-c-ink-3">
        {t(ROOM_KIND_KEY[room.kind])}
        {' · '}
        <span className={cx('font-mono', occupied ? 'text-c-ok-ink' : 'text-c-ink-3')}>
          {occupied
            ? t('console.messaging.demo.room-occupancy', {
                count: room.occupants.length,
                capacity: room.capacity,
              })
            : t('console.messaging.demo.room-empty', { capacity: room.capacity })}
        </span>
      </p>
      {occupied ? (
        <ul aria-label={t('console.messaging.demo.room-occupants-label', { room: room.name })}>
          {room.occupants.map((occupant) => {
            const person = demoPerson(occupant.personId)
            return (
              <li key={occupant.personId} className="flex items-center gap-2 px-2 py-1">
                <DemoAvatar person={person} className="h-5 w-5 text-xs" />
                <span className="min-w-0 truncate text-xs text-c-ink-2">{person.name}</span>
                <span className="flex-none text-xs text-c-ink-3">
                  {t(OCCUPANT_STATE_KEY[occupant.state])}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

export function MessagingDemoSurface() {
  const { t, i18n } = useTranslation()
  const locale: Locale = i18n.language === 'en' ? 'en' : 'fr'
  const [channelId, setChannelId] = useState<string>(DEMO_SEEDED_CHANNEL_ID)
  const [draft, setDraft] = useState('')
  // Whether the composer has been submitted at least once, which is all a
  // preview with nowhere to send to can honestly record.
  const [submitted, setSubmitted] = useState(false)
  const composerId = useId()
  const composerHintId = useId()

  const channel = demoChannel(channelId)
  const seeded = channel.id === DEMO_SEEDED_CHANNEL_ID
  const firstMessage = DEMO_MESSAGES[0]

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDraft('')
    setSubmitted(true)
  }

  return (
    <div
      data-messaging-demo-surface="true"
      className="mx-auto flex w-full max-w-[1384px] flex-col gap-6 px-6 py-8"
    >
      <header className="flex flex-col gap-2">
        <p className="w-fit rounded-full bg-c-warn-soft px-3 py-1 text-xs font-semibold text-c-warn-ink">
          {t('console.messaging.demo.badge')}
        </p>
        <h1 className={PAGE_TITLE}>{t('console.messaging.demo.title')}</h1>
        <p className="text-sm text-c-ink-2">
          {t('console.messaging.demo.subtitle', { organisation: DEMO_ORGANISATION })}
        </p>
        <p className="max-w-shell-document-max-width text-sm leading-body text-c-ink-2">
          {t('console.messaging.demo.notice')}
        </p>
      </header>

      <div className="flex h-[720px] overflow-hidden rounded-lg border border-c-border bg-c-surface shadow-card shadow-c-shadow-1">
        <nav
          aria-label={t('console.messaging.demo.navigation-label')}
          className="hidden w-shell-sidebar-width flex-none flex-col gap-4 overflow-y-auto border-r border-c-border-soft bg-c-sunken px-3 py-4 md:flex"
        >
          <section className="flex flex-col gap-1">
            <h2 className="px-2 text-xs font-semibold tracking-snug text-c-ink-3 uppercase">
              {t('console.messaging.demo.channels-title')}
            </h2>
            <ul>
              {DEMO_CHANNELS.map((entry) => {
                const current = entry.id === channelId
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      {...(current ? { 'aria-current': 'true' as const } : {})}
                      onClick={() => {
                        setChannelId(entry.id)
                        setSubmitted(false)
                      }}
                      className={cx(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
                        'focus-visible:ring focus-visible:outline-hidden',
                        current
                          ? 'bg-c-surface font-semibold text-c-accent-ink'
                          : 'font-medium text-c-ink-2 hover:bg-c-muted'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.unread === undefined ? null : (
                        <span className="flex-none rounded-full bg-c-bad px-2 text-xs font-semibold text-c-on-inverse">
                          <span aria-hidden="true">{entry.unread}</span>
                          <span className="sr-only">
                            {t('console.messaging.demo.unread', { count: entry.unread })}
                          </span>
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="px-2 text-xs font-semibold tracking-snug text-c-ink-3 uppercase">
              {t('console.messaging.demo.rooms-title')}
            </h2>
            <p className="px-2 pb-1 text-xs leading-body text-c-ink-3">
              {t('console.messaging.demo.rooms-hint')}
            </p>
            <ul>
              {DEMO_ROOMS.map((room) => (
                <RoomItem key={room.id} room={room} />
              ))}
            </ul>
          </section>
        </nav>

        <div className="flex min-w-shell-document-min-width flex-1 flex-col">
          <div className="flex flex-none items-baseline gap-3 border-b border-c-border-soft px-6 py-4">
            <h2 className="text-lg font-semibold tracking-snug text-c-ink">{channel.name}</h2>
            <p className="text-xs text-c-ink-3">
              {DEMO_WORKSPACE} ·{' '}
              {t('console.messaging.demo.members-title', { count: DEMO_MEMBERS.length })}
            </p>
          </div>

          {/* `tabIndex={0}` on a named region, not decoration: the conversation
              scrolls, and a scrollable box containing nothing focusable can be
              read by a mouse and by nobody else — axe's
              `scrollable-region-focusable`, which this surface was failing
              before the attribute went on. The member list below scrolls for
              the same reason and carries it for the same reason; the channel
              nav does not need it, because its own buttons already put it in
              the tab order. */}
          <div
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 focus-visible:ring focus-visible:outline-hidden"
            aria-label={t('console.messaging.demo.conversation-label', { channel: channel.name })}
            role="region"
            tabIndex={0}
          >
            {seeded && firstMessage !== undefined ? (
              <>
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="h-px flex-1 bg-c-border-soft" />
                  <h3 className="text-xs font-medium text-c-ink-3">
                    {formatWeekdayDate(firstMessage.at, locale)}
                  </h3>
                  <span aria-hidden="true" className="h-px flex-1 bg-c-border-soft" />
                </div>
                <ol className="flex flex-col gap-5">
                  {DEMO_MESSAGES.map((message) => {
                    const person = demoPerson(message.personId)
                    return (
                      <li key={message.id} className="flex items-start gap-3">
                        <DemoAvatar person={person} className="h-8 w-8 text-xs" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-sm font-semibold text-c-ink">{person.name}</span>
                            <span className="rounded-sm bg-c-accent-soft px-2 text-xs text-c-accent-ink">
                              {person.shortRole}
                            </span>
                            <time dateTime={message.at} className="font-mono text-xs text-c-ink-3">
                              {formatTime(message.at, locale)}
                            </time>
                          </div>
                          <p className="text-sm leading-body text-c-ink">{message.text}</p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <h3 className="text-sm font-semibold text-c-ink">
                  {t('console.messaging.demo.empty-title')}
                </h3>
                <p className="max-w-shell-document-min-width text-sm leading-body text-c-ink-2">
                  {t('console.messaging.demo.empty-body', {
                    channel: demoChannel(DEMO_SEEDED_CHANNEL_ID).name,
                  })}
                </p>
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="flex flex-none flex-col gap-2 px-6 pb-5">
            <label htmlFor={composerId} className="text-sm font-medium text-c-ink-2">
              {t('console.messaging.demo.composer-label', { channel: channel.name })}
            </label>
            <textarea
              id={composerId}
              aria-describedby={composerHintId}
              rows={2}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setSubmitted(false)
              }}
              className="w-full resize-none rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm leading-body text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
            <div className="flex items-center gap-3">
              <p id={composerHintId} className="min-w-0 flex-1 text-xs leading-body text-c-ink-3">
                {t('console.messaging.demo.composer-hint')}
              </p>
              <button
                type="submit"
                className="focus-offset flex-none rounded-md bg-c-action px-4 py-2 text-sm font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden"
              >
                {t('console.messaging.demo.composer-send')}
              </button>
            </div>
            {/* A live region rather than a toast: the one thing submitting can
                truthfully report is that nothing left the browser. */}
            <p role="status" className="text-xs leading-body text-c-warn-ink">
              {submitted ? t('console.messaging.demo.composer-sent') : ''}
            </p>
          </form>
        </div>

        {/* `role="region"` rather than an `<aside>`: this box scrolls and holds
            nothing focusable, so it has to be a tab stop of its own (axe's
            `scrollable-region-focusable`), and `region` is the one role
            eslint.config.js allows `tabIndex` on — a decision that repo made
            deliberately, for exactly this shape. A named `region` is a
            landmark too, so nothing is lost against `complementary`. */}
        <div
          role="region"
          aria-label={t('console.messaging.demo.members-label', { channel: channel.name })}
          tabIndex={0}
          className="hidden w-shell-dock-width flex-none flex-col gap-3 overflow-y-auto border-l border-c-border-soft px-4 py-4 focus-visible:ring focus-visible:outline-hidden xl:flex"
        >
          <h2 className="text-xs font-semibold tracking-snug text-c-ink-3 uppercase">
            {t('console.messaging.demo.members-title', { count: DEMO_MEMBERS.length })}
          </h2>
          <ul className="flex flex-col gap-3">
            {DEMO_MEMBERS.map((person) => (
              <li key={person.id} className="flex items-center gap-3">
                <DemoAvatar person={person} className="h-8 w-8 text-xs" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-c-ink">{person.name}</span>
                  <span className="truncate text-xs text-c-ink-3">{person.role}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
