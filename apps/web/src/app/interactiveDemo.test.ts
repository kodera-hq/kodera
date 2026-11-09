import { afterEach, expect, it } from 'vitest'
import { createDemoWorkspaceStore, registerInteractiveDemos } from './interactiveDemo'
import { createLocalWorkspaceStore } from '../mocks/demo/workspaceStore'
import { readyWorkspace } from '../mocks/fixtures/workspaceFixtures'

afterEach(() => registerInteractiveDemos([]))

it('preserves local conversations when switching away and back or adding another workspace', async () => {
  const workspace = readyWorkspace()
  const first = { slug: 'first', createStore: createLocalWorkspaceStore }
  const second = { slug: 'second', createStore: createLocalWorkspaceStore }
  registerInteractiveDemos([first, second])
  const store = createDemoWorkspaceStore('first', workspace)!
  const channel = workspace.categories[0]!.channels[0]!
  store.addChannel?.({ ...channel, room_state: 'ready' })
  const roomId = store.getSnapshot().rooms[0]!.roomId
  await store.send(roomId, 'Keep this conversation')
  createDemoWorkspaceStore('second', workspace)
  registerInteractiveDemos([
    first,
    second,
    { slug: 'third', createStore: createLocalWorkspaceStore },
  ])
  expect(createDemoWorkspaceStore('first', workspace)).toBe(store)
  expect(store.getTimeline(roomId).at(-1)?.body).toBe('Keep this conversation')
})

it('discards a removed demo store so another identity cannot inherit its messages', () => {
  const workspace = readyWorkspace()
  const demo = { slug: 'first', createStore: createLocalWorkspaceStore }
  registerInteractiveDemos([demo])
  const previous = createDemoWorkspaceStore('first', workspace)
  registerInteractiveDemos([])
  registerInteractiveDemos([demo])
  expect(createDemoWorkspaceStore('first', workspace)).not.toBe(previous)
})
