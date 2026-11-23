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
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import {
  ConnectionQualityBars,
  type AudioDockCompanionChat,
  type AudioDockMediaToggle,
  type AudioDockStatus,
  type SignalQuality,
} from '../../../ui/AudioDock/AudioDock'
import { cssProperty, initialCssProperty } from '../../../ui/cssom'
import { cx } from '../../../ui/cx'
import { EspaceGlyph, type EspaceGlyphName } from '../../../ui/icons/EspaceGlyph'
import { StudioGlyph } from '../../../ui/icons/StudioGlyph'
import { hasLabel } from '../../../ui/stateLabel'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import { Tooltip } from '../../../ui/Tooltip/Tooltip'

export const PILL_MARGIN = 16
export const PILL_SNAP_THRESHOLD = 32
export const PILL_NUDGE_STEP = 32
const DEFAULT_PILL_WIDTH = 304
const DEFAULT_PILL_HEIGHT = 56
const DEFAULT_INITIAL_Y = 72

export const FLOATING_PILL_CLASS =
  'call-floating-pill focus-ground-inverse inverse-edge fixed z-40 flex w-[304px] max-w-[calc(100vw-32px)] cursor-grab flex-col gap-2 rounded-xl bg-c-inverse p-2 text-c-on-inverse shadow-pop shadow-c-shadow-2 active:cursor-grabbing'

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

function clearPillCssPosition(element: HTMLElement | null): void {
  cssProperty('--call-pill-x', undefined)(element)
  cssProperty('--call-pill-y', undefined)(element)
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

export interface CallDockRegionProps {
  label: string
  floating: boolean
  dockLayout?: string | undefined
  dockedClassName?: string | undefined
  onRedock: () => void
  children: ReactNode
}

/**
 * Persistent `<section>` landmark for an active call across `stage`, `sidebar`, and `floating`
 * placements so the region DOM node never unmounts and `--call-pill-x` / `--call-pill-y` are
 * applied strictly while `floating` is active.
 */
export function CallDockRegion({
  label,
  floating,
  dockLayout,
  dockedClassName,
  onRedock,
  children,
}: CallDockRegionProps) {
  const pillRef = useRef<HTMLElement | null>(null)
  const positionRef = useRef<PillPosition | null>(null)

  const currentPosition = (): PillPosition => {
    positionRef.current ??= initialPosition()
    return positionRef.current
  }

  const syncClampedPosition = useCallback((element: HTMLElement | null) => {
    if (element === null) return
    const current = positionRef.current ?? initialPosition()
    const { pillWidth, pillHeight, viewportWidth, viewportHeight } = measurePill(element)
    const clamped = clampPillPosition(
      current.x,
      current.y,
      pillWidth,
      pillHeight,
      viewportWidth,
      viewportHeight
    )
    positionRef.current = clamped
    applyPillCssPosition(element, clamped)
  }, [])

  const dragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    originX: number
    originY: number
  } | null>(null)

  const attachPillRef = useCallback(
    (element: HTMLElement | null) => {
      if (element === null && pillRef.current !== null) {
        clearPillCssPosition(pillRef.current)
      }
      pillRef.current = element
      if (element !== null) {
        if (floating) syncClampedPosition(element)
        else clearPillCssPosition(element)
      }
    },
    [floating, syncClampedPosition]
  )

  useEffect(() => {
    const element = pillRef.current
    if (element === null) return
    if (floating) {
      syncClampedPosition(element)
    } else {
      dragRef.current = null
      clearPillCssPosition(element)
    }
  }, [floating, syncClampedPosition])

  useEffect(() => {
    if (!floating) return
    const handleResize = () => {
      syncClampedPosition(pillRef.current)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [floating, syncClampedPosition])

  // The pill grows when its content does (a camera tile mounting, a screen share starting): a pill
  // parked against the bottom or right edge would then spill out of the viewport, so a size change
  // re-clamps it. Re-clamping only moves the pill, never resizes it, so the observer cannot loop.
  useEffect(() => {
    if (!floating || typeof ResizeObserver === 'undefined') return
    const element = pillRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => {
      if (dragRef.current !== null) return
      syncClampedPosition(pillRef.current)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [floating, syncClampedPosition])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!floating) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('button, a, input, select, [role="button"]') !== null) return
    const origin = currentPosition()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: origin.x,
      originY: origin.y,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!floating) return
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
    if (!floating) return
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
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!floating) return
    const target = event.target instanceof Element ? event.target : null
    const inOverlay = target?.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null
    if (
      event.key === 'Escape' &&
      !inOverlay &&
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
    const origin = currentPosition()
    let targetX = origin.x
    let targetY = origin.y
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
  }

  return (
    // Interactive region supports Alt+Arrow keyboard placement and pointer dragging when floating.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={attachPillRef}
      aria-label={label}
      data-testid={floating ? 'floating-call-pill' : undefined}
      data-dock-layout={floating ? 'floating' : dockLayout}
      tabIndex={floating ? -1 : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onKeyDown={onKeyDown}
      className={floating ? FLOATING_PILL_CLASS : dockedClassName}
    >
      {children}
    </section>
  )
}

function PillIconButton({
  label,
  glyph,
  tone,
  pressed,
  busy,
  buttonRef,
  onClick,
}: {
  label: string
  glyph: EspaceGlyphName
  tone: keyof typeof TONE
  pressed?: boolean | undefined
  busy?: boolean | undefined
  buttonRef?: Ref<HTMLButtonElement> | undefined
  onClick: () => void
}) {
  return (
    <Tooltip content={label} names>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        {...(busy === true ? { 'aria-busy': true } : {})}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        className={cx(
          'focus-offset flex h-[28px] min-h-[28px] w-[28px] min-w-[28px] shrink-0 items-center justify-center rounded-md border-2 border-transparent transition-colors duration-fast focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
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
  companionChat?: AudioDockCompanionChat
  companionChatButtonRef?: Ref<HTMLButtonElement>
  meterRef?: Ref<HTMLSpanElement>
  visualizer?: ReactNode
  activePollCount?: number
  activePollLabel?: string
  videoPreview?: ReactNode
  redockButtonRef?: Ref<HTMLButtonElement>
  /** Renders only the inner pill bar when `false` inside a persistent outer `<CallDockRegion>`. */
  asSection?: boolean
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
  companionChat,
  companionChatButtonRef,
  meterRef,
  visualizer,
  activePollCount = 0,
  activePollLabel,
  videoPreview,
  redockButtonRef,
  asSection = true,
  onToggleMute,
  onToggleDeafen,
  onOpenCall,
  onRedock,
  onLeave,
  labels,
}: FloatingCallPillProps) {
  const meterFillRef = useMemo(
    () => initialCssProperty<HTMLSpanElement>('transform', 'scaleX(0)', meterRef),
    [meterRef]
  )

  const body = (
    <>
      {videoPreview === undefined ? null : <div className="w-full">{videoPreview}</div>}
      <div className="flex min-h-10 w-full items-center justify-between gap-2">
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
              {activePollCount > 0 ? (
                <span
                  data-testid="floating-pill-poll-badge"
                  {...(activePollLabel !== undefined && hasLabel(activePollLabel)
                    ? { role: 'status', 'aria-label': activePollLabel }
                    : {})}
                  className="inline-flex shrink-0 items-center rounded-full bg-c-action px-2 text-xs font-bold text-c-on-inverse tabular-nums"
                >
                  {activePollCount}
                </span>
              ) : null}
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
            {visualizer !== undefined ? (
              <span aria-hidden="true" data-mic-meter="" className="mt-1 block w-full">
                {meterRef === undefined ? null : (
                  <span ref={meterFillRef} className="sr-only origin-left" />
                )}
                {visualizer}
              </span>
            ) : meterRef === undefined ? null : (
              <span
                aria-hidden="true"
                data-mic-meter=""
                className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-c-inverse-2"
              >
                <span
                  ref={meterFillRef}
                  className="block h-full w-full origin-left bg-c-action"
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
          {companionChat !== undefined && hasLabel(companionChat.label) ? (
            <Tooltip content={companionChat.label} names>
              <button
                ref={companionChatButtonRef}
                type="button"
                aria-label={companionChat.label}
                aria-expanded={companionChat.open}
                onClick={companionChat.onToggle}
                className={cx(
                  'focus-offset relative flex h-[28px] min-h-[28px] w-[28px] min-w-[28px] shrink-0 items-center justify-center rounded-md border-2 border-transparent transition-colors duration-fast focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden motion-reduce:transition-none',
                  TOUCH_TARGET,
                  companionChat.open ? TONE.pressed : TONE.idle
                )}
              >
                <StudioGlyph name="message" />
                {!companionChat.open && companionChat.unread > 0 ? (
                  <span
                    aria-hidden="true"
                    data-testid="companion-chat-unread"
                    className="pointer-events-none absolute -top-1 -right-1 min-w-5 rounded-full bg-c-action px-1 text-center text-xs font-bold text-c-on-inverse tabular-nums"
                  >
                    {companionChat.unread > 99 ? '99+' : companionChat.unread}
                  </span>
                ) : null}
              </button>
            </Tooltip>
          ) : null}
          <PillIconButton
            label={labels.redock}
            glyph="redock"
            tone="idle"
            buttonRef={redockButtonRef}
            onClick={onRedock}
          />
          <PillIconButton label={labels.leave} glyph="leave" tone="leave" onClick={onLeave} />
        </div>
      </div>
    </>
  )

  if (!asSection) {
    return body
  }

  return (
    <CallDockRegion label={label} floating onRedock={onRedock}>
      {body}
    </CallDockRegion>
  )
}
