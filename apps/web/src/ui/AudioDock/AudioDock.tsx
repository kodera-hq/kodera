import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { studioMessages } from '../../features/workspace/studioMessages'
import { Avatar } from '../Avatar/Avatar'
import { StudioGlyph } from '../icons/StudioGlyph'
import type { ReactNode, Ref } from 'react'
import { cx } from '../cx'
import { initialCssProperty } from '../cssom'
import { EspaceGlyph } from '../icons/EspaceGlyph'
import type { EspaceGlyphName } from '../icons/EspaceGlyph'
import { hasLabel } from '../stateLabel'
import { TOUCH_TARGET } from '../touchTarget'
import { Tooltip } from '../Tooltip/Tooltip'

/**
 * The call the member is in, docked at the foot of Espace's sidebar
 * (`design specification` `design/reference/p02-messages.html`, `.callbar`; the
 * phone banner is `.mroom`). It stays while the member moves around Kodera.
 *
 * A named `region`: the room, its category, the call's state, and three
 * controls — mute and deafen as toggles (`aria-pressed`), and leave. With
 * `onOpenCall`, a fourth button beside the room returns to the call's own view.
 *
 * The state is `status` (`connected`, `connecting`, `reconnecting`) drawn as a
 * dot and said by `statusLabel` in the caller's words. The dot is filled only
 * when connected; while connecting or reconnecting it is a hollow ring, so the
 * state is a shape and words, never a hue alone.
 *
 * Grounds and rings follow the dark workspace reference (owner decision, 2026-11-07;
 * docs/specs/workspace-dark-roles.md): the dock is `c-inverse`, the rail's ground, with
 * `focus-ground-inverse` (`src/index.css`), so every ring inside draws the tokens'
 * on-inverse ring and its offset gap takes `c-inverse`; `inverse-edge` gives it its edge
 * in dark and black, where `c-inverse` is close to the sidebar's ground. Contrast, light /
 * dark / black, measured from tokens v0.6.0:
 * - the room in `c-on-inverse`, 17.74 / 18.51 / 20.03 : 1; the category in
 *   `c-on-inverse-dim`, 9.52 / 8.76 / 9.42;
 * - connected, the dot and the state in `c-ok-on-dark`, 12.39 / 10.96 / 11.55; waiting,
 *   the state in `c-on-inverse-dim`;
 * - the controls sit on `c-inverse-2`, their glyph 15.35 / 16.01 / 16.82 : 1. Their fill is
 *   close to the ground (1.16 : 1): the glyph is what identifies each one;
 * - a pressed toggle turns to the `c-on-inverse` plate with `c-inverse` ink, and its glyph is
 *   struck through, so "off" is a shape and a luminance change, not a hue;
 * - leave is `c-bad`, the dock's only red fill (the reference keeps it the page's only red
 *   control), 3.27 / 3.68 / 3.88 : 1 against the dock, its glyph 5.42 / 5.03 / 5.17 : 1.
 *   Hovering it adds an on-inverse edge, never a lighter fill.
 * The ring sits 2 px outside each control (`focus-offset`), so it never touches the control's
 * own fill.
 *
 * `layout="banner"`: the phone's full-width banner, with 52 px round controls.
 *
 * Icons only, in both layouts (owner decision, 2026-11-07): each control's label is its accessible name and
 * shows as a tooltip on hover and on focus, never as text under the glyph (three labels side by
 * side ran into each other in the sidebar's 264 px).
 *
 * With `meterRef`, a thin bar under the call's state draws the member's own
 * microphone level: the caller sets the fill's `scaleX` transform as the
 * level moves, frame by frame, without a render. It is decoration
 * (`aria-hidden`): the mute toggle already says whether the member is heard.
 * The fill is `c-ok-on-dark` on a `c-inverse-2` track, like the controls.
 */
export type AudioDockLayout = 'sidebar' | 'compact' | 'banner' | 'studio'

export type AudioDockStatus = 'connected' | 'connecting' | 'reconnecting'

export type SignalQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

const QUALITY_BARS: Record<SignalQuality, number> = {
  excellent: 3,
  good: 2,
  poor: 1,
  lost: 0,
  unknown: 3,
}

const QUALITY_INK: Record<SignalQuality, string> = {
  excellent: 'text-c-ok-on-dark',
  good: 'text-c-ok-on-dark',
  poor: 'text-c-warn',
  lost: 'text-c-bad-on-dark',
  unknown: 'text-c-ok-on-dark',
}

export function ConnectionQualityBars({
  quality = 'unknown',
  status = 'connected',
  label,
}: {
  quality?: SignalQuality | undefined
  status?: AudioDockStatus | undefined
  label?: string | undefined
}) {
  const waiting = status !== 'connected'
  const activeBars = waiting ? 1 : QUALITY_BARS[quality]
  const tone = waiting ? 'text-c-on-inverse-dim' : QUALITY_INK[quality]
  const svg = (
    <span
      data-connection-quality={waiting ? status : quality}
      {...(label !== undefined && hasLabel(label)
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true })}
      className={cx('inline-flex shrink-0 items-center justify-center', tone)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-3 w-3 shrink-0">
        <rect
          x="2"
          y="10"
          width="2.5"
          height="4"
          rx="0.75"
          fill="currentColor"
          className={activeBars >= 1 ? '' : 'opacity-30'}
        />
        <rect
          x="6.75"
          y="7"
          width="2.5"
          height="7"
          rx="0.75"
          fill="currentColor"
          className={activeBars >= 2 ? '' : 'opacity-30'}
        />
        <rect
          x="11.5"
          y="3.5"
          width="2.5"
          height="10.5"
          rx="0.75"
          fill="currentColor"
          className={activeBars >= 3 ? '' : 'opacity-30'}
        />
      </svg>
    </span>
  )
  return label !== undefined && hasLabel(label) ? (
    <Tooltip content={label} names>
      {svg}
    </Tooltip>
  ) : (
    svg
  )
}

/** A camera or screen toggle the call can honour: `on` is pressed, `busy` while it starts. */
export interface AudioDockMediaToggle {
  on: boolean
  busy: boolean
  /** Its accessible name and tooltip, saying what a press does (« Activer la caméra »). */
  label: string
  onToggle: () => void
}

export interface AudioDockProps {
  /** The region's accessible name, e.g. « Appel en cours ». */
  participants?: readonly {
    id: string
    name: string
    speaking: boolean
    roleLabel?: string
    avatarSrc?: string | undefined
    onAvatarError?: (() => void) | undefined
    quality?: SignalQuality
  }[]
  participantsLabel?: string
  localParticipantId?: string
  previewCamera?: boolean
  cameraUnavailable?: string
  label: string
  /** The room's name. */
  room: string
  /** The room's category, e.g. « Équipe ». */
  category?: string
  /** Where the call stands: drawn as the dot. */
  status: AudioDockStatus
  /** The same state in words, e.g. « Connecté · 12 min », « Reconnexion… ». */
  statusLabel: ReactNode
  /** LiveKit connection quality for the local participant. */
  quality?: SignalQuality
  qualityLabel?: string
  /** The viewer's microphone is off. */
  muted: boolean
  /** The viewer hears nothing (and, by the usual rule, is muted too). */
  deafened: boolean
  onToggleMute: () => void
  onToggleDeafen: () => void
  onLeave: () => void
  /** Back to the call's own view. Needs `labels.openCall`, its accessible name. */
  onOpenCall?: () => void
  /** Detaches the call into the draggable floating pill (`↗` icon only). */
  onDetach?: () => void
  /** Ref to the `↗` detach button so focus returns to it after re-docking. */
  detachButtonRef?: Ref<HTMLButtonElement>
  /** Toggles full-pane stage vs split stage in `studio` layout. */
  fullStage?: boolean
  onToggleFullStage?: () => void
  /** Hides audio-only participant cards when `VideoStage` is already rendered above the dock. */
  hideParticipants?: boolean
  /** Renders as a `<div>` inside an outer persistent `<section>` when `false` (`true` by default). */
  asSection?: boolean
  /**
   * Each control's short label: its accessible name and its tooltip.
   * `openCall` names the icon-only button `onOpenCall` draws.
   */
  labels: {
    mute: string
    deafen: string
    leave: string
    openCall?: string
    detach?: string
    fullStage?: string
  }
  layout?: AudioDockLayout
  /** The microphone meter's fill: its transform is the caller's to set (see above). */
  meterRef?: Ref<HTMLSpanElement>
  /**
   * The call's audio settings: a control the caller draws (a popover's trigger), set in the
   * dock's top row beside the call's name, before `onOpenCall`'s button.
   */
  settings?: ReactNode
  /**
   * The member's real camera and screen, before mute: toggles (`aria-pressed` while on), in place
   * of the preview camera or the « not available » one.
   */
  media?: { camera: AudioDockMediaToggle; screen?: AudioDockMediaToggle }
}

// Filled only when connected; a hollow ring while the call is not yet, or no
// longer, through. Connected is the tokens' success on a dark ground, the dark
// workspace reference's state colour (docs/specs/workspace-dark-roles.md).
const DOT: Record<AudioDockStatus, string> = {
  connected: 'bg-c-ok-on-dark',
  connecting: 'border border-c-on-inverse-dim',
  reconnecting: 'border border-c-on-inverse-dim',
}

// The state in words takes the dot's colour while connected, and the dim
// on-inverse ink while it waits.
const STATUS_INK: Record<AudioDockStatus, string> = {
  connected: 'text-c-ok-on-dark',
  connecting: 'text-c-on-inverse-dim',
  reconnecting: 'text-c-on-inverse-dim',
}

const DOCK: Record<AudioDockLayout, string> = {
  studio: 'flex flex-col gap-3 p-3',
  sidebar: 'm-2 flex flex-col gap-3 rounded-lg p-3',
  compact: 'flex h-[56px] min-h-[56px] w-full items-center justify-between gap-2 px-2 py-1',
  banner: 'flex w-full items-center gap-3 rounded-lg py-2 pr-2 pl-3',
}

const CONTROLS: Record<AudioDockLayout, string> = {
  studio: 'flex shrink-0 flex-wrap items-center justify-center gap-2',
  sidebar: 'grid grid-cols-3 gap-1',
  compact: 'flex shrink-0 items-center gap-1',
  banner: 'flex shrink-0 items-center gap-2',
}

// The sidebar's controls are 40 px tall, icon only, with the 44 px floor on a
// narrow screen (`TOUCH_TARGET`). Compact bottom-sidebar card controls are 28 px squares.
const CONTROL_SHAPE: Record<AudioDockLayout, string> = {
  studio: `h-10 w-10 rounded-md ${TOUCH_TARGET}`,
  sidebar: `h-10 rounded-md ${TOUCH_TARGET}`,
  compact: `h-[28px] w-[28px] rounded-md ${TOUCH_TARGET}`,
  banner: 'h-[52px] w-[52px] rounded-full',
}

const CONTROL_BASE =
  'focus-offset flex items-center justify-center border-2 border-transparent transition-colors duration-fast focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden'

// On the dock's `c-inverse` ground: controls on `c-inverse-2`, pressed ones
// reversed, and « Quitter » the dock's only red fill.
const TONE = {
  idle: 'bg-c-inverse-2 text-c-on-inverse hover:border-c-on-inverse-dim',
  pressed: 'bg-c-on-inverse text-c-inverse',
  leave: 'bg-c-bad text-c-on-inverse hover:border-c-on-inverse',
} as const

interface ControlProps {
  layout: AudioDockLayout
  label: string
  glyph: EspaceGlyphName
  tone: keyof typeof TONE
  pressed?: boolean | undefined
  busy?: boolean | undefined
  buttonRef?: Ref<HTMLButtonElement> | undefined
  onClick: () => void
}

function Control({
  layout,
  label,
  glyph,
  tone,
  pressed,
  busy,
  buttonRef,
  onClick,
}: ControlProps) {
  return (
    <Tooltip content={label} names>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        {...(busy === true ? { 'aria-busy': true } : {})}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        className={cx(CONTROL_BASE, CONTROL_SHAPE[layout], TONE[tone])}
      >
        <EspaceGlyph name={glyph} />
      </button>
    </Tooltip>
  )
}

export function AudioDock({
  label,
  room,
  category,
  status,
  statusLabel,
  quality,
  qualityLabel,
  muted,
  deafened,
  onToggleMute,
  onToggleDeafen,
  onLeave,
  onOpenCall,
  onDetach,
  detachButtonRef,
  fullStage,
  onToggleFullStage,
  hideParticipants = false,
  asSection = true,
  labels,
  layout = 'sidebar',
  meterRef,
  settings,
  participants,
  participantsLabel,
  cameraUnavailable,
  localParticipantId,
  previewCamera = false,
  media,
}: AudioDockProps) {
  const [cameraActive, setCameraActive] = useState(false)
  // Starts empty, then the caller scales it; never a `style` attribute (src/ui/cssom.ts).
  const meterFillRef = useMemo(
    () => initialCssProperty<HTMLSpanElement>('transform', 'scaleX(0)', meterRef),
    [meterRef]
  )
  const { i18n } = useTranslation()
  const copy = studioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  if (onOpenCall !== undefined && !hasLabel(labels.openCall)) {
    // An icon-only button with no name is a control nobody using a screen
    // reader can identify; refuse it rather than draw it.
    throw new Error('AudioDock onOpenCall needs labels.openCall, the button’s accessible name')
  }
  const isCompact = layout === 'compact'
  const Root = asSection ? 'section' : 'div'
  return (
    <Root
      {...(asSection ? { 'aria-label': label, 'data-dock-layout': layout } : {})}
      className={cx(
        asSection
          ? 'focus-ground-inverse inverse-edge bg-c-inverse text-c-on-inverse'
          : 'text-c-on-inverse',
        DOCK[layout]
      )}
    >
      <div
        className={cx(
          'flex min-w-0 items-center gap-2',
          isCompact ? 'flex-1' : 'flex-1',
          layout === 'studio' ? 'w-full' : ''
        )}
      >
        {isCompact ? (
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-1">
              <span
                aria-hidden="true"
                data-status={status}
                className={cx('h-2 w-2 shrink-0 rounded-full', DOT[status])}
              />
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={cx('truncate text-xs font-bold tabular-nums', STATUS_INK[status])}
              >
                {statusLabel}
              </p>
              <ConnectionQualityBars quality={quality} status={status} label={qualityLabel} />
            </div>
            {category === undefined ? null : <span className="sr-only">{category}</span>}
            {onOpenCall !== undefined && labels.openCall !== undefined ? (
              <Tooltip content={labels.openCall} names>
                <button
                  type="button"
                  aria-label={`${labels.openCall} (${room})`}
                  onClick={onOpenCall}
                  className="focus-offset max-w-full truncate rounded-sm text-left text-xs leading-snug font-semibold text-c-on-inverse hover:underline focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden"
                >
                  {room}
                </button>
              </Tooltip>
            ) : (
              <p className="truncate text-xs leading-snug font-semibold">{room}</p>
            )}
            {meterRef === undefined ? null : (
              <span
                aria-hidden="true"
                data-mic-meter=""
                className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-c-inverse-2"
              >
                <span
                  ref={meterFillRef}
                  className="block h-full w-full origin-left bg-c-ok-on-dark"
                />
              </span>
            )}
          </div>
        ) : (
          <>
            <span
              aria-hidden="true"
              data-status={status}
              className={cx('h-2 w-2 shrink-0 rounded-full', DOT[status])}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm leading-snug font-semibold">{room}</p>
                {quality !== undefined || layout === 'studio' ? (
                  <ConnectionQualityBars quality={quality} status={status} label={qualityLabel} />
                ) : null}
              </div>
              {category === undefined ? null : (
                <p className="truncate text-xs text-c-on-inverse-dim">{category}</p>
              )}
              {/* Wraps rather than truncates, as the reference's state does: at 14 px bold
                  « Connecté · écoute seule » is wider than the sidebar dock's text column. */}
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={cx('text-sm font-bold break-words tabular-nums', STATUS_INK[status])}
              >
                {statusLabel}
              </p>
              {meterRef === undefined ? null : (
                <span
                  aria-hidden="true"
                  data-mic-meter=""
                  className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-c-inverse-2"
                >
                  {/* Scaled, not sized: the caller moves it on every frame without moving layout. The
                      track's rounded clip keeps its ends round. */}
                  <span
                    ref={meterFillRef}
                    className="block h-full w-full origin-left bg-c-ok-on-dark"
                  />
                </span>
              )}
            </div>
            {settings === undefined ? null : <div className="ml-auto shrink-0">{settings}</div>}
            {layout === 'studio' &&
            onToggleFullStage !== undefined &&
            hasLabel(labels.fullStage) ? (
              <Tooltip content={labels.fullStage} names>
                <button
                  type="button"
                  aria-label={labels.fullStage}
                  aria-pressed={fullStage === true}
                  onClick={onToggleFullStage}
                  className={cx(
                    settings === undefined ? 'ml-auto' : '',
                    'focus-offset flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-c-inverse-2 text-c-on-inverse-dim hover:text-c-on-inverse focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
                    TOUCH_TARGET
                  )}
                >
                  <EspaceGlyph name={fullStage === true ? 'shrink' : 'expand'} />
                </button>
              </Tooltip>
            ) : null}
            {layout === 'studio' && onDetach !== undefined && hasLabel(labels.detach) ? (
              <Tooltip content={labels.detach} names>
                <button
                  ref={detachButtonRef}
                  type="button"
                  aria-label={labels.detach}
                  onClick={onDetach}
                  className={cx(
                    settings === undefined && onToggleFullStage === undefined ? 'ml-auto' : '',
                    'focus-offset flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-c-inverse-2 text-c-on-inverse-dim hover:text-c-on-inverse focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
                    TOUCH_TARGET
                  )}
                >
                  <EspaceGlyph name="detach" />
                </button>
              </Tooltip>
            ) : null}
            {onOpenCall === undefined || labels.openCall === undefined ? null : (
              <Tooltip content={labels.openCall} names>
                <button
                  type="button"
                  aria-label={labels.openCall}
                  onClick={onOpenCall}
                  className={cx(
                    // Pushed to the row's end, unless another header control already did.
                    settings === undefined &&
                      !(layout === 'studio' && onToggleFullStage !== undefined) &&
                      !(layout === 'studio' && onDetach !== undefined)
                      ? 'ml-auto'
                      : '',
                    'focus-offset flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-c-inverse-2 text-c-on-inverse-dim hover:text-c-on-inverse focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
                    TOUCH_TARGET
                  )}
                >
                  <EspaceGlyph name="open" />
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>
      {layout === 'studio' && !hideParticipants && participants && participants.length > 0 ? (
        <div
          role="region"
          aria-label={participantsLabel ?? copy.participants}
          tabIndex={0}
          className="max-h-shell-dock-width min-h-0 min-w-0 flex-1 overflow-y-auto rounded-md focus-visible:ring focus-visible:outline-hidden"
        >
          <ul aria-label={participantsLabel} className="grid grid-cols-4 gap-2 narrow:grid-cols-2">
            {participants.map((person) => (
              <li
                key={person.id}
                data-speaking={person.speaking || undefined}
                className={cx(
                  'flex min-w-0 flex-col items-center gap-2 rounded-lg border bg-c-inverse-2 p-3',
                  person.speaking
                    ? 'border-c-ok-on-dark ring-1 ring-c-ok-on-dark'
                    : 'border-c-on-inverse-dim'
                )}
              >
                {previewCamera && cameraActive && person.id === localParticipantId ? (
                  <div
                    data-testid="local-camera-preview"
                    className="flex w-full flex-col items-center gap-2 rounded-md bg-c-inverse p-3 text-c-on-inverse"
                  >
                    <StudioGlyph name="camera" />
                    <span className="text-center text-xs">{copy.cameraPreview}</span>
                  </div>
                ) : (
                  <Avatar
                    name={person.name}
                    identity={person.id}
                    size="lg"
                    {...(person.onAvatarError === undefined ? {} : { onError: person.onAvatarError })}
                    {...(person.avatarSrc === undefined ? {} : { src: person.avatarSrc })}
                  />
                )}
                <span className="rounded-full bg-c-inverse px-2 py-1 text-xs text-c-on-inverse-dim">
                  {person.id === localParticipantId
                    ? copy.you
                    : (person.roleLabel ?? copy.participant)}{' '}
                  · {person.speaking ? copy.speaking : copy.listening}
                </span>
                <span className="flex max-w-full items-center gap-2 text-xs font-bold">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'h-2 w-2 shrink-0 rounded-full',
                      person.speaking ? 'bg-c-ok-on-dark' : 'border border-c-on-inverse-dim'
                    )}
                  />
                  <span className="truncate">{person.name}</span>
                  {person.quality !== undefined ? (
                    <ConnectionQualityBars quality={person.quality} status={status} />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={CONTROLS[layout]}>
        {media !== undefined ? (
          <>
            {isCompact && media.screen?.on === true ? (
              <Control
                layout={layout}
                label={media.screen.label}
                glyph="screen"
                tone="pressed"
                pressed
                busy={media.screen.busy}
                onClick={media.screen.onToggle}
              />
            ) : (
              <Control
                layout={layout}
                label={media.camera.label}
                glyph={media.camera.on ? 'camera' : 'camera-off'}
                tone={media.camera.on ? 'pressed' : 'idle'}
                pressed={media.camera.on}
                busy={media.camera.busy}
                onClick={media.camera.onToggle}
              />
            )}
            {!isCompact && media.screen !== undefined ? (
              <Control
                layout={layout}
                label={media.screen.label}
                glyph="screen"
                tone={media.screen.on ? 'pressed' : 'idle'}
                pressed={media.screen.on}
                busy={media.screen.busy}
                onClick={media.screen.onToggle}
              />
            ) : null}
          </>
        ) : previewCamera && participants?.some((person) => person.id === localParticipantId) ? (
          <Tooltip content={copy.cameraHint}>
            <button
              type="button"
              aria-label={copy.camera}
              aria-pressed={cameraActive}
              onClick={() => setCameraActive(!cameraActive)}
              className={cx(
                CONTROL_BASE,
                CONTROL_SHAPE[layout],
                cameraActive ? TONE.pressed : TONE.idle
              )}
            >
              <StudioGlyph name="camera" />
            </button>
          </Tooltip>
        ) : !isCompact && cameraUnavailable ? (
          <Tooltip content={cameraUnavailable}>
            <button
              type="button"
              disabled
              aria-label={cameraUnavailable}
              className={cx(
                'flex items-center justify-center bg-c-inverse-2 text-c-on-inverse-dim focus-visible:ring',
                CONTROL_SHAPE[layout]
              )}
            >
              <StudioGlyph name="camera" />
            </button>
          </Tooltip>
        ) : null}
        <Control
          layout={layout}
          label={labels.mute}
          glyph={muted ? 'mic-off' : 'mic'}
          tone={muted ? 'pressed' : 'idle'}
          pressed={muted}
          onClick={onToggleMute}
        />
        <Control
          layout={layout}
          label={labels.deafen}
          glyph={deafened ? 'headphones-off' : 'headphones'}
          tone={deafened ? 'pressed' : 'idle'}
          pressed={deafened}
          onClick={onToggleDeafen}
        />
        {(isCompact || layout === 'banner') && onDetach !== undefined && hasLabel(labels.detach) ? (
          <Control
            layout={layout}
            label={labels.detach}
            glyph="detach"
            tone="idle"
            buttonRef={detachButtonRef}
            onClick={onDetach}
          />
        ) : null}
        <Control
          layout={layout}
          label={labels.leave}
          glyph="leave"
          tone="leave"
          onClick={onLeave}
        />
      </div>
    </Root>
  )
}
