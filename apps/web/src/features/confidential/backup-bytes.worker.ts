import { need } from './crypto-session.worker-core'

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
/** Intrinsic bounded copy: never enumerate millions of typed-array index properties. */
export function copyBackupBytes(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  need(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    need(!Object.hasOwn(value, key))
  const buffer: unknown = Reflect.apply(bufferOf, value, [])
  const length: number = Reflect.apply(lengthOf, value, [])
  const offset: number = Reflect.apply(offsetOf, value, [])
  need(
    buffer instanceof ArrayBuffer &&
      (!resizable || !Reflect.apply(resizable, buffer, [])) &&
      length >= min &&
      length <= max
  )
  return new Uint8Array(new Uint8Array(buffer, offset, length))
}
