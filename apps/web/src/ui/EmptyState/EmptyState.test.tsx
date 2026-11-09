import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title as a heading, so a screen reader can jump to it', () => {
    render(
      <EmptyState title="Aucune personne invitée" body="Invitez votre équipe pour commencer." />
    )

    expect(screen.getByRole('heading', { name: 'Aucune personne invitée' })).toBeInTheDocument()
  })

  it('renders the body text', () => {
    render(<EmptyState title="Aucun domaine" body="Ajoutez votre premier domaine." />)

    expect(screen.getByText('Ajoutez votre premier domaine.')).toBeInTheDocument()
  })

  it('hides a decorative icon from assistive technology', () => {
    render(
      <EmptyState
        title="Aucune facture"
        body="Rien à afficher pour le moment."
        icon={<svg data-testid="icon" viewBox="0 0 16 16" />}
      />
    )

    const icon = screen.getByTestId('icon')
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('renders the one action the caller passes', () => {
    render(
      <EmptyState
        title="Aucune personne invitée"
        body="Invitez votre équipe pour commencer."
        action={<button type="button">Inviter des personnes</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Inviter des personnes' })).toBeInTheDocument()
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<EmptyState ref={ref} title="Vide" body="Rien ici." />)

    expect(ref.current).not.toBeNull()
  })

  it('concatenates the caller class with its own layout classes', () => {
    render(<EmptyState className="mt-6" title="Vide" body="Rien ici." data-testid="empty" />)

    expect(screen.getByTestId('empty')).toHaveClass('mt-6')
  })
})

it('keeps section titles at level three by default', () => {
  render(<EmptyState title="No records" body="Nothing yet." />)
  expect(screen.getByRole('heading', { level: 3, name: 'No records' })).toHaveClass(
    'text-lg',
    'font-semibold',
    'text-c-ink'
  )
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
})

it('lets a whole-page empty state opt into one page heading without changing its styles', () => {
  render(<EmptyState headingLevel={1} title="No instance" body="Nothing yet." />)
  expect(screen.getByRole('heading', { level: 1, name: 'No instance' })).toHaveClass(
    'text-lg',
    'font-semibold',
    'text-c-ink'
  )
  expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
})

it('lets feedback directly below a page heading opt into level two without changing its styles', () => {
  render(<EmptyState headingLevel={2} title="No records" body="Nothing yet." />)
  expect(screen.getByRole('heading', { level: 2, name: 'No records' })).toHaveClass(
    'text-lg',
    'font-semibold',
    'text-c-ink'
  )
  expect(screen.getAllByRole('heading')).toHaveLength(1)
})
