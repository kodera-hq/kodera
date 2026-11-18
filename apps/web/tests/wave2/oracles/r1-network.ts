import type { BrowserContext, Page, Request, Response, Worker } from '@playwright/test'
import { exactOrigin, guard, pathMatches } from './shared'

export interface NetworkTemplate {
  origin: string
  method: string
  pathPattern: string
  expectedStatus: number
  min?: number
  max?: number
  query?: Readonly<Record<string, string>>
  requiredBodyKeys?: readonly string[]
}
export interface NetworkObservation {
  url: string
  method: string
  status: number
  contentType: string
  bodyPrefix?: string
  body?: unknown
  jsonValid?: boolean
}

export class NetworkLedger {
  readonly failures: string[] = []
  private readonly counts: number[]
  constructor(
    readonly templates: readonly NetworkTemplate[],
    readonly allowedOrigins: readonly string[]
  ) {
    allowedOrigins.forEach(exactOrigin)
    for (const t of templates) {
      exactOrigin(t.origin)
      guard(allowedOrigins.includes(t.origin), 'R1_TEMPLATE_ORIGIN')
      guard(t.method === t.method.toUpperCase() && /^[A-Z]+$/.test(t.method), 'R1_METHOD_TEMPLATE')
      guard(
        Number.isInteger(t.expectedStatus) && t.expectedStatus >= 100 && t.expectedStatus <= 599,
        'R1_STATUS_TEMPLATE'
      )
      pathMatches(t.pathPattern, '/')
      guard((t.min ?? 1) >= 0 && (t.max ?? Infinity) >= (t.min ?? 1), 'R1_COUNT_TEMPLATE')
    }
    this.counts = templates.map(() => 0)
  }
  fail(marker: string): void {
    this.failures.push(marker)
  }
  request(url: string): void {
    if (!this.allowedOrigins.includes(new URL(url).origin)) this.fail('R1_UNADMITTED_ORIGIN')
  }
  observe(value: NetworkObservation): void {
    this.request(value.url)
    const url = new URL(value.url)
    const candidates = this.templates
      .map((t, i) => ({ t, i }))
      .filter(
        ({ t }) =>
          t.origin === url.origin &&
          t.method === value.method &&
          pathMatches(t.pathPattern, url.pathname)
      )
    const matched = candidates.find(({ t }) => t.expectedStatus === value.status) ?? candidates[0]
    if (value.status >= 400 && !candidates.some(({ t }) => t.expectedStatus === value.status))
      this.fail(value.status >= 500 ? 'R1_UNEXPECTED_5XX' : 'R1_UNEXPECTED_4XX')
    if (/^\/api(?:\/|$)/.test(url.pathname)) {
      if (!matched) this.fail('R1_UNEXPECTED_API')
      if (value.jsonValid === false) this.fail('R1_API_JSON')
      if (
        !/^(application\/(?:[a-z0-9.-]+\+)?json)(?:;|$)/i.test(value.contentType) ||
        /^\s*(?:<!doctype\s+html|<html\b|<)/i.test(value.bodyPrefix ?? '')
      )
        this.fail('R1_HTML_AT_API')
    }
    if (!matched) return
    const { t, i } = matched
    this.counts[i] = (this.counts[i] ?? 0) + 1
    if (value.status !== t.expectedStatus) this.fail('R1_EXACT_STATUS')
    if (
      t.query &&
      JSON.stringify([...url.searchParams].sort()) !==
        JSON.stringify(Object.entries(t.query).sort())
    )
      this.fail('R1_QUERY')
    if (
      t.requiredBodyKeys?.some(
        (key) => !value.body || typeof value.body !== 'object' || !Object.hasOwn(value.body, key)
      )
    )
      this.fail('R1_BODY_SHAPE')
    if (this.counts[i]! > (t.max ?? Infinity)) this.fail('R1_MAX_COUNT')
  }
  assertClean(): void {
    guard(this.failures.length === 0, this.failures[0] ?? 'R1_FAILURE')
    guard(
      this.templates.every((t, i) => this.counts[i]! >= (t.min ?? 1)),
      'R1_MISSING_RESPONSE'
    )
  }
  receipt() {
    return this.templates.map((t, i) => ({
      origin: t.origin,
      method: t.method,
      pathPattern: t.pathPattern,
      expectedStatus: t.expectedStatus,
      count: this.counts[i],
    }))
  }
}

/** Context hooks cover popups as well as the original page. Install before navigation. */
export async function recordNetwork(
  target: BrowserContext | Page,
  ledger: NetworkLedger,
  allowedRequestFailure?: (request: Request) => boolean
) {
  const context = 'newPage' in target ? target : target.context()
  const pending = new Set<Promise<void>>()
  const request = (r: Request) => ledger.request(r.url())
  const response = (r: Response) => {
    const task = (async () => {
      const isApi = /^\/api(?:\/|$)/.test(new URL(r.url()).pathname)
      const bodyText = isApi ? await r.text() : ''
      let body: unknown
      let jsonValid = true
      try {
        body = isApi ? JSON.parse(bodyText) : undefined
      } catch {
        jsonValid = false
      }
      ledger.observe({
        url: r.url(),
        method: r.request().method(),
        status: r.status(),
        contentType: r.headers()['content-type'] ?? '',
        bodyPrefix: bodyText.slice(0, 128),
        body,
        jsonValid,
      })
    })().catch(() => ledger.fail('R1_RESPONSE_READ'))
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  const consoleMessage = (message: { type(): string }) => {
    if (message.type() === 'error') ledger.fail('R1_CONSOLE_ERROR')
  }
  const webError = () => ledger.fail('R1_PAGE_ERROR')
  const requestFailed = (request: Request) => {
    if (!allowedRequestFailure?.(request)) ledger.fail('R1_REQUEST_FAILED')
  }
  context.on('request', request)
  context.on('response', response)
  context.on('console', consoleMessage)
  context.on('weberror', webError)
  context.on('requestfailed', requestFailed)
  const pageDisposers = new Map<Page, () => void>()
  const attachPage = (page: Page) => {
    if (pageDisposers.has(page)) return
    const crash = () => ledger.fail('R1_PAGE_CRASH')
    const workerDisposers: (() => void)[] = []
    const attachWorker = (worker: Worker) => {
      const error = () => ledger.fail('R1_WORKER_ERROR')
      // Worker errors also surface through weberror; retain the worker's own emitter witness.
      const emitter = worker as unknown as {
        on(event: string, listener: () => void): void
        off(event: string, listener: () => void): void
      }
      emitter.on('error', error)
      workerDisposers.push(() => emitter.off('error', error))
    }
    page.on('crash', crash).on('worker', attachWorker)
    page.workers().forEach(attachWorker)
    pageDisposers.set(page, () => {
      page.off('crash', crash).off('worker', attachWorker)
      workerDisposers.forEach((dispose) => dispose())
    })
  }
  context.on('page', attachPage)
  context.pages().forEach(attachPage)
  const binding = `__wave2Csp${recordNetwork.ordinal++}`
  await context.exposeBinding(binding, () => ledger.fail('R1_CSP_VIOLATION'))
  const install = (name: string) => {
    document.addEventListener('securitypolicyviolation', () => {
      const report = (globalThis as unknown as Record<string, () => Promise<void>>)[name]
      if (report) void report().catch(() => {})
    })
  }
  await context.addInitScript(install, binding)
  await Promise.all(context.pages().map((page) => page.evaluate(install, binding)))
  return {
    async assertClean() {
      while (pending.size) await Promise.all([...pending])
      ledger.assertClean()
    },
    async dispose() {
      context
        .off('request', request)
        .off('response', response)
        .off('console', consoleMessage)
        .off('weberror', webError)
        .off('requestfailed', requestFailed)
      context.off('page', attachPage)
      pageDisposers.forEach((dispose) => dispose())
      pageDisposers.clear()
      while (pending.size) await Promise.all([...pending])
    },
  }
}
recordNetwork.ordinal = 0
