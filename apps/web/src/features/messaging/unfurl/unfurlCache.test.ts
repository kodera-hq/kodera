import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, UnfurlCache } from './unfurlCache'

/** A fetch the test settles by hand, so "in flight" is exact, not a race. */
interface Deferred {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((settled) => {
    resolve = settled
  })
  return { promise, resolve }
}

/** Lets the fetch promises' `then` callbacks run; no timers, so the test stays deterministic. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const ORG = 'org'
const url = (n: number) => `https://exemple.fr/${n}`

describe('UnfurlCache', () => {
  it('asks once per address, and remembers a refusal as none', async () => {
    const fetches: string[] = []
    const cache = new UnfurlCache((_organisationId, requested) => {
      fetches.push(requested)
      return requested.endsWith('/refused')
        ? Promise.reject(new Error('refused'))
        : Promise.resolve({ url: requested, title: 'Un titre' })
    })
    const ok = 'https://exemple.fr/ok'
    const refused = 'https://exemple.fr/refused'

    cache.request(ORG, ok)
    cache.request(ORG, ok)
    cache.request(ORG, refused)
    expect(fetches).toEqual([ok, refused])
    expect(cache.card(ORG, ok)).toBeUndefined()

    await flush()
    expect(cache.card(ORG, ok)).toMatchObject({ host: 'exemple.fr', title: 'Un titre' })
    expect(cache.card(ORG, refused)).toBeNull()

    // A refused preview is remembered: the address is not asked for again.
    cache.request(ORG, refused)
    expect(fetches).toHaveLength(2)
  })

  it('never grows past MAX_ENTRIES when an evicted in-flight request settles late', async () => {
    const fetches: string[] = []
    const pending = new Map<string, Deferred>()
    const cache = new UnfurlCache((_organisationId, requested) => {
      fetches.push(requested)
      const held = deferred()
      pending.set(requested, held)
      return held.promise
    })
    let notifications = 0
    cache.subscribe(() => notifications++)

    // The cap's worth of requests in flight, then one more: the oldest (url(0)) is evicted
    // while its fetch is still running.
    for (let n = 0; n <= MAX_ENTRIES; n++) cache.request(ORG, url(n))
    expect(fetches).toHaveLength(MAX_ENTRIES + 1)

    // The evicted request settles first, while every other is still in flight: it stays out,
    // so it draws no card and tells no listener.
    pending.get(url(0))!.resolve({ url: url(0), title: 'evicted' })
    await flush()
    expect(cache.card(ORG, url(0))).toBeUndefined()
    expect(notifications).toBe(0)

    // The rest settle: exactly the cap's worth of cards, none of them the evicted address.
    for (let n = 1; n <= MAX_ENTRIES; n++) {
      pending.get(url(n))!.resolve({ url: url(n), title: `t${n}` })
    }
    await flush()
    expect(notifications).toBe(MAX_ENTRIES)
    for (let n = 1; n <= MAX_ENTRIES; n++) expect(cache.card(ORG, url(n))?.title).toBe(`t${n}`)
    expect(cache.card(ORG, url(0))).toBeUndefined()

    // The evicted address is asked for again like a fresh one.
    cache.request(ORG, url(0))
    expect(fetches.filter((requested) => requested === url(0))).toHaveLength(2)
  })
})
