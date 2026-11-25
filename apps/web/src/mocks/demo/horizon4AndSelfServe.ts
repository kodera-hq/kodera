// The demo's answers to Horizon 4 workspace extensions/experience/key-backup surfaces and
// cardless PME self-serve creation (Core API 0.61.0), aligned strictly with the OpenAPI contract.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components, operations } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'
import { problem } from '../problem'

export const HORIZON4_DEMO_ROUTES: readonly string[] = [
  'GET /organisations/:organisation_id/confidential/key-backup',
  'POST /organisations/:organisation_id/confidential/key-backup',
  'DELETE /organisations/:organisation_id/confidential/key-backup',
  'GET /organisations/:organisation_id/workspace/emojis',
  'POST /organisations/:organisation_id/workspace/emojis',
  'DELETE /organisations/:organisation_id/workspace/emojis/:emoji_id',
  'GET /organisations/:organisation_id/workspace/emojis/:emoji_id/blob',
  'GET /organisations/:organisation_id/workspace/extensions/marketplace',
  'POST /organisations/:organisation_id/workspace/extensions/marketplace',
  'POST /organisations/:organisation_id/workspace/extensions/marketplace/:listing_id/checkout',
  'POST /organisations/:organisation_id/workspace/extensions/marketplace/:listing_id/install',
  'GET /organisations/:organisation_id/workspace/preferences/me',
  'PATCH /organisations/:organisation_id/workspace/preferences/me',
  'GET /organisations/:organisation_id/workspace/reminders',
  'POST /organisations/:organisation_id/workspace/reminders',
  'PATCH /organisations/:organisation_id/workspace/reminders/:reminder_id',
  'DELETE /organisations/:organisation_id/workspace/reminders/:reminder_id',
  'GET /organisations/:organisation_id/workspace/scheduled-messages',
  'POST /organisations/:organisation_id/workspace/scheduled-messages',
  'PATCH /organisations/:organisation_id/workspace/scheduled-messages/:scheduled_message_id',
  'DELETE /organisations/:organisation_id/workspace/scheduled-messages/:scheduled_message_id',
  'POST /organisations/:organisation_id/workspace/channels/:channel_id/widgets/:widget_id/actions',
  'POST /workspaces/self-serve',
]

type KeyBackupEnvelope =
  operations['getConfidentialKeyBackup']['responses'][200]['content']['application/json']
type KeyBackupPublished =
  operations['publishConfidentialKeyBackup']['responses'][201]['content']['application/json']
type WorkspacePreferences =
  operations['getMyWorkspacePreferences']['responses'][200]['content']['application/json']

export function horizon4DemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  let backupEpoch = 1
  let storedBackup: KeyBackupEnvelope | null = null
  let preferences: WorkspacePreferences = structuredClone(
    EXAMPLES.getMyWorkspacePreferences.body as WorkspacePreferences
  )
  let prefsEtag = '"vercelli-prefs-1"'

  return [
    http.get(`${base}/organisations/:organisation_id/confidential/key-backup`, async () => {
      if (storedBackup === null) {
        const res = problem('https://kodera.io/problems/not-found')
        const body = (await res.json()) as Record<string, unknown>
        return HttpResponse.json(body, {
          status: 404,
          headers: {
            ...headers(),
            'Content-Type': 'application/problem+json',
            'X-Kodera-Next-Backup-Epoch': String(backupEpoch),
          },
        })
      }
      return HttpResponse.json(storedBackup, {
        headers: {
          ...headers(),
          'X-Kodera-Next-Backup-Epoch': String(storedBackup.backupEpoch + 1),
        },
      })
    }),
    http.post(
      `${base}/organisations/:organisation_id/confidential/key-backup`,
      async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const templateEnvelope = structuredClone(
          EXAMPLES.getConfidentialKeyBackup.body as KeyBackupEnvelope
        )
        const templatePublished = structuredClone(
          EXAMPLES.publishConfidentialKeyBackup.body as KeyBackupPublished
        )
        const epoch = typeof body['backupEpoch'] === 'number' ? body['backupEpoch'] : backupEpoch
        backupEpoch = epoch + 1
        const nowIso = new Date().toISOString()
        const nextBackup: KeyBackupEnvelope = {
          ...templateEnvelope,
          backupEpoch: epoch,
          ...(typeof body['deviceId'] === 'string' ? { sourceDeviceId: body['deviceId'] } : {}),
          ...(typeof body['capsule'] === 'string' && body['capsule'].length > 0
            ? { capsule: body['capsule'] }
            : {}),
          publishedAt: nowIso,
        }
        storedBackup = nextBackup
        const published: KeyBackupPublished = {
          ...templatePublished,
          backupEpoch: nextBackup.backupEpoch,
        }
        return HttpResponse.json(published, {
          status: 201,
          headers: {
            ...headers(),
            'Idempotency-Replayed': 'false',
            'X-Kodera-Next-Backup-Epoch': String(backupEpoch),
          },
        })
      }
    ),
    http.delete(`${base}/organisations/:organisation_id/confidential/key-backup`, () => {
      storedBackup = null
      backupEpoch += 1
      return new HttpResponse(null, {
        status: 204,
        headers: {
          ...headers(),
          'X-Kodera-Next-Backup-Epoch': String(backupEpoch),
        },
      })
    }),
    http.get(`${base}/organisations/:organisation_id/workspace/emojis`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.listWorkspaceCustomEmojis.body), {
        headers: headers(),
      })
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/emojis`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.createWorkspaceCustomEmoji.body), {
        status: 201,
        headers: { ...headers(), 'Idempotency-Replayed': 'false' },
      })
    ),
    http.delete(
      `${base}/organisations/:organisation_id/workspace/emojis/:emoji_id`,
      () => new HttpResponse(null, { status: 204, headers: headers() })
    ),
    http.get(`${base}/organisations/:organisation_id/workspace/emojis/:emoji_id/blob`, () => {
      const b64 = String(EXAMPLES.getWorkspaceCustomEmojiBlob.body)
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      return new HttpResponse(bytes.buffer, {
        status: 200,
        headers: { ...headers(), 'Content-Type': 'image/webp' },
      })
    }),
    http.get(`${base}/organisations/:organisation_id/workspace/extensions/marketplace`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.listMarketplaceExtensions.body), {
        headers: headers(),
      })
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/extensions/marketplace`, () =>
      problem('https://kodera.io/problems/forbidden')
    ),
    http.post(
      `${base}/organisations/:organisation_id/workspace/extensions/marketplace/:listing_id/checkout`,
      () => problem('https://kodera.io/problems/forbidden')
    ),
    http.post(
      `${base}/organisations/:organisation_id/workspace/extensions/marketplace/:listing_id/install`,
      () => problem('https://kodera.io/problems/forbidden')
    ),
    http.get(`${base}/organisations/:organisation_id/workspace/preferences/me`, () =>
      HttpResponse.json(preferences, {
        headers: { ...headers(), ETag: prefsEtag },
      })
    ),
    http.patch(
      `${base}/organisations/:organisation_id/workspace/preferences/me`,
      async ({ request }) => {
        const patch = (await request.json().catch(() => ({}))) as Partial<WorkspacePreferences>
        preferences = {
          ...preferences,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
        prefsEtag = `"vercelli-prefs-${Date.now()}"`
        return HttpResponse.json(preferences, {
          headers: { ...headers(), ETag: prefsEtag },
        })
      }
    ),
    http.get(`${base}/organisations/:organisation_id/workspace/reminders`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.listPersonalReminders.body), {
        headers: headers(),
      })
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/reminders`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.createPersonalReminder.body), {
        status: 201,
        headers: { ...headers(), ETag: '"vercelli-rem-1"', 'Idempotency-Replayed': 'false' },
      })
    ),
    http.patch(`${base}/organisations/:organisation_id/workspace/reminders/:reminder_id`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.updatePersonalReminder.body), {
        headers: { ...headers(), ETag: '"vercelli-rem-2"' },
      })
    ),
    http.delete(
      `${base}/organisations/:organisation_id/workspace/reminders/:reminder_id`,
      () => new HttpResponse(null, { status: 204, headers: headers() })
    ),
    http.get(`${base}/organisations/:organisation_id/workspace/scheduled-messages`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.listScheduledMessages.body), {
        headers: headers(),
      })
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/scheduled-messages`, () =>
      HttpResponse.json(structuredClone(EXAMPLES.createScheduledMessage.body), {
        status: 201,
        headers: { ...headers(), ETag: '"vercelli-sched-1"', 'Idempotency-Replayed': 'false' },
      })
    ),
    http.patch(
      `${base}/organisations/:organisation_id/workspace/scheduled-messages/:scheduled_message_id`,
      () =>
        HttpResponse.json(structuredClone(EXAMPLES.updateScheduledMessage.body), {
          headers: { ...headers(), ETag: '"vercelli-sched-2"' },
        })
    ),
    http.delete(
      `${base}/organisations/:organisation_id/workspace/scheduled-messages/:scheduled_message_id`,
      () => new HttpResponse(null, { status: 204, headers: headers() })
    ),
    http.post(
      `${base}/organisations/:organisation_id/workspace/channels/:channel_id/widgets/:widget_id/actions`,
      () =>
        HttpResponse.json(structuredClone(EXAMPLES.invokeChannelWidgetAction.body), {
          headers: { ...headers(), 'Idempotency-Replayed': 'false' },
        })
    ),
    http.post(`${base}/workspaces/self-serve`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const template = structuredClone(
        EXAMPLES.createSelfServeWorkspace.body as components['schemas']['SelfServeWorkspaceCreated']
      )
      const slug =
        typeof body['slug'] === 'string' && body['slug'].length >= 5
          ? body['slug']
          : template.organisation_slug
      return HttpResponse.json(
        {
          ...template,
          organisation_slug: slug,
          redirect_path: `/${slug}/workspace`,
        },
        { status: 201, headers: { ...headers(), 'Idempotency-Replayed': 'false' } }
      )
    }),
  ]
}
