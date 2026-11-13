import { describe, expect, it, vi } from 'vitest'
import { codeOf, takeJoinCode } from './joinCode'

const CODE = 'Ab3_-'.repeat(5)

describe('an invite link’s code', () => {
  it('is read from the fragment only, and only in the shape Core issues', () => {
    expect(codeOf(`#${CODE}`)).toBe(CODE)
    for (const bad of ['', '#', '#short', `#${CODE}<script>`, '#%E0%A4%A', `#${'a'.repeat(129)}`]) {
      expect(codeOf(bad)).toBeNull()
    }
  })

  it('leaves the address bar and the history entry as soon as it is read', () => {
    const replaceState = vi.fn()
    const code = takeJoinCode(
      { hash: `#${CODE}`, pathname: '/console/join', search: '' } as Location,
      { state: null, replaceState } as unknown as History
    )
    expect(code).toBe(CODE)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/console/join')
  })
})
