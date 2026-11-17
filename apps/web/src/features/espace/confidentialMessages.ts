/** User-facing room security copy; policy metadata never implies authenticated encryption. */
export const confidentialMessages = {
  en: {
    unknown: 'Room protection unavailable',
    ordinary: 'Workspace · not end-to-end encrypted',
    community: 'Community · public room · not end-to-end encrypted',
    'confidential-unavailable': 'Confidential · keys unavailable',
    invalid: 'Confidential protection could not be verified',
    unavailable:
      'This device cannot open a verified encryption session for this room. Messages and files cannot be sent. No plaintext fallback is allowed.',
    'media-encryption-unavailable':
      'Encrypted media is unavailable for this room. No call was started.',
    'media-transforms-unavailable':
      'This browser cannot encrypt calls. Use a browser with encoded media transform support.',
    'media-encryption-revoked': 'Call protection changed. The call ended and capture stopped.',
    checking: 'Waiting for the room’s protection state before showing or sending messages.',
  },
  fr: {
    unknown: 'Protection du salon indisponible',
    ordinary: 'Espace de travail · sans chiffrement de bout en bout',
    community: 'Communauté · salon public · sans chiffrement de bout en bout',
    'confidential-unavailable': 'Confidentiel · clés indisponibles',
    invalid: 'La protection confidentielle n’a pas pu être vérifiée',
    unavailable:
      'Cet appareil ne peut pas ouvrir de session chiffrée vérifiée pour ce salon. L’envoi de messages et de fichiers est bloqué. Aucun envoi en clair n’est autorisé.',
    'media-encryption-unavailable':
      'Le chiffrement des appels est indisponible pour ce salon. Aucun appel n’a démarré.',
    'media-transforms-unavailable':
      'Ce navigateur ne peut pas chiffrer les appels. Utilisez un navigateur compatible avec les transformations de médias encodés.',
    'media-encryption-revoked':
      'La protection de l’appel a changé. L’appel et la capture ont été arrêtés.',
    checking: 'Vérification de la protection du salon avant d’afficher ou d’envoyer des messages.',
  },
} as const
