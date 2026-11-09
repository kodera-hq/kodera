// Rendered by `orgRoute`'s `notFoundComponent` when the `:org` slug in the
// URL matches no entry in `GET /me`'s `organisations[]` (docs/specs/
// 00-shell-and-login.md §3: "Unknown slug → a not-found screen using
// catalogue keys"). Own `<h1>`, not `EmptyState`'s `<h3>` — see the same note
// on `AreaStub.tsx`: this IS the screen, not a section inside one.
//
// The router also draws it inside the shell, for an address that names no page
// of the person's own organisation. There the shell's `main` already holds it;
// as the whole page it is the `main` itself — without one, the page had no main
// landmark and its content sat in none (axe `landmark-one-main`, `region`).
// `RouteError.tsx` makes the same choice the same way.

import { useMatches } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

/** `orgRoute`'s id, spelled rather than imported: `org-route.tsx` imports
 * this module. */
const ORG_ROUTE_ID = '/$org'

export function NotFoundOrganisation() {
  const { t } = useTranslation()
  // The shell is on screen only when the organisation layout itself loaded.
  const inShell = useMatches({
    select: (matches) =>
      matches.some((match) => match.routeId === ORG_ROUTE_ID && match.status === 'success'),
  })
  const Frame = inShell ? 'div' : 'main'
  return (
    <Frame className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold text-c-ink">{t('console.common.title-not-found')}</h1>
      <p className="max-w-[320px] text-sm text-c-ink-3">
        {t('console.common.body-not-found-organisation')}
      </p>
    </Frame>
  )
}
