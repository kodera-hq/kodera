// Typed Core API wrapper and reactive stores for Custom Emojis, Send Later, Reminders, and Kodera Labs.
// Calls `coreApi().VERB(path, ...)` directly against the generated 0.59.0 contract types.

import { useEffect, useSyncExternalStore } from 'react'
import { ApiProblem, coreApi } from '../../api/client'
import {
  registerEspaceVaultCleanup,
  registerLocalSessionCleanup,
  registerOrganisationSwitchCleanup,
} from '../../auth/localSession'

export type LabsFlagKey =
  | 'send_later'
  | 'custom_emojis'
  | 'personal_reminders'
  | 'waiting_room_ambience'

export type LabsFlags = Record<LabsFlagKey, boolean>

export const DEFAULT_LABS_FLAGS: LabsFlags = Object.freeze({
  send_later: true,
  custom_emojis: true,
  personal_reminders: true,
  waiting_room_ambience: true,
})

export interface WorkspaceCustomEmojiItem {
  readonly id: string
  readonly shortcode: string
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly animated: boolean
  readonly creatorMembershipId: string
  readonly createdAt: string | null
  readonly blobPath: string
}

export interface ScheduledMessageItem {
  readonly id: string
  readonly channelId: string | null
  readonly roomId: string
  readonly body: string
  readonly mentions: readonly string[]
  readonly threadRootEventId: string | null
  readonly deliverAt: string
  readonly matrixTxnId: string
  readonly matrixEventId: string | null
  readonly state: 'pending' | 'in_flight' | 'delivered' | 'cancelled' | 'refused_policy' | 'obsolete'
  readonly failureReason: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface PersonalReminderItem {
  readonly id: string
  readonly channelId: string | null
  readonly roomId: string
  readonly targetEventId: string
  readonly note: string
  readonly remindAt: string
  readonly state:
    | 'pending'
    | 'in_flight'
    | 'fired'
    | 'snoozed'
    | 'completed'
    | 'cancelled'
    | 'obsolete'
  readonly notificationId: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface MemberWorkspacePreferences {
  readonly labsFlags: LabsFlags
  readonly waitingRoomAmbience: boolean
  readonly updatedAt: string | null
}

function nextIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseCustomEmoji(raw: unknown): WorkspaceCustomEmojiItem | null {
  if (!isObject(raw)) return null
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  const shortcode = typeof raw['shortcode'] === 'string' ? raw['shortcode'] : ''
  const sha256 = typeof raw['sha256'] === 'string' ? raw['sha256'] : ''
  if (!id || !shortcode) return null
  return {
    id,
    shortcode,
    sha256,
    width: typeof raw['width'] === 'number' ? raw['width'] : 64,
    height: typeof raw['height'] === 'number' ? raw['height'] : 64,
    animated: raw['animated'] === true,
    creatorMembershipId:
      typeof raw['creatorMembershipId'] === 'string' ? raw['creatorMembershipId'] : '',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : null,
    blobPath: typeof raw['blobPath'] === 'string' ? raw['blobPath'] : '',
  }
}

function parseScheduledMessage(raw: unknown): ScheduledMessageItem | null {
  if (!isObject(raw)) return null
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  const body = typeof raw['body'] === 'string' ? raw['body'] : ''
  const deliverAt = typeof raw['deliverAt'] === 'string' ? raw['deliverAt'] : ''
  if (!id || !deliverAt) return null
  const stateRaw = raw['state']
  const state: ScheduledMessageItem['state'] =
    stateRaw === 'pending' ||
    stateRaw === 'in_flight' ||
    stateRaw === 'delivered' ||
    stateRaw === 'cancelled' ||
    stateRaw === 'refused_policy' ||
    stateRaw === 'obsolete'
      ? stateRaw
      : 'pending'
  return {
    id,
    channelId: typeof raw['channelId'] === 'string' ? raw['channelId'] : null,
    roomId: typeof raw['roomId'] === 'string' ? raw['roomId'] : '',
    body,
    mentions: Array.isArray(raw['mentions'])
      ? raw['mentions'].filter((m): m is string => typeof m === 'string')
      : [],
    threadRootEventId:
      typeof raw['threadRootEventId'] === 'string' ? raw['threadRootEventId'] : null,
    deliverAt,
    matrixTxnId: typeof raw['matrixTxnId'] === 'string' ? raw['matrixTxnId'] : '',
    matrixEventId: typeof raw['matrixEventId'] === 'string' ? raw['matrixEventId'] : null,
    state,
    failureReason: typeof raw['failureReason'] === 'string' ? raw['failureReason'] : null,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : null,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
  }
}

function parseReminder(raw: unknown): PersonalReminderItem | null {
  if (!isObject(raw)) return null
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  const targetEventId = typeof raw['targetEventId'] === 'string' ? raw['targetEventId'] : ''
  const remindAt = typeof raw['remindAt'] === 'string' ? raw['remindAt'] : ''
  if (!id || !targetEventId || !remindAt) return null
  const stateRaw = raw['state']
  const state: PersonalReminderItem['state'] =
    stateRaw === 'pending' ||
    stateRaw === 'in_flight' ||
    stateRaw === 'fired' ||
    stateRaw === 'snoozed' ||
    stateRaw === 'completed' ||
    stateRaw === 'cancelled' ||
    stateRaw === 'obsolete'
      ? stateRaw
      : 'pending'
  return {
    id,
    channelId: typeof raw['channelId'] === 'string' ? raw['channelId'] : null,
    roomId: typeof raw['roomId'] === 'string' ? raw['roomId'] : '',
    targetEventId,
    note: typeof raw['note'] === 'string' ? raw['note'] : '',
    remindAt,
    state,
    notificationId: typeof raw['notificationId'] === 'string' ? raw['notificationId'] : null,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : null,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
  }
}

export function parsePreferences(raw: unknown): MemberWorkspacePreferences {
  if (!isObject(raw)) {
    return {
      labsFlags: { ...DEFAULT_LABS_FLAGS },
      waitingRoomAmbience: false,
      updatedAt: null,
    }
  }
  const rawFlags = isObject(raw['labsFlags']) ? raw['labsFlags'] : {}
  const labsFlags: LabsFlags = {
    send_later:
      typeof rawFlags['send_later'] === 'boolean'
        ? rawFlags['send_later']
        : DEFAULT_LABS_FLAGS.send_later,
    custom_emojis:
      typeof rawFlags['custom_emojis'] === 'boolean'
        ? rawFlags['custom_emojis']
        : DEFAULT_LABS_FLAGS.custom_emojis,
    personal_reminders:
      typeof rawFlags['personal_reminders'] === 'boolean'
        ? rawFlags['personal_reminders']
        : DEFAULT_LABS_FLAGS.personal_reminders,
    waiting_room_ambience:
      typeof rawFlags['waiting_room_ambience'] === 'boolean'
        ? rawFlags['waiting_room_ambience']
        : DEFAULT_LABS_FLAGS.waiting_room_ambience,
  }
  return {
    labsFlags,
    waitingRoomAmbience: raw['waitingRoomAmbience'] === true,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
  }
}

export function isUnsupportedEndpointError(error: unknown): boolean {
  return (
    error instanceof ApiProblem &&
    (error.status === 405 || error.status === 501 || (error.status === 404 && error.type === null))
  )
}

// --------------------------------------------------------------------------- Custom Emojis ---

export async function listWorkspaceCustomEmojis(
  organisationId: string,
  signal?: AbortSignal
): Promise<WorkspaceCustomEmojiItem[]> {
  try {
    const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/emojis', {
      params: { path: { organisation_id: organisationId } },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!isObject(data) || !Array.isArray(data['items'])) return []
    return data['items']
      .map(parseCustomEmoji)
      .filter((item): item is WorkspaceCustomEmojiItem => item !== null)
  } catch (error) {
    if (isUnsupportedEndpointError(error)) return []
    throw error
  }
}

export async function createWorkspaceCustomEmoji(
  organisationId: string,
  payload: { shortcode: string; webpBase64: string }
): Promise<WorkspaceCustomEmojiItem> {
  const { data } = await coreApi().POST('/organisations/{organisation_id}/workspace/emojis', {
    params: {
      path: { organisation_id: organisationId },
      header: { 'Idempotency-Key': nextIdempotencyKey() },
    },
    body: { shortcode: payload.shortcode, webpBase64: payload.webpBase64 },
  })
  const parsed = parseCustomEmoji(data)
  if (parsed === null) throw new Error('Malformed custom emoji response')
  return parsed
}

export async function deleteWorkspaceCustomEmoji(
  organisationId: string,
  emojiId: string
): Promise<void> {
  await coreApi().DELETE('/organisations/{organisation_id}/workspace/emojis/{emoji_id}', {
    params: { path: { organisation_id: organisationId, emoji_id: emojiId } },
  })
}

export async function fetchWorkspaceCustomEmojiBlob(
  organisationId: string,
  emojiId: string,
  signal?: AbortSignal
): Promise<Blob> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/emojis/{emoji_id}/blob',
    {
      params: { path: { organisation_id: organisationId, emoji_id: emojiId } },
      parseAs: 'arrayBuffer',
      ...(signal === undefined ? {} : { signal }),
    }
  )
  const buffer = data as ArrayBuffer | undefined
  if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength === 0) {
    throw new Error('Empty custom emoji WebP blob')
  }
  return new Blob([new Uint8Array(buffer)], { type: 'image/webp' })
}

// ---------------------------------------------------------------------- Scheduled Messages ---

export async function listScheduledMessages(
  organisationId: string,
  channelId?: string
): Promise<ScheduledMessageItem[]> {
  try {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/scheduled-messages',
      {
        params: {
          path: { organisation_id: organisationId },
          ...(channelId ? { query: { channel_id: channelId } } : {}),
        },
      }
    )
    if (!isObject(data) || !Array.isArray(data['items'])) return []
    return data['items']
      .map(parseScheduledMessage)
      .filter((item): item is ScheduledMessageItem => item !== null)
  } catch (error) {
    if (isUnsupportedEndpointError(error)) return []
    throw error
  }
}

const scheduledEtagById = new Map<string, string>()
const reminderEtagById = new Map<string, string>()
const prefsEtagByOrg = new Map<string, string>()

export async function createScheduledMessage(
  organisationId: string,
  payload: {
    channelId?: string | null | undefined
    roomId?: string | undefined
    body: string
    mentions?: readonly string[] | undefined
    threadRootEventId?: string | null | undefined
    deliverAt: string
  }
): Promise<ScheduledMessageItem> {
  const { data, response } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/scheduled-messages',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': nextIdempotencyKey() },
      },
      body: {
        ...(payload.channelId
          ? { channelId: payload.channelId }
          : payload.roomId
            ? { roomId: payload.roomId }
            : {}),
        body: payload.body,
        ...(payload.mentions && payload.mentions.length > 0
          ? { mentions: [...payload.mentions] }
          : {}),
        ...(payload.threadRootEventId ? { threadRootEventId: payload.threadRootEventId } : {}),
        deliverAt: payload.deliverAt,
      },
    }
  )
  const parsed = parseScheduledMessage(data)
  if (parsed === null) throw new Error('Malformed scheduled message response')
  const etag = response.headers.get('ETag')
  if (etag) scheduledEtagById.set(parsed.id, etag)
  notifyScheduledChanged(organisationId)
  return parsed
}

export async function updateScheduledMessage(
  organisationId: string,
  scheduledMessageId: string,
  patch: { body?: string; deliverAt?: string; mentions?: readonly string[] }
): Promise<ScheduledMessageItem> {
  const ifMatch = scheduledEtagById.get(scheduledMessageId) ?? '*'
  const { data, response } = await coreApi().PATCH(
    '/organisations/{organisation_id}/workspace/scheduled-messages/{scheduled_message_id}',
    {
      params: {
        path: { organisation_id: organisationId, scheduled_message_id: scheduledMessageId },
        header: { 'If-Match': ifMatch },
      },
      body: {
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.deliverAt !== undefined ? { deliverAt: patch.deliverAt } : {}),
        ...(patch.mentions !== undefined ? { mentions: [...patch.mentions] } : {}),
      },
    }
  )
  const parsed = parseScheduledMessage(data)
  if (parsed === null) throw new Error('Malformed scheduled message response')
  const etag = response.headers.get('ETag')
  if (etag) scheduledEtagById.set(parsed.id, etag)
  notifyScheduledChanged(organisationId)
  return parsed
}

export async function cancelScheduledMessage(
  organisationId: string,
  scheduledMessageId: string
): Promise<void> {
  await coreApi().DELETE(
    '/organisations/{organisation_id}/workspace/scheduled-messages/{scheduled_message_id}',
    {
      params: {
        path: { organisation_id: organisationId, scheduled_message_id: scheduledMessageId },
      },
    }
  )
  scheduledEtagById.delete(scheduledMessageId)
  notifyScheduledChanged(organisationId)
}

// ---------------------------------------------------------------------- Personal Reminders ---

export async function listPersonalReminders(
  organisationId: string,
  includeCompleted = false
): Promise<PersonalReminderItem[]> {
  try {
    const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/reminders', {
      params: {
        path: { organisation_id: organisationId },
        ...(includeCompleted ? { query: { include_completed: 'true' } } : {}),
      },
    })
    if (!isObject(data) || !Array.isArray(data['items'])) return []
    return data['items']
      .map(parseReminder)
      .filter((item): item is PersonalReminderItem => item !== null)
  } catch (error) {
    if (isUnsupportedEndpointError(error)) return []
    throw error
  }
}

export async function createPersonalReminder(
  organisationId: string,
  payload: {
    channelId?: string | null | undefined
    roomId?: string | undefined
    targetEventId: string
    note?: string | undefined
    remindAt: string
  }
): Promise<PersonalReminderItem> {
  const { data, response } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/reminders',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': nextIdempotencyKey() },
      },
      body: {
        ...(payload.channelId
          ? { channelId: payload.channelId }
          : payload.roomId
            ? { roomId: payload.roomId }
            : {}),
        targetEventId: payload.targetEventId,
        ...(payload.note !== undefined ? { note: payload.note } : {}),
        remindAt: payload.remindAt,
      },
    }
  )
  const parsed = parseReminder(data)
  if (parsed === null) throw new Error('Malformed personal reminder response')
  const etag = response.headers.get('ETag')
  if (etag) reminderEtagById.set(parsed.id, etag)
  notifyRemindersChanged(organisationId)
  return parsed
}

export async function updatePersonalReminder(
  organisationId: string,
  reminderId: string,
  patch: { note?: string; remindAt?: string; state?: 'completed' | 'cancelled' | 'snoozed' }
): Promise<PersonalReminderItem> {
  const ifMatch = reminderEtagById.get(reminderId) ?? '*'
  const { data, response } = await coreApi().PATCH(
    '/organisations/{organisation_id}/workspace/reminders/{reminder_id}',
    {
      params: {
        path: { organisation_id: organisationId, reminder_id: reminderId },
        header: { 'If-Match': ifMatch },
      },
      body: {
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.remindAt !== undefined ? { remindAt: patch.remindAt } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
      },
    }
  )
  const parsed = parseReminder(data)
  if (parsed === null) throw new Error('Malformed personal reminder response')
  const etag = response.headers.get('ETag')
  if (etag) reminderEtagById.set(parsed.id, etag)
  notifyRemindersChanged(organisationId)
  return parsed
}

export async function deletePersonalReminder(
  organisationId: string,
  reminderId: string
): Promise<void> {
  await coreApi().DELETE('/organisations/{organisation_id}/workspace/reminders/{reminder_id}', {
    params: { path: { organisation_id: organisationId, reminder_id: reminderId } },
  })
  reminderEtagById.delete(reminderId)
  notifyRemindersChanged(organisationId)
}

// ------------------------------------------------ Reactive Preferences & Event Stores ---

const DEFAULT_PREFS: MemberWorkspacePreferences = Object.freeze({
  labsFlags: DEFAULT_LABS_FLAGS,
  waitingRoomAmbience: false,
  updatedAt: null,
})

const prefsByOrg = new Map<string, MemberWorkspacePreferences>()
const prefsLoadedOrgs = new Set<string>()
const prefsInFlight = new Map<string, Promise<MemberWorkspacePreferences>>()
const prefsListeners = new Set<() => void>()

const scheduledRevisionByOrg = new Map<string, number>()
const scheduledListeners = new Set<() => void>()

const remindersRevisionByOrg = new Map<string, number>()
const remindersListeners = new Set<() => void>()

function emitPrefs(): void {
  for (const listener of prefsListeners) listener()
}

function notifyScheduledChanged(organisationId: string): void {
  scheduledRevisionByOrg.set(organisationId, (scheduledRevisionByOrg.get(organisationId) ?? 0) + 1)
  for (const listener of scheduledListeners) listener()
}

function notifyRemindersChanged(organisationId: string): void {
  remindersRevisionByOrg.set(organisationId, (remindersRevisionByOrg.get(organisationId) ?? 0) + 1)
  for (const listener of remindersListeners) listener()
}

export function subscribeScheduledRevision(listener: () => void): () => void {
  scheduledListeners.add(listener)
  return () => scheduledListeners.delete(listener)
}

export function getScheduledRevision(organisationId: string | null): number {
  if (!organisationId) return 0
  return scheduledRevisionByOrg.get(organisationId) ?? 0
}

export function subscribeRemindersRevision(listener: () => void): () => void {
  remindersListeners.add(listener)
  return () => remindersListeners.delete(listener)
}

export function getRemindersRevision(organisationId: string | null): number {
  if (!organisationId) return 0
  return remindersRevisionByOrg.get(organisationId) ?? 0
}

let globalPrefsGeneration = 0
const orgPrefsGenerations = new Map<string, number>()

function currentPrefsGeneration(organisationId: string): string {
  return `${globalPrefsGeneration}:${orgPrefsGenerations.get(organisationId) ?? 0}`
}

export async function loadMyWorkspacePreferences(
  organisationId: string,
  force = false
): Promise<MemberWorkspacePreferences> {
  if (!force && prefsLoadedOrgs.has(organisationId)) {
    return prefsByOrg.get(organisationId) ?? DEFAULT_PREFS
  }
  const existing = prefsInFlight.get(organisationId)
  if (existing !== undefined && !force) return existing

  const startGen = currentPrefsGeneration(organisationId)
  const task = (async () => {
    try {
      const { data, response } = await coreApi().GET(
        '/organisations/{organisation_id}/workspace/preferences/me',
        { params: { path: { organisation_id: organisationId } } }
      )
      if (currentPrefsGeneration(organisationId) !== startGen) {
        return DEFAULT_PREFS
      }
      const parsed = parsePreferences(data)
      const etag = response.headers.get('ETag')
      if (etag) prefsEtagByOrg.set(organisationId, etag)
      prefsByOrg.set(organisationId, parsed)
      prefsLoadedOrgs.add(organisationId)
      emitPrefs()
      return parsed
    } catch (error) {
      if (currentPrefsGeneration(organisationId) !== startGen) {
        return DEFAULT_PREFS
      }
      if (isUnsupportedEndpointError(error)) {
        prefsByOrg.set(organisationId, DEFAULT_PREFS)
        prefsLoadedOrgs.add(organisationId)
        return DEFAULT_PREFS
      }
      return prefsByOrg.get(organisationId) ?? DEFAULT_PREFS
    } finally {
      if (currentPrefsGeneration(organisationId) === startGen) {
        prefsInFlight.delete(organisationId)
      }
    }
  })()

  prefsInFlight.set(organisationId, task)
  return task
}

export async function updateMyWorkspacePreferences(
  organisationId: string,
  patch: {
    labsFlags?: Partial<LabsFlags>
    waitingRoomAmbience?: boolean
  }
): Promise<MemberWorkspacePreferences> {
  const ifMatch = prefsEtagByOrg.get(organisationId) ?? '*'
  const { data, response } = await coreApi().PATCH(
    '/organisations/{organisation_id}/workspace/preferences/me',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'If-Match': ifMatch },
      },
      body: {
        ...(patch.labsFlags !== undefined ? { labsFlags: patch.labsFlags } : {}),
        ...(patch.waitingRoomAmbience !== undefined
          ? { waitingRoomAmbience: patch.waitingRoomAmbience }
          : {}),
      },
    }
  )
  const parsed = parsePreferences(data)
  const etag = response.headers.get('ETag')
  if (etag) prefsEtagByOrg.set(organisationId, etag)
  prefsByOrg.set(organisationId, parsed)
  prefsLoadedOrgs.add(organisationId)
  emitPrefs()
  return parsed
}

export function setCachedWorkspacePreferencesForTest(
  organisationId: string,
  prefs: MemberWorkspacePreferences
): void {
  prefsByOrg.set(organisationId, prefs)
  prefsEtagByOrg.delete(organisationId)
  prefsLoadedOrgs.add(organisationId)
  emitPrefs()
}

export function clearOrganisationExperienceStore(organisationId: string): void {
  orgPrefsGenerations.set(organisationId, (orgPrefsGenerations.get(organisationId) ?? 0) + 1)
  prefsByOrg.delete(organisationId)
  prefsLoadedOrgs.delete(organisationId)
  prefsInFlight.delete(organisationId)
  prefsEtagByOrg.delete(organisationId)
  scheduledRevisionByOrg.delete(organisationId)
  remindersRevisionByOrg.delete(organisationId)
  emitPrefs()
}

export function clearExperienceStores(): void {
  globalPrefsGeneration += 1
  orgPrefsGenerations.clear()
  prefsByOrg.clear()
  prefsLoadedOrgs.clear()
  prefsInFlight.clear()
  prefsEtagByOrg.clear()
  scheduledEtagById.clear()
  reminderEtagById.clear()
  scheduledRevisionByOrg.clear()
  remindersRevisionByOrg.clear()
  emitPrefs()
}

registerLocalSessionCleanup(clearExperienceStores)
registerEspaceVaultCleanup(clearExperienceStores)
registerOrganisationSwitchCleanup(clearOrganisationExperienceStore)

const subscribePrefs = (listener: () => void) => {
  prefsListeners.add(listener)
  return () => {
    prefsListeners.delete(listener)
  }
}

export function useExperiencePreferences(
  organisationId: string | null,
  options?: { autoFetch?: boolean }
): MemberWorkspacePreferences {
  const snapshot = useSyncExternalStore(subscribePrefs, () =>
    organisationId ? (prefsByOrg.get(organisationId) ?? DEFAULT_PREFS) : DEFAULT_PREFS
  )
  const autoFetch = options?.autoFetch ?? false
  useEffect(() => {
    if (organisationId && autoFetch && !prefsLoadedOrgs.has(organisationId)) {
      void loadMyWorkspacePreferences(organisationId)
    }
  }, [organisationId, autoFetch])
  return snapshot
}
