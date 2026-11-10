// The workspace's pure rules (docs/specs/11-workspace.md): which screen a `getWorkspace` answer
// draws, how often it is read again, which label a starter row gets, which channel is current,
// and which `Idempotency-Key` the next creation attempt sends. No React, no client: each rule is
// tested on its own (`workspace.test.ts`).

import '../../validation-policy'
import type { TFunction } from 'i18next'
import { z } from 'zod'
import { ApiProblem } from '../../api/client'
import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'

export type Workspace = components['schemas']['Workspace']
export type WorkspaceCategory = components['schemas']['WorkspaceCategory']
export type WorkspaceChannel = components['schemas']['WorkspaceChannel']
export type TenantStatus = components['schemas']['TenantStatus']

// The contract's closed schemas, as far as the screen depends on them. An enum member this build
// does not know would otherwise be drawn as some other state; refused here, it is the error state.
const templateKey = z.string().nullable()
const channel = z.object({
  id: z.string().min(1),
  kind: z.enum(['text', 'audio']),
  name: z.string().min(1),
  template_key: templateKey,
  topic: z.string(),
  lifecycle: z.enum(['active', 'archived']),
  room_state: z.enum(['pending', 'ready', 'failed']),
})
const workspaceSchema = z.object({
  organisation_id: z.string().min(1),
  state: z.enum(['not_initialised', 'initialised']),
  setup: z.object({
    state: z.enum(['pending', 'running', 'ready', 'failed']),
    reason: z
      .enum(['awaiting_owner_confirmation', 'issuer_untrusted', 'realm_job_failed'])
      .nullable(),
  }),
  can_initialise: z.boolean(),
  id: z.string().nullable(),
  categories: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      template_key: templateKey,
      channels: z.array(channel),
    })
  ),
  uncategorised_channels: z.array(channel),
})

/** The answer, or a thrown error the query reports as a failed read. */
export function requireWorkspace(data: unknown): Workspace {
  const parsed = workspaceSchema.safeParse(data)
  if (!parsed.success) throw new Error('The workspace answer is not one the console can draw.')
  return data as Workspace
}

/** One screen per answer (§4.3). */
export type WorkspaceView =
  | { kind: 'preparing' }
  | { kind: 'confirming-owner' }
  | { kind: 'failed' }
  | { kind: 'ready-to-create' }
  | { kind: 'not-created' }
  | { kind: 'workspace'; workspace: Workspace }

export function workspaceView(workspace: Workspace): WorkspaceView {
  const { setup } = workspace
  // A stopped setup is said whatever the workspace's own state: an operator acts first.
  if (setup.state === 'failed') return { kind: 'failed' }
  if (workspace.state === 'initialised') return { kind: 'workspace', workspace }
  if (setup.state === 'ready') {
    // Setup is done; what is missing is a person who may create the workspace. Nothing is
    // running, so this is not « en préparation ».
    return workspace.can_initialise ? { kind: 'ready-to-create' } : { kind: 'not-created' }
  }
  if (setup.reason === 'awaiting_owner_confirmation') return { kind: 'confirming-owner' }
  return { kind: 'preparing' }
}

const PREPARING_MS = 10_000
const WAITING_ON_A_PERSON_MS = 60_000

/** Every channel of the workspace, text and audio, in the stored order. */
export function everyChannel(workspace: Workspace): WorkspaceChannel[] {
  return [
    ...workspace.categories.flatMap((category) => category.channels),
    ...workspace.uncategorised_channels,
  ]
}

/** The workspace as drawn while its tenant is prepared: no room can be used before the homeserver
 * exists, whatever each room's own state says (quick-workspace W2). */
export function withEveryRoomPending(workspace: Workspace): Workspace {
  const pending = (channel: WorkspaceChannel): WorkspaceChannel => ({
    ...channel,
    room_state: 'pending',
  })
  return {
    ...workspace,
    categories: workspace.categories.map((category) => ({
      ...category,
      channels: category.channels.map(pending),
    })),
    uncategorised_channels: workspace.uncategorised_channels.map(pending),
  }
}

/** How long until the next read, or `false` for none. Nothing reads while the tab is hidden. */
export function workspaceRefetchInterval(
  view: WorkspaceView | undefined,
  hidden: boolean
): number | false {
  if (hidden || view === undefined) return false
  switch (view.kind) {
    case 'preparing':
      return PREPARING_MS
    case 'confirming-owner':
    case 'failed':
    case 'not-created':
      return WAITING_ON_A_PERSON_MS
    case 'ready-to-create':
      return false
    case 'workspace': {
      // A room the tenant agent has not created yet arrives within seconds of its enrolment
      // (quick-workspace SPEC W2); one that failed waits on an operator, so it is read less often.
      const rooms = everyChannel(view.workspace).map((channel) => channel.room_state)
      if (rooms.includes('pending')) return PREPARING_MS
      if (rooms.includes('failed')) return WAITING_ON_A_PERSON_MS
      return false
    }
  }
}

/**
 * What the tenant's status means for the workspace (quick-workspace SPEC §2.5, W2): `preparing`
 * while its homeserver does not exist yet, so nothing may start a Matrix sign-in; `failed` when
 * an operator must act; `closed` when it is suspended or being removed, so its homeserver is not
 * one to sign in to either; `open` otherwise.
 */
export type TenantPhase = 'preparing' | 'failed' | 'closed' | 'open'

/** What the workspace reads of the organisation's tenant: the rest of the row is not its concern. */
export interface WorkspaceTenant {
  hostingMode?: 'community' | 'cloud-shared' | 'cloud-dedicated' | undefined
  hosting_mode?: 'community' | 'cloud-shared' | 'cloud-dedicated' | undefined
  slug: string
  status: TenantStatus
}

const tenantSchema = z.object({
  hostingMode: z.enum(['community', 'cloud-shared', 'cloud-dedicated']).optional().catch(undefined),
  hosting_mode: z
    .enum(['community', 'cloud-shared', 'cloud-dedicated'])
    .optional()
    .catch(undefined),
  slug: z.string().min(1),
  status: z.enum([
    'ordered',
    'provisioning',
    'ready',
    'active',
    'upgrading',
    'maintenance',
    'suspended',
    'decommissioning',
    'deleted',
    'failed',
  ]),
})

/** The tenant, or a thrown error the query reports as a failed read: a status this build does
 * not know is never taken for an open homeserver. */
export function requireTenant(data: unknown): WorkspaceTenant {
  const parsed = tenantSchema.safeParse(data)
  if (!parsed.success) throw new Error('The tenant answer is not one the workspace can use.')
  return { slug: parsed.data.slug, status: parsed.data.status }
}

/** How long until the tenant is read again: every 10 s while an operator prepares it, every
 * minute while it waits on one (`ordered`, `failed`), never otherwise or when there is none. */
export function tenantRefetchInterval(
  tenant: WorkspaceTenant | null | undefined,
  hidden: boolean
): number | false {
  if (hidden || tenant === undefined || tenant === null) return false
  switch (tenant.status) {
    case 'provisioning':
    case 'ready':
      return PREPARING_MS
    case 'ordered':
    case 'failed':
      return WAITING_ON_A_PERSON_MS
    default:
      return false
  }
}

export function tenantPhase(status: TenantStatus): TenantPhase {
  switch (status) {
    case 'ordered':
    case 'provisioning':
    case 'ready':
      return 'preparing'
    case 'failed':
      return 'failed'
    case 'suspended':
    case 'decommissioning':
    case 'deleted':
      return 'closed'
    default:
      return 'open'
  }
}

/** A channel whose Matrix room exists: the only kind a member can open (`room_state`). */
export function channelUsable(channel: WorkspaceChannel): boolean {
  return channel.room_state === 'ready'
}

/** The starter `welcome` channel, when its room exists: where a first sign-in lands. */
export function welcomeChannel(workspace: Workspace): WorkspaceChannel | undefined {
  return everyChannel(workspace).find(
    (channel) =>
      channel.template_key === 'welcome' && channel.kind === 'text' && channelUsable(channel)
  )
}

// The starter template's rows (Core's PILOT_WORKSPACE_ONBOARDING.md §2), namespaced by kind: the
// category and the channel both keyed `general` have two labels. An open set: a key that is not
// here, or no key, shows the stored name.
const CATEGORY_LABELS = {
  general: 'console.workspace.category.general',
  team: 'console.workspace.category.team',
} as const satisfies Record<string, MessageKey>

const CHANNEL_LABELS = {
  welcome: 'console.workspace.channel.welcome',
  general: 'console.workspace.channel.general',
  lounge: 'console.workspace.channel.lounge',
} as const satisfies Record<string, MessageKey>

function labelOf(
  labels: Readonly<Record<string, MessageKey>>,
  row: { name: string; template_key: string | null },
  t: TFunction
): string {
  const key = row.template_key
  // `Object.hasOwn`: a key from the network can be `toString`, which a plain lookup would find.
  return key !== null && Object.hasOwn(labels, key) ? t(labels[key]!) : row.name
}

export function categoryLabel(category: WorkspaceCategory, t: TFunction): string {
  return labelOf(CATEGORY_LABELS, category, t)
}

export function channelLabel(channel: WorkspaceChannel, t: TFunction): string {
  return labelOf(CHANNEL_LABELS, channel, t)
}

/** Text channels only: audio channels are listed by a later slice. */
export function listedChannels(channels: readonly WorkspaceChannel[]): WorkspaceChannel[] {
  return channels.filter((entry) => entry.kind === 'text')
}

/** Every listed channel, in the order the sidebar draws them. */
export function channelsInOrder(workspace: Workspace): WorkspaceChannel[] {
  return [
    ...workspace.categories.flatMap((category) => listedChannels(category.channels)),
    ...listedChannels(workspace.uncategorised_channels),
  ]
}

/** The current channel: the one the address names, else the first. `null` when the address
 * names one the caller cannot see, `undefined` when there is no channel at all. */
export function currentChannel(
  workspace: Workspace,
  channelId: string | undefined
): WorkspaceChannel | null | undefined {
  const channels = channelsInOrder(workspace)
  if (channelId === undefined) return channels[0]
  return channels.find((entry) => entry.id === channelId) ?? null
}

/**
 * The key the next creation attempt sends (§4.3, the contract's retry rule): the same one only
 * when the outcome is unknown — a `5xx` or a network failure — and a new one after any `4xx`,
 * whose answer is final for that key.
 */
export function keyAfterFailure(error: unknown, key: string, fresh: () => string): string {
  if (error instanceof ApiProblem && error.status >= 400 && error.status < 500) return fresh()
  return key
}

/** A `409`: the last read is stale, so the screen reads again before anything else. */
export function isStaleRead(error: unknown): boolean {
  return error instanceof ApiProblem && error.status === 409
}

/** A `404` from a Core that does not serve `getWorkspace` yet is an answer, not a dropped
 * response: asking again changes nothing. Any other failure keeps the client's two retries. */
export function retryWorkspaceRead(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiProblem && error.status === 404) return false
  return failureCount < 2
}
