// The composer's emoji palette: « Insérer un émoji » opens a grid of Unicode emoji, Kodera's
// original SVG glyphs (`koderaShortcodes.ts`), and sanitized workspace custom WebP emojis.

import { useNarrowViewport } from '../../app/useNarrowViewport'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { EmojiIcon } from '../../ui/icons/Composer'
import { Popover } from '../../ui/Popover/Popover'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { refreshWorkspaceCustomEmojis, useCustomEmojis } from './customEmojiStore'
import { PALETTE_EMOJI } from './emoji'
import { experienceCopy } from './experienceMessages'
import { CustomWorkspaceEmoji, KoderaEmoji } from './KoderaEmoji'
import { KODERA_EMOJI, shortcodeOf, type KoderaEmojiName } from './koderaShortcodes'

interface PaletteCell {
  readonly key: string
  readonly text: string
  readonly title: string
  readonly kodera?: KoderaEmojiName
  readonly customShortcode?: string
}

const BASE_CELLS: readonly PaletteCell[] = [
  ...PALETTE_EMOJI.map(({ emoji, names }) => ({
    key: emoji,
    text: emoji,
    title: `:${names[0]!}:`,
  })),
  ...KODERA_EMOJI.map((name) => ({
    key: name,
    text: shortcodeOf(name),
    title: shortcodeOf(name),
    kodera: name,
  })),
]

function moves(columns: number, total: number): Record<string, (at: number) => number> {
  return {
    ArrowRight: (at) => at + 1,
    ArrowLeft: (at) => at - 1,
    ArrowDown: (at) => at + columns,
    ArrowUp: (at) => at - columns,
    Home: () => 0,
    End: () => Math.max(0, total - 1),
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
  const { t, i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage)
  const organisationId = useMessagingOrganisation()
  const { items: customItems, enabled: customEnabled } = useCustomEmojis(organisationId)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const narrow = useNarrowViewport()

  useEffect(() => {
    if (open && organisationId && customEnabled) {
      void refreshWorkspaceCustomEmojis(organisationId)
    }
  }, [open, organisationId, customEnabled])

  const allCells = useMemo<readonly PaletteCell[]>(() => {
    if (!customEnabled || customItems.length === 0) return BASE_CELLS
    return [
      ...BASE_CELLS,
      ...customItems.map((item) => ({
        key: `custom:${item.id}`,
        text: shortcodeOf(item.shortcode),
        title: shortcodeOf(item.shortcode),
        customShortcode: item.shortcode,
      })),
    ]
  }, [customEnabled, customItems])

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      event.preventDefault()
      setOpen(false)
      return
    }
    const move = moves(narrow ? 6 : 8, allCells.length)[event.key]
    if (move === undefined) return
    event.preventDefault()
    const next = Math.min(Math.max(move(active), 0), allCells.length - 1)
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
        <button
          type="button"
          aria-label={t('console.workspace.composer.action-emoji')}
          title={t('console.workspace.composer.action-emoji')}
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
        {allCells.map(({ key, text, title, kodera, customShortcode }, index) => (
          <Fragment key={key}>
            {index === PALETTE_EMOJI.length ? (
              <p className="col-span-full pt-2 text-xs font-semibold text-c-ink-3">
                {t('console.workspace.composer.label-kodera-emoji')}
              </p>
            ) : null}
            {index === BASE_CELLS.length ? (
              <p className="col-span-full pt-2 text-xs font-semibold text-c-ink-3">
                {copy.customEmojis.paletteHeading}
              </p>
            ) : null}
            <button
              ref={(element) => {
                cells.current[index] = element
              }}
              type="button"
              tabIndex={index === active ? 0 : -1}
              title={title}
              aria-label={t('console.workspace.composer.action-insert-emoji', { emoji: text })}
              onFocus={() => setActive(index)}
              onClick={() => {
                onPick(text)
                setOpen(false)
              }}
              className={cx(
                'inline-flex h-8 w-8 items-center justify-center rounded-md text-lg',
                'hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              {kodera !== undefined ? (
                <KoderaEmoji name={kodera} />
              ) : customShortcode !== undefined ? (
                <CustomWorkspaceEmoji
                  organisationId={organisationId}
                  shortcode={customShortcode}
                />
              ) : (
                text
              )}
            </button>
          </Fragment>
        ))}
      </div>
    </Popover>
  )
}
