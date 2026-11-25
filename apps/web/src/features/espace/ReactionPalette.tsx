// Quick reactions + Kodera original and workspace custom WebP reactions, opened beside a message's
// action menu.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Popover } from '../../ui/Popover/Popover'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { refreshWorkspaceCustomEmojis, useCustomEmojis } from './customEmojiStore'
import { experienceCopy } from './experienceMessages'
import { CustomWorkspaceEmoji } from './KoderaEmoji'
import { shortcodeOf } from './koderaShortcodes'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '😮'] as const

export function ReactionPalette({
  mine,
  onReact,
}: {
  /** The keys the viewer has already reacted with on this message. */
  mine: ReadonlySet<string>
  onReact: (key: string) => void
}) {
  const { t, i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage)
  const organisationId = useMessagingOrganisation()
  const { items: customItems, enabled: customEnabled } = useCustomEmojis(organisationId)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (open && organisationId && customEnabled) {
      void refreshWorkspaceCustomEmojis(organisationId)
    }
  }, [open, organisationId, customEnabled])

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
      <div className="flex flex-col gap-2">
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
        {customEnabled && customItems.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-c-border-soft pt-2">
            <p className="text-xs font-semibold text-c-ink-3">
              {copy.customEmojis.paletteHeading}
            </p>
            <div className="grid grid-cols-4 gap-1">
              {customItems.slice(0, 12).map((item) => {
                const code = shortcodeOf(item.shortcode)
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={mine.has(code)}
                    aria-label={t('console.workspace.message.action-react-with', { emoji: code })}
                    title={code}
                    onClick={() => {
                      onReact(code)
                      setOpen(false)
                    }}
                    className={cx(
                      'inline-flex h-8 items-center justify-center rounded-md border focus-visible:ring focus-visible:outline-hidden',
                      TOUCH_TARGET_HEIGHT,
                      mine.has(code)
                        ? 'border-c-accent-ink bg-c-accent-soft'
                        : 'border-transparent hover:bg-c-muted'
                    )}
                  >
                    <CustomWorkspaceEmoji
                      organisationId={organisationId}
                      shortcode={item.shortcode}
                    />
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </Popover>
  )
}
