// kodera issue 201: the page inside the shell — the router's `<Outlet />`, and in the workspace the view
// that owns the member's call — keeps its React path when the viewport crosses the 768 px
// breakpoint or the shell switches surface. A layout that swapped whole wrappers remounted it, and
// the workspace view leaves its call when it unmounts (`EspaceLiveView`: `ownedCall.leave()`).

import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { Shell } from './Shell'
import type { OrganisationRole } from './Sidebar'
import type { RailSurface } from './railModules'

vi.mock('./StatusBanner', () => ({ StatusBanner: () => null }))
vi.mock('../features/workspace/WorkspaceSettingsHost', () => ({
  WorkspaceSettingsHost: () => null,
}))
vi.mock('../features/status/queries', () => ({
  useOrganisationTenant: () => ({ data: { id: 'tenant-1' } }),
  useTenantStatus: () => ({ data: { apps: [] } }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => '/vercelli/workspace',
}))

const ROLE: OrganisationRole = 'org_admin'

/** A viewport whose narrow media query the test flips, as a browser resize does. */
function controllableViewport() {
  let narrow = false
  const listeners = new Set<() => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return narrow
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }))
  )
  return (next: boolean) => {
    narrow = next
    act(() => {
      for (const listener of [...listeners]) listener()
    })
  }
}

/** Stands for the workspace view: it joins on mount and, as the view does, leaves on unmount. */
const call = { join: vi.fn(), leave: vi.fn() }
function CallOwningPage() {
  useEffect(() => {
    call.join()
    return () => call.leave()
  }, [])
  return <h1>Salon vocal</h1>
}

function shell(surface: RailSurface) {
  return (
    <Shell
      org="vercelli"
      organisationId="org-1"
      organisation={{ name: 'Groupe Vercelli', slug: 'vercelli' }}
      user={{ displayName: 'Claire Mercier', role: 'org_admin' }}
      role={ROLE}
      onSignOut={() => {}}
      surface={surface}
    >
      <CallOwningPage />
    </Shell>
  )
}

beforeEach(() => {
  call.join.mockClear()
  call.leave.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('shell page identity across layouts', () => {
  it('keeps the page and its call through resizes across the 768 px breakpoint', () => {
    const resize = controllableViewport()
    render(shell('workspace'))
    const main = screen.getByRole('main')
    const heading = screen.getByRole('heading', { name: 'Salon vocal' })

    resize(true)
    // The narrow frame is drawn: its own top bar, no rail.
    expect(screen.getByRole('banner')).toBeInTheDocument()
    resize(false)
    resize(true)
    resize(false)

    expect(call.join).toHaveBeenCalledTimes(1)
    expect(call.leave).not.toHaveBeenCalled()
    // The very same nodes, not equal copies: nothing under `<main>` was rebuilt.
    expect(screen.getByRole('main')).toBe(main)
    expect(screen.getByRole('heading', { name: 'Salon vocal' })).toBe(heading)
  })

  it('keeps the page and its call when the shell switches between console and workspace', () => {
    controllableViewport()
    const { rerender } = render(shell('workspace'))
    const heading = screen.getByRole('heading', { name: 'Salon vocal' })

    rerender(shell('console'))
    expect(screen.getByRole('banner', { name: 'En-tête de la page' })).toBeInTheDocument()
    rerender(shell('workspace'))

    expect(call.join).toHaveBeenCalledTimes(1)
    expect(call.leave).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Salon vocal' })).toBe(heading)
  })

  it('keeps the page through a resize while on the console surface too', () => {
    const resize = controllableViewport()
    render(shell('console'))
    resize(true)
    resize(false)
    expect(call.join).toHaveBeenCalledTimes(1)
    expect(call.leave).not.toHaveBeenCalled()
  })
})
