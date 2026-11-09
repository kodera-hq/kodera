// In-memory conversations for the browser demo; never starts a client or contacts a homeserver.
import i18n from '../../i18n'
import { createLocalAudioCall } from './audioCall'
import { isMatrixUserId } from '../../features/espace/roomInvitations'
import type { EspaceStoreLike } from '../../features/espace/EspaceLiveView'
import type { EspaceSnapshot, MemberView, RoomSummary } from '../../features/espace/matrix/store'
import type { MessageView } from '../../features/espace/matrix/timeline'
import {
  everyChannel,
  type Workspace,
  type WorkspaceChannel,
} from '../../features/workspace/workspace'
import { workspaceDemoMessages } from './workspaceMessages'

const VIEWER = '@ines:demo.invalid'
const MEMBERS: readonly MemberView[] = [
  { userId: '@product:demo.invalid', name: 'Product Team' },
  { userId: '@engineering:demo.invalid', name: 'Engineering Team' },
  { userId: '@design:demo.invalid', name: 'Design Team' },
]
const EMPTY: readonly MessageView[] = []
const MAX_MESSAGES = 256

export function createLocalWorkspaceStore(
  workspace: Workspace,
  profile: 'vercelli' | 'community' = 'vercelli',
  persist = false
): EspaceStoreLike & { addChannel: (channel: WorkspaceChannel) => void } {
  const copy = workspaceDemoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const viewer = profile === 'community' ? '@member:demo.invalid' : VIEWER
  const members =
    profile === 'community'
      ? [
          { userId: '@maintainer:demo.invalid', name: 'Kodera Maintainer' },
          { userId: '@contributor:demo.invalid', name: 'SDK Contributor' },
        ]
      : MEMBERS
  const listeners = new Set<() => void>()
  const timelines = new Map<string, readonly MessageView[]>()
  const threads = new Map<string, readonly MessageView[]>()
  const channels = new Map<string, { state: 'resolved'; roomId: string }>()
  const roomMembers = new Map<string, readonly MemberView[]>()
  const markers = new Map<string, string>()
  let sequence = 0
  const message = (body: string, author?: MemberView): MessageView => {
    const eventId = `demo-message-${++sequence}`
    return {
      key: eventId,
      eventId,
      sender: author?.userId ?? viewer,
      senderName: author?.name ?? (profile === 'community' ? 'Community Member' : copy.viewer),
      body,
      ts: Date.now(),
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
    }
  }
  const rooms: RoomSummary[] = everyChannel(workspace)
    .filter((channel) => channel.room_state === 'ready')
    .map((channel) => {
      const roomId = `!${channel.id}:demo.invalid`
      roomMembers.set(roomId, [...members])
      channels.set(channel.id, { state: 'resolved', roomId })
      const conversation =
        profile === 'community'
          ? (copy.community[channel.name as keyof typeof copy.community] ?? [copy.welcome])
          : [copy.welcome]
      timelines.set(
        roomId,
        channel.kind === 'text'
          ? conversation.map((body, index) =>
              message(body, profile === 'community' ? members[index % members.length] : undefined)
            )
          : EMPTY
      )
      return {
        roomId,
        name: channel.name,
        alias: `#${channel.name.toLowerCase().replace(/\s+/g, '-')}:demo.invalid`,
        kind: channel.kind,
        unread: 0,
        mentions: 0,
        occupancy: null,
        joined: members.length + 1,
        faces: members,
      }
    })
  let snapshot: EspaceSnapshot = { status: 'live', rooms, channels, invites: [] }
  const storageKey = `kodera.demo.conversations.${workspace.organisation_id}`
  const save = () => {
    if (!persist) return
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          sequence,
          rooms: snapshot.rooms,
          timelines: [...timelines],
          threads: [...threads],
          channels: [...channels],
          members: [...roomMembers],
          markers: [...markers],
        })
      )
    } catch {
      /* An unavailable or full session store must not block messaging. */
    }
  }
  if (persist) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      if (validStoredConversations(stored)) {
        sequence = stored.sequence
        timelines.clear()
        threads.clear()
        channels.clear()
        roomMembers.clear()
        markers.clear()
        for (const [key, value] of stored.timelines) timelines.set(key, value)
        for (const [key, value] of stored.threads) threads.set(key, value)
        for (const [key, value] of stored.channels) channels.set(key, value)
        for (const [key, value] of stored.members) roomMembers.set(key, value)
        for (const [key, value] of stored.markers) markers.set(key, value)
        snapshot = { ...snapshot, rooms: stored.rooms, channels: new Map(channels) }
      }
    } catch {
      /* Corrupted browser state falls back to the fresh local fixture. */
    }
  }
  const emit = () => {
    snapshot = { ...snapshot }
    save()
    for (const listener of listeners) listener()
  }
  const updateMessage = (
    roomId: string,
    eventId: string,
    update: (value: MessageView) => MessageView
  ) => {
    timelines.set(
      roomId,
      (timelines.get(roomId) ?? EMPTY).map((value) =>
        value.eventId === eventId ? update(value) : value
      )
    )
    for (const [key, values] of threads) {
      if (key.startsWith(`${roomId}:`))
        threads.set(
          key,
          values.map((value) => (value.eventId === eventId ? update(value) : value))
        )
    }
    emit()
  }
  return {
    audioCall: createLocalAudioCall(viewer),
    addChannel(channel) {
      if (channels.has(channel.id)) return
      if (channel.room_state !== 'ready')
        throw new Error('Only ready channels can be added locally')
      const roomId = `!${channel.id}:demo.invalid`
      channels.set(channel.id, { state: 'resolved', roomId })
      roomMembers.set(roomId, [...members])
      timelines.set(roomId, EMPTY)
      snapshot = {
        ...snapshot,
        channels: new Map(channels),
        rooms: [
          ...snapshot.rooms,
          {
            roomId,
            name: channel.name,
            alias: `#${channel.name.toLowerCase().replace(/\s+/g, '-')}:demo.invalid`,
            kind: channel.kind,
            unread: 0,
            mentions: 0,
            occupancy: null,
            joined: members.length + 1,
            faces: members,
          },
        ],
      }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    getUserId: () => viewer,
    getTimeline: (roomId) => timelines.get(roomId) ?? EMPTY,
    getThread: (roomId, root) => threads.get(`${roomId}:${root}`) ?? EMPTY,
    getHistory: () => 'start',
    getMembers: (roomId) => roomMembers.get(roomId) ?? [],
    getRoster: (roomId) => roomMembers.get(roomId) ?? [],
    async inviteToRoom(roomId, userId) {
      if (!isMatrixUserId(userId)) throw new Error('Invalid Matrix user ID')
      const current = roomMembers.get(roomId)
      if (current === undefined) throw new Error('Unknown Matrix room')
      if (userId !== viewer && !current.some((member) => member.userId === userId)) {
        roomMembers.set(roomId, [...current, { userId }])
      }
      timelines.set(
        roomId,
        [
          ...(timelines.get(roomId) ?? EMPTY),
          message(i18n.t('console.workspace.channel-invite.success', { userId })),
        ].slice(-MAX_MESSAGES)
      )
      emit()
    },
    getMemberRole: () => 'member',
    isOnline: () => true,
    getReadMarker: (roomId) => markers.get(roomId) ?? null,
    async markRead(roomId) {
      const last = timelines.get(roomId)?.at(-1)?.eventId
      if (last) {
        markers.set(roomId, last)
        save()
      }
    },
    async send(roomId, body, options) {
      if (!timelines.has(roomId)) return
      const next = { ...message(body), replyTo: options?.replyTo ?? null }
      if (options?.threadRootId) {
        const key = `${roomId}:${options.threadRootId}`
        threads.set(key, [...(threads.get(key) ?? EMPTY), next].slice(-MAX_MESSAGES))
      } else {
        timelines.set(roomId, [...(timelines.get(roomId) ?? EMPTY), next].slice(-MAX_MESSAGES))
      }
      emit()
    },
    async edit(roomId, eventId, body) {
      updateMessage(roomId, eventId, (value) => ({ ...value, body, edited: true }))
    },
    async remove(roomId, eventId) {
      updateMessage(roomId, eventId, (value) => ({
        ...value,
        body: '',
        redacted: true,
        reactions: [],
      }))
    },
    async toggleReaction(roomId, eventId, key) {
      updateMessage(roomId, eventId, (value) => {
        const existing = value.reactions.find((reaction) => reaction.key === key)
        return {
          ...value,
          reactions: existing
            ? value.reactions.filter((reaction) => reaction.key !== key)
            : [...value.reactions, { key, count: 1, mine: true }],
        }
      })
    },
  }
}

interface StoredConversations {
  version: 1
  sequence: number
  rooms: RoomSummary[]
  timelines: [string, MessageView[]][]
  threads: [string, MessageView[]][]
  channels: [string, { state: 'resolved'; roomId: string }][]
  members: [string, MemberView[]][]
  markers: [string, string][]
}
function validStoredConversations(value: unknown): value is StoredConversations {
  if (!value || typeof value !== 'object') return false
  const data = value as StoredConversations
  const entries = (items: unknown, valid: (item: unknown) => boolean): boolean =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && valid(item[1])
    )
  const member = (item: unknown): boolean =>
    !!item && typeof item === 'object' && typeof (item as MemberView).userId === 'string'
  const messages = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.length <= MAX_MESSAGES &&
    items.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.body === 'string' &&
        typeof item.eventId === 'string' &&
        typeof item.sender === 'string' &&
        Number.isFinite(item.ts) &&
        Array.isArray(item.reactions)
    )
  return (
    data.version === 1 &&
    Number.isSafeInteger(data.sequence) &&
    data.sequence >= 0 &&
    Array.isArray(data.rooms) &&
    data.rooms.every(
      (room) =>
        room &&
        typeof room.roomId === 'string' &&
        typeof room.name === 'string' &&
        (room.kind === 'text' || room.kind === 'audio') &&
        Array.isArray(room.faces) &&
        room.faces.every(member)
    ) &&
    entries(data.timelines, messages) &&
    entries(data.threads, messages) &&
    entries(
      data.channels,
      (item) =>
        !!item &&
        typeof item === 'object' &&
        (item as { state?: unknown }).state === 'resolved' &&
        typeof (item as { roomId?: unknown }).roomId === 'string'
    ) &&
    entries(data.members, (items) => Array.isArray(items) && items.every(member)) &&
    entries(data.markers, (item) => typeof item === 'string')
  )
}
