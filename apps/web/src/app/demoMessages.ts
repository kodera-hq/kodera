/** Shared copy for browser-local simulations. */
export const demoMessages = {
  en: {
    title: 'Interactive browser-local simulation',
    body: 'Messages and changes stay only in this browser session. They are never sent to a server or seen by other participants.',
    support: 'Real product or support questions:',
    composer:
      'Simulated message · saved only in this browser session (sessionStorage). No support ticket is created.',
    placeholder: 'Try a local simulated message…',
    presence: 'Simulated presence',
    roster: 'Demo members · simulated presence',
  },
  fr: {
    title: 'Simulation interactive locale au navigateur',
    body: 'Les messages et modifications restent uniquement dans cette session du navigateur. Ils ne sont jamais envoyés à un serveur ni vus par les autres participants.',
    support: 'Questions réelles sur le produit ou le support :',
    composer:
      'Message simulé · conservé uniquement dans cette session du navigateur (sessionStorage). Aucun ticket de support n’est créé.',
    placeholder: 'Essayez un message simulé local…',
    presence: 'Présence simulée',
    roster: 'Membres de démonstration · présence simulée',
  },
} as const
