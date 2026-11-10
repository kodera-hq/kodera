import { ApiProblem, NetworkError, coreApi } from '../../api/client'
export type TemplateId =
  | 'audiovisual-production'
  | 'tech-studio'
  | 'b2b-advisory'
  | 'public-sector'
  | 'crisis-cell'
  | 'open-source-community'
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
  'crisis-cell': ['general', 'incident-log', 'field-bridge', 'urgence'],
  'open-source-community': [
    'general',
    'announcements',
    'contributing',
    'support',
    'community-lounge',
  ],
}

export interface InstantClaimPayload {
  organizationName: string
  slug: string
  hostingMode: 'cloud' | 'self-host'
  templateId: TemplateId
  themeId: 'givre' | 'ardoise' | 'real-black'
  soundPackId:
    | 'cristal-48k'
    | 'studio-mat'
    | 'silence'
    | 'givre'
    | 'atelier'
    | 'souffle'
    | 'cosmos'
    | 'luciole'
    | 'silencieux'
  enabledConnectors: readonly (
    | 'frameio-review-bridge'
    | 'github-webhook'
    | 'linear-sync'
    | 'sentry-alerts'
    | 'qonto-treasury-alerts'
    | 'stripe-revenue-events'
    | 'calcom-booking-sync'
    | 'nextcloud-drive-notifier'
  )[]
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
  // Local templates must not be sent to a server contract that does not support them yet.
  const cloudTemplate = payload.templateId
  if (cloudTemplate === 'open-source-community') throw new InstantClaimError('refused')
  const templates = [
    'audiovisual-production',
    'tech-studio',
    'b2b-advisory',
    'public-sector',
    'crisis-cell',
  ]
  if (
    typeof payload.organizationName !== 'string' ||
    !payload.organizationName.trim() ||
    payload.organizationName.length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(payload.organizationName) ||
    !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u.test(payload.slug) ||
    !['cloud', 'self-host'].includes(payload.hostingMode) ||
    !templates.includes(payload.templateId) ||
    !['givre', 'ardoise', 'real-black'].includes(payload.themeId) ||
    ![
      'cristal-48k',
      'studio-mat',
      'silence',
      'givre',
      'atelier',
      'souffle',
      'cosmos',
      'luciole',
      'silencieux',
    ].includes(payload.soundPackId) ||
    !Array.isArray(payload.enabledConnectors) ||
    payload.enabledConnectors.length > 10 ||
    new Set(payload.enabledConnectors).size !== payload.enabledConnectors.length ||
    !payload.enabledConnectors.every((id) =>
      [
        'frameio-review-bridge',
        'github-webhook',
        'linear-sync',
        'sentry-alerts',
        'qonto-treasury-alerts',
        'stripe-revenue-events',
        'calcom-booking-sync',
        'nextcloud-drive-notifier',
      ].includes(id)
    )
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
        body: payload,
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
      return parseClaim(parsed, payload)
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
export function localClaim(payload: InstantClaimPayload): ClaimedWorkspace {
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
