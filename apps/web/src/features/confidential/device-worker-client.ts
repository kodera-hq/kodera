import { useLayoutEffect, useMemo } from 'react'
import { useAuth, useAuthLifetime } from '@/auth/AuthProvider'
import type { AuthLifetime } from '@/auth/AuthProvider'
import { bindConfidentialDeviceDispatch } from '@/api/client'
import { parseDeviceControlReply } from './device-worker-protocol'
import type { DeviceCommand, DeviceStatus, DeviceWorkerCode } from './device-worker-protocol'

export type ConfidentialDeviceResult =
  | Readonly<{ ok: true; status: DeviceStatus }>
  | Readonly<{ ok: false; code: DeviceWorkerCode }>
export interface ConfidentialDeviceSnapshot {
  readonly phase: 'idle' | 'starting' | 'busy' | 'ready' | 'restore-required' | 'closed'
  readonly status: DeviceStatus | null
  readonly code: DeviceWorkerCode | null
}
export interface ConfidentialDeviceClient {
  create(): Promise<ConfidentialDeviceResult>
  restore(): Promise<ConfidentialDeviceResult>
  prepareRegistration(): Promise<ConfidentialDeviceResult>
  preparePublication(): Promise<ConfidentialDeviceResult>
  attempt(): Promise<ConfidentialDeviceResult>
  getSnapshot(): ConfidentialDeviceSnapshot
  close(): void
}

interface AuthCapture {
  readonly status: string
  readonly generation: number
  readonly credentialGeneration: number
  readonly realm: string | undefined
  readonly issuer: string | undefined
  readonly subject: string | undefined
}
interface Root {
  readonly stamp: object
  active: boolean
  controller: Controller | undefined
  unsubscribe: (() => void) | undefined
}
interface RpcIdentity {
  readonly id: number
  readonly command: DeviceCommand
  readonly controller: Controller
  readonly worker: Worker
  readonly transport: MessagePort
  readonly root: Root
  readonly nonce: string
  readonly organisationSlug: string
}
interface Pending {
  readonly identity: RpcIdentity
  readonly started: number
  readonly duration: number
  readonly resolve: (result: ConfidentialDeviceResult) => void
  sent: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}
interface Controller {
  readonly root: Root
  readonly worker: Worker
  readonly control: MessagePort
  readonly transport: MessagePort
  readonly workerControl: MessagePort
  readonly workerTransport: MessagePort
  readonly ports: readonly MessagePort[]
  readonly nonce: string
  readonly controlListener: (event: MessageEvent<unknown>) => void
  readonly transportListener: (event: MessageEvent<unknown>) => void
  readonly failed: (event: Event) => void
  binding: Readonly<{ close(): void }> | undefined
  pending: Pending | undefined
  startupTimer: ReturnType<typeof setTimeout> | undefined
  ready: boolean
  bootstrapped: boolean
  closed: boolean
  nextId: number
  frames: number
  lastClock: number
  status: DeviceStatus | null
}
const now = performance.now.bind(performance)
const random = crypto.getRandomValues.bind(crypto)
const refused = (code: DeviceWorkerCode): ConfidentialDeviceResult => Object.freeze({ ok: false, code })
const contain = (action: () => void) => {
  try { action() } catch { /* Retirement remains synchronous even if one cleanup step fails. */ }
}

// Not exported: only this hook constructs the actual Worker/ports/dispatcher binding.
function fixedClient(lifetime: AuthLifetime, slug: string, auth: AuthCapture) {
  let root: Root | undefined
  let permanent = false
  let restoreRequired = false
  let snapshot: ConfidentialDeviceSnapshot = Object.freeze({ phase: 'closed', status: null, code: 'closed' })
  const show = (phase: ConfidentialDeviceSnapshot['phase'], status: DeviceStatus | null, code: DeviceWorkerCode | null) => {
    snapshot = Object.freeze({ phase, status, code })
  }
  function authMatches(scope: Root): boolean {
    if (permanent || !scope.active || root !== scope) return false
    try {
      const current = lifetime.getSnapshot()
      const usable = lifetime.hasUsableCredential()
      const stamp = lifetime.getRetirementStamp()
      const user = current.user, identity = user?.identity
      const matches = usable && stamp === scope.stamp &&
        current.status === 'ready' && current.status === auth.status &&
        Number.isSafeInteger(current.generation) && current.generation >= 0 &&
        Number.isSafeInteger(current.credentialGeneration) && current.credentialGeneration >= 0 &&
        current.generation === auth.generation && current.credentialGeneration === auth.credentialGeneration &&
        typeof auth.realm === 'string' && auth.realm.length > 0 &&
        typeof auth.issuer === 'string' && auth.issuer.length > 0 &&
        typeof auth.subject === 'string' && auth.subject.length > 0 &&
        user?.realm === auth.realm && identity?.issuer === auth.issuer && identity?.subject === auth.subject
      return matches && !permanent && scope.active && root === scope
    } catch { return false }
  }
  function currentRoot(scope: Root): boolean {
    if (authMatches(scope)) return true
    if (scope.active && root === scope) {
      permanent = true
      retireRoot(scope, 'ineligible')
    }
    return false
  }
  function uncertain(controller: Controller): boolean {
    return controller.status !== null || controller.pending?.sent === true
  }
  function retireController(controller: Controller, code: DeviceWorkerCode, ambiguous = uncertain(controller)): void {
    if (controller.closed) return
    const pending = controller.pending
    const binding = controller.binding
    controller.closed = true
    controller.pending = undefined
    controller.binding = undefined
    if (controller.root.controller === controller) controller.root.controller = undefined
    restoreRequired ||= ambiguous
    if (root === controller.root && controller.root.active) {
      show(restoreRequired ? 'restore-required' : 'idle', null, code)
    }
    // Root/operation references are invalid BEFORE any callback, binding cleanup or termination.
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    if (controller.startupTimer !== undefined) clearTimeout(controller.startupTimer)
    contain(() => binding?.close())
    contain(() => controller.worker.terminate())
    contain(() => controller.control.removeEventListener('message', controller.controlListener))
    contain(() => controller.transport.removeEventListener('message', controller.transportListener))
    contain(() => controller.worker.removeEventListener('error', controller.failed))
    contain(() => controller.worker.removeEventListener('messageerror', controller.failed))
    contain(() => controller.control.removeEventListener('messageerror', controller.failed))
    contain(() => controller.transport.removeEventListener('messageerror', controller.failed))
    for (const port of controller.ports) contain(() => port.close())
    pending?.resolve(refused(code))
  }
  function retireRoot(scope: Root, code: DeviceWorkerCode): void {
    if (!scope.active) return
    const controller = scope.controller
    const unsubscribe = scope.unsubscribe
    scope.active = false
    scope.controller = undefined
    scope.unsubscribe = undefined
    if (root === scope) root = undefined
    show('closed', null, code)
    if (controller) retireController(controller, code)
    contain(() => unsubscribe?.())
  }
  function clock(controller: Controller): number {
    const value = now()
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < controller.lastClock) {
      throw new Error('DEVICE_CLOCK')
    }
    controller.lastClock = value
    return value
  }
  function current(controller: Controller, pending?: Pending): boolean {
    if (controller.closed || !currentRoot(controller.root) || controller.root.controller !== controller) return false
    if (pending && (controller.pending !== pending || pending.identity.controller !== controller ||
        pending.identity.nonce !== controller.nonce || pending.identity.organisationSlug !== slug ||
        pending.identity.worker !== controller.worker ||
        pending.identity.transport !== controller.transport || pending.identity.root !== controller.root)) return false
    try {
      const value = clock(controller)
      if (pending && value - pending.started > pending.duration) {
        retireController(controller, pending.sent ? 'restore-required' : 'closed')
        return false
      }
      return !controller.closed && root === controller.root && controller.root.active &&
        controller.root.controller === controller && (!pending || controller.pending === pending)
    } catch {
      retireController(controller, 'restore-required')
      return false
    }
  }
  function frames(controller: Controller, count: 1 | 2): boolean {
    if (controller.frames + count > 64) {
      retireController(controller, 'invalid-response')
      return false
    }
    controller.frames += count
    return true
  }
  function send(controller: Controller, pending: Pending): void {
    if (!current(controller, pending) || !frames(controller, 1)) return
    pending.sent = true
    show('busy', controller.status, null)
    try {
      controller.control.postMessage({ version: 1, nonce: controller.nonce, rpcId: pending.identity.id,
        kind: 'command', command: pending.identity.command })
    } catch { retireController(controller, 'restore-required') }
  }
  function control(controller: Controller, input: unknown): void {
    const pending = controller.pending
    if (!current(controller, pending) || !frames(controller, 1)) return
    try {
      const reply = parseDeviceControlReply(input, controller.nonce)
      if (!current(controller, pending)) return
      if (reply.kind === 'ready') {
        if (controller.ready || !controller.bootstrapped || !pending || clock(controller) - pending.started > 30000) {
          throw new Error('DEVICE_READY')
        }
        controller.ready = true
        if (controller.startupTimer !== undefined) clearTimeout(controller.startupTimer)
        send(controller, pending)
        return
      }
      if (!controller.ready || !pending?.sent || reply.rpcId !== pending.identity.id) throw new Error('DEVICE_RPC')
      if (reply.kind === 'refused') {
        // The worker closes accepted-command failures. Busy is unexpected with our one-RPC gate.
        retireController(controller, reply.code)
        return
      }
      const status = Object.freeze({ ...reply.result })
      controller.pending = undefined
      controller.status = status
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      restoreRequired = false
      show('ready', status, null)
      pending.resolve(Object.freeze({ ok: true, status }))
    } catch { retireController(controller, 'invalid-response') }
  }
  function transport(controller: Controller, input: unknown): void {
    if (!current(controller, controller.pending)) return
    try {
      if (input === null || typeof input !== 'object') throw new Error('DEVICE_FRAME')
      const descriptors = Object.getOwnPropertyDescriptors(input)
      const values = ['version','nonce','rpcId','kind'].map((key) => {
        const item = descriptors[key]
        if (!item || !('value' in item)) throw new Error('DEVICE_FRAME')
        return item.value as unknown
      })
      const [version, nonce, rpcId, kind] = values
      if (version !== 1 || nonce !== controller.nonce || typeof rpcId !== 'number' ||
          !Number.isSafeInteger(rpcId) || rpcId <= 0 || typeof kind !== 'string' || !controller.ready) throw new Error('DEVICE_FRAME')
      if (kind === 'retire-rpc') {
        // Cross-port delivery can put genuine cleanup after its control result.
        if (rpcId > controller.nextId || Reflect.ownKeys(descriptors).length !== 4) throw new Error('DEVICE_FRAME')
        frames(controller, 1)
      } else {
        if (!['initialize-prepare','initialize-consume','attempt-prepare','attempt-send'].includes(kind) ||
            !controller.pending?.sent || controller.pending.identity.id !== rpcId) throw new Error('DEVICE_FRAME')
        // Reserve request + at most one dispatcher response BEFORE its actual listener runs.
        frames(controller, 2)
      }
      if (!current(controller, controller.pending)) return
    } catch { retireController(controller, 'invalid-response') }
  }
  function allocate(scope: Root): Controller | undefined {
    let worker: Worker | undefined
    const ports: MessagePort[] = []
    let controller: Controller | undefined
    try {
      const randomBytes = new Uint8Array(16)
      random(randomBytes)
      const nonce = Array.from(randomBytes, (value) => value.toString(16).padStart(2, '0')).join('')
      const command = new MessageChannel(); ports.push(command.port1, command.port2)
      const wire = new MessageChannel(); ports.push(wire.port1, wire.port2)
      worker = new Worker(new URL('./device.worker.ts', import.meta.url), { type: 'module', name: 'confidential-device' })
      const actual = worker
      const value: Controller = {
        root: scope, worker: actual, control: command.port1, transport: wire.port1,
        workerControl: command.port2, workerTransport: wire.port2, ports, nonce,
        controlListener: (event) => control(value, event.data),
        transportListener: (event) => transport(value, event.data),
        failed: (event) => { event.preventDefault(); retireController(value, uncertain(value) ? 'restore-required' : 'closed') },
        binding: undefined, pending: undefined, startupTimer: undefined, ready: false, bootstrapped: false,
        closed: false, nextId: 0, frames: 0, lastClock: 0, status: null,
      }
      controller = value
      scope.controller = value
      command.port1.addEventListener('message', value.controlListener)
      wire.port1.addEventListener('message', value.transportListener)
      actual.addEventListener('error', value.failed)
      actual.addEventListener('messageerror', value.failed)
      command.port1.addEventListener('messageerror', value.failed)
      wire.port1.addEventListener('messageerror', value.failed)
      // The guard listener precedes the binder; no over-budget request reaches HTTP.
      const binding = bindConfidentialDeviceDispatch(lifetime, slug, actual, wire.port1, nonce, (rpcId) => {
        const pending = value.pending
        if (!pending?.sent || pending.identity.id !== rpcId || !current(value, pending)) return undefined
        const identity = pending.identity
        return Object.freeze({ isCurrent: () => value.pending === pending && pending.identity === identity && current(value, pending) })
      })
      if (!current(value)) { contain(() => binding.close()); retireController(value, 'ineligible'); return undefined }
      value.binding = binding
      command.port1.start(); wire.port1.start()
      return value
    } catch {
      if (controller) retireController(controller, 'closed')
      else {
        contain(() => worker?.terminate())
        for (const port of ports) contain(() => port.close())
      }
      return undefined
    }
  }
  function run(command: DeviceCommand): Promise<ConfidentialDeviceResult> {
    const scope = root
    if (!scope || !currentRoot(scope)) return Promise.resolve(refused('closed'))
    if (scope.controller?.pending) return Promise.resolve(refused('busy'))
    const initialize = command === 'create' || command === 'restore'
    if (command === 'create' && restoreRequired) return Promise.resolve(refused('restore-required'))
    if (command === 'create' && scope.controller?.status) return Promise.resolve(refused('ineligible'))
    if (initialize && scope.controller) retireController(scope.controller, 'closed')
    const controller = initialize ? allocate(scope) : scope.controller
    if (!controller || (!initialize && (!controller.ready || !controller.status))) {
      return Promise.resolve(refused(restoreRequired ? 'restore-required' : 'ineligible'))
    }
    if (!current(controller)) return Promise.resolve(refused('closed'))
    return new Promise<ConfidentialDeviceResult>((resolve) => {
      try {
        const id = controller.nextId + 1
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('DEVICE_CAPACITY')
        const duration = command === 'create' || command === 'restore' || command === 'attempt' ? 60000 : 30000
        const pending: Pending = {
          identity: Object.freeze({ id, command, controller, worker: controller.worker, transport: controller.transport,
            root: scope, nonce: controller.nonce, organisationSlug: slug }),
          started: clock(controller), duration, resolve, sent: false, timer: undefined,
        }
        controller.nextId = id
        controller.frames = 0
        controller.pending = pending
        pending.timer = setTimeout(() => {
          if (controller.pending === pending) retireController(controller, pending.sent ? 'restore-required' : 'closed')
        }, duration)
        if (controller.ready) send(controller, pending)
        else {
          show('starting', null, null)
          controller.startupTimer = setTimeout(() => {
            if (!controller.ready && controller.pending === pending) retireController(controller, 'closed')
          }, 30000)
          controller.bootstrapped = true
          controller.worker.postMessage({ version: 1, kind: 'bootstrap', nonce: controller.nonce,
            control: controller.workerControl, transport: controller.workerTransport },
          [controller.workerControl, controller.workerTransport])
        }
      } catch {
        const code = uncertain(controller) ? 'restore-required' : 'closed'
        retireController(controller, code)
        resolve(refused(code))
      }
    })
  }
  const facade: ConfidentialDeviceClient = Object.freeze({
    create: () => run('create'), restore: () => run('restore'),
    prepareRegistration: () => run('prepare-registration'), preparePublication: () => run('prepare-publication'),
    attempt: () => run('attempt'),
    getSnapshot: () => { if (root) currentRoot(root); return snapshot },
    close: () => { permanent = true; if (root) retireRoot(root, 'closed'); else show('closed', null, 'closed') },
  })
  function mount(): () => void {
    if (permanent) return () => {}
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$/.test(slug)) {
      permanent = true; show('closed', null, 'invalid-input'); return () => {}
    }
    let scope: Root
    try {
      const stamp = lifetime.getRetirementStamp()
      if (stamp === null || typeof stamp !== 'object') throw new Error('DEVICE_AUTH')
      scope = { stamp, active: true, controller: undefined, unsubscribe: undefined }
      root = scope
      const unsubscribe = lifetime.subscribe(() => { currentRoot(scope) })
      if (!scope.active) { contain(unsubscribe); return () => {} }
      scope.unsubscribe = unsubscribe
      if (!currentRoot(scope)) return () => {}
      show(restoreRequired ? 'restore-required' : 'idle', null, restoreRequired ? 'restore-required' : null)
    } catch {
      permanent = true
      if (root) retireRoot(root, 'ineligible')
      else show('closed', null, 'ineligible')
      return () => {}
    }
    return () => { retireRoot(scope, 'closed') }
  }
  return { facade, mount }
}

/** One facade per actual provider/context. No public transport or native-host injection. */
export function useConfidentialDevice(organisationSlug: string): ConfidentialDeviceClient {
  const lifetime = useAuthLifetime()
  const auth = useAuth()
  const realm = auth.user?.realm, issuer = auth.user?.identity?.issuer, subject = auth.user?.identity?.subject
  const { status, generation, credentialGeneration } = auth
  const client = useMemo(() => fixedClient(lifetime, organisationSlug, Object.freeze({
    status, generation, credentialGeneration, realm, issuer, subject,
  })), [lifetime, organisationSlug, status, generation, credentialGeneration, realm, issuer, subject])
  useLayoutEffect(() => client.mount(), [client])
  return client.facade
}
