// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { hostSecurityWorker } from './security-rpc.worker'
import { securityWorkerClient } from './security-worker-client'
import { clearLocalSessionStorage } from '../../auth/localSession'

class LocalWorker extends EventTarget {
  handlers = new Map<string, (event: MessageEvent<unknown>) => void>()
  terminated = false
  requests: unknown[] = []
  constructor() {
    super()
    hostSecurityWorker(
      {
        addEventListener: (kind, fn) => this.handlers.set(kind, fn),
        postMessage: (data) => {
          if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data }))
        },
        close: () => {
          this.terminated = true
        },
      },
      async () => async (operation, input) => {
        if (operation === 'public') return { public: input }
        throw new Error('private error details')
      },
      () => {}
    )
  }
  postMessage(data: unknown) {
    this.requests.push(data)
    this.handlers.get('message')?.(new MessageEvent('message', { data, ports: [] }))
  }
  terminate() {
    this.terminated = true
  }
}
describe('security worker control protocol', () => {
  it('correlates public RPC, sanitizes failures and rejects pending work at cleanup', async () => {
    const worker = new LocalWorker(),
      client = securityWorkerClient(worker as unknown as Worker, {
        organisationId: 'org',
        accountId: 'account',
      })
    expect(await client.run('public', 'descriptor')).toEqual({ public: 'descriptor' })
    await expect(client.run('bad', null)).rejects.toThrow('Security operation refused.')
    const pending = client.run('public', 'late')
    clearLocalSessionStorage()
    await expect(pending).rejects.toThrow('closed')
    expect(worker.terminated).toBe(true)
    await expect(client.run('public', null)).rejects.toThrow()
  })
  it('retires the client on an unsolicited or malformed worker reply', async () => {
    const worker = new LocalWorker(),
      client = securityWorkerClient(worker as unknown as Worker, {})
    worker.dispatchEvent(
      new MessageEvent('message', { data: { kind: 'result', id: 99, result: 'forged' } })
    )
    expect(worker.terminated).toBe(true)
    await expect(client.run('public', null)).rejects.toThrow()
  })
  it('disposes a bootstrap that completes after a malformed request closes it', async () => {
    let release!: (handler: (operation: string, input: unknown) => Promise<unknown>) => void
    const dispose = vi.fn(),
      close = vi.fn(),
      handlers = new Map<string, (event: MessageEvent<unknown>) => void>()
    hostSecurityWorker(
      { addEventListener: (kind, fn) => handlers.set(kind, fn), postMessage: vi.fn(), close },
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
      dispose
    )
    handlers.get('message')!(
      new MessageEvent('message', { data: { kind: 'bootstrap', context: {} }, ports: [] })
    )
    handlers.get('message')!(new MessageEvent('message', { data: { malformed: true } }))
    release(async () => null)
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
