// Structural private-channel codecs. These shapes confer no Core/native authority.
export type DeviceCommand = 'create' | 'restore' | 'prepare-registration' | 'prepare-publication' | 'attempt'
export type DeviceWorkerCode = 'invalid-input' | 'ineligible' | 'busy' | 'closed' | 'storage' |
  'network' | 'invalid-response' | 'restore-required'
export type DeviceState = 'pre-admission' | 'registration-prepared' | 'registration-attempted' |
  'admitted' | 'publication-prepared' | 'publication-attempted' | 'published' | 'outcome-unknown'
export interface DeviceStatus {
  readonly version: 2
  readonly state: DeviceState
  readonly nativeGeneration: number
  readonly hostGeneration: number
}
export interface DeviceCommandFrame {
  readonly version: 1; readonly nonce: string; readonly rpcId: number
  readonly kind: 'command'; readonly command: DeviceCommand
}
export type DeviceControlReply =
  | Readonly<{ version: 1; nonce: string; kind: 'ready' }>
  | Readonly<{ version: 1; nonce: string; rpcId: number; kind: 'result'; result: DeviceStatus }>
  | Readonly<{ version: 1; nonce: string; rpcId: number; kind: 'refused'; code: DeviceWorkerCode }>
const COMMANDS: readonly string[] = ['create', 'restore', 'prepare-registration', 'prepare-publication', 'attempt']
const STATES: readonly string[] = ['pre-admission', 'registration-prepared', 'registration-attempted',
  'admitted', 'publication-prepared', 'publication-attempted', 'published', 'outcome-unknown']
const CODES: readonly string[] = ['invalid-input', 'ineligible', 'busy', 'closed', 'storage', 'network', 'invalid-response', 'restore-required']
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
export class DeviceWorkerProtocolError extends Error {
  constructor() { super('Device worker protocol refused.'); this.name = 'DeviceWorkerProtocolError' }
}
export function deviceWorkerNeed(value: unknown): asserts value {
  if (!value) throw new DeviceWorkerProtocolError()
}
export function deviceWorkerInteger(value: unknown, positive = true): asserts value is number {
  deviceWorkerNeed(typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0))
}
export function deviceWorkerId(value: unknown): asserts value is string {
  deviceWorkerNeed(typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000')
}
export function deviceWorkerObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  deviceWorkerNeed(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors)
  deviceWorkerNeed(actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key)))
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const item = descriptors[key]
    deviceWorkerNeed(item && item.enumerable && 'value' in item)
    result[key] = item.value
  }
  return result
}
export function deviceWorkerJson(value: unknown, cap: number, keys: readonly string[]): Record<string, unknown> {
  deviceWorkerNeed(typeof value === 'string' && value.length > 0 && value.length <= cap)
  for (let i = 0; i < value.length; i++) deviceWorkerNeed(value.charCodeAt(i) >= 32 && value.charCodeAt(i) <= 126)
  const parsed: unknown = JSON.parse(value)
  deviceWorkerNeed(JSON.stringify(parsed) === value)
  return deviceWorkerObject(parsed, keys)
}
export function deviceWorkerBytes(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  deviceWorkerNeed(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
  const buffer: unknown = Reflect.apply(bufferOf, value, [])
  const length: number = Reflect.apply(lengthOf, value, []), offset: number = Reflect.apply(offsetOf, value, [])
  deviceWorkerNeed(buffer instanceof ArrayBuffer && (!resizable || Reflect.apply(resizable, buffer, []) === false) &&
    length >= minimum && length <= maximum)
  const copy = new Uint8Array(length); copy.set(new Uint8Array(buffer, offset, length)); return copy
}
function correlation(value: Record<string, unknown>, nonce: string): void {
  deviceWorkerNeed(value.version === 1 && typeof nonce === 'string' && /^[0-9a-f]{32}$/.test(nonce) && value.nonce === nonce)
}
export function parseDeviceBootstrap(value: unknown, ports: readonly unknown[]) {
  const frame = deviceWorkerObject(value, ['version', 'kind', 'nonce', 'control', 'transport'])
  deviceWorkerNeed(frame.version === 1 && frame.kind === 'bootstrap' && typeof frame.nonce === 'string' && /^[0-9a-f]{32}$/.test(frame.nonce))
  deviceWorkerNeed(frame.control instanceof MessagePort && frame.transport instanceof MessagePort && frame.control !== frame.transport &&
    ports.length === 2 && ports.includes(frame.control) && ports.includes(frame.transport))
  return Object.freeze({ nonce: frame.nonce, control: frame.control, transport: frame.transport })
}
export function parseDeviceCommand(value: unknown, nonce: string): DeviceCommandFrame {
  const frame = deviceWorkerObject(value, ['version', 'nonce', 'rpcId', 'kind', 'command'])
  correlation(frame, nonce); deviceWorkerInteger(frame.rpcId)
  deviceWorkerNeed(frame.kind === 'command' && typeof frame.command === 'string' && COMMANDS.includes(frame.command))
  return Object.freeze({ version: 1, nonce, rpcId: frame.rpcId, kind: 'command', command: frame.command as DeviceCommand })
}
export function parseDeviceStatus(value: unknown): DeviceStatus {
  const keys = ['version', 'state', 'nativeGeneration', 'hostGeneration']
  const status = typeof value === 'string' ? deviceWorkerJson(value, 1024, keys) : deviceWorkerObject(value, keys)
  deviceWorkerInteger(status.nativeGeneration); deviceWorkerInteger(status.hostGeneration)
  deviceWorkerNeed(status.version === 2 && typeof status.state === 'string' && STATES.includes(status.state) && status.hostGeneration >= status.nativeGeneration)
  return Object.freeze({ version: 2, state: status.state as DeviceState,
    nativeGeneration: status.nativeGeneration, hostGeneration: status.hostGeneration })
}
export function parseDeviceControlReply(value: unknown, nonce: string): DeviceControlReply {
  deviceWorkerNeed(value !== null && typeof value === 'object')
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  deviceWorkerNeed(kind && 'value' in kind)
  if (kind.value === 'ready') {
    const frame = deviceWorkerObject(value, ['version', 'nonce', 'kind']); correlation(frame, nonce)
    return Object.freeze({ version: 1, nonce, kind: 'ready' })
  }
  deviceWorkerNeed(kind.value === 'result' || kind.value === 'refused')
  const frame = deviceWorkerObject(value, ['version', 'nonce', 'rpcId', 'kind', kind.value === 'result' ? 'result' : 'code'])
  correlation(frame, nonce); deviceWorkerInteger(frame.rpcId)
  if (kind.value === 'result') return Object.freeze({ version: 1, nonce, rpcId: frame.rpcId, kind: 'result', result: parseDeviceStatus(frame.result) })
  deviceWorkerNeed(typeof frame.code === 'string' && CODES.includes(frame.code))
  return Object.freeze({ version: 1, nonce, rpcId: frame.rpcId, kind: 'refused', code: frame.code as DeviceWorkerCode })
}
