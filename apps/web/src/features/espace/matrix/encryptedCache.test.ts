import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ESPACE_VAULT_DATABASE,
  EspaceVaultError,
  LEGACY_TIMELINE_DATABASE,
  MAX_OUTBOX_BODY_BYTES,
  MAX_OUTBOX_ITEMS,
  openEspaceVault,
  wipeEspaceVault,
  type EspaceVault,
  type EspaceVaultPrincipal,
} from './encryptedCache'
import type { MessageView } from './timeline'
import { createTestVaultIndexedDb } from './testVaultIdb'
import {
  requestAccountDeletion,
  requestWorkspaceDeletion,
} from '../../workspace/privacyApi'

const PRINCIPAL_A: EspaceVaultPrincipal = {
  ownerId: '@alice:matrix.acme.kodera.test',
  organisationId: 'org-acme-01',
  membershipId: 'mem-alice-01',
  deviceId: 'DEV_ALICE_1',
}

const PRINCIPAL_B: EspaceVaultPrincipal = {
  ownerId: '@bob:matrix.acme.kodera.test',
  organisationId: 'org-acme-01',
  membershipId: 'mem-bob-02',
  deviceId: 'DEV_BOB_1',
}

const ROOM_GENERAL = '!general:matrix.acme.kodera.test'
const ROOM_SECRET = '!secret:matrix.acme.kodera.test'

function sampleMessage(id: string, body: string, ts = 1_762_000_000_000): MessageView {
  return {
    key: id,
    eventId: id,
    sender: '@alice:matrix.acme.kodera.test',
    body,
    ts,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

function serializeRawBytes(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return new TextDecoder().decode(new Uint8Array(value as ArrayBuffer))
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    )
  }
  if (Array.isArray(value)) return value.map((v) => serializeRawBytes(v)).join('|')
  if (typeof value === 'object') {
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return '[CryptoKey]'
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}:${serializeRawBytes(v)}`)
      .join('|')
  }
  return ''
}

const vaults: EspaceVault[] = []
afterEach(async () => {
  for (const v of vaults.splice(0)) {
    v.closeImmediate()
  }
  vi.unstubAllGlobals()
})

describe('Espace encrypted cold-start & offline outbox vault (kodera.espace-vault.v1)', () => {
  it('generates a non-extractable AES-GCM 256-bit CryptoKey in owners and deletes legacy kodera-espace-timelines on open', async () => {
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vault)

    expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(true)
    expect(idb.deletedDatabases).toContain(LEGACY_TIMELINE_DATABASE)

    const owners = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'owners').values()] as Array<{
      ownerId: string
      organisationId: string
      membershipId: string
      deviceId: string
      incarnation: string
      status: string
      key?: CryptoKey
    }>
    expect(owners).toHaveLength(1)
    const owner = owners[0]!
    expect(owner.ownerId).toBe(PRINCIPAL_A.ownerId)
    expect(owner.organisationId).toBe(PRINCIPAL_A.organisationId)
    expect(owner.membershipId).toBe(PRINCIPAL_A.membershipId)
    expect(owner.deviceId).toBe(PRINCIPAL_A.deviceId)
    expect(owner.status).toBe('active')
    expect(owner.incarnation).toMatch(/^[0-9a-f-]{36}$/i)
    expect(owner.key).toBeInstanceOf(CryptoKey)
    expect(owner.key!.extractable).toBe(false)
    expect(owner.key!.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    await expect(crypto.subtle.exportKey('raw', owner.key!)).rejects.toThrow()
  })

  it('refuses relaxed IndexedDB transaction durability', async () => {
    const relaxedIdb = createTestVaultIndexedDb({ forceRelaxedDurability: true })
    await expect(openEspaceVault(PRINCIPAL_A, { idb: relaxedIdb })).rejects.toMatchObject({
      name: 'EspaceVaultError',
      code: 'unavailable',
    })
  })

  it('stores zero plaintext in raw IndexedDB rooms, outbox, and drafts rows and keeps quarantine rows body-free', async () => {
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vault)

    const secretSentinel = 'SENTINEL_PLAIN_MESSAGE_99182'
    const sidebarSentinel = 'SENTINEL_CHANNEL_TITLE_77210'
    const outboxSentinel = 'SENTINEL_UNSENT_OUTBOX_55109'
    const draftSentinel = 'SENTINEL_COMPOSER_DRAFT_33901'

    vault.scheduleRoomSave(
      ROOM_GENERAL,
      'ordinary',
      [sampleMessage('$m1', secretSentinel)],
      {
        roomId: ROOM_GENERAL,
        name: sidebarSentinel,
        alias: '#general:matrix.acme.kodera.test',
        verifiedBoundary: 'ordinary',
        kind: 'text',
        unread: 2,
        mentions: 1,
      },
      ['ch-general']
    )
    vault.scheduleSidebarSave(
      [
        {
          roomId: ROOM_GENERAL,
          name: sidebarSentinel,
          alias: '#general:matrix.acme.kodera.test',
          verifiedBoundary: 'ordinary',
          kind: 'text',
          unread: 2,
          mentions: 1,
        },
      ],
      [['ch-general', ROOM_GENERAL]]
    )
    await vault.flush()

    await vault.putOutbox({
      clientTxnId: 'txn-001',
      roomId: ROOM_GENERAL,
      verifiedBoundary: 'ordinary',
      body: outboxSentinel,
      content: { msgtype: 'm.text', body: outboxSentinel },
    })
    await vault.putDraft(ROOM_GENERAL, 'ordinary', draftSentinel, 'thread-note')
    await vault.quarantineRoom(ROOM_SECRET)

    for (const storeName of ['rooms', 'outbox', 'drafts'] as const) {
      const rows = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, storeName).values()]
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const dumped = serializeRawBytes(row)
        expect(dumped).not.toContain(secretSentinel)
        expect(dumped).not.toContain(sidebarSentinel)
        expect(dumped).not.toContain(outboxSentinel)
        expect(dumped).not.toContain(draftSentinel)
      }
    }

    const quarantineRows = [
      ...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'quarantine').values(),
    ] as Array<Record<string, unknown>>
    expect(quarantineRows).toHaveLength(1)
    expect(Object.keys(quarantineRows[0]!).sort()).toEqual([
      'id',
      'markedAt',
      'ownerKey',
      'roomId',
    ])
    expect(quarantineRows[0]!.roomId).toBe(ROOM_SECRET)

    // Round-trip decryption succeeds for the exact bound principal.
    const cold = await vault.coldStartRead('ch-general')
    expect(cold.quarantined.has(ROOM_SECRET)).toBe(true)
    expect(cold.sidebar?.rooms[0]?.name).toBe(sidebarSentinel)
    expect(cold.activeRoom?.messages[0]?.body).toBe(secretSentinel)
    expect(cold.outbox[0]?.body).toBe(outboxSentinel)
    const draft = await vault.readDraft(ROOM_GENERAL)
    expect(draft?.text).toBe(draftSentinel)
  })

  it('isolates principals across (ownerId, organisationId, membershipId, deviceId) and refuses AAD/ciphertext tampering', async () => {
    const idb = createTestVaultIndexedDb()
    const vaultA = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vaultA)

    vaultA.scheduleRoomSave(ROOM_GENERAL, 'ordinary', [sampleMessage('$e1', 'alice-only')])
    await vaultA.flush()
    await vaultA.putOutbox({
      clientTxnId: 'txn-a',
      roomId: ROOM_GENERAL,
      verifiedBoundary: 'ordinary',
      body: 'alice-outbox',
      content: { msgtype: 'm.text', body: 'alice-outbox' },
    })
    await vaultA.putDraft(ROOM_GENERAL, 'ordinary', 'alice-draft', '')
    await vaultA.close()

    // Different membershipId on the same user/org/device gets its own CryptoKey + empty state.
    const vaultRejoined = await openEspaceVault(
      { ...PRINCIPAL_A, membershipId: 'mem-alice-rejoined-02' },
      { idb, delayMs: 0 }
    )
    vaults.push(vaultRejoined)
    const rejoinedCold = await vaultRejoined.coldStartRead(undefined, ROOM_GENERAL)
    expect(rejoinedCold.activeRoom).toBeNull()
    expect(rejoinedCold.outbox).toEqual([])
    expect(await vaultRejoined.readDraft(ROOM_GENERAL)).toBeNull()

    // Different user on shared device cannot read Alice's records even if row metadata is copied.
    const vaultB = await openEspaceVault(PRINCIPAL_B, { idb, delayMs: 0 })
    vaults.push(vaultB)
    const bCold = await vaultB.coldStartRead(undefined, ROOM_GENERAL)
    expect(bCold.activeRoom).toBeNull()

    // Tamper AAD-bound `verifiedBoundary` ('ordinary' -> 'community') on Alice's stored room row.
    const roomsMap = idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'rooms')
    for (const [k, raw] of roomsMap.entries()) {
      const rec = raw as { roomId?: string; verifiedBoundary?: string }
      if (rec.roomId === ROOM_GENERAL) {
        roomsMap.set(k, { ...rec, verifiedBoundary: 'community' })
      }
    }

    // Tamper 1 byte in Alice's outbox ciphertext.
    const outboxMap = idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'outbox')
    for (const [k, raw] of outboxMap.entries()) {
      const rec = raw as { clientTxnId?: string; ciphertext: ArrayBuffer }
      const bytes = new Uint8Array(rec.ciphertext.slice(0))
      if (bytes.length > 0) bytes[0] = bytes[0]! ^ 0xff
      outboxMap.set(k, { ...rec, ciphertext: bytes.buffer })
    }

    const vaultAReopened = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vaultAReopened)
    const tamperedCold = await vaultAReopened.coldStartRead(undefined, ROOM_GENERAL)
    expect(tamperedCold.activeRoom).toBeNull()
    expect(tamperedCold.outbox).toEqual([])
  })

  it('enforces outbox bounds (<= 32 items, <= 64 KiB body) and refuses unknown/confidential/quarantined rooms', async () => {
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vault)

    for (const forbidden of ['unknown', 'invalid', 'confidential-unavailable'] as const) {
      await expect(
        vault.putOutbox({
          clientTxnId: `txn-${forbidden}`,
          roomId: ROOM_GENERAL,
          verifiedBoundary: forbidden,
          body: 'blocked',
          content: { msgtype: 'm.text', body: 'blocked' },
        })
      ).rejects.toBeInstanceOf(EspaceVaultError)
      await expect(vault.putDraft(ROOM_GENERAL, forbidden, 'draft', '')).rejects.toMatchObject({
        code: 'quarantined',
      })
    }

    // Oversized body (> 64 KiB UTF-8) is refused with 'capacity'.
    const oversized = 'x'.repeat(MAX_OUTBOX_BODY_BYTES + 1)
    await expect(
      vault.putOutbox({
        clientTxnId: 'txn-oversized',
        roomId: ROOM_GENERAL,
        verifiedBoundary: 'ordinary',
        body: oversized,
        content: { msgtype: 'm.text', body: oversized },
      })
    ).rejects.toMatchObject({ code: 'capacity' })

    // Up to 32 queued items succeed; the 33rd is refused with 'capacity'.
    for (let i = 0; i < MAX_OUTBOX_ITEMS; i++) {
      await vault.putOutbox({
        clientTxnId: `txn-cap-${i}`,
        roomId: ROOM_GENERAL,
        verifiedBoundary: 'ordinary',
        queuedAt: 1_000 + i,
        body: `msg-${i}`,
        content: { msgtype: 'm.text', body: `msg-${i}` },
      })
    }
    await expect(
      vault.putOutbox({
        clientTxnId: 'txn-cap-overflow',
        roomId: ROOM_GENERAL,
        verifiedBoundary: 'ordinary',
        body: 'overflow',
        content: { msgtype: 'm.text', body: 'overflow' },
      })
    ).rejects.toMatchObject({ code: 'capacity' })

    // Quarantining the room immediately deletes all 32 outbox rows and refuses new ones.
    await vault.quarantineRoom(ROOM_GENERAL)
    const cold = await vault.coldStartRead(undefined, ROOM_GENERAL)
    expect(cold.outbox).toEqual([])
    await expect(
      vault.putOutbox({
        clientTxnId: 'txn-after-quarantine',
        roomId: ROOM_GENERAL,
        verifiedBoundary: 'ordinary',
        body: 'after-quarantine',
        content: { msgtype: 'm.text', body: 'after-quarantine' },
      })
    ).rejects.toMatchObject({ code: 'quarantined' })
  })

  it('gdpr-erasure-purge: requestWorkspaceDeletion and requestAccountDeletion cryptographically destroy vault keys and delete espace + docs IndexedDBs', async () => {
    for (const kind of ['workspace', 'account'] as const) {
      import.meta.env['VITE_CORE_API_URL'] = `https://core-${kind}-erasure.acme.kodera.test/api/v1`
      let holdActive = true
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (holdActive) {
            return new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Service Unavailable',
                status: 503,
                detail: 'Hold active',
              }),
              { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
            )
          }
          const nowIso = new Date().toISOString()
          return new Response(
            JSON.stringify({
              id: `del-${kind}-1`,
              scope: kind,
              kind: 'deletion',
              status: 'queued',
              requestedAt: nowIso,
              updatedAt: nowIso,
              expiresAt: null,
              purgeAfter: nowIso,
              failureCode: null,
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          )
        })
      )

      const idb = createTestVaultIndexedDb()
      // Seed a legacy timeline DB and a Yjs collab DB alongside the active encrypted vault.
      await new Promise<void>((resolve) => {
        const r1 = idb.open(LEGACY_TIMELINE_DATABASE, 1)
        r1.onsuccess = () => {
          r1.result.close()
          resolve()
        }
      })
      await new Promise<void>((resolve) => {
        const r2 = idb.open('kodera-docs-yjs:org-acme-01:doc-42', 1)
        r2.onsuccess = () => {
          r2.result.close()
          resolve()
        }
      })

      vi.stubGlobal('indexedDB', idb)
      const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
      vaults.push(vault)
      vault.scheduleRoomSave(ROOM_GENERAL, 'ordinary', [sampleMessage('$g1', 'erase-me')])
      await vault.flush()
      await vault.putDraft(ROOM_GENERAL, 'ordinary', 'erase-draft', '')

      // 503 hold response must NOT wipe local device state prematurely.
      await expect(
        kind === 'workspace'
          ? requestWorkspaceDeletion(
              'org-acme-01',
              { reason: 'closing' },
              '11111111-1111-4111-8111-111111111111'
            )
          : requestAccountDeletion({ reason: 'closing' }, '11111111-1111-4111-8111-111111111111')
      ).rejects.toThrow()
      expect((await vault.readDraft(ROOM_GENERAL))?.text).toBe('erase-draft')

      // Accepted Art. 17 erasure response triggers full cryptographic wipe + DB deletion.
      holdActive = false

      const res =
        kind === 'workspace'
          ? await requestWorkspaceDeletion(
              'org-acme-01',
              { reason: 'closing' },
              '22222222-2222-4222-8222-222222222222'
            )
          : await requestAccountDeletion(
              { reason: 'closing' },
              '22222222-2222-4222-8222-222222222222'
            )
      expect(res.status).toBe('queued')

      // Wait one macrotask for async `deleteDatabase` completion in `testVaultIdb`.
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(idb.deletedDatabases).toContain(ESPACE_VAULT_DATABASE)
      expect(idb.deletedDatabases).toContain(LEGACY_TIMELINE_DATABASE)
      expect(idb.deletedDatabases).toContain('kodera-docs-yjs:org-acme-01:doc-42')
      expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(false)
      await expect(vault.readDraft(ROOM_GENERAL)).rejects.toMatchObject({ code: 'closed' })
    }
  })

  it('forgetRoom and quarantineRoom purge room/draft/outbox artifacts and rotate owner CryptoKey + incarnation while preserving surviving ordinary rooms', async () => {
    const idb = createTestVaultIndexedDb()
    const roomKeep = '!keep:matrix.acme.kodera.test'
    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(vault)

    vault.scheduleRoomSave(ROOM_GENERAL, 'ordinary', [sampleMessage('$g1', 'general-msg')])
    vault.scheduleRoomSave(roomKeep, 'ordinary', [sampleMessage('$k1', 'keep-msg')])
    await vault.flush()
    await vault.putDraft(ROOM_GENERAL, 'ordinary', 'revoked-room-draft', 'revoked-thread')
    await vault.putDraft(roomKeep, 'ordinary', 'surviving-draft', 'surviving-thread')
    await vault.putOutbox({
      clientTxnId: 'txn-revoked',
      roomId: ROOM_GENERAL,
      channelId: 'ch-general',
      verifiedBoundary: 'ordinary',
      body: 'revoked-outbox',
      content: { msgtype: 'm.text', body: 'revoked-outbox' },
    })
    await vault.putOutbox({
      clientTxnId: 'txn-keep',
      roomId: roomKeep,
      channelId: 'ch-keep',
      verifiedBoundary: 'ordinary',
      body: 'keep-outbox',
      content: { msgtype: 'm.text', body: 'keep-outbox' },
    })

    const readOwnerSnapshot = () => {
      const rows = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'owners').values()] as Array<{
        incarnation: string
        key?: CryptoKey
      }>
      expect(rows).toHaveLength(1)
      return rows[0]!
    }
    const ownerBefore = readOwnerSnapshot()
    const keyBefore = ownerBefore.key!
    const incarnationBefore = ownerBefore.incarnation

    await vault.forgetRoom(ROOM_GENERAL)

    const ownerAfterForget = readOwnerSnapshot()
    expect(ownerAfterForget.incarnation).not.toBe(incarnationBefore)
    expect(ownerAfterForget.key).toBeInstanceOf(CryptoKey)
    expect(ownerAfterForget.key).not.toBe(keyBefore)
    expect(ownerAfterForget.key!.extractable).toBe(false)

    // Revoked room artifacts are purged across rooms, drafts, and outbox.
    expect(await vault.readDraft(ROOM_GENERAL)).toBeNull()
    const coldAfterForget = await vault.coldStartRead(undefined, ROOM_GENERAL)
    expect(coldAfterForget.activeRoom).toBeNull()

    // Surviving ordinary room + draft + outbox (including persisted channelId) remain readable under rotated key.
    expect(await vault.readDraft(roomKeep)).toMatchObject({
      text: 'surviving-draft',
      threadText: 'surviving-thread',
    })
    const coldKeep = await vault.coldStartRead(undefined, roomKeep)
    expect(coldKeep.activeRoom?.messages[0]?.body).toBe('keep-msg')
    expect(coldKeep.outbox).toHaveLength(1)
    expect(coldKeep.outbox[0]).toMatchObject({
      clientTxnId: 'txn-keep',
      roomId: roomKeep,
      channelId: 'ch-keep',
      body: 'keep-outbox',
    })

    // Quarantining the remaining room rotates the key + incarnation again and leaves quarantine marker.
    await vault.quarantineRoom(roomKeep)
    const ownerAfterQuarantine = readOwnerSnapshot()
    expect(ownerAfterQuarantine.incarnation).not.toBe(ownerAfterForget.incarnation)
    expect(ownerAfterQuarantine.key).not.toBe(ownerAfterForget.key)
    expect(await vault.readDraft(roomKeep)).toBeNull()
    const coldAfterQuarantine = await vault.coldStartRead(undefined, roomKeep)
    expect(coldAfterQuarantine.quarantined.has(roomKeep)).toBe(true)
    expect(coldAfterQuarantine.outbox).toEqual([])
  })

  it('serializes concurrent forgetRoom rotations and putDraft across peer handles without resurrecting purged rooms or clobbering newer writes', async () => {
    const idb = createTestVaultIndexedDb()
    const room1 = '!room-one:matrix.acme.kodera.test'
    const room2 = '!room-two:matrix.acme.kodera.test'
    const room3 = '!room-three:matrix.acme.kodera.test'

    const handleA = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    const handleB = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(handleA, handleB)

    handleA.scheduleRoomSave(room1, 'ordinary', [sampleMessage('$m1', 'purge-one')])
    handleB.scheduleRoomSave(room2, 'ordinary', [sampleMessage('$m2', 'purge-two')])
    handleA.scheduleRoomSave(room3, 'ordinary', [sampleMessage('$m3', 'keep-three')])
    await Promise.all([handleA.flush(), handleB.flush()])
    await handleA.putDraft(room1, 'ordinary', 'draft-one', '')
    await handleB.putDraft(room2, 'ordinary', 'draft-two', '')
    await handleA.putDraft(room3, 'ordinary', 'initial-draft-three', '')

    const incarnationBefore = handleA.incarnation

    // Fire two concurrent room revocations + a concurrent draft update on the third room!
    await Promise.all([
      handleA.forgetRoom(room1),
      handleB.forgetRoom(room2),
      handleA.putDraft(room3, 'ordinary', 'concurrent-fresh-draft-three', 'concurrent-thread'),
    ])

    expect(handleA.incarnation).not.toBe(incarnationBefore)
    expect(handleB.incarnation).toBe(handleA.incarnation)

    // Neither room1 nor room2 may be resurrected in rooms or drafts.
    expect(await handleA.readDraft(room1)).toBeNull()
    expect(await handleB.readDraft(room2)).toBeNull()
    expect((await handleB.coldStartRead(undefined, room1)).activeRoom).toBeNull()
    expect((await handleA.coldStartRead(undefined, room2)).activeRoom).toBeNull()

    // room3's concurrent draft + timeline survive under the final rotated key.
    expect(await handleB.readDraft(room3)).toMatchObject({
      text: 'concurrent-fresh-draft-three',
      threadText: 'concurrent-thread',
    })
    expect((await handleB.coldStartRead(undefined, room3)).activeRoom?.messages[0]?.body).toBe(
      'keep-three'
    )
  })

  it('refcounts open handles so closeImmediate on one handle never zeros a surviving peer handle CryptoKey after rotation', async () => {
    const idb = createTestVaultIndexedDb()
    const roomPurge = '!purge-peer:matrix.acme.kodera.test'
    const roomSurvive = '!survive-peer:matrix.acme.kodera.test'

    const handleA = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    const handleB = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vaults.push(handleA, handleB)

    handleA.scheduleRoomSave(roomPurge, 'ordinary', [sampleMessage('$p1', 'bye')])
    handleA.scheduleRoomSave(roomSurvive, 'ordinary', [sampleMessage('$s1', 'alive-msg')])
    await handleA.flush()
    await handleA.putDraft(roomSurvive, 'ordinary', 'alive-draft', 'alive-thread')

    await handleA.forgetRoom(roomPurge)

    // Close handleA immediately after rotation; handleA is fenced, while handleB stays fully operational!
    handleA.closeImmediate()
    expect(handleA.isClosed).toBe(true)
    expect(handleB.isClosed).toBe(false)
    await expect(handleA.readDraft(roomSurvive)).rejects.toMatchObject({ code: 'closed' })

    expect(await handleB.readDraft(roomSurvive)).toMatchObject({
      text: 'alive-draft',
      threadText: 'alive-thread',
    })
    const coldB = await handleB.coldStartRead(undefined, roomSurvive)
    expect(coldB.activeRoom?.messages[0]?.body).toBe('alive-msg')

    await handleB.putDraft(roomSurvive, 'ordinary', 'updated-by-handle-b', '')
    expect((await handleB.readDraft(roomSurvive))?.text).toBe('updated-by-handle-b')

    handleB.closeImmediate()
    expect(handleB.isClosed).toBe(true)
    await expect(handleB.readDraft(roomSurvive)).rejects.toMatchObject({ code: 'closed' })
  })

  it('enqueues quarantineRoom, forgetRoom, and flush synchronously onto the coordinator FIFO ahead of immediate reads', async () => {
    const idb = createTestVaultIndexedDb()
    const roomQuarantine = '!sync-fifo-quarantine:matrix.acme.kodera.test'
    const roomForget = '!sync-fifo-forget:matrix.acme.kodera.test'
    const roomFlush = '!sync-fifo-flush:matrix.acme.kodera.test'

    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 60_000 })
    vaults.push(vault)

    await vault.putDraft(roomQuarantine, 'ordinary', 'quarantine-me-now', '')
    await vault.putDraft(roomForget, 'ordinary', 'forget-me-now', '')

    // 1. Synchronous invocation ordering: `quarantineRoom` followed immediately by `readDraft` on the same tick!
    const purgeQuarantine = vault.quarantineRoom(roomQuarantine)
    const draftAfterQuarantine = await vault.readDraft(roomQuarantine)
    expect(draftAfterQuarantine).toBeNull()
    await purgeQuarantine

    // 2. Synchronous invocation ordering: `forgetRoom` followed immediately by `readDraft` on the same tick!
    const purgeForget = vault.forgetRoom(roomForget)
    const draftAfterForget = await vault.readDraft(roomForget)
    expect(draftAfterForget).toBeNull()
    await purgeForget

    // 3. Synchronous invocation ordering: `flush` followed immediately by `coldStartRead` on the same tick!
    vault.scheduleRoomSave(roomFlush, 'ordinary', [sampleMessage('$f1', 'flushed-synchronously')])
    const flushing = vault.flush()
    const coldAfterFlush = await vault.coldStartRead(undefined, roomFlush)
    expect(coldAfterFlush.activeRoom?.messages[0]?.body).toBe('flushed-synchronously')
    await flushing
  })

  it('wipeEspaceVault revokes closed vault owner CryptoKeys with tombstones before deleting databases', async () => {
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL_A, { idb, delayMs: 0 })
    vault.scheduleRoomSave(ROOM_GENERAL, 'ordinary', [sampleMessage('$w1', 'wipe-check')])
    await vault.flush()
    await vault.close()

    await wipeEspaceVault(idb)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(idb.deletedDatabases).toContain(ESPACE_VAULT_DATABASE)
    expect(idb.deletedDatabases).toContain(LEGACY_TIMELINE_DATABASE)
    expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(false)
  })
})
