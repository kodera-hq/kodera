// @vitest-environment node

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { Browser, Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import {
  beginReliability,
  claimReliabilityIdentity,
  createReliabilityRecord,
  createReliabilityReceipt,
  finalizeReliabilityRecord,
  reliabilityCases,
  reliabilityByteBudget,
  reliabilityGuardControls,
  reliabilityRecordReason,
  selectReliabilityCase,
} from '../e2e/support/reliabilityRecord'

const firstCase = reliabilityCases[0]!
const identity = { caseId: firstCase.id, project: firstCase.project, retry: 0, worker: 0 }
const request = (url = 'http://localhost:4173/api/v1/me') => ({
  url: () => url,
  method: () => 'GET',
  resourceType: () => 'fetch',
})

function fixture() {
  const page = new EventEmitter()
  const browser = new EventEmitter()
  let time = 10
  const recorder = createReliabilityRecord(
    identity,
    page as unknown as Pick<Page, 'on' | 'off'>,
    browser as unknown as Pick<Browser, 'on' | 'off'>,
    () => time++
  )
  return { page, browser, recorder, time: (next: number) => (time = next) }
}

function completed() {
  const active = fixture()
  const observed = request()
  active.page.emit('request', observed)
  active.page.emit('response', { request: () => observed, status: () => 200 })
  active.page.emit('requestfinished', observed)
  return active.recorder.finish('passed')
}

function pressureRecord() {
  const active = fixture()
  for (let index = 0; index < 120; index += 1) {
    const observed = request()
    active.page.emit('request', observed)
    active.page.emit('response', { request: () => observed, status: () => 200 })
    active.page.emit('requestfinished', observed)
  }
  for (let index = 0; index < 8; index += 1) active.recorder.mark('primary')
  for (let index = 0; index < 7; index += 1) active.page.emit('framenavigated', request())
  return active.recorder.finish('passed')
}

function expectReceipt(
  lines: string[],
  record: ReturnType<typeof completed>,
  attachment = 'ok'
): Buffer {
  const body = Buffer.from(JSON.stringify(record))
  const digest = createHash('sha256').update(body).digest('hex')
  const parts = Math.ceil(body.length / 4096)
  const identityFields = `case=${record.caseId} project=${record.project} retry=${record.retry} worker=${record.worker}`
  expect(lines.length, 'RECEIPT_FRAMES').toBe(parts + 1)
  const payloads: string[] = []
  for (const [index, line] of lines.entries()) {
    expect(/^[\x20-\x7e]+$/.test(line) && !/[\r\n]/.test(line), 'RECEIPT_ASCII').toBe(true)
    expect(Buffer.byteLength(line) + 1, 'RECEIPT_LINE').toBeLessThanOrEqual(
      index === parts ? 256 : 4352
    )
    if (index === parts) {
      expect(line, 'RECEIPT_END').toBe(
        `E2E_RELIABILITY_V3_END ${identityFields} parts=${parts} bytes=${body.length} sha256=${digest} attachment=${attachment}`
      )
    } else {
      const header = `E2E_RELIABILITY_V3_PART ${identityFields} part=${index + 1}/${parts} bytes=${body.length} sha256=${digest} data=`
      expect(Buffer.byteLength(header) + 1, 'RECEIPT_HEADER_BOUND').toBeLessThanOrEqual(256)
      expect(line.startsWith(header), 'RECEIPT_HEADER').toBe(true)
      const payload = line.slice(header.length)
      expect(Buffer.byteLength(payload), 'RECEIPT_CHUNK').toBe(
        Math.min(4096, body.length - index * 4096)
      )
      payloads.push(payload)
    }
  }
  const reconstructed = Buffer.from(payloads.join(''))
  expect(reconstructed.equals(body), 'RECEIPT_BODY').toBe(true)
  expect(createHash('sha256').update(reconstructed).digest('hex'), 'RECEIPT_DIGEST').toBe(digest)
  expect(
    reliabilityRecordReason(JSON.parse(reconstructed.toString())),
    'RECEIPT_RECORD'
  ).toBeUndefined()
  expect(
    lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0),
    'RECEIPT_WIRE'
  ).toBeLessThanOrEqual(69888)
  return reconstructed
}

describe('bounded passive reliability records', () => {
  it('selects only six exact project/declaration pairs and eighteen possible attempts', () => {
    const seen = new Set<string>()
    for (const selected of reliabilityCases) {
      for (const retry of [0, 1, 2]) {
        const input = { ...selected, file: `/tests/e2e/${selected.file}`, retry, worker: 0 }
        const admitted = selectReliabilityCase(input)
        expect(admitted?.caseId).toBe(selected.id)
        claimReliabilityIdentity(admitted!, seen)
        expect(() => claimReliabilityIdentity(admitted!, seen)).toThrow('IDENTITY')
      }
      expect(
        selectReliabilityCase({ ...selected, project: 'unselected', retry: 0, worker: 0 })
      ).toBeUndefined()
      expect(
        selectReliabilityCase({ ...selected, title: `${selected.title}!`, retry: 0, worker: 0 })
      ).toBeUndefined()
      expect(() => selectReliabilityCase({ ...selected, retry: 3, worker: 0 })).toThrow('IDENTITY')
    }
    expect(seen.size).toBe(18)
  })

  it('leaves unselected listeners and attempt state untouched', () => {
    const page = new EventEmitter()
    const browser = new EventEmitter()
    const canary = () => {}
    browser.on('disconnected', canary)
    beginReliability(
      page as unknown as Pick<Page, 'on' | 'off'>,
      browser as unknown as Pick<Browser, 'on' | 'off'>,
      { ...firstCase, project: 'unselected', retry: 0, worker: 0 }
    )
    expect(page.eventNames()).toEqual([])
    expect(browser.listeners('disconnected')).toEqual([canary])
    browser.off('disconnected', canary)
  })

  it('copies the admitted identity before observing events', () => {
    const page = new EventEmitter()
    const browser = new EventEmitter()
    const supplied = { ...identity, rawURL: 'NO_LOG' }
    const recorder = createReliabilityRecord(
      supplied,
      page as unknown as Pick<Page, 'on' | 'off'>,
      browser as unknown as Pick<Browser, 'on' | 'off'>
    )
    supplied.worker = 7
    const result = recorder.finish('passed')
    expect(result.worker).toBe(0)
    expect(JSON.stringify(result)).not.toContain('NO_LOG')
  })

  it('projects events without retaining raw URLs, error text or platform payloads', () => {
    const active = fixture()
    const observed = {
      ...request('http://NO_LOG@localhost:4173/api/v1/me?value=NO_LOG#NO_LOG'),
      method: () => 'UNKNOWN',
      resourceType: () => 'unknown',
      body: 'NO_LOG',
      headers: { value: 'NO_LOG' },
    }
    active.page.emit('request', observed)
    active.page.emit('response', {
      request: () => observed,
      status: () => 999,
      rawURL: 'NO_LOG',
      body: 'NO_LOG',
    })
    active.page.emit('requestfinished', observed)
    active.page.emit('framenavigated', request('https://external.invalid/NO_LOG'))
    active.page.emit('framenavigated', request('not a URL NO_LOG'))
    active.page.emit('pageerror', new Error('NO_LOG'))
    active.browser.emit('disconnected')
    const result = active.recorder.finish('passed')
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('NO_LOG')
    expect(result.events).toContainEqual(
      expect.objectContaining({
        kind: 'request',
        method: 'OTHER',
        resource: 'other',
        category: 'me',
      })
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({ response: expect.objectContaining({ status: 'other' }) })
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({ category: 'external-or-opaque' })
    )
  })

  it('runs actual output guard refusals and restores pristine after every negative', () => {
    const pristine = completed()
    const original = JSON.stringify(pristine)
    const negatives = [
      { value: { ...pristine, rawURL: 'NO_LOG' }, reason: 'schema' },
      {
        value: {
          ...pristine,
          events: pristine.events.map((event) =>
            event.kind === 'finished' ? { ...event, request: 99 } : event
          ),
        },
        reason: 'order',
      },
      { value: { ...pristine, events: Array(257).fill(pristine.events[0]) }, reason: 'limit' },
      {
        value: {
          ...pristine,
          events: pristine.events.map((event) =>
            event.kind === 'request'
              ? { ...event, response: { ...event.response, rawURL: 'NO_LOG' } }
              : event
          ),
        },
        reason: 'schema',
      },
      {
        value: {
          ...pristine,
          events: pristine.events.map((event) =>
            event.kind === 'request'
              ? { ...event, response: { ...event.response, order: 0 } }
              : event
          ),
        },
        reason: 'order',
      },
      {
        value: {
          ...pristine,
          events: pristine.events
            .filter((event) => event.kind !== 'finished')
            .map((event, seq) => ({ ...event, seq })),
        },
        reason: 'order',
      },
    ]
    for (const negative of negatives) {
      expect(reliabilityRecordReason(negative.value)).toBe(negative.reason)
      expect(reliabilityRecordReason(pristine)).toBeUndefined()
      expect(JSON.stringify(pristine)).toBe(original)
    }
    expect(reliabilityGuardControls()).toEqual([
      'schema',
      'order',
      'order',
      'order',
      'limit',
      'limit',
      'bytes',
    ])
  })

  it('retains 120 complete request triples in exactly 256 rows and 376 observations', () => {
    const active = fixture()
    for (let index = 0; index < 120; index += 1) {
      const observed = request()
      active.page.emit('request', observed)
      active.page.emit('response', { request: () => observed, status: () => 200 })
      active.page.emit('requestfinished', observed)
    }
    for (let index = 0; index < 8; index += 1) active.recorder.mark('primary')
    for (let index = 0; index < 7; index += 1) active.page.emit('framenavigated', request())
    const result = active.recorder.finish('passed')
    const starts = result.events.filter((event) => event.kind === 'request')
    expect(result.version).toBe(3)
    expect(result.representation).toBe('response-inline')
    expect(result.events).toHaveLength(256)
    expect(starts).toHaveLength(120)
    expect(starts.every((event) => event.response?.status === 'success')).toBe(true)
    expect(result.events.filter((event) => event.kind === 'finished')).toHaveLength(120)
    expect(result.events.filter((event) => event.kind === 'phase')).toHaveLength(8)
    expect(result.events.filter((event) => event.kind === 'frame-navigation')).toHaveLength(7)
    expect(result.events.at(-1)).toMatchObject({ kind: 'end', order: 375 })
    const orders = result.events
      .flatMap((event) =>
        event.kind === 'request' && event.response
          ? [event.order, event.response.order]
          : [event.order]
      )
      .sort((left, right) => left - right)
    expect(orders).toEqual(Array.from({ length: 376 }, (_, index) => index))
    expect(result.pending).toEqual([])
    expect(result.disposition).toBe('complete')
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536)
  })

  it('preserves interleaved inline response phases, equal-time order and response-less failure', () => {
    const active = fixture()
    const first = request()
    const second = request()
    active.time(20)
    active.page.emit('request', first)
    active.time(20)
    active.page.emit('request', second)
    active.time(20)
    active.page.emit('response', { request: () => second, status: () => 201 })
    active.recorder.mark('authentication')
    active.page.emit('response', { request: () => first, status: () => 302 })
    active.page.emit('requestfinished', second)
    active.page.emit('requestfinished', first)
    const failed = request()
    active.page.emit('request', failed)
    active.page.emit('requestfailed', failed)
    const result = active.recorder.finish('passed')
    expect(result.events[0]).toMatchObject({
      order: 0,
      at: 10,
      phase: 'setup',
      response: { order: 4, at: 12, phase: 'authentication', status: 'redirect' },
    })
    expect(result.events[1]).toMatchObject({
      order: 1,
      at: 10,
      response: { order: 2, at: 10, phase: 'setup', status: 'success' },
    })
    expect(result.events[2]).toMatchObject({ kind: 'phase', order: 3, phase: 'authentication' })
    expect(result.events[3]).toMatchObject({ kind: 'finished', request: 2, order: 5 })
    expect(result.events[4]).toMatchObject({ kind: 'finished', request: 1, order: 6 })
    expect(result.events[5]).not.toHaveProperty('response')
    expect(result.events[6]).toMatchObject({ kind: 'failed', request: 3, order: 8 })
    expect(reliabilityRecordReason(result)).toBeUndefined()
    const original = JSON.stringify(result)
    for (const order of [0, 5]) {
      const changed = structuredClone(result)
      const start = changed.events[0]!
      if (start.kind !== 'request' || !start.response) throw new Error('RECORD_FIXTURE')
      start.response.order = order
      expect(reliabilityRecordReason(changed)).toBe('order')
      expect(reliabilityRecordReason(result)).toBeUndefined()
      expect(JSON.stringify(result)).toBe(original)
    }
    const afterTerminal = structuredClone(result)
    const start = afterTerminal.events[0]!
    if (start.kind !== 'request' || !start.response) throw new Error('RECORD_FIXTURE')
    start.response.order = 6
    afterTerminal.events[3]!.order = 4
    afterTerminal.events[4]!.order = 5
    expect(reliabilityRecordReason(afterTerminal)).toBe('order')
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(JSON.stringify(result)).toBe(original)
    active.page.emit('response', { request: () => first, status: () => 500 })
    expect(JSON.stringify(result)).toBe(original)
    expect(active.recorder.finish('passed')).toEqual(result)
  })

  it('preserves a safe 255-row prefix on overflow without inventing an end', async () => {
    const active = fixture()
    for (let index = 0; index < 255; index += 1) active.recorder.mark('primary')
    active.recorder.mark('billing')
    const result = active.recorder.finish('passed')
    const expected = Array.from({ length: 255 }, (_, index) => ({
      kind: 'phase',
      seq: index,
      order: index,
      at: index + 1,
      phase: 'primary',
    }))
    expect(result.reason).toBe('events')
    expect(result.events).toHaveLength(255)
    expect(JSON.stringify(result.events)).toBe(JSON.stringify(expected))
    expect(result.events.some((event) => event.kind === 'end')).toBe(false)
    expect(result.pending).toEqual([])
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(reliabilityRecordReason({ ...result, disposition: 'complete', reason: 'none' })).toBe(
      'order'
    )
    const saved = JSON.stringify(result)
    active.recorder.mark('invoice')
    expect(JSON.stringify(active.recorder.finish('passed'))).toBe(saved)
    expect(active.page.eventNames()).toEqual([])
    expect(active.browser.eventNames()).toEqual([])
    await expect(
      finalizeReliabilityRecord(
        active.recorder,
        'passed',
        undefined,
        async () => {},
        () => {},
        () => {}
      )
    ).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
    expect(reliabilityRecordReason(completed())).toBeUndefined()
  })

  it.each(['start', 'terminal'] as const)(
    'retains transactional pending state when a %s row is refused',
    (boundary) => {
      const active = fixture()
      const observed = request()
      active.page.emit('request', observed)
      for (let index = 0; index < 254; index += 1) active.recorder.mark('primary')
      if (boundary === 'start') active.page.emit('request', request())
      else active.page.emit('requestfinished', observed)
      const result = active.recorder.finish('passed')
      const expected = [
        {
          kind: 'request',
          request: 1,
          method: 'GET',
          resource: 'fetch',
          category: 'me',
          seq: 0,
          order: 0,
          at: 1,
          phase: 'setup',
        },
        ...Array.from({ length: 254 }, (_, index) => ({
          kind: 'phase',
          seq: index + 1,
          order: index + 1,
          at: index + 2,
          phase: 'primary',
        })),
      ]
      expect(result.reason).toBe('events')
      expect(result.events).toHaveLength(255)
      expect(JSON.stringify(result.events)).toBe(JSON.stringify(expected))
      expect(result.events.filter((event) => event.kind === 'request')).toHaveLength(1)
      expect(result.events.some((event) => event.kind === 'finished')).toBe(false)
      expect(result.pending).toEqual([1])
      expect(reliabilityRecordReason(result)).toBeUndefined()
      active.page.emit('request', request())
      active.page.emit('requestfinished', observed)
      expect(JSON.stringify(active.recorder.finish('passed').events)).toBe(JSON.stringify(expected))
      expect(active.recorder.finish('passed').pending).toEqual([1])
      expect(reliabilityRecordReason(completed())).toBeUndefined()
    }
  )

  it('refuses a 65th pending start without admitting a phantom ordinal', () => {
    const active = fixture()
    for (let index = 0; index < 65; index += 1) active.page.emit('request', request())
    const result = active.recorder.finish('passed')
    expect(result.reason).toBe('pending')
    expect(result.events).toHaveLength(64)
    expect(result.pending).toEqual(Array.from({ length: 64 }, (_, index) => index + 1))
    expect(result.events.at(-1)).toMatchObject({ kind: 'request', request: 64, order: 63 })
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(reliabilityRecordReason(completed())).toBeUndefined()
  })

  it.each(['duplicate', 'backwards'] as const)(
    'retains the exact prefix on %s inline response refusal',
    (cause) => {
      const active = fixture()
      const observed = request()
      active.page.emit('request', observed)
      if (cause === 'duplicate')
        active.page.emit('response', { request: () => observed, status: () => 200 })
      active.recorder.mark('primary')
      if (cause === 'backwards') active.time(11)
      active.page.emit('response', { request: () => observed, status: () => 500 })
      const result = active.recorder.finish('passed')
      const expected = [
        {
          kind: 'request',
          request: 1,
          method: 'GET',
          resource: 'fetch',
          category: 'me',
          seq: 0,
          order: 0,
          at: 1,
          phase: 'setup',
          ...(cause === 'duplicate'
            ? { response: { order: 1, at: 2, phase: 'setup', status: 'success' } }
            : {}),
        },
        {
          kind: 'phase',
          seq: 1,
          order: cause === 'duplicate' ? 2 : 1,
          at: cause === 'duplicate' ? 3 : 2,
          phase: 'primary',
        },
      ]
      expect(result.reason).toBe('observer')
      expect(result.events).toHaveLength(2)
      expect(JSON.stringify(result.events)).toBe(JSON.stringify(expected))
      expect(result.pending).toEqual([1])
      expect(result.disposition).toBe('incomplete')
      expect(reliabilityRecordReason(result)).toBeUndefined()
      expect(active.page.eventNames()).toEqual([])
      expect(active.browser.eventNames()).toEqual([])
      active.page.emit('response', { request: () => observed, status: () => 302 })
      expect(JSON.stringify(active.recorder.finish('passed').events)).toBe(JSON.stringify(expected))
      expect(active.recorder.finish('passed').pending).toEqual([1])
      expect(reliabilityRecordReason(completed())).toBeUndefined()
    }
  )

  it('checks response time against the latest global boundary, not its earlier request row', () => {
    const active = fixture()
    const first = request()
    const second = request()
    active.page.emit('request', first)
    active.page.emit('request', second)
    active.time(30)
    active.page.emit('response', { request: () => first, status: () => 200 })
    active.time(29)
    active.page.emit('response', { request: () => second, status: () => 200 })
    const result = active.recorder.finish('passed')
    expect(result.reason).toBe('observer')
    expect(result.events[0]).toMatchObject({ response: { order: 2, at: 20 } })
    expect(result.events[1]).not.toHaveProperty('response')
    expect(result.pending).toEqual([1, 2])
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(reliabilityRecordReason(completed())).toBeUndefined()
  })

  it('accounts for excluded resources without ordinals or unobserved-boundary spam', () => {
    const active = fixture()
    for (const url of [
      'http://localhost:4173/assets/font-NO_LOG.woff2',
      'https://external.invalid/NO_LOG',
    ]) {
      const ignored = request(url)
      active.page.emit('request', ignored)
      active.page.emit('response', { request: () => ignored, status: () => 200 })
      active.page.emit('requestfinished', ignored)
    }
    const bootstrap = request('http://localhost:4173/assets/index-fixture.js')
    active.page.emit('request', bootstrap)
    active.page.emit('requestfinished', bootstrap)
    const result = active.recorder.finish('passed')
    expect(result.coverage).toBe('allowlisted-phase-only')
    expect(result.assetMapping).toBe('pattern-only')
    expect(result.excludedRequests).toBe(2)
    expect(result.events.filter((event) => event.kind === 'request')).toHaveLength(1)
    expect(result.events).toContainEqual(
      expect.objectContaining({ category: 'bootstrap-script', request: 1 })
    )
    expect(result.events.some((event) => event.kind === 'unobserved-boundary')).toBe(false)
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(reliabilityRecordReason({ ...result, excludedRequests: 257 })).toBe('limit')
    expect(reliabilityRecordReason({ ...result, coverage: 'all' })).toBe('schema')
  })

  it('labels known asset prefixes as patterns and preserves unknown local scripts', () => {
    const active = fixture()
    for (const path of [
      '/assets/index-fixture.js',
      '/assets/main-fixture.js',
      '/assets/browser-fixture.js',
      '/assets/new-bundle-fixture.js',
    ]) {
      const observed = request(`http://localhost:4173${path}`)
      active.page.emit('request', observed)
      active.page.emit('requestfinished', observed)
    }
    const result = active.recorder.finish('passed')
    expect(
      result.events.filter((event) => event.kind === 'request').map((event) => event.category)
    ).toEqual(['bootstrap-script', 'main-script', 'mock-runtime-script', 'unknown-local-script'])
    expect(result.assetMapping).toBe('pattern-only')
    expect(reliabilityRecordReason(result)).toBeUndefined()
  })

  describe('files the console fetches on demand', () => {
    const deferredChunk = (name: string) => request(`http://localhost:4173/assets/${name}`)
    const fetchWhole = (
      active: ReturnType<typeof fixture>,
      observed: ReturnType<typeof request>
    ) => {
      active.page.emit('request', observed)
      active.page.emit('response', { request: () => observed, status: () => 200 })
      active.page.emit('requestfinished', observed)
    }

    it('counts a lazy route, its layout, a library and a catalogue without a row each', () => {
      const active = fixture()
      for (const name of [
        'route-people-fixture.js',
        'console-fixture.js',
        'vendor-matrix-fixture.js',
        'i18n-fr-people-fixture.js',
        'i18n-en-console-fixture.js',
      ])
        fetchWhole(active, deferredChunk(name))
      fetchWhole(active, request())
      const result = active.recorder.finish('passed')
      expect(result.deferredChunks).toBe(5)
      expect(result.excludedRequests).toBe(0)
      // The call to Core is the first request with a row, and the only one: no ordinal was spent
      // on a chunk, and none of the three boundaries of a chunk is reported as unobserved.
      expect(result.events.filter((event) => event.kind === 'request')).toEqual([
        expect.objectContaining({ category: 'me', request: 1, seq: 0, order: 0 }),
      ])
      expect(result.events.some((event) => event.kind === 'unobserved-boundary')).toBe(false)
      expect(result.pending).toEqual([])
      expect(result.disposition).toBe('complete')
      expect(reliabilityRecordReason(result)).toBeUndefined()
    })

    it('still gives a row to the application, and to a script it has no name for', () => {
      const active = fixture()
      for (const name of [
        'app-fixture.js',
        // Not one of the four names `vite.config.ts` gives a deferred chunk: a near miss is a
        // script nobody has a name for, and that is exactly what a row is for.
        'routes-fixture.js',
        'vendor.js',
        'i18n-fixture.css.js.map',
        'nested/route-people-fixture.js',
        'rolldown-runtime-fixture.js',
      ])
        fetchWhole(active, deferredChunk(name))
      const result = active.recorder.finish('passed')
      expect(result.deferredChunks).toBe(0)
      expect(
        result.events.filter((event) => event.kind === 'request').map((event) => event.category)
      ).toEqual([
        'application-script',
        'unknown-local-script',
        'unknown-local-script',
        'unknown-local-script',
        'unknown-local-script',
      ])
      // The source map is no script at all: it is excluded as any other local resource is.
      expect(result.excludedRequests).toBe(1)
      expect(reliabilityRecordReason(result)).toBeUndefined()
    })

    it('still trips the event cap on calls to Core, however many chunks came first', () => {
      const active = fixture()
      for (let index = 0; index < 200; index += 1)
        fetchWhole(active, deferredChunk(`route-area${index}-fixture.js`))
      // 127 complete calls are 254 rows; the 128th starts on row 255 and cannot finish.
      for (let index = 0; index < 128; index += 1) fetchWhole(active, request())
      const result = active.recorder.finish('passed')
      expect(result.reason).toBe('events')
      expect(result.disposition).toBe('incomplete')
      expect(result.events).toHaveLength(255)
      expect(result.events.some((event) => event.kind === 'end')).toBe(false)
      expect(result.deferredChunks).toBe(200)
      expect(result.pending).toEqual([128])
      expect(reliabilityRecordReason(result)).toBeUndefined()
      expect(reliabilityRecordReason({ ...result, disposition: 'complete', reason: 'none' })).toBe(
        'order'
      )
    })

    it('still trips the event cap on scripts it has no name for', () => {
      const active = fixture()
      for (let index = 0; index < 128; index += 1)
        fetchWhole(active, deferredChunk(`unnamed${index}-fixture.js`))
      const result = active.recorder.finish('passed')
      expect(result.reason).toBe('events')
      expect(result.events).toHaveLength(255)
      expect(result.deferredChunks).toBe(0)
      expect(reliabilityRecordReason(result)).toBeUndefined()
    })

    it('stops at the 257th chunk: counted is not the same as without limit', () => {
      const active = fixture()
      for (let index = 0; index < 256; index += 1)
        fetchWhole(active, deferredChunk(`i18n-fr-area${index}-fixture.js`))
      const within = fixture()
      for (let index = 0; index < 256; index += 1)
        fetchWhole(within, deferredChunk(`i18n-fr-area${index}-fixture.js`))
      expect(within.recorder.finish('passed')).toMatchObject({
        deferredChunks: 256,
        disposition: 'complete',
        reason: 'none',
      })

      fetchWhole(active, deferredChunk('vendor-livekit-fixture.js'))
      const result = active.recorder.finish('passed')
      expect(result.reason).toBe('events')
      expect(result.disposition).toBe('incomplete')
      expect(result.deferredChunks).toBe(256)
      expect(result.events).toEqual([])
      expect(reliabilityRecordReason(result)).toBeUndefined()
      // Observation stopped with the refusal: nothing after it is counted or given a row.
      expect(active.page.eventNames()).toEqual([])
      fetchWhole(active, request())
      expect(active.recorder.finish('passed').events).toEqual([])
    })

    it('refuses a record whose chunk count is missing, malformed or over its bound', () => {
      const result = completed()
      expect(result.deferredChunks).toBe(0)
      expect(reliabilityRecordReason({ ...result, deferredChunks: 256 })).toBeUndefined()
      expect(reliabilityRecordReason({ ...result, deferredChunks: 257 })).toBe('limit')
      for (const deferredChunks of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])
        expect(reliabilityRecordReason({ ...result, deferredChunks })).toBe('schema')
      const { deferredChunks: _absent, ...without } = result
      expect(reliabilityRecordReason(without)).toBe('schema')
      // The record that came before had no such field and said so by its version.
      expect(reliabilityRecordReason({ ...without, version: 2 })).toBe('schema')
      expect(reliabilityRecordReason({ ...result, version: 2 })).toBe('schema')
    })
  })

  it('distinguishes native unobserved starts from corrupt observed completion ordinals', () => {
    const active = fixture()
    const earlier = request()
    active.page.emit('response', { request: () => earlier, status: () => 200 })
    active.page.emit('requestfinished', earlier)
    const pending = request()
    active.page.emit('request', pending)
    const result = active.recorder.finish('failed')
    expect(result.events.filter((event) => event.kind === 'unobserved-boundary')).toHaveLength(2)
    expect(result.pending).toEqual([1])
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(reliabilityRecordReason({ ...result, pending: [] })).toBe('order')
  })

  it.each(['events', 'pending', 'observer'] as const)('refuses %s inside emit', (reason) => {
    const active = fixture()
    if (reason === 'events') {
      for (let index = 0; index < 257; index += 1) active.recorder.mark('primary')
    } else if (reason === 'pending') {
      for (let index = 0; index < 65; index += 1) active.page.emit('request', request())
    } else {
      active.time(-1)
      active.recorder.mark('primary')
    }
    const result = active.recorder.finish('passed')
    expect(result.reason).toBe(reason)
    expect(result.disposition).toBe('incomplete')
    expect(reliabilityRecordReason(result)).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536)
    expect(active.page.eventNames()).toEqual([])
    expect(active.browser.eventNames()).toEqual([])
  })

  it('refuses duplicate completion and invalid output shapes', () => {
    const pristine = completed()
    const duplicate = structuredClone(pristine)
    duplicate.events.splice(2, 0, { ...duplicate.events[1]!, seq: 2, order: 3 })
    expect(reliabilityRecordReason(duplicate)).toBe('order')
    const backwards = structuredClone(pristine)
    backwards.events[1]!.at = -1
    expect(reliabilityRecordReason(backwards)).toBe('order')
    expect(reliabilityRecordReason({ ...pristine, worker: Infinity })).toBe('schema')
    expect(reliabilityRecordReason({ ...pristine, extra: 'NO_LOG' })).toBe('schema')
  })

  it('refuses the exact byte-budget input and restores its fixed boundary', () => {
    const pristine = completed()
    expect(reliabilityByteBudget(Buffer.byteLength(JSON.stringify(pristine), 'utf8'))).toBe(true)
    expect(reliabilityByteBudget(65536)).toBe(true)
    expect(reliabilityByteBudget(65537), 'RELIABILITY_BYTE_OVERFLOW').toBe(false)
    expect(reliabilityByteBudget(65536), 'RELIABILITY_BYTE_RESTORED').toBe(true)
    for (const bytes of [-1, 0.5, NaN, Infinity]) expect(reliabilityByteBudget(bytes)).toBe(false)
  })

  it('preserves exact original errors while reporting secondary attachment failure', async () => {
    const active = fixture()
    const original = new Error('NO_LOG')
    const errors = [original]
    const codes: string[] = []
    await finalizeReliabilityRecord(
      active.recorder,
      'failed',
      errors[0],
      async () => {
        throw new Error('NO_LOG')
      },
      (code) => codes.push(code),
      () => {}
    )
    expect(errors).toEqual([original])
    expect(errors[0]).toBe(original)
    expect(codes).toEqual(['attachment'])
    const passed = fixture()
    await expect(
      finalizeReliabilityRecord(
        passed.recorder,
        'passed',
        undefined,
        async () => {
          throw new Error('NO_LOG')
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
  })

  it('detaches before pending attachment and preserves foreign ownership', async () => {
    const active = fixture()
    let foreign = 0
    const canary = () => foreign++
    active.browser.on('disconnected', canary)
    const timer = setTimeout(() => {}, 10000)
    let release: () => void = () => {}
    const attachment = new Promise<void>((resolve) => (release = resolve))
    let entered: () => void = () => {}
    const attaching = new Promise<void>((resolve) => (entered = resolve))
    let bytes: Buffer | undefined
    try {
      const finalizing = finalizeReliabilityRecord(
        active.recorder,
        'passed',
        undefined,
        async (body) => {
          bytes = body
          entered()
          await attachment
        },
        () => {},
        () => {}
      )
      expect(active.page.eventNames()).toEqual([])
      expect(active.browser.listenerCount('disconnected')).toBe(1)
      expect(timer.hasRef()).toBe(true)
      await attaching
      const saved = bytes!.toString()
      active.browser.emit('disconnected')
      active.page.emit('request', request())
      expect(foreign).toBe(1)
      expect(bytes!.toString()).toBe(saved)
      expect(active.recorder.finish('passed')).toEqual(JSON.parse(saved))
      release()
      await finalizing
    } finally {
      release()
      clearTimeout(timer)
      active.browser.off('disconnected', canary)
    }
  })

  it('refuses cleanup contamination without replacing a primary failure', async () => {
    const active = fixture()
    const originalOff = active.browser.off.bind(active.browser)
    active.browser.off = (kind, listener) => {
      originalOff(kind, listener)
      throw new Error('NO_LOG')
    }
    const codes: string[] = []
    const original = new Error('NO_LOG')
    await finalizeReliabilityRecord(
      active.recorder,
      'failed',
      original,
      async () => {},
      (code) => codes.push(code),
      () => {}
    )
    expect(codes).toEqual(['cleanup'])
    expect(active.browser.eventNames()).toEqual([])
    expect(original.message).toBe('NO_LOG')
  })

  it.each(['single', 'multipart'] as const)(
    'publishes an exact %s closed receipt after cleanup',
    async (size) => {
      const record = size === 'single' ? completed() : pressureRecord()
      const lines: string[] = []
      let attached: Buffer | undefined
      await finalizeReliabilityRecord(
        { finish: () => record, mark: () => {} },
        'passed',
        undefined,
        async (body) => {
          attached = body
        },
        () => {},
        (line) => {
          lines.push(line)
        }
      )
      const reconstructed = expectReceipt(lines, record)
      expect(attached!.equals(reconstructed)).toBe(true)
      expect(lines.length).toBe(size === 'single' ? 2 : Math.ceil(reconstructed.length / 4096) + 1)
      if (size === 'multipart') {
        expect(lines.length).toBeGreaterThan(2)
        expect(record.events).toHaveLength(256)
        expect(
          record.events.filter((event) => event.kind === 'request' && event.response)
        ).toHaveLength(120)
        expect(record.events.at(-1)?.order).toBe(375)
        expect(record.pending).toEqual([])
      }
    }
  )

  it('exports a useful incomplete prefix without making its capture complete', async () => {
    const active = fixture()
    for (let index = 0; index < 256; index += 1) active.recorder.mark('primary')
    const record = active.recorder.finish('passed')
    const lines: string[] = []
    const codes: string[] = []
    await expect(
      finalizeReliabilityRecord(
        active.recorder,
        'passed',
        undefined,
        async () => {},
        (code) => codes.push(code),
        (line) => {
          lines.push(line)
        }
      )
    ).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
    expectReceipt(lines, record)
    expect(record.events).toHaveLength(255)
    expect(record.reason).toBe('events')
    expect(codes).toEqual(['events'])
    const pristine = createReliabilityReceipt(completed())
    expectReceipt([...pristine.parts, pristine.end.ok], completed())
  })

  it('refuses actual missing, duplicate, reversed, corrupt, foreign and over-bound output controls', async () => {
    const record = pressureRecord()
    const packet = createReliabilityReceipt(record)
    const pristine = [...packet.parts, packet.end.ok]
    const original = JSON.stringify(pristine)
    const corrupt = [...pristine]
    const payload = corrupt[0]!.indexOf(' data=') + 6
    corrupt[0] = `${corrupt[0]!.slice(0, payload)}!${corrupt[0]!.slice(payload + 1)}`
    const badDigest = pristine.map((line) =>
      line.replace(/sha256=[a-f0-9]{64}/, `sha256=${'0'.repeat(64)}`)
    )
    const negatives = [
      { lines: pristine.slice(1), reason: 'RECEIPT_FRAMES' },
      { lines: [pristine[0]!, ...pristine], reason: 'RECEIPT_FRAMES' },
      { lines: [pristine[1]!, pristine[0]!, ...pristine.slice(2)], reason: 'RECEIPT_HEADER' },
      { lines: corrupt, reason: 'RECEIPT_BODY' },
      { lines: badDigest, reason: 'RECEIPT_HEADER' },
      {
        lines: [pristine[0]!.replace('case=C1', 'case=C2'), ...pristine.slice(1)],
        reason: 'RECEIPT_HEADER',
      },
      { lines: pristine.slice(0, -1), reason: 'RECEIPT_FRAMES' },
      { lines: [...pristine, pristine.at(-1)!], reason: 'RECEIPT_FRAMES' },
      {
        lines: [`${pristine[0]}${' '.repeat(4353)}`, ...pristine.slice(1)],
        reason: 'RECEIPT_LINE',
      },
      {
        lines: [pristine[0]!.replace(/part=1\/\d+/, 'part=1/17'), ...pristine.slice(1)],
        reason: 'RECEIPT_HEADER',
      },
      { lines: [`${pristine[0]}\n`, ...pristine.slice(1)], reason: 'RECEIPT_ASCII' },
    ]
    for (const negative of negatives) {
      expect(() => expectReceipt(negative.lines, record)).toThrow(negative.reason)
      const restored = createReliabilityReceipt(record)
      expectReceipt([...restored.parts, restored.end.ok], record)
      expect(JSON.stringify(pristine)).toBe(original)
    }
    const omitted: string[] = []
    let writes = 0
    await finalizeReliabilityRecord(
      { finish: () => record, mark: () => {} },
      'passed',
      undefined,
      async () => {},
      () => {},
      (line) => {
        if (writes++ !== 0) omitted.push(line)
      }
    )
    expect(() => expectReceipt(omitted, record)).toThrow('RECEIPT_FRAMES')
    expectReceipt([...packet.parts, packet.end.ok], record)
  })

  it('refuses unsafe object and actual serialized-buffer payloads before any output', async () => {
    const pristine = completed()
    const nested = structuredClone(pristine)
    const first = nested.events[0]!
    if (first.kind !== 'request' || !first.response) throw new Error('RECORD_FIXTURE')
    Object.assign(first.response, { rawURL: 'NO_LOG' })
    const serialized = Object.setPrototypeOf(
      { ...pristine },
      { toJSON: () => ({ rawURL: 'NO_LOG', reason: 'NO_LOG' }) }
    )
    for (const invalid of [
      { ...pristine, rawURL: 'NO_LOG', reason: 'NO_LOG' },
      nested,
      serialized,
    ]) {
      const lines: string[] = []
      const codes: string[] = []
      let attachments = 0
      expect(() => createReliabilityReceipt(invalid)).toThrow('E2E_RECORD_PUBLICATION')
      await expect(
        finalizeReliabilityRecord(
          { finish: () => invalid as typeof pristine, mark: () => {} },
          'passed',
          undefined,
          async () => {
            attachments += 1
          },
          (code) => codes.push(code),
          (line) => {
            lines.push(line)
          }
        )
      ).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
      expect(lines).toEqual([])
      expect(attachments).toBe(0)
      expect(codes).toEqual(['publication'])
      const restored = createReliabilityReceipt(pristine)
      expectReceipt([...restored.parts, restored.end.ok], pristine)
    }
  })

  it.each(['first', 'middle', 'end'] as const)(
    'handles an actual %s writer failure without losing primary or attachment',
    async (site) => {
      for (const status of ['passed', 'failed'] as const) {
        const active = fixture()
        for (let index = 0; index < 100; index += 1) active.recorder.mark('primary')
        const original = new Error('NO_LOG')
        const errors = [original]
        const lines: string[] = []
        const codes: string[] = []
        let writes = 0
        let attachments = 0
        const foreign = () => {}
        active.browser.on('disconnected', foreign)
        const running = finalizeReliabilityRecord(
          active.recorder,
          status,
          status === 'failed' ? errors[0] : undefined,
          async (body) => {
            attachments += 1
            expect(body.toString()).toBe(JSON.stringify(active.recorder.finish(status)))
          },
          (code) => codes.push(code),
          (line) => {
            expect(active.page.eventNames()).toEqual([])
            expect(active.browser.listeners('disconnected')).toEqual([foreign])
            const index = writes++
            if (site === 'middle' && index === 1) return Promise.reject(new Error('NO_LOG'))
            if (
              (site === 'first' && index === 0) ||
              (site === 'end' && line.startsWith('E2E_RELIABILITY_V3_END'))
            )
              throw new Error('NO_LOG')
            lines.push(line)
          }
        )
        try {
          if (status === 'passed')
            await expect(running).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
          else await expect(running).resolves.toBeUndefined()
          const packet = createReliabilityReceipt(active.recorder.finish(status))
          const failureIndex = site === 'first' ? 0 : site === 'middle' ? 1 : packet.parts.length
          expect(packet.parts.length).toBeGreaterThan(1)
          expect(attachments).toBe(1)
          expect(writes).toBe(failureIndex + 1)
          expect(codes).toEqual(['publication'])
          expect(lines.some((line) => line.startsWith('E2E_RELIABILITY_V3_END'))).toBe(false)
          expect(lines.join('')).not.toContain('NO_LOG')
          expect(errors[0]).toBe(original)
        } finally {
          active.browser.off('disconnected', foreign)
        }
        const restored = fixture()
        const restoredLines: string[] = []
        await finalizeReliabilityRecord(
          restored.recorder,
          'passed',
          undefined,
          async () => {},
          () => {},
          (line) => {
            restoredLines.push(line)
          }
        )
        expectReceipt(restoredLines, restored.recorder.finish('passed'))
      }
    }
  )

  it('awaits only owned sequential handoff writes after detaching observers', async () => {
    const active = fixture()
    const observed = request()
    active.page.emit('request', observed)
    active.page.emit('response', { request: () => observed, status: () => 200 })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const lines: string[] = []
    let attachments = 0
    const timer = setTimeout(() => {}, 10000)
    const foreign = () => {}
    active.browser.on('disconnected', foreign)
    const running = finalizeReliabilityRecord(
      active.recorder,
      'passed',
      undefined,
      async () => {
        attachments += 1
      },
      () => {},
      (line) => {
        lines.push(line)
        return lines.length === 1 ? held : undefined
      }
    )
    try {
      expect(lines).toHaveLength(1)
      expect(attachments).toBe(0)
      expect(active.page.eventNames()).toEqual([])
      expect(active.browser.listeners('disconnected')).toEqual([foreign])
      expect(timer.hasRef()).toBe(true)
      const prefix = lines[0]
      active.page.emit('requestfinished', observed)
      active.browser.emit('disconnected')
      expect(lines[0]).toBe(prefix)
      release()
      await running
      expect(attachments).toBe(1)
      const record = active.recorder.finish('passed')
      expectReceipt(lines, record)
      expect(record.pending).toEqual([1])
    } finally {
      release()
      try {
        await running
      } finally {
        clearTimeout(timer)
        active.browser.off('disconnected', foreign)
      }
    }
  })

  it('binds failed attachment and preserves all ordered fixed reports despite reporter throws', async () => {
    const attached = fixture()
    const record = attached.recorder.finish('passed')
    const lines: string[] = []
    const codes: string[] = []
    await expect(
      finalizeReliabilityRecord(
        attached.recorder,
        'passed',
        undefined,
        async () => {
          throw new Error('NO_LOG')
        },
        (code) => codes.push(code),
        (line) => {
          lines.push(line)
        }
      )
    ).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
    expectReceipt(lines, record, 'failed')
    expect(codes).toEqual(['attachment'])
    for (const status of ['passed', 'failed'] as const) {
      const active = fixture()
      for (let index = 0; index < 256; index += 1) active.recorder.mark('primary')
      const original = new Error('NO_LOG')
      const errors = [original]
      const reports: string[] = []
      let attachments = 0
      const running = finalizeReliabilityRecord(
        active.recorder,
        status,
        status === 'failed' ? errors[0] : undefined,
        async () => {
          attachments += 1
          throw new Error('NO_LOG')
        },
        (code) => {
          reports.push(code)
          throw new Error('NO_LOG')
        },
        async () => {
          throw new Error('NO_LOG')
        }
      )
      if (status === 'passed') await expect(running).rejects.toThrow('E2E_DIAGNOSTIC_INCOMPLETE')
      else await expect(running).resolves.toBeUndefined()
      expect(reports).toEqual(['events', 'attachment', 'publication'])
      expect(attachments).toBe(1)
      expect(errors[0]).toBe(original)
      const restored = createReliabilityReceipt(completed())
      expectReceipt([...restored.parts, restored.end.ok], completed())
    }
  })

  it('refuses an actual retained-listener control and restores pristine cleanup', () => {
    const contaminated = fixture()
    const remove = contaminated.browser.off.bind(contaminated.browser)
    contaminated.browser.off = () => contaminated.browser
    contaminated.recorder.finish('passed')
    const acceptance = () =>
      expect(contaminated.browser.listenerCount('disconnected'), 'RELIABILITY_LISTENERS').toBe(0)
    expect(acceptance).toThrow('RELIABILITY_LISTENERS')
    for (const listener of contaminated.browser.listeners('disconnected'))
      remove('disconnected', listener)
    const pristine = fixture()
    pristine.recorder.finish('passed')
    expect(pristine.browser.listenerCount('disconnected'), 'RELIABILITY_LISTENERS').toBe(0)
  })
})
