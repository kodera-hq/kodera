import { ApiProblem, NetworkError, coreApi } from '../../api/client'
import type { components } from '../../api/schema'

// Every identifier this module sends or accepts is the contract's own: the unions come from the
// generated types, and each allow-list below is a record over one of them, so an identifier the
// contract gains or loses fails the type-check here instead of drifting.
type ClaimRequest = components['schemas']['InstantClaimTenantRequest']

/** An official workspace template, as the contract names it (`proximity`, and its alias). */
export type WorkspaceTemplateId = components['schemas']['WorkspaceTemplateId']
/** Any template identifier this client may read: official or the deprecated alias. */
export type TemplateId = WorkspaceTemplateId

/**
 * `crisis-cell` is the identifier the proximity template took before contract 0.42.0. It is a
 * permanent alias: a value stored or linked before then is read as `proximity`, for good. A new
 * request sends `proximity`.
 */
export const TEMPLATE_ALIASES = { 'crisis-cell': 'proximity' } as const satisfies Partial<
  Record<WorkspaceTemplateId, WorkspaceTemplateId>
>
type TemplateAlias = keyof typeof TEMPLATE_ALIASES
/** A template identifier as this client writes it: never the alias. */
export type CanonicalTemplateId = Exclude<TemplateId, TemplateAlias>

export interface TemplateChannelBlueprint {
  readonly categoryKey: string
  readonly templateKey: string
  readonly name: string
  readonly kind: 'text' | 'audio'
}

const PROXIMITY_BLUEPRINTS: readonly TemplateChannelBlueprint[] = [
  { categoryKey: 'proximity', templateKey: 'proximity', name: 'proximity', kind: 'text' },
]

/**
 * Official starter channel blueprints aligned 1:1 with `apps/server/apps/workspaces/templates.py`
 * (`category_key`, `template_key`, `name`, and explicit `kind: 'text' | 'audio'`).
 */
export const TEMPLATE_CHANNEL_BLUEPRINTS: Record<
  CanonicalTemplateId,
  readonly TemplateChannelBlueprint[]
> = {
  'audiovisual-production': [
    { categoryKey: 'production', templateKey: 'production', name: 'production', kind: 'text' },
    { categoryKey: 'production', templateKey: 'tournage', name: 'tournage', kind: 'text' },
    {
      categoryKey: 'post-production',
      templateKey: 'post-production',
      name: 'post-production',
      kind: 'text',
    },
    {
      categoryKey: 'post-production',
      templateKey: 'dailies-rushes',
      name: 'dailies-rushes',
      kind: 'text',
    },
    { categoryKey: 'plateaux', templateKey: 'plateau-regie', name: 'plateau-regie', kind: 'audio' },
    { categoryKey: 'plateaux', templateKey: 'salle-montage', name: 'salle-montage', kind: 'audio' },
  ],
  'tech-studio': [
    { categoryKey: 'general', templateKey: 'general', name: 'general', kind: 'text' },
    { categoryKey: 'engineering', templateKey: 'releases', name: 'releases', kind: 'text' },
    { categoryKey: 'engineering', templateKey: 'incidents', name: 'incidents', kind: 'text' },
    { categoryKey: 'voice', templateKey: 'standup', name: 'standup', kind: 'audio' },
    { categoryKey: 'voice', templateKey: 'pairing', name: 'pairing', kind: 'audio' },
  ],
  'b2b-advisory': [
    { categoryKey: 'cabinet', templateKey: 'general', name: 'general', kind: 'text' },
    {
      categoryKey: 'missions',
      templateKey: 'missions-clients',
      name: 'missions-clients',
      kind: 'text',
    },
    { categoryKey: 'missions', templateKey: 'livrables', name: 'livrables', kind: 'text' },
    {
      categoryKey: 'salles',
      templateKey: 'salle-associes',
      name: 'salle-associes',
      kind: 'audio',
    },
    { categoryKey: 'salles', templateKey: 'point-client', name: 'point-client', kind: 'audio' },
  ],
  'association-coop': [
    { categoryKey: 'vie-collective', templateKey: 'accueil', name: 'accueil', kind: 'text' },
    {
      categoryKey: 'vie-collective',
      templateKey: 'gouvernance',
      name: 'gouvernance',
      kind: 'text',
    },
    {
      categoryKey: 'projets',
      templateKey: 'entraide-projets',
      name: 'entraide-projets',
      kind: 'text',
    },
    { categoryKey: 'salons-vocaux', templateKey: 'foyer', name: 'foyer', kind: 'audio' },
    { categoryKey: 'salons-vocaux', templateKey: 'assemblee', name: 'assemblee', kind: 'audio' },
  ],
  'open-source-community': [
    { categoryKey: 'community', templateKey: 'general', name: 'general', kind: 'text' },
    {
      categoryKey: 'community',
      templateKey: 'announcements',
      name: 'announcements',
      kind: 'text',
    },
    {
      categoryKey: 'contributors',
      templateKey: 'contributing',
      name: 'contributing',
      kind: 'text',
    },
    { categoryKey: 'contributors', templateKey: 'support', name: 'support', kind: 'text' },
    {
      categoryKey: 'voice',
      templateKey: 'community-lounge',
      name: 'community-lounge',
      kind: 'audio',
    },
  ],
  'public-sector': [
    { categoryKey: 'collectivite', templateKey: 'accueil', name: 'accueil', kind: 'text' },
    {
      categoryKey: 'collectivite',
      templateKey: 'services-generaux',
      name: 'services-generaux',
      kind: 'text',
    },
    {
      categoryKey: 'deliberations',
      templateKey: 'deliberations',
      name: 'deliberations',
      kind: 'text',
    },
    {
      categoryKey: 'permanence',
      templateKey: 'salle-du-conseil',
      name: 'salle-du-conseil',
      kind: 'audio',
    },
    { categoryKey: 'permanence', templateKey: 'permanence', name: 'permanence', kind: 'audio' },
  ],
  blank: [{ categoryKey: 'general', templateKey: 'general', name: 'general', kind: 'text' }],
  proximity: PROXIMITY_BLUEPRINTS,
}

export const TEMPLATE_CATEGORY_KEYS: Record<CanonicalTemplateId, readonly string[]> = {
  'audiovisual-production': ['production', 'post-production', 'plateaux'],
  'tech-studio': ['general', 'engineering', 'voice'],
  'b2b-advisory': ['cabinet', 'missions', 'salles'],
  'association-coop': ['vie-collective', 'projets', 'salons-vocaux'],
  'open-source-community': ['community', 'contributors', 'voice'],
  'public-sector': ['collectivite', 'deliberations', 'permanence'],
  blank: ['general'],
  proximity: ['proximity'],
}

/**
 * The proximity template starts with one channel, `proximity`, a text channel: what Core answers
 * for it (`{ name: "proximity", kind: "text" }`). Anything more is a channel its members add
 * afterwards, through the same creation and invitation screens as any other channel.
 */
const PROXIMITY_CHANNELS = ['proximity'] as const

/**
 * The channels each template starts with. The alias keeps a key of its own, with the very list of
 * the template it names: a claim stored under `crisis-cell` is still a known template to whoever
 * looks its identifier up here.
 */
export const TEMPLATE_CHANNELS: Record<TemplateId, readonly string[]> = {
  'audiovisual-production': TEMPLATE_CHANNEL_BLUEPRINTS['audiovisual-production'].map(
    (ch) => ch.name
  ),
  'tech-studio': TEMPLATE_CHANNEL_BLUEPRINTS['tech-studio'].map((ch) => ch.name),
  'b2b-advisory': TEMPLATE_CHANNEL_BLUEPRINTS['b2b-advisory'].map((ch) => ch.name),
  'association-coop': TEMPLATE_CHANNEL_BLUEPRINTS['association-coop'].map((ch) => ch.name),
  'open-source-community': TEMPLATE_CHANNEL_BLUEPRINTS['open-source-community'].map(
    (ch) => ch.name
  ),
  'public-sector': TEMPLATE_CHANNEL_BLUEPRINTS['public-sector'].map((ch) => ch.name),
  blank: TEMPLATE_CHANNEL_BLUEPRINTS.blank.map((ch) => ch.name),
  proximity: PROXIMITY_CHANNELS,
  'crisis-cell': PROXIMITY_CHANNELS,
}

/**
 * The template an identifier names, in its canonical spelling; nothing for a value that names
 * none. This is how an identifier is read back from anywhere it was kept or sent before: session
 * storage, a link, an older peer. `aliases` is a parameter so that the tests can show what a
 * reader without the alias would lose.
 */
export function readTemplateId(
  value: unknown,
  aliases: Readonly<Record<string, CanonicalTemplateId>> = TEMPLATE_ALIASES
): CanonicalTemplateId | undefined {
  if (typeof value !== 'string') return undefined
  if (Object.hasOwn(aliases, value)) return aliases[value]
  // Without the alias table an alias names nothing: it is not a canonical identifier.
  if (Object.hasOwn(TEMPLATE_ALIASES, value)) return undefined
  return Object.hasOwn(TEMPLATE_CHANNELS, value) ? (value as CanonicalTemplateId) : undefined
}

/** The canonical spelling of a template identifier already known to be one. */
export function canonicalTemplateId(id: TemplateId): CanonicalTemplateId {
  return Object.hasOwn(TEMPLATE_ALIASES, id)
    ? TEMPLATE_ALIASES[id as TemplateAlias]
    : (id as CanonicalTemplateId)
}

/**
 * The identifier the self-host tooling takes for a template (`npx create-kodera --template`,
 * `deploy/community/kodera-deploy.sh --template`). Their template tables name the proximity
 * template by its alias only, so the command a person copies keeps the alias, which is permanent:
 * a command naming `proximity` would be refused by the tooling it is for.
 */
export function deployTemplateId(id: TemplateId): TemplateId {
  return canonicalTemplateId(id) === 'proximity' ? 'crisis-cell' : id
}

export type ClaimThemeId = NonNullable<ClaimRequest['themeId']>
export type ClaimSoundPackId = NonNullable<ClaimRequest['soundPackId']>
export type ClaimConnectorId = NonNullable<ClaimRequest['enabledConnectors']>[number]
export type ClaimCustomization = NonNullable<ClaimRequest['customization']>

// What Core's contract accepts, value by value. Each record is exhaustive over its generated
// union: the keys are the allow-list.
const CLOUD_TEMPLATES: Record<WorkspaceTemplateId, true> = {
  'audiovisual-production': true,
  'tech-studio': true,
  'b2b-advisory': true,
  'association-coop': true,
  'open-source-community': true,
  'public-sector': true,
  blank: true,
  proximity: true,
  'crisis-cell': true,
}
const HOSTING_MODES: Record<ClaimRequest['hostingMode'], true> = { cloud: true, 'self-host': true }
// The five theme identifiers and the three aliases in use before contract 0.42.0, all accepted.
const THEMES: Record<ClaimThemeId, true> = {
  light: true,
  dark: true,
  black: true,
  ciel: true,
  'ciel-nuit': true,
  givre: true,
  ardoise: true,
  'real-black': true,
}
const SOUND_PACKS: Record<ClaimSoundPackId, true> = {
  'cristal-48k': true,
  'studio-mat': true,
  silence: true,
  givre: true,
  atelier: true,
  souffle: true,
  cosmos: true,
  luciole: true,
  silencieux: true,
}
const CONNECTORS: Record<ClaimConnectorId, true> = {
  'frameio-review-bridge': true,
  'github-webhook': true,
  'linear-sync': true,
  'sentry-alerts': true,
  'qonto-treasury-alerts': true,
  'stripe-revenue-events': true,
  'calcom-booking-sync': true,
  'nextcloud-drive-notifier': true,
}
export const CONNECTOR_IDS = Object.freeze(Object.keys(CONNECTORS) as ClaimConnectorId[])
const listed = (table: Readonly<Record<string, true>>, value: unknown): boolean =>
  typeof value === 'string' && Object.hasOwn(table, value)
export function isClaimConnectorId(value: unknown): value is ClaimConnectorId {
  return listed(CONNECTORS, value)
}

/**
 * Printable single-line Latin/ASCII name rule from Core `warm_pool.py`: `1..64` chars (excluding
 * soft hyphen `\u00ad`) containing at least one ASCII `[A-Za-z0-9]` (rejects zero-ASCII-alphanumeric
 * inputs like `"ø"` or `"Ａ"`).
 */
export const CUSTOM_CHANNEL_NAME_PATTERN =
  /^[\x20-\x7e\u00a0-\u00ac\u00ae-\u024f]*[A-Za-z0-9][\x20-\x7e\u00a0-\u00ac\u00ae-\u024f]*$/
const CHANNEL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TRANSMITTED_CHANNEL_KEY_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const ALLOWED_CUSTOMIZATION_KEYS = new Set([
  'includeAudioChannels',
  'includeCollections',
  'includeStarterDocs',
  'excludedChannelKeys',
  'additionalChannels',
])
const ALLOWED_ADDITIONAL_CHANNEL_KEYS = new Set(['categoryKey', 'name', 'kind', 'topic'])

/**
 * Mirrors Core channel-key normalization and constraints: validates printable single-line `1..64`
 * char input (excluding `\u00ad`) with `>= 1` ASCII `[A-Za-z0-9]`, and derives a `1..32` char
 * ASCII key (`c-<digits>` when starting with a digit) satisfying both `CUSTOM_CHANNEL_KEY_PATTERN`
 * and `Channel.template_key` (`^[a-z][a-z0-9_]{0,31}$`). Returns `null` when invalid.
 */
export function slugifyChannelKey(rawName: string): string | null {
  if (
    typeof rawName !== 'string' ||
    rawName.length < 1 ||
    rawName.length > 64 ||
    !CUSTOM_CHANNEL_NAME_PATTERN.test(rawName)
  ) {
    return null
  }
  const trimmed = rawName.trim()
  if (trimmed.length < 1 || !CUSTOM_CHANNEL_NAME_PATTERN.test(trimmed)) {
    return null
  }
  let slug = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!slug) return null
  if (/^[0-9]/.test(slug)) {
    slug = `c-${slug}`
  }
  slug = slug.slice(0, 32).replace(/-+$/gu, '')
  if (!slug || !TRANSMITTED_CHANNEL_KEY_PATTERN.test(slug)) return null
  return slug
}

export function dbChannelKey(templateKey: string): string {
  return templateKey.replace(/-/g, '_')
}

/**
 * Validates and normalizes `WorkspaceTemplateCustomization` at the client boundary so every
 * transmitted `additionalChannels[i].name` and `excludedChannelKeys[i]` satisfies Core's exact
 * regex, length (`1..32`), category, uniqueness, and `>= 1` text-channel invariants.
 * Returns `undefined` when omitted, `null` when invalid, or the normalized `ClaimCustomization`.
 */
export function normalizeCustomization(
  value: ClaimCustomization | undefined,
  templateId: CanonicalTemplateId
): ClaimCustomization | undefined | null {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CUSTOMIZATION_KEYS.has(key)) return null
  }
  if (
    typeof value.includeAudioChannels !== 'boolean' ||
    typeof value.includeCollections !== 'boolean' ||
    typeof value.includeStarterDocs !== 'boolean'
  ) {
    return null
  }
  let normalizedExcluded: string[] | undefined
  if (value.excludedChannelKeys !== undefined) {
    if (
      !Array.isArray(value.excludedChannelKeys) ||
      value.excludedChannelKeys.length > 32 ||
      !value.excludedChannelKeys.every(
        (key) => typeof key === 'string' && CHANNEL_KEY_PATTERN.test(key)
      )
    ) {
      return null
    }
    normalizedExcluded = [...new Set(value.excludedChannelKeys)]
  }

  const allowedCategories = new Set(TEMPLATE_CATEGORY_KEYS[templateId])
  const excluded = new Set(normalizedExcluded ?? [])
  const remainingStarter = TEMPLATE_CHANNEL_BLUEPRINTS[templateId].filter(
    (ch) => !excluded.has(ch.templateKey) && (value.includeAudioChannels || ch.kind !== 'audio')
  )
  const seenDbKeys = new Set(remainingStarter.map((ch) => dbChannelKey(ch.templateKey)))
  const seenNames = new Set(remainingStarter.map((ch) => ch.name))
  let textCount = remainingStarter.filter((ch) => ch.kind === 'text').length

  let normalizedAdditional: NonNullable<ClaimCustomization['additionalChannels']> | undefined
  if (value.additionalChannels !== undefined) {
    if (!Array.isArray(value.additionalChannels) || value.additionalChannels.length > 16) {
      return null
    }
    normalizedAdditional = []
    for (const ch of value.additionalChannels) {
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return null
      for (const key of Object.keys(ch)) {
        if (!ALLOWED_ADDITIONAL_CHANNEL_KEYS.has(key)) return null
      }
      if (
        typeof ch.categoryKey !== 'string' ||
        !CHANNEL_KEY_PATTERN.test(ch.categoryKey) ||
        !allowedCategories.has(ch.categoryKey)
      ) {
        return null
      }
      if (ch.kind !== 'text' && ch.kind !== 'audio') return null
      if (!value.includeAudioChannels && ch.kind === 'audio') return null
      const normalizedName = slugifyChannelKey(ch.name)
      if (normalizedName === null) return null
      const derivedDbKey = dbChannelKey(normalizedName)
      if (seenDbKeys.has(derivedDbKey) || seenNames.has(normalizedName)) {
        return null
      }
      if (
        ch.topic !== undefined &&
        (typeof ch.topic !== 'string' ||
          ch.topic.length > 1024 ||
          /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(ch.topic))
      ) {
        return null
      }
      seenDbKeys.add(derivedDbKey)
      seenNames.add(normalizedName)
      if (ch.kind === 'text') textCount += 1
      normalizedAdditional.push({
        categoryKey: ch.categoryKey,
        name: normalizedName,
        kind: ch.kind,
        ...(ch.topic === undefined ? {} : { topic: ch.topic }),
      })
    }
  }

  if (textCount < 1) return null
  return {
    includeAudioChannels: value.includeAudioChannels,
    includeCollections: value.includeCollections,
    includeStarterDocs: value.includeStarterDocs,
    ...(normalizedExcluded === undefined ? {} : { excludedChannelKeys: normalizedExcluded }),
    ...(normalizedAdditional === undefined ? {} : { additionalChannels: normalizedAdditional }),
  }
}

export interface InstantClaimPayload {
  organizationName: ClaimRequest['organizationName']
  slug: ClaimRequest['slug']
  hostingMode: ClaimRequest['hostingMode']
  templateId: TemplateId
  themeId: ClaimThemeId
  soundPackId: ClaimSoundPackId
  enabledConnectors: readonly ClaimConnectorId[]
  customization?: ClaimCustomization | undefined
}
export interface ClaimedChannel {
  id: string
  name: string
  kind: 'text' | 'audio'
}
export interface ClaimedWorkspace {
  workspaceId: string
  workspaceUrl?: string
  invitationUrl?: string
  channels: readonly ClaimedChannel[]
  enabledConnectors: readonly string[]
  offerMode?: 'community' | 'cloud-shared' | 'cloud-dedicated' | undefined
  mode: 'cloud' | 'local'
  payload: InstantClaimPayload
}
export class InstantClaimError extends Error {
  constructor(readonly kind: 'unavailable' | 'refused' | 'invalid-response') {
    super(kind)
  }
}
type Post = (
  path: '/workspaces/instant-claim',
  init: {
    parseAs: 'stream'
    body: InstantClaimPayload
    signal: AbortSignal
    headers: { 'Idempotency-Key': string }
  }
) => Promise<{ data: unknown; response: { status: number } }>
function https(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\p{Cc}\p{Cf}\\]/u.test(value))
    return false
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u.test(u.hostname) &&
      !/\.(local|internal|localhost|test|invalid)$/u.test(u.hostname)
    )
  } catch {
    return false
  }
}
export function parseClaim(data: unknown, payload: InstantClaimPayload): ClaimedWorkspace {
  if (!data || typeof data !== 'object') throw new InstantClaimError('invalid-response')
  const value = data as Record<string, unknown>
  if (
    typeof value.workspaceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) ||
    !https(value.workspaceUrl) ||
    !https(value.invitationUrl) ||
    !Array.isArray(value.channels) ||
    value.channels.length < 1 ||
    value.channels.length > 128 ||
    !Array.isArray(value.enabledConnectors) ||
    value.enabledConnectors.length > 32
  )
    throw new InstantClaimError('invalid-response')
  const ids = new Set<string>()
  const channels: ClaimedChannel[] = value.channels.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new InstantClaimError('invalid-response')
    const c = raw as Record<string, unknown>
    if (
      typeof c.id !== 'string' ||
      c.id.length < 1 ||
      c.id.length > 128 ||
      ids.has(c.id) ||
      typeof c.name !== 'string' ||
      c.name.length < 1 ||
      c.name.length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(c.name) ||
      (c.kind !== 'text' && c.kind !== 'audio')
    )
      throw new InstantClaimError('invalid-response')
    ids.add(c.id)
    return { id: c.id, name: c.name, kind: c.kind }
  })
  if (
    !value.enabledConnectors.every(
      (id: unknown) => typeof id === 'string' && /^[a-z][a-z0-9-]{1,63}$/u.test(id)
    )
  )
    throw new InstantClaimError('invalid-response')
  return {
    workspaceId: value.workspaceId,
    workspaceUrl: value.workspaceUrl,
    invitationUrl: value.invitationUrl,
    channels,
    enabledConnectors: value.enabledConnectors as string[],
    offerMode: ['community', 'cloud-shared', 'cloud-dedicated'].includes(String(value.offerMode))
      ? (value.offerMode as 'community' | 'cloud-shared' | 'cloud-dedicated')
      : undefined,
    mode: 'cloud',
    payload,
  }
}
export async function instantClaimWorkspace(
  payload: InstantClaimPayload,
  options: { post?: Post; idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ClaimedWorkspace> {
  // Local templates must not be sent to a server contract that does not support them yet, and an
  // identifier that names no template is refused before anything is sent.
  const template = readTemplateId(payload.templateId)
  if (template === undefined || !listed(CLOUD_TEMPLATES, template))
    throw new InstantClaimError('refused')
  // What is sent is the canonical identifier: `proximity`, never the alias it was once stored as.
  const cloudTemplate = template as WorkspaceTemplateId
  const normalizedCustomization = normalizeCustomization(payload.customization, template)
  if (
    typeof payload.organizationName !== 'string' ||
    !payload.organizationName.trim() ||
    payload.organizationName.length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(payload.organizationName) ||
    !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u.test(payload.slug) ||
    !listed(HOSTING_MODES, payload.hostingMode) ||
    !listed(THEMES, payload.themeId) ||
    !listed(SOUND_PACKS, payload.soundPackId) ||
    !Array.isArray(payload.enabledConnectors) ||
    payload.enabledConnectors.length > 10 ||
    new Set(payload.enabledConnectors).size !== payload.enabledConnectors.length ||
    !payload.enabledConnectors.every((id) => listed(CONNECTORS, id)) ||
    normalizedCustomization === null
  )
    throw new InstantClaimError('refused')

  const normalizedPayload: InstantClaimPayload = {
    organizationName: payload.organizationName,
    slug: payload.slug,
    hostingMode: payload.hostingMode,
    templateId: cloudTemplate,
    themeId: payload.themeId,
    soundPackId: payload.soundPackId,
    enabledConnectors: payload.enabledConnectors,
    ...(normalizedCustomization === undefined ? {} : { customization: normalizedCustomization }),
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (controller.signal.aborted) throw new InstantClaimError('unavailable')
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort()
          reject(new InstantClaimError('unavailable'))
        },
        Math.min(2500, Math.max(1, options.timeoutMs ?? 2500))
      )
    })
    const post: Post =
      options.post ??
      (async (_path, init) => {
        const result = await coreApi().POST('/workspaces/instant-claim', {
          ...init,
          params: { header: init.headers },
          body: {
            organizationName: init.body.organizationName,
            slug: init.body.slug,
            hostingMode: init.body.hostingMode,
            templateId: cloudTemplate,
            themeId: init.body.themeId,
            soundPackId: init.body.soundPackId,
            enabledConnectors: [...init.body.enabledConnectors],
            ...(init.body.customization === undefined
              ? {}
              : { customization: init.body.customization }),
          },
        })
        return { data: result.data, response: result.response }
      })
    const dispatch = async () => {
      const { data, response } = await post('/workspaces/instant-claim', {
        parseAs: 'stream',
        body: normalizedPayload,
        signal: controller.signal,
        headers: { 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID() },
      })
      if (response.status !== 200 && response.status !== 201)
        throw new InstantClaimError(
          [404, 502, 503, 504].includes(response.status) ? 'unavailable' : 'refused'
        )
      let parsed: unknown = data
      if (data instanceof ReadableStream) {
        const reader = data.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            const chunk = part.value as Uint8Array
            size += chunk.byteLength
            if (size > 65_536) {
              await reader.cancel()
              throw new InstantClaimError('invalid-response')
            }
            chunks.push(chunk)
          }
        } finally {
          reader.releaseLock()
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          throw new InstantClaimError('invalid-response')
        }
      }
      if (controller.signal.aborted) throw new InstantClaimError('unavailable')
      return parseClaim(parsed, normalizedPayload)
    }
    return await Promise.race([dispatch(), timeout])
  } catch (error) {
    if (error instanceof InstantClaimError) throw error
    if (error instanceof ApiProblem)
      throw new InstantClaimError(
        [404, 502, 503, 504].includes(error.status) ? 'unavailable' : 'refused'
      )
    if (error instanceof NetworkError || controller.signal.aborted)
      throw new InstantClaimError('unavailable')
    throw new InstantClaimError('unavailable')
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
export function localClaim(given: InstantClaimPayload): ClaimedWorkspace {
  // A claim kept under the alias (session storage, before 0.42.0) is the proximity template's.
  const canonicalId = readTemplateId(given.templateId)
  if (canonicalId === undefined) throw new InstantClaimError('refused')
  const normalizedCustomization = normalizeCustomization(given.customization, canonicalId)
  if (normalizedCustomization === null) throw new InstantClaimError('refused')
  const { customization: _rawCustomization, ...restGiven } = given
  void _rawCustomization
  const payload: InstantClaimPayload = {
    ...restGiven,
    templateId: canonicalId,
    ...(normalizedCustomization === undefined ? {} : { customization: normalizedCustomization }),
  }
  const blueprints = TEMPLATE_CHANNEL_BLUEPRINTS[canonicalId]
  const starter = blueprints.map((bp) => ({
    templateKey: bp.templateKey,
    channel: {
      id: `local-${bp.templateKey}`,
      name: bp.name,
      kind: bp.kind,
    } satisfies ClaimedChannel,
  }))
  if (normalizedCustomization === undefined) {
    return {
      workspaceId: `local-${payload.slug}`,
      mode: 'local',
      payload,
      channels: starter.map((item) => item.channel),
      enabledConnectors: [],
    }
  }
  const excluded = new Set(normalizedCustomization.excludedChannelKeys ?? [])
  const customized: ClaimedChannel[] = []
  for (const item of starter) {
    if (excluded.has(item.templateKey)) continue
    if (!normalizedCustomization.includeAudioChannels && item.channel.kind === 'audio') continue
    customized.push(item.channel)
  }
  for (const extra of normalizedCustomization.additionalChannels ?? []) {
    customized.push({
      id: `local-${extra.name}`,
      name: extra.name,
      kind: extra.kind,
    })
  }
  if (!customized.some((channel) => channel.kind === 'text')) {
    const fallbackText = starter.find((item) => item.channel.kind === 'text')
    if (fallbackText !== undefined) customized.unshift(fallbackText.channel)
  }
  return {
    workspaceId: `local-${payload.slug}`,
    mode: 'local',
    payload,
    channels: customized,
    enabledConnectors: [],
  }
}
