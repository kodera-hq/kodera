// Unit-level real browser storage checks, not a product E2E or engine qualification.
// Discovered by the existing Playwright tests/e2e suite; no nested runner or browser launch.
// npx playwright test tests/e2e/confidential-local-state.spec.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from '@playwright/test'
import ts from 'typescript'

let server, origin
test.beforeAll(async () => {
  const source = await readFile(new URL('../../src/features/confidential/local-state.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics?.length ?? 0, 0)
  server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', req.url === '/state.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/state.js' ? compiled.outputText : '<!doctype html><title>Isolated storage unit test</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
async function pageFor(context) {
  const page = await context.newPage()
  await page.goto(origin)
  await page.evaluate(async () => {
    window.stateModule = await import('/state.js')
    window.ownerA = '01950000-0000-7000-8000-000000000001'
    window.ownerB = '01950000-0000-7000-8000-000000000002'
    window.roomA = '01950000-0000-7000-8000-000000000003'
    window.roomB = '01950000-0000-7000-8000-000000000004'
    window.scope = (kind = 'room', roomId = window.roomA, ownerId = window.ownerA) => ({
      ownerId, organisationId: '01950000-0000-7000-8000-000000000005',
      membershipId: '01950000-0000-7000-8000-000000000006', devicePublicKey: '41'.repeat(32),
      kind, ...(kind === 'room' ? { roomId } : {}),
    })
    window.payload = (n) => ({ checkpoint: new Uint8Array([n, 92, 177]), pendingSends: [{
      id: '01950000-0000-7000-8000-000000000007', ciphertext: new Uint8Array([n, 204]),
    }] })
    window.captured = async (operation) => {
      try { return { ok: true, value: await operation() } }
      catch (error) { return { ok: false, code: error.code ?? error.name } }
    }
    window.raw = async (operation) => {
      const opening = indexedDB.open(window.stateModule.CONFIDENTIAL_STATE_DATABASE, 1)
      const db = await new Promise((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
      })
      try { return await operation(db) } finally { db.close() }
    }
    window.idbRequest = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    window.rawUpdate = (stores, operation) => window.raw((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error)
      operation(tx)
    }))
    window.holdCrypto = (name) => {
      const original = crypto.subtle[name].bind(crypto.subtle)
      let release
      const held = new Promise((resolve) => { release = resolve })
      window.cryptoEntered = false
      window.releaseCrypto = () => { crypto.subtle[name] = original; release() }
      crypto.subtle[name] = async (...args) => {
        const result = await original(...args)
        window.cryptoEntered = true
        await held
        return result
      }
    }
  })
  return page
}
function check(name, body) {
  test(`unit browser storage: ${name}`, async ({ browser }) => {
    test.setTimeout(25_000)
    const context = await browser.newContext()
    try { await body(await pageFor(context), context) } finally { await context.close() }
  })
}

check('real non-extractable key and ciphertext survive close/reopen without plaintext browser storage', async (page) => {
  const result = await page.evaluate(async () => {
    const { initializeConfidentialState, openConfidentialState } = window.stateModule
    const store = await initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(17) }])
    store.close()
    const reopened = await openConfidentialState(window.ownerA)
    const state = await reopened.read(window.scope())
    const disk = await window.raw(async (db) => {
      const tx = db.transaction(['owners', 'records'])
      const owners = await window.idbRequest(tx.objectStore('owners').getAll())
      const rows = await window.idbRequest(tx.objectStore('records').getAll())
      const key = owners[0].key
      const exportAttempt = await window.captured(() => crypto.subtle.exportKey('raw', key))
      return { extractable: key.extractable, length: key.algorithm.length,
        usages: [...key.usages].sort(), exportDenied: !exportAttempt.ok,
        encryptedLength: rows[0].ciphertext.byteLength,
        noClearField: !('checkpoint' in rows[0]) && !('pendingSends' in rows[0]),
        differs: !new Uint8Array(rows[0].ciphertext).every((v, i) => v === state.checkpoint[i]) }
    })
    reopened.close()
    return { checkpoint: [...state.checkpoint], pending: [...state.pendingSends[0].ciphertext],
      generation: state.generation, disk, local: localStorage.length, session: sessionStorage.length }
  })
  assert.deepEqual(result.checkpoint, [17, 92, 177])
  assert.deepEqual(result.pending, [17, 204])
  assert.equal(result.generation, 1)
  assert.deepEqual(result.disk.usages, ['decrypt', 'encrypt'])
  assert.equal(result.disk.extractable, false); assert.equal(result.disk.length, 256)
  assert.equal(result.disk.exportDenied, true); assert.equal(result.disk.noClearField, true)
  assert.equal(result.disk.differs, true); assert.ok(result.disk.encryptedLength > 3)
  assert.equal(result.local, 0); assert.equal(result.session, 0)
})

check('two tabs racing owner creation share the persisted key and exactly one absent-generation CAS wins', async (page, context) => {
  const peer = await pageFor(context)
  await Promise.all([page, peer].map((p) => p.evaluate(async () => {
    window.holdCrypto('generateKey')
    window.initializing = window.stateModule.initializeConfidentialState(window.ownerA)
  })))
  await Promise.all([page, peer].map((p) => p.waitForFunction(() => window.cryptoEntered)))
  await Promise.all([page, peer].map((p) => p.evaluate(async () => {
    window.releaseCrypto(); window.store = await window.initializing
  })))
  const results = await Promise.all([page, peer].map((p, i) => p.evaluate(async (n) =>
    window.captured(() => window.store.compareAndSwap([{
      scope: window.scope(), expectedGeneration: 0, state: window.payload(n),
    }])), i + 1)))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.find((r) => !r.ok).code, 'conflict')
  const snapshots = await Promise.all([page, peer].map((p) => p.evaluate(async () => {
    const current = await window.store.read(window.scope())
    return [current.generation, ...current.checkpoint]
  })))
  assert.deepEqual(snapshots[0], snapshots[1])
})

check('device-vault and initial room commit together; stale member aborts the entire batch', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    const vault = window.scope('device-vault'), room = window.scope()
    await store.compareAndSwap([{ scope: vault, expectedGeneration: 0, state: window.payload(1) }])
    const rejected = await window.captured(() => store.compareAndSwap([
      { scope: vault, expectedGeneration: 0, state: window.payload(2) },
      { scope: room, expectedGeneration: 0, state: window.payload(3) },
    ]))
    const absent = await store.read(room), old = await store.read(vault)
    const committed = await store.compareAndSwap([
      { scope: vault, expectedGeneration: 1, state: window.payload(4) },
      { scope: room, expectedGeneration: 0, state: window.payload(5) },
    ])
    return { rejected, absent, old: old.checkpoint[0], committed,
      vault: (await store.read(vault)).checkpoint[0], room: (await store.read(room)).checkpoint[0] }
  })
  assert.deepEqual(result.rejected, { ok: false, code: 'conflict' })
  assert.equal(result.absent, null); assert.equal(result.old, 1)
  assert.deepEqual(result.committed, [2, 1]); assert.equal(result.vault, 4); assert.equal(result.room, 5)
})

check('actual IDB abort rolls back a partial batch and acknowledgement waits for complete', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    const vault = window.scope('device-vault'), room = window.scope()
    await store.compareAndSwap([{ scope: vault, expectedGeneration: 0, state: window.payload(1) }])
    const original = IDBObjectStore.prototype.put
    let aborted = false
    IDBObjectStore.prototype.put = function (...args) {
      const req = original.apply(this, args)
      if (this.name === 'records' && !aborted) { aborted = true; this.transaction.abort() }
      return req
    }
    const failure = await window.captured(() => store.compareAndSwap([
      { scope: vault, expectedGeneration: 1, state: window.payload(2) },
      { scope: room, expectedGeneration: 0, state: window.payload(3) },
    ]))
    IDBObjectStore.prototype.put = original
    const old = await store.read(vault), missing = await store.read(room)
    const originalTransaction = IDBDatabase.prototype.transaction
    let completed = false
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = originalTransaction.apply(this, args)
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => { completed = true })
      return tx
    }
    await store.compareAndSwap([{ scope: vault, expectedGeneration: 1, state: window.payload(4) }])
    IDBDatabase.prototype.transaction = originalTransaction
    return { aborted, failure, old: old.checkpoint[0], missing, completed }
  })
  assert.equal(result.aborted, true); assert.equal(result.failure.ok, false)
  assert.equal(result.old, 1); assert.equal(result.missing, null); assert.equal(result.completed, true)
})

check('batch snapshots scope, generation and bytes before awaited encryption', async (page) => {
  await page.evaluate(async () => {
    window.store = await window.stateModule.initializeConfidentialState(window.ownerA)
    window.holdCrypto('encrypt')
    window.changes = [
      { scope: window.scope('device-vault'), expectedGeneration: 0, state: window.payload(11) },
      { scope: window.scope(), expectedGeneration: 0, state: window.payload(12) },
    ]
    window.pending = window.captured(() => window.store.compareAndSwap(window.changes))
  })
  await page.waitForFunction(() => window.cryptoEntered)
  const result = await page.evaluate(async () => {
    window.changes[1].expectedGeneration = 99
    window.changes[1].scope.roomId = window.roomB
    window.changes[1].state.checkpoint.fill(255)
    window.changes.push({ scope: window.scope('room', window.roomB), expectedGeneration: 0, state: window.payload(99) })
    window.releaseCrypto()
    const outcome = await window.pending
    return { outcome, room: (await window.store.read(window.scope())).checkpoint[0],
      other: await window.store.read(window.scope('room', window.roomB)) }
  })
  assert.equal(result.outcome.ok, true); assert.equal(result.room, 12); assert.equal(result.other, null)
})

for (const action of ['close', 'delete']) {
  check(`held real decrypt cannot return bytes after ${action}`, async (page, context) => {
    const peer = await pageFor(context)
    await page.evaluate(async () => {
      window.store = await window.stateModule.initializeConfidentialState(window.ownerA)
      await window.store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
      window.holdCrypto('decrypt')
      window.pending = window.captured(() => window.store.read(window.scope()))
    })
    await page.waitForFunction(() => window.cryptoEntered)
    if (action === 'delete') await peer.evaluate(() => window.stateModule.deleteConfidentialOwner(window.ownerA))
    else await page.evaluate(() => window.store.close())
    const outcome = await page.evaluate(async () => { window.releaseCrypto(); return window.pending })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, action === 'close' ? 'closed' : 'owner-revoked')
  })
}

check('owner deletion fences held encrypt and initializer, keeps other owner and refuses recreation', async (page, context) => {
  const peer = await pageFor(context)
  await page.evaluate(async () => {
    window.store = await window.stateModule.initializeConfidentialState(window.ownerA)
    window.other = await window.stateModule.initializeConfidentialState(window.ownerB)
    await window.other.compareAndSwap([{ scope: window.scope('room', window.roomA, window.ownerB), expectedGeneration: 0, state: window.payload(8) }])
    window.holdCrypto('encrypt')
    window.pending = window.captured(() => window.store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }]))
  })
  await page.waitForFunction(() => window.cryptoEntered)
  await peer.evaluate(() => window.stateModule.deleteConfidentialOwner(window.ownerA))
  const result = await page.evaluate(async () => {
    window.releaseCrypto()
    const pending = await window.pending
    const recreate = await window.captured(() => window.stateModule.initializeConfidentialState(window.ownerA))
    return { pending, recreate, other: (await window.other.read(window.scope('room', window.roomA, window.ownerB))).checkpoint[0] }
  })
  assert.equal(result.pending.ok, false); assert.equal(result.recreate.code, 'owner-revoked'); assert.equal(result.other, 8)
  await page.evaluate(() => {
    window.holdCrypto('generateKey')
    window.pendingInit = window.captured(() => window.stateModule.initializeConfidentialState(window.roomB))
  })
  await page.waitForFunction(() => window.cryptoEntered)
  await peer.evaluate(() => window.stateModule.deleteConfidentialOwner(window.roomB))
  assert.deepEqual(await page.evaluate(async () => { window.releaseCrypto(); return window.pendingInit }),
    { ok: false, code: 'owner-revoked' })
})

check('tampering and moving ciphertext across authenticated scope fields are refused', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    const rows = await window.raw((db) => window.idbRequest(db.transaction('records').objectStore('records').getAll()))
    const original = rows[0]
    const results = []
    for (const replacement of [window.roomB, window.ownerB, '01950000-0000-7000-8000-000000000008', '42'.repeat(32)]) {
      const fields = JSON.parse(original.id)
      const index = replacement === window.roomB ? 5 : replacement === window.ownerB ? 1 : replacement.length === 64 ? 3 : 2
      fields[index] = replacement
      const moved = { ...original, id: JSON.stringify(fields) }
      await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put(moved))
      const scope = { ...window.scope(), organisationId: fields[1], membershipId: fields[2], devicePublicKey: fields[3], roomId: fields[5] }
      results.push(await window.captured(() => store.read(scope)))
    }
    const damaged = { ...original, ciphertext: original.ciphertext.slice(0) }
    new Uint8Array(damaged.ciphertext)[0] ^= 1
    await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put(damaged))
    results.push(await window.captured(() => store.read(window.scope())))
    return results
  })
  assert.equal(result.length, 5)
  for (const outcome of result) assert.deepEqual(outcome, { ok: false, code: 'corrupt' })
})

check('invalid scopes, exhausted generations, pending bounds and checkpoint bounds refuse without writes', async (page) => {
  const outcomes = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    const s = window.scope(), p = window.payload(1)
    const mutations = [
      [{ scope: { ...s, ownerId: window.ownerB }, expectedGeneration: 0, state: p }],
      [{ scope: { ...s, devicePublicKey: 'AB'.repeat(32) }, expectedGeneration: 0, state: p }],
      [{ scope: { ...s, kind: 'device-vault' }, expectedGeneration: 0, state: p }],
      [{ scope: s, expectedGeneration: Number.MAX_SAFE_INTEGER, state: p }],
      [{ scope: s, expectedGeneration: -1, state: p }],
      [{ scope: s, expectedGeneration: 0, state: p }, { scope: s, expectedGeneration: 0, state: p }],
      [{ scope: s, expectedGeneration: 0, state: { ...p, pendingSends: [p.pendingSends[0], p.pendingSends[0]] } }],
      [{ scope: s, expectedGeneration: 0, state: { ...p, pendingSends: [{ ...p.pendingSends[0], ciphertext: new Uint8Array(64 * 1024 + 1) }] } }],
      [{ scope: s, expectedGeneration: 0, state: { ...p, checkpoint: new Uint8Array(17 * 1024 * 1024 + 1) } }],
    ]
    const rejected = []
    for (const mutation of mutations) rejected.push(await window.captured(() => store.compareAndSwap(mutation)))
    return { rejected, state: await store.read(s) }
  })
  assert.equal(outcomes.state, null)
  assert.equal(outcomes.rejected.length, 9)
  for (const outcome of outcomes.rejected) assert.equal(outcome.ok, false)
})

check('owner record cap refuses new records but permits replacing an existing generation', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    const scope = (i) => window.scope('room', `01950000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`)
    for (let start = 0; start < 64; start += 8) {
      await store.compareAndSwap(Array.from({ length: 8 }, (_, i) => ({ scope: scope(start + i), expectedGeneration: 0,
        state: { checkpoint: new Uint8Array([1]), pendingSends: [] } })))
    }
    const refusal = await window.captured(() => store.compareAndSwap([{ scope: scope(65), expectedGeneration: 0, state: window.payload(9) }]))
    const replacement = await store.compareAndSwap([{ scope: scope(0), expectedGeneration: 1, state: window.payload(7) }])
    return { refusal, replacement, retained: (await store.read(scope(0))).checkpoint[0] }
  })
  assert.deepEqual(result.refusal, { ok: false, code: 'capacity' })
  assert.deepEqual(result.replacement, [2]); assert.equal(result.retained, 7)
})

check('missing key never regenerates; closed handles and version changes refuse', async (page) => {
  const result = await page.evaluate(async () => {
    const { initializeConfidentialState, openConfidentialState } = window.stateModule
    const store = await initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    await window.rawUpdate(['owners'], (tx) => {
      const owners = tx.objectStore('owners'), req = owners.get(window.ownerA)
      req.onsuccess = () => { const row = req.result; delete row.key; owners.put(row) }
    })
    const read = await window.captured(() => store.read(window.scope()))
    const open = await window.captured(() => openConfidentialState(window.ownerA))
    const initialize = await window.captured(() => initializeConfidentialState(window.ownerA))
    store.close()
    const closed = await window.captured(() => store.read(window.scope()))
    const other = await initializeConfidentialState(window.ownerB)
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(window.stateModule.CONFIDENTIAL_STATE_DATABASE, 2)
      req.onsuccess = () => { req.result.close(); resolve() }; req.onerror = () => reject(req.error)
    })
    const changed = await window.captured(() => other.read(window.scope('room', window.roomA, window.ownerB)))
    return { read, open, initialize, closed, changed }
  })
  for (const key of ['read', 'open', 'initialize']) assert.deepEqual(result[key], { ok: false, code: 'corrupt' })
  assert.deepEqual(result.closed, { ok: false, code: 'closed' })
  assert.deepEqual(result.changed, { ok: false, code: 'closed' })
})

check('unavailable IndexedDB fails closed without a browser-storage substitute', async (page) => {
  assert.deepEqual(await page.evaluate(async () => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true })
    const result = await window.captured(() => window.stateModule.initializeConfidentialState(window.ownerA))
    return { result, local: localStorage.length, session: sessionStorage.length }
  }), { result: { ok: false, code: 'unavailable' }, local: 0, session: 0 })
})

check('lifetime owner cap includes deletion tombstones and never evicts them', async (page) => {
  const result = await page.evaluate(async () => {
    const id = (i) => `01950000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`
    for (let i = 0; i < 16; i++) await window.stateModule.deleteConfidentialOwner(id(i))
    const seventeenth = await window.captured(() => window.stateModule.initializeConfidentialState(id(16)))
    const old = await window.captured(() => window.stateModule.initializeConfidentialState(id(0)))
    const rows = await window.raw((db) => window.idbRequest(db.transaction('owners').objectStore('owners').getAll()))
    return { seventeenth, old, count: rows.length, keys: rows.filter((row) => row.key !== undefined).length }
  })
  assert.deepEqual(result.seventeenth, { ok: false, code: 'capacity' })
  assert.deepEqual(result.old, { ok: false, code: 'owner-revoked' })
  assert.equal(result.count, 16); assert.equal(result.keys, 0)
})

check('key-clone and encryption failures publish no state and never fall back to memory', async (page) => {
  const result = await page.evaluate(async () => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'owners') throw new DOMException('synthetic clone refusal', 'DataCloneError')
      return add.apply(this, args)
    }
    const refusedKey = await window.captured(() => window.stateModule.initializeConfidentialState(window.ownerA))
    IDBObjectStore.prototype.add = add
    const notInitialized = await window.captured(() => window.stateModule.openConfidentialState(window.ownerA))
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt = async () => { throw new DOMException('synthetic crypto refusal', 'OperationError') }
    const refusedCipher = await window.captured(() => store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }]))
    crypto.subtle.encrypt = encrypt
    return { refusedKey, notInitialized, refusedCipher, absent: await store.read(window.scope()) }
  })
  assert.equal(result.refusedKey.ok, false)
  assert.deepEqual(result.notInitialized, { ok: false, code: 'not-initialized' })
  assert.deepEqual(result.refusedCipher, { ok: false, code: 'storage' })
  assert.equal(result.absent, null)
})

check('generation, nonce, record kind and wrong persisted key cannot authenticate a checkpoint', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    const original = (await window.raw((db) => window.idbRequest(db.transaction('records').objectStore('records').getAll())))[0]
    const results = []
    for (const mutation of [
      { ...original, generation: original.generation + 1 },
      { ...original, iv: Uint8Array.from(new Uint8Array(original.iv), (v, i) => i === 0 ? v ^ 1 : v).buffer },
    ]) {
      await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put(mutation))
      results.push(await window.captured(() => store.read(window.scope())))
    }
    const fields = JSON.parse(original.id); fields[4] = 'device-vault'; fields[5] = null
    await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put({ ...original, id: JSON.stringify(fields) }))
    results.push(await window.captured(() => store.read(window.scope('device-vault'))))
    await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put(original))
    store.close()
    const replacement = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await window.rawUpdate(['owners'], (tx) => {
      const owners = tx.objectStore('owners'), req = owners.get(window.ownerA)
      req.onsuccess = () => owners.put({ ...req.result, key: replacement })
    })
    const reopened = await window.stateModule.openConfidentialState(window.ownerA)
    results.push(await window.captured(() => reopened.read(window.scope())))
    return results
  })
  assert.equal(result.length, 4)
  for (const outcome of result) assert.deepEqual(outcome, { ok: false, code: 'corrupt' })
})

check('a valid AEAD tag does not admit malformed bounded checkpoint framing', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    const [owner, row] = await window.raw(async (db) => {
      const tx = db.transaction(['owners', 'records'])
      const a = await window.idbRequest(tx.objectStore('owners').get(window.ownerA))
      const b = await window.idbRequest(tx.objectStore('records').getAll())
      return [a, b[0]]
    })
    const results = []
    for (const mode of ['magic', 'checkpoint-size', 'count', 'trailing']) {
      const frame = new Uint8Array(mode === 'trailing' ? 13 : 12)
      frame.set([75, 67, 83, 49])
      const view = new DataView(frame.buffer)
      if (mode === 'magic') frame[0] = 0
      if (mode === 'checkpoint-size') view.setUint32(4, 17 * 1024 * 1024 + 1)
      if (mode === 'count') view.setUint32(8, 33)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const additionalData = new TextEncoder().encode(JSON.stringify(['kodera-confidential-local-v1', row.id, row.incarnation, row.generation]))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, owner.key, frame)
      await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put({ ...row, iv: iv.buffer, ciphertext }))
      results.push(await window.captured(() => store.read(window.scope())))
    }
    return results
  })
  assert.equal(result.length, 4)
  for (const outcome of result) assert.deepEqual(outcome, { ok: false, code: 'corrupt' })
})

check('lost owner header with surviving ciphertext refuses initialization before key generation', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    store.close()
    await window.rawUpdate(['owners'], (tx) => tx.objectStore('owners').delete(window.ownerA))
    const generate = crypto.subtle.generateKey.bind(crypto.subtle)
    let generated = 0
    crypto.subtle.generateKey = (...args) => { generated++; return generate(...args) }
    const initialize = await window.captured(() => window.stateModule.initializeConfidentialState(window.ownerA))
    const open = await window.captured(() => window.stateModule.openConfidentialState(window.ownerA))
    crypto.subtle.generateKey = generate
    const persisted = await window.raw(async (db) => {
      const tx = db.transaction(['owners', 'records', 'metadata'])
      const owner = await window.idbRequest(tx.objectStore('owners').get(window.ownerA))
      const records = await window.idbRequest(tx.objectStore('records').getAll())
      const metadata = await window.idbRequest(tx.objectStore('metadata').get('capacity'))
      return { noOwner: owner === undefined, records: records.length, bytes: metadata.bytes }
    })
    return { initialize, open, generated, persisted }
  })
  assert.deepEqual(result.initialize, { ok: false, code: 'corrupt' })
  assert.deepEqual(result.open, { ok: false, code: 'corrupt' })
  assert.equal(result.generated, 0)
  assert.equal(result.persisted.noOwner, true); assert.equal(result.persisted.records, 1)
  assert.ok(result.persisted.bytes > 0)
})

check('every production write requests and reports strict durability; weaker or unsupported mode never retries', async (page) => {
  const result = await page.evaluate(async () => {
    const original = IDBDatabase.prototype.transaction
    const observed = []
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args)
      if (args[1] === 'readwrite') observed.push({ requested: args[2]?.durability, actual: tx.durability })
      return tx
    }
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    await window.stateModule.deleteConfidentialOwner(window.ownerA)
    store.close()
    IDBDatabase.prototype.transaction = original
    const failures = []
    for (const mode of ['ignored', 'unsupported']) {
      let calls = 0
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] !== 'readwrite') return original.apply(this, args)
        calls++
        if (mode === 'unsupported') throw new TypeError('synthetic unsupported strict option')
        return original.call(this, args[0], args[1], { durability: 'relaxed' })
      }
      const failure = await window.captured(() => window.stateModule.initializeConfidentialState(window.ownerB))
      IDBDatabase.prototype.transaction = original
      const absent = await window.captured(() => window.stateModule.openConfidentialState(window.ownerB))
      failures.push({ failure, absent, calls })
    }
    return { observed, failures }
  })
  assert.ok(result.observed.length >= 3)
  for (const item of result.observed) assert.deepEqual(item, { requested: 'strict', actual: 'strict' })
  for (const item of result.failures) {
    assert.deepEqual(item.failure, { ok: false, code: 'unavailable' })
    assert.deepEqual(item.absent, { ok: false, code: 'not-initialized' })
    assert.equal(item.calls, 1)
  }
})

check('orphan and repeated tombstone deletion reconcile actual bytes and remove stray rows/key', async (page) => {
  const result = await page.evaluate(async () => {
    const a = await window.stateModule.initializeConfidentialState(window.ownerA)
    const b = await window.stateModule.initializeConfidentialState(window.ownerB)
    await a.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    await b.compareAndSwap([{ scope: window.scope('room', window.roomA, window.ownerB), expectedGeneration: 0, state: window.payload(8) }])
    const original = (await window.raw((db) => window.idbRequest(db.transaction('records').objectStore('records').getAll())))
      .find((row) => row.ownerId === window.ownerA)
    a.close()
    await window.rawUpdate(['owners'], (tx) => tx.objectStore('owners').delete(window.ownerA))
    await window.stateModule.deleteConfidentialOwner(window.ownerA)
    await window.stateModule.deleteConfidentialOwner(window.ownerA)
    const strayKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await window.rawUpdate(['owners', 'records', 'metadata'], (tx) => {
      tx.objectStore('records').put(original)
      const owners = tx.objectStore('owners'), o = owners.get(window.ownerA)
      o.onsuccess = () => owners.put({ ...o.result, key: strayKey })
      const metadata = tx.objectStore('metadata'), m = metadata.get('capacity')
      m.onsuccess = () => metadata.put({ id: 'capacity', bytes: m.result.bytes + original.ciphertext.byteLength })
    })
    await window.stateModule.deleteConfidentialOwner(window.ownerA)
    const remaining = await window.raw(async (db) => {
      const tx = db.transaction(['owners', 'records', 'metadata'])
      const rows = await window.idbRequest(tx.objectStore('records').getAll())
      const owner = await window.idbRequest(tx.objectStore('owners').get(window.ownerA))
      const meta = await window.idbRequest(tx.objectStore('metadata').get('capacity'))
      return { ownerRows: rows.filter((r) => r.ownerId === window.ownerA).length,
        noKey: owner.key === undefined, status: owner.status, bytes: meta.bytes,
        actualBytes: rows.reduce((n, r) => n + r.ciphertext.byteLength, 0) }
    })
    return { remaining, other: (await b.read(window.scope('room', window.roomA, window.ownerB))).checkpoint[0] }
  })
  assert.equal(result.other, 8)
  assert.equal(result.remaining.ownerRows, 0); assert.equal(result.remaining.noKey, true)
  assert.equal(result.remaining.status, 'revoked'); assert.equal(result.remaining.bytes, result.remaining.actualBytes)
})

check('corrupt or over-limit deletion scans abort without claiming absence or changing another owner', async (page) => {
  const result = await page.evaluate(async () => {
    const a = await window.stateModule.initializeConfidentialState(window.ownerA)
    const b = await window.stateModule.initializeConfidentialState(window.ownerB)
    await a.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    await b.compareAndSwap([{ scope: window.scope('room', window.roomA, window.ownerB), expectedGeneration: 0, state: window.payload(8) }])
    const original = (await window.raw((db) => window.idbRequest(db.transaction('records').objectStore('records').getAll())))
      .find((row) => row.ownerId === window.ownerA)
    await window.rawUpdate(['records'], (tx) => tx.objectStore('records').put({ ...original, iv: new Uint8Array(11).buffer }))
    const malformed = await window.captured(() => window.stateModule.deleteConfidentialOwner(window.ownerA))
    await window.rawUpdate(['records'], (tx) => {
      tx.objectStore('records').put(original)
      for (let i = 32; i < 96; i++) {
        const fields = JSON.parse(original.id)
        fields[5] = `01950000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`
        tx.objectStore('records').put({ ...original, id: JSON.stringify(fields) })
      }
    })
    const overLimit = await window.captured(() => window.stateModule.deleteConfidentialOwner(window.ownerA))
    const persisted = await window.raw(async (db) => {
      const tx = db.transaction(['records', 'owners'])
      const count = await window.idbRequest(tx.objectStore('records').index('ownerId').count(window.ownerA))
      const owner = await window.idbRequest(tx.objectStore('owners').get(window.ownerA))
      return { count, status: owner.status, hasKey: owner.key !== undefined }
    })
    return { malformed, overLimit, persisted,
      other: (await b.read(window.scope('room', window.roomA, window.ownerB))).checkpoint[0] }
  })
  assert.deepEqual(result.malformed, { ok: false, code: 'corrupt' })
  assert.deepEqual(result.overLimit, { ok: false, code: 'corrupt' })
  assert.deepEqual(result.persisted, { count: 65, status: 'active', hasKey: true })
  assert.equal(result.other, 8)
})

check('inconsistent global accounting aborts deletion and rolls back queued record removals', async (page) => {
  const result = await page.evaluate(async () => {
    const store = await window.stateModule.initializeConfidentialState(window.ownerA)
    await store.compareAndSwap([{ scope: window.scope(), expectedGeneration: 0, state: window.payload(1) }])
    await window.rawUpdate(['metadata'], (tx) => tx.objectStore('metadata').put({ id: 'capacity', bytes: 0 }))
    const failure = await window.captured(() => window.stateModule.deleteConfidentialOwner(window.ownerA))
    const persisted = await window.raw(async (db) => {
      const tx = db.transaction(['records', 'owners'])
      const count = await window.idbRequest(tx.objectStore('records').index('ownerId').count(window.ownerA))
      const owner = await window.idbRequest(tx.objectStore('owners').get(window.ownerA))
      return { count, status: owner.status, hasKey: owner.key !== undefined }
    })
    return { failure, persisted }
  })
  assert.deepEqual(result.failure, { ok: false, code: 'corrupt' })
  assert.deepEqual(result.persisted, { count: 1, status: 'active', hasKey: true })
})
