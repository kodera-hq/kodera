export type CoordinatorFixtureVariant = 'canonical' | 'per-port-spent' | 'hydrate-replay'

export interface NativeCapabilityReply {
  protocol: 'test-v1'
  id: number
  op: 'hello' | 'prepare' | 'take' | 'close'
  status: 'hello' | 'prepared' | 'taken' | 'refused' | 'closing'
  instance: string
  port: number
  armPresent: boolean
  arm?: string
}

export interface NativeCapabilityClient {
  connect(name: string): Promise<NativeCapabilityReply>
  prepare(): Promise<NativeCapabilityReply>
  take(): Promise<NativeCapabilityReply>
  closeWorker(): Promise<NativeCapabilityReply>
  replay(marker: string): Promise<NativeCapabilityReply>
  inspect(): {
    initialMarker: string | null
    currentMarker: string | null
    pending: number
    errors: string[]
    constructors: { url: string; name: string; type: string; credentials: string }[]
    transcript: unknown[]
    profile: {
      userAgent: string
      language: string
      colorScheme: string
      timezone: string
      viewport: { width: number; height: number }
      devicePixelRatio: number
      maxTouchPoints: number
      secureContext: boolean
    }
  }
  dispose(contamination?: 'FORCED_DISPOSE_ERROR'): void
}

const client = String.raw`
'use strict';
const signature = 'W03_NATIVE_COORDINATOR_FIXTURE_ONLY';
const markerName = 'kodera.test.owner-claim.arm.v1';
const initialMarker = sessionStorage.getItem(markerName);
const connections = [];
const constructors = [];
const errors = [];
const transcript = [];
let current;
let disposed = false;
function record(value) {
  if (transcript.length >= 64) {
    errors.push('TRANSCRIPT_CAP');
    throw Error('TRANSCRIPT_CAP');
  }
  transcript.push(value);
}
function fail(message) {
  errors.push(message);
}
function send(connection, op, marker) {
  if (disposed || !connection) return Promise.reject(Error('CLIENT_NOT_CONNECTED'));
  const id = ++connection.nextId;
  const command = { id, op };
  if (op === 'take') command.marker = marker;
  record({ kind: 'send', op, id });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      fail('RPC_TIMEOUT');
      reject(Error('RPC_TIMEOUT'));
    }, 5000);
    connection.pending.set(id, { resolve, reject, timer, op });
    try { connection.worker.port.postMessage(command); }
    catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      fail('POST_MESSAGE_FAILED');
      reject(error);
    }
  });
}
function marker() {
  const stored = sessionStorage.getItem(markerName);
  return stored === null ? null : JSON.parse(stored);
}
const api = {
  async connect(name) {
    if (disposed || typeof name !== 'string' || name.length > 96) throw Error('CONNECT_ARGUMENT');
    const options = { name, type: 'classic', credentials: 'same-origin' };
    constructors.push({ url: '/owner-claim-coordinator.js', ...options });
    const worker = new SharedWorker('/owner-claim-coordinator.js', options);
    const connection = { worker, pending: new Map(), nextId: 0 };
    connections.push(connection);
    current = connection;
    worker.onerror = () => fail('WORKER_ERROR');
    worker.port.onmessageerror = () => fail('PORT_MESSAGE_ERROR');
    worker.port.onmessage = (event) => {
      const reply = event.data;
      if (!reply || reply.protocol !== 'test-v1' || !Number.isSafeInteger(reply.id) ||
          typeof reply.instance !== 'string' || !Number.isSafeInteger(reply.port) ||
          typeof reply.armPresent !== 'boolean') {
        fail('REPLY_SHAPE');
        return;
      }
      const pending = connection.pending.get(reply.id);
      if (!pending || pending.op !== reply.op) {
        fail('UNEXPECTED_REPLY');
        return;
      }
      connection.pending.delete(reply.id);
      clearTimeout(pending.timer);
      record({ kind: 'reply', ...reply });
      pending.resolve(reply);
    };
    worker.port.start();
    return send(connection, 'hello');
  },
  async prepare() {
    const reply = await send(current, 'prepare');
    if (reply.status === 'prepared') {
      sessionStorage.setItem(markerName, JSON.stringify({ protocol: 'test-v1', instance: reply.instance, arm: reply.arm }));
      record({ kind: 'marker-written' });
    }
    return reply;
  },
  take() { return send(current, 'take', marker()); },
  closeWorker() { return send(current, 'close'); },
  replay(oldMarker) {
    sessionStorage.setItem(markerName, oldMarker);
    record({ kind: 'synthetic-marker-replay' });
    return api.take();
  },
  inspect() {
    return { signature, initialMarker, currentMarker: sessionStorage.getItem(markerName),
      pending: connections.reduce((count, connection) => count + connection.pending.size, 0),
      errors: [...errors], constructors: [...constructors], transcript: [...transcript],
      profile: { userAgent: navigator.userAgent, language: navigator.language,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints, secureContext: isSecureContext } };
  },
  dispose(contamination) {
    if (contamination !== undefined && contamination !== 'FORCED_DISPOSE_ERROR') throw Error('INVALID_DISPOSE_INPUT');
    disposed = true;
    for (const connection of connections) {
      if (connection.pending.size > 0) fail('DISPOSE_UNSETTLED');
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error('CLIENT_DISPOSED'));
      }
      connection.pending.clear();
      connection.worker.onerror = null;
      connection.worker.port.onmessage = null;
      connection.worker.port.onmessageerror = null;
      connection.worker.port.close();
    }
    for (const [button, handler] of handlers) button.removeEventListener('click', handler);
    if (contamination === 'FORCED_DISPOSE_ERROR') fail('FORCED_DISPOSE_ERROR');
  }
};
const handlers = [
  [document.querySelector('#prepare'), () => { void api.prepare().catch(() => fail('PREPARE_BUTTON_FAILED')); }],
  [document.querySelector('#open'), () => { if (!window.open('/index.html', '_blank')) fail('CHILD_OPEN_FAILED'); }],
  [document.querySelector('#take'), () => { void api.take().catch(() => fail('TAKE_BUTTON_FAILED')); }]
];
for (const [button, handler] of handlers) button.addEventListener('click', handler);
window.__koderaNativeCapability = api;
`

function worker(variant: CoordinatorFixtureVariant): string {
  return String.raw`
'use strict';
const signature = 'W03_NATIVE_COORDINATOR_FIXTURE_ONLY';
const perPortSpent = ${JSON.stringify(variant === 'per-port-spent')};
const hydrateReplay = ${JSON.stringify(variant === 'hydrate-replay')};
const instance = crypto.randomUUID();
let arm = null;
let spent = false;
let portSerial = 0;
function validMarker(marker) {
  return marker !== null && typeof marker === 'object' && !Array.isArray(marker) &&
    Object.keys(marker).sort().join(',') === 'arm,instance,protocol' && marker.protocol === 'test-v1' &&
    typeof marker.instance === 'string' && marker.instance.length === 36 &&
    typeof marker.arm === 'string' && marker.arm.length === 36;
}
self.onconnect = (event) => {
  const port = event.ports[0];
  const portId = ++portSerial;
  let localSpent = false;
  port.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isSafeInteger(data.id) || data.id < 1 ||
        !['hello', 'prepare', 'take', 'close'].includes(data.op) ||
        Object.keys(data).sort().join(',') !== (data.op === 'take' ? 'id,marker,op' : 'id,op')) return;
    const reply = (status, extra = {}) => port.postMessage({ protocol: 'test-v1', id: data.id, op: data.op,
      status, instance, port: portId, armPresent: arm !== null, ...extra });
    if (data.op === 'hello') reply('hello');
    if (data.op === 'prepare') {
      if (arm !== null) reply('refused');
      else { arm = crypto.randomUUID(); reply('prepared', { arm }); }
    }
    if (data.op === 'take') {
      const candidate = data.marker;
      if (hydrateReplay && arm === null && validMarker(candidate)) {
        arm = candidate.arm;
        spent = true;
        reply('taken');
        return;
      }
      if (!validMarker(candidate) || candidate.instance !== instance || candidate.arm !== arm ||
          (perPortSpent ? localSpent : spent)) reply('refused');
      else {
        if (perPortSpent) localSpent = true;
        else spent = true;
        reply('taken');
      }
    }
    if (data.op === 'close') { reply('closing'); self.close(); }
  };
  port.start();
};
void signature;
`
}

export function coordinatorFixtureAssets(
  variant: CoordinatorFixtureVariant
): Record<string, string> {
  return {
    'index.html':
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native capability fixture</title><link rel="icon" href="/fixture-icon.svg"><script defer src="/fixture-client.js"></script></head><body><button id="prepare">Prepare arm</button><button id="open">Open prepared child</button><button id="take">Take arm</button></body></html>\n',
    'fixture-client.js': client,
    'fixture-icon.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Test fixture</title></svg>\n',
    'owner-claim-coordinator.js': worker(variant),
  }
}

export interface Rank1PageState {
  nativeInvocationOrder: number
  lockCompletionOrder: number
  adoptionOrder: number | null
  invocations: number
  responseSettled: boolean
  operationSettled: boolean
  forwardingSettled: boolean
  observerSettled: boolean
  errors: string[]
}

export interface Rank1PageClient {
  ready(): Promise<void>
  release(): void
  witness(): Promise<{
    kind: 'lock-completed' | 'response-adopted'
    invocation: number
    adoption: number | null
  }>
  inspect(): Rank1PageState
  finish(): Promise<Rank1PageState>
}

const rank1CanonicalProgram = String.raw`
(() => {
  'use strict';
  if (window.__koderaRank1 || typeof navigator.locks?.request !== 'function' || typeof fetch !== 'function') throw Error('R1_NATIVE_PREREQUISITE');
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }
  const barrier = gate();
  const ready = gate();
  const invoked = gate();
  const adopted = gate();
  const completed = gate();
  const errors = [];
  let order = 0;
  let nativeInvocationOrder = 0;
  let lockCompletionOrder = 0;
  let adoptionOrder = null;
  let invocations = 0;
  let responseSettled = false;
  let operationSettled = false;
  let forwardingSettled = false;
  let observerSettled = false;
  let responseWork = Promise.resolve();
  let forwarding = Promise.resolve();
  let forwardingReaction = Promise.resolve();
  function tick() {
    if (++order > 16) throw Error('R1_TRACE_CAP');
    return order;
  }
  function invoke() {
    const responsePromise = fetch('/fixture-icon.svg?rank1-probe=1', { method: 'GET', credentials: 'omit' });
    nativeInvocationOrder = tick();
    invocations += 1;
    invoked.release();
    responseWork = responsePromise.then(
      () => { responseSettled = true; },
      () => { responseSettled = true; errors.push('R1_RESPONSE_FAILED'); }
    );
    const responseThenable = {
      then(resolve, reject) {
        forwarding = responsePromise.then(resolve, reject);
        forwardingReaction = forwarding.catch(() => { errors.push('R1_FORWARDING_FAILED'); });
        if (adoptionOrder !== null) throw Error('R1_DUPLICATE_ADOPTION');
        adoptionOrder = tick();
        adopted.release('response-adopted');
      }
    };
    return { wrapper: { responsePromise }, responseThenable };
  }
  const callback = async lock => {
    if (!lock) throw Error('R1_LOCK_ABSENT');
    ready.release();
    await barrier.promise;
    const work = invoke();
    return work.wrapper;
  };
  const outsideDispatch = async () => {};
  const originalLockRequest = navigator.locks.request('kodera.test.owner-claim/11111111-1111-4111-8111-111111111111', { mode: 'exclusive' }, callback);
  const completion = originalLockRequest.then(() => {
    lockCompletionOrder = tick();
    completed.release('lock-completed');
  });
  const completionReaction = completion.catch(() => { errors.push('R1_LOCK_FAILED'); });
  const outside = completion.then(outsideDispatch);
  const outsideReaction = outside.catch(() => { errors.push('R1_DISPATCH_FAILED'); });
  const observation = Promise.race([completed.promise, adopted.promise]);
  function inspect() {
    return { nativeInvocationOrder, lockCompletionOrder, adoptionOrder, invocations, responseSettled, operationSettled, forwardingSettled, observerSettled, errors: [...errors] };
  }
  window.__koderaRank1 = {
    ready: () => ready.promise,
    release: () => barrier.release(),
    async witness() {
      const kind = await observation;
      await invoked.promise;
      if (kind !== 'lock-completed' && kind !== 'response-adopted') throw Error('R1_CLEANUP_NOT_WITNESS');
      return { kind, invocation: nativeInvocationOrder, adoption: adoptionOrder };
    },
    inspect,
    async finish() {
      barrier.release();
      await Promise.allSettled([outside, completion]);
      operationSettled = true;
      await Promise.allSettled([responseWork, forwarding, forwardingReaction, completionReaction, outsideReaction]);
      forwardingSettled = true;
      ready.release('cleanup-only');
      invoked.release('cleanup-only');
      adopted.release('cleanup-only');
      completed.release('cleanup-only');
      await Promise.all([adopted.promise, completed.promise, observation]);
      observerSettled = true;
      return inspect();
    }
  };
})();
`

export function rank1BrowserProgram(variant: 'canonical' | 'F1' | 'F2'): string {
  if (variant === 'canonical') return rank1CanonicalProgram
  const replace = (source: string, before: string, after: string): string => {
    if (source.split(before).length !== 2) throw Error('R1_PROGRAM_TARGET')
    return source.replace(before, after)
  }
  if (variant === 'F2')
    return replace(rank1CanonicalProgram, 'return work.wrapper;', 'return work.responseThenable;')
  if (variant !== 'F1') throw Error('R1_PROGRAM_VARIANT')
  const early = replace(
    rank1CanonicalProgram,
    '    ready.release();\n    await barrier.promise;\n    const work = invoke();\n    return work.wrapper;',
    '    return undefined;'
  )
  return replace(
    early,
    'const outsideDispatch = async () => {};',
    'const outsideDispatch = async () => { ready.release(); await barrier.promise; invoke(); };'
  )
}

export type FencingVariant = 'canonical' | 'no-grant-revision' | 'no-owner-binding'
export interface FencingReply {
  serial: number
  port: 1 | 2
  nonce: number
  op: 'hello' | 'replace' | 'grant' | 'release' | 'close'
  phase: 'held' | 'final'
  status:
    | 'snapshot'
    | 'replaced'
    | 'refused'
    | 'granted'
    | 'held-command'
    | 'held-reply'
    | 'released'
    | 'closing'
  revision: number
  generation: number
  ownerPort: 1 | 2 | null
  grantRevision: number | null
  heldCommand: boolean
  heldReply: boolean
}
export interface FencingPageState {
  instance: string
  port: number
  replies: FencingReply[]
  pending: number
  abandoned: number
  rpcTimers: number
  errors: string[]
  invocations: number
  automaticInvocations: number
  ignoredLateReplies: number
  abandonedContinuations: number
  locksSettled: boolean
  responsesDisposed: boolean
  closeAcknowledged: boolean
  portCloseCalls: number
}
export interface FencingPageClient {
  connect(): Promise<FencingReply>
  replace(fresh: boolean): Promise<FencingReply>
  grant(holdReply: boolean): Promise<{ granted: boolean }>
  park(): Promise<void>
  waitHeld(): Promise<void>
  release(slot: 'late-command' | 'grant-reply'): Promise<FencingReply>
  snapshot(): Promise<FencingReply>
  retire(): void
  inspect(): FencingPageState
  closeWorker(): Promise<FencingReply>
  closePort(): void
  finish(): Promise<FencingPageState>
}

const fencingWorker = String.raw`
'use strict';
const signature = 'W03_NATIVE_COORDINATOR_FIXTURE_ONLY';
const protocol = 'test-fence-v1';
const org = '11111111-1111-4111-8111-111111111111';
const instance = crypto.randomUUID();
let revision = 0;
let generation = 0;
let ownerPort = null;
let serial = 0;
let portCount = 0;
let heldCommand = null;
let heldReply = null;
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key));
}
function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function post(connection, message, phase, status, grantRevision = null) {
  if (++serial > 24) throw Error('FENCE_WORKER_REPLY_CAP');
  connection.port.postMessage({ protocol, instance, org, serial, port: connection.id,
    nonce: message.nonce, op: message.op, phase, status, revision, generation, ownerPort,
    grantRevision, heldCommand: heldCommand !== null, heldReply: heldReply !== null });
}
function replace(connection, message) {
  if (message.payload.expectedRevision !== revision) {
    post(connection, message, 'final', 'refused');
    return;
  }
  generation += 1;
  revision += 1;
  ownerPort = connection.id;
  if (generation > 4 || revision > 16) throw Error('FENCE_WORKER_STATE_CAP');
  post(connection, message, 'final', 'replaced');
}
self.onconnect = event => {
  if (++portCount > 2 || event.ports.length !== 1) throw Error('FENCE_WORKER_PORT_CAP');
  const connection = { port: event.ports[0], id: portCount, nonce: 0 };
  connection.port.onmessage = event => {
    const message = event.data;
    if (!exact(message, ['protocol', 'instance', 'org', 'nonce', 'op', 'payload']) ||
        message.protocol !== protocol || message.org !== org ||
        !integer(message.nonce, 1, 16) || message.nonce !== connection.nonce + 1 ||
        (connection.nonce === 0 ? message.op !== 'hello' || message.instance !== null : message.instance !== instance)) {
      throw Error('FENCE_WORKER_ENVELOPE');
    }
    const payload = message.payload;
    if (message.op === 'hello' || message.op === 'close') {
      if (!exact(payload, [])) throw Error('FENCE_WORKER_PAYLOAD');
    } else if (message.op === 'replace') {
      if (!exact(payload, ['expectedRevision', 'park']) || !integer(payload.expectedRevision, 0, 16) || typeof payload.park !== 'boolean') throw Error('FENCE_WORKER_PAYLOAD');
    } else if (message.op === 'grant') {
      if (!exact(payload, ['expectedRevision', 'generation', 'holdReply']) || !integer(payload.expectedRevision, 0, 16) || !integer(payload.generation, 1, 4) || typeof payload.holdReply !== 'boolean') throw Error('FENCE_WORKER_PAYLOAD');
    } else if (message.op === 'release') {
      if (!exact(payload, ['slot']) || !['late-command', 'grant-reply'].includes(payload.slot)) throw Error('FENCE_WORKER_PAYLOAD');
    } else throw Error('FENCE_WORKER_OPERATION');
    connection.nonce = message.nonce;
    if (message.op === 'hello') return post(connection, message, 'final', 'snapshot');
    if (message.op === 'replace') {
      if (payload.park) {
        if (connection.id !== 1 || message.nonce !== 6 || heldCommand) throw Error('FENCE_WORKER_PARK_ROLE');
        heldCommand = { connection, message };
        post(connection, message, 'held', 'held-command');
      } else replace(connection, message);
      return;
    }
    if (message.op === 'grant') {
      if (message.payload.expectedRevision !== revision || !(ownerPort === connection.id && message.payload.generation === generation)) {
        post(connection, message, 'final', 'refused');
        return;
      }
      revision += 1;
      const grantRevision = revision;
      if (revision > 16) throw Error('FENCE_WORKER_STATE_CAP');
      if (payload.holdReply) {
        if (connection.id !== 2 || message.nonce !== 7 || heldReply) throw Error('FENCE_WORKER_HOLD_ROLE');
        heldReply = { connection, message, grantRevision };
        post(connection, message, 'held', 'held-reply', grantRevision);
      } else post(connection, message, 'final', 'granted', grantRevision);
      return;
    }
    if (message.op === 'release') {
      if (payload.slot === 'late-command') {
        if (!heldCommand) throw Error('FENCE_WORKER_EMPTY_COMMAND');
        const captured = heldCommand;
        heldCommand = null;
        replace(captured.connection, captured.message);
      } else {
        if (!heldReply) throw Error('FENCE_WORKER_EMPTY_REPLY');
        const captured = heldReply;
        heldReply = null;
        post(captured.connection, captured.message, 'final', 'granted', captured.grantRevision);
      }
      return post(connection, message, 'final', 'released');
    }
    if (heldCommand || heldReply) throw Error('FENCE_WORKER_CLOSE_WITH_WORK');
    post(connection, message, 'final', 'closing');
    self.close();
  };
  connection.port.onmessageerror = () => { throw Error('FENCE_WORKER_MESSAGE_ERROR'); };
  connection.port.start();
};
void signature;
`

export function fencingFixtureAssets(variant: FencingVariant): Record<string, string> {
  let source = fencingWorker
  const anchor =
    variant === 'no-grant-revision'
      ? '      revision += 1;\n      const grantRevision = revision;'
      : ' || !(ownerPort === connection.id && message.payload.generation === generation)'
  if (variant !== 'canonical') {
    if (source.split(anchor).length !== 2) throw Error('FENCE_SOURCE_CONTROL_ANCHOR')
    source = source.replace(
      anchor,
      variant === 'no-grant-revision' ? '      const grantRevision = revision;' : ''
    )
  }
  return { ...coordinatorFixtureAssets('canonical'), 'owner-claim-coordinator.js': source }
}

const fencingPageProgram = String.raw`
(() => {
'use strict';
const signature = 'W03_NATIVE_COORDINATOR_FIXTURE_ONLY';
const protocol = 'test-fence-v1';
const org = '11111111-1111-4111-8111-111111111111';
const lock = 'kodera.test.owner-claim/' + org;
const replies = [];
const errors = [];
const pending = new Map();
const abandoned = new Map();
const rpcTimers = new Set();
const activeContinuations = new Set();
const work = [];
const responses = [];
let worker;
let instance = '';
let port = 0;
let nonce = 0;
let holder;
let retired = false;
let locks = 0;
let invocations = 0;
let automaticInvocations = 0;
let ignoredLateReplies = 0;
let abandonedContinuations = 0;
let closeAcknowledged = false;
let portCloseCalls = 0;
let lastSerial = 0;
let heldGrant;
let heldWait;
let rejectHeldWait;
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key));
}
function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function failure(marker) {
  if (errors.length < 24) errors.push(marker);
  if (rejectHeldWait) {
    rejectHeldWait(Error(marker));
    heldWait = undefined;
    rejectHeldWait = undefined;
  }
}
function own(promise, collection = work) {
  promise.catch(() => {});
  collection.push(promise);
  return promise;
}
function rpc(op, payload) {
  if (!worker || ++nonce > 16 || pending.size >= 4) throw Error('FENCE_RPC_ADMISSION');
  let resolveFinal;
  let rejectFinal;
  const final = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  final.catch(() => {});
  const heldOperation = payload.park === true || payload.holdReply === true;
  let resolveHeld;
  let rejectHeld;
  const held = heldOperation ? new Promise((resolve, reject) => { resolveHeld = resolve; rejectHeld = reject; }) : final;
  held.catch(() => {});
  const current = nonce;
  const entry = { op, resolveFinal, rejectFinal, resolveHeld, rejectHeld, held: false,
    timer: setTimeout(() => {
      rpcTimers.delete(entry.timer);
      pending.delete(current);
      failure('FENCE_RPC_TIMEOUT');
      rejectFinal(Error('FENCE_RPC_TIMEOUT'));
      if (rejectHeld) rejectHeld(Error('FENCE_RPC_TIMEOUT'));
    }, 4000) };
  rpcTimers.add(entry.timer);
  pending.set(current, entry);
  worker.port.postMessage({ protocol, instance: current === 1 ? null : instance, org, nonce: current, op, payload });
  return { nonce: current, final, held };
}
function receive(event) {
  try {
    const value = event.data;
    if (!exact(value, ['protocol', 'instance', 'org', 'serial', 'port', 'nonce', 'op', 'phase', 'status', 'revision', 'generation', 'ownerPort', 'grantRevision', 'heldCommand', 'heldReply']) ||
        value.protocol !== protocol || value.org !== org || typeof value.instance !== 'string' || value.instance.length !== 36 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.instance) ||
        (instance && value.instance !== instance) || !integer(value.serial, 1, 24) || value.serial <= lastSerial ||
        !integer(value.port, 1, 2) || (port && value.port !== port) || !integer(value.nonce, 1, 16) ||
        !integer(value.revision, 0, 16) || !integer(value.generation, 0, 4) ||
        !(value.ownerPort === null || integer(value.ownerPort, 1, 2)) ||
        !(value.grantRevision === null || integer(value.grantRevision, 0, 16)) ||
        typeof value.heldCommand !== 'boolean' || typeof value.heldReply !== 'boolean') throw Error('FENCE_REPLY_ENVELOPE');
    const combinations = {
      hello: ['final/snapshot'], replace: ['held/held-command', 'final/replaced', 'final/refused'],
      grant: ['held/held-reply', 'final/granted', 'final/refused'], release: ['final/released'], close: ['final/closing']
    };
    if (!Object.hasOwn(combinations, value.op) || !combinations[value.op].includes(value.phase + '/' + value.status) ||
        ((value.op === 'grant' && ['held-reply', 'granted'].includes(value.status)) ? value.grantRevision === null : value.grantRevision !== null)) throw Error('FENCE_REPLY_STATUS');
    const entry = pending.get(value.nonce);
    const ignored = abandoned.get(value.nonce);
    if ((!entry && !ignored) || (entry || ignored).op !== value.op) throw Error('FENCE_REPLY_CORRELATION');
    if (!instance) {
      if (value.nonce !== 1 || value.op !== 'hello' || value.phase !== 'final') throw Error('FENCE_REPLY_INITIAL');
      instance = value.instance;
      port = value.port;
    }
    lastSerial = value.serial;
    if (replies.length >= 24) throw Error('FENCE_REPLY_CAP');
    const { protocol: ignoredProtocol, instance: ignoredInstance, org: ignoredOrg, ...projected } = value;
    void ignoredProtocol; void ignoredInstance; void ignoredOrg;
    replies.push(projected);
    if (ignored) {
      if (value.phase !== 'final' || value.op !== 'replace') throw Error('FENCE_ABANDONED_PHASE');
      abandoned.delete(value.nonce);
      ignoredLateReplies += 1;
      return;
    }
    if (value.phase === 'held') {
      if (entry.held || !entry.resolveHeld) throw Error('FENCE_DUPLICATE_HELD');
      entry.held = true;
      entry.resolveHeld(value);
      if (value.op === 'grant') {
        heldGrant = value;
        if (heldWait) { heldWait(); heldWait = undefined; rejectHeldWait = undefined; }
      }
      return;
    }
    clearTimeout(entry.timer);
    rpcTimers.delete(entry.timer);
    pending.delete(value.nonce);
    if (entry.resolveHeld && !entry.held) entry.resolveHeld(value);
    if (value.op === 'close') closeAcknowledged = true;
    entry.resolveFinal(value);
  } catch (error) {
    failure(error instanceof Error ? error.message : 'FENCE_REPLY_ERROR');
  }
}
function locked(callback) {
  const operation = navigator.locks.request(lock, { mode: 'exclusive' }, async () => {
    locks += 1;
    try { return await callback(); } finally { locks -= 1; }
  });
  return own(operation);
}
function invoke(captured, capturedGeneration, reply, continuation) {
  if (retired || !captured || holder !== captured || !captured.live || captured.generation !== capturedGeneration || reply.status !== 'granted') return { granted: false };
  const response = fetch('/fixture-icon.svg?rank1-probe=1', { method: 'GET', credentials: 'omit', cache: 'no-store' });
  invocations += 1;
  if (!activeContinuations.has(continuation) || continuation.nonce !== reply.nonce) automaticInvocations += 1;
  const disposed = own(response.then(async value => {
    if (!value.ok) throw Error('FENCE_NATIVE_RESPONSE');
    await value.arrayBuffer();
  }), responses);
  return { granted: true, response: disposed };
}
const api = {
  connect() {
    if (worker) throw Error('FENCE_DUPLICATE_CONNECT');
    worker = new SharedWorker('/owner-claim-coordinator.js', { name: 'kodera-test-owner-claim-coordinator', type: 'classic', credentials: 'same-origin' });
    worker.onerror = () => failure('FENCE_WORKER_ERROR');
    worker.port.onmessage = receive;
    worker.port.onmessageerror = () => failure('FENCE_MESSAGE_ERROR');
    worker.port.start();
    return rpc('hello', {}).final;
  },
  replace(fresh) {
    return locked(async () => {
      if (retired) throw Error('FENCE_RETIRED');
      const snapshot = fresh ? await rpc('hello', {}).final : replies[0];
      const reply = await rpc('replace', { expectedRevision: snapshot.revision, park: false }).final;
      if (reply.status !== 'replaced') throw Error('FENCE_INITIAL_REPLACE_REFUSED');
      holder = { generation: reply.generation, live: true };
      return reply;
    });
  },
  grant(holdReply) {
    const captured = holder;
    const capturedGeneration = captured && captured.generation;
    const operation = locked(async () => {
      if (retired || !captured || !captured.live) throw Error('FENCE_GRANT_HOLDER_ABSENT');
      const snapshot = await rpc('hello', {}).final;
      const command = rpc('grant', { expectedRevision: snapshot.revision, generation: captured.generation, holdReply });
      const continuation = { nonce: command.nonce };
      activeContinuations.add(continuation);
      try {
        const reply = await command.final;
        return invoke(captured, capturedGeneration, reply, continuation);
      } finally { activeContinuations.delete(continuation); }
    });
    return own(operation.then(async wrapper => {
      if (wrapper.response) await wrapper.response;
      return { granted: wrapper.granted };
    }));
  },
  park() {
    return locked(async () => {
      const snapshot = await rpc('hello', {}).final;
      const command = rpc('replace', { expectedRevision: snapshot.revision, park: true });
      own(command.final.then(() => { abandonedContinuations += 1; }, () => {}));
      const reply = await command.held;
      if (reply.phase !== 'held' || reply.status !== 'held-command') throw Error('FENCE_PARK_NOT_HELD');
      const entry = pending.get(command.nonce);
      if (!entry) throw Error('FENCE_PARK_HOLDER_ABSENT');
      clearTimeout(entry.timer);
      rpcTimers.delete(entry.timer);
      pending.delete(command.nonce);
      abandoned.set(command.nonce, { op: entry.op });
      if (holder) holder.live = false;
      entry.rejectFinal(Error('FENCE_ABANDONED'));
    });
  },
  waitHeld() {
    if (heldGrant) return Promise.resolve();
    if (heldWait) throw Error('FENCE_DUPLICATE_HELD_WAITER');
    return own(new Promise((resolve, reject) => { heldWait = resolve; rejectHeldWait = reject; }));
  },
  release(slot) { return rpc('release', { slot }).final; },
  snapshot() { return rpc('hello', {}).final; },
  retire() {
    retired = true;
    if (holder) holder.live = false;
    if (rejectHeldWait) {
      rejectHeldWait(Error('FENCE_RETIRED'));
      heldWait = undefined;
      rejectHeldWait = undefined;
    }
  },
  inspect() {
    return { instance, port, replies: replies.map(reply => ({ ...reply })), pending: pending.size, abandoned: abandoned.size,
      rpcTimers: rpcTimers.size, errors: [...errors], invocations, automaticInvocations,
      ignoredLateReplies, abandonedContinuations, locksSettled: locks === 0, responsesDisposed: false,
      closeAcknowledged, portCloseCalls };
  },
  closeWorker() { return rpc('close', {}).final; },
  closePort() {
    if (pending.size || abandoned.size || rpcTimers.size || activeContinuations.size || locks || heldWait) throw Error('FENCE_PORT_WITH_WORK');
    worker.port.onmessage = null;
    worker.port.onmessageerror = null;
    worker.onerror = null;
    worker.port.close();
    portCloseCalls += 1;
  },
  async finish() {
    const operations = await Promise.allSettled(work);
    const bodies = await Promise.allSettled(responses);
    if (operations.some(entry => entry.status !== 'fulfilled') || bodies.some(entry => entry.status !== 'fulfilled')) failure('FENCE_OWNED_WORK_REJECTED');
    const state = api.inspect();
    state.responsesDisposed = bodies.every(entry => entry.status === 'fulfilled');
    if (pending.size || abandoned.size || rpcTimers.size || activeContinuations.size || locks || heldWait || errors.length) throw Error('FENCE_OWNED_WORK_UNSETTLED');
    return state;
  }
};
if (window.__koderaFencing) throw Error('FENCE_EXISTING_STATE');
window.__koderaFencing = api;
void signature;
})()
`

export function fencingBrowserProgram(): string {
  return fencingPageProgram
}
