import { beforeEach, describe, expect, it } from 'vitest'
import { consumeReturnTo, rememberReturnTo } from '@/auth/return-to'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('rememberReturnTo / consumeReturnTo', () => {
  it('round-trips the remembered path', () => {
    rememberReturnTo('/acme-sa/home')
    expect(consumeReturnTo()).toBe('/acme-sa/home')
  })

  it('clears the stored value once consumed — a second read falls back to "/"', () => {
    rememberReturnTo('/acme-sa/home')
    consumeReturnTo()
    expect(consumeReturnTo()).toBe('/')
  })

  it('falls back to "/" when nothing was remembered', () => {
    expect(consumeReturnTo()).toBe('/')
  })
})
