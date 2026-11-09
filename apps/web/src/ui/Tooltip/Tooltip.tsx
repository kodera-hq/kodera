import * as RadixTooltip from '@radix-ui/react-tooltip'
import { forwardRef } from 'react'
import type { ReactElement } from 'react'
import { cx } from '../cx'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

// How long the pointer rests on an icon-only control before its name shows. Shorter than Radix's
// 700 ms default: for an icon with no visible label the name is what the pointer is looking for.
const NAME_DELAY_MS = 300

export interface TooltipProps {
  /** A single element — usually an icon-only `Button` — wrapped with
   * `asChild`, never replaced. */
  children: ReactElement
  /** The instruction. `DESIGN_SYSTEM.md`/`ui-common.md`: a tooltip is never
   * the only carrier of one — the trigger keeps its own accessible name, and
   * this adds detail rather than supplying the name from scratch. */
  content: string
  side?: TooltipSide
  /** See `Dialog`'s doc comment — same reason, same story-only use. */
  container?: HTMLElement | null
  /**
   * The content restates the trigger's accessible name: the tooltip of an icon-only control
   * (owner decision, 2026-11-07: icons only, the name on hover and focus). The trigger keeps its own
   * `aria-label`; the tooltip is drawn for the eye only (`aria-hidden`) and is not added as the
   * trigger's description, so a screen reader reads the name once, not twice. It shows sooner.
   */
  names?: boolean
  /** The gap between the trigger and the tooltip, in px (6 by default). The rail passes enough to
   * clear its own ground, so the tooltip sits on the sidebar, not on the rail's dark column. */
  sideOffset?: number
}

/**
 * Keyboard: shown on focus, exactly as it is on hover — `Tab` reaches the
 * trigger and the tooltip appears; moving on hides it. No separate keyboard
 * path exists to open one, and none is needed, since focus already covers it.
 * `Escape` hides it without moving focus, and the pointer can move onto it
 * without it closing (WCAG 1.4.13): both are Radix's.
 *
 * Wraps its own `Provider` — one per instance rather than one at the
 * application root — trading a slightly later group-hover delay for a
 * primitive that needs nothing mounted above it to work in isolation, in a
 * story or in a test.
 */
export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(function Tooltip(
  { children, content, side = 'top', container, names = false, sideOffset = 6 },
  ref
) {
  const root = (
    <RadixTooltip.Root>
      {/* Radix names the trigger's description after the content while it is open; a name
          restated as its own description is read twice, so `names` takes that back off. */}
      <RadixTooltip.Trigger asChild {...(names ? { 'aria-describedby': undefined } : {})}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal container={container}>
        <RadixTooltip.Content
          ref={ref}
          side={side}
          sideOffset={sideOffset}
          {...(names ? { 'aria-hidden': true } : {})}
          className={cx(
            'z-50 rounded-sm bg-c-inverse px-3 py-1 text-xs font-medium text-c-on-inverse shadow-pop shadow-c-shadow-2'
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-c-inverse" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
  return (
    <RadixTooltip.Provider {...(names ? { delayDuration: NAME_DELAY_MS } : {})}>
      {root}
    </RadixTooltip.Provider>
  )
})
