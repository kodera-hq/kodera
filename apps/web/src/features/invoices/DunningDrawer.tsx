// The dunning ladder drawer (§4.5), opened from the list banner or the
// detail screen. Renders `DunningView.steps[]` through `classifyDunningSteps`
// (`./dunning.ts`) — a pure mapping, tested on its own — onto `ProgressList`
// (one of the three primitives `docs/specs/README.md`'s "Design gaps" table
// names, built to cover exactly the states the drop's own "Provisioning
// timeline" does not: a step with no timestamp at all, which an unresolved
// ladder step reaches when `due_at` is missing).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FocusTarget } from '../../ui/returnFocus'
import type { ReactNode } from 'react'
import type { MessageKey } from '../../i18n'
import { formatDate } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Drawer } from '../../ui/Drawer/Drawer'
import type { ProgressListStep, ProgressStepStatus } from '../../ui/ProgressList/ProgressList'
import { ProgressList } from '../../ui/ProgressList/ProgressList'
import { useLocale } from './useLocale'
import {
  activeHoldUntil,
  classifyDunningSteps,
  displayedLadder,
  isPastDue,
  overdueSinceDate,
} from './dunning'
import type { DunningStepKind } from './dunning'
import type { DunningView } from './queries'

const KIND_LABEL_KEY: Record<Exclude<DunningStepKind, 'past-due' | 'other'>, MessageKey> = {
  'reminder-1': 'console.invoices.dunning.status-reminder-1',
  'reminder-2': 'console.invoices.dunning.status-reminder-2',
  'formal-notice': 'console.invoices.dunning.status-formal-notice',
  'suspension-notice': 'console.invoices.dunning.status-suspension-notice',
  suspension: 'console.invoices.dunning.status-suspension',
}

/** While a dispute holds the ladder: the same steps, undated, paused. */
const HELD_LABEL_KEY: Record<Exclude<DunningStepKind, 'past-due' | 'other'>, MessageKey> = {
  'reminder-1': 'console.invoices.dunning.status-reminder-1-held',
  'reminder-2': 'console.invoices.dunning.status-reminder-2-held',
  'formal-notice': 'console.invoices.dunning.status-formal-notice-held',
  'suspension-notice': 'console.invoices.dunning.status-suspension-notice-held',
  suspension: 'console.invoices.dunning.status-suspension-held',
}

/** `ProgressList` steps read `done` → `done`; the one step still ahead of
 * today reads `running`; everything after it reads `pending` — there is no
 * `failed`/`skipped` step in a dunning ladder. */
function progressStatus(done: boolean, isNext: boolean): ProgressStepStatus {
  if (done) return 'done'
  if (isNext) return 'running'
  return 'pending'
}

export interface DunningDrawerProps {
  dunning: DunningView | undefined
  loading: boolean
  errored: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: ReactNode
  returnFocusTo?: FocusTarget
  onPayNow?: (() => void) | undefined
  onContactSupport: () => void
}

export function DunningDrawer({
  dunning,
  loading,
  errored,
  open,
  onOpenChange,
  trigger,
  returnFocusTo,
  onPayNow,
  onContactSupport,
}: DunningDrawerProps) {
  const { t } = useTranslation()
  const locale = useLocale()

  const classified = dunning === undefined ? [] : classifyDunningSteps(dunning.steps)
  // A dispute freezes the ladder: nothing is "in progress", and the
  // suspension is shown as held, with no date (`displayedLadder`).
  const [now] = useState(Date.now)
  const holdActive = activeHoldUntil(dunning?.hold_until, now) !== undefined
  const rungs = displayedLadder(classified, holdActive)
  const firstPending = holdActive ? undefined : rungs.find((step) => !step.done)
  const overdueSince = overdueSinceDate(classified)

  const steps: ProgressListStep[] = rungs.map((step) =>
    step.held
      ? {
          id: step.id,
          label: t(HELD_LABEL_KEY[step.kind as Exclude<DunningStepKind, 'past-due' | 'other'>]),
          // `skipped` draws a dashed circle and reads the "paused" word
          // below: a dunning ladder has no skipped step of its own.
          status: 'skipped',
        }
      : {
          id: step.id,
          label: t(KIND_LABEL_KEY[step.kind as Exclude<DunningStepKind, 'past-due' | 'other'>], {
            date: step.dueAt ? formatDate(step.dueAt, locale) : '',
          }),
          // A step the ladder has reached but not marked done is under way,
          // never "À venir" with a date already gone.
          status: progressStatus(step.done, step.id === firstPending?.id || isPastDue(step, now)),
          ...(step.dueAt ? { timestamp: formatDate(step.dueAt, locale) } : {}),
        }
  )

  return (
    <Drawer
      {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      title={t('console.invoices.dunning.title')}
      closeLabel={t('console.common.action-close')}
      footer={
        <>
          <Button variant="secondary" onClick={onContactSupport}>
            {t('console.common.action-contact-support')}
          </Button>
          {onPayNow === undefined ? null : (
            <Button variant={holdActive ? 'secondary' : 'primary'} onClick={onPayNow}>
              {t('console.invoices.dunning.action-pay-now')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <p role="status" className="text-sm text-c-ink-3">
            {t('console.invoices._.a11y-loading')}
          </p>
        ) : errored ? (
          <p className="text-sm text-c-ink-3">{t('console.common.error-unavailable')}</p>
        ) : (
          <>
            {overdueSince === undefined ? null : (
              <p className="text-sm font-medium text-c-ink">
                {t('console.invoices.dunning.label-overdue-since', {
                  date: formatDate(overdueSince, locale),
                })}
              </p>
            )}
            <ProgressList
              steps={steps}
              statusLabels={{
                pending: t('console.invoices.dunning.status-word-pending'),
                running: t('console.invoices.dunning.status-word-running'),
                done: t('console.invoices.dunning.status-word-done'),
                failed: t('console.invoices.dunning.status-word-failed'),
                skipped: holdActive
                  ? t('console.invoices.dunning.status-word-paused')
                  : t('console.invoices.dunning.status-word-skipped'),
              }}
            />
            <p className="text-sm text-c-ink-3">{t('console.invoices.dunning.hint-restore')}</p>
          </>
        )}
      </div>
    </Drawer>
  )
}
