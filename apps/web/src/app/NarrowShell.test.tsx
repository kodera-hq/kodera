import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type * as RouterModule from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { AccountItem } from './accountItems'
import { NarrowTopBar } from './NarrowShell'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault()
        onClick?.()
      }}
    >
      {children}
    </a>
  ),
}))

// The trap a new top-menu entry would fall into: the menu once wired every entry to sign-out.
// Stub entries of every other kind, each labelled with a real catalogue key.
const STUB_ITEMS: readonly AccountItem[] = [
  {
    id: 'stub-place',
    kind: 'place',
    labelKey: 'console.shell.account.action-security',
    to: '/$org/security',
    wide: true,
    narrow: 'account-menu',
  },
  {
    id: 'stub-pending',
    kind: 'pending',
    labelKey: 'console.shell.account.action-language',
    wide: true,
    narrow: 'account-menu',
  },
  {
    id: 'sign-out',
    kind: 'sign-out',
    labelKey: 'console.shell.account.action-sign-out',
    wide: true,
    narrow: 'account-menu',
  },
]

function renderTopBar(onSignOut: () => void, displayName = 'Henri Duflot') {
  render(
    <NarrowTopBar
      org="acme-sa"
      organisation={{ name: 'ACME', slug: 'acme-sa' }}
      user={{ displayName, role: 'org_admin' }}
      onSignOut={onSignOut}
      accountItems={STUB_ITEMS}
    />
  )
}

describe('NarrowTopBar account entries', () => {
  it('signs out only from the sign-out entry, whatever else the menu holds', async () => {
    const user = userEvent.setup()
    const onSignOut = vi.fn()
    renderTopBar(onSignOut)
    await user.click(screen.getByRole('button', { name: 'HD · Compte et organisation' }))

    const place = screen.getByRole('link', { name: 'Sécurité et connexion' })
    expect(place).toHaveAttribute('href', '/$org/security')
    await user.click(place)
    expect(onSignOut).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'HD · Compte et organisation' }))
    const pending = screen.getByRole('button', { name: 'Langue' })
    expect(pending).toBeDisabled()
    await user.click(pending)
    expect(onSignOut).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  // WCAG 2.5.3, label in name: the button shows the avatar's initials, so its accessible name
  // starts with them, and the menu it opens keeps its own title.
  it('names the account button with the initials it shows', async () => {
    const user = userEvent.setup()
    renderTopBar(vi.fn())
    const button = screen.getByRole('button', { name: 'HD · Compte et organisation' })
    expect(button).toHaveTextContent('HD')
    await user.click(button)
    expect(screen.getByRole('dialog', { name: 'Compte et organisation' })).toBeInTheDocument()
  })

  it('keeps the plain name when there are no initials to show', () => {
    renderTopBar(vi.fn(), ' ')
    expect(screen.getByRole('button', { name: 'Compte et organisation' })).toBeInTheDocument()
  })
})
