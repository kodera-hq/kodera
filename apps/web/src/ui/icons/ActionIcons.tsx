import type { ReactNode } from 'react'

/**
 * The icon-first toolbars' glyphs (owner directive: icons only on composer, formatting and action
 * toolbars). Original stroke geometry on a 16 px grid, drawn at 16 px inside a 32 px button. Each is
 * decoration: the button around it carries the accessible name, shown as its tooltip.
 */
export type ActionIconName =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'link'
  | 'code'
  | 'code-block'
  | 'bullet-list'
  | 'quote'
  | 'plus'
  | 'slash'
  | 'retry'
  | 'more'
  | 'thread'
  | 'reaction'
  | 'direct'
  | 'copy'
  | 'bell'
  | 'bell-off'
  | 'person-plus'
  | 'shield'
  | 'wave'
  | 'sparkle'
  | 'upload'

const PATHS: Record<ActionIconName, ReactNode> = {
  bold: <path d="M4.5 2.5h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z" />,
  italic: <path d="M6.5 2.5h6M3.5 13.5h6M9.75 2.5l-3.5 11" />,
  strike: (
    <>
      <path d="M2.5 8h11" />
      <path d="M11.5 4.25C11 3.2 9.8 2.5 8 2.5 5.9 2.5 4.75 3.6 4.75 5c0 .9.45 1.55 1.25 2" />
      <path d="M10.6 9.5c.55.4.9 1 .9 1.75 0 1.4-1.4 2.25-3.5 2.25-1.9 0-3.1-.75-3.6-1.9" />
    </>
  ),
  link: (
    <>
      <path d="M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.74" />
      <path d="M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.74-.74" />
    </>
  ),
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />,
  'code-block': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 6.5 4.5 8 6 9.5M10 6.5 11.5 8 10 9.5" />
    </>
  ),
  'bullet-list': <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.75 4h.01M2.75 8h.01M2.75 12h.01" />,
  quote: <path d="M3 3v10M6.5 5h6.5M6.5 8h6.5M6.5 11h4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  slash: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M9.75 4.75 6.25 11.25" />
    </>
  ),
  retry: (
    <>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
      <path d="M13.25 2.5v3.25H10" />
    </>
  ),
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.25" />,
  thread: (
    <>
      <path d="M2.5 3.5h11v6.5H8l-3 2.5V10H2.5z" />
      <path d="M5.25 6.75h5.5" />
    </>
  ),
  reaction: (
    <>
      <circle cx="7.5" cy="8.5" r="5.25" />
      <path d="M5.25 10a2.6 2.6 0 0 0 4.5 0M5.75 7v.01M9.25 7v.01M12.5 1.5v3M11 3h3" />
    </>
  ),
  direct: (
    <>
      <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 11.5 4v3.5A1.5 1.5 0 0 1 10 9H6.5L4 11V9a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M11.5 6h.5A1.5 1.5 0 0 1 13.5 7.5V11a1.5 1.5 0 0 1-1.5 1.5V14l-2.5-1.5H8" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
    </>
  ),
  bell: (
    <>
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" />
      <path d="M6.75 14a1.4 1.4 0 0 0 2.5 0" />
    </>
  ),
  'bell-off': (
    <>
      <path d="M4 11.5V7a4 4 0 0 1 6.6-3.05M12 7v4.5l1 1H6" />
      <path d="M6.75 14a1.4 1.4 0 0 0 2.5 0M2.5 2.5l11 11" />
    </>
  ),
  'person-plus': (
    <>
      <circle cx="6.5" cy="5" r="2.5" />
      <path d="M2 13.5a4.5 4.5 0 0 1 9 0M12.5 5v4M10.5 7h4" />
    </>
  ),
  shield: (
    <>
      <path d="M8 1.75 13 3.5V7.5c0 3-2.1 5.4-5 6.75C5.1 12.9 3 10.5 3 7.5V3.5z" />
      <path d="M5.75 8 7.25 9.5 10.25 6.5" />
    </>
  ),
  wave: (
    <>
      <path d="M5.5 8.5 3.75 6.75a1.06 1.06 0 0 1 1.5-1.5l3 3M6.75 5.75 5 4a1.06 1.06 0 0 1 1.5-1.5L9.75 5.75M8.5 4 8 3.5A1.06 1.06 0 0 1 9.5 2L12 4.5c1.9 1.9 1.9 5.1 0 7l-.5.5c-1.9 1.9-5 1.9-6.9 0L2.5 9.9a1.06 1.06 0 0 1 1.5-1.5L5.5 9.9" />
      <path d="M12.75 1.5c.9.4 1.5 1 1.75 1.75M1.5 12.25c.25.75.85 1.4 1.75 1.75" />
    </>
  ),
  sparkle: <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2" />,
  upload: (
    <>
      <path d="M8 10.5V2.5M5 5.5l3-3 3 3" />
      <path d="M2.5 10v2A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </>
  ),
}

export function ActionIcon({ name, className }: { name: ActionIconName; className?: string }) {
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
      data-icon={name}
      className={className ?? 'h-4 w-4 shrink-0'}
    >
      {PATHS[name]}
    </svg>
  )
}
