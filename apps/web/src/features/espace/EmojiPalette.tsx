// The composer's emoji palette (workspace audit item 4): « Insérer un émoji » opens a grid of 32
// emoji, and choosing one writes it at the field's caret. No search: the « :nom: » shortcodes
// (`emoji.ts`) reach every other emoji, and each button's tooltip is its code.
//
// Keyboard: one tab stop for the grid. The arrow keys move within it, `Home` and `End` go to its
// first and last, `Enter` or `Space` chooses. Choosing puts the focus back in the field;
// `Escape` or `Tab` closes the palette and returns the focus to the button.
//
// Eight to a row, six at phone width, where each cell keeps the 44 px touch floor.

import { useNarrowViewport } from '../../app/useNarrowViewport'

import { useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { EmojiIcon } from '../../ui/icons/Composer'
import { Popover } from '../../ui/Popover/Popover'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { PALETTE_EMOJI } from './emoji'

function moves(columns: number): Record<string, (at: number) => number> {
  return {
    ArrowRight: (at) => at + 1,
    ArrowLeft: (at) => at - 1,
    ArrowDown: (at) => at + columns,
    ArrowUp: (at) => at - columns,
    Home: () => 0,
    End: () => PALETTE_EMOJI.length - 1,
  }
}

export function EmojiPalette({
  disabled,
  anchorRef,
  onPick,
}: {
  disabled?: boolean
  /** The composer's box: the palette opens above it, never over the field. */
  anchorRef?: RefObject<HTMLElement | null>
  /** Writes the emoji into the field and puts the focus back there. */
  onPick: (emoji: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const narrow = useNarrowViewport()

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      // The popover sits at the end of the page, so `Tab` would leave it for nowhere near the
      // composer: it closes instead, and the focus goes back to the button, as with `Escape`.
      event.preventDefault()
      setOpen(false)
      return
    }
    const move = moves(narrow ? 6 : 8)[event.key]
    if (move === undefined) return
    event.preventDefault()
    const next = Math.min(Math.max(move(active), 0), PALETTE_EMOJI.length - 1)
    setActive(next)
    cells.current[next]?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setActive(0)
        setOpen(next)
      }}
      side="top"
      align="start"
      {...(anchorRef === undefined ? {} : { anchorRef })}
      label={t('console.workspace.composer.label-emoji-palette')}
      trigger={
        // p02's `.icon-btn`, drawn as « Mentionner » beside it is.
        <button
          type="button"
          aria-label={t('console.workspace.composer.action-emoji')}
          disabled={disabled}
          className={cx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
            'hover:bg-c-sunken hover:text-c-ink',
            'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
            'data-[state=open]:bg-c-sunken data-[state=open]:text-c-ink',
            TOUCH_TARGET,
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          <EmojiIcon />
        </button>
      }
    >
      {/* The grid's own arrow keys; each cell is a button and stays one. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className={cx('grid gap-1', narrow ? 'grid-cols-6' : 'grid-cols-8')} onKeyDown={keyDown}>
        {PALETTE_EMOJI.map(({ emoji, names }, index) => (
          <button
            key={emoji}
            ref={(element) => {
              cells.current[index] = element
            }}
            type="button"
            tabIndex={index === active ? 0 : -1}
            title={`:${names[0]!}:`}
            aria-label={t('console.workspace.composer.action-insert-emoji', { emoji })}
            onFocus={() => setActive(index)}
            onClick={() => {
              // `onPick` focuses the field, outside the popover, so Radix leaves the focus there
              // as the popover closes instead of returning it to the button.
              onPick(emoji)
              setOpen(false)
            }}
            className={cx(
              'inline-flex h-8 w-8 items-center justify-center rounded-md text-lg',
              'hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
    </Popover>
  )
}
