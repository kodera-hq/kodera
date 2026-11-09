/**
 * Ordinary links and actions use theme ink; selected, status and focus roles
 * keep their own semantics. Inline links remain underlined at rest. A
 * standalone action underlines on hover and keyboard focus, with the same
 * canonical focus ring as Button/LinkButton even when used by a native button.
 */
export const LINK_TEXT = {
  standalone:
    'text-c-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:ring focus-visible:outline-hidden',
  inline: 'text-c-ink underline underline-offset-2',
} as const
