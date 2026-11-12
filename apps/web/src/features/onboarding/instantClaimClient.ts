import { ApiProblem, NetworkError, coreApi } from '../../api/client'
import type { components } from '../../api/schema'

// Every identifier this module sends or accepts is the contract's own: the unions come from the
// generated types, and each allow-list below is a record over one of them, so an identifier the
// contract gains or loses fails the type-check here instead of drifting.
type ClaimRequest = components['schemas']['InstantClaimTenantRequest']

/** An official workspace template, as the contract names it (`proximity`, and its alias). */
export type WorkspaceTemplateId = components['schemas']['WorkspaceTemplateId']
/** A template only the local preview offers: Core's contract does not take it. */
type LocalTemplateId = 'open-source-community'
/** Any template identifier this client may read: official, local, or the deprecated alias. */
export type TemplateId = WorkspaceTemplateId | LocalTemplateId

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
  'audiovisual-production': [
    'production',
    'post-production',
    'dailies-rushes',
    'tournage',
    'stage-control',
    'editing-room',
  ],
  'tech-studio': ['general', 'architecture', 'incident-prod'],
  'b2b-advisory': ['general', 'client-projects', 'deliverables'],
  'public-sector': ['general', 'compliance', 'on-call'],
  proximity: PROXIMITY_CHANNELS,
  'crisis-cell': PROXIMITY_CHANNELS,
  'open-source-community': [
    'general',
    'announcements',
    'contributing',
    'support',
    'community-lounge',
  ],
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

type ClaimThemeId = NonNullable<ClaimRequest['themeId']>
type ClaimSoundPackId = NonNullable<ClaimRequest['soundPackId']>
type ClaimConnectorId = NonNullable<ClaimRequest['enabledConnectors']>[number]

// What Core's contract accepts, value by value. Each record is exhaustive over its generated
// union: the keys are the allow-list.
const CLOUD_TEMPLATES: Record<WorkspaceTemplateId, true> = {
  'audiovisual-production': true,
  'tech-studio': true,
  'b2b-advisory': true,
  'public-sector': true,
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
const listed = (table: Readonly<Record<string, true>>, value: unknown): boolean =>
  typeof value === 'string' && Object.hasOwn(table, value)

export interface InstantClaimPayload {
  organizationName: ClaimRequest['organizationName']
  slug: ClaimRequest['slug']
  hostingMode: ClaimRequest['hostingMode']
  templateId: TemplateId
  themeId: ClaimThemeId
  soundPackId: ClaimSoundPackId
  enabledConnectors: readonly ClaimConnectorId[]
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
    !payload.enabledConnectors.every((id) => listed(CONNECTORS, id))
  )
    throw new InstantClaimError('refused')

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
            ...init.body,
            templateId: cloudTemplate,
            enabledConnectors: [...init.body.enabledConnectors],
          },
        })
        return { data: result.data, response: result.response }
      })
    const dispatch = async () => {
      const { data, response } = await post('/workspaces/instant-claim', {
        parseAs: 'stream',
        body: { ...payload, templateId: cloudTemplate },
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
      return parseClaim(parsed, { ...payload, templateId: cloudTemplate })
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
  const payload = { ...given, templateId: canonicalTemplateId(given.templateId) }
  const names = TEMPLATE_CHANNELS[payload.templateId]
  return {
    workspaceId: `local-${payload.slug}`,
    mode: 'local',
    payload,
    channels: names.map((name, index) => ({
      id: `local-${name}`,
      name,
      kind: index > 3 ? 'audio' : 'text',
    })),
    enabledConnectors: [],
  }
}
