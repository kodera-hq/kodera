// `/{org}/appearance` — « Apparence » (docs/specs/10-appearance.md), the start
// of the delivered design's Réglages › Vous › Apparence pane: one line saying
// how a choice applies, then one preview card per theme. The mock's three
// cards (Clair, Sombre, Noir) come after a fourth, « Automatique », which
// follows the device and is the default — an owner-approved deviation from the
// mock (plan D4, 2026-09-24). The pane's density and text-size rows are not
// drawn: the console has neither setting.
//
// This page only stores a choice and announces it (`src/theme/theme.ts`);
// `public/theme.js` applies it to the whole page, before the first paint on the
// next load and at once on this one.

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { cx } from '../../ui/cx'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import {
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  isThemePreferenceKept,
  readThemePreference,
  saveThemePreference,
} from '../../theme/theme'
import type { ThemePreference } from '../../theme/theme'
import { PAGE_TITLE } from '../../ui/pageTitle'

const COPY: Record<ThemePreference, { label: MessageKey; hint: MessageKey }> = {
  system: {
    label: 'console.shell.appearance.label-system',
    hint: 'console.shell.appearance.hint-system',
  },
  light: {
    label: 'console.shell.appearance.label-light',
    hint: 'console.shell.appearance.hint-light',
  },
  dark: {
    label: 'console.shell.appearance.label-dark',
    hint: 'console.shell.appearance.hint-dark',
  },
  black: {
    label: 'console.shell.appearance.label-black',
    hint: 'console.shell.appearance.hint-black',
  },
}

/** The themes a preview draws: « Automatique » shows both a device can ask for. */
const PREVIEW: Record<ThemePreference, readonly ('light' | 'dark' | 'black')[]> = {
  system: ['light', 'dark'],
  light: ['light'],
  dark: ['dark'],
  black: ['black'],
}

// A card, as in the mock: surface, 12 px radius, 14 px padding, a 1 px border,
// or a 2 px edge when chosen, its padding a pixel smaller so nothing inside
// moves. The chosen edge and label are `c-accent-ink`, not the mock's
// `c-action`, by the owner-approved chosen-edge ruling of `PlanCard` (2026-09-23),
// taken when `action` was 2.88 : 1 against the dark card, under WCAG 1.4.11's
// 3 : 1; tokens v0.5.0 raise it to 3.54 : 1, and the ruling stands. The
// focus ring stands 2 px off the edge (`focus-offset`, `src/index.css`), so it
// never touches the edge it would have to contrast with.
const CARD =
  'flex flex-col gap-[10px] rounded-lg bg-c-surface text-left focus-visible:outline-hidden focus-visible:ring focus-offset focus-visible:ring-offset-2'
const CARD_IDLE = 'border border-c-border p-[14px]'
const CARD_CHOSEN = 'border-2 border-c-accent-ink p-[13px]'

/**
 * A theme drawn with its own roles: `data-theme` on the preview scopes the
 * tokens (`[data-theme="dark"]` sets every `--c-*` below it), so the preview
 * cannot drift from the theme it names. The page's strip, the surface, and a
 * pill in the primary action's colour — the mock's swatch, without its
 * hard-coded values. Decorative: the card's label names the theme.
 */
function Preview({ themes }: { themes: readonly ('light' | 'dark' | 'black')[] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-[56px] overflow-hidden rounded-md border border-c-border"
    >
      {themes.map((theme) => (
        <span key={theme} data-theme={theme} className="flex flex-1">
          <span className="w-[34%] bg-c-page" />
          <span className="flex flex-1 items-end bg-c-surface p-2">
            <span className="h-[10px] w-[44px] max-w-full rounded-full bg-c-action" />
          </span>
        </span>
      ))}
    </span>
  )
}

export function AppearanceScreen() {
  const { t } = useTranslation()
  const id = useId()
  const hintId = `${id}-hint`
  // The choice in effect, not only the stored one: after a refused write the
  // page keeps the refused choice until the next load, and so does a page
  // opened again in the meantime, warning included.
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)
  const [notKept, setNotKept] = useState(() => !isThemePreferenceKept())

  // Another tab's choice reaches this one through `storage`, as it reaches
  // `public/theme.js`; the cards follow it so they never contradict the page.
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return
      setPreference(readThemePreference())
      setNotKept(!isThemePreferenceKept())
    }
    window.addEventListener('storage', follow)
    return () => window.removeEventListener('storage', follow)
  }, [])

  function choose(value: string) {
    const next = THEME_PREFERENCES.find((candidate) => candidate === value)
    if (next === undefined) return
    setPreference(next)
    setNotKept(!saveThemePreference(next))
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className={PAGE_TITLE}>{t('console.shell.appearance.title')}</h1>
        <p className="text-sm text-c-ink-2">{t('console.shell.appearance.subtitle')}</p>
      </div>

      <div className="flex flex-col gap-3">
        <p id={hintId} className="text-xs text-c-ink-3">
          {t('console.shell.appearance.hint-choice')}
        </p>
        <RadioGroupPrimitive.Root
          value={preference}
          onValueChange={choose}
          aria-label={t('console.shell.appearance.label-theme')}
          aria-describedby={hintId}
          className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3 narrow:grid-cols-1"
        >
          {THEME_PREFERENCES.map((theme) => {
            const chosen = theme === preference
            return (
              <RadioGroupPrimitive.Item
                key={theme}
                value={theme}
                aria-labelledby={`${id}-${theme}-label`}
                aria-describedby={`${id}-${theme}-hint`}
                className={cx(CARD, chosen ? CARD_CHOSEN : CARD_IDLE)}
              >
                <Preview themes={PREVIEW[theme]} />
                <span
                  id={`${id}-${theme}-label`}
                  className={cx(
                    'text-sm font-semibold',
                    chosen ? 'text-c-accent-ink' : 'text-c-ink'
                  )}
                >
                  {t(COPY[theme].label)}
                </span>
                <span id={`${id}-${theme}-hint`} className="text-xs text-c-ink-3">
                  {t(COPY[theme].hint)}
                </span>
              </RadioGroupPrimitive.Item>
            )
          })}
        </RadioGroupPrimitive.Root>
        {/* Mounted empty from the start, so the warning is announced when it
            appears: a polite region inserted with its message is often not.
            `-mt-3` cancels the column's gap while it is empty; the warning
            puts it back. */}
        <div role="status" className="-mt-3">
          {notKept ? (
            <InlineAlert kind="warning" inLiveRegion className="mt-3">
              {t('console.shell.appearance.warning-not-kept')}
            </InlineAlert>
          ) : null}
        </div>
      </div>
    </div>
  )
}
