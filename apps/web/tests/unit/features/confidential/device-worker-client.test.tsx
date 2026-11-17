// Factory/lifetime tests: real AuthProvider, binder and MessageChannels; controlled Worker.
// No generated native module, Core HTTP, browser worker or durable-store proof is claimed.
import { setImmediate as realImmediate } from 'node:timers'
import { MessageChannel as NativeChannel, MessagePort as NativePort } from 'node:worker_threads'
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthSessionSnapshot } from '@/auth/AuthAdapter'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { useConfidentialDevice } from '@/features/confidential/device-worker-client'
import type { ConfidentialDeviceClient } from '@/features/confidential/device-worker-client'
import type { DeviceCommandFrame, DeviceStatus } from '@/features/confidential/device-worker-protocol'
import { parseDeviceCommand } from '@/features/confidential/device-worker-protocol'

import type * as ApiClient from '@/api/client'
type Binder = typeof ApiClient['bindConfidentialDeviceDispatch']
const trace = vi.hoisted(() => ({
  bindings: [] as { args: Parameters<Binder>; close: () => void }[],
  beforeClose: undefined as (() => void) | undefined,
}))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>()
  return {
    ...actual,
    bindConfidentialDeviceDispatch(...args: Parameters<Binder>) {
      const binding = actual.bindConfidentialDeviceDispatch(...args)
      const close = vi.fn(() => {
        trace.beforeClose?.()
        binding.close()
      })
      trace.bindings.push({ args, close })
      return Object.freeze({ close })
    },
  }
})

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new Error('UNIT_OBJECT')
  return value as Record<string, unknown>
}
class UnitWorker extends EventTarget implements Worker {
  static instances: UnitWorker[] = []
  static failBootstrap = false
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null
  readonly url: string
  readonly options: WorkerOptions | undefined
  bootstrap: Record<string, unknown> | undefined
  control: MessagePort | undefined
  transport: MessagePort | undefined
  nonce = ''
  commands: DeviceCommandFrame[] = []
  terminations = 0
  beforeTerminate: (() => void) | undefined
  constructor(url: string | URL, options?: WorkerOptions) {
    super()
    this.url = String(url)
    this.options = options
    UnitWorker.instances.push(this)
  }
  postMessage(message: unknown, transfer: Transferable[]): void
  postMessage(message: unknown, options?: StructuredSerializeOptions): void
  postMessage(message: unknown, supplied: Transferable[] | StructuredSerializeOptions = []): void {
    if (UnitWorker.failBootstrap) throw new Error('UNIT_PUBLIC_BOOTSTRAP_FAILURE')
    const transfer = Array.isArray(supplied) ? supplied : supplied.transfer ?? []
    const frame = object(structuredClone(message, { transfer }))
    if (typeof frame.nonce !== 'string' || !(frame.control instanceof MessagePort) ||
        !(frame.transport instanceof MessagePort)) throw new Error('UNIT_BOOTSTRAP')
    this.bootstrap = frame
    this.nonce = frame.nonce
    this.control = frame.control
    this.transport = frame.transport
    this.control.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.commands.push(parseDeviceCommand(event.data, this.nonce))
    })
    this.control.start()
    this.transport.start()
  }
  ready(extra: Record<string, unknown> = {}): void {
    this.control?.postMessage({ version: 1, nonce: this.nonce, kind: 'ready', ...extra })
  }
  result(result: DeviceStatus, extra: Record<string, unknown> = {}): void {
    const last = this.commands.at(-1)
    if (!last) throw new Error('UNIT_COMMAND')
    this.control?.postMessage({ version: 1, nonce: this.nonce, rpcId: last.rpcId, kind: 'result', result, ...extra })
  }
  refused(code: string): void {
    const last = this.commands.at(-1)
    if (!last) throw new Error('UNIT_COMMAND')
    this.control?.postMessage({ version: 1, nonce: this.nonce, rpcId: last.rpcId, kind: 'refused', code })
  }
  terminate(): void {
    this.terminations += 1
    this.beforeTerminate?.()
    this.shutdown()
  }
  shutdown(): void {
    this.control?.close()
    this.transport?.close()
  }
}

const status = (state: DeviceStatus['state'] = 'pre-admission'): DeviceStatus =>
  ({ version: 2, state, nativeGeneration: 1, hostGeneration: 1 })
function authFixture() {
  let snapshot: AuthSessionSnapshot = {
    status: 'ready', generation: 2, credentialGeneration: 3,
    user: { realm: 'spec-org', identity: { issuer: 'https://identity.factory.test/realms/spec-org', subject: 'public-unit-subject' } },
  }
  let token: string | undefined = 'public-synthetic-bearer'
  const listeners = new Set<() => void>()
  const adapter: AuthAdapter = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getAccessToken: () => token, getUser: () => snapshot.user,
    restoreSession: async () => true, renew: async () => false,
    signIn: async () => {}, handleCallback: async () => 'interactive', signOut: async () => {},
    getExpiresAt: () => undefined, onExpiring: () => () => {}, onRenewed: () => () => {}, onRenewalFailed: () => () => {},
  }
  return {
    adapter, listeners,
    get snapshot() { return snapshot },
    publish(next: AuthSessionSnapshot, nextToken = token) {
      snapshot = next; token = nextToken
      for (const listener of [...listeners]) listener()
    },
    dropCredentialSilently() { token = undefined },
  }
}
async function turns() {
  // Captured real function, unaffected by finite fake RPC fuses.
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => realImmediate(resolve))
}
async function sent(worker: UnitWorker, count: number) {
  for (let i = 0; i < 32; i += 1) {
    if (worker.commands.length === count) return
    await new Promise<void>((resolve) => realImmediate(resolve))
  }
  throw new Error('UNIT_COMMAND_NOT_SETTLED')
}
function lastWorker(): UnitWorker {
  const worker = UnitWorker.instances.at(-1)
  if (!worker) throw new Error('UNIT_WORKER')
  return worker
}
function binding() {
  const bound = trace.bindings.at(-1)
  if (!bound) throw new Error('UNIT_BINDING')
  return bound
}
function mount(strict = false) {
  const auth = authFixture()
  const result = renderHook(({ slug }) => ({ device: useConfidentialDevice(slug), auth: useAuth() }), {
    initialProps: { slug: 'spec-org' },
    wrapper: ({ children }: { children: ReactNode }) => strict
      ? <StrictMode><AuthProvider adapter={auth.adapter}>{children}</AuthProvider></StrictMode>
      : <AuthProvider adapter={auth.adapter}>{children}</AuthProvider>,
  })
  return { ...result, adapter: auth }
}
async function started(client: ConfidentialDeviceClient) {
  const pending = client.create(); const worker = lastWorker()
  worker.ready(); await sent(worker, 1)
  expect(worker.commands.map((x) => x.command)).toEqual(['create'])
  return { worker, pending }
}
async function created(client: ConfidentialDeviceClient) {
  const { worker, pending } = await started(client)
  worker.result(status()); await turns()
  expect(await pending).toEqual({ ok: true, status: status() })
  return worker
}
beforeEach(() => {
  UnitWorker.instances = []; UnitWorker.failBootstrap=false; trace.bindings = []; trace.beforeClose = undefined
  vi.stubGlobal('Worker', UnitWorker)
  vi.stubGlobal('MessageChannel', NativeChannel)
  vi.stubGlobal('MessagePort', NativePort)
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.factory.test/api/v1')
})
afterEach(() => {
  cleanup()
  for (const worker of UnitWorker.instances) worker.shutdown()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

describe('fixed confidential-device facade', () => {
  it('has no worker or transport until explicit initialization and exposes only closed methods', () => {
    const { result } = mount()
    expect(UnitWorker.instances).toHaveLength(0)
    expect(Object.keys(result.current.device).sort()).toEqual([
      'attempt', 'close', 'create', 'getSnapshot', 'preparePublication', 'prepareRegistration', 'restore',
    ])
    expect(Object.isFrozen(result.current.device)).toBe(true)
    expect(result.current.device.getSnapshot()).toEqual({ phase: 'idle', status: null, code: null })
  })
  it('uses a fixed module URL and two genuinely transferred independent channels, binding transport only', async () => {
    const { result } = mount(); const pending = result.current.device.create(); const worker = lastWorker()
    expect(new URL(worker.url, window.location.href).pathname).toMatch(/\/features\/confidential\/device\.worker\.ts$/)
    expect(worker.options).toEqual({ type: 'module', name: 'confidential-device' })
    expect(Object.keys(worker.bootstrap ?? {}).sort()).toEqual(['control','kind','nonce','transport','version'])
    expect(worker.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(worker.control).not.toBe(worker.transport)
    expect(binding().args[2]).toBe(worker)
    expect(binding().args[3]).not.toBe(worker.transport) // actual opposite end, not a facade-supplied port
    expect(binding().args[3]).not.toBe(worker.control)
    expect(worker.commands).toEqual([])
    let transportFrames=0
    binding().args[3].addEventListener('message',()=>{transportFrames+=1})
    worker.ready(); await sent(worker, 1); expect(transportFrames).toBe(0)
    worker.transport?.postMessage({version:1,nonce:worker.nonce,rpcId:1,kind:'retire-rpc'})
    await turns(); expect(transportFrames).toBe(1)
    worker.result(status()); await turns()
    expect(await pending).toEqual({ ok:true,status:status() })
    expect(Object.isFrozen(result.current.device.getSnapshot())).toBe(true)
    expect(result.current.device.getSnapshot()).toEqual({ phase:'ready',status:status(),code:null })
  })
  it('refuses a second public RPC instead of queueing or constructing another worker', async () => {
    const { result } = mount(); const { worker, pending } = await started(result.current.device)
    expect(await result.current.device.restore()).toEqual({ ok:false,code:'busy' })
    expect(UnitWorker.instances).toHaveLength(1); expect(worker.commands).toHaveLength(1)
    worker.result(status()); await turns(); await pending
  })
  it.each([
    ['prepareRegistration','prepare-registration'], ['preparePublication','prepare-publication'], ['attempt','attempt'],
  ] as const)('maps %s to the closed command without caller payload', async (method, command) => {
    const { result } = mount(); const worker = await created(result.current.device)
    const pending = result.current.device[method](); await sent(worker, 2)
    expect(worker.commands.at(-1)).toEqual({ version:1,nonce:worker.nonce,rpcId:2,kind:'command',command })
    worker.result(status('outcome-unknown')); await turns()
    expect(await pending).toEqual({ ok:true,status:status('outcome-unknown') })
    expect(worker.terminations).toBe(0)
  })
  it('keeps an outcome-unknown success live for a later deliberate attempt', async () => {
    const { result } = mount(); const worker = await created(result.current.device)
    const first = result.current.device.attempt(); await sent(worker, 2); worker.result(status('outcome-unknown')); await turns(); await first
    expect(worker.terminations).toBe(0)
    const later = result.current.device.attempt(); await sent(worker, 3)
    expect(worker.commands.at(-1)?.rpcId).toBe(3)
    worker.result(status('admitted')); await turns(); expect(await later).toEqual({ ok:true,status:status('admitted') })
    expect(UnitWorker.instances).toHaveLength(1)
  })
  it.each(['storage','restore-required','ineligible','closed','network','invalid-input','invalid-response','busy'] as const)('retires correlated %s and requires a new explicit restore controller', async (code) => {
    const { result } = mount(); const client=result.current.device; const worker=await created(client)
    const pending=client.attempt(); await sent(worker, 2); worker.refused(code); await turns()
    expect(await pending).toEqual({ ok:false,code }); expect(worker.terminations).toBe(1)
    expect(await client.create()).toEqual({ ok:false,code:'restore-required' })
    const restored=client.restore(); const next=lastWorker(); expect(next).not.toBe(worker)
    expect(next.nonce).not.toBe(worker.nonce); expect(trace.bindings).toHaveLength(2)
    next.ready(); await sent(next, 1); expect(next.commands.at(-1)?.command).toBe('restore')
    next.result(status('admitted')); await turns(); expect(await restored).toEqual({ ok:true,status:status('admitted') })
  })
  it('retires every failed consumed initializer, including a nonterminal network code', async () => {
    const { result }=mount(); const client=result.current.device; const { worker,pending }=await started(client)
    worker.refused('network'); await turns(); expect(await pending).toEqual({ ok:false,code:'network' })
    expect(worker.terminations).toBe(1); expect(await client.create()).toEqual({ ok:false,code:'restore-required' })
    const restore=client.restore(); const next=lastWorker(); next.ready(); await sent(next, 1); next.result(status()); await turns(); await restore
    expect(trace.bindings).toHaveLength(2)
  })
  it('permits a new explicit create after a known pre-command bootstrap failure with a fresh binder', async () => {
    const {result}=mount(); const client=result.current.device; UnitWorker.failBootstrap=true
    expect(await client.create()).toEqual({ok:false,code:'closed'})
    const old=lastWorker(); expect(old.terminations).toBe(1); expect(old.commands).toEqual([])
    UnitWorker.failBootstrap=false; const worker=await created(client)
    expect(worker).not.toBe(old); expect(trace.bindings).toHaveLength(2)
  })
  it('invalidates the immutable RPC lease before binder cleanup or actual termination', async () => {
    const { result }=mount(); const client=result.current.device; const { worker,pending }=await started(client)
    const capture=binding().args[5]; const lease=capture(1); expect(lease?.isCurrent()).toBe(true)
    const observed:boolean[][]=[]
    const check=()=>{ observed.push([capture(1)===undefined,lease?.isCurrent()===false]) }
    trace.beforeClose=check; worker.beforeTerminate=check
    client.close(); expect(worker.terminations).toBe(1); expect(await pending).toEqual({ ok:false,code:'closed' })
    expect(observed).toEqual([[true,true],[true,true]])
    expect(await client.restore()).toEqual({ ok:false,code:'closed' }); expect(UnitWorker.instances).toHaveLength(1)
  })
  it.each(['credential','generation','issuer','subject','pending'] as const)('synchronously retires %s changes through the real provider', async (field) => {
    const view=mount(); const old=view.result.current.device; const { worker,pending }=await started(old)
    const prior=view.adapter.snapshot; let next:AuthSessionSnapshot={...prior,user:prior.user ? {...prior.user,identity:prior.user.identity ? {...prior.user.identity}:undefined}:undefined}
    if(field==='credential') next={...next,credentialGeneration:next.credentialGeneration+1}
    if(field==='generation') next={...next,generation:next.generation+1}
    if(field==='pending') next={...next,status:'pending'}
    if(field==='issuer' && next.user?.identity) next={...next,user:{...next.user,identity:{...next.user.identity,issuer:'https://new-identity.factory.test'}}}
    if(field==='subject' && next.user?.identity) next={...next,user:{...next.user,identity:{...next.user.identity,subject:'different-public-subject'}}}
    act(()=>view.adapter.publish(next,'changed-public-bearer'))
    expect(worker.terminations).toBe(1); expect(await pending).toEqual({ ok:false,code:'ineligible' })
    expect(old.getSnapshot().phase).toBe('closed'); expect(await old.restore()).toEqual({ok:false,code:'closed'})
    expect(UnitWorker.instances).toHaveLength(1)
  })
  it('observes lost usable credential even without a React notification', async () => {
    const { result,adapter }=mount(); const client=result.current.device; const {worker,pending}=await started(client)
    adapter.dropCredentialSilently(); expect(client.getSnapshot().phase).toBe('closed')
    expect(worker.terminations).toBe(1); expect(await pending).toEqual({ok:false,code:'ineligible'})
  })
  it('rechecks retirement after a real adapter callback closes the facade while returning a usable credential', async () => {
    const {result,adapter}=mount(); const client=result.current.device; const {worker,pending}=await started(client)
    adapter.adapter.getAccessToken=()=>{client.close();return 'public-synthetic-bearer'}
    expect(client.getSnapshot().phase).toBe('closed')
    expect(worker.terminations).toBe(1); expect(await pending).toEqual({ok:false,code:'closed'})
  })
  it('retires the stamp before a real signOut adapter promise settles', async () => {
    const view=mount(); let finish:()=>void=()=>{}; view.adapter.adapter.signOut=()=>new Promise<void>((resolve)=>{finish=resolve})
    const {worker,pending}=await started(view.result.current.device)
    const ended=view.result.current.auth.signOut(); expect(worker.terminations).toBe(1)
    expect(await pending).toEqual({ok:false,code:'ineligible'}); finish(); await ended
  })
  it('never retargets retained facades after an organisation switch', async () => {
    const view=mount(); const old=view.result.current.device; const {worker,pending}=await started(old)
    view.rerender({slug:'other-org'}); expect(worker.terminations).toBe(1); await pending
    expect(view.result.current.device).not.toBe(old); expect(old.getSnapshot().phase).toBe('closed')
    expect(await old.create()).toEqual({ok:false,code:'closed'}); expect(UnitWorker.instances).toHaveLength(1)
    const fresh=view.result.current.device.restore(); const next=lastWorker(); expect(binding().args[1]).toBe('other-org')
    next.ready(); await sent(next, 1); next.result(status()); await turns(); await fresh
  })
  it('handles StrictMode setup/cleanup without eager worker or consumed binder reuse', async () => {
    const view=mount(true); expect(UnitWorker.instances).toHaveLength(0)
    const client=view.result.current.device; const worker=await created(client); expect(trace.bindings).toHaveLength(1)
    view.unmount(); expect(worker.terminations).toBe(1); expect(client.getSnapshot().phase).toBe('closed')
    expect(await client.restore()).toEqual({ok:false,code:'closed'})
  })
  it.each(['wrong-nonce','wrong-rpc','extra','cross-port'] as const)('quarantines a %s reply without publishing it', async (fault) => {
    const { result }=mount(); const {worker,pending}=await started(result.current.device)
    const frame={version:1,nonce:worker.nonce,rpcId:1,kind:'result',result:status(),...(fault==='extra'?{seed:'PUBLIC-NOT-SECRET-ORACLE'}:{})}
    if(fault==='wrong-nonce') frame.nonce='f'.repeat(32)
    if(fault==='wrong-rpc') frame.rpcId=2
    if(fault==='cross-port') worker.transport?.postMessage(frame); else worker.control?.postMessage(frame)
    await turns(); expect(await pending).toEqual({ok:false,code:'invalid-response'}); expect(worker.terminations).toBe(1)
    expect(result.current.device.getSnapshot().status).toBeNull()
  })
  it.each(['error','messageerror'] as const)('retires a worker %s without surfacing raw diagnostics', async (kind) => {
    const {result}=mount(); const {worker,pending}=await started(result.current.device)
    worker.dispatchEvent(kind==='error'?new ErrorEvent('error',{message:'PUBLIC_RAW_DIAGNOSTIC'}):new Event('messageerror'))
    expect(await pending).toEqual({ok:false,code:'restore-required'}); expect(worker.terminations).toBe(1)
    expect(JSON.stringify(result.current.device.getSnapshot())).not.toContain('PUBLIC_RAW_DIAGNOSTIC')
  })
  it('refuses repeated ready instead of silently reinitializing a healthy worker', async () => {
    const {result}=mount(); const worker=await created(result.current.device)
    worker.ready(); await turns(); expect(worker.terminations).toBe(1)
    expect(result.current.device.getSnapshot().phase).toBe('restore-required')
  })
  it('accepts delayed retire-rpc cleanup after the control result, without granting a new lease', async () => {
    const {result}=mount(); const client=result.current.device; const worker=await created(client)
    expect(binding().args[5](1)).toBeUndefined()
    worker.transport?.postMessage({version:1,nonce:worker.nonce,rpcId:1,kind:'retire-rpc'}); await turns()
    expect(worker.terminations).toBe(0)
    const pending=client.prepareRegistration(); await sent(worker, 2); worker.result(status('registration-prepared')); await turns(); await pending
  })
  it('stops transport frame overflow before the real binder may act', async () => {
    const {result}=mount(); const {worker,pending}=await started(result.current.device)
    for(let i=0;i<65;i+=1) worker.transport?.postMessage({version:1,nonce:worker.nonce,rpcId:1,kind:'retire-rpc'})
    await turns(); expect(await pending).toEqual({ok:false,code:'invalid-response'}); expect(worker.terminations).toBe(1)
  })
  it('retires startup after30s without a command or automatic retry', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); const {result}=mount(); const pending=result.current.device.create(); const worker=lastWorker()
    await vi.advanceTimersByTimeAsync(30000); expect(await pending).toEqual({ok:false,code:'closed'})
    expect(worker.commands).toEqual([]); expect(worker.terminations).toBe(1); expect(UnitWorker.instances).toHaveLength(1)
  })
  it.each([['create',60000],['prepare',30000]] as const)('retires the %s overall fuse and preserves restore-required', async (kind,delay) => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); const {result}=mount(); const client=result.current.device
    let pending:ReturnType<ConfidentialDeviceClient['create']>; let worker:UnitWorker
    if(kind==='create') ({pending,worker}=await started(client))
    else {worker=await created(client); pending=client.prepareRegistration(); await sent(worker, 2)}
    await vi.advanceTimersByTimeAsync(delay); expect(await pending).toEqual({ok:false,code:'restore-required'})
    expect(worker.terminations).toBe(1); expect(await client.create()).toEqual({ok:false,code:'restore-required'})
  })
})
