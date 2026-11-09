// The four-step wizard shell (01-order.md §4): the `Stepper` header and the
// live-region announcement come from `Wizard`; each step below carries its
// own "Continuer"/"Retour" buttons (`PlanStep.tsx` etc.), so `Wizard`'s own
// `back`/`next` slots stay unused here — using them too would put two
// "Continuer" buttons on the same screen (COMPONENTS.md: one primary per
// screen). `quote` is reached from `plan` but is not one of the four steps
// the header shows (01-order.md §4.5): the Enterprise path has no summary,
// no price, and does not count against the buyer's progress through the
// paid flow.

import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { Banner } from '../../ui/Banner/Banner'
import { Wizard } from '../../ui/Wizard/Wizard'
import type { WizardStep } from '../../ui/Wizard/Wizard'
import { AgreementsStep } from './AgreementsStep'
import { ConfirmationStep } from './ConfirmationStep'
import { ContactsStep } from './ContactsStep'
import type { OrderStep } from './draft'
import { furthestStep } from './draft'
import { PlanStep } from './PlanStep'
import type { OrderRole } from './PlanStep'
import { QuoteStep } from './QuoteStep'
import { useOrderDraft } from './useOrderDraft'
import { SUBMISSION_HELD, orderSubmission } from './submission'
import type { OrderOwner } from './owner'

export interface OrderWizardProps {
  org: string
  owner: OrderOwner
  draftId: string
  step: OrderStep | 'quote'
  organisationId: string
  role: OrderRole
  signatoryName: string
  signatoryEmail: string
  onNavigate: (step: OrderStep | 'quote', draftId?: string) => void
  onGoToStatus: () => void
}

const STEP_LABEL_KEY: Record<OrderStep, string> = {
  plan: 'console.order._.label-step-plan',
  contacts: 'console.order._.label-step-contacts',
  agreements: 'console.order._.label-step-agreements',
  confirmation: 'console.order._.label-step-confirmation',
}

export function OrderWizard({
  org,
  owner,
  draftId,
  step,
  organisationId,
  role,
  signatoryName,
  signatoryEmail,
  onNavigate,
  onGoToStatus,
}: OrderWizardProps) {
  const { t } = useTranslation()
  const { draft, update, status } = useOrderDraft(draftId, owner)
  const heldReasonId = useId()
  // A placed order is recorded outside the steps (`submission.ts`), so a remount still finds it.
  const [, setRevision] = useState(0)
  const submission = orderSubmission(draftId)
  const placedOrderId = submission.orderId ?? draft.orderId
  const reachable = furthestStep({ ...draft, orderId: placedOrderId })
  const reachableIndex = ['plan', 'contacts', 'agreements', 'confirmation'].indexOf(reachable)
  const requestedIndex = ['plan', 'contacts', 'agreements', 'confirmation'].indexOf(step)
  const unreachable = step !== 'quote' && requestedIndex > reachableIndex
  useEffect(() => {
    if (status !== 'held' && unreachable) onNavigate(reachable)
  }, [status, unreachable, reachable, onNavigate])

  if (status === 'held')
    return (
      <Banner
        kind="incident"
        headline={t('console.order._.error-outcome-held')}
        action={
          <LinkButton href={`mailto:${SUPPORT_EMAIL}`} variant="tertiary">
            {t('console.common.action-contact-support')}
          </LinkButton>
        }
      />
    )

  if (step === 'quote') {
    return <QuoteStep onBack={() => onNavigate('plan')} />
  }

  // The resume rule (01-order.md §5): a direct visit to a step the draft
  // has not reached yet lands back on the furthest one it actually holds,
  // rather than rendering a screen with data that is still missing.
  if (unreachable) return null

  const stepperSteps: WizardStep[] = (
    ['plan', 'contacts', 'agreements', 'confirmation'] as const
  ).map((candidate) => ({
    id: candidate,
    label: t(STEP_LABEL_KEY[candidate] as never),
    content: null,
  }))

  const announcement = t('console.order._.a11y-step-announcement', {
    step: requestedIndex + 1,
    total: 4,
    label: t(STEP_LABEL_KEY[step] as never),
  })

  return (
    <div className="flex flex-col gap-6">
      {status === 'unavailable' ? (
        <Banner kind="info" headline={t('console.order._.error-draft-storage')} />
      ) : null}
      {status === 'rejected' ? (
        <Banner kind="info" headline={t('console.order._.error-draft-refused')} />
      ) : null}
      {SUBMISSION_HELD ? (
        <Banner
          id={heldReasonId}
          kind="info"
          headline={t('console.order._.status-submission-held')}
        />
      ) : null}
      <Wizard
        steps={stepperSteps}
        step={step}
        stepperLabel={t('console.order._.a11y-steps')}
        announcement={announcement}
      />

      {step === 'plan' ? (
        <PlanStep
          draft={draft}
          update={update}
          role={role}
          organisationId={organisationId}
          onContinue={() => onNavigate('contacts')}
          onRequestQuote={() => onNavigate('quote')}
        />
      ) : null}

      {step === 'contacts' ? (
        <ContactsStep
          draft={draft}
          owner={owner}
          update={update}
          onContinue={() => onNavigate('agreements')}
          onBack={() => onNavigate('plan')}
        />
      ) : null}

      {step === 'agreements' ? (
        draft.packCode === undefined ||
        draft.capacityTierCode === undefined ||
        draft.contacts === undefined ? (
          <Banner kind="incident" headline={t('console.common.error-unavailable')} />
        ) : (
          <AgreementsStep
            draft={draft}
            organisationId={organisationId}
            signatoryName={signatoryName}
            signatoryEmail={signatoryEmail}
            {...(SUBMISSION_HELD ? { submissionHeldReasonId: heldReasonId } : {})}
            onSubmitted={() => {
              setRevision((revision) => revision + 1)
              onNavigate('confirmation')
            }}
            onBack={() => onNavigate('contacts')}
          />
        )
      ) : null}

      {step === 'confirmation' ? (
        placedOrderId === undefined ? (
          <Banner kind="incident" headline={t('console.common.error-unavailable')} />
        ) : (
          <ConfirmationStep
            org={org}
            role={role}
            orderId={placedOrderId}
            firstName={signatoryName.split(' ')[0] ?? signatoryName}
            onGoToStatus={onGoToStatus}
          />
        )
      ) : null}
    </div>
  )
}
