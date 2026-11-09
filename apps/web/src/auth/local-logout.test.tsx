import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { AppProviders, createQueryClient } from '@/app/providers'
import { useAuth } from './AuthProvider'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('explicit local logout', () => {
  it('cancels a pending query and ignores its late customer response', async () => {
    const client = createQueryClient()
    let requestSignal: AbortSignal | undefined
    let resolveRequest!: (value: unknown) => void
    const request = client
      .fetchQuery({
        queryKey: ['private-pending'],
        queryFn: ({ signal }) => {
          requestSignal = signal
          return new Promise((resolve) => {
            resolveRequest = resolve
          })
        },
      })
      .catch(() => {})
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => <AppProviders queryClient={client}>{children}</AppProviders>,
    })

    await act(() => result.current.signOut())
    resolveRequest({ privateValue: 'late synthetic reply' })
    await request

    expect(requestSignal?.aborted).toBe(true)
    expect(client.getQueryCache().getAll()).toEqual([])
  })

  it('clears cached identity, customer queries and mutation state', async () => {
    const client = createQueryClient()
    client.setQueryData(['me'], { email: 'synthetic@example.test' })
    client.setQueryData(['home', 'acme-sa'], { privateValue: 'synthetic' })
    client.getMutationCache().build(client, { mutationKey: ['private-mutation'] })
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => <AppProviders queryClient={client}>{children}</AppProviders>,
    })

    await act(() => result.current.signOut())

    expect(client.getQueryCache().getAll()).toEqual([])
    expect(client.getMutationCache().getAll()).toEqual([])
  })

  it('removes console-owned state and drafts while preserving unrelated storage', async () => {
    sessionStorage.setItem('kodera.web.session.formStash', 'private form')
    sessionStorage.setItem('kodera.web.mfa.enrolledLocally', '1')
    sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home')
    sessionStorage.setItem('unrelated', 'keep')
    localStorage.setItem('order-draft:synthetic', 'private contacts')
    localStorage.setItem('order-draft-latest:acme-sa', 'synthetic')
    localStorage.setItem('unrelated', 'keep')
    const { result } = renderHook(useAuth, {
      wrapper: AppProviders,
    })

    await act(() => result.current.signOut())

    expect(Object.keys(sessionStorage)).toEqual(['unrelated'])
    expect(Object.keys(localStorage)).toEqual(['unrelated'])
  })

  it('clears cached customer data even when browser storage cannot be read', async () => {
    const client = createQueryClient()
    client.setQueryData(['me'], { email: 'synthetic@example.test' })
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => <AppProviders queryClient={client}>{children}</AppProviders>,
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })

    await act(async () => {
      await result.current.signOut().catch(() => {})
    })

    expect(client.getQueryCache().getAll()).toEqual([])
  })
})
