// The active language, narrowed to `src/i18n/format.ts`'s `Locale` — the
// catalogue only ever runs in `fr` or `en` (`src/i18n/index.ts`'s own
// `supportedLngs`), so this is a total mapping, never a guess.

import { useTranslation } from 'react-i18next'
import type { Locale } from '../../i18n/format'

export function useLocale(): Locale {
  const { i18n } = useTranslation()
  return i18n.language === 'en' ? 'en' : 'fr'
}
