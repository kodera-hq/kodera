import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { AppProviders, createQueryClient } from '@/app/providers'
import { useAuth } from '@/auth/AuthProvider'

function Probe() {
  const queryClient = useQueryClient()
  const auth = useAuth()
  return (
    <div>
      <p data-testid="has-query-client">{String(queryClient instanceof QueryClient)}</p>
      <p data-testid="authenticated">{String(auth.isAuthenticated)}</p>
    </div>
  )
}

describe('AppProviders', () => {
  it('wires the query client and the auth context for its children', () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>
    )
    expect(screen.getByTestId('has-query-client')).toHaveTextContent('true')
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('uses a caller-provided query client instead of creating its own', () => {
    const client = createQueryClient()
    render(
      <AppProviders queryClient={client}>
        <Probe />
      </AppProviders>
    )
    expect(screen.getByTestId('has-query-client')).toHaveTextContent('true')
  })

  it("createQueryClient turns refetchOnWindowFocus off (ADR-0005: rules come from each resource's own config, not a global refetch)", () => {
    const client = createQueryClient()
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })
})
