// Localized fr/en copy for channel and live-call polls.

export type PollLocale = 'fr' | 'en'

export const pollMessages = {
  fr: {
    statusOpen: 'Sondage en cours',
    statusClosed: 'Sondage clôturé',
    modeMultiple: 'Choix multiple',
    modeSingle: 'Choix unique',
    anonymousBadge: 'Vote anonyme',
    createdBy: (name: string, votes: number, participants: number) =>
      `Proposé par ${name} • ${votes} vote(s) • ${participants} participant(s)`,
    expand: 'Développer ▾',
    collapse: 'Réduire ▴',
    optionStat: (count: number, pct: number) => `${count} vote(s) · ${pct} %`,
    closeAction: 'Clôturer le sondage',
    copyDocsAction: 'Copier le résumé pour Docs',
    copiedStatus: 'Résumé Markdown prêt pour Docs',
    callOverlayBadge: (count: number) =>
      count > 1 ? `${count} sondages actifs` : 'Sondage en cours',
    callOverlayShow: 'Afficher le sondage',
    callOverlayHide: 'Masquer le sondage',
    pillBadgeLabel: (question: string) => `Sondage actif : ${question}`,
    errNotPoll: 'La commande doit commencer par /poll.',
    errUsage: 'Usage : /poll "Question ?" "Option A" "Option B" [--multiple] [--anonymous]',
    errUnclosedQuote: 'Guillemet non refermé dans la commande /poll.',
    errMinOptions: 'Un sondage requiert une question et au moins 2 options.',
    errEmptyQuestionOrOptions:
      'Un sondage requiert une question valide et au moins 2 options non vides.',
    errConfidentialForbidden:
      'Les sondages en clair sont désactivés dans les salons confidentiels chiffrés.',
    errSendFailed: 'Impossible de publier le sondage dans ce salon.',
    mdHeading: (question: string) => `### Sondage Kodera : ${question}`,
    mdStatusLine: (status: string, mode: string, anon: string) =>
      `- **Statut** : ${status} (${mode} · ${anon})`,
    mdStatusOpen: 'En cours',
    mdStatusClosed: 'Clôturé',
    mdNamedVote: 'Vote nominatif',
    mdParticipation: (votes: number, participants: number) =>
      `- **Participation** : ${votes} vote(s) (${participants} participant(s))`,
    mdOptionLine: (label: string, count: number, pct: number) =>
      `- **${label}** : ${count} vote(s) (${pct} %)`,
  },
  en: {
    statusOpen: 'Active poll',
    statusClosed: 'Poll closed',
    modeMultiple: 'Multiple choice',
    modeSingle: 'Single choice',
    anonymousBadge: 'Anonymous vote',
    createdBy: (name: string, votes: number, participants: number) =>
      `Created by ${name} • ${votes} vote(s) • ${participants} participant(s)`,
    expand: 'Expand ▾',
    collapse: 'Collapse ▴',
    optionStat: (count: number, pct: number) => `${count} vote(s) · ${pct}%`,
    closeAction: 'Close poll',
    copyDocsAction: 'Copy summary for Docs',
    copiedStatus: 'Markdown summary ready for Docs',
    callOverlayBadge: (count: number) => (count > 1 ? `${count} active polls` : 'Active poll'),
    callOverlayShow: 'Show poll',
    callOverlayHide: 'Hide poll',
    pillBadgeLabel: (question: string) => `Active poll: ${question}`,
    errNotPoll: 'Command must start with /poll.',
    errUsage: 'Usage: /poll "Question?" "Option A" "Option B" [--multiple] [--anonymous]',
    errUnclosedQuote: 'Unclosed quote in /poll command.',
    errMinOptions: 'A poll requires a question and at least 2 options.',
    errEmptyQuestionOrOptions: 'A poll requires a valid question and at least 2 non-empty options.',
    errConfidentialForbidden: 'Plaintext polls are disabled in confidential encrypted rooms.',
    errSendFailed: 'Unable to publish the poll in this room.',
    mdHeading: (question: string) => `### Kodera Poll: ${question}`,
    mdStatusLine: (status: string, mode: string, anon: string) =>
      `- **Status**: ${status} (${mode} · ${anon})`,
    mdStatusOpen: 'Open',
    mdStatusClosed: 'Closed',
    mdNamedVote: 'Named vote',
    mdParticipation: (votes: number, participants: number) =>
      `- **Participation**: ${votes} vote(s) (${participants} participant(s))`,
    mdOptionLine: (label: string, count: number, pct: number) =>
      `- **${label}**: ${count} vote(s) (${pct}%)`,
  },
} as const
