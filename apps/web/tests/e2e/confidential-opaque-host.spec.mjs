// Unit-level outer storage/framing only. Every inner native fixture is INVALID.
// No fixture is restored as MLS or used as a fake successful native binding.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from '@playwright/test'
import ts from 'typescript'

let server, origin
test.beforeAll(async () => {
  const modules = new Map()
  for (const name of ['local-state', 'opaque-host']) {
    const source = await readFile(new URL(`../../src/features/confidential/${name}.ts`, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true,
    })
    assert.equal(compiled.diagnostics?.length ?? 0, 0)
    modules.set(`/${name}`, compiled.outputText)
  }
  server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', modules.has(req.url) ? 'text/javascript' : 'text/html')
    res.end(modules.get(req.url) ?? '<!doctype html><title>Opaque storage unit test</title>')
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
    window.localState = await import('/local-state')
    window.opaqueHost = await import('/opaque-host')
    window.owner = '01950000-0000-7000-8000-000000000001'
    window.org = '01950000-0000-7000-8000-000000000002'
    window.member = '01950000-0000-7000-8000-000000000003'
    window.room = '01950000-0000-7000-8000-000000000004'
    window.otherRoom = '01950000-0000-7000-8000-000000000005'
    window.accepted = () => ({ ownerId: window.owner, organisationId: window.org, membershipId: window.member })
    window.scope = (roomId) => ({ ...window.accepted(), devicePublicKey: '41'.repeat(32),
      kind: roomId === undefined ? 'device-vault' : 'room', ...(roomId === undefined ? {} : { roomId }) })
    window.state = (checkpoint, pendingSends = []) => ({ checkpoint, pendingSends })
    window.capture = async (operation) => {
      try { return { ok: true, value: await operation() } }
      catch (error) { return { ok: false, code: error.code ?? error.name, message: error.message, cause: 'cause' in error } }
    }
    // These are bounded framing fixtures, deliberately INVALID native AEAD/provider state.
    window.kwe = (length = 36) => {
      const bytes = new Uint8Array(56 + length)
      bytes.set(new TextEncoder().encode('KWE1')); bytes.fill(17, 4, 20); bytes.fill(119, 20, 52)
      new DataView(bytes.buffer).setUint32(52, length)
      bytes.set(new TextEncoder().encode('KDV1'), 56)
      return bytes
    }
    window.kri = (kind = 0, length = 36) => {
      const bytes = new Uint8Array(73 + length), view = new DataView(bytes.buffer)
      bytes.set(new TextEncoder().encode('KRI1')); bytes[4] = kind
      if (kind === 1) {
        view.setBigUint64(5, 1n); view.setBigUint64(13, 7n)
        bytes.set(new Uint8Array([1, 149, 0, 0, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 0, 6]), 21)
        bytes.fill(51, 37, 69)
      }
      view.setUint32(69, length); bytes.set(new TextEncoder().encode('KMS1'), 73)
      return bytes
    }
    window.kdr = (length = 33) => { const bytes = new Uint8Array(length); bytes.set(new TextEncoder().encode('KDR1')); return bytes }
    window.setup = async () => {
      const store = await window.localState.initializeConfidentialState(window.owner)
      await store.createUniqueDeviceVault(window.scope(), window.state(window.kwe()))
      return store
    }
    window.openOpaque = async (currentTicket = { checkCurrent: () => true }, accepted = window.accepted()) => {
      const owned = await window.localState.openConfidentialState(window.owner)
      return window.opaqueHost.openStoredContext(owned, accepted, currentTicket)
    }
    window.raw = async (operation) => {
      const opening = indexedDB.open(window.localState.CONFIDENTIAL_STATE_DATABASE, 1)
      const db = await new Promise((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
      })
      try { return await operation(db) } finally { db.close() }
    }
    window.req = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    window.rawWrite = (stores, operation) => window.raw((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); operation(tx)
    }))
    window.holdDecrypt = () => {
      const original = crypto.subtle.decrypt.bind(crypto.subtle)
      let release
      const held = new Promise((resolve) => { release = resolve })
      window.entered = false
      crypto.subtle.decrypt = async (...args) => {
        const result = await original(...args); window.entered = true; await held; return result
      }
      window.releaseDecrypt = () => { crypto.subtle.decrypt = original; release() }
    }
  })
  return page
}
function check(name, body) {
  test(`unit opaque storage (INVALID native fixture): ${name}`, async ({ browser }) => {
    test.setTimeout(25_000)
    const context = await browser.newContext()
    try { await body(await pageFor(context), context) } finally { await context.close() }
  })
}
function refuses(outcome, code) {
  assert.equal(outcome.ok, false); assert.equal(outcome.code, code)
  assert.equal(outcome.message, code); assert.equal(outcome.cause, false)
}

check('real outer recovery is opaque, secret-free, read-only and consumes only its dedicated connection', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.setup(), owned = await window.localState.openConfidentialState(window.owner)
    const counters = { open: 0, writes: 0, random: 0, generate: 0 }
    const open = indexedDB.open, transaction = IDBDatabase.prototype.transaction
    const random = crypto.getRandomValues, generate = crypto.subtle.generateKey
    indexedDB.open = function (...args) { counters.open++; return Reflect.apply(open, this, args) }
    IDBDatabase.prototype.transaction = function (...args) { if (args[1] === 'readwrite') counters.writes++; return Reflect.apply(transaction, this, args) }
    crypto.getRandomValues = function (...args) { counters.random++; return Reflect.apply(random, crypto, args) }
    crypto.subtle.generateKey = function (...args) { counters.generate++; return Reflect.apply(generate, crypto.subtle, args) }
    const capsule = await window.opaqueHost.openStoredContext(owned, window.accepted(), { checkCurrent: () => true })
    const descriptor = capsule.describe(), names = Object.getOwnPropertyNames(Object.getPrototypeOf(capsule)).sort()
    const noRoom = await capsule.openStoredRoom(window.room)
    const json = JSON.stringify(capsule), own = Reflect.ownKeys(capsule)
    capsule.close(); capsule.close()
    const consumed = await window.capture(() => owned.readUniqueDeviceVault(window.accepted()))
    indexedDB.open = open; IDBDatabase.prototype.transaction = transaction
    crypto.getRandomValues = random; crypto.subtle.generateKey = generate
    const fresh = await window.openOpaque(), recovered = fresh.describe(); fresh.close()
    const raw = await window.raw(async (db) => {
      const tx = db.transaction(['records', 'owners'])
      const rows = await window.req(tx.objectStore('records').getAll())
      const owner = await window.req(tx.objectStore('owners').get(window.owner))
      const exported = await window.capture(() => crypto.subtle.exportKey('raw', owner.key))
      return { encrypted: !('checkpoint' in rows[0]) && rows[0].ciphertext.byteLength > 92, extractable: owner.key.extractable, exportDenied: !exported.ok }
    })
    return { descriptor, recovered, frozen: Object.isFrozen(descriptor), names, own, json, noRoom, consumed, counters, raw,
      setupStillOpen: (await setup.readUniqueDeviceVault(window.accepted())).generation,
      exports: Object.keys(window.opaqueHost).sort(), local: localStorage.length, session: sessionStorage.length }
  })
  assert.equal(result.descriptor.native, 'unavailable'); assert.equal(result.descriptor.innerAuthentication, 'not-performed')
  assert.equal(result.descriptor.generation, 1); assert.equal(result.frozen, true)
  assert.deepEqual(result.recovered, result.descriptor); assert.equal(result.json, '{}'); assert.deepEqual(result.own, [])
  assert.deepEqual(result.names, ['close', 'constructor', 'describe', 'openStoredRoom'])
  assert.deepEqual(result.exports, ['OpaqueHostError', 'openStoredContext'])
  assert.equal(result.noRoom, null); assert.equal(result.consumed.code, 'closed'); assert.equal(result.setupStillOpen, 1)
  assert.deepEqual(result.counters, { open: 0, writes: 0, random: 0, generate: 0 })
  assert.deepEqual(result.raw, { encrypted: true, extractable: false, exportDenied: true })
  assert.equal(result.local, 0); assert.equal(result.session, 0)
})

check('empty, wrong-context, closed and foreign store inputs never initialize or grant availability', async (page) => {
  const result = await page.evaluate(async () => {
    const emptyStore = await window.localState.initializeConfidentialState(window.owner)
    const empty = await window.opaqueHost.openStoredContext(emptyStore, window.accepted(), { checkCurrent: () => true })
    const consumed = await window.capture(() => emptyStore.readUniqueDeviceVault(window.accepted()))
    const setup = await window.setup()
    const other = await window.localState.initializeConfidentialState(window.otherRoom)
    await other.createUniqueDeviceVault({ ...window.scope(), ownerId: window.otherRoom }, window.state(window.kwe()))
    let duckCalled = false
    const foreign = await window.capture(() => window.opaqueHost.openStoredContext({ readUniqueDeviceVault() { duckCalled = true } }, window.accepted(), { checkCurrent: () => true }))
    const mismatch = await window.capture(() => window.openOpaque({ checkCurrent: () => true }, { ...window.accepted(), ownerId: window.otherRoom }))
    const invalid = await window.capture(() => window.openOpaque({ checkCurrent: () => true }, { ...window.accepted(), membershipId: '00000000-0000-0000-0000-000000000000' }))
    const closedStore = await window.localState.openConfidentialState(window.owner); closedStore.close()
    const closed = await window.capture(() => window.opaqueHost.openStoredContext(closedStore, window.accepted(), { checkCurrent: () => true }))
    const actual = await window.localState.openConfidentialState(window.owner)
    let injected = false
    actual.readUniqueDeviceVault = () => { injected = true; throw new Error('injected reader') }
    actual.close = () => { injected = true }
    const capsule = await window.opaqueHost.openStoredContext(actual, window.accepted(), { checkCurrent: () => true })
    const actualGeneration = capsule.describe().generation; capsule.close()
    const actualClosed = await window.capture(() => window.localState.ConfidentialStateStore.prototype.readUniqueDeviceVault.call(actual, window.accepted()))
    return { empty, consumed, foreign, mismatch, invalid, closed, duckCalled, injected, actualGeneration, actualClosed,
      remains: (await setup.readUniqueDeviceVault(window.accepted())).generation,
      otherRemains: (await other.readUniqueDeviceVault(window.accepted())).generation }
  })
  assert.equal(result.empty, null); assert.equal(result.consumed.code, 'closed'); assert.equal(result.duckCalled, false); assert.equal(result.remains, 1)
  refuses(result.foreign, 'invalid-input'); refuses(result.mismatch, 'corrupt'); refuses(result.invalid, 'invalid-input'); refuses(result.closed, 'closed')
  assert.equal(result.injected, false); assert.equal(result.actualGeneration, 1); assert.equal(result.actualClosed.code, 'closed')
  assert.equal(result.otherRemains, 1)
})

check('private KWE1 framing refuses every short header and malformed lengths without native fallback', async (page) => {
  const outcomes = await page.evaluate(async () => {
    const setup = await window.setup(); let generation = 1
    const frames = Array.from({ length: 56 }, (_, n) => window.kwe().slice(0, n))
    frames.push(window.kwe().slice(0, 91), window.kwe(35))
    for (const mode of ['magic', 'native-magic', 'declared', 'uint32', 'trailing', 'legacy']) {
      let frame = mode === 'trailing' ? new Uint8Array(93) : mode === 'legacy' ? new Uint8Array(36) : window.kwe()
      if (mode === 'trailing') frame.set(window.kwe())
      if (mode === 'legacy') frame.set(new TextEncoder().encode('KDV1'))
      if (mode === 'magic') frame[0] = 0
      if (mode === 'native-magic') frame[56] = 0
      if (mode === 'declared') new DataView(frame.buffer).setUint32(52, 37)
      if (mode === 'uint32') new DataView(frame.buffer).setUint32(52, 0xffffffff)
      frames.push(frame)
    }
    const result = []
    for (const frame of frames) {
      await setup.compareAndSwap([{ scope: window.scope(), expectedGeneration: generation++, state: window.state(frame) }])
      result.push(await window.capture(() => window.openOpaque()))
    }
    await setup.compareAndSwap([{ scope: window.scope(), expectedGeneration: generation, state: window.state(window.kwe(), [{ id: window.room, ciphertext: new Uint8Array([1]) }]) }])
    result.push(await window.capture(() => window.openOpaque()))
    return result
  })
  assert.equal(outcomes.length, 65)
  for (const outcome of outcomes) refuses(outcome, 'corrupt')
})

check('generation dispatch is strict and one room slot is released only by explicit close', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.setup(), creator = window.kri(), welcome = window.kri(1)
    new DataView(welcome.buffer).setBigUint64(5, 9007199254740991n)
    new DataView(welcome.buffer).setBigUint64(13, 9007199254740991n)
    await setup.compareAndSwap([
      { scope: window.scope(window.room), expectedGeneration: 0, state: window.state(creator) },
      { scope: window.scope(window.otherRoom), expectedGeneration: 0, state: window.state(welcome) },
    ])
    const device = await window.openOpaque(), first = await device.openStoredRoom(window.room)
    const initial = first.describe(), names = Object.getOwnPropertyNames(Object.getPrototypeOf(first)).sort()
    const capacity = await window.capture(() => device.openStoredRoom(window.otherRoom))
    first.close(); first.close()
    const closed = await window.capture(() => first.describe())
    const second = await device.openStoredRoom(window.otherRoom), recipient = second.describe(); second.close()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 1, state: window.state(window.kdr(), [
      { id: window.otherRoom, ciphertext: new Uint8Array([9, 8]) },
    ]) }])
    const upgraded = await device.openStoredRoom(window.room), durable = upgraded.describe()
    const roomJson = JSON.stringify(upgraded), frozen = Object.isFrozen(durable)
    device.close()
    return { initial, recipient, durable, capacity, closed, names, roomJson, frozen,
      parentClosed: await window.capture(() => device.describe()), childClosed: await window.capture(() => upgraded.describe()),
      callerBytesIntact: creator[0] === 75 && welcome[4] === 1 }
  })
  assert.equal(result.initial.format, 'initial'); assert.equal(result.initial.generation, 1)
  assert.equal(result.recipient.format, 'initial'); assert.notEqual(result.initial.roomId, result.recipient.roomId)
  assert.equal(result.durable.format, 'durable'); assert.equal(result.durable.generation, 2)
  assert.equal(result.durable.native, 'unavailable'); assert.equal(result.durable.innerAuthentication, 'not-performed')
  assert.deepEqual(result.names, ['close', 'constructor', 'describe']); assert.equal(result.roomJson, '{}'); assert.equal(result.frozen, true)
  assert.equal(result.callerBytesIntact, true)
  refuses(result.capacity, 'capacity'); refuses(result.closed, 'closed'); refuses(result.parentClosed, 'closed'); refuses(result.childClosed, 'closed')
})

check('KRI1 creator, Welcome, unsafe-number and format mismatches refuse without cross-format fallback', async (page) => {
  const outcomes = await page.evaluate(async () => {
    const setup = await window.setup(), frames = []
    for (const mode of ['creator-epoch', 'creator-sequence', 'creator-id', 'creator-digest', 'welcome-epoch', 'welcome-sequence', 'welcome-nil',
      'unsafe-epoch', 'unsafe-sequence', 'unknown-kind', 'native-magic', 'declared', 'uint32', 'trailing', 'short', 'raw-kms', 'raw-kdr']) {
      let frame = mode === 'raw-kdr' ? window.kdr() : mode === 'raw-kms' ? new Uint8Array(36) :
        window.kri(mode.startsWith('welcome') || mode.startsWith('unsafe') ? 1 : 0)
      const view = new DataView(frame.buffer)
      if (mode === 'creator-epoch') view.setBigUint64(5, 1n)
      if (mode === 'creator-sequence') view.setBigUint64(13, 1n)
      if (mode === 'creator-id') frame[21] = 1
      if (mode === 'creator-digest') frame[37] = 1
      if (mode === 'welcome-epoch') view.setBigUint64(5, 0n)
      if (mode === 'welcome-sequence') view.setBigUint64(13, 0n)
      if (mode === 'welcome-nil') frame.fill(0, 21, 37)
      if (mode === 'unsafe-epoch') view.setBigUint64(5, 9007199254740992n)
      if (mode === 'unsafe-sequence') view.setBigUint64(13, 9007199254740992n)
      if (mode === 'unknown-kind') frame[4] = 2
      if (mode === 'native-magic') frame[73] = 0
      if (mode === 'declared') view.setUint32(69, 35)
      if (mode === 'uint32') view.setUint32(69, 0xffffffff)
      if (mode === 'trailing') { const extra = new Uint8Array(frame.length + 1); extra.set(frame); frame = extra }
      if (mode === 'short') frame = frame.slice(0, 108)
      if (mode === 'raw-kms') frame.set(new TextEncoder().encode('KMS1'))
      frames.push(frame)
    }
    const result = []
    for (let i = 0; i < frames.length; i++) {
      const roomId = `01950000-0000-7000-8000-${(i + 100).toString(16).padStart(12, '0')}`
      await setup.compareAndSwap([{ scope: window.scope(roomId), expectedGeneration: 0, state: window.state(frames[i]) }])
      const device = await window.openOpaque()
      result.push(await window.capture(() => device.openStoredRoom(roomId)))
      result.push(await window.capture(() => device.describe()))
    }
    // A valid initial frame under generation two must not fall back to KRI1.
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri()) }])
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 1, state: window.state(window.kri()) }])
    const device = await window.openOpaque(); result.push(await window.capture(() => device.openStoredRoom(window.room)))
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 2, state: window.state(window.kdr(32)) }])
    const shortDurable = await window.openOpaque(); result.push(await window.capture(() => shortDurable.openStoredRoom(window.room)))
    // Generation one also requires an empty external outbox.
    await setup.compareAndSwap([{ scope: window.scope(window.otherRoom), expectedGeneration: 0, state: window.state(window.kri(1), [
      { id: window.room, ciphertext: new Uint8Array([1]) },
    ]) }])
    const fresh = await window.openOpaque(); result.push(await window.capture(() => fresh.openStoredRoom(window.otherRoom)))
    return result
  })
  assert.equal(outcomes.length, 37)
  for (const outcome of outcomes) refuses(outcome, 'corrupt')
})

check('actual outer AEAD fails while a changed invalid native tag stays explicitly opaque', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.setup(), changedInner = window.kwe(); changedInner[changedInner.length - 1] = 255
    await setup.compareAndSwap([{ scope: window.scope(), expectedGeneration: 1, state: window.state(changedInner) }])
    const opaque = await window.openOpaque(), descriptor = opaque.describe(); opaque.close()
    const row = (await window.raw((db) => window.req(db.transaction('records').objectStore('records').getAll())))[0]
    const results = []
    for (const mode of ['ciphertext', 'nonce', 'generation', 'scope']) {
      const changed = { ...row, ciphertext: row.ciphertext.slice(0), iv: row.iv.slice(0) }
      if (mode === 'ciphertext') new Uint8Array(changed.ciphertext)[0] ^= 1
      if (mode === 'nonce') new Uint8Array(changed.iv)[0] ^= 1
      if (mode === 'generation') changed.generation++
      if (mode === 'scope') { const scope = JSON.parse(row.id); scope[3] = '42'.repeat(32); changed.id = JSON.stringify(scope) }
      await window.rawWrite(['records'], (tx) => { tx.objectStore('records').delete(row.id); tx.objectStore('records').put(changed) })
      results.push(await window.capture(() => window.openOpaque()))
      await window.rawWrite(['records'], (tx) => { tx.objectStore('records').delete(changed.id); tx.objectStore('records').put(row) })
    }
    return { descriptor, results }
  })
  assert.equal(result.descriptor.native, 'unavailable'); assert.equal(result.descriptor.innerAuthentication, 'not-performed')
  for (const outcome of result.results) refuses(outcome, 'corrupt')
})

check('observed invalid or throwing tickets permanently poison existing handles and redact errors', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.setup()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri()) }])
    const accepted = window.accepted(), current = { valid: true, checkCurrent() { return this.valid } }
    const device = await window.openOpaque(current, accepted), room = await device.openStoredRoom(window.room)
    accepted.ownerId = window.otherRoom; accepted.organisationId = window.otherRoom
    const unchangedContext = device.describe()
    current.checkCurrent = () => true; current.valid = false
    const invalid = await window.capture(() => room.describe())
    current.valid = true
    const stillPoisoned = await window.capture(() => device.describe())
    const noReopen = await window.capture(() => device.openStoredRoom(window.room))
    const fresh = await window.openOpaque(), reloaded = fresh.describe(); fresh.close()
    const throwing = { shouldThrow: false, checkCurrent() { if (this.shouldThrow) throw new Error('sensitive-ticket-detail'); return true } }
    const doomed = await window.openOpaque(throwing); throwing.shouldThrow = true
    const thrown = await window.capture(() => doomed.describe()); throwing.shouldThrow = false
    const thrownStillPoisoned = await window.capture(() => doomed.describe())
    const initialFalse = await window.capture(() => window.openOpaque({ checkCurrent: () => false }))
    const nonBoolean = await window.capture(() => window.openOpaque({ checkCurrent: () => Promise.resolve(true) }))
    return { unchangedContext, invalid, stillPoisoned, noReopen, reloaded, thrown, thrownStillPoisoned, initialFalse, nonBoolean }
  })
  assert.equal(result.unchangedContext.ownerId, result.reloaded.ownerId)
  assert.equal(result.unchangedContext.organisationId, result.reloaded.organisationId)
  for (const name of ['invalid', 'stillPoisoned', 'noReopen', 'thrown', 'thrownStillPoisoned', 'initialFalse', 'nonBoolean']) refuses(result[name], 'context-changed')
  assert.equal(JSON.stringify(result).includes('sensitive-ticket-detail'), false)
})

check('synchronous ticket closure during device describe wins over true and false results', async (page) => {
  const results = await page.evaluate(async () => {
    await window.setup()
    const results = []
    for (const ticketResult of [true, false]) {
      let device, armed = false
      const owned = await window.localState.openConfidentialState(window.owner)
      const ticket = { checkCurrent() { if (armed) device.close(); return armed ? ticketResult : true } }
      device = await window.opaqueHost.openStoredContext(owned, window.accepted(), ticket)
      armed = true
      const described = await window.capture(() => device.describe())
      armed = false
      results.push({ described, later: await window.capture(() => device.describe()),
        room: await window.capture(() => device.openStoredRoom(window.room)),
        connection: await window.capture(() => owned.readUniqueDeviceVault(window.accepted())) })
    }
    const fresh = await window.openOpaque(), recovered = fresh.describe(); fresh.close()
    return { results, recovered }
  })
  for (const outcomes of results.results) {
    for (const outcome of Object.values(outcomes)) refuses(outcome, 'closed')
  }
  assert.equal(results.recovered.native, 'unavailable')
})

check('synchronous ticket closure at the post-read room fence exposes no room and closes its connection', async (page) => {
  await page.evaluate(async () => {
    const setup = await window.setup()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri()) }])
    window.closeFromTicket = false
    window.transferred = await window.localState.openConfidentialState(window.owner)
    window.device = await window.opaqueHost.openStoredContext(window.transferred, window.accepted(), {
      checkCurrent() { if (window.closeFromTicket) window.device.close(); return true },
    })
    window.holdDecrypt()
    window.pending = window.capture(() => window.device.openStoredRoom(window.room))
  })
  await page.waitForFunction(() => window.entered)
  const result = await page.evaluate(async () => {
    window.closeFromTicket = true; window.releaseDecrypt()
    const pending = await window.pending; window.closeFromTicket = false
    return { pending, described: await window.capture(() => window.device.describe()),
      reopened: await window.capture(() => window.device.openStoredRoom(window.room)),
      connection: await window.capture(() => window.transferred.readUniqueDeviceVault(window.accepted())) }
  })
  for (const outcome of Object.values(result)) refuses(outcome, 'closed')
})

check('synchronous child closure during its ticket cannot return a descriptor or close its live parent', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.setup()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri()) }])
    let child, armed = false
    const device = await window.openOpaque({ checkCurrent() { if (armed) child.close(); return true } })
    child = await device.openStoredRoom(window.room); armed = true
    const described = await window.capture(() => child.describe()); armed = false
    const old = await window.capture(() => child.describe()), parent = device.describe()
    const fresh = await device.openStoredRoom(window.room), recovered = fresh.describe()
    fresh.close(); device.close()
    return { described, old, parent, recovered }
  })
  refuses(result.described, 'closed'); refuses(result.old, 'closed')
  assert.equal(result.parent.native, 'unavailable'); assert.equal(result.recovered.format, 'initial')
})

check('a ticket invalidated during a real held factory decrypt cannot expose or resurrect a capsule', async (page) => {
  await page.evaluate(async () => {
    await window.setup(); window.ticket = { valid: true, checkCurrent() { return this.valid } }
    window.transferred = await window.localState.openConfidentialState(window.owner)
    window.holdDecrypt()
    window.pending = window.capture(() => window.opaqueHost.openStoredContext(window.transferred, window.accepted(), window.ticket))
  })
  await page.waitForFunction(() => window.entered)
  const result = await page.evaluate(async () => {
    window.ticket.valid = false; window.releaseDecrypt()
    const invalid = await window.pending; window.ticket.valid = true
    const closed = await window.capture(() => window.transferred.readUniqueDeviceVault(window.accepted()))
    const fresh = await window.openOpaque(window.ticket), descriptor = fresh.describe(); fresh.close()
    return { invalid, closed, descriptor }
  })
  refuses(result.invalid, 'context-changed'); assert.equal(result.closed.code, 'closed'); assert.equal(result.descriptor.native, 'unavailable')
})

for (const action of ['close', 'delete', 'ticket']) {
  check(`one in-flight room read is bounded and cannot expose bytes after ${action}`, async (page, context) => {
    const peer = await pageFor(context)
    await page.evaluate(async () => {
      const setup = await window.setup()
      await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri()) }])
      window.ticket = { valid: true, checkCurrent() { return this.valid } }
      window.device = await window.openOpaque(window.ticket); window.holdDecrypt()
      window.pending = window.capture(() => window.device.openStoredRoom(window.room))
    })
    await page.waitForFunction(() => window.entered)
    const busy = await page.evaluate(() => window.capture(() => window.device.openStoredRoom(window.otherRoom)))
    refuses(busy, 'capacity')
    if (action === 'delete') await peer.evaluate(() => window.localState.deleteConfidentialOwner(window.owner))
    else await page.evaluate((action) => { if (action === 'close') window.device.close(); else window.ticket.valid = false }, action)
    const result = await page.evaluate(async () => {
      window.releaseDecrypt(); const pending = await window.pending; window.ticket.valid = true
      return { pending, old: await window.capture(() => window.device.describe()) }
    })
    const code = action === 'close' ? 'closed' : action === 'delete' ? 'owner-revoked' : 'context-changed'
    refuses(result.pending, code); refuses(result.old, code)
  })
}

check('actual atomic foundation abort and commit-before-ack recover authoritative KRI1 then KDR1 generations', async (page) => {
  const result = await page.evaluate(async () => {
    let setup = await window.setup()
    const batch = () => [
      { scope: window.scope(), expectedGeneration: 1, state: window.state(window.kwe()) },
      { scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri(1)) },
    ]
    const conflict = await window.capture(() => setup.compareAndSwap([{ ...batch()[0], expectedGeneration: 0 }, batch()[1]]))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) { const req = Reflect.apply(put, this, args); if (this.name === 'records') this.transaction.abort(); return req }
    const aborted = await window.capture(() => setup.compareAndSwap(batch()))
    IDBObjectStore.prototype.put = put
    const old = await setup.readUniqueDeviceVault(window.accepted()), missing = await setup.read(window.scope(window.room))
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = Reflect.apply(transaction, this, args)
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => setup.close(), { once: true })
      return tx
    }
    const unacknowledged = await window.capture(() => setup.compareAndSwap(batch()))
    IDBDatabase.prototype.transaction = transaction
    setup = await window.localState.openConfidentialState(window.owner)
    let device = await window.openOpaque(), room = await device.openStoredRoom(window.room)
    const deviceGeneration = device.describe().generation, initial = room.describe(); device.close()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 1, state: window.state(window.kdr()) }])
    device = await window.openOpaque(); room = await device.openStoredRoom(window.room)
    const durable = room.describe(); device.close()
    return { conflict, aborted, old: old.generation, missing, unacknowledged, deviceGeneration, initial, durable }
  })
  assert.equal(result.conflict.code, 'conflict'); assert.equal(result.aborted.ok, false)
  assert.equal(result.old, 1); assert.equal(result.missing, null); assert.equal(result.unacknowledged.code, 'closed')
  assert.equal(result.deviceGeneration, 2); assert.equal(result.initial.generation, 1); assert.equal(result.initial.format, 'initial')
  assert.equal(result.durable.generation, 2); assert.equal(result.durable.format, 'durable')
  assert.equal(result.durable.native, 'unavailable')
})

check('maximum profile frames stay opaque and larger declared/native/store bounds fail closed', async (page) => {
  const result = await page.evaluate(async () => {
    const setup = await window.localState.initializeConfidentialState(window.owner)
    await setup.createUniqueDeviceVault(window.scope(), window.state(window.kwe(17 * 1024 * 1024 - 56)))
    await setup.compareAndSwap([
      { scope: window.scope(window.room), expectedGeneration: 0, state: window.state(window.kri(1, 14 * 1024 * 1024)) },
      { scope: window.scope(window.otherRoom), expectedGeneration: 0, state: window.state(window.kri(1, 14 * 1024 * 1024 + 1)) },
    ])
    const device = await window.openOpaque(), room = await device.openStoredRoom(window.room)
    const admitted = { device: device.describe().native, room: room.describe().format }; room.close()
    const oversizedInitial = await window.capture(() => device.openStoredRoom(window.otherRoom))
    const oversizedDevice = await window.capture(() => setup.compareAndSwap([{ scope: window.scope(), expectedGeneration: 1,
      state: window.state(window.kwe(17 * 1024 * 1024 - 55)) }]))
    let fresh = await window.openOpaque(); const preserved = fresh.describe().generation; fresh.close()
    await setup.compareAndSwap([{ scope: window.scope(window.room), expectedGeneration: 1,
      state: window.state(window.kdr(17 * 1024 * 1024), Array.from({ length: 16 }, (_, i) => ({
        id: `01950000-0000-7000-8000-${(i + 200).toString(16).padStart(12, '0')}`, ciphertext: new Uint8Array(64 * 1024),
      }))) }])
    fresh = await window.openOpaque(); const largest = await fresh.openStoredRoom(window.room)
    const durable = largest.describe(); fresh.close()
    return { admitted, oversizedInitial, oversizedDevice, preserved, durable }
  })
  assert.deepEqual(result.admitted, { device: 'unavailable', room: 'initial' })
  refuses(result.oversizedInitial, 'corrupt'); assert.equal(result.oversizedDevice.code, 'capacity'); assert.equal(result.preserved, 1)
  assert.equal(result.durable.format, 'durable'); assert.equal(result.durable.native, 'unavailable')
})

check('accepted context and ticket method are captured before awaited factory decryption', async (page) => {
  await page.evaluate(async () => {
    await window.setup()
    window.contextInput = window.accepted()
    window.ticket = { valid: true, checkCurrent() { return this.valid } }
    window.holdDecrypt()
    window.pending = window.openOpaque(window.ticket, window.contextInput)
  })
  await page.waitForFunction(() => window.entered)
  const result = await page.evaluate(async () => {
    window.contextInput.ownerId = window.otherRoom; window.contextInput.organisationId = window.otherRoom
    window.contextInput.membershipId = window.otherRoom
    window.ticket.checkCurrent = () => false
    window.releaseDecrypt()
    const capsule = await window.pending, descriptor = capsule.describe()
    window.ticket.valid = false
    const invalid = await window.capture(() => capsule.describe())
    window.ticket.valid = true; window.ticket.checkCurrent = () => true
    return { descriptor, invalid, stillPoisoned: await window.capture(() => capsule.describe()), expected: window.accepted() }
  })
  assert.equal(result.descriptor.ownerId, result.expected.ownerId)
  assert.equal(result.descriptor.organisationId, result.expected.organisationId)
  assert.equal(result.descriptor.membershipId, result.expected.membershipId)
  refuses(result.invalid, 'context-changed'); refuses(result.stillPoisoned, 'context-changed')
})
