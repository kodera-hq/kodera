// `useAutoOpenEspace` on its own: what it says of a start still to come, which the screen draws as
// « Ouverture de vos messages… ».

import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAutoOpenEspace } from './OpenEspace'

const AUTO_OPEN_KEY = 'kodera.espace.auto-open.v1'

afterEach(() => sessionStorage.removeItem(AUTO_OPEN_KEY))

function entry() {
  return { opening: false, problem: undefined, open: vi.fn(async () => {}) }
}

it('says no start is coming, and starts none, where the way in is not offered', () => {
  const espace = entry()
  const { result } = renderHook(() => useAutoOpenEspace(espace, false))
  expect(result.current).toBe(false)
  expect(espace.open).not.toHaveBeenCalled()
})

it('says a start is coming from the first draw where it is offered and due', () => {
  const espace = entry()
  const seen: boolean[] = []
  renderHook(() => {
    const starting = useAutoOpenEspace(espace, true, '/acme-sa/workspace/welcome')
    seen.push(starting)
    return starting
  })
  expect(seen[0]).toBe(true)
  expect(espace.open).toHaveBeenCalledWith({
    replace: true,
    returnTo: '/acme-sa/workspace/welcome',
  })
})
