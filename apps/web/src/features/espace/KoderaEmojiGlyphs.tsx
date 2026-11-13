// The glyphs of Kodera's own emoji, loaded the first time one is drawn (`KoderaEmoji.tsx`). Each
// is drawn in `currentColor`, so it takes the colour of the text around it in every theme; the
// second tone is the same colour, lighter. No colour is written here.

import type { ReactElement } from 'react'
import type { KoderaEmojiName } from './koderaShortcodes'

const frame = (children: ReactElement | ReactElement[]) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

export const GLYPHS: Record<KoderaEmojiName, () => ReactElement> = {
  kodera_mark: () =>
    frame([
      <rect key="b" x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity="0.2" />,
      <path
        key="k"
        d="M8 6v12M8 12l7-6M8 12l7 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />,
    ]),
  kodera_heart: () =>
    frame(
      <path
        d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"
        fill="currentColor"
      />
    ),
  kodera_check: () =>
    frame([
      <circle key="c" cx="12" cy="12" r="10" fill="currentColor" opacity="0.2" />,
      <path
        key="v"
        d="m7 12.5 3.2 3.2L17 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />,
    ]),
  kodera_spark: () =>
    frame(
      <path
        d="M12 2c.6 4.8 2.2 6.4 7 7-4.8.6-6.4 2.2-7 7-.6-4.8-2.2-6.4-7-7 4.8-.6 6.4-2.2 7-7zM19 15c.3 2 .9 2.7 3 3-2.1.3-2.7.9-3 3-.3-2.1-.9-2.7-3-3 2.1-.3 2.7-1 3-3z"
        fill="currentColor"
      />
    ),
  kodera_coop: () =>
    frame([
      <circle key="a" cx="8" cy="9" r="4" fill="currentColor" opacity="0.5" />,
      <circle key="b" cx="16" cy="9" r="4" fill="currentColor" opacity="0.5" />,
      <circle key="c" cx="12" cy="16" r="4" fill="currentColor" />,
    ]),
  kodera_sky: () =>
    frame(
      <path
        d="M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.5 4.75 4.75 0 0 1 17 18z"
        fill="currentColor"
        opacity="0.85"
      />
    ),
  kodera_sun: () =>
    frame([
      <circle key="c" cx="12" cy="12" r="4.5" fill="currentColor" />,
      <path
        key="r"
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />,
    ]),
  kodera_wave: () =>
    frame(
      <path
        d="M2 14c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3M2 19c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    ),
}

export default function KoderaEmojiGlyph({ name }: { name: KoderaEmojiName }) {
  const Glyph = GLYPHS[name]
  return <Glyph />
}
