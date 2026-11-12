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
