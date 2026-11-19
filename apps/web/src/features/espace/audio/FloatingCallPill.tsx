// Detached draggable floating call pill (`docs/specs/espace-video-and-screenshare.md`).
//
// Positioned exclusively via CSSOM custom properties (`--call-pill-x`, `--call-pill-y`) through
// `cssProperty()` (`src/ui/cssom.ts`), consumed by `.call-floating-pill` in `src/index.css`, so
// `style-src-attr 'none'` is never violated. Uses `bg-c-inverse` without `.material-*` blur so the
// workspace stays strictly within the three-surface glass budget.
//
// Icon-first minimalism: every control button (`Micro`, `Casque`, `Caméra`, `↙` re-dock, `Quitter`)
// renders a pure SVG glyph with `aria-label` and a `names` tooltip — zero visible button text.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import {
  ConnectionQualityBars,
  type AudioDockMediaToggle,
  type AudioDockStatus,
  type SignalQuality,
} from '../../../ui/AudioDock/AudioDock'
import { cssProperty, initialCssProperty } from '../../../ui/cssom'
import { cx } from '../../../ui/cx'
import { EspaceGlyph, type EspaceGlyphName } from '../../../ui/icons/EspaceGlyph'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import { Tooltip } from '../../../ui/Tooltip/Tooltip'

export const PILL_MARGIN = 16
export const PILL_SNAP_THRESHOLD = 32
export const PILL_NUDGE_STEP = 32
const DEFAULT_PILL_WIDTH = 304
const DEFAULT_PILL_HEIGHT = 56
const DEFAULT_INITIAL_Y = 72

export interface PillPosition {
  readonly x: number
  readonly y: number
}

const DOT: Record<AudioDockStatus, string> = {
  connected: 'bg-c-ok-on-dark',
  connecting: 'border border-c-on-inverse-dim',
  reconnecting: 'border border-c-on-inverse-dim',
}

const STATUS_INK: Record<AudioDockStatus, string> = {
  connected: 'text-c-ok-on-dark',
  connecting: 'text-c-on-inverse-dim',
  reconnecting: 'text-c-on-inverse-dim',
}

const TONE = {
  idle: 'bg-c-inverse-2 text-c-on-inverse hover:border-c-on-inverse-dim',
  pressed: 'bg-c-on-inverse text-c-inverse',
  leave: 'bg-c-bad text-c-on-inverse hover:border-c-on-inverse',
} as const

export function clampPillPosition(
  x: number,
  y: number,
  pillWidth: number,
  pillHeight: number,
  viewportWidth: number,
  viewportHeight: number
): PillPosition {
  const maxX = Math.max(PILL_MARGIN, viewportWidth - pillWidth - PILL_MARGIN)
  const maxY = Math.max(PILL_MARGIN, viewportHeight - pillHeight - PILL_MARGIN)
  return {
    x: Math.min(Math.max(PILL_MARGIN, Math.round(x)), Math.round(maxX)),
    y: Math.min(Math.max(PILL_MARGIN, Math.round(y)), Math.round(maxY)),
  }
}

export function snapPillPosition(
  x: number,
  y: number,
  pillWidth: number,
  pillHeight: number,
  viewportWidth: number,
  viewportHeight: number
): PillPosition {
  const clamped = clampPillPosition(x, y, pillWidth, pillHeight, viewportWidth, viewportHeight)
  const maxX = Math.max(PILL_MARGIN, Math.round(viewportWidth - pillWidth - PILL_MARGIN))
  const maxY = Math.max(PILL_MARGIN, Math.round(viewportHeight - pillHeight - PILL_MARGIN))
  const snappedX =
    clamped.x - PILL_MARGIN <= PILL_SNAP_THRESHOLD
      ? PILL_MARGIN
      : maxX - clamped.x <= PILL_SNAP_THRESHOLD
        ? maxX
        : clamped.x
  const snappedY =
    clamped.y - PILL_MARGIN <= PILL_SNAP_THRESHOLD
      ? PILL_MARGIN
      : maxY - clamped.y <= PILL_SNAP_THRESHOLD
        ? maxY
        : clamped.y
  return { x: snappedX, y: snappedY }
}

function measurePill(element: HTMLElement | null): {
  pillWidth: number
  pillHeight: number
  viewportWidth: number
  viewportHeight: number
} {
  const rect = element?.getBoundingClientRect()
  const pillWidth = rect && rect.width > 0 ? rect.width : DEFAULT_PILL_WIDTH
  const pillHeight = rect && rect.height > 0 ? rect.height : DEFAULT_PILL_HEIGHT
  const viewportWidth =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280
  const viewportHeight =
    typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800
  return { pillWidth, pillHeight, viewportWidth, viewportHeight }
}

function applyPillCssPosition(element: HTMLElement | null, position: PillPosition): void {
  cssProperty('--call-pill-x', `${position.x}px`)(element)
  cssProperty('--call-pill-y', `${position.y}px`)(element)
}

function initialPosition(): PillPosition {
  const viewportWidth =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280
  const viewportHeight =
    typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800
  return clampPillPosition(
    viewportWidth - DEFAULT_PILL_WIDTH - PILL_MARGIN,
    DEFAULT_INITIAL_Y,
    DEFAULT_PILL_WIDTH,
    DEFAULT_PILL_HEIGHT,
    viewportWidth,
    viewportHeight
  )
}

function PillIconButton({
  label,
  glyph,
  tone,
  pressed,
  busy,
  onClick,
}: {
  label: string
  glyph: EspaceGlyphName
  tone: keyof typeof TONE
  pressed?: boolean
  busy?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip content={label} names>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        {...(busy === true ? { 'aria-busy': true } : {})}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        className={cx(
          'focus-offset flex h-[28px] w-[28px] items-center justify-center rounded-md border-2 border-transparent transition-colors duration-fast focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
          TOUCH_TARGET,
          TONE[tone]
        )}
      >
        <EspaceGlyph name={glyph} />
      </button>
    </Tooltip>
  )
}

export interface FloatingCallPillProps {
  label: string
  room: string
  category?: string
  status: AudioDockStatus
  statusLabel: ReactNode
  quality?: SignalQuality
  qualityLabel?: string
  muted: boolean
  deafened: boolean
  media?: { camera: AudioDockMediaToggle; screen?: AudioDockMediaToggle }
  meterRef?: Ref<HTMLSpanElement>
  videoPreview?: ReactNode
  onToggleMute: () => void
  onToggleDeafen: () => void
  onOpenCall: () => void
  onRedock: () => void
  onLeave: () => void
  labels: {
    mute: string
    deafen: string
    leave: string
    openCall: string
    redock: string
  }
}

export function FloatingCallPill({
  label,
  room,
  category,
  status,
  statusLabel,
  quality,
  qualityLabel,
  muted,
  deafened,
  media,
  meterRef,
  videoPreview,
  onToggleMute,
  onToggleDeafen,
  onOpenCall,
  onRedock,
  onLeave,
  labels,
}: FloatingCallPillProps) {
  const pillRef = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<PillPosition>(initialPosition)
  const positionRef = useRef<PillPosition>(position)
  useEffect(() => {
    positionRef.current = position
  }, [position])

  const dragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    originX: number
    originY: number
  } | null>(null)

  const meterFillRef = useMemo(
    () => initialCssProperty<HTMLSpanElement>('transform', 'scaleX(0)', meterRef),
    [meterRef]
  )

  const attachPillRef = useCallback(
    (element: HTMLElement | null) => {
      pillRef.current = element
      if (element !== null) {
        applyPillCssPosition(element, position)
      }
    },
    [position]
  )

  useEffect(() => {
    const handleResize = () => {
      const { pillWidth, pillHeight, viewportWidth, viewportHeight } = measurePill(pillRef.current)
      const clamped = clampPillPosition(
        positionRef.current.x,
        positionRef.current.y,
        pillWidth,
        pillHeight,
        viewportWidth,
        viewportHeight
      )
      positionRef.current = clamped
      applyPillCssPosition(pillRef.current, clamped)
      setPosition(clamped)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('button, a, input, select, [role="button"]') !== null) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: positionRef.current.x,
      originY: positionRef.current.y,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const { pillWidth, pillHeight, viewportWidth, viewportHeight } = measurePill(pillRef.current)
    const next = clampPillPosition(
      drag.originX + (event.clientX - drag.startClientX),
      drag.originY + (event.clientY - drag.startClientY),
      pillWidth,
      pillHeight,
      viewportWidth,
      viewportHeight
    )
    positionRef.current = next
    applyPillCssPosition(pillRef.current, next)
  }

  const finishPointerDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // Synthetic pointer events in tests may not hold an active pointer capture.
    }
    const { pillWidth, pillHeight, viewportWidth, viewportHeight } = measurePill(pillRef.current)
    const snapped = snapPillPosition(
      drag.originX + (event.clientX - drag.startClientX),
      drag.originY + (event.clientY - drag.startClientY),
      pillWidth,
      pillHeight,
      viewportWidth,
      viewportHeight
    )
    positionRef.current = snapped
    applyPillCssPosition(pillRef.current, snapped)
    setPosition(snapped)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      event.preventDefault()
      onRedock()
      return
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    const { pillWidth, pillHeight, viewportWidth, viewportHeight } = measurePill(pillRef.current)
    const maxX = Math.max(PILL_MARGIN, viewportWidth - pillWidth - PILL_MARGIN)
    const maxY = Math.max(PILL_MARGIN, viewportHeight - pillHeight - PILL_MARGIN)
    let targetX = positionRef.current.x
    let targetY = positionRef.current.y
    switch (event.key) {
      case 'ArrowLeft':
        targetX = event.shiftKey ? PILL_MARGIN : targetX - PILL_NUDGE_STEP
        break
      case 'ArrowRight':
        targetX = event.shiftKey ? maxX : targetX + PILL_NUDGE_STEP
        break
      case 'ArrowUp':
        targetY = event.shiftKey ? PILL_MARGIN : targetY - PILL_NUDGE_STEP
        break
      case 'ArrowDown':
        targetY = event.shiftKey ? maxY : targetY + PILL_NUDGE_STEP
        break
      default:
        return
    }
    event.preventDefault()
    const next = clampPillPosition(
      targetX,
      targetY,
      pillWidth,
      pillHeight,
      viewportWidth,
      viewportHeight
    )
    positionRef.current = next
    applyPillCssPosition(pillRef.current, next)
    setPosition(next)
  }

  return (
    // Interactive region supports Alt+Arrow keyboard placement and pointer dragging on its frame.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={attachPillRef}
      aria-label={label}
      data-testid="floating-call-pill"
      data-dock-layout="floating"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onKeyDown={onKeyDown}
      className="call-floating-pill focus-ground-inverse inverse-edge fixed z-40 flex w-[304px] max-w-[calc(100vw-32px)] cursor-grab flex-col gap-2 rounded-xl bg-c-inverse p-2 text-c-on-inverse shadow-pop shadow-c-shadow-2 active:cursor-grabbing"
    >
      {videoPreview === undefined ? null : <div className="w-full">{videoPreview}</div>}
      <div className="flex min-h-10 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <EspaceGlyph name="grip" className="h-4 w-4 shrink-0 text-c-on-inverse-dim" />
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
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {media === undefined ? null : media.screen?.on === true ? (
            <PillIconButton
              label={media.screen.label}
              glyph="screen"
              tone="pressed"
              pressed
              busy={media.screen.busy}
              onClick={media.screen.onToggle}
            />
          ) : (
            <PillIconButton
              label={media.camera.label}
              glyph={media.camera.on ? 'camera' : 'camera-off'}
              tone={media.camera.on ? 'pressed' : 'idle'}
              pressed={media.camera.on}
              busy={media.camera.busy}
              onClick={media.camera.onToggle}
            />
          )}
          <PillIconButton
            label={labels.mute}
            glyph={muted ? 'mic-off' : 'mic'}
            tone={muted ? 'pressed' : 'idle'}
            pressed={muted}
            onClick={onToggleMute}
          />
          <PillIconButton
            label={labels.deafen}
            glyph={deafened ? 'headphones-off' : 'headphones'}
            tone={deafened ? 'pressed' : 'idle'}
            pressed={deafened}
            onClick={onToggleDeafen}
          />
          <PillIconButton label={labels.redock} glyph="redock" tone="idle" onClick={onRedock} />
          <PillIconButton label={labels.leave} glyph="leave" tone="leave" onClick={onLeave} />
        </div>
      </div>
    </section>
  )
}
