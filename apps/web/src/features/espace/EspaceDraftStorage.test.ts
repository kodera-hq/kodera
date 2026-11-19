import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthLifetime } from '../../auth/AuthProvider'
import type { EspaceStoreLike } from './liveViewModel'
import type { RoomBoundary } from '../confidential/room-boundary'
const fixture = vi.hoisted(() => ({
  session: {
    baseUrl: 'https://chat.example.test',
    userId: '@person:example.test',
    deviceId: 'device',
  },
  matrixStamp: {},
}))
vi.mock('../../auth/matrix', () => ({
  getMatrixSession: () => fixture.session,
  getMatrixRegistrationStamp: () => fixture.matrixStamp,
  subscribeMatrixSession: () => () => {},
}))
vi.mock('../workspace/OpenEspace', () => ({ espaceSessionFor: () => fixture.session }))
import { DraftMemory } from './EspaceDraftProvider'
const authority = {
  org: 'workspace',
  organisationId: 'organisation',
  meGeneration: 1,
  meCredentialGeneration: 1,
}
function harness(initialBoundary: RoomBoundary = 'ordinary') {
  let usable = true
  let boundary = initialBoundary
  const coreListeners = new Set<() => void>()
  const storeListeners = new Set<() => void>()
  const stamp = {}
  const lifetime = {
    getSnapshot: () => ({
      status: 'ready',
      generation: 1,
      credentialGeneration: 1,
      user: {
        realm: 'workspace',
        identity: { issuer: 'https://login.example.test', subject: 'person' },
      },
    }),
    getRetirementStamp: () => stamp,
    hasUsableCredential: () => usable,
    subscribe: (listener: () => void) => {
      coreListeners.add(listener)
      return () => coreListeners.delete(listener)
    },
  } as unknown as AuthLifetime
  const store = {
    getUserId: () => fixture.session.userId,
    getRoomBoundary: () => boundary,
    subscribe: (listener: () => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
  } as unknown as EspaceStoreLike
  const memory = new DraftMemory(lifetime, authority, () => 'example.test')
  const close = memory.connect()
  const lease = memory.attachView(store, { organisation_id: 'organisation' }, '!room')
  return {
    memory,
    store,
    lease,
    close,
    lifetime,
    logout: () => {
      usable = false
      for (const notify of coreListeners) notify()
    },
    boundary: (value: RoomBoundary) => {
      boundary = value
      for (const notify of storeListeners) notify()
    },
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
})
it('debounces text only, restores after a provider reload, and clears on logout', () => {
  const h = harness()
  h.lease.update({
    text: 'Draft',
    threadText: 'Thread draft',
    replyTo: { roomId: '!room', eventId: '$private-target' },
  })
  vi.advanceTimersByTime(299)
  expect(sessionStorage.length).toBe(0)
  h.lease.update({ text: 'Final draft' })
  vi.advanceTimersByTime(300)
  const saved = sessionStorage.getItem(sessionStorage.key(0)!)!
  expect(saved).toContain('Final draft')
  expect(saved).not.toContain('$private-target')
  h.close()
  const next = harness()
  expect(next.lease.read()).toMatchObject({
    text: 'Final draft',
    threadText: 'Thread draft',
    replyTo: null,
  })
  next.logout()
  expect(sessionStorage.length).toBe(0)
  expect(next.lease.read().text).toBe('')
  next.close()
})
it.each<RoomBoundary>(['unknown', 'invalid', 'confidential-unavailable'])(
  'never persists a %s room',
  (boundary) => {
    const h = harness(boundary)
    h.lease.update({ text: 'Private' })
    vi.advanceTimersByTime(300)
    expect(sessionStorage.length).toBe(0)
    h.close()
  }
)
it('removes already-saved text immediately when a room becomes confidential', () => {
  const h = harness()
  h.lease.update({ text: 'Earlier draft' })
  vi.advanceTimersByTime(300)
  expect(sessionStorage.length).toBe(1)
  h.boundary('confidential-unavailable')
  expect(sessionStorage.length).toBe(0)
  expect(h.lease.read().text).toBe('')
  h.close()
})
it('ignores malformed storage and refuses delayed writes after retirement', () => {
  const h = harness()
  h.lease.update({ text: 'Unsent' })
  h.logout()
  vi.advanceTimersByTime(300)
  expect(sessionStorage.length).toBe(0)
  h.close()
})

it('clears a saved draft when returning to a room reclassified while its view was detached', () => {
  const h = harness()
  h.lease.update({ text: 'Earlier ordinary draft' })
  h.lease.release()
  h.boundary('confidential-unavailable')
  const next = h.memory.attachView(h.store, { organisation_id: 'organisation' }, '!room')
  expect(next.read().text).toBe('')
  expect(sessionStorage.length).toBe(0)
  next.release()
  h.close()
})
