import type { ReactNode } from 'react'
import type { ModuleGlyphName } from '@/app/railModules'

/**
 * Shared module glyphs for the rail and application cards. The surrounding
 * control or heading supplies the accessible name; token classes supply ink.
 */
const PATHS: Record<ModuleGlyphName, ReactNode> = {
  // A camera body with the lens wedge pointing right.
  visio: (
    <>
      <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
      <path d="M15.5 10.5L21 7.5v9l-5.5-3z" />
    </>
  ),
  // A page with a folded corner and two ruled lines.
  docs: (
    <>
      <path d="M6 3.5h7l5 5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20.5v-15A1.5 1.5 0 0 1 6.5 4z" />
      <path d="M13 3.5v5h5" />
      <path d="M8.5 13.5h7M8.5 17h5" />
    </>
  ),
  // A drive: a cloud over a baseline.
  drive: (
    <>
      <path d="M7.5 16.5a3.5 3.5 0 0 1 0-7 5 5 0 0 1 9.6 1.2 3 3 0 0 1-.6 5.8z" />
      <path d="M5 20h14" />
    </>
  ),
  // A conversation: a speech bubble with a tail.
  messaging: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" />
    </>
  ),
  // A table: an outer frame with one row and one column rule.
  grist: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M10 9.5v10" />
    </>
  ),
  // The console itself: two sliders, the settings surface of the product.
  console: (
    <>
      <path d="M5 8h14M5 16h14" />
      <circle cx="10" cy="8" r="2.2" />
      <circle cx="15" cy="16" r="2.2" />
    </>
  ),
  // The workspace: a channel's hash, where the organisation's conversations live.
  workspace: (
    <>
      <path d="M10 4.5 8 19.5M16 4.5l-2 15M5 9h14.5M4.5 15H19" />
    </>
  ),
  // A code the contract this build was generated from does not name: a plain
  // tile, deliberately not any other application's mark.
  unknown: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" />
    </>
  ),
}

export interface ModuleGlyphProps {
  name: ModuleGlyphName
  /** `'tab'` draws it at the phone tab bar's size and stroke, beside `TabGlyph`'s. */
  size?: 'rail' | 'tab'
}

export function ModuleGlyph({ name, size = 'rail' }: ModuleGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size === 'tab' ? 17 : 22}
      height={size === 'tab' ? 17 : 22}
      fill="none"
      stroke="currentColor"
      strokeWidth={size === 'tab' ? 1.8 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-glyph={name}
    >
      {PATHS[name]}
    </svg>
  )
}
