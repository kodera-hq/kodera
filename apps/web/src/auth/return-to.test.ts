import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeReturnTo, hasReturnTo, rememberReturnTo } from '@/auth/return-to'

beforeEach(() => {
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rememberReturnTo / consumeReturnTo', () => {
  it('round-trips the remembered path', () => {
    rememberReturnTo('/acme-sa/home')
    expect(hasReturnTo()).toBe(true)
    expect(consumeReturnTo()).toBe('/acme-sa/home')
  })

  it('clears the stored value once consumed — a second read falls back to "/"', () => {
    rememberReturnTo('/acme-sa/home')
    consumeReturnTo()
    expect(hasReturnTo()).toBe(false)
    expect(consumeReturnTo()).toBe('/')
  })

  it('falls back to "/" when nothing was remembered', () => {
    expect(consumeReturnTo()).toBe('/')
  })

  it('swallows sessionStorage quota and security exceptions without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    expect(() => rememberReturnTo('/community/workspace')).not.toThrow()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError')
    })
    expect(hasReturnTo()).toBe(false)
    expect(consumeReturnTo()).toBe('/')
  })
})
