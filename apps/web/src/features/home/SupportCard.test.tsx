// Owner ruling B (2026-09-24): the card said « Le contexte de votre instance
// est joint au ticket. » while there is no ticket. It says what is true today,
// and its action reaches Aide through the router.
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { SupportCard } from './SupportCard'

vi.mock('../support/HelpLink', async () => {
  const { helpHref } = await import('../support/helpHref')
  return {
    HelpLink: ({
      org,
      search,
      children,
    }: {
      org: string
      search?: Parameters<typeof helpHref>[1]
      children: ReactNode
    }) => <a href={helpHref(org, search)}>{children}</a>,
  }
})

it('says what Aide gives today, claims no ticket, and opens Aide', () => {
  render(
    <SupportCard
      org="acme-sa"
      helpContext={{ articles: [], sla: { first_response_target_minutes: 240 } } as never}
    />
  )
  expect(
    screen.getByText("L'Aide vous indique quoi préciser dans votre message.")
  ).toBeInTheDocument()
  expect(screen.queryByText(/ticket/)).toBeNull()
  expect(screen.getByRole('link', { name: 'Écrire au support' })).toHaveAttribute(
    'href',
    '/acme-sa/help'
  )
})
