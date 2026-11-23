import type { MessageKey } from '../../i18n'

export const ONBOARDING_STORAGE_KEY = 'kodera.onboarding.completed.v1'

export type OnboardingStepId = 'theme' | 'sonic' | 'av_check' | 'channels'

/**
 * A step of the guided tour. Its words are catalogue keys (`console.onboarding.tour.*`), read
 * with `t` where the step is drawn: nothing here is a sentence, in any language. The badge is
 * one key for every step, « Étape {step} sur {total} », filled from `stepNumber`.
 */
export interface OnboardingStepDescriptor {
  readonly id: OnboardingStepId
  readonly stepNumber: 1 | 2 | 3 | 4
  readonly title: MessageKey
  readonly subtitle: MessageKey
  readonly badge: MessageKey
}

const STEP_BADGE = 'console.onboarding.tour.step-badge' satisfies MessageKey

export const ONBOARDING_STEPS: readonly OnboardingStepDescriptor[] = [
  {
    id: 'theme',
    stepNumber: 1,
    title: 'console.onboarding.tour.theme-title',
    subtitle: 'console.onboarding.tour.theme-subtitle',
    badge: STEP_BADGE,
  },
  {
    id: 'sonic',
    stepNumber: 2,
    title: 'console.onboarding.tour.sonic-title',
    subtitle: 'console.onboarding.tour.sonic-subtitle',
    badge: STEP_BADGE,
  },
  {
    id: 'av_check',
    stepNumber: 3,
    title: 'console.onboarding.tour.av-check-title',
    subtitle: 'console.onboarding.tour.av-check-subtitle',
    badge: STEP_BADGE,
  },
  {
    id: 'channels',
    stepNumber: 4,
    title: 'console.onboarding.tour.channels-title',
    subtitle: 'console.onboarding.tour.channels-subtitle',
    badge: STEP_BADGE,
  },
] as const

/**
 * A channel the tour presents. `id` is the channel's identifier; `label` is a catalogue key for
 * the words shown beside it (« #proximité », « #proximity »): a label only, never an identifier.
 */
export interface OnboardingGuidedChannel {
  readonly id: string
  readonly label: MessageKey
  readonly description: MessageKey
  readonly badge: MessageKey
}

export const ONBOARDING_GUIDED_CHANNELS: readonly OnboardingGuidedChannel[] = [
  {
    id: 'general',
    label: 'console.onboarding.tour.general-label',
    description: 'console.onboarding.tour.general-description',
    badge: 'console.onboarding.tour.general-badge',
  },
  {
    id: 'architecture',
    label: 'console.onboarding.tour.architecture-label',
    description: 'console.onboarding.tour.architecture-description',
    badge: 'console.onboarding.tour.architecture-badge',
  },
  {
    id: 'proximity',
    label: 'console.onboarding.tour.proximity-label',
    description: 'console.onboarding.tour.proximity-description',
    badge: 'console.onboarding.tour.proximity-badge',
  },
] as const

export function getOnboardingStepIndex(stepId: OnboardingStepId): number {
  const index = ONBOARDING_STEPS.findIndex((step) => step.id === stepId)
  return index >= 0 ? index : 0
}

export function nextOnboardingStep(current: OnboardingStepId): OnboardingStepId {
  const index = getOnboardingStepIndex(current)
  const next = ONBOARDING_STEPS[Math.min(ONBOARDING_STEPS.length - 1, index + 1)]
  return next ? next.id : 'channels'
}

export function prevOnboardingStep(current: OnboardingStepId): OnboardingStepId {
  const index = getOnboardingStepIndex(current)
  const prev = ONBOARDING_STEPS[Math.max(0, index - 1)]
  return prev ? prev.id : 'theme'
}

export function isOnboardingCompleted(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function markOnboardingCompleted(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    return true
  } catch {
    return false
  }
}

export function resetOnboardingCompleted(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch {
    // Ignore storage removal errors in restricted environments
  }
}

export const ACTIVATION_STORAGE_PREFIX = 'kodera.onboarding.activation.v1.'

export const ACTIVATION_TASK_IDS = [
  'identity_template',
  'theme_sonic',
  'invite_member',
  'first_message_or_call',
] as const

export type ActivationTaskId = (typeof ACTIVATION_TASK_IDS)[number]

export interface ActivationChecklistState {
  readonly org: string
  readonly completed: readonly ActivationTaskId[]
  readonly dismissed: boolean
}

function normalizeOrgKey(org: string): string {
  return org.trim().toLowerCase()
}

export function activationChecklistStorageKey(org: string): string {
  return `${ACTIVATION_STORAGE_PREFIX}${normalizeOrgKey(org)}`
}

function isActivationTaskId(value: unknown): value is ActivationTaskId {
  return typeof value === 'string' && (ACTIVATION_TASK_IDS as readonly string[]).includes(value)
}

function canonicalizeTasks(tasks: readonly unknown[]): readonly ActivationTaskId[] {
  const seen = new Set<ActivationTaskId>()
  for (const item of tasks) {
    if (isActivationTaskId(item)) seen.add(item)
  }
  return ACTIVATION_TASK_IDS.filter((id) => seen.has(id))
}

function writeActivationChecklist(state: ActivationChecklistState): void {
  const normalizedOrg = normalizeOrgKey(state.org)
  if (!normalizedOrg || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      activationChecklistStorageKey(normalizedOrg),
      JSON.stringify({
        completed: state.completed,
        dismissed: state.dismissed,
      })
    )
  } catch {
    // Ignore storage write errors in restricted environments
  }
}

export function readActivationChecklist(
  org: string,
  defaultCompleted: readonly ActivationTaskId[] = []
): ActivationChecklistState {
  const normalizedOrg = normalizeOrgKey(org)
  const fallback: ActivationChecklistState = {
    org: normalizedOrg,
    completed: canonicalizeTasks(defaultCompleted),
    dismissed: false,
  }
  if (!normalizedOrg || typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(activationChecklistStorageKey(normalizedOrg))
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    const record = parsed as Record<string, unknown>
    const completed = Array.isArray(record.completed)
      ? canonicalizeTasks(record.completed)
      : fallback.completed
    return {
      org: normalizedOrg,
      completed,
      dismissed: record.dismissed === true,
    }
  } catch {
    return fallback
  }
}

export function completeActivationTask(
  org: string,
  taskId: ActivationTaskId
): ActivationChecklistState {
  const current = readActivationChecklist(org)
  if (!isActivationTaskId(taskId) || current.completed.includes(taskId)) {
    writeActivationChecklist(current)
    return current
  }
  const next: ActivationChecklistState = {
    org: current.org,
    completed: canonicalizeTasks([...current.completed, taskId]),
    dismissed: current.dismissed,
  }
  writeActivationChecklist(next)
  return next
}

export function dismissActivationChecklist(org: string): ActivationChecklistState {
  const current = readActivationChecklist(org)
  const next: ActivationChecklistState = {
    org: current.org,
    completed: current.completed,
    dismissed: true,
  }
  writeActivationChecklist(next)
  return next
}
