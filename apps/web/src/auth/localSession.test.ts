import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalSessionStorage,
  DOCS_COLLAB_DATABASE,
  DOCS_COLLAB_DATABASE_PREFIX,
  DOCS_COLLAB_REGISTRY_KEY,
  ESPACE_TIMELINE_DATABASE,
  registerLocalSessionCleanup,
} from './localSession'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('the local sign-out', () => {
  it("deletes Espace's device cache of messages, whether or not Espace was opened", () => {
    const deleteDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase })
    clearLocalSessionStorage()
    expect(deleteDatabase).toHaveBeenCalledWith(ESPACE_TIMELINE_DATABASE)
    expect(deleteDatabase).toHaveBeenCalledWith(DOCS_COLLAB_DATABASE)
  })

  it('wipes all registered collaborative document Yjs IndexedDB databases and invokes teardown hooks', () => {
    const order: string[] = []
    const deleteDatabase = vi.fn((name: string) => {
      order.push(`delete:${name}`)
    })
    const databases = vi.fn(async () => [
      { name: `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-orphan` },
      { name: 'unrelated-third-party-db' },
    ])
    vi.stubGlobal('indexedDB', { deleteDatabase, databases })

    window.localStorage.setItem(
      DOCS_COLLAB_REGISTRY_KEY,
      JSON.stringify([
        `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-alpha`,
        `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-beta`,
        'unrelated-db-ignored',
      ])
    )

    const disposeHandle = vi.fn(() => {
      order.push('close-handle')
    })
    registerLocalSessionCleanup(disposeHandle)

    clearLocalSessionStorage()

    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(order[0]).toBe('close-handle')
    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-alpha`)
    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-beta`)
    expect(deleteDatabase).not.toHaveBeenCalledWith('unrelated-db-ignored')
    expect(window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)).toBeNull()
  })

  it('sweeps enumerated Yjs IndexedDB databases not present in localStorage registry', async () => {
    const deleteDatabase = vi.fn()
    const databases = vi.fn(async () => [
      { name: `${DOCS_COLLAB_DATABASE_PREFIX}org-2:doc-99` },
      { name: 'other-origin-store' },
    ])
    vi.stubGlobal('indexedDB', { deleteDatabase, databases })

    clearLocalSessionStorage()
    await Promise.resolve()

    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-2:doc-99`)
    expect(deleteDatabase).not.toHaveBeenCalledWith('other-origin-store')
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
