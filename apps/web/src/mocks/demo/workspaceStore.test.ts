import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import {
  createDemoWorkspaceStore,
  isDemoActive,
  registerInteractiveDemo,
} from '../../app/interactiveDemo'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import { createLocalWorkspaceStore } from './workspaceStore'
import {
  demoIncidents,
  demoStatusComponents,
  demoStatusSummary,
  demoTenantStatus,
} from './interactiveStatus'

const demo = { slug: 'vercelli', createStore: createLocalWorkspaceStore }
afterEach(() => registerInteractiveDemo(undefined))

describe('interactive demo isolation', () => {
  it('requires bootstrap registration and isolates the selected organisation', () => {
    expect(isDemoActive()).toBe(false)
    expect(createDemoWorkspaceStore('vercelli', readyWorkspace())).toBeUndefined()
    registerInteractiveDemo(demo)
    expect(isDemoActive('vercelli')).toBe(true)
    expect(isDemoActive('other')).toBe(false)
    expect(createDemoWorkspaceStore('other', readyWorkspace())).toBeUndefined()
    expect(createDemoWorkspaceStore('vercelli', readyWorkspace())).toBeDefined()
    registerInteractiveDemo(undefined)
    expect(isDemoActive()).toBe(false)
  })

  it('starts operational without changing the incident scenario fixture', () => {
    const now = new Date('2026-11-09T12:00:00Z')
    expect(demoStatusSummary(now).overall).toBe('degraded')
    expect(demoIncidents(now)).toHaveLength(1)
    registerInteractiveDemo(demo)
    expect(demoStatusSummary(now)).toMatchObject({ overall: 'operational', open_incident_ids: [] })
    expect(demoIncidents(now)).toEqual([])
    expect(
      demoStatusComponents(now).every(
        (component) => component.state === 'operational' && component.incident_ref === null
      )
    ).toBe(true)
    expect(demoTenantStatus(now).components).toEqual(demoStatusComponents(now))
  })
})

describe('local workspace conversations', () => {
  it('resolves only ready rooms and keeps stable snapshots between changes', () => {
    const workspace = readyWorkspace()
    const store = createLocalWorkspaceStore(workspace)
    const snapshot = store.getSnapshot()
    expect(store.getSnapshot()).toBe(snapshot)
    const all = [
      ...workspace.categories.flatMap((category) => category.channels),
      ...workspace.uncategorised_channels,
    ]
    expect([...snapshot.channels.keys()]).toEqual(
      all.filter((channel) => channel.room_state === 'ready').map((channel) => channel.id)
    )
    for (const room of snapshot.rooms.filter((room) => room.kind === 'text')) {
      expect(store.getTimeline(room.roomId)[0]?.body).toContain('Bienvenue')
      expect(store.getTimeline(room.roomId)).toBe(store.getTimeline(room.roomId))
    }
    expect(store.getThread('missing', 'missing')).toBe(store.getThread('missing', 'missing'))
  })

  it('sends, replies, edits, reacts and deletes locally without sharing state across mounts', async () => {
    const store = createLocalWorkspaceStore(readyWorkspace())
    const other = createLocalWorkspaceStore(readyWorkspace())
    const room = store.getSnapshot().rooms.find((entry) => entry.kind === 'text')!.roomId
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const before = store.getTimeline(room)
    await store.send(room, 'Local message')
    const sent = store.getTimeline(room).at(-1)!
    expect(sent).toMatchObject({ body: 'Local message', delivery: 'sent' })
    expect(other.getTimeline(room)).toHaveLength(before.length)
    await store.send(room, 'Local reply', { replyTo: sent.eventId! })
    expect(store.getTimeline(room).at(-1)?.replyTo).toBe(sent.eventId)
    await store.send(room, 'Thread reply', { threadRootId: sent.eventId! })
    expect(store.getThread(room, sent.eventId!)).toHaveLength(1)
    await store.edit(room, sent.eventId!, 'Updated')
    expect(
      store.getTimeline(room).find((message) => message.eventId === sent.eventId)
    ).toMatchObject({ body: 'Updated', edited: true })
    await store.toggleReaction(room, sent.eventId!, '👍')
    expect(
      store.getTimeline(room).find((message) => message.eventId === sent.eventId)?.reactions
    ).toEqual([{ key: '👍', mine: true, count: 1 }])
    await store.toggleReaction(room, sent.eventId!, '👍')
    expect(
      store.getTimeline(room).find((message) => message.eventId === sent.eventId)?.reactions
    ).toEqual([])
    await store.remove(room, sent.eventId!)
    expect(
      store.getTimeline(room).find((message) => message.eventId === sent.eventId)
    ).toMatchObject({ body: '', redacted: true })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    await store.send(room, 'After unsubscribe')
    expect(listener).not.toHaveBeenCalled()
  })
})

it('adds a channel without losing conversations and immediately accepts messages', async () => {
  const store = createLocalWorkspaceStore(readyWorkspace(), 'community')
  const original = store.getSnapshot().rooms[0]!
  await store.send(original.roomId, 'Keep this conversation')
  const previous = store.getSnapshot()
  store.addChannel({
    id: 'new-room',
    name: 'new-room',
    kind: 'text',
    template_key: null,
    topic: '',
    lifecycle: 'active',
    room_state: 'ready',
  })
  const resolution = store.getSnapshot().channels.get('new-room')!
  expect(resolution.state).toBe('resolved')
  if (resolution.state !== 'resolved') throw new Error('Channel was not resolved')
  await store.send(resolution.roomId, 'First message')
  expect(store.getTimeline(resolution.roomId).at(-1)?.body).toBe('First message')
  expect(store.getTimeline(original.roomId).at(-1)?.body).toBe('Keep this conversation')
  expect(previous.rooms).toHaveLength(store.getSnapshot().rooms.length - 1)
})

it('seeds review threads and publishes stable document references across remounts', async () => {
  sessionStorage.clear()
  const workspace = readyWorkspace()
  const store = createLocalWorkspaceStore(workspace, 'community', true)
  const doc = store.getInitialDocuments!().docs[0]!
  expect(doc.comments?.map((comment) => comment.authorName)).toEqual([
    'Claire Mercer',
    'Elena Vance',
  ])
  const room = store.getSnapshot().channels.get(doc.channelId)!
  if (room.state !== 'resolved') throw new Error('Expected a ready room')
  expect(store.getTimeline(room.roomId).at(-1)?.document?.id).toBe(doc.id)
  await store.publishDocument!(room.roomId, { ...doc, title: 'Updated guide' })
  const restored = createLocalWorkspaceStore(workspace, 'community', true)
  expect(restored.getTimeline(room.roomId).at(-1)?.document).toEqual({
    id: doc.id,
    title: 'Updated guide',
  })
  sessionStorage.clear()
})
