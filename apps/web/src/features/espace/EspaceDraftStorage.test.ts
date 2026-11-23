import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthLifetime } from '../../auth/AuthProvider'
import type { EspaceStoreLike } from './liveViewModel'
import type { RoomBoundary } from '../confidential/room-boundary'
import { ESPACE_VAULT_DATABASE } from './matrix/encryptedCache'
import { createTestVaultIndexedDb, type TestVaultIdbFactory } from './matrix/testVaultIdb'

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
  ownerId: 'person-uuid',
  membershipId: 'membership-uuid',
  meGeneration: 1,
  meCredentialGeneration: 1,
}

function createAuthHarness() {
  let usable = true
  const coreListeners = new Set<() => void>()
  let stamp = {}
  const lifetime = {
    getSnapshot: () => ({
      status: usable ? 'ready' : 'unauthenticated',
      generation: 1,
      credentialGeneration: 1,
      user: usable
        ? {
            realm: 'workspace',
            identity: { issuer: 'https://login.example.test', subject: 'person' },
          }
        : undefined,
    }),
    getRetirementStamp: () => stamp,
    hasUsableCredential: () => usable,
    subscribe: (listener: () => void) => {
      coreListeners.add(listener)
      return () => coreListeners.delete(listener)
    },
  } as unknown as AuthLifetime
  return {
    lifetime,
    logout: () => {
      usable = false
      stamp = {}
      for (const notify of coreListeners) notify()
    },
  }
}

function harness(
  initialBoundary: RoomBoundary = 'ordinary',
  idb?: TestVaultIdbFactory | undefined,
  sharedAuth = createAuthHarness()
) {
  let boundary = initialBoundary
  const storeListeners = new Set<() => void>()
  const store = {
    getUserId: () => fixture.session.userId,
    getRoomBoundary: () => boundary,
    subscribe: (listener: () => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
  } as unknown as EspaceStoreLike
  const memory = new DraftMemory(sharedAuth.lifetime, authority, () => 'example.test', idb)
  const close = memory.connect()
  const lease = memory.attachView(store, { organisation_id: 'organisation' }, '!room')
  return {
    memory,
    store,
    lease,
    close,
    lifetime: sharedAuth.lifetime,
    auth: sharedAuth,
    logout: sharedAuth.logout,
    boundary: (value: RoomBoundary) => {
      boundary = value
      for (const notify of storeListeners) notify()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
  localStorage.clear()
})

describe('Espace encrypted draft persistence and boundary quarantine', () => {
  it('encrypts ordinary drafts inside kodera.espace-vault.v1, purges legacy plaintext kodera:drafts:*, restores on reload, and wipes on logout', async () => {
    const idb = createTestVaultIndexedDb()
    sessionStorage.setItem('kodera:drafts:legacy:entry', '{"!room":{"text":"plaintext-leak"}}')
    localStorage.setItem('kodera:drafts:legacy:local', '{"!room":{"text":"plaintext-leak"}}')

    const h = harness('ordinary', idb)
    expect(sessionStorage.getItem('kodera:drafts:legacy:entry')).toBeNull()
    expect(localStorage.getItem('kodera:drafts:legacy:local')).toBeNull()

    h.lease.update({
      text: 'Draft',
      threadText: 'Thread draft',
      replyTo: { roomId: '!room', eventId: '$private-target' },
    })
    await vi.advanceTimersByTimeAsync(299)
    expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)

    h.lease.update({ text: 'Final encrypted draft' })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)
    )

    // Verify raw IndexedDB and sessionStorage contain zero plaintext or reply target IDs.
    expect(sessionStorage.length).toBe(0)
    const rawRow = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').values()][0] as {
      ciphertext: ArrayBuffer
    }
    const rawDecoded = new TextDecoder().decode(new Uint8Array(rawRow.ciphertext))
    expect(rawDecoded).not.toContain('Final encrypted draft')
    expect(rawDecoded).not.toContain('$private-target')
    expect(JSON.stringify(rawRow)).not.toContain('Final encrypted draft')

    h.close()

    const next = harness('ordinary', idb, h.auth)
    await vi.waitFor(() =>
      expect(next.lease.read()).toMatchObject({
        text: 'Final encrypted draft',
        threadText: 'Thread draft',
        replyTo: null,
      })
    )

    next.logout()
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(false))
    expect(sessionStorage.length).toBe(0)
    expect(next.lease.read().text).toBe('')
    next.close()
  })

  it('encrypts session-scoped fallback storage when IndexedDB is unavailable without writing plaintext', async () => {
    const h = harness('community', undefined)
    h.lease.update({
      text: 'Community encrypted draft',
      threadText: 'Thread note',
      replyTo: { roomId: '!room', eventId: '$private-target' },
    })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(sessionStorage.length).toBe(1))
    const key = sessionStorage.key(0)!
    expect(key.startsWith('kodera:drafts:')).toBe(false)
    const rawSaved = sessionStorage.getItem(key)!
    expect(rawSaved).not.toContain('Community encrypted draft')
    expect(rawSaved).not.toContain('Thread note')
    expect(rawSaved).not.toContain('$private-target')
    h.close()

    const next = harness('community', undefined, h.auth)
    await vi.waitFor(() =>
      expect(next.lease.read()).toMatchObject({
        text: 'Community encrypted draft',
        threadText: 'Thread note',
        replyTo: null,
      })
    )
    next.logout()
    expect(sessionStorage.length).toBe(0)
    expect(next.lease.read().text).toBe('')
    next.close()
  })

  it.each<RoomBoundary>(['unknown', 'invalid', 'confidential-unavailable'])(
    'never persists a %s room',
    async (boundary) => {
      const idb = createTestVaultIndexedDb()
      const h = harness(boundary, idb)
      h.lease.update({ text: 'Private' })
      await vi.advanceTimersByTimeAsync(300)
      expect(sessionStorage.length).toBe(0)
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)
      h.close()
    }
  )

  it('removes already-saved encrypted draft immediately when a room becomes confidential', async () => {
    const idb = createTestVaultIndexedDb()
    const h = harness('ordinary', idb)
    h.lease.update({ text: 'Earlier draft' })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)
    )
    h.boundary('confidential-unavailable')
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)
    )
    expect(sessionStorage.length).toBe(0)
    expect(h.lease.read().text).toBe('')
    h.close()
  })

  it('refuses delayed writes after retirement', async () => {
    const idb = createTestVaultIndexedDb()
    const h = harness('ordinary', idb)
    h.lease.update({ text: 'Unsent' })
    h.logout()
    await vi.advanceTimersByTimeAsync(300)
    expect(sessionStorage.length).toBe(0)
    expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)
    h.close()
  })

  it('clears a saved draft when returning to a room reclassified while its view was detached', async () => {
    const idb = createTestVaultIndexedDb()
    const h = harness('ordinary', idb)
    h.lease.update({ text: 'Earlier ordinary draft' })
    h.lease.release()
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)
    )
    h.boundary('confidential-unavailable')
    const next = h.memory.attachView(h.store, { organisation_id: 'organisation' }, '!room')
    expect(next.read().text).toBe('')
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)
    )
    expect(sessionStorage.length).toBe(0)
    next.release()
    h.close()
  })

  it('preserves encrypted ordinary drafts across cold-start unknown -> ordinary transition while purging if sync resolves confidential', async () => {
    const idb = createTestVaultIndexedDb()
    const h = harness('ordinary', idb)
    h.lease.update({ text: 'Cold-start preserved draft', threadText: 'Cold-start thread' })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)
    )
    h.close()

    // Restart where cached channel resolution attaches the view while live room boundary is `'unknown'` before `/sync`.
    const cold = harness('unknown', idb, h.auth)
    await vi.advanceTimersByTimeAsync(50)
    // While `'unknown'`, plaintext draft is withheld from view (`''`) AND encrypted record is NOT deleted on disk!
    expect(cold.lease.read().text).toBe('')
    expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)

    // Once `/sync` confirms `'ordinary'`, the persisted encrypted draft is decrypted and restored cleanly!
    cold.boundary('ordinary')
    await vi.waitFor(() =>
      expect(cold.lease.read()).toMatchObject({
        text: 'Cold-start preserved draft',
        threadText: 'Cold-start thread',
      })
    )
    cold.close()

    // Sibling restart where `/sync` resolves `'confidential-unavailable'` instead: draft stays `''` and is deleted from disk!
    const coldProtected = harness('unknown', idb, h.auth)
    expect(coldProtected.lease.read().text).toBe('')
    expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(1)
    coldProtected.boundary('confidential-unavailable')
    await vi.waitFor(() =>
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'drafts').size).toBe(0)
    )
    expect(coldProtected.lease.read().text).toBe('')
    coldProtected.close()
  })
})
