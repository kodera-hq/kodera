import * as RadixTabs from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

export interface TabItem {
  value: string
  label: string
  content: ReactNode
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  /**
   * Controlled, always — never internal state. A screen keeps `?tab=` in the
   * URL as the single source of truth and passes it straight through here;
   * an uncontrolled tab list would let the URL and the visible panel
   * disagree the moment someone uses the back button.
   */
  value: string
  onValueChange: (value: string) => void
  /** Accessible name for the tab list, e.g. "Sections du domaine". */
  ariaLabel: string
}

/**
 * Behaviour from `@radix-ui/react-tabs`: roving `Tabindex`, `ArrowLeft` /
 * `ArrowRight` moving focus and activating the tab under it (automatic
 * activation — this is a set of views, not a form where changing focus
 * should not fire an action), `Home`/`End` to the first/last enabled tab, a
 * disabled tab skipped entirely by arrow navigation.
 */
export function Tabs({ items, value, onValueChange, ariaLabel }: TabsProps) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List aria-label={ariaLabel} className="flex gap-6 border-b border-c-border">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cx(
              'relative -mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors duration-fast ease-out',
              'focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET_HEIGHT,
              'data-[state=active]:border-c-accent-ink data-[state=active]:text-c-accent-ink',
              'data-[state=inactive]:border-transparent data-[state=inactive]:text-c-ink-3',
              'data-[state=inactive]:hover:text-c-ink',
              'data-[disabled]:cursor-not-allowed data-[disabled]:text-c-ink-3 data-[disabled]:opacity-50'
            )}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-4">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}
