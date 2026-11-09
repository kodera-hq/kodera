/**
 * The composer's glyphs (reference screen p02): « @ » for « Mentionner », a face for « Insérer un
 * émoji » and the paper plane of « Envoyer ». Decoration only: the button around each carries the
 * accessible name.
 */
export function MentionIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.6" strokeWidth="1.5" />
      <path
        d="M10.6 8v1.1a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11.9 13"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function EmojiIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" strokeWidth="1.5" />
      <path d="M5.4 9.6a3 3 0 0 0 5.2 0" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 6.2v.4M10 6.2v.4" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function SendIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        d="M14 2 7.2 8.8M14 2l-4.3 12-2.5-5.2L2 6.3 14 2Z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
