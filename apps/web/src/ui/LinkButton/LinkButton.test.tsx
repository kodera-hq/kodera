import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LinkButton } from './LinkButton'

describe('LinkButton', () => {
  it('is a link with the label and destination the caller gave it', () => {
    render(<LinkButton href="/factures">Voir les factures</LinkButton>)

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toBeVisible()
    expect(link).toHaveAttribute('href', '/factures')
  })

  it('adds noopener noreferrer to a blank-target link the caller did not annotate', () => {
    // A `target="_blank"` anchor with no `rel` keeps a handle on `window.opener`
    // for the page it navigates to — the reverse-tabnabbing hole `rel` closes.
    render(
      <LinkButton href="https://status.kodera.io" target="_blank">
        Voir le statut
      </LinkButton>
    )

    expect(screen.getByRole('link', { name: 'Voir le statut' })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    )
  })

  it('keeps the caller-supplied rel on a blank-target link', () => {
    render(
      <LinkButton href="https://status.kodera.io" target="_blank" rel="noopener author">
        Voir le statut
      </LinkButton>
    )

    expect(screen.getByRole('link', { name: 'Voir le statut' })).toHaveAttribute(
      'rel',
      'noopener author'
    )
  })

  it('is disabled without navigating, since an anchor has no disabled attribute', () => {
    const onClick = vi.fn()
    render(
      <LinkButton href="/factures" disabled onClick={onClick}>
        Voir les factures
      </LinkButton>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(link).toHaveAttribute('data-disabled')
    expect(link).toHaveAttribute('tabindex', '-1')

    link.click()

    expect(onClick).not.toHaveBeenCalled()
  })

  it('stays unavailable even if a caller passes a conflicting aria-disabled', () => {
    // `aria-disabled` is a valid prop here (`AnchorHTMLAttributes`) — a stray
    // `aria-disabled="false"` from elsewhere must not make a `disabled` link
    // announce itself as available while the click guard still blocks it.
    render(
      <LinkButton href="/factures" disabled aria-disabled="false">
        Voir les factures
      </LinkButton>
    )

    expect(screen.getByRole('link', { name: 'Voir les factures' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('hides the icon from assistive technology so it cannot become the name', () => {
    render(
      <LinkButton
        href="/domaines"
        icon={
          <svg viewBox="0 0 16 16">
            <title>Signe plus</title>
          </svg>
        }
      >
        Ajouter un domaine
      </LinkButton>
    )

    expect(screen.getByRole('link')).toHaveAccessibleName('Ajouter un domaine')
  })

  it('renders the caller element with asChild, so a router link can look like a button', () => {
    render(
      <LinkButton asChild variant="secondary">
        <a href="/factures" data-router-link="">
          Voir les factures
        </a>
      </LinkButton>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveAttribute('href', '/factures')
    expect(link).toHaveAttribute('data-router-link', '')
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLAnchorElement>()
    render(
      <LinkButton href="/factures" ref={ref}>
        Voir les factures
      </LinkButton>
    )

    ref.current?.focus()

    expect(screen.getByRole('link', { name: 'Voir les factures' })).toHaveFocus()
  })

  it('concatenates the caller class with the variant classes', () => {
    render(
      <LinkButton href="/factures" className="w-full">
        Voir les factures
      </LinkButton>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveClass('w-full')
    expect(link).toHaveClass('inline-flex')
  })
})
