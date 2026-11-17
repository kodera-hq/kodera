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
    checking: 'Vérification de la protection du salon avant d’afficher ou d’envoyer des messages.',
  },
} as const
