import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import '@/i18n'
import { PeoplePreparation } from './PeoplePreparation'

it.each(['org_owner', 'org_admin', 'org_billing', 'org_member', 'member'] as const)(
  'requires an explicit management role for standalone preparation: %s',
  (role) => {
    render(<PeoplePreparation org="other-org" role={role} source="status" />)
    const link = screen.queryByRole('link')
    if (role === 'org_owner' || role === 'org_admin') {
      expect(link).toHaveAttribute('href', '/other-org/people/import?from=status')
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Pendant ce temps')
    } else {
      expect(link).toBeNull()
      expect(screen.queryByRole('heading')).toBeNull()
    }
  }
)
