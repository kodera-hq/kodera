import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLocalSessionStorage, ESPACE_TIMELINE_DATABASE } from './localSession'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the local sign-out', () => {
  it("deletes Espace's device cache of messages, whether or not Espace was opened", () => {
    const deleteDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase })
    clearLocalSessionStorage()
    expect(deleteDatabase).toHaveBeenCalledWith(ESPACE_TIMELINE_DATABASE)
  })

  it('still clears the browser storage where IndexedDB refuses', () => {
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        throw new DOMException('refused', 'SecurityError')
      },
    })
    window.localStorage.setItem('kodera.web.test', 'value')
    clearLocalSessionStorage()
    expect(window.localStorage.getItem('kodera.web.test')).toBeNull()
  })
})
