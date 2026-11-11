const messages = {
  en: {
    title: 'Community & Support',
    body: 'Join the support conversation or send a private request to the Kodera team.',
    join: 'Join support in Kodera Community (#support)',
    subject: 'Subject',
    description: 'How can we help?',
    privacy: 'Do not include passwords, access tokens, or sensitive personal information.',
    send: 'Send a support request',
    pending: 'Sending your request…',
    success: 'Your request has been received.',
    ticket: 'Ticket',
    priority: 'Priority',
    error: 'The request could not be completed. Please try again.',
    limited: 'Too many requests. Please wait before trying again.',
    unavailable: 'Community support is not available yet. You can still contact us by email.',
  },
  fr: {
    title: 'Communauté & Support',
    body: 'Rejoignez le salon de support ou envoyez une demande privée à l’équipe Kodera.',
    join: 'Joindre le support dans Kodera Community (#support)',
    subject: 'Objet',
    description: 'Comment pouvons-nous vous aider ?',
    privacy: 'N’incluez aucun mot de passe, jeton d’accès ou renseignement personnel sensible.',
    send: 'Envoyer une demande de support',
    pending: 'Envoi de votre demande…',
    success: 'Votre demande a bien été reçue.',
    ticket: 'Ticket',
    priority: 'Priorité',
    error: 'La demande n’a pas pu aboutir. Réessayez.',
    limited: 'Trop de demandes. Patientez avant de réessayer.',
    unavailable:
      'Le support communautaire n’est pas encore disponible. Vous pouvez nous écrire par e-mail.',
  },
} as const
export const communitySupportCopy = (language: string | undefined) =>
  language?.startsWith('en') ? messages.en : messages.fr
