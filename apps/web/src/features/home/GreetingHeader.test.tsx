import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { GreetingHeader } from './GreetingHeader'

describe('home greeting', () => {
  it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)(
    'scopes the invitation shortcut for %s',
    (role) => {
      render(
        <GreetingHeader
          org="another-org"
          role={role}
          firstName="Julie"
          now="2026-09-08T12:00:00Z"
          health="operational"
        />
      )
      expect(screen.getByRole('heading')).toHaveTextContent('Bonjour Julie')
      const invite = screen.queryByRole('link', { name: 'Inviter des personnes' })
      if (role === 'org_owner' || role === 'org_admin') {
        expect(invite).toHaveAttribute('href', '/another-org/people/invite')
      } else {
        expect(invite).toBeNull()
      }
    }
  )

  it('keeps a real space between « Bonjour » and the name', () => {
    render(
      <GreetingHeader
        org="acme"
        role={'org_member' as const}
        firstName="Marie-Jeanne"
        now="2026-11-07T10:00:00Z"
        health="operational"
      />
    )
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Bonjour Marie-Jeanne')
  })
})
