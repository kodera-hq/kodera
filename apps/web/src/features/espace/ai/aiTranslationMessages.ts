// Feature-local FR/EN copy for H3.2 written channel translation and consent-gated live call captions.

export const SUPPORTED_TRANSLATION_LANGUAGES = [
  'fr',
  'en',
  'de',
  'es',
  'it',
  'nl',
  'pt',
  'pl',
] as const

export type SupportedTranslationLanguage = (typeof SUPPORTED_TRANSLATION_LANGUAGES)[number]

export function isSupportedTranslationLanguage(
  value: string
): value is SupportedTranslationLanguage {
  return (SUPPORTED_TRANSLATION_LANGUAGES as readonly string[]).includes(value)
}

export const aiTranslationMessages = {
  fr: {
    menuTranslate: 'Traduire',
    translating: 'Traduction souveraine…',
    sovereignHide: 'Traduit via IA souveraine · Masquer',
    sovereignShow: 'Traduit via IA souveraine · Afficher',
    targetLanguageLabel: 'Langue cible de traduction',
    retry: 'Réessayer',
    forbiddenNotice:
      'Traduction refusée : l’IA souveraine est désactivée (organisation, salon ou consentement membre) ou ce salon est confidentiel.',
    budgetNotice: 'Budget mensuel IA atteint pour cet espace.',
    errorNotice: 'Impossible de traduire ce message pour le moment.',
    languages: {
      fr: 'Français (FR)',
      en: 'Anglais (EN)',
      de: 'Allemand (DE)',
      es: 'Espagnol (ES)',
      it: 'Italien (IT)',
      nl: 'Néerlandais (NL)',
      pt: 'Portugais (PT)',
      pl: 'Polonais (PL)',
    },
    captionsToggle: 'Sous-titres IA',
    captionsRegionLabel: 'Sous-titres en direct',
    captionsConfidentialDisabled: 'Sous-titres IA indisponibles (salon chiffré ou confidentiel)',
    consentPromptTitle: 'Sous-titres et traduction en direct (IA souveraine)',
    consentPromptBody:
      'Les sous-titres sont strictement éphémères, jamais enregistrés, et s’activent uniquement lorsque 100 % des participants à l’appel ont consenti.',
    consentGrant: 'Donner mon consentement IA',
    consentSubmitting: 'Activation…',
    consentWithdraw: 'Retirer mon consentement IA',
    consentWithdrawing: 'Retrait…',
    pausedUnconsented: "En pause : un participant n'a pas consenti",
    awaitingAllConsents: (consented: number, total: number) =>
      `En attente du consentement de tous (${consented}/${total})`,
    stoppedWithdrawn: 'Sous-titres arrêtés : un participant a retiré son consentement.',
    activeLive: 'Sous-titres actifs · 100 % consentis',
    subtitleLanguageLabel: 'Langue des sous-titres',
    dismissBanner: 'Masquer',
    captionsRefused:
      'Sous-titres refusés : vérifiez la politique IA de l’espace, du salon et votre consentement.',
    captionsBudgetExhausted: 'Budget mensuel IA atteint : sous-titres suspendus.',
  },
  en: {
    menuTranslate: 'Translate',
    translating: 'Translating via sovereign AI…',
    sovereignHide: 'Translated via sovereign AI · Hide',
    sovereignShow: 'Translated via sovereign AI · Show',
    targetLanguageLabel: 'Translation target language',
    retry: 'Retry',
    forbiddenNotice:
      'Translation refused: sovereign AI is off (organisation, channel, or member consent) or this room is confidential.',
    budgetNotice: 'Workspace monthly AI budget exhausted.',
    errorNotice: 'Unable to translate this message right now.',
    languages: {
      fr: 'French (FR)',
      en: 'English (EN)',
      de: 'German (DE)',
      es: 'Spanish (ES)',
      it: 'Italian (IT)',
      nl: 'Dutch (NL)',
      pt: 'Portuguese (PT)',
      pl: 'Polish (PL)',
    },
    captionsToggle: 'AI captions',
    captionsRegionLabel: 'Live call captions',
    captionsConfidentialDisabled: 'AI captions unavailable (encrypted or confidential room)',
    consentPromptTitle: 'Live call captions & translation (sovereign AI)',
    consentPromptBody:
      'Captions are strictly ephemeral, never recorded, and activate only when 100% of call participants explicitly consent.',
    consentGrant: 'Grant my AI consent',
    consentSubmitting: 'Enabling…',
    consentWithdraw: 'Withdraw my AI consent',
    consentWithdrawing: 'Withdrawing…',
    pausedUnconsented: 'Paused: a participant has not consented',
    awaitingAllConsents: (consented: number, total: number) =>
      `Awaiting all participant consents (${consented}/${total})`,
    stoppedWithdrawn: 'Captions stopped: a participant withdrew consent.',
    activeLive: 'Live captions active · 100% consented',
    subtitleLanguageLabel: 'Subtitle language',
    dismissBanner: 'Dismiss',
    captionsRefused:
      'Captions refused: check workspace AI policy, channel AI policy, and your consent.',
    captionsBudgetExhausted: 'Monthly AI budget exhausted: captions paused.',
  },
} as const
