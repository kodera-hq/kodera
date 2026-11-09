// `login-organisation` (docs/specs/00-shell-and-login.md §4.2): one email,
// several organisations. Reached only when `POST /auth/discover` returns two
// or more `candidates` and no `realm` — §3 names no URL for this screen
// either, so `LoginScreen` renders it as a view over the same route, exactly
// like `Handoff`.
//
// The wireframe pairs each organisation's name with its domain so two
// organisations that share a display name (§2, "Where it still fails") can
// still be told apart. Neither `RealmDiscoveryResult.candidates[]` nor
// `Me.organisations[]` carries a domain field, though — the contract's
// `OrganisationSummary` (§6's own field list for this call) stops at `id`,
// `slug`, `name`, `realm`. Reported as a gap: this renders the `slug`
// instead, the only other field the response actually carries that tells
// two same-named organisations apart.

import { useTranslation } from 'react-i18next'
import type { RealmDiscoveryResult } from './useDiscoverRealm'
import { Button } from '../../ui/Button/Button'
import { Card } from '../../ui/Card/Card'

type Candidate = RealmDiscoveryResult['candidates'][number]

export interface OrganisationChoiceProps {
  candidates: RealmDiscoveryResult['candidates']
  onChoose: (candidate: Candidate) => void
  onBack: () => void
}

export function OrganisationChoice({ candidates, onChoose, onBack }: OrganisationChoiceProps) {
  const { t } = useTranslation()

  return (
    <main className="flex min-h-screen items-center justify-center p-6 narrow:p-4">
      <div className="flex w-full max-w-[420px] flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-c-ink">
            {t('console.login.organisation.title', { count: candidates.length })}
          </h1>
          <p className="mt-1 text-md text-c-ink-3">{t('console.login.organisation.subtitle')}</p>
        </div>

        {/* The rule between rows sits on the top of every row after the first,
            the selector `divide-y` had under Tailwind 3. Tailwind 4's `divide-y`
            puts it on the bottom of every row but the last instead, which moves
            each row's box, and with it the row's focus ring, by 1 px. */}
        <Card className="overflow-hidden [&>:not([hidden])~:not([hidden])]:border-t [&>:not([hidden])~:not([hidden])]:border-c-border-soft">
          {candidates.map((candidate) => (
            <button
              key={candidate.realm}
              type="button"
              onClick={() => onChoose(candidate)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
            >
              <span className="font-medium text-c-ink">{candidate.organisation.name}</span>
              <span className="text-sm text-c-ink-3">{candidate.organisation.slug}</span>
            </button>
          ))}
        </Card>

        <Button variant="tertiary" onClick={onBack}>
          {t('console.login.organisation.action-back')}
        </Button>
      </div>
    </main>
  )
}
