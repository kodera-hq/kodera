// Decoration-only glyphs for the administration's compact controls. The button around each one
// carries the accessible name (and, through `Button iconOnly`, the tooltip).

import type { ReactNode } from 'react'

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const BackIcon = () => (
  <Glyph>
    <path d="M10 3L5 8l5 5" />
  </Glyph>
)
export const PlusIcon = () => (
  <Glyph>
    <path d="M8 3v10M3 8h10" />
  </Glyph>
)
export const TrashIcon = () => (
  <Glyph>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
  </Glyph>
)
export const UpIcon = () => (
  <Glyph>
    <path d="M4 10l4-4 4 4" />
  </Glyph>
)
export const DownIcon = () => (
  <Glyph>
    <path d="M4 6l4 4 4-4" />
  </Glyph>
)
export const EditIcon = () => (
  <Glyph>
    <path d="M10.5 3.5l2 2L6 12H4v-2z" />
  </Glyph>
)
export const PersonIcon = () => (
  <Glyph>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13c.8-2.3 2.7-3.5 5-3.5s4.2 1.2 5 3.5" />
  </Glyph>
)
export const MoreIcon = () => (
  <Glyph>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.4" />
  </Glyph>
)
export const UnbanIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5" />
    <path d="M5.5 8.2l1.7 1.7 3.3-3.4" />
  </Glyph>
)
export const RevokeIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5" />
    <path d="M4.5 11.5l7-7" />
  </Glyph>
)
export const SearchIcon = () => (
  <Glyph>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3 3" />
  </Glyph>
)
