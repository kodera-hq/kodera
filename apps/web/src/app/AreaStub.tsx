// What every launch area renders until its own unit lands: a page heading
// naming the area, nothing else. Shared so the nine `src/features/<area>/
// routes.ts` files stay a one-line `component`, not nine copies of the same
// markup (brief W0-8 §3).
//
// Not `EmptyState`: that primitive's title is an `<h3>`, meant to sit inside
// a screen that already carries its own `<h1>` above it. A stub route IS the
// whole screen (docs/specs/00-shell-and-login.md §10: "one h1 per screen"),
// so it owns that heading directly rather than composing a primitive whose
// heading level assumes it doesn't have to.

import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../i18n'

export interface AreaStubProps {
  titleKey: MessageKey
}

export function AreaStub({ titleKey }: AreaStubProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
      <h1 className="text-lg font-semibold text-c-ink">{t(titleKey)}</h1>
      <p className="max-w-[320px] text-sm text-c-ink-3">{t('console.common.body-area-pending')}</p>
    </div>
  )
}
