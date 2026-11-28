import { HomeRecovery } from './HomeRecovery'
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

import { useEffect } from 'react'
import { forgetSharedRealmSlug } from '../auth/sharedRealmHints'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { StageContainer, useInOrgShell } from '../ui/StageFrame/KoderaStageEmblem'

export function NotFoundOrganisation() {
  const { t } = useTranslation()
  const { org } = useParams({ strict: false })
  const inShell = useInOrgShell()
  useEffect(() => {
    if (!inShell && typeof org === 'string') forgetSharedRealmSlug(org)
  }, [inShell, org])
  return (
    <StageContainer inShell={inShell}>
      <h1 className="text-lg font-semibold text-c-ink">{t('console.common.title-not-found')}</h1>
      <p className="max-w-shell-dock-width text-sm text-c-ink-3">
        {t('console.common.body-not-found-organisation')}
      </p>
      <HomeRecovery />
    </StageContainer>
  )
}
