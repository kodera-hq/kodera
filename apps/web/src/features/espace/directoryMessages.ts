export const directoryMessages = {
  en: {
    hint: 'Search also includes people your server makes discoverable.',
    result: 'Directory result',
    label: 'People found',
    unavailable: 'Directory search is unavailable. Known channel members remain searchable.',
    e2eeLabel: 'End-to-end encrypted conversation',
    e2eeHelp:
      'Enabled by default for 1:1 and private group direct messages (MLS, SFrame, local search).',
  },
  fr: {
    hint: 'La recherche inclut aussi les personnes que votre serveur permet de découvrir.',
    result: 'Résultat de l’annuaire',
    label: 'Personnes trouvées',
    unavailable:
      'La recherche dans l’annuaire est indisponible. Les membres connus des salons restent accessibles.',
    e2eeLabel: 'Conversation chiffrée de bout en bout',
    e2eeHelp:
      'Activé par défaut pour les messages directs 1:1 et de groupe privé (MLS, SFrame, recherche locale).',
  },
} as const
