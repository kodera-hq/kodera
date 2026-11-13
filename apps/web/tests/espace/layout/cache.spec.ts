// The device's timeline cache on the browser's real IndexedDB (docs/specs/espace-timeline-scale.md).
// The unit tests run the same cache over a map; this proves the IndexedDB backend itself, and the
// wipe when the Matrix session ends. jsdom has no IndexedDB.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout/cache.spec.ts`.

import { expect, test, type Page } from '@playwright/test'

const CACHE_MODULE = '/src/features/espace/matrix/timelineCache.ts'
const AUTH_MODULE = '/src/auth/matrix.ts'

async function openPage(page: Page) {
  await page.goto('/tests/espace/layout/harness.html')
  await page.waitForFunction(() => 'indexedDB' in window)
}

test('espace/cache: a room kept in IndexedDB is read back by the next store of the same member', async ({
  page,
}) => {
  await openPage(page)
  const result = await page.evaluate(async (path) => {
    const cache = await import(/* @vite-ignore */ path)
    const backend = cache.indexedDbBackend()
    const me = '@me:matrix.acme.kodera.test'
    const message = (index: number) => ({
      key: `$m${index}`,
      eventId: `$m${index}`,
      sender: '@alice:matrix.acme.kodera.test',
      body: `kept ${index}`,
      ts: 1_700_000_000_000 + index,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [{ key: '👍', count: 2, mine: true }],
    })
    const first = new cache.TimelineCache(backend, me)
    first.save(
      '!general:matrix.acme.kodera.test',
      Array.from({ length: 250 }, (_, i) => message(i))
    )
    await first.close()
    const rooms = await new cache.TimelineCache(backend, me).loadAll()
    const kept = rooms.get('!general:matrix.acme.kodera.test')
    const other = await new cache.TimelineCache(backend, '@other:matrix.acme.kodera.test').loadAll()
    const databases = (await indexedDB.databases()).map((db) => db.name)
    return {
      count: kept?.length,
      first: kept?.[0]?.key,
      reaction: kept?.[0]?.reactions[0],
      other: other.size,
      named: databases.includes(cache.CACHE_DATABASE),
    }
  }, CACHE_MODULE)
  expect(result).toEqual({
    count: 200,
    first: '$m50',
    reaction: { key: '👍', count: 2, mine: true },
    other: 0,
    named: true,
  })
})

test('espace/cache: ending the Matrix session wipes every room kept on the device', async ({
  page,
}) => {
  await openPage(page)
  const left = await page.evaluate(
    async ({ cachePath, authPath }) => {
      const cache = await import(/* @vite-ignore */ cachePath)
      const auth = await import(/* @vite-ignore */ authPath)
      const me = '@me:matrix.acme.kodera.test'
      auth.registerMatrixSession({
        baseUrl: 'https://matrix.acme.kodera.test',
        userId: me,
        deviceId: 'DEVICE',
        accessToken: 'session-under-test',
        refreshToken: 'refresh-under-test',
        refresh: async () => ({ accessToken: 'renewed-under-test' }),
      })
      const opened = cache.openTimelineCache(me)
      opened.save('!general:matrix.acme.kodera.test', [
        {
          key: '$m1',
          eventId: '$m1',
          sender: me,
          body: 'kept',
          ts: 1_700_000_000_000,
          edited: false,
          redacted: false,
          delivery: 'sent',
          replyTo: null,
          reactions: [],
        },
      ])
      await opened.flush()
      const before = (await new cache.TimelineCache(cache.indexedDbBackend(), me).loadAll()).size
      // A write still waiting when the session ends must never land.
      opened.save('!random:matrix.acme.kodera.test', [])
      auth.clearMatrixSession()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const after = (await new cache.TimelineCache(cache.indexedDbBackend(), me).loadAll()).size
      return { before, after }
    },
    { cachePath: CACHE_MODULE, authPath: AUTH_MODULE }
  )
  expect(left).toEqual({ before: 1, after: 0 })
})
