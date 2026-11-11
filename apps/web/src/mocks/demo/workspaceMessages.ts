import { SUPPORT_EMAIL } from '../../app/supportContact'

/** Copy for the local demonstration conversation. */
export const workspaceDemoMessages = {
  fr: {
    reviewTitle: 'Revue du guide communautaire',
    reviewContent:
      '## Avant de partager\n- [x] Relire le guide\n- [ ] Vérifier les accès\n\nUne version pour toute l’équipe.',
    reviewQuote: 'Vérifier les accès',
    claireReview:
      'Ajoutons une vérification des accès avant de partager le guide avec les nouveaux membres.',
    elenaReview: 'La structure est claire. Je peux relire la checklist après la mise à jour.',
    claireTime: 'Il y a 12 min',
    elenaTime: 'Il y a 5 min',
    welcome:
      'Bienvenue dans cet espace de démonstration. Essayez une conversation simulée ou ouvrez Docs ; les modifications restent dans cette session du navigateur.',
    community: {
      announcements: [
        'Exemple simulé d’annonces et de notes de version dans Kodera Community. Ce salon ne diffuse pas d’annonces officielles.',
        `Simulation locale : essayez un échange dans #support. Pour toute question réelle sur le produit, écrivez à ${SUPPORT_EMAIL}.`,
      ],
      'developers-community': [
        'Bienvenue ! Partagez ici vos questions de développement, d’architecture et d’API.',
        'Pour une proposition de contrat, joignez un exemple de requête et de réponse ; nous pouvons discuter des limites du control plane avant la revue.',
      ],
      support: [
        `Exemple simulé de support produit : aucun ticket n’est créé ni transmis. Pour une demande réelle, écrivez à ${SUPPORT_EMAIL}.`,
        'Exemple de parcours de triage, sans automatisation active : les messages restent dans cette session du navigateur (sessionStorage), sans être vus par une équipe de support.',
      ],
      extensions: [
        'Bienvenue dans le salon SDK TypeScript, webhooks signés et connecteurs Frame.io, GitHub et Qonto.',
        'Pour tester une intégration, utilisez un payload synthétique et vérifiez la signature HMAC, l’horodatage et la protection antirejeu avant le routage.',
      ],
      'self-hosting': [
        'Bienvenue ! Parlons Docker Compose, npx create-kodera et fournisseur OIDC externe.',
        'Commencez par un dry-run de configuration. Le registre public de confiance OIDC reste sous le contrôle de votre opérateur ; ne partagez jamais vos clés privées.',
      ],
      'show-and-tell': [
        'Bienvenue ! Présentez vos créations, extensions et intégrations à la communauté.',
        'Un court scénario, une capture et un lien vers le code suffisent pour lancer une discussion et recueillir des retours utiles.',
      ],
      dev: [
        'Bienvenue dans le salon privé d’ingénierie de l’équipe cœur Kodera.',
        'La revue couvre la CI/CD, les invariants du noyau Rust et le control plane ; ajoutez les preuves de tests à chaque modification de contrat.',
      ],
      strategy: [
        'Bienvenue dans le salon privé produit, roadmap et go-to-market.',
        'Pour le prochain arbitrage, séparons les besoins des partenaires, les critères d’acceptation et les limites déjà visibles dans le produit.',
      ],
      'ops-oncall': [
        'Bienvenue dans le salon privé infrastructure, Keycloak et monitoring.',
        'Avant toute intervention, vérifiez les alertes, l’issuer OIDC concerné et les procédures opérateur. Conservez les secrets hors des conversations.',
      ],
      'partner-dinum': [
        'Bienvenue dans la boucle de feedback privée DINUM / La Suite.',
        'Exemple de message depuis Element, client Matrix standard : notre équipe DINUM souhaite retrouver le même fil de feedback dans Element et dans le Workspace Kodera, sans recopier la conversation.',
      ],
      'partner-octo': [
        'Bienvenue dans la boucle de feedback privée OCTO.',
        'Exemple de message envoyé avec Element via Matrix : côté OCTO, nous pouvons suivre les réponses et le même historique du salon partenaire depuis un client Matrix standard ou le Workspace Kodera.',
      ],
    },
    viewer: 'Inès Kaci',
  },
  en: {
    reviewTitle: 'Community guide review',
    reviewContent:
      '## Before sharing\n- [x] Review the guide\n- [ ] Check access\n\nOne version for the whole team.',
    reviewQuote: 'Check access',
    claireReview: 'Let’s add an access check before sharing the guide with new members.',
    elenaReview: 'The structure looks clear. I can review the checklist after the update.',
    claireTime: '12 min ago',
    elenaTime: '5 min ago',
    welcome:
      'Welcome to this demo workspace. Try a simulated conversation or open Docs; changes stay in this browser session.',
    community: {
      announcements: [
        'Simulated example of announcements and release notes in Kodera Community. This channel does not publish official announcements.',
        `Local simulation: try a conversation in #support. For real product questions, email ${SUPPORT_EMAIL}.`,
      ],
      'developers-community': [
        'Welcome! Ask development, architecture and API questions here.',
        'For a contract proposal, include a request and response example so we can discuss control-plane boundaries before review.',
      ],
      support: [
        `Simulated product support example: no ticket is created or sent. For a real request, email ${SUPPORT_EMAIL}.`,
        'Example triage workflow, with no active automation: messages stay in this browser session (sessionStorage) and are not seen by a support team.',
      ],
      extensions: [
        'Welcome to TypeScript SDK, signed webhooks and Frame.io, GitHub and Qonto connectors.',
        'Use a synthetic payload to test an integration, checking the HMAC signature, timestamp and replay protection before routing.',
      ],
      'self-hosting': [
        'Welcome! Discuss Docker Compose, npx create-kodera and your external OIDC provider.',
        'Start with a configuration dry run. Your operator owns the public OIDC trust registry; never share private keys here.',
      ],
      'show-and-tell': [
        'Welcome! Share your creations, extensions and integrations with the community.',
        'A short scenario, a screenshot and a source link are enough to start a useful feedback discussion.',
      ],
      dev: [
        'Welcome to the private engineering channel for the Kodera core team.',
        'Review CI/CD, Rust core invariants and the control plane, and attach test evidence to each contract change.',
      ],
      strategy: [
        'Welcome to the private product, roadmap and go-to-market channel.',
        'For the next decision, distinguish partner needs, acceptance criteria and the limits already visible in the product.',
      ],
      'ops-oncall': [
        'Welcome to the private infrastructure, Keycloak and monitoring channel.',
        'Before an intervention, check alerts, the affected OIDC issuer and operator procedures. Keep secrets out of conversations.',
      ],
      'partner-dinum': [
        'Welcome to the private DINUM / La Suite feedback loop.',
        'Example message from Element, a standard Matrix client: our DINUM team wants to follow the same feedback thread in Element and the Kodera Workspace without copying the conversation.',
      ],
      'partner-octo': [
        'Welcome to the private OCTO feedback loop.',
        'Example message sent with Element over Matrix: OCTO can follow replies and the same partner-room history from a standard Matrix client or the Kodera Workspace.',
      ],
    },
    viewer: 'Inès Kaci',
  },
} as const
