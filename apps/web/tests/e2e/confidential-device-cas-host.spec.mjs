// Real IDB/host structural tests only. KDV1 bytes below are deliberately INVALID
// native seals; successful outer persistence never means native or Core admission.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from '@playwright/test'
import ts from 'typescript'

let server, origin
test.beforeAll(async () => {
  const modules = new Map()
  for (const name of ['local-state', 'device-http-record', 'device-cas-host']) {
    const source = await readFile(new URL(`../../src/features/confidential/${name}.ts`, import.meta.url), 'utf8')
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true,
    })
    assert.equal(result.diagnostics?.length ?? 0, 0); modules.set(`/${name}`, result.outputText)
    if (name === 'device-cas-host') {
      const guard = 'reread.generation === expected.nextHostGeneration &&'
      assert.equal(source.split(guard).length, 2, 'one actual final-G guard must be mutated')
      const mutant = ts.transpileModule(source.replace(guard, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true,
      })
      assert.equal(mutant.diagnostics?.length ?? 0, 0)
      modules.set('/device-cas-host-without-final-g', mutant.outputText)
    }
  }
  const vectors = await readFile(new URL('../../../../packages/kodera-rs/vectors/device-http-v1.json', import.meta.url), 'utf8')
  server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/vectors') { res.setHeader('Content-Type', 'application/json'); res.end(vectors); return }
    res.setHeader('Content-Type', modules.has(req.url) ? 'text/javascript' : 'text/html')
    res.end(modules.get(req.url) ?? '<!doctype html><title>Device CAS host structural checks</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
test.afterAll(async () => { if (server) await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) })

async function pageFor(context) {
  const page = await context.newPage(); await page.goto(origin)
  await page.evaluate(async () => {
    window.storage = await import('/local-state'); window.codec = await import('/device-http-record')
    window.hostModule = await import('/device-cas-host'); window.vectors = await (await fetch('/vectors')).json()
    const ids = window.vectors.records[0].record.scope
    window.accepted = { ownerId: ids[0], organisationId: ids[1], membershipId: ids[2] }
    window.scope = { ...window.accepted, devicePublicKey: ids[3], kind: 'device-vault' }
    window.context = { organisationId: ids[1], membershipId: ids[2] }
    window.hash = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    window.sealed = crypto.getRandomValues(new Uint8Array(36)); window.sealed.set([75, 68, 86, 49])
    window.initial = new Uint8Array(56 + window.sealed.length)
    window.initial.set([75, 87, 69, 49]); crypto.getRandomValues(window.initial.subarray(4, 52))
    new DataView(window.initial.buffer).setUint32(52, window.sealed.length); window.initial.set(window.sealed, 56)
    window.store = await window.storage.initializeConfidentialState(ids[0])
    await window.store.createUniqueDeviceVault(window.scope, { checkpoint: window.initial, pendingSends: [] })
    window.current = true
    window.host = window.hostModule.createDeviceCasHost(window.store, window.accepted, () => () => window.current)
    window.captured = async (operation) => {
      try { return { ok: true, value: [...await operation()] } }
      catch (error) { return { ok: false, code: error.code ?? error.name } }
    }
    window.frame = (record) => {
      const json = new TextEncoder().encode(JSON.stringify(record)), result = new Uint8Array(8 + json.length)
      result.set([75, 68, 72, 49]); new DataView(result.buffer).setUint32(4, json.length); result.set(json, 8); return result
    }
    window.metadata = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
    window.request = async (index = 1, expectedN = 1, nextN = 1, expectedG = 1, nextG = 2, sealed = window.sealed) => {
      const record = structuredClone(window.vectors.records[index].record)
      record.nativeGeneration = nextN; record.sealedSha256 = await window.hash(sealed)
      const manifest = window.frame(record)
      const meta = { version: 2, ...window.accepted, devicePublicKey: window.scope.devicePublicKey, recordId: record.recordId,
        expectedNativeGeneration: expectedN, nextNativeGeneration: nextN, expectedHostGeneration: expectedG, nextHostGeneration: nextG,
        sealedSha256: record.sealedSha256, recordSha256: await window.hash(manifest) }
      return { meta, sealed: sealed.slice(), manifest, record }
    }
    window.write = (request) => window.host.compareAndSwapDeviceV2(window.metadata(request.meta), request.sealed, request.manifest)
    window.read = async () => {
      const peer = await window.storage.openConfidentialState(window.accepted.ownerId)
      try { return await peer.readUniqueDeviceVault(window.context) } finally { peer.close() }
    }
  })
  return page
}
function check(name, run) {
  test(`device CAS host structural: ${name}`, async ({ browser }) => {
    test.setTimeout(25_000); const context = await browser.newContext()
    try { await run(await pageFor(context), context) } finally { await context.close() }
  })
}

check('strict oncomplete precedes full ACK; capsule header and separate N/G survive', async (page) => {
  const result = await page.evaluate(async () => {
    const original = IDBDatabase.prototype.transaction; let completed = false
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args)
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => { completed = true })
      return tx
    }
    const request = await window.request(), ack = await window.write(request)
    IDBDatabase.prototype.transaction = original
    const value = await window.read()
    return { completed, ack: window.codec.decodeDeviceHttpAck(ack), generation: value.generation,
      header: [...value.state.checkpoint.subarray(0, 52)], original: [...window.initial.subarray(0, 52)],
      sealed: [...value.state.checkpoint.subarray(56)], expectedSealed: [...window.sealed],
      nestedHash: await window.hash(value.state.checkpoint.subarray(56)), wrapperHash: await window.hash(value.state.checkpoint),
      manifestHash: await window.hash(value.state.pendingSends[0].ciphertext), exports: Object.keys(window.host).sort(),
      id: value.state.pendingSends[0].id, record: await window.codec.decodeDeviceHttpRecord(value.state.pendingSends[0].ciphertext), count: value.state.pendingSends.length }
  })
  assert.equal(result.completed, true); assert.equal(result.generation, 2)
  assert.equal(result.ack.expectedNativeGeneration, 1); assert.equal(result.ack.nextNativeGeneration, 1)
  assert.equal(result.ack.expectedHostGeneration, 1); assert.equal(result.ack.nextHostGeneration, 2)
  assert.deepEqual(result.header, result.original); assert.deepEqual(result.sealed, result.expectedSealed)
  assert.equal(result.count, 1); assert.equal(result.id, result.record.recordId)
  assert.equal(result.ack.sealedSha256, result.nestedHash); assert.notEqual(result.ack.sealedSha256, result.wrapperHash)
  assert.equal(result.ack.recordSha256, result.manifestHash)
  assert.deepEqual(result.exports, ['close', 'compareAndSwapDeviceV2'])
})

check('native successor atomically replaces seal plus receipt plus pending retirement', async (page) => {
  const result = await page.evaluate(async () => {
    await window.write(await window.request())
    const next = window.sealed.slice(); next[35] ^= 1
    const ack = await window.write(await window.request(3, 1, 2, 2, 3, next))
    const value = await window.read(), record = await window.codec.decodeDeviceHttpRecord(value.state.pendingSends[0].ciphertext)
    return { ack: window.codec.decodeDeviceHttpAck(ack), generation: value.generation, record,
      sealed: [...value.state.checkpoint.subarray(56)], expected: [...next], header: [...value.state.checkpoint.subarray(0, 52)], original: [...window.initial.subarray(0, 52)] }
  })
  assert.equal(result.generation, 3); assert.equal(result.record.nativeGeneration, 2)
  assert.equal(result.record.pending, null); assert.ok(result.record.admission)
  assert.deepEqual(result.sealed, result.expected); assert.deepEqual(result.header, result.original)
  assert.equal(result.ack.nextNativeGeneration, 2); assert.equal(result.ack.nextHostGeneration, 3)
})

for (const mutation of ['unknown', 'duplicate', 'wrong-scope', 'wrong-record', 'wrong-seal-hash', 'wrong-frame-hash', 'skipped-G', 'skipped-N']) {
  check(`rejects closed metadata ${mutation} before any write`, async (page) => {
    const result = await page.evaluate(async (mode) => {
      const request = await window.request(); let metadata
      if (mode === 'unknown') request.meta.extra = 1
      if (mode === 'wrong-scope') request.meta.membershipId = window.accepted.ownerId
      if (mode === 'wrong-record') request.meta.recordId = window.accepted.ownerId
      if (mode === 'wrong-seal-hash') {
        // Keep metadata and KDH1 mutually consistent, so only hashing actual KDV1 refuses.
        request.meta.sealedSha256 = '00'.repeat(32); request.record.sealedSha256 = request.meta.sealedSha256
        request.manifest = window.frame(request.record); request.meta.recordSha256 = await window.hash(request.manifest)
      }
      if (mode === 'wrong-frame-hash') request.meta.recordSha256 = '00'.repeat(32)
      if (mode === 'skipped-G') request.meta.nextHostGeneration += 1
      if (mode === 'skipped-N') request.meta.nextNativeGeneration += 2
      metadata = window.metadata(request.meta)
      if (mode === 'duplicate') metadata = metadata.replace('{', '{"version":2,')
      const failure = await window.captured(() => window.host.compareAndSwapDeviceV2(metadata, request.sealed, request.manifest))
      const current = await window.read(); return { failure, generation: current.generation, pending: current.state.pendingSends.length }
    }, mutation)
    assert.equal(result.failure.ok, false); assert.equal(result.generation, 1); assert.equal(result.pending, 0)
  })
}

check('G-only seal replacement refuses even when both supplied digests match', async (page) => {
  const result = await page.evaluate(async () => {
    const different = window.sealed.slice(); different[35] ^= 1
    const failure = await window.captured(async () => window.write(await window.request(1, 1, 1, 1, 2, different)))
    const current = await window.read(); return { failure, generation: current.generation, sealed: [...current.state.checkpoint.subarray(56)], original: [...window.sealed] }
  })
  assert.equal(result.failure.ok, false); assert.equal(result.generation, 1); assert.deepEqual(result.sealed, result.original)
})

check('actual abort retains the complete predecessor and yields no ACK', async (page) => {
  const result = await page.evaluate(async () => {
    const request = await window.request(), original = IDBObjectStore.prototype.put; let aborted = false
    IDBObjectStore.prototype.put = function (...args) {
      const req = original.apply(this, args)
      if (this.name === 'records' && !aborted) { aborted = true; this.transaction.abort() }
      return req
    }
    const failure = await window.captured(() => window.write(request)); IDBObjectStore.prototype.put = original
    const current = await window.read(); return { failure, aborted, generation: current.generation, pending: current.state.pendingSends.length }
  })
  assert.equal(result.aborted, true); assert.equal(result.failure.ok, false)
  assert.equal(result.generation, 1); assert.equal(result.pending, 0)
})

check('owner deletion after a held real decrypt cannot acknowledge', async (page) => {
  await page.evaluate(async () => {
    const request = await window.request(), original = crypto.subtle.decrypt.bind(crypto.subtle)
    let release; const held = new Promise((resolve) => { release = resolve })
    window.release = () => { crypto.subtle.decrypt = original; release() }; window.entered = false
    crypto.subtle.decrypt = async (...args) => { const bytes = await original(...args); window.entered = true; await held; return bytes }
    window.pending = window.captured(() => window.write(request))
  })
  await page.waitForFunction(() => window.entered)
  await page.evaluate(async () => { await window.storage.deleteConfidentialOwner(window.accepted.ownerId); window.release() })
  const result = await page.evaluate(() => window.pending)
  assert.equal(result.ok, false)
})

for (const action of ['retire', 'close', 'reentrant-close']) {
  check(`${action} at actual transaction completion suppresses ACK after durable commit`, async (page) => {
    const result = await page.evaluate(async (action) => {
      const request = await window.request(), original = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args)
        if (args[1] === 'readwrite') tx.addEventListener('complete', () => {
          if (action === 'retire') window.current = false
          else if (action === 'close') window.host.close()
          else { window.closeOnCheck = true }
        })
        return tx
      }
      if (action === 'reentrant-close') {
        window.host = window.hostModule.createDeviceCasHost(window.store, window.accepted, () => () => {
          if (window.closeOnCheck) window.host.close()
          return true
        })
      }
      const failure = await window.captured(() => window.write(request)); IDBDatabase.prototype.transaction = original
      const current = await window.read(); return { failure, generation: current.generation, count: current.state.pendingSends.length }
    }, action)
    assert.equal(result.failure.ok, false); assert.equal(result.generation, 2); assert.equal(result.count, 1)
  })
}

check('caller bytes are frozen before first await', async (page) => {
  const result = await page.evaluate(async () => {
    const request = await window.request(), expected = [...request.manifest], sealed = [...request.sealed]
    const pending = window.write(request); request.manifest.fill(0); request.sealed.fill(0)
    const ack = await pending, current = await window.read()
    return { bytes: [...current.state.pendingSends[0].ciphertext], sealed: [...current.state.checkpoint.subarray(56)], expected, original: sealed, ack: ack.length }
  })
  assert.equal(result.ack, 276); assert.deepEqual(result.bytes, result.expected); assert.deepEqual(result.sealed, result.original)
})

check('RPC replacement cannot retarget a captured operation predicate', async (page) => {
  await page.evaluate(async () => {
    window.rpc = {}; window.captureCalls = 0
    window.host = window.hostModule.createDeviceCasHost(window.store, window.accepted, () => {
      window.captureCalls++; const captured = window.rpc
      return () => window.current && captured === window.rpc
    })
    const request = await window.request(), original = crypto.subtle.digest.bind(crypto.subtle)
    let release; const held = new Promise((resolve) => { release = resolve })
    window.release = () => { crypto.subtle.digest = original; release() }; window.entered = false
    crypto.subtle.digest = async (...args) => { const bytes = await original(...args); window.entered = true; await held; return bytes }
    window.pending = window.captured(() => window.write(request))
  })
  await page.waitForFunction(() => window.entered)
  const result = await page.evaluate(async () => {
    window.rpc = {}; window.release()
    const failure = await window.pending, current = await window.read()
    return { failure, captures: window.captureCalls, generation: current.generation }
  })
  assert.equal(result.failure.ok, false); assert.equal(result.captures, 1); assert.equal(result.generation, 1)
})

for (const mode of ['missing-manifest-at-G2', 'duplicate-entry', 'prior-seal-hash']) {
  check(`rejects predecessor ${mode} without replacing it`, async (page) => {
    const result = await page.evaluate(async (mode) => {
      const request = await window.request(), state = { checkpoint: window.initial.slice(), pendingSends: [] }
      if (mode !== 'missing-manifest-at-G2') {
        const record = structuredClone(request.record)
        if (mode === 'prior-seal-hash') record.sealedSha256 = '00'.repeat(32)
        state.pendingSends.push({ id: record.recordId, ciphertext: window.frame(record) })
        if (mode === 'duplicate-entry') state.pendingSends.push({ id: window.accepted.ownerId, ciphertext: window.frame(record) })
      }
      await window.store.compareAndSwap([{ scope: window.scope, expectedGeneration: 1, state }])
      const failure = await window.captured(async () => window.write(await window.request(1, 1, 1, 2, 3)))
      const current = await window.read(); return { failure, generation: current.generation, count: current.state.pendingSends.length, expectedCount: state.pendingSends.length }
    }, mode)
    assert.equal(result.failure.ok, false); assert.equal(result.generation, 2); assert.equal(result.count, result.expectedCount)
  })
}

for (const offset of [4, 20]) {
  check(`whole-wrapper readback detects a test-owned capsule-header fault at ${offset}`, async (page) => {
    const result = await page.evaluate(async (offset) => {
      const request = await window.request(), original = crypto.subtle.decrypt.bind(crypto.subtle); let calls = 0
      crypto.subtle.decrypt = async (...args) => {
        const plaintext = await original(...args)
        // Real AEAD first; only the second returned test-owned plaintext is faulted.
        // This isolates the whole-KWE1 check from nested KDV1 SHA and G checks.
        if (++calls === 2) new Uint8Array(plaintext)[12 + offset] ^= 1
        return plaintext
      }
      const failure = await window.captured(() => window.write(request)); crypto.subtle.decrypt = original
      const current = await window.read()
      return { failure, calls, generation: current.generation, header: [...current.state.checkpoint.subarray(0, 52)], expected: [...window.initial.subarray(0, 52)] }
    }, offset)
    assert.equal(result.failure.ok, false); assert.equal(result.calls, 2); assert.equal(result.generation, 2)
    assert.deepEqual(result.header, result.expected)
  })
}

check('reentrant close while capturing a lifetime refuses before any await or write', async (page) => {
  const result = await page.evaluate(async () => {
    window.host = window.hostModule.createDeviceCasHost(window.store, window.accepted, () => {
      window.host.close(); return () => true
    })
    const failure = await window.captured(async () => window.write(await window.request()))
    const current = await window.read(); return { failure, generation: current.generation }
  })
  assert.equal(result.failure.ok, false); assert.equal(result.generation, 1)
})

for (const mode of ['missing-operation', 'truthy-nonboolean']) {
  check(`lifetime ${mode} cannot authorize a write`, async (page) => {
    const result = await page.evaluate(async (mode) => {
      window.host = window.hostModule.createDeviceCasHost(window.store, window.accepted,
        mode === 'missing-operation' ? () => undefined : () => () => 'true')
      const failure = await window.captured(async () => window.write(await window.request()))
      const current = await window.read(); return { failure, generation: current.generation }
    }, mode)
    assert.equal(result.failure.ok, false); assert.equal(result.generation, 1)
  })
}

for (const mode of ['actual-source', 'removed-final-G-guard']) {
  check(`peer identical-byte G3 precedes final readback: ${mode}`, async (page) => {
    await page.evaluate(async (mode) => {
      if (mode === 'removed-final-G-guard') {
        const mutant = await import('/device-cas-host-without-final-g')
        window.host = mutant.createDeviceCasHost(window.store, window.accepted, () => () => window.current)
      }
      window.racingRequest = await window.request()
      window.peerState = { checkpoint: window.initial.slice(), pendingSends: [{
        id: window.racingRequest.record.recordId, ciphertext: window.racingRequest.manifest.slice(),
      }] }
      window.peerStore = await window.storage.openConfidentialState(window.accepted.ownerId)
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
      let release; const held = new Promise((resolve) => { release = resolve })
      window.releasePeer = release; window.peerEncrypted = false
      crypto.subtle.encrypt = async (...args) => {
        const ciphertext = await encrypt(...args)
        // Hold only the already-real-encrypted peer result; host encryption stays genuine/unheld.
        crypto.subtle.encrypt = encrypt; window.peerEncrypted = true
        await held; return ciphertext
      }
      window.peerCommit = window.peerStore.compareAndSwap([{
        scope: window.scope, expectedGeneration: 2, state: window.peerState,
      }])
    }, mode)
    await page.waitForFunction(() => window.peerEncrypted)
    const result = await page.evaluate(async () => {
      const transaction = IDBDatabase.prototype.transaction
      const order = []; let released = false, recording = true
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args)
        if (recording && args[1] === 'readwrite') {
          if (!released) {
            order.push('host-write')
            // Registered before the store's oncomplete handler resolves its Promise.
            tx.addEventListener('complete', () => {
              order.push('host-complete'); released = true; window.releasePeer()
            })
          } else {
            order.push('peer-write')
            tx.addEventListener('complete', () => { order.push('peer-complete') })
          }
        } else if (recording && released && args[1] === 'readonly') order.push('host-final-readonly')
        return tx
      }
      let outcome, peerGenerations
      try {
        ;[outcome, peerGenerations] = await Promise.all([
          window.captured(() => window.write(window.racingRequest)), window.peerCommit,
        ])
      } finally { recording = false; IDBDatabase.prototype.transaction = transaction; window.peerStore.close() }
      const current = await window.read()
      const poisoned = await window.captured(() => window.write(window.racingRequest))
      return { order, outcome, poisoned, peerGenerations, generation: current.generation,
        wrapper: [...current.state.checkpoint], expectedWrapper: [...window.peerState.checkpoint],
        manifest: [...current.state.pendingSends[0].ciphertext], expectedManifest: [...window.peerState.pendingSends[0].ciphertext] }
    })
    // These are mandatory setup/ordering checks, never counted as protocol refusals.
    const peerAt = result.order.indexOf('peer-write'), readAt = result.order.indexOf('host-final-readonly')
    assert.ok(peerAt >= 0 && readAt > peerAt, `peer must queue before final host READ: ${JSON.stringify(result.order)}`)
    assert.ok(result.order.includes('peer-complete')); assert.deepEqual(result.peerGenerations, [3])
    assert.equal(result.generation, 3); assert.deepEqual(result.wrapper, result.expectedWrapper)
    assert.deepEqual(result.manifest, result.expectedManifest)
    if (mode === 'actual-source') {
      assert.equal(result.outcome.ok, false); assert.deepEqual(result.poisoned, { ok: false, code: 'closed' })
    } else {
      // Actual bytes/other fences stay healthy: omitting only final G must yield the forbidden ACK.
      assert.equal(result.outcome.ok, true); assert.equal(result.outcome.value.length, 276)
      assert.throws(() => assert.equal(result.outcome.ok, false), assert.AssertionError)
    }
  })
}
