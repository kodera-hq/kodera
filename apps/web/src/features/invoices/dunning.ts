// Pure mapping from `DunningView.steps[]` (docs/specs/05-invoices.md §6) to
// what the dunning drawer renders. Kept free of React and i18next so it can
// be unit-tested without a translation context — the screen maps a `kind`
// here onto a message-catalogue key, this module never touches one.
//
// "Two email reminders are the same `notice` state at different ages" (§6):
// the contract tells them apart only by order in `steps[]`, which is already
// oldest-first (`DunningView`'s own doc comment: "the whole ladder, so the
// customer sees the step after the one they are on"), so the first `notice`
// entry is the first reminder and the second is the second — never `days_overdue`,
// which is a snapshot of today, not a property of a given step.

import type { components } from '../../api/schema'

export type DunningStepState = components['schemas']['DunningState']

export interface DunningStepInput {
  readonly state: DunningStepState
  readonly due_at?: string | null
  readonly done: boolean
}

export type DunningStepKind =
  | 'past-due'
  | 'reminder-1'
  | 'reminder-2'
  | 'formal-notice'
  | 'suspension-notice'
  | 'suspension'
  | 'other'

export interface ClassifiedDunningStep {
  readonly id: string
  readonly kind: DunningStepKind
  readonly dueAt: string | null | undefined
  readonly done: boolean
}

function kindOf(state: DunningStepState, noticeOccurrence: number): DunningStepKind {
  switch (state) {
    case 'past_due':
      return 'past-due'
    case 'notice':
      return noticeOccurrence === 1 ? 'reminder-1' : 'reminder-2'
    case 'formal_notice':
      return 'formal-notice'
    case 'suspension_notice':
      return 'suspension-notice'
    case 'suspended':
      return 'suspension'
    default:
      return 'other'
  }
}

/** One entry per step, in the order the API returned them. */
export function classifyDunningSteps(
  steps: readonly DunningStepInput[]
): readonly ClassifiedDunningStep[] {
  let noticeCount = 0
  return steps.map((step, index) => {
    if (step.state === 'notice') noticeCount += 1
    return {
      id: `${index}-${step.state}`,
      kind: kindOf(step.state, noticeCount),
      dueAt: step.due_at,
      done: step.done,
    }
  })
}

/**
 * The date the drawer's "Échéance dépassée le {date}" header quotes — the
 * `due_at` of the ladder's own `past_due` step, when the API returns one.
 * `undefined` when it does not (§5's "Dates unavailable" state), so the
 * screen can fall back to the ladder alone rather than a broken sentence.
 */
export function overdueSinceDate(steps: readonly ClassifiedDunningStep[]): string | undefined {
  return steps.find((step) => step.kind === 'past-due')?.dueAt ?? undefined
}

/**
 * The steps the drawer's `ProgressList` renders: every step but the
 * `past_due` one, which the header line above the list already states, and
 * `other` (an unclassified state, e.g. `terminated`, that has no ladder
 * sentence of its own — a case this launch's overlays never reach).
 */
export function ladderSteps(
  steps: readonly ClassifiedDunningStep[]
): readonly ClassifiedDunningStep[] {
  return steps.filter((step) => step.kind !== 'past-due' && step.kind !== 'other')
}

/**
 * Whether a billing dispute is freezing the ladder right now: `hold_until`
 * is set and still ahead. A hold whose date has passed is over; it is never
 * shown as a date to come.
 */
export function activeHoldUntil(
  holdUntil: string | null | undefined,
  now: number
): string | undefined {
  if (holdUntil === null || holdUntil === undefined) return undefined
  const until = Date.parse(holdUntil)
  return Number.isNaN(until) || until <= now ? undefined : holdUntil
}

/**
 * The date access would be suspended, when the ladder carries one that is
 * still to come: the `suspended` step, not done, dated in the future. A step
 * already done or dated in the past is not a threat about the future, and a
 * sentence that says "before {date}" must never name a date that has gone.
 */
export function upcomingSuspensionDate(
  steps: readonly ClassifiedDunningStep[],
  now: number
): string | undefined {
  const step = steps.find((candidate) => candidate.kind === 'suspension')
  if (step === undefined || step.done || !step.dueAt) return undefined
  const due = Date.parse(step.dueAt)
  return Number.isNaN(due) || due <= now ? undefined : step.dueAt
}

export interface DisplayedDunningStep extends ClassifiedDunningStep {
  /** The step is one the open dispute is holding back: shown without a
   * date, as paused while the dispute is examined. */
  readonly held: boolean
}

/**
 * The drawer's rungs. While a dispute holds the ladder, no step that is not
 * done is a dated step to come — reminders, the formal notice and its
 * penalties, the suspension notice and the suspension itself are all paused.
 */
export function displayedLadder(
  steps: readonly ClassifiedDunningStep[],
  holdActive: boolean
): readonly DisplayedDunningStep[] {
  return ladderSteps(steps).map((step) => ({ ...step, held: holdActive && !step.done }))
}

/**
 * A step that is not done but whose date has passed is not "to come": the
 * ladder has reached it and it is being carried out (§4.5, "En cours").
 */
export function isPastDue(step: ClassifiedDunningStep, now: number): boolean {
  if (step.done || !step.dueAt) return false
  const due = Date.parse(step.dueAt)
  return !Number.isNaN(due) && due <= now
}
