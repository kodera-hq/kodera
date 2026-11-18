import type { AnalyticsEvent, TrackProperties } from '../track'

export const EU_INGESTION_HOST = 'https://eu.i.posthog.com'
/** No DOM collection is installed. These restrictions also govern any future adapter. */
export const CAPTURE_PRIVACY = Object.freeze({
  maskAllInputs: true,
  blockSelector: '[data-ph-no-capture], .ph-no-capture',
  autocapture: false,
  sessionRecording: false,
})
const AREAS = [
  'home',
  'workspace',
  'docs',
  'people',
  'status',
  'security',
  'domain',
  'federation',
  'invoices',
  'order',
  'login',
  'other',
] as const
const OPERATIONS = ['chat_send', 'docs_load', 'docs_save', 'file_upload', 'file_download'] as const
const EXTENSION_IDS = [
  'io.kodera.ext.frameio-review-bridge',
  'io.kodera.ext.frameio',
  'io.kodera.ext.renderfarm',
  'io.kodera.ext.hello-webhook',
  'io.kodera.ext.github',
  'io.kodera.ext.gitlab',
  'io.kodera.ext.linear',
  'io.kodera.ext.sentry',
  'io.kodera.ext.alertmanager',
  'io.kodera.ext.rss-advisories',
  'io.kodera.ext.release-assistant',
  'io.kodera.ext.github-release-notifier',
  'io.kodera.ext.uptime-incident-bridge',
  'io.kodera.ext.docs-collab-announcer',
  'io.kodera.ext.openproject',
  'io.kodera.ext.calcom',
  'io.kodera.ext.github-repo-tracker',
  'io.kodera.ext.qonto-treasury-feed',
  'io.kodera.ext.billing-webhooks',
  'io.kodera.ext.notion-workspace-bridge',
  'io.kodera.ext.gdrive-document-share',
  'io.kodera.ext.social-pulse-bridge',
] as const
export type TelemetryOperation = (typeof OPERATIONS)[number]
type Rule = readonly string[] | 'number' | 'boolean'
const RULES: Record<string, Record<string, Rule>> = {
  workspace_created: {},
  workspace_channel_created: { kind: ['text', 'audio'], access: ['members', 'invite'] },
  workspace_message_sent: {
    kind: ['message', 'message_with_files', 'reply', 'thread_reply'],
  },
  workspace_files_uploaded: { file_count: 'number' },
  workspace_document_published: { editor_mode: ['markdown', 'blocks'] },
  extension_setup_opened: { extension_id: EXTENSION_IDS },
  navigation_completed: { area: AREAS, duration_ms: 'number' },
  web_vital: { metric: ['LCP', 'CLS', 'interaction_latency'], value: 'number' },
  resource_latency: { operation: [...OPERATIONS, 'docs_request'], duration_ms: 'number' },
  operation_completed: { operation: OPERATIONS, duration_ms: 'number', success: 'boolean' },
  onboarding_completed: { mode: ['cloud', 'local'] },
  channel_opened: { kind: ['chat', 'voice'] },
  workspace_surface_changed: { surface: ['chat', 'docs', 'files'], duration_ms: 'number' },
  channel_joined: { kind: ['chat', 'docs', 'voice'] },
  client_error: {
    source: ['error', 'rejection', 'boundary'],
    kind: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'unknown'],
    area: AREAS,
    component: ['RouteError', 'unknown'],
  },
  status_banner_shown: { kind: ['offline', 'incident', 'dunning', 'capacity', 'maintenance'] },
  organisation_switched: { membership_count: 'number' },
  session_expiry_dialog_shown: { outcome: ['extended', 'signed-out', 'ignored'] },
  help_opened: { area: AREAS },
  login_discovery_submitted: { kind: ['email', 'domain'] },
  home_viewed: {
    tenant_state: ['active', 'pending', 'suspended', 'none'],
    cards_rendered: 'number',
  },
}
/** Construct a new payload. Unknown names, properties and arbitrary strings never survive. */
export function sanitizeTelemetryEvent(event: AnalyticsEvent): AnalyticsEvent | undefined {
  if (
    !event ||
    typeof event.name !== 'string' ||
    !event.properties ||
    typeof event.properties !== 'object'
  )
    return undefined
  const rules = Object.hasOwn(RULES, event.name) ? RULES[event.name] : undefined
  if (!rules) return undefined
  const properties: TrackProperties = {}
  for (const [name, rule] of Object.entries(rules)) {
    const value = event.properties[name]
    if (rule === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0)
      properties[name] = Math.round(Math.min(value, 3_600_000) * 1000) / 1000
    else if (rule === 'boolean' && typeof value === 'boolean') properties[name] = value
    else if (Array.isArray(rule) && typeof value === 'string' && rule.includes(value))
      properties[name] = value
  }
  // Stack values use a separate grammar and cannot contain messages, function names or URLs.
  if (event.name === 'client_error' && typeof event.properties.stack === 'string') {
    const frames = event.properties.stack
      .split('\n')
      .filter((frame) => /^bundle:\d{1,8}:\d{1,8}$/.test(frame))
      .slice(0, 8)
    if (frames.length) properties.stack = frames.join('\n')
  }
  return { name: event.name, properties }
}
export function routeArea(pathname: string): (typeof AREAS)[number] {
  const area = pathname.split('/')[2] ?? (pathname === '/login' ? 'login' : 'other')
  return AREAS.find((known) => known === area) ?? 'other'
}
/** Only this origin's bundled code locations; no exception message or dynamic component name. */
export function codeStack(error: unknown, origin: string): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return ''
  const frames: string[] = []
  for (const line of error.stack.split('\n').slice(1, 30)) {
    const match = line.match(
      /(https?:\/\/[^\s)]+\/assets\/[A-Za-z0-9_-]+\.js):(\d{1,8}):(\d{1,8})\)?$/
    )
    if (!match?.[1]) continue
    try {
      const url = new URL(match[1])
      if (url.origin === origin && !url.search && !url.hash)
        frames.push(`bundle:${match[2]}:${match[3]}`)
    } catch {
      /* An invalid frame is discarded. */
    }
  }
  return frames.slice(0, 8).join('\n')
}
