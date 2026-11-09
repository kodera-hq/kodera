/**
 * A neutral head-and-shoulders mark: what an `Avatar` draws for someone with no name to take
 * initials from. Decoration only: the avatar around it carries the accessible name.
 */
export function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="5.5" r="3" />
      <path d="M2.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5z" />
    </svg>
  )
}
