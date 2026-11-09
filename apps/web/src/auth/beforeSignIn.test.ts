import { describe, expect, it, vi } from 'vitest'
import { beforeSignIn, onBeforeSignIn } from './beforeSignIn'

describe('the synchronous reauthentication save boundary', () => {
  it('finishes listeners before returning, isolates failure and unregisters', () => {
    const calls: string[] = []
    const offFirst = onBeforeSignIn(() => {
      calls.push('first')
      throw new Error('denied')
    })
    const last = vi.fn(() => calls.push('last'))
    const offLast = onBeforeSignIn(last)
    expect(() => beforeSignIn()).not.toThrow()
    calls.push('redirect')
    expect(calls).toEqual(['first', 'last', 'redirect'])
    offFirst()
    offLast()
    beforeSignIn()
    expect(last).toHaveBeenCalledTimes(1)
  })
})
