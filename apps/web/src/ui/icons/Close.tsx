/**
 * The "×" glyph shared by every dismiss control (`Banner`, `Dialog`,
 * `Drawer`, `Toast`) — decoration only, the button around it carries the
 * accessible name. Kept as its own file so the four primitives draw the same
 * mark rather than four copies that could drift apart one edit at a time.
 */
export function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
