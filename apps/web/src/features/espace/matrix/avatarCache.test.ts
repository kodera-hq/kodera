import { describe, expect, it, vi } from 'vitest'
import { AvatarCache, isMxcUrl } from './avatarCache'

function urls() {
  let serial = 0
  const revoked: string[] = []
  return {
    revoked,
    urls: { create: () => `blob:avatar-${++serial}`, revoke: (url: string) => revoked.push(url) },
  }
}

const A = 'mxc://kodera.test/aaa'
const B = 'mxc://kodera.test/bbb'
const C = 'mxc://kodera.test/ccc'

describe('the avatar cache', () => {
  it('resolves an mxc address once to a blob address, asked once however many draw it', async () => {
    const fetch = vi.fn(async () => new Blob(['x'], { type: 'image/png' }))
    const { urls: u } = urls()
    const cache = new AvatarCache(fetch, { urls: u })
    const heard = vi.fn()
    cache.subscribe(heard)
    expect(cache.get(A)).toBeUndefined()
    expect(cache.get(A)).toBeUndefined()
    await expect(cache.load(A)).resolves.toBe('blob:avatar-1')
    expect(cache.get(A)).toBe('blob:avatar-1')
    expect(fetch).toHaveBeenCalledOnce()
    expect(heard).toHaveBeenCalledOnce()
  })

  it('drops the least recently drawn past its capacity, revoking its object URL', async () => {
    const { urls: u, revoked } = urls()
    const cache = new AvatarCache(async () => new Blob(['x']), { capacity: 2, urls: u })
    await cache.load(A)
    await cache.load(B)
    cache.get(A)
    await cache.load(C)
    expect(cache.size).toBe(2)
    expect(revoked).toEqual(['blob:avatar-2'])
    expect(cache.get(A)).toBe('blob:avatar-1')
  })

  it('does not ask again soon for an address that gave nothing, or a broken one', async () => {
    let now = 0
    const fetch = vi.fn(async (mxc: string) => (mxc === A ? null : new Blob(['x'])))
    const { urls: u, revoked } = urls()
    const cache = new AvatarCache(fetch, { urls: u, now: () => now })
    await cache.load(A)
    await cache.load(A)
    expect(fetch).toHaveBeenCalledTimes(1)
    await cache.load(B)
    cache.forget(B)
    expect(revoked).toEqual(['blob:avatar-1'])
    await cache.load(B)
    expect(fetch).toHaveBeenCalledTimes(2)
    now = 10 * 60_000
    await cache.load(A)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('refuses anything but mxc://server/id, and revokes everything when closed', async () => {
    expect(isMxcUrl('https://evil.test/a.png')).toBe(false)
    expect(isMxcUrl('mxc://kodera.test/../x')).toBe(false)
    expect(isMxcUrl(A)).toBe(true)
    const { urls: u, revoked } = urls()
    const cache = new AvatarCache(async () => new Blob(['x']), { urls: u })
    await cache.load(A)
    cache.close()
    expect(revoked).toEqual(['blob:avatar-1'])
    expect(cache.get(A)).toBeUndefined()
    await expect(cache.load(B)).resolves.toBeNull()
  })
})
