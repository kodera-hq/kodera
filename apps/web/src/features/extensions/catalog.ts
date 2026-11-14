export const EXTENSION_SCHEMA_VERSION = 'kodera.extension.v1' as const

export type ExtensionCatalogScope =
  | 'messages:write'
  | 'commands:register'
  | 'webhooks:incoming'
  | 'ephemeral:write'
  | 'channels:read'
  | 'incidents:write'
  | 'threads:write'

export type ExtensionCategory = 'devops' | 'studio' | 'finance' | 'productivity' | 'social'

export type ExtensionCategoryFilter = 'all' | ExtensionCategory

export interface ExtensionCategoryFilterDescriptor {
  readonly id: ExtensionCategoryFilter
  readonly label: string
  readonly labelEn: string
}

export const EXTENSION_CATEGORY_FILTERS: readonly ExtensionCategoryFilterDescriptor[] =
  Object.freeze([
    Object.freeze({ id: 'all', label: 'Toutes', labelEn: 'All' }),
    Object.freeze({ id: 'devops', label: 'DevOps & Code', labelEn: 'DevOps & Code' }),
    Object.freeze({ id: 'studio', label: 'Studio & Production', labelEn: 'Studio & Production' }),
    Object.freeze({ id: 'finance', label: 'Finance (Qonto)', labelEn: 'Finance & Billing' }),
    Object.freeze({
      id: 'productivity',
      label: 'Productivité (Docs / Notion / GDrive)',
      labelEn: 'Productivity & Docs',
    }),
    Object.freeze({
      id: 'social',
      label: 'Réseaux Sociaux (X / Mastodon / Insta)',
      labelEn: 'Social & Community',
    }),
  ])

export type OfficialExtensionId =
  | 'io.kodera.ext.frameio-review-bridge'
  | 'io.kodera.ext.frameio'
  | 'io.kodera.ext.renderfarm'
  | 'io.kodera.ext.hello-webhook'
  | 'io.kodera.ext.github'
  | 'io.kodera.ext.gitlab'
  | 'io.kodera.ext.linear'
  | 'io.kodera.ext.sentry'
  | 'io.kodera.ext.alertmanager'
  | 'io.kodera.ext.rss-advisories'
  | 'io.kodera.ext.release-assistant'
  | 'io.kodera.ext.github-release-notifier'
  | 'io.kodera.ext.uptime-incident-bridge'
  | 'io.kodera.ext.docs-collab-announcer'
  | 'io.kodera.ext.openproject'
  | 'io.kodera.ext.calcom'
  | 'io.kodera.ext.github-repo-tracker'
  | 'io.kodera.ext.qonto-treasury-feed'
  | 'io.kodera.ext.billing-webhooks'
  | 'io.kodera.ext.notion-workspace-bridge'
  | 'io.kodera.ext.gdrive-document-share'
  | 'io.kodera.ext.social-pulse-bridge'

export type OfficialSlashCommand =
  | '/frameio-review'
  | '/dailies'
  | '/render'
  | '/hello'
  | '/gh'
  | '/gitlab'
  | '/linear'
  | '/sentry'
  | '/alerts'
  | '/advisories'
  | '/release-draft'
  | '/release-notes'
  | '/incident'
  | '/doc-pad'
  | '/work'
  | '/schedule'
  | '/github-track'
  | '/qonto-feed'
  | '/billing-ops'
  | '/notion-page'
  | '/gdrive-share'
  | '/social-post'

export interface ExtensionSlashCommandDescriptor {
  readonly name: string
  readonly slashCommand: OfficialSlashCommand
  readonly usage: string
  readonly description: string
  readonly descriptionEn: string
}

export interface OfficialExtensionDescriptor {
  readonly schemaVersion: typeof EXTENSION_SCHEMA_VERSION
  readonly id: OfficialExtensionId
  readonly slug: string
  readonly name: string
  readonly nameEn: string
  readonly version: string
  readonly category: ExtensionCategory
  readonly verifiedManifest: true
  readonly description: string
  readonly descriptionEn: string
  readonly slashCommand: OfficialSlashCommand
  readonly scopes: readonly ExtensionCatalogScope[]
  readonly events: readonly string[]
  readonly commands: readonly ExtensionSlashCommandDescriptor[]
  readonly defaultWebhookExample: string
}

export type ExtensionWebhookErrorCode =
  | 'INVALID_URL'
  | 'SSRF_INSECURE_PROTOCOL'
  | 'SSRF_EMBEDDED_CREDENTIALS'
  | 'SSRF_FORBIDDEN_HOST'
  | 'SSRF_FORBIDDEN_IP'

export type ExtensionWebhookValidationResult =
  | {
      readonly ok: true
      readonly normalizedUrl: string
    }
  | {
      readonly ok: false
      readonly code: ExtensionWebhookErrorCode
      readonly message: string
    }

/**
 * The starters this checkout ships: reference implementations to adapt, each a manifest and a
 * sample command. None is a connector endorsed by the service it names, and listing one here
 * connects no account. What the screen says of them is « implémentations de référence »
 * (`console.onboarding.extensions.*`); the `Official` in these identifiers is only the name the
 * code has had since before that wording, kept because modules outside this feature import it.
 */
export const OFFICIAL_EXTENSIONS_CATALOG: readonly OfficialExtensionDescriptor[] = Object.freeze<
  readonly OfficialExtensionDescriptor[]
>([
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.frameio-review-bridge',
    slug: 'frameio-review-bridge',
    name: 'Frame.io Review Bridge',
    nameEn: 'Frame.io Review Bridge',
    version: '0.1.0',
    category: 'studio',
    verifiedManifest: true,
    description: 'Production review events in #post-production and #dailies-rushes',
    descriptionEn: 'Production review events in #post-production and #dailies-rushes.',
    slashCommand: '/frameio-review',
    scopes: ['messages:write', 'commands:register', 'webhooks:incoming'],
    events: ['asset.ready', 'comment.created', 'review.status_changed'],
    commands: [
      {
        name: 'frameio-review',
        slashCommand: '/frameio-review',
        usage: '/frameio-review https://app.frame.io/reviews/project',
        description: 'Share a production review',
        descriptionEn: 'Share a production review link in the channel.',
      },
    ],
    defaultWebhookExample: 'https://extensions.example.kodera.io/hooks/frameio-review-bridge',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.frameio',
    slug: 'frameio',
    name: 'Frame.io & Timecode Dailies',
    nameEn: 'Frame.io & Timecode Dailies',
    version: '0.1.0',
    category: 'studio',
    verifiedManifest: true,
    description:
      'Commentaires synchronisés au timecode SMPTE, marqueurs de montage et signature HMAC-SHA256 horodatée.',
    descriptionEn:
      'Timecode-synced dailies notes, timeline marker summaries, and timestamped HMAC-SHA256 verification.',
    slashCommand: '/dailies',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'message.created'],
    commands: [
      {
        name: 'dailies',
        slashCommand: '/dailies',
        usage: '/dailies [timecode|otio|reviews|status] [--frame=1800 --fps=24]',
        description: 'Convertit un timecode SMPTE ou inspecte les notes de dailies du montage.',
        descriptionEn: 'Format SMPTE timecodes or inspect active dailies review notes.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/frameio',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.renderfarm',
    slug: 'renderfarm',
    name: 'Supervision Render Farm & VFX',
    nameEn: 'Render Farm & VFX Queue Bridge',
    version: '0.1.0',
    category: 'studio',
    verifiedManifest: true,
    description:
      "Suit les files de rendu 3D et VFX (plages d'images, temps moyen par image, alertes mémoire des nœuds).",
    descriptionEn:
      'Tracks 3D and VFX render queues with shot codes, frame ranges, average frame times, and worker alerts.',
    slashCommand: '/render',
    scopes: [
      'messages:write',
      'incidents:write',
      'threads:write',
      'commands:register',
      'webhooks:incoming',
    ],
    events: ['command.invoked', 'incident.opened', 'incident.resolved', 'ci.workflow_failed'],
    commands: [
      {
        name: 'render',
        slashCommand: '/render',
        usage: '/render [queue|shot|workers|status] [--shot=SH010 --frames=1001-1120]',
        description: "Affiche l'état des files de rendu, d'un plan VFX ou des nœuds de calcul.",
        descriptionEn: 'Inspect render queue status, shot frame progress, or worker nodes.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/renderfarm',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.hello-webhook',
    slug: 'hello-webhook',
    name: 'Hello Webhook (Diagnostic & Echo)',
    nameEn: 'Hello Webhook (Diagnostic & Echo)',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Extension de référence vérifiant la signature HMAC-SHA256 des webhooks entrants et répondant à la commande /hello.',
    descriptionEn:
      'Starter reference verifying incoming HMAC-SHA256 webhook signatures and replying to /hello.',
    slashCommand: '/hello',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'hello',
        slashCommand: '/hello' as const,
        usage: '/hello [message]',
        description: 'Vérifie la connectivité du bot et publie un accusé signé dans le salon.',
        descriptionEn: 'Check bot connectivity and post a signed echo in the channel.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/hello',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.github',
    slug: 'github',
    name: 'Pont GitHub (PR, CI & Triage)',
    nameEn: 'GitHub PR, CI & Triage Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Revues de pull requests en fil dédié, synthèses CI et triage structuré avec vérification HMAC-SHA256.',
    descriptionEn:
      'Threaded pull request reviews, CI workflow summaries, and issue triage with HMAC-SHA256 verification.',
    slashCommand: '/gh',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'release.published', 'ci.workflow_failed', 'message.created'],
    commands: [
      {
        name: 'gh',
        slashCommand: '/gh',
        usage: '/gh [pr|checks|triage|status] <owner/repo>',
        description: 'Inspecte les pull requests, statuts CI ou tickets GitHub du dépôt.',
        descriptionEn: 'Inspect pull requests, CI checks, or triage issues for a GitHub repository.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/github',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.gitlab',
    slug: 'gitlab',
    name: 'Pont GitLab CE & Auto-hébergé',
    nameEn: 'GitLab & Self-Hosted CE Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Suit les merge requests, étapes de pipeline CI/CD et livraisons pour instances GitLab.',
    descriptionEn:
      'Tracks merge requests, CI/CD pipeline stages, and releases across GitLab instances.',
    slashCommand: '/gitlab',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'release.published', 'ci.workflow_failed', 'message.created'],
    commands: [
      {
        name: 'gitlab',
        slashCommand: '/gitlab',
        usage: '/gitlab [mr|pipelines|issues|status] <group/project>',
        description: "Consulte les merge requests et pipelines d'un projet GitLab.",
        descriptionEn: 'Inspect merge requests, pipeline stages, or issues for a GitLab project.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/gitlab',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.linear',
    slug: 'linear',
    name: 'Pont Produit & Cycles Linear',
    nameEn: 'Linear Issue & Cycle Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Synchronise le cycle de vie des tickets, commentaires et bilans de santé projet Linear.',
    descriptionEn:
      'Synchronises issue transitions, comment previews, cycles, and project health updates.',
    slashCommand: '/linear',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'message.created'],
    commands: [
      {
        name: 'linear',
        slashCommand: '/linear',
        usage: '/linear [issue|triage|cycle|project|status]',
        description: 'Inspecte ou trie les tickets et cycles Linear depuis le salon.',
        descriptionEn: 'Inspect or triage Linear issues, cycles, and project updates.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/linear',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.sentry',
    slug: 'sentry',
    name: "Pont d'erreurs Sentry",
    nameEn: 'Sentry Error Alert Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      "Remonte les régressions applicatives et aperçus de pile d'exécution nettoyés en cartes d'incident.",
    descriptionEn:
      'Surfaces application regressions and sanitized stack previews into structured incident cards.',
    slashCommand: '/sentry',
    scopes: [
      'messages:write',
      'incidents:write',
      'threads:write',
      'commands:register',
      'webhooks:incoming',
    ],
    events: ['command.invoked', 'incident.opened', 'incident.resolved', 'message.created'],
    commands: [
      {
        name: 'sentry',
        slashCommand: '/sentry',
        usage: '/sentry [inspect|resolve|status] [--issue=<id>]',
        description: "Examine ou résout une alerte d'erreur applicative Sentry.",
        descriptionEn: 'Inspect, triage, or resolve Sentry application error alerts.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/sentry',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.alertmanager',
    slug: 'alertmanager',
    name: 'Alertes Supervision & Métriques',
    nameEn: 'Monitoring & Metrics Alert Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      "Transforme les alertes d'infrastructure en cartes d'incident corrélées avec validation HTTPS des runbooks.",
    descriptionEn:
      'Transforms infrastructure firing and resolved alerts into threaded incident cards with validated runbooks.',
    slashCommand: '/alerts',
    scopes: [
      'messages:write',
      'incidents:write',
      'threads:write',
      'commands:register',
      'webhooks:incoming',
    ],
    events: ['command.invoked', 'incident.opened', 'incident.resolved', 'message.created'],
    commands: [
      {
        name: 'alerts',
        slashCommand: '/alerts',
        usage: '/alerts [firing|runbooks|status]',
        description: "Liste les alertes actives et vérifie l'acheminement d'astreinte.",
        descriptionEn: 'List firing alerts, inspect runbooks, or check routing status.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/alertmanager',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.rss-advisories',
    slug: 'rss-advisories',
    name: 'Veille Flux & Avis de Sécurité',
    nameEn: 'Security Advisory & Feed Monitor',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Normalise les flux syndiqués et avis de vulnérabilités logicielles avec déduplication bornée.',
    descriptionEn:
      'Normalizes syndicated feeds and upstream dependency security advisories with bounded deduplication.',
    slashCommand: '/advisories',
    scopes: ['messages:write', 'incidents:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'incident.opened', 'release.published', 'message.created'],
    commands: [
      {
        name: 'advisories',
        slashCommand: '/advisories',
        usage: '/advisories [list|sources|status]',
        description: 'Consulte les derniers avis de sécurité des composants suivis.',
        descriptionEn: 'Inspect upstream security advisories and tracked dependency sources.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/rss-advisories',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.release-assistant',
    slug: 'release-assistant',
    name: 'Assistant Notes de Version Bilingue',
    nameEn: 'Opt-In Bilingual Release Assistant',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Génère sur activation par salon des notes de version bilingues déterministes à partir des commits et PR, sans télémétrie.',
    descriptionEn:
      'Opt-in per-room deterministic bilingual release-notes formatter from commits and pull requests with zero telemetry.',
    slashCommand: '/release-draft',
    scopes: ['messages:write', 'ephemeral:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'release.published'],
    commands: [
      {
        name: 'release-draft',
        slashCommand: '/release-draft',
        usage: '/release-draft [draft|opt-in-check|status] [--tag=v1.0.0]',
        description: 'Rédige un brouillon bilingue de notes de version dans un salon autorisé.',
        descriptionEn: 'Generate deterministic bilingual release notes in an opted-in room.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/release-assistant',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.github-release-notifier',
    slug: 'github-release-notifier',
    name: 'Notificateur de versions Git & CI',
    nameEn: 'Git Release & CI Notifier',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      'Publie automatiquement les notes de version et alertes de pipeline CI dans le salon dédié.',
    descriptionEn:
      'Publishes signed release announcements and CI workflow failure alerts to the room.',
    slashCommand: '/release-notes',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['release.published', 'ci.workflow_failed', 'command.invoked']),
    commands: Object.freeze([
      Object.freeze({
        name: 'release-notes',
        slashCommand: '/release-notes' as const,
        usage: '/release-notes [tag]',
        description: 'Affiche la dernière version publiée et le statut du pipeline associé.',
        descriptionEn: 'Preview the latest published tag and associated CI status.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/releases',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.uptime-incident-bridge',
    slug: 'uptime-incident-bridge',
    name: "Pont d'incidents & supervision",
    nameEn: 'Uptime & Incident Bridge',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      "Relie les sondes de disponibilité aux salons d'astreinte avec cartes d'incident structurées.",
    descriptionEn:
      'Connects availability probes to on-call rooms with structured incident lifecycle cards.',
    slashCommand: '/incident',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
      'incidents:write',
    ]),
    events: Object.freeze([
      'incident.opened',
      'incident.acknowledged',
      'incident.resolved',
      'command.invoked',
    ]),
    commands: Object.freeze([
      Object.freeze({
        name: 'incident',
        slashCommand: '/incident' as const,
        usage: '/incident [open|ack|resolve] <titre>',
        description: "Déclare, acquitte ou résout un incident d'exploitation dans le salon.",
        descriptionEn: 'Declare, acknowledge, or resolve an operational incident in the room.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/incidents',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.docs-collab-announcer',
    slug: 'docs-collab-announcer',
    name: 'Annonceur de pads collaboratifs Docs',
    nameEn: 'Collaborative Docs Pad Announcer',
    version: '0.1.0',
    category: 'productivity',
    verifiedManifest: true,
    description:
      'Partage et épingle les documents collaboratifs Docs directement depuis une commande slash.',
    descriptionEn:
      'Shares and pins collaborative Docs pads directly from a slash command.',
    slashCommand: '/doc-pad',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'doc-pad',
        slashCommand: '/doc-pad' as const,
        usage: '/doc-pad <titre-du-document>',
        description: 'Crée ou annonce un pad collaboratif Docs lié au salon courant.',
        descriptionEn: 'Create or announce a collaborative Docs pad linked to the current room.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/docs-collab',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.openproject',
    slug: 'openproject',
    name: 'Suivi de Travaux & Sprints',
    nameEn: 'Sovereign Work & Sprint Bridge',
    version: '0.1.0',
    category: 'productivity',
    verifiedManifest: true,
    description:
      'Unifie les lots de travaux et tickets de sprint en cartes chronologiques avec validation HTTPS anti-SSRF.',
    descriptionEn:
      'Normalizes work packages and sprint tickets into unified timeline cards with anti-SSRF link checks.',
    slashCommand: '/work',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'message.created'],
    commands: [
      {
        name: 'work',
        slashCommand: '/work',
        usage: '/work [inspect|sprint|triage|status] [--key=OP-1042]',
        description: "Inspecte un lot de travaux, un ticket ou l'avancement du sprint actif.",
        descriptionEn: 'Inspect work packages, sprint timelines, or triage item status.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/openproject',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.calcom',
    slug: 'calcom',
    name: 'Planification & Salons Vocaux',
    nameEn: 'Scheduling & Voice Room Bridge',
    version: '0.1.0',
    category: 'productivity',
    verifiedManifest: true,
    description:
      'Publie les créneaux réservés validés en UTC avec accès direct vers le salon vocal Kodera dédié.',
    descriptionEn:
      'Posts UTC-validated booking cards with a one-click jump action to the designated Kodera voice room.',
    slashCommand: '/schedule',
    scopes: ['messages:write', 'threads:write', 'commands:register', 'webhooks:incoming'],
    events: ['command.invoked', 'message.created'],
    commands: [
      {
        name: 'schedule',
        slashCommand: '/schedule',
        usage: '/schedule [upcoming|room|booking|status] [--room=office-hours]',
        description: 'Consulte les prochains créneaux ou associe un salon vocal Kodera.',
        descriptionEn: 'Inspect upcoming booking windows or link a target Kodera voice room.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/calcom',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.github-repo-tracker',
    slug: 'github-repo-tracker',
    name: 'Suivi de dépôt GitHub (Issues, PR, CI & Sécurité)',
    nameEn: 'GitHub Repository Tracker (Issues, PR & CI)',
    version: '0.1.0',
    category: 'devops',
    verifiedManifest: true,
    description:
      "Suit l'activité d'un dépôt GitHub (issues, pull requests, workflow runs, releases, avis de sécurité) dans le salon.",
    descriptionEn:
      'Tracks GitHub repository activity (issues, pull requests, CI runs, releases, advisories) in the room.',
    slashCommand: '/github-track',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze([
      'command.invoked',
      'message.created',
      'release.published',
      'ci.workflow_failed',
    ]),
    commands: Object.freeze([
      Object.freeze({
        name: 'github-track',
        slashCommand: '/github-track' as const,
        usage: '/github-track <owner/repo> [--events=issues,pull_requests,security_advisories]',
        description: "Configure ou affiche le suivi d'un dépôt GitHub (owner/repo) dans le salon.",
        descriptionEn: 'Configure or inspect tracking for a GitHub repository in the room.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/github-track',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.qonto-treasury-feed',
    slug: 'qonto-treasury-feed',
    name: 'Flux de trésorerie Qonto (IBAN masqué)',
    nameEn: 'Qonto Treasury Feed (Masked IBAN)',
    version: '0.1.0',
    category: 'finance',
    verifiedManifest: true,
    description:
      'Suit les mouvements bancaires Qonto (virements, justificatifs manquants, seuils de dépense) avec masquage déterministe des IBAN.',
    descriptionEn:
      'Tracks Qonto treasury movements, missing receipts, and spend thresholds with deterministic IBAN masking.',
    slashCommand: '/qonto-feed',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'qonto-feed',
        slashCommand: '/qonto-feed' as const,
        usage: '/qonto-feed [status|alerts|threshold|missing-invoices]',
        description:
          'Consulte le flux de trésorerie Qonto, les seuils de dépense ou les justificatifs manquants.',
        descriptionEn: 'Check Qonto treasury status, spend alerts, or missing invoice receipts.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/qonto-feed',
  }),
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.billing-webhooks',
    slug: 'billing-webhooks',
    name: 'Facturation & Quotas (Sans Données Personnelles)',
    nameEn: 'Billing & Quota Ops Webhooks (PII-Redacted)',
    version: '0.1.0',
    category: 'finance',
    verifiedManifest: true,
    description:
      "Achemine l'état des factures, abonnements et quotas vers les salons d'exploitation autorisés en supprimant toute coordonnée client ou carte.",
    descriptionEn:
      'Routes invoice, subscription, and quota alerts to authorized ops rooms while stripping all customer PII and card data.',
    slashCommand: '/billing-ops',
    scopes: [
      'messages:write',
      'ephemeral:write',
      'incidents:write',
      'commands:register',
      'webhooks:incoming',
    ],
    events: ['command.invoked', 'incident.opened'],
    commands: [
      {
        name: 'billing-ops',
        slashCommand: '/billing-ops',
        usage: '/billing-ops [summary|quotas|policy|status] [--workspace=<slug>]',
        description:
          "Vérifie le palier d'abonnement ou les seuils de quotas sans exposer de données personnelles.",
        descriptionEn:
          'Inspect redacted workspace plan, invoice status, or quota thresholds in ops rooms.',
      },
    ],
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/billing-webhooks',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.notion-workspace-bridge',
    slug: 'notion-workspace-bridge',
    name: 'Pont Notion Workspace & Bases de données',
    nameEn: 'Notion Workspace & Database Bridge',
    version: '0.1.0',
    category: 'productivity',
    verifiedManifest: true,
    description:
      'Partage et synchronise les pages et entrées de bases Notion dans un salon aux côtés de Docs.',
    descriptionEn:
      'Shares and synchronises Notion workspace pages and database entries alongside Docs.',
    slashCommand: '/notion-page',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'notion-page',
        slashCommand: '/notion-page' as const,
        usage: '/notion-page [share|sync|database] --page=<id> --title=<titre>',
        description: 'Partage ou synchronise une page ou base Notion aux côtés de Docs.',
        descriptionEn: 'Share or sync a Notion page or database entry alongside Docs.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/notion-bridge',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.gdrive-document-share',
    slug: 'gdrive-document-share',
    name: 'Partage Google Drive (Fichiers & Dossiers)',
    nameEn: 'Google Drive Document & Folder Share',
    version: '0.1.0',
    category: 'productivity',
    verifiedManifest: true,
    description:
      "Partage des fichiers et dossiers Google Drive avec badges de droits d'accès (lecture, commentaire, édition) et validation HTTPS anti-SSRF.",
    descriptionEn:
      'Shares Google Drive files and folders with access permission badges and anti-SSRF HTTPS validation.',
    slashCommand: '/gdrive-share',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'gdrive-share',
        slashCommand: '/gdrive-share' as const,
        usage: '/gdrive-share [lecture|commentaire|édition] --id=<fileId> --title=<titre>',
        description:
          'Partage un fichier ou dossier Google Drive avec badge de permission structuré.',
        descriptionEn: 'Share a Google Drive file or folder with a structured permission badge.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/gdrive-share',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.social-pulse-bridge',
    slug: 'social-pulse-bridge',
    name: 'Veille & Syndication Sociale (X, Mastodon, Instagram)',
    nameEn: 'Social Syndication Bridge (X, Mastodon, Instagram)',
    version: '0.1.0',
    category: 'social',
    verifiedManifest: true,
    description:
      'Diffuse les publications X / Twitter, Mastodon / Fédiverse et Instagram sans pixel tiers et supprime automatiquement les paramètres de pistage.',
    descriptionEn:
      'Syndicates X, Mastodon, and Instagram posts with zero third-party pixels and automatic tracking-parameter removal.',
    slashCommand: '/social-post',
    scopes: Object.freeze<readonly ExtensionCatalogScope[]>([
      'messages:write',
      'commands:register',
      'webhooks:incoming',
    ]),
    events: Object.freeze(['command.invoked', 'message.created']),
    commands: Object.freeze([
      Object.freeze({
        name: 'social-post',
        slashCommand: '/social-post' as const,
        usage: '/social-post --url=<https://...> [--network=x|mastodon|instagram]',
        description:
          'Partage une publication X / Twitter, Mastodon / Fédiverse ou Instagram nettoyée de tout pistage.',
        descriptionEn: 'Share a tracking-stripped X, Mastodon, or Instagram post in the room.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/social-pulse',
  }),
])

export const OFFICIAL_EXTENSIONS: readonly OfficialExtensionDescriptor[] =
  OFFICIAL_EXTENSIONS_CATALOG

function isForbiddenIpv4Octets(a: number, b: number, c: number, _d: number): boolean {
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

function parseIpv4Literal(host: string): readonly [number, number, number, number] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const parts = host.split('.').map((segment) => Number(segment))
  if (parts.length !== 4) return null
  for (const part of parts) {
    if (!Number.isInteger(part) || part < 0 || part > 255) return null
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

function expandIpv6Groups(ipv6: string): readonly number[] | null {
  let addr = ipv6
  if (addr.includes('%')) return null

  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4Octets = parseIpv4Literal(addr.slice(lastColon + 1))
    if (v4Octets === null) return null
    const high = ((v4Octets[0] << 8) | v4Octets[1]).toString(16)
    const low = ((v4Octets[2] << 8) | v4Octets[3]).toString(16)
    addr = `${addr.slice(0, lastColon)}:${high}:${low}`
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0
  if ((halves.length === 1 && left.length !== 8) || missing < 0) {
    return null
  }
  const full = [...left, ...Array<string>(missing).fill('0'), ...right]
  if (full.length !== 8) return null

  const groups: number[] = []
  for (const part of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}

function isForbiddenIpv6Address(unbracketedHost: string): boolean {
  const groups = expandIpv6Groups(unbracketedHost)
  if (groups === null) return true

  const g0 = groups[0]!
  const g1 = groups[1]!
  const g2 = groups[2]!
  const g3 = groups[3]!
  const g4 = groups[4]!
  const g5 = groups[5]!
  const g6 = groups[6]!
  const g7 = groups[7]!

  const isAllZeroTop80 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0

  // Unspecified :: or Loopback ::1
  if (isAllZeroTop80 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true
  }

  // IPv4-mapped ::ffff:w.x.y.z or IPv4-compatible ::w.x.y.z
  if (isAllZeroTop80 && (g5 === 0xffff || g5 === 0x0000)) {
    const a = (g6 >> 8) & 0xff
    const b = g6 & 0xff
    const c = (g7 >> 8) & 0xff
    const d = g7 & 0xff
    if (isForbiddenIpv4Octets(a, b, c, d)) return true
  }

  // NAT64 64:ff9b::/96 or 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b) {
    const a = (g6 >> 8) & 0xff
    const b = g6 & 0xff
    const c = (g7 >> 8) & 0xff
    const d = g7 & 0xff
    if (isForbiddenIpv4Octets(a, b, c, d)) return true
  }

  // Unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8, doc 2001:db8::/32
  if ((g0 & 0xfe00) === 0xfc00) return true
  if ((g0 & 0xffc0) === 0xfe80) return true
  if ((g0 & 0xff00) === 0xff00) return true
  if (g0 === 0x2001 && g1 === 0x0db8) return true

  return false
}

/**
 * Pure HTTPS & anti-SSRF validator for Kodera extension webhook endpoints,
 * matching `@kodera/extension-sdk` (`https:` only, no embedded credentials,
 * no localhost/loopback/RFC1918/link-local/CGNAT/ULA targets).
 */
export function validateExtensionWebhookUrl(rawUrl: string): ExtensionWebhookValidationResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || /\s/.test(rawUrl.trim())) {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: "L'URL du webhook doit être une adresse HTTPS complète et valide.",
    }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: "Format d'URL de webhook invalide.",
    }
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'SSRF_INSECURE_PROTOCOL',
      message: 'Protocole non sécurisé refusé : seul https:// est autorisé pour les webhooks.',
    }
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      code: 'SSRF_EMBEDDED_CREDENTIALS',
      message: "Les identifiants intégrés (user:pass@) sont interdits dans l'URL du webhook.",
    }
  }

  const rawHost = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (rawHost.length === 0) {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: "L'URL du webhook doit comporter un nom d'hôte valide.",
    }
  }

  if (rawHost.includes('%')) {
    return {
      ok: false,
      code: 'SSRF_FORBIDDEN_IP',
      message: "Les identifiants de zone IPv6 sont interdits dans l'URL du webhook.",
    }
  }

  const unbracketedHost =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost

  if (
    unbracketedHost === 'localhost' ||
    unbracketedHost.endsWith('.localhost') ||
    unbracketedHost.endsWith('.local') ||
    unbracketedHost.endsWith('.internal') ||
    unbracketedHost.endsWith('.arpa')
  ) {
    return {
      ok: false,
      code: 'SSRF_FORBIDDEN_HOST',
      message: `Hôte local ou interne interdit (${unbracketedHost}).`,
    }
  }

  if (rawHost.startsWith('[') || unbracketedHost.includes(':')) {
    if (isForbiddenIpv6Address(unbracketedHost)) {
      return {
        ok: false,
        code: 'SSRF_FORBIDDEN_IP',
        message: 'Adresse IPv6 privée, loopback ou link-local interdite (protection SSRF).',
      }
    }
    return { ok: true, normalizedUrl: parsed.toString() }
  }

  const ipv4Octets = parseIpv4Literal(unbracketedHost)
  if (ipv4Octets !== null) {
    if (isForbiddenIpv4Octets(ipv4Octets[0], ipv4Octets[1], ipv4Octets[2], ipv4Octets[3])) {
      return {
        ok: false,
        code: 'SSRF_FORBIDDEN_IP',
        message: 'Plage IPv4 privée, loopback, link-local ou réservée interdite (protection SSRF).',
      }
    }
    return { ok: true, normalizedUrl: parsed.toString() }
  }

  if (!unbracketedHost.includes('.')) {
    return {
      ok: false,
      code: 'SSRF_FORBIDDEN_HOST',
      message: 'Nom DNS interne mono-label interdit.',
    }
  }

  const labels = unbracketedHost.split('.')
  const tld = labels[labels.length - 1]
  if (
    tld === undefined ||
    tld.length < 2 ||
    !/^[a-z]+$/.test(tld) ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith('-') ||
        label.endsWith('-') ||
        !/^[a-z0-9-]+$/.test(label)
    )
  ) {
    return {
      ok: false,
      code: 'SSRF_FORBIDDEN_HOST',
      message: "Nom d'hôte DNS invalide ou non routable publiquement.",
    }
  }

  return { ok: true, normalizedUrl: parsed.toString() }
}

export function isAllowedExtensionWebhookUrl(url: string): boolean {
  return validateExtensionWebhookUrl(url).ok
}
