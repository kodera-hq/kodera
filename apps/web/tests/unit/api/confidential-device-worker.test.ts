// @vitest-environment node
// Actual worker orchestration with controlled native/store oracles, not real IDB/Core.
import { MessageChannel, MessagePort } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/confidential-device-http.responses.json'

const nonce = '0123456789abcdef0123456789abcdef'
let clock: number
let initialized: () => void
let scope: EventTarget & { close: ReturnType<typeof vi.fn> }
let nativeCreate: ReturnType<typeof vi.fn<(host: ControlledHost, ...args: unknown[]) => unknown>>
let controls: unknown[]
let transports: Record<string, unknown>[]
let channels: MessageChannel[]
let vault: { scope: Record<string, string>; generation: number; state: { checkpoint: Uint8Array; pendingSends: [] } } | null
interface ControlledHost {
  checkCurrent(value: string): boolean
  compareAndSwapDevice(value: string, sealed: Uint8Array): Promise<unknown>
}
class UnitStore {
  async readUniqueDeviceVault() { return vault === null ? null : structuredClone(vault) }
  compareAndSwap() { throw new Error('UNIT_UNEXPECTED_V2') }
  async createUniqueDeviceVault(scope: Record<string, string>, state: { checkpoint: Uint8Array; pendingSends: [] }) {
    if (vault) throw new Error('UNIT_CONFLICT')
    vault = { scope: { ...scope }, generation: 1, state: structuredClone(state) }; return 1
  }
  close() { /* Controlled connection only; no real database is opened. */ }
}

beforeEach(async () => {
  clock = 100; controls = []; transports = []; channels = []; vault = null
  scope = Object.assign(new EventTarget(), { close: vi.fn() })
  nativeCreate = vi.fn()
  vi.stubGlobal('self', scope); vi.stubGlobal('MessagePort', MessagePort)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const startup = new Promise<void>((resolve) => { initialized = resolve })
  vi.doMock('@/features/confidential/native/kodera_rs.js', () => ({
    default: () => startup,
    BrowserMlsHttpDevice: class {
      constructor(private readonly host: ControlledHost) {}
      createHttpDevice = (identity: unknown, seed: unknown, consent: unknown) => nativeCreate(this.host, identity, seed, consent)
      close = vi.fn()
      free = vi.fn()
    },
  }))
  vi.doMock('@/features/confidential/local-state', () => ({
    ConfidentialStateStore: UnitStore,
    ConfidentialStateError: class extends Error {},
    LOCAL_STATE_LIMITS: { checkpointBytes: 17 * 1024 * 1024 },
    initializeConfidentialState: async () => new UnitStore(),
    openConfidentialState: async () => new UnitStore(),
  }))
  vi.resetModules()
  await import('@/features/confidential/device.worker')
})
afterEach(() => {
  scope.dispatchEvent(new MessageEvent('messageerror'))
  for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  vault?.state.checkpoint.fill(0); vault = null
  vi.doUnmock('@/features/confidential/native/kodera_rs.js')
  vi.doUnmock('@/features/confidential/local-state')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function bootstrap(extra: Record<string, unknown> = {}) {
  const control = new MessageChannel(), transport = new MessageChannel()
  channels.push(control, transport)
  control.port2.on('message', (value: unknown) => controls.push(value))
  transport.port2.on('message', (value: Record<string, unknown>) => transports.push(value))
  const event = new MessageEvent('message', {
    data: { version: 1, kind: 'bootstrap', nonce, control: control.port1,
      transport: transport.port1, ...extra },
  })
  Object.defineProperty(event, 'ports', { value: [control.port1, transport.port1] })
  scope.dispatchEvent(event)
  return { control, transport, command: (rpcId = 1, selectedNonce = nonce) =>
    control.port2.postMessage({ version: 1, nonce: selectedNonce, rpcId,
      kind: 'command', command: 'create' }) }
}
async function ready() {
  const h = bootstrap(); initialized()
  await vi.waitFor(() => expect(controls).toEqual([{ version: 1, nonce, kind: 'ready' }]))
  return h
}
function initializer(h: ReturnType<typeof bootstrap>) {
  const cellId = '01970000-0000-7000-8000-000000000099'
  h.transport.port2.on('message', (frame: Record<string, unknown>) => {
    if (frame.kind === 'initialize-prepare') h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1,
      kind: 'initialization-prepared', cellId, principal: fixtures.acceptedContext, mode: 'create' })
    if (frame.kind === 'initialize-consume') h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1,
      kind: 'initialization-consumed', cellId, mode: 'create', remainingMs: 5000 })
  })
}
function nativeContext(key: string | null, n: number, actorOperation = 1) {
  const c = fixtures.acceptedContext
  return JSON.stringify({ version: 2, profile: 'http', actorOperation, ownerId: c.ownerId,
    organisationId: c.organisationId, membershipId: c.membershipId, devicePublicKey: key,
    nativeGeneration: n, hostGeneration: n, recordId: null, recordSha256: null, admittedDeviceId: null })
}

describe('fixed worker controlled orchestration', () => {
  it('initializes native before ready and sends no principal request at startup', async () => {
    bootstrap()
    expect(controls).toEqual([]); expect(transports).toEqual([])
    initialized()
    await vi.waitFor(() => expect(controls).toHaveLength(1))
    expect(transports).toEqual([]); expect(nativeCreate).not.toHaveBeenCalled()
  })
  it('refuses global bootstrap scope instead of using it as authority', () => {
    bootstrap({ ownerId: fixtures.acceptedContext.ownerId })
    expect(scope.close).toHaveBeenCalledOnce()
    expect(nativeCreate).not.toHaveBeenCalled(); expect(transports).toEqual([])
  })
  it('retires the global bootstrap listener and never installs a second channel', async () => {
    const h = await ready(); bootstrap()
    expect(controls).toHaveLength(1)
    h.command(1, 'f'.repeat(32))
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce())
    expect(transports).toEqual([]); expect(nativeCreate).not.toHaveBeenCalled()
  })
  it('refuses control-shaped data on the separate transport port', async () => {
    const h = await ready()
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'command', command: 'create' })
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce())
    expect(nativeCreate).not.toHaveBeenCalled()
  })
  it.each([false, true])('preserves the exact dispatcher refusal code with scoped cell=%s', async (scoped) => {
    const h = await ready(); h.command()
    await vi.waitFor(() => expect(transports.at(-1)?.kind).toBe('initialize-prepare'))
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'refused', code: 'network',
      ...(scoped ? { cellId: '01970000-0000-7000-8000-000000000099' } : {}) })
    await vi.waitFor(() => expect(controls).toContainEqual({ version: 1, nonce, rpcId: 1, kind: 'refused', code: 'network' }))
    expect(scope.close).toHaveBeenCalledOnce(); expect(nativeCreate).not.toHaveBeenCalled()
  })
  it('rejects a refusal for another known cell rather than trusting its code', async () => {
    const h = await ready(); h.command()
    await vi.waitFor(() => expect(transports.at(-1)?.kind).toBe('initialize-prepare'))
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'initialization-prepared',
      cellId: '01970000-0000-7000-8000-000000000099', principal: fixtures.acceptedContext, mode: 'create' })
    await vi.waitFor(() => expect(transports.at(-1)?.kind).toBe('initialize-consume'))
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'refused', code: 'network',
      cellId: '01970000-0000-7000-8000-000000000098' })
    await vi.waitFor(() => expect(controls).toContainEqual({ version: 1, nonce, rpcId: 1, kind: 'refused', code: 'invalid-input' }))
    expect(nativeCreate).not.toHaveBeenCalled()
  })
  it('consumes a fresh initializer but rejects stale native start without recreating', async () => {
    const h = await ready(); h.command()
    await vi.waitFor(() => expect(transports.at(-1)?.kind).toBe('initialize-prepare'))
    const cellId = '01970000-0000-7000-8000-000000000099'
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'initialization-prepared',
      cellId, principal: fixtures.acceptedContext, mode: 'create' })
    await vi.waitFor(() => expect(transports.at(-1)?.kind).toBe('initialize-consume'))
    clock += 6000
    h.transport.port2.postMessage({ version: 1, nonce, rpcId: 1, kind: 'initialization-consumed',
      cellId, mode: 'create', remainingMs: 5000 })
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce())
    expect(nativeCreate).not.toHaveBeenCalled()
    expect(controls).toContainEqual({ version: 1, nonce, rpcId: 1, kind: 'refused', code: 'ineligible' })
    h.command(2)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(transports.filter((frame) => frame.kind === 'initialize-prepare')).toHaveLength(1)
  })
  it('binds the immutable native operation and permits a valid late CAS after invocation start', async () => {
    const h = await ready(); initializer(h)
    let release!: () => void, invoked = false
    const held = new Promise<void>((resolve) => { release = resolve })
    const key = '1'.repeat(64)
    nativeCreate.mockImplementation(async (host: ControlledHost) => {
      expect(host.checkCurrent(nativeContext(null, 0))).toBe(true)
      expect(host.checkCurrent(nativeContext(null, 0, 2))).toBe(false)
      invoked = true; await held
      const sealed = new Uint8Array(36); sealed.set(new TextEncoder().encode('KDV1'))
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sealed)), (v) => v.toString(16).padStart(2, '0')).join('')
      const c = fixtures.acceptedContext
      const ack: unknown = await host.compareAndSwapDevice(JSON.stringify({ version: 1, ownerId: c.ownerId,
        organisationId: c.organisationId, membershipId: c.membershipId, devicePublicKey: key,
        expectedGeneration: 0, generation: 1, checkpointSha256: digest }), sealed)
      expect(ack instanceof Uint8Array && ack.byteLength === 192).toBe(true)
      expect(host.checkCurrent(nativeContext(key, 1))).toBe(true)
      return JSON.stringify({ version: 2, state: 'pre-admission', nativeGeneration: 1, hostGeneration: 1 })
    })
    h.command(); await vi.waitFor(() => expect(invoked).toBe(true))
    clock += 7000; release()
    await vi.waitFor(() => expect(controls).toContainEqual({ version: 1, nonce, rpcId: 1, kind: 'result',
      result: { version: 2, state: 'pre-admission', nativeGeneration: 1, hostGeneration: 1 } }))
    expect(scope.close).not.toHaveBeenCalled()
    expect(transports.filter((frame) => frame.kind === 'retire-rpc')).toHaveLength(1)
  })
})
