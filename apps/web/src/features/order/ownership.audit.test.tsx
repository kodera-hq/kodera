import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { authAdapter } from '../../auth/oidc'
import { emptyDraft, parseDraft, serializeDraft } from './draft'
import type { OrderOwner } from './owner'
import { useOrderDraft } from './useOrderDraft'
import { editableKey, saveEditable, readEditable, EDITABLE_RETENTION_MS } from './editableStorage'

const owner: OrderOwner = {
  issuer: 'https://id.example.test/realms/acme-sa',
  subject: 'user-a',
  organisationId: 'org-a',
  membershipId: 'membership-a',
  identityId: 'identity-a',
  generation: 1,
}
let activeOwner = owner
beforeEach(() => {
  localStorage.clear()
  activeOwner = owner
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
  vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(() => ({
    status: 'ready',
    generation: activeOwner.generation,
    credentialGeneration: 1,
    user: {
      realm: 'acme-sa',
      identity: { issuer: activeOwner.issuer, subject: activeOwner.subject },
    },
  }))
})
afterEach(() => vi.useRealTimers())
describe('owned editable order recovery', () => {
  it('resumes same-owner editable data while excluding purchase and secret fields', () => {
    const draft = {
      ...emptyDraft(),
      draftId: 'known',
      packCode: 'visio',
      unknownSecret: 'never-editable',
    }
    saveEditable(draft, owner)
    const { result } = renderHook(() => useOrderDraft('known', owner))
    expect(result.current.draft.packCode).toBe('visio')
    expect(result.current.draft.submitIdempotencyKey).toBeUndefined()
    expect(JSON.stringify(localStorage)).not.toContain('never-editable')
  })
  it.each(['organisationId', 'issuer', 'subject'] as const)(
    'refuses copied URLs under another %s without deleting the owner record',
    (field) => {
      const first = renderHook(() => useOrderDraft('known', owner))
      act(() => first.result.current.update({ packCode: 'owner-a-choice' }))
      first.unmount()
      const saved = localStorage.getItem(editableKey('known', owner))
      activeOwner = { ...owner, [field]: 'different' }
      const other = renderHook(() => useOrderDraft('known', activeOwner))
      expect(other.result.current.draft.packCode).toBeUndefined()
      expect(localStorage.getItem(editableKey('known', owner))).toBe(saved)
    }
  )
  it('changes state when a mounted draft route changes', () => {
    const { result, rerender } = renderHook(({ id }) => useOrderDraft(id, owner), {
      initialProps: { id: 'first' },
    })
    act(() => result.current.update({ packCode: 'previous-choice' }))
    const oldUpdate = result.current.update
    rerender({ id: 'second' })
    expect(result.current.draft.draftId).toBe('second')
    expect(result.current.draft.packCode).toBeUndefined()
    act(() => oldUpdate({ packCode: 'late' }))
    expect(result.current.draft.packCode).toBeUndefined()
  })
  it.each(['organisationId', 'generation'] as const)(
    'refuses old callbacks after mounted %s change',
    (field) => {
      const { result, rerender } = renderHook(({ scope }) => useOrderDraft('known', scope), {
        initialProps: { scope: owner },
      })
      const oldUpdate = result.current.update
      activeOwner = { ...owner, [field]: field === 'generation' ? 2 : 'org-b' }
      rerender({ scope: activeOwner })
      act(() => oldUpdate({ packCode: 'late' }))
      expect(result.current.draft.packCode).toBeUndefined()
    }
  )
  it('does not write after unmount or loss of active ownership', () => {
    const { result, unmount } = renderHook(() => useOrderDraft('known', owner))
    const update = result.current.update
    unmount()
    act(() => update({ packCode: 'late' }))
    expect(localStorage.getItem(editableKey('known', owner))).toBeNull()
  })
  it('holds unowned legacy order identifiers without restoring or replacing their record', () => {
    const saved = serializeDraft({
      ...emptyDraft(),
      draftId: 'legacy',
      orderId: 'real-order-id',
      submitIdempotencyKey: 'original-intent',
    })
    localStorage.setItem('order-draft:legacy', saved)
    const { result } = renderHook(() => useOrderDraft('legacy', owner))
    expect(result.current.draft.orderId).toBeUndefined()
    expect(result.current.status).toBe('held')
    act(() => result.current.update({ packCode: 'new' }))
    expect(localStorage.getItem('order-draft:legacy')).toBe(saved)
    expect(localStorage.getItem(editableKey('legacy', owner))).toBeNull()
  })
  it('rejects invalid lifetime metadata', () => {
    expect(
      parseDraft(JSON.stringify({ ...emptyDraft(), createdAt: 'not-a-timestamp' }))
    ).toBeUndefined()
  })
  it('does not restore expired editable data or extend retention just by reading', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    saveEditable({ ...emptyDraft(), draftId: 'known', packCode: 'visio' }, owner)
    const raw = localStorage.getItem(editableKey('known', owner))
    vi.advanceTimersByTime(EDITABLE_RETENTION_MS - 1)
    expect(readEditable('known', owner).draft.packCode).toBe('visio')
    vi.advanceTimersByTime(1)
    expect(readEditable('known', owner).draft.packCode).toBeUndefined()
    expect(localStorage.getItem(editableKey('known', owner))).toBe(raw)
  })
  it.each(['not json', 'null', '{}'])('holds unreadable owned data %s without hydration', (raw) => {
    localStorage.setItem(editableKey('known', owner), raw)
    expect(readEditable('known', owner).status).toBe('held')
    const { result } = renderHook(() => useOrderDraft('known', owner))
    act(() => result.current.update({ packCode: 'replacement' }))
    expect(result.current.status).toBe('held')
    expect(localStorage.getItem(editableKey('known', owner))).toBe(raw)
  })
  it('contains read denial and labels memory-only edits when writes fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = renderHook(() => useOrderDraft('known', owner))
    expect(result.current.status).toBe('unavailable')
    act(() => result.current.update({ packCode: 'visio' }))
    expect(result.current.status).toBe('unavailable')
    expect(result.current.draft.packCode).toBe('visio')
  })
  it('does not write or consume records during StrictMode initialization', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    renderHook(() => useOrderDraft('known', owner), { wrapper: StrictMode })
    expect(write).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

it('holds a possible submitted input instead of stripping its purchase context into an editable save', () => {
  const draft = {
    ...emptyDraft(),
    draftId: 'known',
    submitIdempotencyKey: 'original-intent',
    orderId: 'possible-order',
  }
  expect(saveEditable(draft, owner)?.status).toBe('held')
  expect(localStorage.getItem(editableKey('known', owner))).toBeNull()
})

it('does not let an editable envelope override unresolved legacy purchase context', () => {
  saveEditable({ ...emptyDraft(), draftId: 'known', packCode: 'visio' }, owner)
  localStorage.setItem(
    'order-draft:known',
    JSON.stringify({ submitIdempotencyKey: 'original-intent' })
  )
  expect(readEditable('known', owner).status).toBe('held')
  expect(readEditable('known', owner).draft.packCode).toBeUndefined()
})
it.each(['future', 'wrong owner', 'wrong draft'] as const)(
  'never hydrates %s envelope data',
  (failure) => {
    saveEditable({ ...emptyDraft(), draftId: 'known', packCode: 'private-choice' }, owner)
    const key = editableKey('known', owner)
    const payload = JSON.parse(localStorage.getItem(key)!)
    if (failure === 'future') payload.editedAt = new Date(Date.now() + 60000).toISOString()
    if (failure === 'wrong owner') payload.owner[1] = 'another-user'
    if (failure === 'wrong draft') payload.draftId = 'another-draft'
    localStorage.setItem(key, JSON.stringify(payload))
    expect(readEditable('known', owner).draft.packCode).toBeUndefined()
    expect(localStorage.getItem(key)).toContain('private-choice')
  }
)
it('refuses stale saves as soon as the authentication generation changes', () => {
  const { result } = renderHook(() => useOrderDraft('known', owner))
  activeOwner = { ...owner, generation: 2 }
  act(() => result.current.update({ packCode: 'late' }))
  expect(localStorage.getItem(editableKey('known', owner))).toBeNull()
})

it('refuses a save when the live token expires even if the last ready snapshot is retained', () => {
  const { result } = renderHook(() => useOrderDraft('known', owner))
  vi.mocked(authAdapter.getAccessToken).mockReturnValue(undefined)
  act(() => result.current.update({ packCode: 'expired-session-write' }))
  expect(localStorage.getItem(editableKey('known', owner))).toBeNull()
})

it('does not overwrite a mismatched-owner payload stored under the current namespace', () => {
  saveEditable({ ...emptyDraft(), draftId: 'known', packCode: 'other-owner-data' }, owner)
  const key = editableKey('known', owner)
  const payload = JSON.parse(localStorage.getItem(key)!)
  payload.owner[1] = 'someone-else'
  const original = JSON.stringify(payload)
  localStorage.setItem(key, original)
  const { result } = renderHook(() => useOrderDraft('known', owner))
  act(() => result.current.update({ packCode: 'replacement' }))
  expect(result.current.status).toBe('held')
  expect(localStorage.getItem(key)).toBe(original)
})

// A mounted editor's earlier saved status is not proof that persisted bytes remain editable.
describe('editable save boundary rechecks current recovery state', () => {
  const unrelatedOwner: OrderOwner = { ...owner, subject: 'unrelated-owner' }
  const pointer = (scope: OrderOwner) =>
    `order-draft-latest:editable-v1:${JSON.stringify([scope.issuer, scope.subject, scope.organisationId])}`

  function seeded() {
    const now = Date.now()
    const draft = {
      ...emptyDraft(),
      draftId: 'known',
      createdAt: new Date(now).toISOString(),
      packCode: 'before',
    }
    saveEditable(draft, owner, now)
    const key = editableKey('known', owner)
    const raw = localStorage.getItem(key)!
    expect(readEditable('known', owner, now).status).toBe('saved')
    return { now, draft, key, raw }
  }

  it.each(['submission', 'legacy', 'malformed', 'mismatched-owner', 'invalid-purpose'] as const)(
    'does not overwrite a late %s record or advance the latest pointer',
    (kind) => {
      const { now, draft, key, raw } = seeded()
      const value = JSON.parse(raw)
      const legacyKey = 'order-draft:known'
      let currentRaw = raw
      let legacyRaw: string | null = null
      if (kind === 'submission') {
        value.receipt = { orderId: 'uncertain-original-order' }
        currentRaw = JSON.stringify(value)
      }
      if (kind === 'legacy')
        legacyRaw = JSON.stringify({ submitIdempotencyKey: 'uncertain-original-intent' })
      if (kind === 'malformed') currentRaw = 'not json'
      if (kind === 'mismatched-owner') {
        value.owner[1] = 'another-subject'
        currentRaw = JSON.stringify(value)
      }
      if (kind === 'invalid-purpose') {
        value.purpose = 'unknown-purchase-context'
        currentRaw = JSON.stringify(value)
      }
      localStorage.setItem(key, currentRaw)
      if (legacyRaw !== null) localStorage.setItem(legacyKey, legacyRaw)
      localStorage.setItem(pointer(owner), 'different-latest-draft')
      localStorage.setItem(editableKey('known', unrelatedOwner), 'unrelated-owner-bytes')
      expect(readEditable('known', owner, now).status).toBe('held')
      const writes = vi.spyOn(Storage.prototype, 'setItem')
      const removes = vi.spyOn(Storage.prototype, 'removeItem')
      const result = saveEditable({ ...draft, packCode: 'new-edit' }, owner, now)
      expect(result?.status).toBe('held')
      expect(result?.draft.packCode).toBeUndefined()
      expect(writes).not.toHaveBeenCalled()
      expect(removes).not.toHaveBeenCalled()
      expect(localStorage.getItem(key)).toBe(currentRaw)
      expect(localStorage.getItem(legacyKey)).toBe(legacyRaw)
      expect(localStorage.getItem(pointer(owner))).toBe('different-latest-draft')
      expect(localStorage.getItem(editableKey('known', unrelatedOwner))).toBe(
        'unrelated-owner-bytes'
      )
    }
  )

  it('turns the real mounted draft held when uncertain metadata appears after hydration', () => {
    const { key, raw } = seeded()
    const { result } = renderHook(() => useOrderDraft('known', owner))
    expect(result.current.status).toBe('saved')
    const later = JSON.stringify({
      ...JSON.parse(raw),
      submitIdempotencyKey: 'uncertain-original-intent',
    })
    localStorage.setItem(key, later)
    localStorage.setItem(pointer(owner), 'different-latest-draft')
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    act(() => result.current.update({ packCode: 'new-edit' }))
    expect(result.current.status).toBe('held')
    expect(result.current.draft.packCode).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(later)
    expect(localStorage.getItem(pointer(owner))).toBe('different-latest-draft')
  })

  it('does not overwrite unreadable current records even when writing would succeed', () => {
    const { now, draft, key, raw } = seeded()
    localStorage.setItem(pointer(owner), 'different-latest-draft')
    const reads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('read denied')
    })
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    try {
      const result = saveEditable({ ...draft, packCode: 'memory-only-edit' }, owner, now)
      expect(result?.status).toBe('unavailable')
      expect(result?.draft.packCode).toBe('memory-only-edit')
      expect(writes).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
    expect(localStorage.getItem(key)).toBe(raw)
    expect(localStorage.getItem(pointer(owner))).toBe('different-latest-draft')
  })

  it.each(['empty', 'saved', 'expired', 'future', 'chronology'] as const)(
    'preserves the current explicit-edit behavior for %s persisted state',
    (kind) => {
      const { now, draft, key, raw } = seeded()
      if (kind === 'empty') localStorage.removeItem(key)
      if (kind === 'expired' || kind === 'future' || kind === 'chronology') {
        const value = JSON.parse(raw)
        if (kind === 'expired') {
          value.createdAt = new Date(now - EDITABLE_RETENTION_MS - 2000).toISOString()
          value.editedAt = new Date(now - EDITABLE_RETENTION_MS - 1).toISOString()
        }
        if (kind === 'future') value.editedAt = new Date(now + 1000).toISOString()
        if (kind === 'chronology') value.createdAt = new Date(now + 1000).toISOString()
        localStorage.setItem(key, JSON.stringify(value))
        expect(readEditable('known', owner, now).status).toBe('rejected')
      }
      const result = saveEditable({ ...draft, packCode: 'explicit-new-edit' }, owner, now)
      expect(result?.status).toBe('saved')
      expect(readEditable('known', owner, now).draft.packCode).toBe('explicit-new-edit')
      expect(localStorage.getItem(pointer(owner))).toBe('known')
    }
  )

  it.each(['record', 'pointer'] as const)(
    'preserves unavailable semantics when the %s write fails',
    (failure) => {
      const { now, draft, key, raw } = seeded()
      localStorage.setItem(pointer(owner), 'different-latest-draft')
      const originalSet = Storage.prototype.setItem
      const calls: string[] = []
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        name,
        value
      ) {
        calls.push(name)
        if (name === (failure === 'record' ? key : pointer(owner))) throw new Error('quota')
        return originalSet.call(this, name, value)
      })
      const result = saveEditable({ ...draft, packCode: 'new-edit' }, owner, now)
      expect(result?.status).toBe('unavailable')
      expect(result?.draft.packCode).toBe('new-edit')
      expect(localStorage.getItem(pointer(owner))).toBe('different-latest-draft')
      if (failure === 'record') {
        expect(calls).toEqual([key])
        expect(localStorage.getItem(key)).toBe(raw)
      } else {
        expect(calls).toEqual([key, pointer(owner)])
        expect(readEditable('known', owner, now).draft.packCode).toBe('new-edit')
      }
    }
  )
})
