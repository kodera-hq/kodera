/** Shared copy for browser-local simulations. */
export const demoMessages = {
  en: {
    title: 'Interactive browser-local simulation',
    body: 'Local session only — nothing is sent to a server or seen by others.',
    support: 'Real support:',
    composer:
      'Simulated message · saved only in this browser session (sessionStorage). No support ticket is created.',
    placeholder: 'Try a local simulated message…',
    presence: 'Simulated presence',
    roster: 'Demo members · simulated presence',
  },
  fr: {
    title: 'Simulation interactive locale au navigateur',
    body: 'Session locale uniquement — rien n’est envoyé au serveur ni vu par d’autres.',
    support: 'Support réel :',
    composer:
      'Message simulé · conservé uniquement dans cette session du navigateur (sessionStorage). Aucun ticket de support n’est créé.',
    placeholder: 'Essayez un message simulé local…',
    presence: 'Présence simulée',
    roster: 'Membres de démonstration · présence simulée',
  },
} as const
