export const EXTENSION_SCHEMA_VERSION = 'kodera.extension.v1' as const

export type ExtensionCatalogScope =
  | 'messages:write'
  | 'commands:register'
  | 'webhooks:incoming'
  | 'ephemeral:write'
  | 'channels:read'
  | 'incidents:write'
  | 'threads:write'

export type ExtensionCategory = 'devops' | 'finance' | 'productivity' | 'social'

export type ExtensionCategoryFilter = 'all' | ExtensionCategory

export interface ExtensionCategoryFilterDescriptor {
  readonly id: ExtensionCategoryFilter
  readonly label: string
}

export const EXTENSION_CATEGORY_FILTERS: readonly ExtensionCategoryFilterDescriptor[] =
  Object.freeze([
    Object.freeze({ id: 'all', label: 'Toutes' }),
    Object.freeze({ id: 'devops', label: 'DevOps & Code' }),
    Object.freeze({ id: 'finance', label: 'Finance (Qonto)' }),
    Object.freeze({ id: 'productivity', label: 'Productivité (Docs / Notion / GDrive)' }),
    Object.freeze({ id: 'social', label: 'Réseaux Sociaux (X / Mastodon / Insta)' }),
  ])

export type OfficialExtensionId =
  | 'io.kodera.ext.frameio-review-bridge'
  | 'io.kodera.ext.hello-webhook'
  | 'io.kodera.ext.github-release-notifier'
  | 'io.kodera.ext.uptime-incident-bridge'
  | 'io.kodera.ext.docs-collab-announcer'
  | 'io.kodera.ext.github-repo-tracker'
  | 'io.kodera.ext.qonto-treasury-feed'
  | 'io.kodera.ext.notion-workspace-bridge'
  | 'io.kodera.ext.gdrive-document-share'
  | 'io.kodera.ext.social-pulse-bridge'

export type OfficialSlashCommand =
  | '/frameio-review'
  | '/hello'
  | '/release-notes'
  | '/incident'
  | '/doc-pad'
  | '/github-track'
  | '/qonto-feed'
  | '/notion-page'
  | '/gdrive-share'
  | '/social-post'

export interface ExtensionSlashCommandDescriptor {
  readonly name: string
  readonly slashCommand: OfficialSlashCommand
  readonly usage: string
  readonly description: string
}

export interface OfficialExtensionDescriptor {
  readonly schemaVersion: typeof EXTENSION_SCHEMA_VERSION
  readonly id: OfficialExtensionId
  readonly slug: string
  readonly name: string
  readonly version: string
  readonly category: ExtensionCategory
  readonly description: string
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

export const OFFICIAL_EXTENSIONS_CATALOG: readonly OfficialExtensionDescriptor[] = Object.freeze<
  readonly OfficialExtensionDescriptor[]
>([
  Object.freeze<OfficialExtensionDescriptor>({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.frameio-review-bridge',
    slug: 'frameio-review-bridge',
    name: 'Frame.io Review Bridge',
    version: '0.1.0',
    category: 'productivity',
    description: 'Production review events in #post-production and #dailies-rushes',
    slashCommand: '/frameio-review',
    scopes: ['messages:write', 'commands:register', 'webhooks:incoming'],
    events: ['asset.ready', 'comment.created', 'review.status_changed'],
    commands: [
      {
        name: 'frameio-review',
        slashCommand: '/frameio-review',
        usage: '/frameio-review https://app.frame.io/reviews/project',
        description: 'Share a production review',
      },
    ],
    defaultWebhookExample: 'https://extensions.example.kodera.io/hooks/frameio-review-bridge',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.hello-webhook',
    slug: 'hello-webhook',
    name: 'Hello Webhook (Diagnostic & Echo)',
    version: '1.0.0',
    category: 'devops',
    description:
      'Extension de référence vérifiant la signature HMAC-SHA256 des webhooks entrants et répondant à la commande /hello.',
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/hello',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.github-release-notifier',
    slug: 'github-release-notifier',
    name: 'Notificateur de versions Git & CI',
    version: '1.0.0',
    category: 'devops',
    description:
      'Publie automatiquement les notes de version et alertes de pipeline CI dans le salon dédié.',
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/releases',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.uptime-incident-bridge',
    slug: 'uptime-incident-bridge',
    name: "Pont d'incidents & supervision",
    version: '1.0.0',
    category: 'devops',
    description:
      "Relie les sondes de disponibilité aux salons d'astreinte avec cartes d'incident structurées.",
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/incidents',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.docs-collab-announcer',
    slug: 'docs-collab-announcer',
    name: 'Annonceur de pads collaboratifs Docs',
    version: '1.0.0',
    category: 'productivity',
    description:
      'Partage et épingle les documents collaboratifs DINUM Docs directement depuis une commande slash.',
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/docs-collab',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.github-repo-tracker',
    slug: 'github-repo-tracker',
    name: 'Suivi de dépôt GitHub (Issues, PR, CI & Sécurité)',
    version: '1.0.0',
    category: 'devops',
    description:
      "Suit en temps réel l'activité d'un dépôt GitHub (issues, pull requests, workflow runs, releases, avis de sécurité) dans le salon.",
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/github-track',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.qonto-treasury-feed',
    slug: 'qonto-treasury-feed',
    name: 'Flux de trésorerie Qonto (IBAN masqué)',
    version: '1.0.0',
    category: 'finance',
    description:
      'Suit les mouvements bancaires Qonto (virements, justificatifs manquants, seuils de dépense) avec masquage déterministe des IBAN.',
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/qonto-feed',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.notion-workspace-bridge',
    slug: 'notion-workspace-bridge',
    name: 'Pont Notion Workspace & Bases de données',
    version: '1.0.0',
    category: 'productivity',
    description:
      'Partage et synchronise les pages et entrées de bases Notion dans un salon aux côtés de DINUM Docs.',
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
        description: 'Partage ou synchronise une page ou base Notion aux côtés de DINUM Docs.',
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/notion-bridge',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.gdrive-document-share',
    slug: 'gdrive-document-share',
    name: 'Partage Google Drive (Fichiers & Dossiers)',
    version: '1.0.0',
    category: 'productivity',
    description:
      "Partage des fichiers et dossiers Google Drive avec badges de droits d'accès (lecture, commentaire, édition) et validation HTTPS anti-SSRF.",
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
      }),
    ]),
    defaultWebhookExample: 'https://hooks.exemple-organisation.fr/kodera/gdrive-share',
  }),
  Object.freeze({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    id: 'io.kodera.ext.social-pulse-bridge',
    slug: 'social-pulse-bridge',
    name: 'Veille & Syndication Sociale (X, Mastodon, Instagram)',
    version: '1.0.0',
    category: 'social',
    description:
      'Diffuse les publications X / Twitter, Mastodon / Fédiverse et Instagram sans pixel tiers et supprime automatiquement les paramètres de pistage.',
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
