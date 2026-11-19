import { expect } from '@playwright/test'
import type { BrowserContext, Request, Response } from '@playwright/test'
import { exactOrigin, guard } from './oracles/shared'

/** Responsive shell replacement stops its old Matrix client and starts a new one. */
export class MatrixSyncLifecycle {
  private readonly pending = new Set<Request>()
  private candidates: Set<Request> | undefined
  private readonly nativeAborts = new Set<string>()
  private readonly replacements = new Set<Request>()
  private cancelled = false
  private recovered = false

  constructor(private readonly homeserver: string) {
    exactOrigin(homeserver)
  }
  private isSync(request: Request) {
    const url = new URL(request.url())
    return (
      request.method() === 'GET' &&
      url.origin === this.homeserver &&
      url.pathname === '/_matrix/client/v3/sync'
    )
  }
  async install(context: BrowserContext) {
    await context.exposeBinding('__wave2NativeSyncAbort', (_source, url: unknown) => {
      if (this.candidates && typeof url === 'string') this.nativeAborts.add(url)
    })
    await context.addInitScript((homeserver) => {
      // eslint-disable-next-line no-restricted-properties -- Test-only transparent native abort observer.
      const original = window.fetch
      // eslint-disable-next-line no-restricted-properties -- Test-only transparent native abort observer.
      window.fetch = function (...args: Parameters<typeof fetch>) {
        const [resource, options] = args
        const url = new URL(
          resource instanceof Request ? resource.url : String(resource),
          location.href
        )
        const method = options?.method ?? (resource instanceof Request ? resource.method : 'GET')
        const signal =
          options?.signal ?? (resource instanceof Request ? resource.signal : undefined)
        if (
          url.origin === homeserver &&
          url.pathname === '/_matrix/client/v3/sync' &&
          method === 'GET'
        ) {
          signal?.addEventListener(
            'abort',
            () => {
              const report = (
                window as unknown as { __wave2NativeSyncAbort(url: string): Promise<void> }
              ).__wave2NativeSyncAbort
              void report(url.href).catch(() => {})
            },
            { once: true }
          )
        }
        return original.apply(this, args)
      }
    }, this.homeserver)
    context.on('request', this.started)
    context.on('requestfinished', this.finished)
    context.on('requestfailed', this.finished)
    context.on('response', this.responded)
  }
  private readonly started = (request: Request) => {
    if (!this.isSync(request)) return
    this.pending.add(request)
    if (this.candidates) this.replacements.add(request)
  }
  private readonly finished = (request: Request) => {
    this.pending.delete(request)
  }
  private readonly responded = (response: Response) => {
    if (this.replacements.has(response.request()) && response.status() === 200)
      this.recovered = true
  }
  readonly allowedRequestFailure = (request: Request): boolean => {
    const allowed = Boolean(
      this.candidates?.has(request) &&
      this.isSync(request) &&
      request.failure()?.errorText === 'net::ERR_ABORTED' &&
      this.nativeAborts.has(request.url())
    )
    if (allowed) this.cancelled = true
    return allowed
  }
  async resize(action: () => Promise<void>) {
    guard(!this.candidates, 'WAVE2_SYNC_BOUNDARY_NESTED')
    this.candidates = new Set(this.pending)
    try {
      await action()
      if (this.cancelled)
        await expect.poll(() => this.recovered, { message: 'WAVE2_SYNC_RECOVERY' }).toBe(true)
    } finally {
      this.candidates = undefined
      this.nativeAborts.clear()
      this.replacements.clear()
      this.cancelled = false
      this.recovered = false
    }
  }
}
