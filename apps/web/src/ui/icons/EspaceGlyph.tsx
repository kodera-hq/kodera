import type { ReactNode } from 'react'

/**
 * The glyphs Espace's sidebar, call dock and timeline draw: decoration only.
 * The control or the text around each one carries the meaning in words, so
 * every glyph is `aria-hidden`. Stroke in `currentColor`, so the token class on
 * the parent decides the ink.
 */
export type EspaceGlyphName =
  | 'chevron'
  | 'speaker'
  | 'lock'
  | 'screen'
  | 'mic'
  | 'mic-off'
  | 'headphones'
  | 'headphones-off'
  | 'leave'
  | 'reply'
  | 'open'
  | 'settings'
  | 'camera'
  | 'camera-off'
  | 'spotlight'
  | 'picture-in-picture'
  | 'expand'
  | 'shrink'

const PATHS: Record<EspaceGlyphName, ReactNode> = {
  // Two sliders: the call's audio settings.
  settings: (
    <>
      <path d="M2.5 5h4M10.5 5h3M2.5 11h2M8.5 11h5" />
      <circle cx="8.5" cy="5" r="1.75" />
      <circle cx="6.5" cy="11" r="1.75" />
    </>
  ),
  // A chevron pointing right; the category rotates it a quarter turn when open.
  chevron: <path d="M6 4l4 4-4 4" />,
  // A loudspeaker with one wave: an audio room.
  speaker: (
    <>
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  // A padlock: a channel where the member reads and cannot post.
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  // A monitor: someone shares a screen.
  screen: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 14h4M8 11v3" />
    </>
  ),
  mic: (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
    </>
  ),
  // The microphone struck through: the shape, not a colour, says it is off.
  'mic-off': (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14M2.5 2.5l11 11" />
    </>
  ),
  headphones: (
    <>
      <path d="M2.5 11V8a5.5 5.5 0 0 1 11 0v3" />
      <rect x="2" y="9.5" width="3" height="4" rx="1" />
      <rect x="11" y="9.5" width="3" height="4" rx="1" />
    </>
  ),
  'headphones-off': (
    <>
      <path d="M2.5 11V8a5.5 5.5 0 0 1 11 0v3" />
      <rect x="2" y="9.5" width="3" height="4" rx="1" />
      <rect x="11" y="9.5" width="3" height="4" rx="1" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  // A handset laid down: leave the call.
  leave: <path d="M2 9.5c3.5-3 8.5-3 12 0l-1.5 2-2.5-1v-1.5a6 6 0 0 0-4 0V10.5l-2.5 1z" />,
  // A hooked arrow: the message answers an earlier one.
  reply: <path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 3.5 3.5v1" />,
  // A video camera: the member's camera is on.
  camera: (
    <>
      <rect x="1.5" y="4.5" width="9" height="7" rx="1.5" />
      <path d="M10.5 7l4-2v6l-4-2" />
    </>
  ),
  // The camera struck through: the shape, not a colour, says it is off.
  'camera-off': (
    <>
      <rect x="1.5" y="4.5" width="9" height="7" rx="1.5" />
      <path d="M10.5 7l4-2v6l-4-2M2.5 2.5l11 11" />
    </>
  ),
  // A pin: this feed takes the stage.
  spotlight: <path d="M6 2.5h4M7 2.5v4l-2.5 2.5h7L9 6.5v-4M8 9v4.5" />,
  // A small frame inside a large one: the video in its own floating window.
  'picture-in-picture': (
    <>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <rect x="8" y="8" width="5" height="3.5" rx="0.5" />
    </>
  ),
  // Corners pulled outwards: make the video larger.
  expand: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  // Corners pulled inwards: shrink the video to a thumbnail.
  shrink: <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />,
  // An arrow leaving a frame: back to the call's own view.
  open: (
    <>
      <path d="M9 3h4v4M13 3L7.5 8.5" />
      <path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
    </>
  ),
}

export interface EspaceGlyphProps {
  name: EspaceGlyphName
  /** Size and placement only (`h-4 w-4`, `rotate-90`); the ink is the parent's. */
  className?: string
}

export function EspaceGlyph({ name, className }: EspaceGlyphProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-glyph={name}
      className={className ?? 'h-4 w-4 shrink-0'}
    >
      {PATHS[name]}
    </svg>
  )
}
