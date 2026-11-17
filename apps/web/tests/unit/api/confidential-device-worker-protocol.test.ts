// @vitest-environment node
// Structural protocol controls using real structured cloning; no Core/crypto claim.
import { MessageChannel, MessagePort } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseDeviceBootstrap, parseDeviceCommand, parseDeviceControlReply, parseDeviceStatus,
} from '@/features/confidential/device-worker-protocol'

const nonce = '0123456789abcdef0123456789abcdef'
const status = { version: 2, state: 'pre-admission', nativeGeneration: 1, hostGeneration: 1 }
const ports: { close(): void }[] = []
beforeEach(() => vi.stubGlobal('MessagePort', MessagePort))
afterEach(() => { for (const port of ports.splice(0)) port.close(); vi.unstubAllGlobals() })

describe('fixed device worker structural protocol', () => {
  it('accepts only two actual transferred endpoints and no caller scope', () => {
    const control = new MessageChannel(), transport = new MessageChannel()
    ports.push(control.port1, control.port2, transport.port1, transport.port2)
    const frame = structuredClone({ version: 1, kind: 'bootstrap', nonce,
      control: control.port1, transport: transport.port1 }, { transfer: [control.port1, transport.port1] })
    ports.push(frame.control, frame.transport)
    expect(parseDeviceBootstrap(frame, [frame.control, frame.transport]).nonce).toBe(nonce)
    expect(() => parseDeviceBootstrap({ ...frame, ownerId: 'forged' }, [frame.control, frame.transport])).toThrow()
    expect(() => parseDeviceBootstrap(frame, [frame.control])).toThrow()
    expect(() => parseDeviceBootstrap({ ...frame, transport: frame.control }, [frame.control, frame.control])).toThrow()
  })
  it.each(['create', 'restore', 'prepare-registration', 'prepare-publication', 'attempt'])(
    'accepts the exact %s command with a positive safe correlation ID', (command) => {
      expect(parseDeviceCommand({ version: 1, nonce, rpcId: 1, kind: 'command', command }, nonce).command).toBe(command)
    }
  )
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, NaN, '1'])(
    'refuses unsafe correlation %s', (rpcId) => {
      expect(() => parseDeviceCommand({ version: 1, nonce, rpcId, kind: 'command', command: 'create' }, nonce)).toThrow()
    }
  )
  it('refuses wrong channel unions, nonces, symbols, accessors and extra fields', () => {
    const good = { version: 1, nonce, rpcId: 1, kind: 'command', command: 'create' }
    for (const bad of [{ ...good, nonce: 'f'.repeat(32) }, { ...good, kind: 'attempt-send' },
      { ...good, body: new Uint8Array(1) }, { ...good, [Symbol('extra')]: true }]) {
      expect(() => parseDeviceCommand(bad, nonce)).toThrow()
    }
    const accessor = { ...good }; Object.defineProperty(accessor, 'command', { get: () => 'create' })
    expect(() => parseDeviceCommand(accessor, nonce)).toThrow()
  })
  it('validates unknown generated status at runtime instead of strengthening its declarations', () => {
    expect(parseDeviceStatus(JSON.stringify(status))).toEqual(status)
    expect(parseDeviceStatus({ ...status, nativeGeneration: 3, hostGeneration: 9 }).hostGeneration).toBe(9)
    for (const bad of [{ ...status, hostGeneration: 0 }, { ...status, nativeGeneration: 2 },
      { ...status, state: 'verified-participant' }, { ...status, seed: 'forged' },
      '{"version":2,"version":2,"state":"pre-admission","nativeGeneration":1,"hostGeneration":1}']) {
      expect(() => parseDeviceStatus(bad)).toThrow()
    }
  })
  it('keeps ready, result and closed refusals distinct from transport outcomes', () => {
    expect(parseDeviceControlReply({ version: 1, nonce, kind: 'ready' }, nonce).kind).toBe('ready')
    expect(parseDeviceControlReply({ version: 1, nonce, rpcId: 2, kind: 'result', result: status }, nonce).kind).toBe('result')
    expect(parseDeviceControlReply({ version: 1, nonce, rpcId: 2, kind: 'refused', code: 'restore-required' }, nonce).kind).toBe('refused')
    for (const bad of [{ version: 1, nonce, rpcId: 2, kind: 'attempt-outcome', outcome: { kind: 'response' } },
      { version: 1, nonce, rpcId: 2, kind: 'refused', code: 'raw-error-text' },
      { version: 1, nonce, kind: 'ready', rpcId: 1 }]) expect(() => parseDeviceControlReply(bad, nonce)).toThrow()
  })
  it('defines extracted object properties without invoking Object.prototype setters', () => {
    let intercepted = false
    Object.defineProperty(Object.prototype, 'command', {
      configurable: true,
      set() {
        intercepted = true
        throw new Error('POLLUTED_OBJECT_PROTOTYPE_SETTER')
      },
    })
    try {
      const parsed = parseDeviceCommand(
        JSON.parse(`{"version":1,"nonce":"${nonce}","rpcId":1,"kind":"command","command":"create"}`),
        nonce
      )
      expect(parsed.command).toBe('create')
      expect(intercepted).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'command')
    }
  })
})
