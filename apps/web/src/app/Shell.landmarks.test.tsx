// The shell's landmark structure, which this change altered: it used to be one
// `nav` and `main`, and it is now two `nav`s and `main`. Two landmarks of the
// same role have to be told apart by name, and the skip link has to stay first
// in the focus order (docs/specs/00-shell-and-login.md §10) even though a whole
// strip of controls now precedes the sidebar in the DOM.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { Shell } from './Shell'
import type { OrganisationRole } from './Sidebar'
import type { MessageKey } from '../i18n'

vi.mock('./StatusBanner', () => ({ StatusBanner: () => null }))
vi.mock('../features/status/queries', () => ({
  useOrganisationTenant: () => ({ data: { id: 'tenant-1' } }),
  useTenantStatus: () => ({
    data: {
      apps: [{ code: 'visio', name: 'Visio', url: 'https://visio.example', state: 'live' }],
    },
  }),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)

// `Shell`'s own `role` prop is an organisation role, not an ARIA role — but a
// string literal in that position is indistinguishable from one to
// `jsx-a11y/aria-role`, which reads the attribute name alone. Typed here so
// the value is an expression, the way every production call site already
// writes it (`src/app/org-route.tsx` passes `membership.role`).
const ROLE: OrganisationRole = 'org_admin'

function renderShell(
  props: {
    organisationMark?: string
    contentTitleKey?: MessageKey
    surface?: 'console' | 'workspace'
  } = {}
) {
  return render(
    <Shell
      org="vercelli"
      organisationId="org-1"
      organisation={{ name: 'Groupe Vercelli', slug: 'vercelli' }}
      user={{ displayName: 'Claire Mercier', role: 'org_admin' }}
      role={ROLE}
      onSignOut={() => {}}
      {...props}
    >
      <h1>Bonjour Claire</h1>
    </Shell>
  )
}

describe('shell landmarks', () => {
  it('provides a contextual header without adding a second page heading', () => {
    renderShell({ contentTitleKey: 'console.shell.nav.title-apps' })
    const header = screen.getByRole('banner', { name: 'En-tête de la page' })
    expect(header).toHaveTextContent('Applications')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // Its own token, 56 px.
    expect(header).toHaveClass('h-shell-header-height')
  })

  it('toggles the desktop sidebar without losing the page content', async () => {
    renderShell()
    const button = screen.getByRole('button', { name: 'Masquer la navigation' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('navigation', { name: 'Navigation principale' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bonjour Claire' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Afficher la navigation' }))
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  })

  it('names the sidebar toggle, an icon, with a tooltip on focus that follows its state', async () => {
    const user = userEvent.setup()
    renderShell()
    const toggle = screen.getByRole('button', { name: 'Masquer la navigation' })
    toggle.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}{Tab}')
    expect(toggle).toHaveFocus()
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Masquer la navigation')
    expect(toggle).toHaveAccessibleDescription('')
    // Pressing it closes the tooltip (Radix's); the next focus shows the new name.
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAccessibleName('Afficher la navigation')
    await user.keyboard('{Shift>}{Tab}{/Shift}{Tab}')
    expect(toggle).toHaveFocus()
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(
      'Afficher la navigation'
    )
  })

  it('names both navigation landmarks, so neither is "navigation" twice', () => {
    renderShell()
    const landmarks = screen.getAllByRole('navigation')
    expect(landmarks).toHaveLength(2)
    const names = landmarks.map((nav) => nav.getAttribute('aria-label'))
    expect(names).toEqual(['Modules', 'Navigation principale'])
    // Distinct, not merely present: two landmarks sharing one name are no
    // easier to tell apart than two with none.
    expect(new Set(names).size).toBe(2)
  })

  it('keeps the skip link first in the document order, ahead of the rail', () => {
    const { container } = renderShell()
    const skip = screen.getByRole('link', { name: 'Aller au contenu' })
    const rail = screen.getByRole('navigation', { name: 'Modules' })
    expect(container.contains(skip)).toBe(true)
    // `DOCUMENT_POSITION_FOLLOWING` on the rail means the skip link comes
    // first — and with no positive `tabindex` anywhere in the shell, document
    // order IS the tab order.
    expect(skip.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[tabindex]:not([tabindex="-1"])')).toHaveLength(0)
  })

  it('colours the skip link shadow only while it is shown, as at login', () => {
    // `shadow-pop` sets its own static colour; the themed one has to carry the
    // same `focus-visible:` variant to land after it. Unprefixed, it applied
    // to the hidden link and lost to `shadow-pop`'s colour once shown.
    renderShell()
    const skip = screen.getByRole('link', { name: 'Aller au contenu' })
    expect(skip).toHaveClass('focus-visible:shadow-pop', 'focus-visible:shadow-c-shadow-2')
    expect([...skip.classList].filter((name) => /^shadow-/.test(name))).toEqual([])
  })

  it('puts the maker mark in the rail and the tenant mark in the sidebar, never the reverse', () => {
    renderShell({ organisationMark: 'data:image/svg+xml,tenant' })
    const rail = screen.getByRole('navigation', { name: 'Modules' })
    const sidebar = screen.getByRole('navigation', { name: 'Navigation principale' })

    expect(rail.querySelector('img[src="/kodera-mark-white.svg"]')).not.toBeNull()
    expect(sidebar.querySelector('img[src="/kodera-mark-white.svg"]')).toBeNull()

    expect(sidebar.querySelector('img[src="data:image/svg+xml,tenant"]')).not.toBeNull()
    expect(rail.querySelector('img[src="data:image/svg+xml,tenant"]')).toBeNull()
  })

  it('shows no tenant mark at all when none is given — the shape of every real build', () => {
    renderShell()
    const sidebar = screen.getByRole('navigation', { name: 'Navigation principale' })
    expect(sidebar.querySelector('img')).toBeNull()
  })

  it('gives the workspace its own layout: the rail, and no console navigation or header', () => {
    renderShell({ surface: 'workspace' })
    expect(screen.getByRole('navigation', { name: 'Modules' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).toBeNull()
    expect(screen.queryByRole('banner', { name: 'En-tête de la page' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Accueil' })).toBeNull()
    expect(screen.getByRole('main')).toContainElement(
      screen.getByRole('heading', { name: 'Bonjour Claire' })
    )
    // The skip link still opens the focus order.
    expect(screen.getAllByRole('link')[0]).toHaveTextContent('Aller au contenu')
  })
})
