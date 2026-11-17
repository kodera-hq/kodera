// Compiled production worker and real IndexedDB; this oracle never contacts Core.
import { openConfidentialState } from '../../src/features/confidential/local-state.ts'

const principal = Object.freeze({
  ownerId: '01970000-0000-7000-8000-0000000000aa',
  identityId: '01970000-0000-7000-8000-000000000002',
  organisationId: '01970000-0000-7000-8000-000000000003',
  membershipId: '01970000-0000-7000-8000-000000000004',
  issuer: 'https://auth.example.test/realms/spec-org', subject: 'fixture-principal',
  organisationSlug: 'spec-org',
})
const selected = new URL(location.href).searchParams.get('case')
const checks = Object.create(null)
const active = new Set()
const need = (value, name) => { if (!value) throw new Error(name); checks[name] = true }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const hash = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
async function saved() {
  const store = await openConfidentialState(principal.ownerId)
  try { return await store.readUniqueDeviceVault(principal) } finally { store.close() }
}
async function fingerprint(value) {
  if (!value) return null
  return {
    key: value.scope.devicePublicKey, generation: value.generation,
    checkpoint: await hash(value.state.checkpoint), header: await hash(value.state.checkpoint.subarray(0, 52)),
    pending: await Promise.all(value.state.pendingSends.map(async (item) => [item.id, await hash(item.ciphertext)])),
  }
}
async function start(fault, stale = false) {
  const worker = fault
    ? new Worker(new URL('./fault.worker.mjs', import.meta.url), { type: 'module', name: 'device-proof-fault' })
    : new Worker(new URL('../../src/features/confidential/device.worker.ts', import.meta.url), { type: 'module', name: 'device-proof' })
  active.add(worker)
  const control = new MessageChannel(), transport = new MessageChannel()
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  let nextId = 0, requests = 0, sends = 0, pending, initMode
  let readyResolve, fixtureResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const fixture = new Promise((resolve) => { fixtureResolve = resolve })
  worker.addEventListener('message', (event) => {
    if (event.data?.fixture === 1) fixtureResolve(event.data.kind)
  })
  control.port2.onmessage = ({ data }) => {
    if (data.nonce !== nonce) throw new Error('CONTROL_NONCE')
    if (data.kind === 'ready') { readyResolve(); return }
    if (!pending || pending.id !== data.rpcId) throw new Error('CONTROL_CORRELATION')
    const value = pending; pending = undefined; value.resolve(data)
  }
  transport.port2.onmessage = async ({ data }) => {
    if (data.nonce !== nonce) throw new Error('TRANSPORT_NONCE')
    const base = { version: 1, nonce, rpcId: data.rpcId }
    if (data.kind === 'retire-rpc') return
    if (data.kind === 'initialize-prepare') {
      requests++; initMode = data.mode
      transport.port2.postMessage({ ...base, kind: 'initialization-prepared',
        cellId: '01970000-0000-7000-8000-000000000021', principal, mode: data.mode })
    } else if (data.kind === 'initialize-consume') {
      if (stale) await delay(5100)
      transport.port2.postMessage({ ...base, kind: 'initialization-consumed',
        cellId: data.cellId, mode: initMode, remainingMs: 5000 })
    } else { sends++; throw new Error('NO_CORE_HTTP_AUTHORITY') }
  }
  // Fault selection is a test-entry message, never a production worker option.
  worker.postMessage({ version: 1, kind: 'bootstrap', nonce,
    control: control.port1, transport: transport.port1, ...(fault ? { fixtureFault: fault } : {}) }, [control.port1, transport.port1])
  await ready
  function stop() {
    worker.terminate(); active.delete(worker); control.port2.close(); transport.port2.close()
  }
  return { stop, fixture, requests: () => requests, sends: () => sends,
    command(command) {
      if (pending) throw new Error('ONE_RPC')
      return new Promise((resolve) => {
        pending = { id: ++nextId, resolve }
        control.port2.postMessage({ version: 1, nonce, rpcId: nextId, kind: 'command', command })
      })
    },
  }
}
async function run() {
  if (selected === 'startup-before-principal') {
    const h = await start(); await delay(30)
    need(h.requests() === 0, 'noPrincipalBeforeCommand')
    const result = await h.command('create')
    need(result.kind === 'result', 'nativeCreateCompleted')
    need(h.requests() === 1 && h.sends() === 0, 'explicitOnlyNoHttp'); h.stop()
  } else if (selected === 'stale-consumed-start') {
    const h = await start(undefined, true), result = await h.command('create')
    need(result.kind === 'refused' && result.code === 'ineligible', 'staleStartRefused')
    need(await saved() === null, 'noSignerRecord'); need(h.sends() === 0, 'noHttp'); h.stop()
  } else if (selected === 'aborted-record-write') {
    const h = await start('abort-record-write'), result = await h.command('create')
    need(await h.fixture === 'record-aborted', 'realTransactionAborted')
    need(result.kind === 'refused' && result.code === 'storage', 'noAcknowledgement')
    need(await saved() === null, 'noDurableRecord'); h.stop()
  } else if (selected === 'committed-held-completion') {
    const h = await start('hold-record-completion'); let settled = false
    void h.command('create').then(() => { settled = true })
    need(await h.fixture === 'record-committed-completion-held', 'realTransactionCommitted')
    const before = await fingerprint(await saved())
    need(before !== null && !settled, 'durableBeforeAcknowledgement'); h.stop()
    const replacement = await start(), restored = await replacement.command('restore')
    need(restored.kind === 'result', 'explicitRestoreCompleted')
    need(JSON.stringify(await fingerprint(await saved())) === JSON.stringify(before), 'exactPersistedTuple'); replacement.stop()
  } else {
    need(['create-terminate-restore', 'prepared-terminate-restore'].includes(selected), 'knownCase')
    const h = await start(), created = await h.command('create')
    need(created.kind === 'result' && created.result.nativeGeneration === 1 && created.result.hostGeneration === 1, 'nativeOneHostOne')
    if (selected === 'prepared-terminate-restore') {
      const prepared = await h.command('prepare-registration')
      need(prepared.kind === 'result' && prepared.result.nativeGeneration === 1 && prepared.result.hostGeneration === 2, 'independentNativeHostGenerations')
    }
    const before = await fingerprint(await saved()); need(before !== null, 'realDurableRecord'); h.stop()
    const replacement = await start(), restored = await replacement.command('restore')
    need(restored.kind === 'result', 'explicitRestoreCompleted')
    need(JSON.stringify(await fingerprint(await saved())) === JSON.stringify(before), 'exactPersistedTuple')
    need(replacement.sends() === 0, 'noHttp'); replacement.stop()
  }
  const output = document.querySelector('output')
  output.textContent = JSON.stringify({ version: 1, case: selected,
    scope: 'compiled-worker-real-idb-controlled-main-oracle', checks })
  output.dataset.phase = 'complete'
}
run().catch(() => {
  for (const worker of active) worker.terminate()
  document.querySelector('output').dataset.phase = 'failed'
})
