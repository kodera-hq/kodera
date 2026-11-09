import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSessionSnapshot } from '../auth/AuthAdapter'
import { createCurrentUserLoader } from './currentUser'
import { ApiProblem, NetworkError } from '../api/client'
import type * as ApiClient from '../api/client'

const get = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  coreApi: () => ({ GET: get }),
}))

const me = {
  id: 'synthetic-new-person',
  email: 'new@example.test',
  locale: 'fr',
  staff: false,
  identities: [],
  organisations: [],
} as const

function expectAuthorityCancellation(value: unknown): void {
  const failure = value as { name?: unknown; message?: unknown }
  expect(
    (failure.name === 'AbortError' && failure.message === 'Credential authority ended.') ||
      failure.message === 'CancelledError'
  ).toBe(true)
}

function context(retry: false | number | ((count: number, error: Error) => boolean) = false) {
  let token: string | undefined = 'synthetic-a'
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  }
  const listeners = new Set<() => void>()
  const client = new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0 } } })
  const adapter = {
    getSnapshot: () => snapshot,
    getAccessToken: () => token,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    restoreSession: vi.fn(async () => snapshot.status === 'ready'),
  }
  const rotate = (nextToken: string | undefined) => {
    if (token === nextToken) return
    token = nextToken
    snapshot = {
      ...snapshot,
      credentialGeneration: snapshot.credentialGeneration + 1,
    }
    listeners.forEach((listener) => listener())
  }
  const replace = (ready: boolean) => {
    token = ready ? 'replacement' : undefined
    snapshot = {
      status: ready ? 'ready' : 'unauthenticated',
      generation: snapshot.generation + 1,
      credentialGeneration: snapshot.credentialGeneration + 1,
      user: ready ? { realm: 'bravo' } : undefined,
    }
    listeners.forEach((listener) => listener())
  }
  return {
    client,
    adapter,
    rotate,
    replace,
    load: createCurrentUserLoader(adapter, client),
  }
}

beforeEach(() => {
  get.mockReset()
})
describe('current identity belongs to the exact credential generation', () => {
  it('shares one fresh identity read and ignores every older query shape', async () => {
    const { client, load } = context()
    client.setQueryData(['me'], { id: 'legacy' })
    client.setQueryData(['me', 1], { id: 'session-only' })
    let resolve!: (value: unknown) => void
    get.mockReturnValue(new Promise((done) => (resolve = done)))
    const first = load()
    const second = load()
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    resolve({ data: me })
    const expected = { me, generation: 1, credentialGeneration: 1 }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    expect(client.getQueryData(['me'])).toBeUndefined()
    expect(client.getQueryData(['me', 1])).toBeUndefined()
    expect(client.getQueryData(['me', 1, 1])).toEqual(expected)
    await expect(load()).resolves.toEqual(expected)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refetches invalidated memberships within the same credential and deduplicates concurrent loaders', async () => {
    const { client, load } = context()
    get.mockResolvedValueOnce({ data: me })
    await load()
    await client.invalidateQueries({ queryKey: ['me'] })
    let finish!: (value: unknown) => void
    get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const first = load()
    const second = load()
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    const updated = {
      ...me,
      organisations: [{ organisation: { id: 'new-workspace', slug: 'new-workspace' } }],
    }
    finish({ data: updated })
    await expect(first).resolves.toMatchObject({
      me: updated,
      generation: 1,
      credentialGeneration: 1,
    })
    await expect(second).resolves.toMatchObject({ me: updated })
    await expect(load()).resolves.toMatchObject({ me: updated })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('makes no identity request while restoration is pending or unauthenticated', async () => {
    const { adapter, load } = context()
    let finish!: (ready: boolean) => void
    adapter.restoreSession.mockReturnValue(new Promise((done) => (finish = done)))
    const result = load().catch((error: unknown) => error)
    await Promise.resolve()
    expect(get).not.toHaveBeenCalled()
    finish(false)
    expect(await result).toBeInstanceOf(Error)
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects late A and B so only C can regain authority', async () => {
    const { client, load, rotate } = context()
    client.setQueryData(['unrelated'], { draft: 'preserved' })
    const releases: Array<(value: unknown) => void> = []
    get.mockImplementation(
      () => new Promise((resolve) => releases.push(resolve as (value: unknown) => void))
    )

    const a = load().catch((error: unknown) => error)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const signalA = get.mock.calls[0]?.[1]?.signal as AbortSignal
    rotate('synthetic-b')
    const b = load().catch((error: unknown) => error)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    const signalB = get.mock.calls[1]?.[1]?.signal as AbortSignal
    rotate('synthetic-c')
    const c = load()
    await vi.waitFor(() => expect(releases).toHaveLength(3))

    releases[1]!({ data: { ...me, id: 'late-b' } })
    releases[0]!({ data: { ...me, id: 'late-a' } })
    releases[2]!({ data: { ...me, id: 'current-c' } })
    expect(await a).toBeInstanceOf(Error)
    expect(await b).toBeInstanceOf(Error)
    await expect(c).resolves.toMatchObject({
      me: { id: 'current-c' },
      generation: 1,
      credentialGeneration: 3,
    })
    expect(signalA.aborted).toBe(true)
    expect(signalB.aborted).toBe(true)
    expect(client.getQueryData(['unrelated'])).toEqual({ draft: 'preserved' })
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === 'me')
    ).toHaveLength(1)
  })

  it('does not create a new read for duplicate token delivery', async () => {
    const { load, rotate } = context()
    get.mockResolvedValue({ data: me })
    await load()
    rotate('synthetic-a')
    await load()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('closes on token disappearance and requires a fresh read before reopening', async () => {
    const { load, rotate } = context()
    get.mockResolvedValueOnce({ data: me })
    await expect(load()).resolves.toMatchObject({ credentialGeneration: 1 })

    rotate(undefined)
    await expect(load()).rejects.toThrow('Credential authority ended.')
    expect(get).toHaveBeenCalledTimes(1)

    rotate('synthetic-fresh')
    get.mockResolvedValueOnce({ data: { ...me, id: 'fresh-person' } })
    await expect(load()).resolves.toMatchObject({
      me: { id: 'fresh-person' },
      credentialGeneration: 3,
    })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'cancels late identity data after a session boundary (replacement=%s)',
    async (ready) => {
      const { client, load, replace } = context()
      let resolve!: (value: unknown) => void
      get.mockReturnValue(new Promise((done) => (resolve = done)))
      const result = load().catch((error: unknown) => error)
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      const signal = get.mock.calls[0]?.[1]?.signal as AbortSignal
      replace(ready)
      resolve({ data: me })
      expectAuthorityCancellation(await result)
      expect(signal.aborted).toBe(true)
      expect(client.getQueryCache().getAll()).toEqual([])
      if (ready) {
        get.mockResolvedValueOnce({ data: { ...me, id: 'replacement' } })
        await expect(load()).resolves.toMatchObject({ me: { id: 'replacement' } })
        expect(get).toHaveBeenCalledTimes(2)
      }
    }
  )

  it('can retry a failed authority read instead of retaining a rejected promise', async () => {
    const { load } = context()
    get.mockRejectedValueOnce(new Error('Temporary outage'))
    await expect(load()).rejects.toThrow('Temporary outage')
    get.mockResolvedValueOnce({ data: me })
    await expect(load()).resolves.toMatchObject({ me })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps token bytes out of query keys, returned authority and errors', async () => {
    const { client, load, rotate } = context()
    get.mockResolvedValueOnce({ data: me })
    const authority = await load()
    expect(JSON.stringify(authority)).not.toContain('synthetic-a')
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain('synthetic-a')
    rotate(undefined)
    const error = await load().catch((reason: unknown) => reason)
    expect(String(error)).not.toContain('synthetic-a')
  })
})

describe('production identity-read retry boundaries', () => {
  it.each([401, 403])('does not automatically repeat a definitive %s refusal', async (status) => {
    const { client, load } = context(2)
    const refusal = new ApiProblem({ type: null, status, title: 'Synthetic refusal' })
    get.mockRejectedValue(refusal)
    try {
      await expect(load()).rejects.toBe(refusal)
      expect(get).toHaveBeenCalledTimes(1)
      // A deliberate new read is allowed; the rejected request is not retained.
      get.mockResolvedValueOnce({ data: me })
      await expect(load()).resolves.toMatchObject({ me })
      expect(get).toHaveBeenCalledTimes(2)
    } finally {
      client.clear()
    }
  })

  it.each([
    new ApiProblem({
      type: 'https://kodera.io/problems/service-unavailable',
      status: 503,
      title: 'Synthetic outage',
    }),
    new NetworkError(new Error('Synthetic network outage')),
  ])('retains two automatic attempts after a transient failure', async (failure) => {
    const { client, load } = context(2)
    get.mockRejectedValue(failure)
    try {
      await expect(load()).rejects.toBe(failure)
      expect(get).toHaveBeenCalledTimes(3)
    } finally {
      client.clear()
    }
  })
})

it('delegates transient failures to the configured retry function with the original error', async () => {
  const retry = vi.fn((count: number) => count < 1)
  const { client, load } = context(retry)
  const failure = new NetworkError(new Error('Synthetic temporary failure'))
  get.mockRejectedValue(failure)
  try {
    await expect(load()).rejects.toBe(failure)
    expect(get).toHaveBeenCalledTimes(2)
    expect(retry.mock.calls).toEqual([
      [0, failure],
      [1, failure],
    ])
  } finally {
    client.clear()
  }
})

it.each([401, 403])(
  'does not delegate definitive %s refusals to a retry function',
  async (status) => {
    const retry = vi.fn((count: number) => count < 1)
    const { client, load } = context(retry)
    const failure = new ApiProblem({ type: null, status, title: 'Synthetic refusal' })
    get.mockRejectedValue(failure)
    try {
      await expect(load()).rejects.toBe(failure)
      expect(get).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  }
)
