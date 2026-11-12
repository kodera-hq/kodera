/** The proximity room's mark, in the sidebar and beside its name in the channel's header. */
export function AntennaIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6" />
      <path d="M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3 3a7 7 0 0 0 0 10" />
      <path d="M13 3a7 7 0 0 1 0 10" />
    </svg>
  )
}
