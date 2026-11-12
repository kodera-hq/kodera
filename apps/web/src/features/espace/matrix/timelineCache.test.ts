import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageView } from './timeline'
import { ESPACE_TIMELINE_DATABASE } from '@/auth/localSession'
import {
  CACHE_DATABASE,
  CACHE_WRITE_DELAY_MS,
  isCachedMessage,
  MAX_AGE_MS,
  memoryBackend,
  TimelineCache,
  wipeTimelineCaches,
} from './timelineCache'

const ME = '@me:matrix.acme.kodera.test'
const OTHER = '@other:matrix.acme.kodera.test'
const ROOM = '!general:matrix.acme.kodera.test'
const ROOM_B = '!random:matrix.acme.kodera.test'

function message(index: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    key: `$m${index}`,
    eventId: `$m${index}`,
    sender: '@alice:matrix.acme.kodera.test',
    body: `message ${index}`,
    ts: Date.UTC(2026, 10, 2, 9) + index,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...overrides,
  }
}

const many = (count: number) => Array.from({ length: count }, (_, index) => message(index))

afterEach(() => {
  vi.useRealTimers()
})

describe('the timeline cache', () => {
  it('reads back what it kept, per room, for the same member', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME, { delayMs: 0 })
    cache.save(ROOM, many(3))
    cache.save(ROOM_B, [message(9)])
    await cache.flush()
    const rooms = await new TimelineCache(backend, ME).loadAll()
    expect([...rooms.keys()].sort()).toEqual([ROOM, ROOM_B].sort())
    expect(rooms.get(ROOM)!.map((m) => m.key)).toEqual(['$m0', '$m1', '$m2'])
  })

  it('keeps only the newest two hundred messages of a room', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(500))
    await cache.flush()
    const kept = (await cache.loadAll()).get(ROOM)!
    expect(kept).toHaveLength(200)
    expect(kept[0]!.key).toBe('$m300')
    expect(kept.at(-1)!.key).toBe('$m499')
  })

  it('never keeps a message this device has not had acknowledged', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, [
      message(1),
      message(2, { delivery: 'pending' }),
      message(3, { delivery: 'failed' }),
    ])
    await cache.flush()
    expect((await cache.loadAll()).get(ROOM)!.map((m) => m.key)).toEqual(['$m1'])
  })

  it('writes once per burst, after the wait, with the last messages given', async () => {
    vi.useFakeTimers()
    const backend = memoryBackend()
    const put = vi.spyOn(backend, 'put')
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(1))
    cache.save(ROOM, many(2))
    cache.save(ROOM, many(3))
    expect(put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CACHE_WRITE_DELAY_MS)
    expect(put).toHaveBeenCalledTimes(1)
    expect(backend.records.values().next().value!.messages).toHaveLength(3)
  })

  it("never reads another member's records", async () => {
    const backend = memoryBackend()
    const other = new TimelineCache(backend, OTHER)
    other.save(ROOM, many(2))
    await other.flush()
    expect((await new TimelineCache(backend, ME).loadAll()).size).toBe(0)
  })

  it('ignores a record of another version or shape', async () => {
    const backend = memoryBackend()
    const good = { v: 1, userId: ME, roomId: ROOM, savedAt: 1, messages: [message(1)] }
    await backend.put(`${ME}\n${ROOM}`, { ...good, v: 2 })
    await backend.put(`${ME}\n${ROOM_B}`, {
      ...good,
      roomId: ROOM_B,
      messages: [{ ...message(2), body: 42 } as unknown as MessageView],
    })
    expect((await new TimelineCache(backend, ME).loadAll()).size).toBe(0)
  })

  it('checks every field a message view is drawn from', () => {
    expect(isCachedMessage(message(1))).toBe(true)
    expect(isCachedMessage(message(1, { senderName: 'Alice', mentionsMe: true }))).toBe(true)
    expect(isCachedMessage({ ...message(1), ts: Number.NaN })).toBe(false)
    expect(isCachedMessage({ ...message(1), reactions: [{ key: '👍', count: '1' }] })).toBe(false)
    expect(isCachedMessage({ ...message(1), document: { id: 'd' } })).toBe(false)
    expect(isCachedMessage({ ...message(1), mentionsMe: false })).toBe(false)
    expect(isCachedMessage(null)).toBe(false)
  })

  it('keeps a copy: a change made in place afterwards is not written', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    const messages = [message(1, { reactions: [{ key: '👍', count: 1, mine: false }] })]
    cache.save(ROOM, messages)
    await cache.flush()
    messages[0]!.reactions[0]!.count = 9
    expect((await cache.loadAll()).get(ROOM)![0]!.reactions[0]!.count).toBe(1)
  })

  it('forgets a room the member left', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(2))
    await cache.flush()
    cache.forget(ROOM)
    await cache.flush()
    expect(backend.records.size).toBe(0)
  })

  it('writes what was waiting when its store stops, and nothing after', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME, { delayMs: 60_000 })
    cache.save(ROOM, many(2))
    await cache.close()
    expect(backend.records.size).toBe(1)
    cache.save(ROOM_B, many(1))
    await cache.flush()
    expect(backend.records.size).toBe(1)
  })

  it('wipes every record on sign-out, and a write still waiting never lands', async () => {
    vi.useFakeTimers()
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(2))
    await cache.flush()
    cache.save(ROOM_B, many(2))
    const other = new TimelineCache(backend, OTHER)
    other.save(ROOM, many(1))
    await wipeTimelineCaches(backend)
    await vi.advanceTimersByTimeAsync(CACHE_WRITE_DELAY_MS * 2)
    expect(backend.records.size).toBe(0)
    cache.save(ROOM, many(1))
    await cache.flush()
    expect(backend.records.size).toBe(0)
  })

  it('loses only the cache when storage refuses', async () => {
    const backend = memoryBackend()
    backend.put = () => Promise.reject(new Error('QuotaExceededError'))
    backend.entries = () => Promise.reject(new Error('refused'))
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(2))
    await expect(cache.flush()).resolves.toBeUndefined()
    await expect(cache.loadAll()).resolves.toEqual(new Map())
  })

  it("deletes another member's records, and expired ones, as a member's store starts", async () => {
    const backend = memoryBackend()
    let now = 1_000_000
    const old = new TimelineCache(backend, ME, { now: () => now })
    old.save(ROOM, many(1))
    await old.flush()
    const other = new TimelineCache(backend, OTHER, { now: () => now })
    other.save(ROOM, many(1))
    await other.flush()
    now += MAX_AGE_MS + 1
    const fresh = new TimelineCache(backend, ME, { now: () => now })
    fresh.save(ROOM_B, many(1))
    await fresh.flush()
    const rooms = await fresh.loadAll()
    await fresh.flush()
    expect([...rooms.keys()]).toEqual([ROOM_B])
    expect([...backend.records.keys()]).toEqual([`${ME}\n${ROOM_B}`])
  })

  it('deletes a record filed under a key that is not its own', async () => {
    const backend = memoryBackend()
    await backend.put(`${ME}\n${ROOM_B}`, {
      v: 1,
      userId: ME,
      roomId: ROOM,
      savedAt: Date.now(),
      messages: [message(1)],
    })
    const cache = new TimelineCache(backend, ME)
    expect((await cache.loadAll()).size).toBe(0)
    await cache.flush()
    expect(backend.records.size).toBe(0)
  })

  it('deletes the whole store when clearing it fails, and says when that fails too', async () => {
    const backend = memoryBackend()
    const cache = new TimelineCache(backend, ME)
    cache.save(ROOM, many(1))
    await cache.flush()
    backend.clear = () => Promise.reject(new Error('refused'))
    const destroy = vi.spyOn(backend, 'destroy')
    await expect(wipeTimelineCaches(backend)).resolves.toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
    expect(backend.records.size).toBe(0)
    backend.destroy = () => Promise.reject(new Error('refused'))
    await expect(wipeTimelineCaches(backend)).resolves.toBe(false)
  })

  it("is the database the console's sign-out deletes", () => {
    expect(CACHE_DATABASE).toBe(ESPACE_TIMELINE_DATABASE)
  })
})
