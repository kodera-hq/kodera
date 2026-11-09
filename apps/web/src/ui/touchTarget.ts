/**
 * The narrow layout's touch-target floor: 44 × 44 px wherever the phone layout
 * applies (the delivered mock, README §3 "Cibles tactiles : 44 px minimum"),
 * nothing elsewhere. `narrow:` is the variant `tailwind.config.ts` builds from
 * `src/app/layoutQuery.ts`, the query the shell's own frame choice reads — so a
 * phone held sideways gets the floor too. A variant rather than a base class
 * moved behind `md:`, so a control's wide-layout classes are exactly what they
 * were and the desktop baselines cannot move. A minimum, not a height: a 48 px
 * control stays 48.
 */
export const TOUCH_TARGET = 'narrow:min-h-[44px] narrow:min-w-[44px]'

/** The same floor for a field or a row, whose width is its container's. */
export const TOUCH_TARGET_HEIGHT = 'narrow:min-h-[44px]'
