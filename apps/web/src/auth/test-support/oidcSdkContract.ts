import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import {
  clearInterval as nodeClearInterval,
  clearTimeout as nodeClearTimeout,
  setInterval as nodeSetInterval,
  setTimeout as nodeSetTimeout,
} from 'node:timers'
import { isDeepStrictEqual, TextEncoder } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'
import type * as InstalledSdk from 'oidc-client-ts'
import * as ts from 'typescript'
import { expect } from 'vitest'

export type SdkNamespace = Pick<
  typeof InstalledSdk,
  'Version' | 'OidcClient' | 'UserManager' | 'WebStorageStateStore' | 'InMemoryWebStorage'
>
export type SdkCase =
  | 'inspect-preserved'
  | 'missing-state'
  | 'unknown-state'
  | 'explicit-remove'
  | 'metadata-reversed'
  | 'round-trip'
  | 'callback-reversed'
  | 'authority-mismatch'
  | 'client-mismatch'
export type SdkVariant = 'S01' | 'S02' | 'S03' | 'S04' | 'S05'
const popupCases = [
  'stored-popup',
  'user-loaded-order',
  'wrong-origin',
  'wrong-message-tag',
  'wrong-source-state',
  'matching-state-other-source',
  'same-source-other-state',
  'same-source-unknown-state',
  'stored-redirect',
  'stored-silent',
  'stored-unknown',
  'missing-popup-state',
  'unknown-popup-state',
  'duplicate-popup',
  'abort-late-popup',
] as const
export type PopupCase = (typeof popupCases)[number]
export type PopupVariant = 'P01' | 'P02' | 'P03'
type Marker = { purpose: 'metadata-test'; correlation: 'correlation-a' | 'correlation-b' }
type Checkpoint = { marker: string; actual: unknown; expected: unknown; prerequisites: string[] }
export type CanonicalReceipt = {
  id: SdkCase | PopupCase
  prerequisites: string[]
  discoveryRequests: number
  tokenRequests: number
  checkpoints: string[]
}
type Reason =
  | 'qualified'
  | 'untagged-sdk-error'
  | 'untagged-host-error'
  | 'wrong-marker'
  | 'wrong-operands'
  | 'missing-refusal'
  | 'sticky-effect'
  | 'cleanup-failed'
  | 'residual-timer'
  | 'late-work'
  | 'unsettled-operation'
  | 'deadline'
type Outcome = {
  receipt: CanonicalReceipt
  primary: unknown
  tag: Checkpoint | undefined
  effects: string[]
  cleanup: unknown[]
  residualTimers: number
  late: number
  lateErrors: unknown[]
  unsettled: number
  deadline: boolean
}
type TimerHandle = ReturnType<typeof nodeSetTimeout>
type Manager = InstanceType<SdkNamespace['UserManager']>
type Sources = { sdk: string; jwt: string }

const issuer = 'https://id.example.test/realms/acme-sa'
const redirectUri = `${window.location.origin}/auth/callback`
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
}
const first: Marker = { purpose: 'metadata-test', correlation: 'correlation-a' }
const second: Marker = { purpose: 'metadata-test', correlation: 'correlation-b' }
const sourcePins = {
  sdk: 'cefa3decaeb97fd78b123e7cd29c092ffb7713f62756eac038f1d976b67296c6',
  jwt: 'ed3e96056fb676bbdebd1cb2b082f7f87bc6d2262401d18adfa65a5f820f6837',
  sdkPackage: '302e06acbad7e35f2844dfc29a5a708b0b06f3d8b45df4ac6a9a32c5ec826228',
  jwtPackage: '15cc76bd7effa3c5ce634c178e22cbfa76de58fa8ab7bef96d6ca2f53912df37',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  lock: '4ed80242ddb921414dc3f4b68b4f21381ceddba5e30587aadfb03ed2c66e0897',
}
const caps = { sdk: 128 * 1024, jwt: 8 * 1024, output: 256 * 1024 }
const owners = new AsyncLocalStorage<Environment>()
const active: { owner: Environment | undefined } = { owner: undefined }
const knownHostErrors = new WeakSet<object>()
function hostError(marker: string): Error {
  const error = new Error(marker)
  knownHostErrors.add(error)
  return error
}

function fail(marker: string): never {
  throw hostError(marker)
}
function own(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function message(value: unknown): string | null {
  const text = own(value, 'message')
  return typeof text === 'string' ? text : null
}
function projectMarker(value: unknown): Marker | undefined {
  if (value === undefined) return undefined
  if (!record(value) || Object.keys(value).length !== 2) fail('SDK_MARKER_SHAPE')
  const purpose = own(value, 'purpose')
  const correlation = own(value, 'correlation')
  if (
    purpose !== 'metadata-test' ||
    (correlation !== 'correlation-a' && correlation !== 'correlation-b')
  )
    fail('SDK_MARKER_SHAPE')
  return { purpose, correlation }
}
function namespace(value: unknown): value is SdkNamespace {
  if (own(value, 'Version') !== '3.5.0') return false
  const methods = {
    OidcClient: ['createSigninRequest', 'readSigninResponseState', 'processSigninResponse'],
    UserManager: ['signinCallback', 'removeUser', 'stopSilentRenew'],
    WebStorageStateStore: ['set', 'get', 'remove', 'getAllKeys'],
    InMemoryWebStorage: ['getItem', 'setItem', 'removeItem', 'clear', 'key'],
  }
  return Object.entries(methods).every(([name, required]) => {
    const constructor = own(value, name)
    if (typeof constructor !== 'function') return false
    const prototype = own(constructor, 'prototype')
    return required.every((method) => typeof own(prototype, method) === 'function')
  })
}
function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function cap(kind: 'sdk' | 'jwt', source: string): void {
  if (Buffer.byteLength(source) > caps[kind]) fail(`SDK_SOURCE_BYTE_CAP:${kind}`)
}
function sourceGrammar(source: string, kind: 'sdk' | 'jwt'): void {
  cap(kind, source)
  const ast = ts.createSourceFile(
    `${kind}.js`,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  )
  const imports: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) fail('SDK_DEPENDENCY_REFUSED')
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      fail('SDK_DYNAMIC_IMPORT_REFUSED')
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      fail('SDK_IMPORT_META_REFUSED')
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['require', 'eval', 'Function'].includes(node.expression.text)
    )
      fail('SDK_DEPENDENCY_REFUSED')
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) fail('SDK_DEPENDENCY_REFUSED')
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const expected = kind === 'sdk' ? ['jwt-decode'] : []
  if (!isDeepStrictEqual(imports, expected)) fail('SDK_DEPENDENCY_REFUSED')
}
function pinned(kind: 'sdk' | 'jwt', source: string): void {
  cap(kind, source)
  if (sha(source) !== sourcePins[kind]) fail(`SDK_SOURCE_PIN_MISMATCH:${kind}`)
}
// Only the SDK's own lockfile entries are pinned: an unrelated dependency bump must not trip it.
function sdkLockEntries(): string {
  const lock: unknown = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../package-lock.json'),
      'utf8'
    )
  )
  const packages = own(lock, 'packages')
  if (!record(packages)) fail('SDK_SOURCE_PIN_MISMATCH:tool-or-lock')
  const entries = Object.keys(packages)
    .filter((path) => /(^|\/)node_modules\/(oidc-client-ts|jwt-decode)$/.test(path))
    .sort()
    .map((path) => [path, packages[path]])
  return JSON.stringify(entries)
}
function readSources(): Sources {
  const require = createRequire(import.meta.url)
  const sdkPackagePath = require.resolve('oidc-client-ts/package.json')
  const sdkDirectory = dirname(sdkPackagePath)
  const sdkPackageBytes = readFileSync(sdkPackagePath)
  if (sha(sdkPackageBytes) !== sourcePins.sdkPackage) fail('SDK_SOURCE_PIN_MISMATCH:sdk-package')
  const sdkPackage: unknown = JSON.parse(sdkPackageBytes.toString('utf8'))
  if (own(own(own(sdkPackage, 'exports'), '.'), 'import') !== './dist/esm/oidc-client-ts.js')
    fail('SDK_DEPENDENCY_REFUSED')
  const sdkRequire = createRequire(sdkPackagePath)
  // Resolve the actual dependency's require entry only to locate its package; read its import target.
  const jwtPackagePath = resolve(dirname(sdkRequire.resolve('jwt-decode')), '../../package.json')
  const jwtPackageBytes = readFileSync(jwtPackagePath)
  if (sha(jwtPackageBytes) !== sourcePins.jwtPackage) fail('SDK_SOURCE_PIN_MISMATCH:jwt-package')
  const jwtPackage: unknown = JSON.parse(jwtPackageBytes.toString('utf8'))
  if (
    own(own(own(own(jwtPackage, 'exports'), '.'), 'import'), 'default') !== './build/esm/index.js'
  )
    fail('SDK_DEPENDENCY_REFUSED')
  const sdk = readFileSync(resolve(sdkDirectory, 'dist/esm/oidc-client-ts.js'), 'utf8')
  const jwt = readFileSync(resolve(dirname(jwtPackagePath), 'build/esm/index.js'), 'utf8')
  const typescriptPackagePath = require.resolve('typescript/package.json')
  if (
    sha(readFileSync(typescriptPackagePath)) !== sourcePins.typescriptPackage ||
    sha(readFileSync(resolve(dirname(typescriptPackagePath), 'lib/typescript.js'))) !==
      sourcePins.typescript ||
    sha(sdkLockEntries()) !== sourcePins.lock
  )
    fail('SDK_SOURCE_PIN_MISMATCH:tool-or-lock')
  pinned('sdk', sdk)
  pinned('jwt', jwt)
  sourceGrammar(sdk, 'sdk')
  sourceGrammar(jwt, 'jwt')
  return { sdk, jwt }
}
function output(source: string, errors: readonly ts.Diagnostic[]): string {
  if (errors.length) fail('SDK_CONVERSION_REFUSED')
  if (Buffer.byteLength(source) > caps.output) fail('SDK_OUTPUT_BYTE_CAP')
  return source
}
function convert(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  })
  return output(result.outputText, result.diagnostics ?? [])
}
function replaceUnique(
  source: string,
  start: string,
  end: string,
  anchor: string,
  replacement: string
): string {
  const begin = source.indexOf(start)
  const finish = source.indexOf(end, begin + start.length)
  if (begin < 0 || finish < 0 || source.indexOf(start, begin + 1) >= 0) fail('SDK_ANCHOR_COUNT')
  const window = source.slice(begin, finish)
  if (window.split(anchor).length - 1 !== 1) fail('SDK_ANCHOR_COUNT')
  return source.slice(0, begin) + window.replace(anchor, replacement) + source.slice(finish)
}
function variant(source: string, id: SdkVariant): string {
  if (id === 'S01' || id === 'S02')
    return replaceUnique(
      source,
      '  async readSigninResponseState(url, removeState = false) {',
      '  async processSigninResponse(',
      'this.settings.stateStore[removeState ? "remove" : "get"]',
      `this.settings.stateStore["${id === 'S01' ? 'remove' : 'get'}"]`
    )
  const anchor =
    id === 'S03'
      ? '    response.userState = state.data;\n'
      : id === 'S04'
        ? '    if (this._settings.authority !== state.authority) {\n      logger2.throw(new Error("authority mismatch on settings vs. signin state"));\n    }\n'
        : '    if (this._settings.client_id && this._settings.client_id !== state.client_id) {\n      logger2.throw(new Error("client_id mismatch on settings vs. signin state"));\n    }\n'
  return replaceUnique(
    source,
    '  _processSigninState(response, state) {',
    '  async _processClaims(',
    anchor,
    ''
  )
}
function fixtureToken(): string {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: issuer,
    sub: 'sdk-processed-subject',
    aud: 'console',
    iat: now,
    exp: now + 300,
  })}.synthetic-signature`
}

class Environment {
  popup: PopupBridge | undefined
  readonly effects: string[] = []
  readonly cleanup: unknown[] = []
  readonly managers: Manager[] = []
  readonly pending = new Set<Promise<unknown>>()
  readonly controllers = new Set<AbortController>()
  readonly timeouts = new Set<TimerHandle>()
  readonly intervals = new Set<TimerHandle>()
  readonly tags = new WeakMap<object, Checkpoint>()
  readonly restore: (() => void)[] = []
  readonly receipt: CanonicalReceipt
  closed = false
  late = 0
  readonly lateErrors: unknown[] = []
  callbackObserved: (() => void) | undefined
  callbacks = 0
  deadline = false
  disposed = false
  constructor(id: SdkCase | PopupCase) {
    if (active.owner) fail('SDK_INVOCATION_OVERLAP')
    active.owner = this
    this.receipt = {
      id,
      prerequisites: [],
      discoveryRequests: 0,
      tokenRequests: 0,
      checkpoints: [],
    }
  }
  unexpected = (kind: string): never => {
    this.effects.push(kind)
    if (this.closed) this.late += 1
    return fail(`SDK_EFFECT_REFUSED:${kind}`)
  }
  open(): void {
    if (this.closed) {
      this.late += 1
      fail('SDK_INVOCATION_CLOSED')
    }
  }
  assert(marker: string, actual: unknown, expected: unknown): void {
    this.receipt.checkpoints.push(marker)
    try {
      expect(actual, marker).toEqual(expected)
    } catch (error) {
      if (typeof error !== 'object' || error === null) throw error
      this.tags.set(error, {
        marker,
        actual,
        expected,
        prerequisites: [...this.receipt.prerequisites],
      })
      throw error
    }
  }
  prerequisite(name: string): void {
    this.receipt.prerequisites.push(name)
  }
  async operation<T>(promise: Promise<T>): Promise<T> {
    this.open()
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise)
    )
    return promise
  }
  schedule(
    callback: unknown,
    delay: number | undefined,
    args: unknown[],
    interval: boolean
  ): TimerHandle {
    this.open()
    if (typeof callback !== 'function') return this.unexpected('timer-string')
    const invoke = () =>
      owners.run(this, () => {
        if (!interval) this.timeouts.delete(handle)
        this.callbacks += 1
        try {
          if (this.closed) {
            this.late += 1
            this.lateErrors.push(hostError('SDK_INVOCATION_CLOSED'))
            return
          }
          const result: unknown = Reflect.apply(callback, undefined, args)
          if (result !== undefined) {
            const completion = Promise.resolve(result)
            this.pending.add(completion)
            void completion.then(
              () => this.pending.delete(completion),
              (error: unknown) => {
                this.cleanup.push(error)
                this.pending.delete(completion)
              }
            )
          }
        } catch (error) {
          this.cleanup.push(error)
        } finally {
          this.callbacks -= 1
          const observed = this.callbackObserved
          this.callbackObserved = undefined
          observed?.()
        }
      })
    const handle: TimerHandle = interval
      ? nodeSetInterval(invoke, delay)
      : nodeSetTimeout(invoke, delay)
    ;(interval ? this.intervals : this.timeouts).add(handle)
    return handle
  }
  clear(handle: unknown, interval: boolean): boolean {
    const handles = interval ? this.intervals : this.timeouts
    for (const owned of handles) {
      if (owned === handle) {
        if (interval) nodeClearInterval(owned)
        else nodeClearTimeout(owned)
        handles.delete(owned)
        return true
      }
    }
    return false
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.open()
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (url === `${issuer}/.well-known/openid-configuration` && method === 'GET') {
        this.receipt.discoveryRequests += 1
        return Response.json(metadata)
      }
      if (
        url === `${issuer}/token` &&
        method === 'POST' &&
        (typeof init?.body === 'string' || init?.body instanceof URLSearchParams)
      ) {
        const body = new URLSearchParams(init.body)
        const fields: string[] = []
        body.forEach((_value, key) => {
          fields.push(key)
        })
        if (
          body.get('grant_type') !== 'authorization_code' ||
          !['console', 'other-console'].includes(body.get('client_id') ?? '') ||
          !['controlled-code', 'controlled-code-a', 'controlled-code-b'].includes(
            body.get('code') ?? ''
          ) ||
          fields.length !== 5 ||
          new Set(fields).size !== 5 ||
          body.get('redirect_uri') !== redirectUri ||
          !body.get('code_verifier')
        )
          return this.unexpected('token-fields')
        this.receipt.tokenRequests += 1
        return Response.json({
          access_token: 'synthetic-access',
          id_token: fixtureToken(),
          token_type: 'Bearer',
          scope: 'openid',
          expires_in: 300,
        })
      }
      return this.unexpected('fetch')
    } finally {
      this.controllers.delete(controller)
    }
  }
  patch(target: object, key: string, replacement: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement })
    this.restore.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else Reflect.deleteProperty(target, key)
    })
  }
  trap(target: object, key: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    const original: unknown = Reflect.get(target, key)
    Object.defineProperty(target, key, {
      configurable: true,
      get: () => {
        if (owners.getStore() === this) return this.unexpected(key)
        return original
      },
    })
    this.restore.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else Reflect.deleteProperty(target, key)
    })
  }
  install(): void {
    const targets = new Set<object>([globalThis, window])
    for (const target of targets) {
      for (const key of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']) {
        const original: unknown = Reflect.get(target, key)
        this.patch(target, key, (...args: unknown[]) => {
          const owner = owners.getStore()
          if (owner !== this) {
            if (typeof original !== 'function') fail('SDK_TIMER_CAPABILITY_MISSING')
            return Reflect.apply(original, target, args)
          }
          if (key.startsWith('clear')) {
            if (!this.clear(args[0], key === 'clearInterval'))
              this.unexpected('foreign-timer-clear')
            return undefined
          }
          return this.schedule(
            args[0],
            typeof args[1] === 'number' ? args[1] : undefined,
            args.slice(2),
            key === 'setInterval'
          )
        })
      }
      const originalFetch: unknown = Reflect.get(target, 'fetch')
      this.patch(target, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (owners.getStore() === this) return this.fetch(input, init)
        if (typeof originalFetch !== 'function')
          return this.unexpected('foreign-fetch-without-fixture')
        return Reflect.apply(originalFetch, target, [input, init])
      })
      this.patch(target, 'crypto', webcrypto)
      for (const key of [
        'open',
        'postMessage',
        'addEventListener',
        'removeEventListener',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'Worker',
        'SharedWorker',
        'BroadcastChannel',
      ]) {
        this.trap(target, key)
      }
    }
    this.trap(navigator, 'sendBeacon')
    for (const target of targets) this.trap(target, 'indexedDB')
    for (const key of ['createElement', 'createElementNS']) {
      const original: unknown = Reflect.get(document, key)
      this.patch(document, key, (...args: unknown[]) => {
        if (owners.getStore() === this) return this.unexpected(`document.${key}`)
        if (typeof original !== 'function') fail('SDK_DOM_CAPABILITY_MISSING')
        return Reflect.apply(original, document, args)
      })
    }
    for (const key of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      const original: unknown = Reflect.get(Storage.prototype, key)
      const ownsInvocation = () => owners.getStore() === this
      const unexpected = this.unexpected
      this.patch(Storage.prototype, key, function (this: Storage, ...args: unknown[]) {
        if (ownsInvocation()) return unexpected(`browser-storage.${key}`)
        if (typeof original !== 'function') fail('SDK_STORAGE_CAPABILITY_MISSING')
        return Reflect.apply(original, this, args)
      })
    }
    this.popup?.install(targets)
  }
  globals(): Record<string, unknown> {
    const unexpected = this.unexpected
    const deny = (name: string) =>
      function (..._args: unknown[]) {
        return unexpected(name)
      }
    const windowFacade = {
      crypto: webcrypto,
      location: Object.freeze({ href: redirectUri, origin: new URL(redirectUri).origin }),
      document: {
        createElement: deny('document.createElement'),
        body: { appendChild: deny('appendChild') },
      },
      open: deny('open'),
      postMessage: deny('postMessage'),
      addEventListener: deny('addEventListener'),
      removeEventListener: deny('removeEventListener'),
      indexedDB: { open: deny('indexedDB') },
    }
    const globals: Record<string, unknown> = {
      window: windowFacade,
      document: windowFacade.document,
      navigator: { sendBeacon: deny('sendBeacon') },
      indexedDB: { open: deny('indexedDB') },
      crypto: webcrypto,
      TextEncoder,
      URL,
      URLSearchParams,
      atob,
      btoa,
      AbortController,
      AbortSignal,
      DOMException,
      fetch: this.fetch,
      setTimeout: (callback: unknown, delay?: number, ...args: unknown[]) =>
        this.schedule(callback, delay, args, false),
      setInterval: (callback: unknown, delay?: number, ...args: unknown[]) =>
        this.schedule(callback, delay, args, true),
      clearTimeout: (handle: unknown) => {
        if (!this.clear(handle, false)) this.unexpected('foreign-timeout-clear')
      },
      clearInterval: (handle: unknown) => {
        if (!this.clear(handle, true)) this.unexpected('foreign-interval-clear')
      },
      XMLHttpRequest: deny('XMLHttpRequest'),
      WebSocket: deny('WebSocket'),
      EventSource: deny('EventSource'),
      Worker: deny('Worker'),
      SharedWorker: deny('SharedWorker'),
      BroadcastChannel: deny('BroadcastChannel'),
    }
    for (const key of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'])
      Object.defineProperty(windowFacade, key, { value: globals[key] })
    for (const key of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(windowFacade, key, { get: () => this.unexpected(key) })
      Object.defineProperty(globals, key, { get: () => this.unexpected(key) })
    }
    this.popup?.realm(windowFacade, globals)
    return globals
  }
  async dispose(): Promise<{ residual: number; unsettled: number }> {
    if (this.disposed) return { residual: 0, unsettled: 0 }
    this.closed = true
    const cleanupDeadline = Date.now() + 1000
    for (const controller of this.controllers) controller.abort()
    this.popup?.dispose()
    for (const manager of this.managers.splice(0)) {
      try {
        const removal = manager.removeUser()
        this.pending.add(removal)
        void removal.then(
          () => this.pending.delete(removal),
          (error: unknown) => {
            this.cleanup.push(error)
            this.pending.delete(removal)
          }
        )
        await drain(removal, Math.max(0, cleanupDeadline - Date.now()))
      } catch (error) {
        this.cleanup.push(error)
      }
      try {
        manager.stopSilentRenew()
      } catch (error) {
        this.cleanup.push(error)
      }
    }
    await drain(Promise.allSettled([...this.pending]), Math.max(0, cleanupDeadline - Date.now()))
    const unsettled = this.pending.size + this.controllers.size + this.callbacks
    if (this.callbackObserved) {
      this.cleanup.push(hostError('SDK_CALLBACK_NOT_DRAINED'))
      this.callbackObserved = undefined
    }
    const residual = this.timeouts.size + this.intervals.size
    for (const handle of this.timeouts) nodeClearTimeout(handle)
    for (const handle of this.intervals) nodeClearInterval(handle)
    this.timeouts.clear()
    this.intervals.clear()
    if (unsettled === 0) {
      for (const restore of this.restore.reverse()) {
        try {
          restore()
        } catch (error) {
          this.cleanup.push(error)
        }
      }
      this.restore.length = 0
      active.owner = undefined
      this.disposed = true
    }
    return { residual, unsettled }
  }
}

function popupLatch<T>() {
  let release: (value: T) => void = () => fail('POPUP_LATCH_NOT_INITIALIZED')
  const promise = new Promise<T>((resolvePromise) => {
    release = resolvePromise
  })
  return { promise, release }
}
type PopupMessage = { source: string; url: string; keepOpen: boolean }
type PopupEvent = { data: PopupMessage; origin: string; source: unknown }
type PopupListener = (event: PopupEvent) => unknown
type PopupChannel = { listeners: Set<PopupListener>; close: () => void }
const popupOrigin = new URL(redirectUri).origin
const popupFeatures = { width: 480, height: 640, left: 0, top: 0 }

class PopupBridge {
  readonly ready = popupLatch<void>()
  readonly listeners = new Set<PopupListener>()
  readonly channels = new Set<PopupChannel>()
  readonly notifications: PopupMessage[] = []
  readonly lanes: ('opener' | 'parent')[] = []
  readonly signalCleanup: (() => void)[] = []
  state: string | undefined
  opens = 0
  disposed = false
  readonly child: {
    closed: boolean
    focus: () => void
    close: () => void
    location: { replace: (value: unknown) => void }
  } = {
    closed: false,
    focus: () => this.env.open(),
    close: () => {
      this.env.open()
      this.child.closed = true
    },
    location: {
      replace: (value: unknown) => {
        this.env.open()
        if (typeof value !== 'string') return this.env.unexpected('popup-navigation')
        const target = new URL(value)
        if (target.origin + target.pathname !== `${issuer}/authorize` || this.state)
          return this.env.unexpected('popup-navigation')
        this.state = target.searchParams.get('state') ?? undefined
        if (!this.state) return this.env.unexpected('popup-state')
      },
    },
  }
  constructor(
    readonly env: Environment,
    readonly id: PopupCase
  ) {}
  open = (value: unknown, target: unknown, features: unknown) => {
    this.env.open()
    if (this.opens || value !== undefined || target !== 'sdk-popup-contract')
      return this.env.unexpected('popup-extra-open')
    if (typeof features !== 'string') return this.env.unexpected('popup-features')
    this.env.assert(
      'POPUP_FEATURES',
      Object.fromEntries(features.split(',').map((part) => part.split('='))),
      {
        location: 'no',
        toolbar: 'no',
        height: '640',
        closePopupWindowAfterInSeconds: '-1',
        width: '480',
        left: '0',
        top: '0',
      }
    )
    this.opens += 1
    return this.child
  }
  add = (kind: unknown, listener: unknown, capture?: unknown) => {
    this.env.open()
    if (kind !== 'message' || typeof listener !== 'function' || capture !== false)
      return this.env.unexpected('popup-event')
    this.listeners.add(listener as PopupListener)
  }
  remove = (kind: unknown, listener: unknown, capture?: unknown) => {
    this.env.open()
    if (
      kind !== 'message' ||
      capture !== false ||
      !this.listeners.delete(listener as PopupListener)
    )
      return this.env.unexpected('popup-foreign-listener')
  }
  notify(value: unknown, origin: unknown, lane: 'opener' | 'parent'): void {
    this.env.open()
    if (lane === 'parent' && this.id !== 'stored-silent')
      return this.env.unexpected('popup-parent-lane')
    if (
      origin !== popupOrigin ||
      !record(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), ['keepOpen', 'source', 'url']) ||
      own(value, 'source') !== 'oidc-client' ||
      own(value, 'keepOpen') !== false ||
      typeof own(value, 'url') !== 'string'
    )
      return this.env.unexpected('popup-notification')
    const responseUrl = own(value, 'url') as string
    const parsed = new URL(responseUrl)
    if (parsed.origin + parsed.pathname !== redirectUri)
      return this.env.unexpected('popup-notification-url')
    this.notifications.push({ source: 'oidc-client', url: responseUrl, keepOpen: false })
    this.lanes.push(lane)
  }
  channelType() {
    const environment = this.env
    const channels = this.channels
    const ready = this.ready
    const currentState = () => this.state
    return class {
      readonly listeners = new Set<PopupListener>()
      constructor(name: unknown) {
        environment.open()
        const state = currentState()
        if (!state || name !== `oidc-client-popup-${state}` || channels.size)
          environment.unexpected('popup-channel')
        channels.add(this)
      }
      addEventListener(kind: unknown, listener: unknown, capture?: unknown): void {
        environment.open()
        if (kind !== 'message' || typeof listener !== 'function' || capture !== false)
          return environment.unexpected('popup-channel-event')
        this.listeners.add(listener as PopupListener)
        ready.release()
      }
      postMessage(): never {
        return environment.unexpected('popup-channel-post')
      }
      close(): void {
        environment.open()
        if (!channels.delete(this)) return environment.unexpected('popup-channel-close')
        this.listeners.clear()
      }
    }
  }
  realm(target: object, globals: Record<string, unknown>): void {
    Object.assign(target, {
      open: this.open,
      addEventListener: this.add,
      removeEventListener: this.remove,
      opener: {
        postMessage: (value: unknown, origin: unknown) => this.notify(value, origin, 'opener'),
      },
      parent: {
        postMessage: (value: unknown, origin: unknown) => this.notify(value, origin, 'parent'),
      },
      outerWidth: 1024,
      outerHeight: 768,
      screenX: 0,
      screenY: 0,
    })
    globals['BroadcastChannel'] = this.channelType()
  }
  install(targets: Set<object>): void {
    const channel = this.channelType()
    for (const target of targets) {
      for (const [key, owned] of Object.entries({
        open: this.open,
        addEventListener: this.add,
        removeEventListener: this.remove,
      })) {
        const original: unknown = Reflect.get(target, key)
        this.env.patch(target, key, (...args: unknown[]) => {
          if (owners.getStore() === this.env) return Reflect.apply(owned, this, args)
          if (typeof original !== 'function') return fail('POPUP_FOREIGN_CAPABILITY')
          return Reflect.apply(original, target, args)
        })
      }
      this.env.patch(target, 'BroadcastChannel', channel)
      this.env.patch(target, 'opener', {
        postMessage: (value: unknown, origin: unknown) => this.notify(value, origin, 'opener'),
      })
      this.env.patch(target, 'parent', {
        postMessage: (value: unknown, origin: unknown) => this.notify(value, origin, 'parent'),
      })
    }
  }
  trackSignal(signal: AbortSignal): void {
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    this.env.patch(signal, 'addEventListener', (kind: string, listener: EventListener) => {
      if (kind !== 'abort') return this.env.unexpected('popup-signal-event')
      add(kind, listener)
      this.signalCleanup.push(() => remove(kind, listener))
    })
  }
  deliver(
    data: PopupMessage,
    origin = popupOrigin,
    source: unknown = this.child,
    channel = false
  ): void {
    this.env.open()
    const receivers = channel
      ? [...this.channels].flatMap((owned) => [...owned.listeners])
      : [...this.listeners]
    for (const listener of receivers) {
      if (listener({ data, origin, source }) !== undefined)
        this.env.unexpected('popup-listener-return')
    }
  }
  async turn(): Promise<void> {
    await this.env.operation(
      new Promise<void>((resolvePromise) => {
        this.env.schedule(resolvePromise, 0, [], false)
      })
    )
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.listeners.size || this.channels.size)
      this.env.cleanup.push(hostError('POPUP_RESIDUAL_RECEIVER'))
    this.listeners.clear()
    for (const channel of this.channels) channel.listeners.clear()
    this.channels.clear()
    for (const cleanup of this.signalCleanup.splice(0)) cleanup()
    this.child.closed = true
  }
}

function memoryNamespace(sources: Sources, environment: Environment): SdkNamespace {
  sourceGrammar(sources.sdk, 'sdk')
  sourceGrammar(sources.jwt, 'jwt')
  const sdkOutput = convert(sources.sdk)
  const jwtOutput = convert(sources.jwt)
  const globals = environment.globals()
  const context = createContext(globals, { codeGeneration: { strings: false, wasm: false } })
  function evaluate(source: string, dependency?: unknown): unknown {
    const module: { exports: unknown } = { exports: {} }
    Object.assign(globals, {
      module,
      exports: module.exports,
      require: (name: unknown) =>
        name === 'jwt-decode' && dependency !== undefined
          ? dependency
          : environment.unexpected('import'),
    })
    new Script(`(function(exports,module,require){\n${source}\n})(exports,module,require);`, {
      filename: 'pinned-sdk-contract.cjs',
    }).runInContext(context, { timeout: 500 })
    return module.exports
  }
  const jwt = evaluate(jwtOutput)
  if (!record(jwt) || typeof own(jwt, 'jwtDecode') !== 'function') fail('SDK_EXPORT_SHAPE')
  const sdk = evaluate(sdkOutput, jwt)
  if (!namespace(sdk)) fail('SDK_EXPORT_SHAPE')
  return sdk
}
function url(id?: string, code = 'controlled-code'): string {
  const value = new URL(redirectUri)
  if (id !== undefined) value.searchParams.set('state', id)
  value.searchParams.set('code', code)
  value.searchParams.set('correlation', 'correlation-b')
  value.searchParams.set('request_type', 'si:s')
  return value.href
}
async function rejected(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return message(error)
  }
}
async function canonical(sdk: SdkNamespace, id: SdkCase, env: Environment): Promise<void> {
  const store = new sdk.WebStorageStateStore({ store: new sdk.InMemoryWebStorage() })
  const settings = {
    authority: issuer,
    client_id: 'console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    stateStore: store,
    metadata: { ...metadata },
  }
  const client = new sdk.OidcClient(settings)
  const request = await env.operation(
    client.createSigninRequest({ request_type: 'si:r', skipUserInfo: true, state: { ...first } })
  )
  env.prerequisite('stored-request')
  const stored = await store.get(request.state.id)
  env.assert('SDK_STORED_REQUEST_NON_NULL', typeof stored, 'string')
  let removeCalls = 0
  const remove = store.remove.bind(store)
  store.remove = async (key) => {
    removeCalls += 1
    return remove(key)
  }
  const beforeInspection = {
    discovery: env.receipt.discoveryRequests,
    token: env.receipt.tokenRequests,
  }
  const inspected = await env.operation(client.readSigninResponseState(url(request.state.id)))
  env.assert(
    'SDK_PUBLIC_REQUEST_FIELDS',
    {
      id: inspected.state.id,
      type: inspected.state.request_type,
      authority: inspected.state.authority,
      client: inspected.state.client_id,
      redirect: inspected.state.redirect_uri,
      data: projectMarker(inspected.state.data),
    },
    {
      id: request.state.id,
      type: 'si:r',
      authority: issuer,
      client: 'console',
      redirect: redirectUri,
      data: first,
    }
  )
  env.assert(
    'SDK_INSPECTION_NO_PROVIDER_REQUEST',
    { discovery: env.receipt.discoveryRequests, token: env.receipt.tokenRequests },
    beforeInspection
  )
  env.prerequisite('first-inspection-matches')
  if (id === 'inspect-preserved') {
    env.assert(
      'SDK_INSPECTION_PRESERVES_REQUEST',
      { retained: stored !== null && (await store.get(request.state.id)) === stored, removeCalls },
      { retained: true, removeCalls: 0 }
    )
    const again = await env.operation(client.readSigninResponseState(url(request.state.id), false))
    env.assert('SDK_REPEAT_METADATA', projectMarker(again.state.data), first)
    env.assert(
      'SDK_REPEAT_STORAGE',
      { retained: (await store.get(request.state.id)) === stored, removeCalls },
      { retained: true, removeCalls: 0 }
    )
  } else if (id === 'missing-state' || id === 'unknown-state' || id === 'explicit-remove') {
    const other = await env.operation(client.createSigninRequest({ request_type: 'si:s' }))
    if (id === 'explicit-remove') {
      const consumed = await env.operation(
        client.readSigninResponseState(url(request.state.id), true)
      )
      env.assert('SDK_EXPLICIT_REMOVAL_RETURNS_REQUEST', consumed.state.id, request.state.id)
      env.prerequisite('explicit-read-returns-request')
      env.assert(
        'SDK_EXPLICIT_REMOVAL_CONSUMES_REQUEST',
        (await store.get(request.state.id)) === undefined,
        true
      )
    }
    const invalidUrl =
      id === 'missing-state'
        ? url()
        : url(id === 'unknown-state' ? 'unknown-request' : request.state.id)
    const error = await rejected(env.operation(client.readSigninResponseState(invalidUrl)))
    env.assert(
      'SDK_MISSING_UNKNOWN_REMOVED_REFUSED',
      error,
      id === 'missing-state' ? 'No state in response' : 'No matching state found in storage'
    )
    const remaining = await env.operation(client.readSigninResponseState(url(other.state.id)))
    env.assert(
      'SDK_INDEPENDENT_REQUEST',
      { id: remaining.state.id, type: remaining.state.request_type },
      { id: other.state.id, type: 'si:s' }
    )
  } else if (id === 'metadata-reversed') {
    const other = await env.operation(
      client.createSigninRequest({ request_type: 'si:s', state: { ...second } })
    )
    env.assert('SDK_DISTINCT_REQUEST_IDS', request.state.id === other.state.id, false)
    for (const [current, marker, label] of [
      [other, second, 'correlation-a'],
      [request, first, 'correlation-b'],
    ] as const) {
      const value = new URL(url(current.state.id))
      value.searchParams.set('correlation', label)
      const result = await env.operation(client.readSigninResponseState(value.href))
      env.assert(
        'SDK_REVERSED_METADATA',
        { id: result.state.id, data: projectMarker(result.state.data) },
        { id: current.state.id, data: marker }
      )
    }
  } else {
    const manager = new sdk.UserManager({
      ...settings,
      ...(id === 'authority-mismatch'
        ? { authority: 'https://other.example.test/realms/acme-sa' }
        : {}),
      ...(id === 'client-mismatch' ? { client_id: 'other-console' } : {}),
      automaticSilentRenew: false,
      userStore: new sdk.WebStorageStateStore({ store: new sdk.InMemoryWebStorage() }),
    })
    env.managers.push(manager)
    const ownedAccessTokenTimers = () =>
      env.assert('SDK_ACCESS_TOKEN_TIMERS_OWNED', env.intervals.size, 2)
    if (id === 'authority-mismatch' || id === 'client-mismatch') {
      env.prerequisite('wrong-config-original-request-same-metadata')
      const error = await rejected(env.operation(manager.signinCallback(url(request.state.id))))
      if (error === null) ownedAccessTokenTimers()
      env.assert(
        id === 'authority-mismatch'
          ? 'SDK_AUTHORITY_MISMATCH_PRE_EXCHANGE'
          : 'SDK_CLIENT_MISMATCH_PRE_EXCHANGE',
        { error, tokenRequests: env.receipt.tokenRequests },
        {
          error: `${id === 'authority-mismatch' ? 'authority' : 'client_id'} mismatch on settings vs. signin state`,
          tokenRequests: 0,
        }
      )
    } else if (id === 'round-trip') {
      const user = await env.operation(manager.signinCallback(url(request.state.id)))
      env.assert('SDK_ONE_TOKEN_EXCHANGE', env.receipt.tokenRequests, 1)
      ownedAccessTokenTimers()
      env.prerequisite('interactive-returned-one-token')
      env.assert('SDK_USER_STATE_ROUND_TRIP', projectMarker(user?.state), first)
      env.assert('SDK_CALLBACK_REQUEST_CONSUMED', await store.get(request.state.id), undefined)
      env.assert(
        'SDK_DUPLICATE_CALLBACK_REFUSED',
        await rejected(env.operation(manager.signinCallback(url(request.state.id)))),
        'No matching state found in storage'
      )
      env.assert('SDK_DUPLICATE_NO_SECOND_TOKEN', env.receipt.tokenRequests, 1)
    } else {
      const other = await env.operation(
        client.createSigninRequest({
          request_type: 'si:r',
          skipUserInfo: true,
          state: { ...second },
        })
      )
      const b = await env.operation(
        manager.signinCallback(url(other.state.id, 'controlled-code-b'))
      )
      ownedAccessTokenTimers()
      env.assert('SDK_REVERSED_CALLBACK_B', projectMarker(b?.state), second)
      env.assert('SDK_REVERSED_CALLBACK_B_REMOVED', await store.get(other.state.id), undefined)
      env.assert(
        'SDK_REMAINING_A_METADATA',
        projectMarker(
          (await env.operation(client.readSigninResponseState(url(request.state.id)))).state.data
        ),
        first
      )
      const a = await env.operation(
        manager.signinCallback(url(request.state.id, 'controlled-code-a'))
      )
      ownedAccessTokenTimers()
      env.assert('SDK_REVERSED_CALLBACK_A', projectMarker(a?.state), first)
      env.assert('SDK_REVERSED_CALLBACK_A_REMOVED', await store.get(request.state.id), undefined)
      env.assert('SDK_REVERSED_CALLBACK_TOKEN_COUNT', env.receipt.tokenRequests, 2)
    }
  }
  if (
    [
      'inspect-preserved',
      'missing-state',
      'unknown-state',
      'explicit-remove',
      'metadata-reversed',
    ].includes(id)
  )
    env.assert(
      'SDK_METADATA_NO_PROVIDER_REQUEST',
      { discovery: env.receipt.discoveryRequests, token: env.receipt.tokenRequests },
      beforeInspection
    )
}

async function popupCanonical(sdk: SdkNamespace, id: PopupCase, env: Environment): Promise<void> {
  const bridge = env.popup
  if (!bridge) fail('POPUP_FIXTURE_MISSING')
  const store = new sdk.WebStorageStateStore({ store: new sdk.InMemoryWebStorage() })
  const settings = {
    authority: issuer,
    client_id: 'console',
    redirect_uri: redirectUri,
    popup_redirect_uri: redirectUri,
    popupWindowTarget: 'sdk-popup-contract',
    popupWindowFeatures: popupFeatures,
    response_type: 'code',
    scope: 'openid',
    stateStore: store,
    metadata: { ...metadata },
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
  }
  const manager = () => {
    const value = new sdk.UserManager({
      ...settings,
      userStore: new sdk.WebStorageStateStore({ store: new sdk.InMemoryWebStorage() }),
    })
    env.managers.push(value)
    return value
  }
  const parent = manager()
  const child = manager()
  const client = new sdk.OidcClient(settings)
  const controller = new AbortController()
  env.controllers.add(controller)
  bridge.trackSignal(controller.signal)
  type PopupUser = Awaited<ReturnType<Manager['signinPopup']>>
  const result: { settled: boolean; count: number; user?: PopupUser; error?: unknown } = {
    settled: false,
    count: 0,
  }
  const event: { count: number; user?: PopupUser } = { count: 0 }
  const loaded = popupLatch<void>()
  const releaseLoaded = popupLatch<void>()
  const observeLoaded = (user: PopupUser) => {
    event.count += 1
    event.user = user
    loaded.release()
    return id === 'user-loaded-order' ? releaseLoaded.promise : undefined
  }
  parent.events.addUserLoaded(observeLoaded)
  const completion = env.operation(
    parent.signinPopup({ state: { ...first }, popupSignal: controller.signal }).then(
      (user) => {
        result.settled = true
        result.count += 1
        result.user = user
      },
      (error: unknown) => {
        result.settled = true
        result.count += 1
        result.error = error
      }
    )
  )
  try {
    await env.operation(bridge.ready.promise)
    const state = bridge.state
    if (!state) fail('POPUP_STORED_STATE_MISSING')
    const inspected = await env.operation(client.readSigninResponseState(url(state)))
    env.assert(
      'POPUP_STORED_CONTEXT',
      {
        id: inspected.state.id === state,
        type: inspected.state.request_type,
        authority: inspected.state.authority,
        client: inspected.state.client_id,
        redirect: inspected.state.redirect_uri,
        marker: projectMarker(inspected.state.data),
      },
      {
        id: true,
        type: 'si:p',
        authority: issuer,
        client: 'console',
        redirect: redirectUri,
        marker: first,
      }
    )
    env.prerequisite('popup-stored-si:p')
    env.assert(
      'POPUP_RECEIVER_INSTALLED',
      { opens: bridge.opens, listeners: bridge.listeners.size, channels: bridge.channels.size },
      { opens: 1, listeners: 1, channels: 1 }
    )
    env.prerequisite('popup-receiver-ready')

    if (
      [
        'stored-redirect',
        'stored-silent',
        'stored-unknown',
        'missing-popup-state',
        'unknown-popup-state',
      ].includes(id)
    ) {
      const type =
        id === 'stored-redirect' ? 'si:r' : id === 'stored-silent' ? 'si:s' : 'si:unknown'
      const other = await env.operation(
        client.createSigninRequest({ request_type: type, state: { ...first }, skipUserInfo: true })
      )
      const callbackUrl = new URL(
        id === 'missing-popup-state'
          ? url()
          : url(id === 'unknown-popup-state' ? 'unknown-request' : other.state.id)
      )
      callbackUrl.searchParams.set('request_type', type === 'si:r' ? 'si:p' : 'si:r')
      if (id === 'stored-redirect' || id === 'stored-silent') {
        const callbackResult = await env.operation(child.signinCallback(callbackUrl.href))
        env.assert(
          'POPUP_OTHER_TYPE_TOKEN_COUNT',
          env.receipt.tokenRequests,
          id === 'stored-redirect' ? 1 : 0
        )
        env.assert(
          'POPUP_OTHER_TYPE_RESULT',
          callbackResult === undefined ? undefined : projectMarker(callbackResult.state),
          id === 'stored-redirect' ? first : undefined
        )
        env.assert(
          'POPUP_OTHER_TYPE_NOTIFICATION_LANE',
          bridge.lanes,
          id === 'stored-silent' ? ['parent'] : []
        )
      } else {
        env.assert(
          'POPUP_INVALID_CALLBACK_REFUSED',
          await rejected(env.operation(child.signinCallback(callbackUrl.href))),
          id === 'stored-unknown'
            ? 'invalid request_type in state'
            : id === 'missing-popup-state'
              ? 'No state in response'
              : 'No matching state found in storage'
        )
        env.assert('POPUP_INVALID_NO_EXCHANGE', env.receipt.tokenRequests, 0)
        env.assert('POPUP_INVALID_NO_NOTIFICATION', bridge.notifications.length, 0)
      }
      env.assert('POPUP_OTHER_TYPE_PARENT_PENDING', result.settled, false)
      env.assert('POPUP_OTHER_TYPE_NO_PARENT_USER', event.count, 0)
      return
    }

    if (id === 'same-source-unknown-state') {
      bridge.deliver({ source: 'oidc-client', url: url('unknown-request'), keepOpen: false })
      await completion
      env.assert(
        'POPUP_UNKNOWN_PARENT_STATE_REFUSED',
        message(result.error),
        'No matching state found in storage'
      )
      env.assert('POPUP_UNKNOWN_PARENT_NO_EXCHANGE', env.receipt.tokenRequests, 0)
      env.assert('POPUP_UNKNOWN_PARENT_NO_USER', event.count, 0)
      return
    }

    const other =
      id === 'same-source-other-state'
        ? await env.operation(
            client.createSigninRequest({
              request_type: 'si:p',
              state: { ...second },
              skipUserInfo: true,
            })
          )
        : undefined
    let callbackUrl = url(other?.state.id ?? state)
    if (id === 'stored-popup') {
      const conflicting = new URL(callbackUrl)
      conflicting.searchParams.set('request_type', 'si:r')
      callbackUrl = conflicting.href
    }
    const callbackResult = await env.operation(child.signinCallback(callbackUrl))
    if (id === 'stored-popup') env.prerequisite('popup-child-completed')
    env.assert('POPUP_CALLBACK_CHILD_TOKEN_COUNT', env.receipt.tokenRequests, 0)
    env.assert('POPUP_CALLBACK_UNDEFINED', callbackResult, undefined)
    env.assert('POPUP_CALLBACK_NOTIFICATION', bridge.notifications.length, 1)
    env.assert('POPUP_CALLBACK_OPENER_LANE', bridge.lanes, ['opener'])
    env.assert(
      'POPUP_CHILD_CALLBACK_RETAINS_STATE',
      typeof (await store.get(other?.state.id ?? state)),
      'string'
    )
    const notification = bridge.notifications[0]
    if (!notification) fail('POPUP_NOTIFICATION_MISSING')

    if (id === 'abort-late-popup') {
      controller.abort('contract-popup-aborted')
      await completion
      env.assert('POPUP_PUBLIC_ABORT', message(result.error), 'contract-popup-aborted')
      env.assert(
        'POPUP_LATE_CHILD_RESULT',
        await env.operation(child.signinCallback(callbackUrl)),
        undefined
      )
      env.assert('POPUP_LATE_CHILD_NOTIFIES', bridge.notifications.length, 2)
      for (const pending of bridge.notifications) bridge.deliver(pending)
      await bridge.turn()
      env.assert('POPUP_ABORT_NO_EXCHANGE', env.receipt.tokenRequests, 0)
      env.assert('POPUP_ABORT_NO_USER', event.count, 0)
      env.assert('POPUP_ABORT_SETTLES_ONCE', result.count, 1)
      return
    }

    if (id === 'duplicate-popup') {
      env.assert(
        'POPUP_DUPLICATE_CHILD_RESULT',
        await env.operation(child.signinCallback(callbackUrl)),
        undefined
      )
      env.assert('POPUP_DUPLICATE_NOTIFICATIONS', bridge.notifications.length, 2)
      env.assert('POPUP_CHILD_INSPECTION_RETAINS_STATE', typeof (await store.get(state)), 'string')
    }
    if (id === 'wrong-origin') {
      bridge.deliver(notification, 'https://wrong-origin.example.test')
      env.prerequisite('popup-wrong-origin-delivered')
    } else if (id === 'wrong-message-tag') {
      bridge.deliver({ ...notification, source: 'unexpected' })
    } else if (id === 'wrong-source-state') {
      bridge.deliver({ ...notification, url: url('unknown-request') }, popupOrigin, {})
    } else {
      for (const pending of bridge.notifications)
        bridge.deliver(
          pending,
          popupOrigin,
          id === 'matching-state-other-source' ? null : bridge.child,
          id === 'matching-state-other-source'
        )
    }

    if (['wrong-origin', 'wrong-message-tag', 'wrong-source-state'].includes(id)) {
      await bridge.turn()
      if (id === 'wrong-origin') {
        env.prerequisite('popup-owned-turn')
        if (bridge.listeners.size === 0 && bridge.channels.size === 0) await completion
      }
      env.assert(
        id === 'wrong-origin' ? 'POPUP_WRONG_ORIGIN_NO_EXCHANGE' : 'POPUP_UNSOLICITED_NO_EXCHANGE',
        env.receipt.tokenRequests,
        0
      )
      env.assert('POPUP_UNSOLICITED_PARENT_PENDING', result.settled, false)
      env.assert('POPUP_UNSOLICITED_NO_USER', event.count, 0)
      if (id === 'wrong-origin')
        env.assert(
          'POPUP_WRONG_ORIGIN_RECEIVERS_LIVE',
          {
            window: bridge.listeners.size,
            channels: bridge.channels.size,
            closed: bridge.child.closed,
          },
          { window: 1, channels: 1, closed: false }
        )
      return
    }
    if (id === 'user-loaded-order') {
      await env.operation(loaded.promise)
      env.assert('POPUP_EVENT_ORIGINAL_MARKER', projectMarker(event.user?.state), first)
      env.prerequisite('popup-user-loaded-original')
      await bridge.turn()
      env.prerequisite('popup-owned-turn')
      env.assert('POPUP_PARENT_PENDING_DURING_USER_LOADED', result.settled, false)
      releaseLoaded.release()
    }
    await completion
    env.assert('POPUP_PARENT_NO_ERROR', result.error, undefined)
    env.assert('POPUP_PARENT_MARKER', projectMarker(result.user?.state), other ? second : first)
    env.assert(
      'POPUP_PARENT_EVENT_MARKER',
      projectMarker(event.user?.state),
      other ? second : first
    )
    env.assert('POPUP_PARENT_EXCHANGES_ONCE', env.receipt.tokenRequests, 1)
    env.assert(
      'POPUP_PARENT_SETTLES_ONCE',
      { settled: result.count, loaded: event.count },
      { settled: 1, loaded: 1 }
    )
    env.assert('POPUP_PARENT_STATE_CONSUMED', await store.get(other?.state.id ?? state), undefined)
    if (other)
      env.assert('POPUP_ORIGINAL_STATE_RETAINED', typeof (await store.get(state)), 'string')
    if (id === 'duplicate-popup') {
      env.assert(
        'POPUP_CONSUMED_REPLAY_REFUSED',
        await rejected(env.operation(child.signinCallback(callbackUrl))),
        'No matching state found in storage'
      )
      env.assert('POPUP_REPLAY_NO_NOTIFICATION', bridge.notifications.length, 2)
      env.assert('POPUP_REPLAY_NO_EXCHANGE', env.receipt.tokenRequests, 1)
    }
  } finally {
    releaseLoaded.release()
    if (!result.settled) controller.abort('contract-popup-aborted')
    try {
      await bounded(completion, 1000, env)
      env.controllers.delete(controller)
      env.assert(
        'POPUP_TERMINAL_RECEIVERS',
        { window: bridge.listeners.size, channels: bridge.channels.size },
        { window: 0, channels: 0 }
      )
      env.assert('POPUP_NO_DISCOVERY_REQUEST', env.receipt.discoveryRequests, 0)
      parent.events.removeUserLoaded(observeLoaded)
    } catch (error) {
      env.cleanup.push(error)
    }
  }
}

const targets: Record<
  SdkVariant,
  { id: SdkCase; marker: string; expected: unknown; wrong: unknown; prerequisites: string[] }
> = {
  S01: {
    id: 'inspect-preserved',
    marker: 'SDK_INSPECTION_PRESERVES_REQUEST',
    expected: { retained: true, removeCalls: 0 },
    wrong: { retained: false, removeCalls: 1 },
    prerequisites: ['stored-request', 'first-inspection-matches'],
  },
  S02: {
    id: 'explicit-remove',
    marker: 'SDK_EXPLICIT_REMOVAL_CONSUMES_REQUEST',
    expected: true,
    wrong: false,
    prerequisites: ['stored-request', 'first-inspection-matches', 'explicit-read-returns-request'],
  },
  S03: {
    id: 'round-trip',
    marker: 'SDK_USER_STATE_ROUND_TRIP',
    expected: first,
    wrong: undefined,
    prerequisites: ['stored-request', 'first-inspection-matches', 'interactive-returned-one-token'],
  },
  S04: {
    id: 'authority-mismatch',
    marker: 'SDK_AUTHORITY_MISMATCH_PRE_EXCHANGE',
    expected: { error: 'authority mismatch on settings vs. signin state', tokenRequests: 0 },
    wrong: { error: null, tokenRequests: 1 },
    prerequisites: [
      'stored-request',
      'first-inspection-matches',
      'wrong-config-original-request-same-metadata',
    ],
  },
  S05: {
    id: 'client-mismatch',
    marker: 'SDK_CLIENT_MISMATCH_PRE_EXCHANGE',
    expected: { error: 'client_id mismatch on settings vs. signin state', tokenRequests: 0 },
    wrong: { error: null, tokenRequests: 1 },
    prerequisites: [
      'stored-request',
      'first-inspection-matches',
      'wrong-config-original-request-same-metadata',
    ],
  },
}
function classify(
  outcome: Outcome,
  id: SdkVariant,
  target: Pick<
    (typeof targets)[SdkVariant],
    'marker' | 'expected' | 'wrong' | 'prerequisites'
  > = targets[id]
): Reason {
  if (outcome.effects.length) return 'sticky-effect'
  if (outcome.cleanup.length) return 'cleanup-failed'
  if (outcome.residualTimers) return 'residual-timer'
  if (outcome.late) return 'late-work'
  if (outcome.unsettled) return 'unsettled-operation'
  if (outcome.deadline) return 'deadline'
  if (outcome.primary === undefined) return 'missing-refusal'
  if (!outcome.tag)
    return typeof outcome.primary === 'object' &&
      outcome.primary !== null &&
      knownHostErrors.has(outcome.primary)
      ? 'untagged-host-error'
      : 'untagged-sdk-error'
  if (outcome.tag.marker !== target.marker) return 'wrong-marker'
  if (
    !isDeepStrictEqual(outcome.tag.expected, target.expected) ||
    !isDeepStrictEqual(outcome.tag.actual, target.wrong) ||
    !isDeepStrictEqual(outcome.tag.prerequisites, target.prerequisites)
  )
    return 'wrong-operands'
  return 'qualified'
}
async function drain(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let handle: TimerHandle | undefined
  const stop = new Promise<void>((resolvePromise) => {
    handle = nodeSetTimeout(resolvePromise, milliseconds)
  })
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined
      ),
      stop,
    ])
  } finally {
    if (handle) nodeClearTimeout(handle)
  }
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, env: Environment): Promise<T> {
  let handle: TimerHandle | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = nodeSetTimeout(() => {
      env.deadline = true
      reject(new Error('SDK_PROBE_DEADLINE'))
    }, milliseconds)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (handle) nodeClearTimeout(handle)
  }
}
function finish(outcome: Outcome): CanonicalReceipt {
  const failures: unknown[] = []
  if (outcome.primary !== undefined) failures.push(outcome.primary)
  if (outcome.effects.length)
    failures.push(new Error(`SDK_STICKY_EFFECT:${outcome.effects.join(',')}`))
  failures.push(...outcome.cleanup)
  if (outcome.residualTimers) failures.push(new Error('SDK_RESIDUAL_TIMER'))
  failures.push(...outcome.lateErrors)
  if (outcome.late) failures.push(new Error('SDK_LATE_WORK'))
  if (outcome.unsettled) failures.push(new Error('SDK_UNSETTLED_OPERATION'))
  if (outcome.deadline) failures.push(new Error('SDK_PROBE_DEADLINE'))
  if (failures.length)
    throw new AggregateError(failures, 'SDK canonical operation or owned cleanup failed')
  return outcome.receipt
}
async function execute(
  id: SdkCase | PopupCase,
  supplied: SdkNamespace | Sources
): Promise<Outcome> {
  const env = new Environment(id)
  const popup = popupCases.find((candidate) => candidate === id)
  if (popup) env.popup = new PopupBridge(env, popup)
  let primary: unknown
  let tag: Checkpoint | undefined
  let residual = 0
  let unsettled = 0
  try {
    env.install()
    await owners.run(env, async () => {
      const sdk = namespace(supplied) ? supplied : memoryNamespace(supplied, env)
      const root = env.operation(
        popup ? popupCanonical(sdk, popup, env) : canonical(sdk, id as SdkCase, env)
      )
      await bounded(root, 2000, env)
    })
  } catch (error) {
    primary = error
    if (typeof error === 'object' && error !== null) tag = env.tags.get(error)
  } finally {
    try {
      const disposed = await owners.run(env, () => env.dispose())
      residual = disposed.residual
      unsettled = disposed.unsettled
    } catch (error) {
      env.cleanup.push(error)
    }
  }
  return {
    receipt: env.receipt,
    primary,
    tag,
    effects: [...env.effects],
    cleanup: [...env.cleanup],
    residualTimers: residual,
    late: env.late,
    lateErrors: [...env.lateErrors],
    unsettled,
    deadline: env.deadline,
  }
}
export async function runCanonicalCase(sdk: SdkNamespace, id: SdkCase): Promise<CanonicalReceipt> {
  if (!namespace(sdk)) fail('SDK_EXPORT_SHAPE')
  const sources = readSources()
  const imported = finish(await execute(id, sdk))
  // SAME canonical function, with a fresh VM and actual converted dependencies.
  finish(await execute(id, sources))
  readSources()
  return imported
}
async function completeCampaignProbe(
  probe: Promise<unknown>,
  deadline: number,
  completionAt: () => number = Date.now
): Promise<void> {
  await probe
  if (completionAt() >= deadline) fail('SDK_CAMPAIGN_DEADLINE')
}
export async function proveMemoryVariant(id: SdkVariant, sdk: SdkNamespace): Promise<void> {
  const campaignDeadline = Date.now() + 20000
  const pristine = readSources()
  const target = targets[id]
  if (!namespace(sdk)) fail('SDK_EXPORT_SHAPE')
  finish(await execute(target.id, sdk))
  finish(await execute(target.id, pristine))
  if (Date.now() >= campaignDeadline) fail('SDK_CAMPAIGN_DEADLINE')
  const changed = { sdk: variant(pristine.sdk, id), jwt: pristine.jwt }
  // Effect/resource validation is part of classify, outside the intended matcher catch in execute.
  const observed = await execute(target.id, changed)
  expect(classify(observed, id), `SDK_VARIANT_${id}_EXACT_HOST_MATCHER`).toBe('qualified')
  expect(sha(pristine.sdk)).toBe(sourcePins.sdk)
  expect(sha(pristine.jwt)).toBe(sourcePins.jwt)
  if (Date.now() >= campaignDeadline) fail('SDK_CAMPAIGN_DEADLINE')
  return completeCampaignProbe(execute(target.id, readSources()).then(finish), campaignDeadline)
}

const popupTargets: Record<
  PopupVariant,
  { id: PopupCase; marker: string; expected: unknown; wrong: unknown; prerequisites: string[] }
> = {
  P01: {
    id: 'stored-popup',
    marker: 'POPUP_CALLBACK_CHILD_TOKEN_COUNT',
    expected: 0,
    wrong: 1,
    prerequisites: ['popup-stored-si:p', 'popup-receiver-ready', 'popup-child-completed'],
  },
  P02: {
    id: 'user-loaded-order',
    marker: 'POPUP_PARENT_PENDING_DURING_USER_LOADED',
    expected: false,
    wrong: true,
    prerequisites: [
      'popup-stored-si:p',
      'popup-receiver-ready',
      'popup-user-loaded-original',
      'popup-owned-turn',
    ],
  },
  P03: {
    id: 'wrong-origin',
    marker: 'POPUP_WRONG_ORIGIN_NO_EXCHANGE',
    expected: 0,
    wrong: 1,
    prerequisites: [
      'popup-stored-si:p',
      'popup-receiver-ready',
      'popup-wrong-origin-delivered',
      'popup-owned-turn',
    ],
  },
}
function popupVariant(source: string, id: PopupVariant): string {
  if (id === 'P01')
    return replaceUnique(
      source,
      '  async signinCallback(url = window.location.href) {',
      '  async signoutCallback(',
      '      case "si:p":\n        await this.signinPopupCallback(url);\n        break;\n',
      '      case "si:p":\n        return await this.signinRedirectCallback(url);\n'
    )
  if (id === 'P02')
    return replaceUnique(
      source,
      '  async _buildUser(signinResponse, verifySub) {',
      '  async signoutRedirect(',
      '    await this._events.load(user);\n',
      '    void this._events.load(user);\n'
    )
  return replaceUnique(
    source,
    'var AbstractChildWindow = class {',
    '// src/UserManagerSettings.ts',
    'e.origin !== origin || ',
    ''
  )
}
export async function runPopupCase(sdk: SdkNamespace, id: PopupCase): Promise<void> {
  if (!namespace(sdk)) fail('SDK_EXPORT_SHAPE')
  const sources = readSources()
  finish(await execute(id, sdk))
  finish(await execute(id, sources))
  readSources()
}
export async function provePopupVariant(sdk: SdkNamespace, id: PopupVariant): Promise<void> {
  const deadline = Date.now() + 20000
  if (!namespace(sdk)) fail('SDK_EXPORT_SHAPE')
  const pristine = readSources()
  const target = popupTargets[id]
  finish(await execute(target.id, sdk))
  finish(await execute(target.id, pristine))
  if (Date.now() >= deadline) fail('SDK_CAMPAIGN_DEADLINE')
  const observed = await execute(target.id, {
    sdk: popupVariant(pristine.sdk, id),
    jwt: pristine.jwt,
  })
  expect(classify(observed, 'S01', target), `POPUP_VARIANT_${id}_EXACT_HOST_MATCHER`).toBe(
    'qualified'
  )
  pinned('sdk', pristine.sdk)
  pinned('jwt', pristine.jwt)
  await completeCampaignProbe(execute(target.id, readSources()).then(finish), deadline)
}
async function popupBridgeRefusal(
  kind: 'extra-open' | 'channel' | 'event' | 'receiver' | 'unsettled'
): Promise<Outcome> {
  const env = new Environment('stored-popup')
  const bridge = new PopupBridge(env, 'stored-popup')
  env.popup = bridge
  const release = popupLatch<void>()
  let primary: unknown
  let tag: Checkpoint | undefined
  let disposed = { residual: 0, unsettled: 0 }
  try {
    env.install()
    await owners.run(env, async () => {
      for (const name of popupTargets.P01.prerequisites) env.prerequisite(name)
      try {
        if (kind === 'extra-open') {
          const features =
            'location=no,toolbar=no,height=640,closePopupWindowAfterInSeconds=-1,width=480,left=0,top=0'
          bridge.open(undefined, 'sdk-popup-contract', features)
          bridge.open(undefined, 'sdk-popup-contract', features)
        }
        if (kind === 'channel') {
          const Channel = bridge.channelType()
          new Channel('unexpected-channel')
        }
        if (kind === 'event') bridge.add('resize', () => undefined, false)
      } catch {
        env.assert('POPUP_SUPPORT_STICKY_RECORDED', env.effects.length, 1)
      }
      if (kind === 'receiver') bridge.add('message', () => undefined, false)
      if (kind === 'unsettled') void env.operation(release.promise)
      env.assert(popupTargets.P01.marker, popupTargets.P01.wrong, popupTargets.P01.expected)
    })
  } catch (error) {
    primary = error
    if (typeof error === 'object' && error !== null) tag = env.tags.get(error)
  } finally {
    try {
      disposed = await owners.run(env, () => env.dispose())
      if (kind === 'unsettled') {
        expect(active.owner === env, 'POPUP_UNSETTLED_RETAINS_OWNER').toBe(true)
        expect(env.restore.length > 0, 'POPUP_UNSETTLED_RETAINS_PATCHES').toBe(true)
      }
    } catch (error) {
      env.cleanup.push(error)
    }
    release.release()
    await Promise.allSettled([...env.pending])
    await env.dispose()
  }
  return {
    receipt: env.receipt,
    primary,
    tag,
    effects: [...env.effects],
    cleanup: [...env.cleanup],
    residualTimers: disposed.residual,
    late: env.late,
    lateErrors: [...env.lateErrors],
    unsettled: disposed.unsettled,
    deadline: env.deadline,
  }
}
export async function provePopupBridgeRefusals(): Promise<void> {
  const deadline = Date.now() + 20000
  const sources = readSources()
  for (const kind of ['extra-open', 'channel', 'event', 'receiver', 'unsettled'] as const) {
    const observed = await popupBridgeRefusal(kind)
    expect(classify(observed, 'S01', popupTargets.P01), `POPUP_SUPPORT_REFUSES:${kind}`).toBe(
      kind === 'receiver'
        ? 'cleanup-failed'
        : kind === 'unsettled'
          ? 'unsettled-operation'
          : 'sticky-effect'
    )
    await completeCampaignProbe(execute('stored-popup', sources).then(finish), deadline)
  }
  let events = 0
  const listener = () => {
    events += 1
  }
  const timer = nodeSetInterval(() => undefined, 60000)
  const remove = window.removeEventListener.bind(window)
  window.addEventListener('popup-contract-foreign-canary', listener)
  try {
    await completeCampaignProbe(execute('stored-popup', sources).then(finish), deadline)
    window.dispatchEvent(new Event('popup-contract-foreign-canary'))
    expect(events, 'POPUP_FOREIGN_LISTENER_PRESERVED').toBe(1)
    expect(timer.hasRef(), 'POPUP_FOREIGN_TIMER_PRESERVED').toBe(true)
  } finally {
    remove('popup-contract-foreign-canary', listener)
    nodeClearInterval(timer)
  }
  readSources()
}

async function classifierFixture(
  marker: string,
  actual: unknown,
  expected: unknown
): Promise<Outcome> {
  const env = new Environment('inspect-preserved')
  let primary: unknown
  let tag: Checkpoint | undefined
  for (const name of targets.S01.prerequisites) env.prerequisite(name)
  try {
    env.assert(marker, actual, expected)
  } catch (error) {
    primary = error
    if (typeof error === 'object' && error !== null) tag = env.tags.get(error)
  }
  const disposed = await env.dispose()
  return {
    receipt: env.receipt,
    primary,
    tag,
    effects: [...env.effects],
    cleanup: [...env.cleanup],
    residualTimers: disposed.residual,
    late: env.late,
    lateErrors: [...env.lateErrors],
    unsettled: disposed.unsettled,
    deadline: env.deadline,
  }
}
async function resourceFixture(
  kind: 'sticky-effect' | 'residual-timer' | 'late-work' | 'unsettled-operation'
): Promise<Outcome> {
  const env = new Environment('inspect-preserved')
  let primary: unknown
  let tag: Checkpoint | undefined
  const release: { complete?: () => void } = {}
  for (const name of targets.S01.prerequisites) env.prerequisite(name)
  try {
    env.install()
    await owners.run(env, async () => {
      if (kind === 'sticky-effect') {
        try {
          await env.fetch('https://unexpected.example.test/never')
        } catch {
          /* Sticky ledger must survive wrapping. */
        }
      }
      if (kind === 'residual-timer') env.schedule(() => undefined, 60000, [], true)
      if (kind === 'late-work') {
        const observed = new Promise<void>((resolvePromise) => {
          env.callbackObserved = resolvePromise
        })
        env.schedule(() => undefined, 0, [], false)
        env.closed = true
        await bounded(observed, 2000, env)
      }
      if (kind === 'unsettled-operation') {
        const controller = new AbortController()
        env.controllers.add(controller)
        const promise = new Promise<void>((resolvePromise) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              env.controllers.delete(controller)
              release.complete = resolvePromise
            },
            { once: true }
          )
        })
        void env.operation(promise)
      }
      env.assert(targets.S01.marker, targets.S01.wrong, targets.S01.expected)
    })
  } catch (error) {
    primary = error
    if (typeof error === 'object' && error !== null) tag = env.tags.get(error)
  }
  let disposed = { residual: 0, unsettled: 0 }
  try {
    disposed = await owners.run(env, () => env.dispose())
  } catch (error) {
    env.cleanup.push(error)
  }
  if (release.complete) {
    release.complete()
    await Promise.allSettled([...env.pending])
    try {
      await env.dispose()
    } catch (error) {
      env.cleanup.push(error)
    }
  }
  return {
    receipt: env.receipt,
    primary,
    tag,
    effects: [...env.effects],
    cleanup: [...env.cleanup],
    residualTimers: disposed.residual,
    late: env.late,
    lateErrors: [...env.lateErrors],
    unsettled: disposed.unsettled,
    deadline: env.deadline,
  }
}
export async function proveSupportRefusals(): Promise<void> {
  const campaignDeadline = Date.now() + 20000
  const sources = readSources()
  async function pristine(): Promise<void> {
    if (Date.now() >= campaignDeadline) fail('SDK_CAMPAIGN_DEADLINE')
    finish(await execute('inspect-preserved', sources))
  }
  await pristine()
  const controls: [string, () => void][] = [
    ['SDK_SOURCE_PIN_MISMATCH:sdk', () => pinned('sdk', `${sources.sdk}\n`)],
    ['SDK_SOURCE_PIN_MISMATCH:jwt', () => pinned('jwt', `${sources.jwt}\n`)],
    ['SDK_DEPENDENCY_REFUSED', () => sourceGrammar(`${sources.sdk}\nimport 'unexpected';`, 'sdk')],
    [
      'SDK_DYNAMIC_IMPORT_REFUSED',
      () => sourceGrammar(`${sources.sdk}\nimport('unexpected');`, 'sdk'),
    ],
    ['SDK_IMPORT_META_REFUSED', () => sourceGrammar(`${sources.sdk}\nimport.meta.url;`, 'sdk')],
    [
      'SDK_ANCHOR_COUNT',
      () => replaceUnique(sources.sdk, 'absent-method', 'absent-end', 'absent', ''),
    ],
    [
      'SDK_ANCHOR_COUNT',
      () => replaceUnique('start needle needle end', 'start', 'end', 'needle', ''),
    ],
    [
      'SDK_CONVERSION_REFUSED',
      () =>
        output('', [
          {
            category: ts.DiagnosticCategory.Error,
            code: 1,
            messageText: 'synthetic conversion refusal',
            file: undefined,
            start: undefined,
            length: undefined,
          },
        ]),
    ],
    [
      'SDK_EXPORT_SHAPE',
      () => {
        if (!namespace({ Version: '3.5.0' })) fail('SDK_EXPORT_SHAPE')
      },
    ],
    [
      'SDK_EXPORT_SHAPE',
      () => {
        const incomplete = {
          Version: '3.5.0',
          OidcClient: class {},
          UserManager: class {},
          WebStorageStateStore: class {},
          InMemoryWebStorage: class {},
        }
        if (!namespace(incomplete)) fail('SDK_EXPORT_SHAPE')
      },
    ],
    ['SDK_SOURCE_BYTE_CAP:sdk', () => cap('sdk', 'x'.repeat(caps.sdk + 1))],
    ['SDK_SOURCE_BYTE_CAP:jwt', () => cap('jwt', 'x'.repeat(caps.jwt + 1))],
    ['SDK_OUTPUT_BYTE_CAP', () => output('x'.repeat(caps.output + 1), [])],
  ]
  for (const [expected, invoke] of controls) {
    let failure: unknown
    try {
      invoke()
    } catch (error) {
      failure = error
    }
    expect(message(failure), `SDK_SUPPORT_REFUSAL:${expected}`).toBe(expected)
    await pristine()
  }
  cap('sdk', 'x'.repeat(caps.sdk))
  cap('jwt', 'x'.repeat(caps.jwt))
  expect(output('x'.repeat(caps.output), []).length).toBe(caps.output)
  await pristine()
  const target = targets.S01
  const tagged = await classifierFixture(target.marker, target.wrong, target.expected)
  expect(classify(tagged, 'S01')).toBe('qualified')
  await pristine()
  const foreignError: unknown = new Script(
    'new Error("SDK_INSPECTION_PRESERVES_REQUEST")'
  ).runInNewContext(Object.create(null), { timeout: 500 })
  const refused: [Reason, Outcome][] = [
    ['untagged-sdk-error', { ...tagged, primary: foreignError, tag: undefined }],
    ['untagged-host-error', { ...tagged, primary: hostError(target.marker), tag: undefined }],
    ['wrong-marker', await classifierFixture('WRONG_MARKER', target.wrong, target.expected)],
    [
      'wrong-operands',
      await classifierFixture(target.marker, { retained: false, removeCalls: 2 }, target.expected),
    ],
    ['missing-refusal', await classifierFixture(target.marker, target.expected, target.expected)],
    ['cleanup-failed', { ...tagged, cleanup: [new Error('synthetic cleanup failure')] }],
    ['deadline', { ...tagged, deadline: true }],
  ]
  for (const [reason, observed] of refused) {
    expect(classify(observed, 'S01'), `SDK_CLASSIFIER_REFUSES:${reason}`).toBe(reason)
    await pristine()
  }
  for (const reason of [
    'sticky-effect',
    'residual-timer',
    'late-work',
    'unsettled-operation',
  ] as const) {
    expect(classify(await resourceFixture(reason), 'S01'), `SDK_RESOURCE_REFUSES:${reason}`).toBe(
      reason
    )
    await pristine()
  }
  // Foreign canaries are created outside the SDK owner and cleaned only by this control.
  let foreignTimer: TimerHandle | undefined
  const canaryKey = 'sdk-contract.foreign-canary'
  let previous: string | null | undefined
  let events = 0
  let listenerInstalled = false
  const listener = () => {
    events += 1
  }
  let canaryFailure: unknown
  const canaryCleanup: unknown[] = []
  let env: Environment | undefined
  try {
    previous = sessionStorage.getItem(canaryKey)
    foreignTimer = nodeSetInterval(() => undefined, 60000)
    window.addEventListener('sdk-contract-canary', listener)
    listenerInstalled = true
    sessionStorage.setItem(canaryKey, 'foreign')
    env = new Environment('inspect-preserved')
    env.install()
    expect(() => new Environment('inspect-preserved')).toThrow('SDK_INVOCATION_OVERLAP')
    expect(await env.dispose()).toEqual({ residual: 0, unsettled: 0 })
    expect(env.cleanup).toEqual([])
    expect(env.effects).toEqual([])
    const closed = env
    expect(() => closed.open()).toThrow('SDK_INVOCATION_CLOSED')
    expect(await env.dispose()).toEqual({ residual: 0, unsettled: 0 })
    expect(foreignTimer.hasRef()).toBe(true)
    expect(sessionStorage.getItem(canaryKey)).toBe('foreign')
    window.dispatchEvent(new Event('sdk-contract-canary'))
    expect(events).toBe(1)
  } catch (error) {
    canaryFailure = error
  } finally {
    try {
      if (env) await env.dispose()
    } catch (error) {
      canaryCleanup.push(error)
    }
    try {
      if (foreignTimer) nodeClearInterval(foreignTimer)
    } catch (error) {
      canaryCleanup.push(error)
    }
    try {
      if (listenerInstalled) window.removeEventListener('sdk-contract-canary', listener)
    } catch (error) {
      canaryCleanup.push(error)
    }
    try {
      if (previous === null) sessionStorage.removeItem(canaryKey)
      else if (previous !== undefined) sessionStorage.setItem(canaryKey, previous)
    } catch (error) {
      canaryCleanup.push(error)
    }
  }
  if (canaryFailure !== undefined || canaryCleanup.length)
    throw new AggregateError(
      [canaryFailure, ...canaryCleanup].filter((error) => error !== undefined),
      'Foreign canary or owned cleanup failed'
    )
  for (const completedAt of [100, 101]) {
    let completed = false
    let sampled = false
    let failure: unknown
    const probe = Promise.resolve().then(() => {
      completed = true
    })
    try {
      await completeCampaignProbe(probe, 100, () => {
        if (!completed) fail('SDK_COMPLETION_READ_TOO_EARLY')
        sampled = true
        return completedAt
      })
    } catch (error) {
      failure = error
    }
    expect({ completed, sampled, error: message(failure) }, 'SDK_LATE_COMPLETION_REFUSED').toEqual({
      completed: true,
      sampled: true,
      error: 'SDK_CAMPAIGN_DEADLINE',
    })
    await completeCampaignProbe(pristine(), 100, () => 99)
  }
  return completeCampaignProbe(pristine(), campaignDeadline)
}
