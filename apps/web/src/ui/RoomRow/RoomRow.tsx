import { forwardRef, useId, useState } from 'react'
import type { ButtonHTMLAttributes, Ref } from 'react'
import { Avatar } from '../Avatar/Avatar'
import { cx } from '../cx'
import { EspaceGlyph } from '../icons/EspaceGlyph'
import { hasLabel } from '../stateLabel'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

/**
 * An always-open audio room in Espace's sidebar (`design specification`
 * `design/reference/p02-messages.html`, `.room` and `.people`): a speaker, the
 * name and how many people are in it, then who they are.
 *
 * The row itself is the join action: a button. Its accessible name is the
 * caller's `joinLabel` (« Rejoindre Point quotidien »), then the occupancy the
 * row draws (`occupancyLabel(n)`, « 3 personnes », « vide »), then each state
 * that is on, in the caller's words. A state is on when its label is given and
 * not empty (`hasLabel`); the same predicate decides the look and the name.
 *
 * - `connected`: the viewer is in this room's call. Only then does the row take
 *   the live look: `c-surface` with a `c-border-soft` inset edge, `c-ink`
 *   semibold, the speaker in `c-ok`, and the word drawn. An occupied room the
 *   viewer is not in keeps the idle tone.
 * - `listenOnly`: the viewer may listen and not speak — a struck microphone
 *   and the word.
 * - `unavailable`: the viewer sees the room and cannot join it — the button is
 *   disabled, with a lock and the reason in words.
 *
 * Occupants nest under the row as a named list: a 20 px `Avatar` and the name,
 * and, on a second line, the caller's words when that person shares a screen.
 * Past `maxOccupants` the rest fold behind a « +N » button (`aria-expanded`,
 * `aria-controls`, named by `overflowLabel(n)`) that reveals them in place.
 *
 * Who is speaking rings their face in `c-ok`, and only in the room the viewer
 * is connected to: LiveKit sends who speaks only to people inside the call, so
 * no one outside it sees a ring. The caller marks a face `speaking`, or, for
 * the viewer's own, hands a `speakingRef` whose element it marks with
 * `data-speaking` frame by frame, so the ring follows the viewer's microphone
 * even alone in the room, without a render. The design of record keeps
 * speaking out of the sidebar (`design/reference/README.md`); the W2 plan,
 * newer, asks for a ring that works alone, and the sidebar is the only place a
 * call is drawn until a call view exists.
 */
export interface RoomOccupant {
  /** Stable key, such as the Matrix user ID. */
  id: string
  name: string
  onlineLabel?: string | undefined
  /** A photo; initials otherwise. */
  src?: string
  /** Shares a screen: the occupant shows the room's `sharingLabel`. */
  sharingScreen?: boolean
  /** Speaking now, as the call says: the face is ringed. */
  speaking?: boolean
  /** The viewer's own face: the caller rings it by setting `data-speaking` on this element. */
  speakingRef?: Ref<HTMLElement>
}

export interface RoomRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'name' | 'disabled'
> {
  /** The room's name. */
  name: string
  /** The join action's words, without the count, e.g. « Rejoindre Point quotidien ». */
  joinLabel: string
  /** The occupancy, drawn and read: (3) => « 3 personnes », (0) => « vide ». */
  occupancyLabel: (count: number) => string
  /** Who is in the room, in the order to show them. */
  occupants?: readonly RoomOccupant[]
  /** The occupant list's accessible name, e.g. « Dans Point quotidien ». */
  occupantsLabel: string
  /** The words under someone who shares a screen, e.g. « partage son écran ». */
  sharingLabel: string
  /** How many occupants show before the rest fold behind « +N ». */
  maxOccupants?: number
  /** The « +N » button's name, e.g. (3) => « Afficher 3 autres personnes ». */
  overflowLabel: (hidden: number) => string
  /** The viewer is in this room's call: the word drawn and read, e.g. « Connecté ». */
  connected?: string
  /** The viewer may listen and not speak, e.g. « écoute seule ». */
  listenOnly?: string
  /** The viewer cannot join: the reason, drawn and read, e.g. « réservé à la direction ». */
  unavailable?: string
}

const ROW =
  'flex w-full min-h-8 items-center gap-2 rounded-sm px-2 text-left text-md focus-visible:ring focus-visible:outline-hidden'

/** A face that speaks: ringed in `c-ok`. */
const SPEAKING_RING = 'data-[speaking]:ring-2 data-[speaking]:ring-c-ok'

const TONE = {
  idle: 'font-regular text-c-ink-3 hover:bg-c-muted hover:text-c-ink',
  live: 'font-semibold text-c-ink hover:bg-c-muted',
  unavailable: 'cursor-not-allowed font-regular text-c-ink-3',
} as const

/** An audio room. Rendered inside an `<li>` it creates itself. */
export const RoomRow = forwardRef<HTMLButtonElement, RoomRowProps>(function RoomRow(
  {
    name,
    joinLabel,
    occupancyLabel,
    occupants = [],
    occupantsLabel,
    sharingLabel,
    maxOccupants = 5,
    overflowLabel,
    connected,
    listenOnly,
    unavailable,
    className,
    type = 'button',
    ...rest
  },
  ref
) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const isConnected = hasLabel(connected)
  const isListenOnly = hasLabel(listenOnly)
  const isUnavailable = hasLabel(unavailable)
  const occupancy = occupancyLabel(occupants.length)
  const limit = Math.max(0, maxOccupants)
  const folded = occupants.slice(limit)
  const accessibleName = [
    joinLabel,
    occupancy,
    isConnected ? connected : undefined,
    isListenOnly ? listenOnly : undefined,
    isUnavailable ? unavailable : undefined,
  ]
    .filter(hasLabel)
    .join(', ')
  const tone = isUnavailable ? TONE.unavailable : isConnected ? TONE.live : TONE.idle
  const foldedIds = folded.map((_, index) => `${id}-folded-${index}`)

  return (
    <li
      className={cx(
        'flex flex-col rounded-md',
        isConnected ? 'bg-c-surface pb-1 ring-1 ring-c-border-soft ring-inset' : ''
      )}
    >
      <button
        {...rest}
        ref={ref}
        type={type}
        disabled={isUnavailable}
        aria-label={accessibleName}
        className={cx(ROW, tone, TOUCH_TARGET_HEIGHT, className)}
      >
        <span
          aria-hidden="true"
          data-speaker=""
          className={isConnected ? 'text-c-ok' : 'text-c-ink-4'}
        >
          <EspaceGlyph name="speaker" />
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1 truncate">
          {name}
        </span>
        {isConnected ? (
          <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-c-ok-ink">
            {connected}
          </span>
        ) : null}
        {isListenOnly ? (
          <span
            aria-hidden="true"
            data-listen-only=""
            className="flex shrink-0 items-center gap-1 text-xs font-regular text-c-ink-3"
          >
            <EspaceGlyph name="mic-off" className="h-3 w-3" />
            {listenOnly}
          </span>
        ) : null}
        {isUnavailable ? (
          <span
            aria-hidden="true"
            data-unavailable=""
            className="flex min-w-0 shrink items-center gap-1 text-xs font-regular text-c-ink-3"
          >
            <EspaceGlyph name="lock" className="h-3 w-3 shrink-0" />
            <span className="truncate">{unavailable}</span>
          </span>
        ) : null}
        {occupants.length === 0 ? null : (
          <span
            aria-hidden="true"
            data-occupancy=""
            className="shrink-0 text-xs font-regular text-c-ink-3 tabular-nums"
          >
            {occupancy}
          </span>
        )}
      </button>
      {occupants.length === 0 ? null : (
        <ul aria-label={occupantsLabel} className="flex flex-col pr-2 pl-8">
          {occupants.map((occupant, index) => {
            const isFolded = index >= limit
            return (
              <li
                key={occupant.id}
                {...(isFolded ? { id: foldedIds[index - limit], hidden: !expanded } : {})}
                className="flex min-h-8 items-center gap-2 py-1 text-sm text-c-ink-2"
              >
                <Avatar
                  ref={occupant.speakingRef as Ref<HTMLImageElement | HTMLSpanElement> | undefined}
                  name={occupant.name}
                  identity={occupant.id}
                  onlineLabel={occupant.onlineLabel}
                  presenceGround={isConnected ? 'surface' : 'sunken'}
                  size="xs"
                  aria-hidden="true"
                  {...(occupant.speaking === true ? { 'data-speaking': '' } : {})}
                  className={SPEAKING_RING}
                  {...(occupant.src === undefined ? {} : { src: occupant.src })}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{occupant.name}</span>
                  <span className="sr-only">
                    {occupant.onlineLabel === undefined ? null : `, ${occupant.onlineLabel}`}
                  </span>
                  {occupant.sharingScreen === true ? (
                    <span data-sharing="" className="flex items-center gap-1 text-xs text-c-ink-3">
                      <EspaceGlyph name="screen" className="h-3 w-3 shrink-0" />
                      <span className="truncate">{sharingLabel}</span>
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
          {folded.length === 0 ? null : (
            <li className="flex">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={foldedIds.join(' ')}
                aria-label={overflowLabel(folded.length)}
                onClick={() => setExpanded((value) => !value)}
                className={cx(
                  'flex min-h-6 items-center gap-1 rounded-sm px-1 text-xs font-semibold text-c-ink-3 hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET_HEIGHT
                )}
              >
                <span aria-hidden="true" className="tabular-nums">
                  +{folded.length}
                </span>
                <EspaceGlyph
                  name="chevron"
                  className={cx('h-3 w-3 shrink-0', expanded ? '-rotate-90' : 'rotate-90')}
                />
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  )
})
