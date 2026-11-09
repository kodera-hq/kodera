// The quick reactions (V1 bar M6): a fixed palette of eight, opened from the button beside a
// message's action menu. No picker and no search; a reaction outside the palette still shows
// and toggles from the message's own reaction row.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Popover } from '../../ui/Popover/Popover'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '😮'] as const

export function ReactionPalette({
  mine,
  onReact,
}: {
  /** The keys the viewer has already reacted with on this message. */
  mine: ReadonlySet<string>
  onReact: (key: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={t('console.workspace.message.reaction-palette-label')}
      trigger={
        <Button
          variant="tertiary"
          size="sm"
          aria-label={t('console.workspace.message.action-add-reaction')}
        >
          <span aria-hidden="true">☺</span>
        </Button>
      }
    >
      <div className="grid grid-cols-4 gap-1">
        {QUICK_REACTIONS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={mine.has(key)}
            aria-label={t('console.workspace.message.action-react-with', { emoji: key })}
            onClick={() => {
              onReact(key)
              setOpen(false)
            }}
            className={cx(
              'inline-flex h-8 items-center justify-center rounded-md border text-lg focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET_HEIGHT,
              mine.has(key)
                ? 'border-c-accent-ink bg-c-accent-soft'
                : 'border-transparent hover:bg-c-muted'
            )}
          >
            {key}
          </button>
        ))}
      </div>
    </Popover>
  )
}
