export const ONBOARDING_STORAGE_KEY = 'kodera.onboarding.completed.v1'

export type OnboardingStepId = 'theme' | 'sonic' | 'av_check' | 'channels'

export interface OnboardingStepDescriptor {
  readonly id: OnboardingStepId
  readonly stepNumber: 1 | 2 | 3 | 4
  readonly title: string
  readonly subtitle: string
  readonly badge: string
}

export const ONBOARDING_STEPS: readonly OnboardingStepDescriptor[] = [
  {
    id: 'theme',
    stepNumber: 1,
    title: 'Apparence visuelle',
    subtitle: 'Choisissez entre la clarté Givre et le confort nocturne Nuit avec aperçu immédiat.',
    badge: 'Étape 1 sur 4',
  },
  {
    id: 'sonic',
    stepNumber: 2,
    title: 'Signature acoustique 48 kHz',
    subtitle: 'Écoutez et sélectionnez votre identité sonore WebAudio DSP synthétisée en temps réel.',
    badge: 'Étape 2 sur 4',
  },
  {
    id: 'av_check',
    stepNumber: 3,
    title: 'Micro & Masque IA local',
    subtitle: '100 % sur l’appareil, zéro donnée biométrique envoyée au serveur.',
    badge: 'Étape 3 sur 4',
  },
  {
    id: 'channels',
    stepNumber: 4,
    title: 'Vos salons essentiels',
    subtitle: 'Visite guidée en un clic de vos salons de coordination, d’architecture et d’urgence.',
    badge: 'Étape 4 sur 4',
  },
] as const

export interface OnboardingGuidedChannel {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly badge: string
}

export const ONBOARDING_GUIDED_CHANNELS: readonly OnboardingGuidedChannel[] = [
  {
    id: 'general',
    label: '#général',
    description: 'Coordination quotidienne, annonces d’équipe et sondages rapides.',
    badge: 'Quotidien',
  },
  {
    id: 'architecture',
    label: '#architecture',
    description: 'Conception système, Matrix E2EE, LiveKit SFU et décisions techniques.',
    badge: 'Ingénierie',
  },
  {
    id: 'urgence',
    label: '#urgence (BLE)',
    description: 'Continuité hors-ligne Bluetooth Low Energy et pointage sécurité terrain.',
    badge: 'Résilience',
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
