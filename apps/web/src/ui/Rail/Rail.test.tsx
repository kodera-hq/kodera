import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef } from 'react'
import type { AnchorHTMLAttributes } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Rail, RailItem } from './Rail'

const glyph = <svg aria-hidden="true" data-testid="glyph" />

function setup() {
  render(
    <Rail label="Applications" mark={<a href="/home">Accueil</a>} footer={<span>IK</span>}>
      <RailItem
        href="/visio"
        label="Visio"
        icon={glyph}
        opensElsewhere="s’ouvre dans un nouvel onglet"
      />
      <RailItem href="/workspace" label="Espace" icon={glyph} attention="2 personnes attendent" />
      <RailItem href="/console" label="Console" icon={glyph} current />
    </Rail>
  )
}

describe('Rail', () => {
  it('is a named navigation landmark holding one list item per destination', () => {
    setup()
    const nav = screen.getByRole('navigation', { name: 'Applications' })
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3)
    expect(within(nav).getByRole('link', { name: 'Accueil' })).toBeInTheDocument()
    expect(within(nav).getByText('IK')).toBeInTheDocument()
  })

  it('marks exactly the current destination, with a marker that is not colour alone', () => {
    setup()
    const current = screen.getByRole('link', { name: 'Console' })
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current).toHaveClass('bg-c-action')
    expect(current.querySelector('.bg-c-on-inverse')).not.toBeNull()
    for (const name of [/Visio/, /Espace/]) {
      const idle = screen.getByRole('link', { name })
      expect(idle).not.toHaveAttribute('aria-current')
      expect(idle).not.toHaveClass('bg-c-action')
      expect(idle.querySelector('.bg-c-on-inverse')).toBeNull()
    }
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')
    ).toHaveLength(1)
  })

  it('names a destination that opens elsewhere, and one where something waits', () => {
    setup()
    expect(
      screen.getByRole('link', { name: 'Visio — s’ouvre dans un nouvel onglet' })
    ).toBeInTheDocument()
    const waiting = screen.getByRole('link', { name: 'Espace, 2 personnes attendent' })
    expect(waiting.querySelector('.bg-c-bad-on-dark')).not.toBeNull()
  })

  it('opens a destination announced as opening elsewhere in a new tab', () => {
    setup()
    const link = screen.getByRole('link', { name: /Visio/ })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
    expect(screen.getByRole('link', { name: 'Console' })).not.toHaveAttribute('target')
  })

  it('draws no attention dot when nothing waits', () => {
    setup()
    expect(
      screen.getByRole('link', { name: 'Console' }).querySelector('.bg-c-bad-on-dark')
    ).toBeNull()
  })

  it('renders the caller’s link element with asChild, keeping its props', () => {
    const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
      function RouterLink(props, ref) {
        return (
          <a ref={ref} data-router="" {...props}>
            {props.children}
          </a>
        )
      }
    )
    render(
      <Rail label="Applications">
        <RailItem asChild label="Console" icon={glyph} current>
          <RouterLink href="/acme/home" />
        </RailItem>
      </Rail>
    )
    const link = screen.getByRole('link', { name: 'Console' })
    expect(link).toHaveAttribute('data-router')
    expect(link).toHaveAttribute('href', '/acme/home')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link).toHaveAttribute('aria-label', 'Console')
    expect(link).toHaveClass('bg-c-action', 'h-12', 'w-12', 'focus-visible:ring-c-on-inverse')
    // Icons only: the name is the accessible name, never text drawn under the glyph.
    expect(link).toHaveTextContent('')
    expect(within(link).getByTestId('glyph')).toBeInTheDocument()
  })

  it('keeps the item’s state when the asChild child tries to override it', () => {
    render(
      <Rail label="Applications">
        <RailItem asChild label="Console" icon={glyph} current>
          <a href="/acme/home" aria-current="false" aria-label="Autre nom" title="Autre titre">
            {null}
          </a>
        </RailItem>
      </Rail>
    )
    const link = screen.getByRole('link', { name: 'Console' })
    expect(link).toHaveAttribute('aria-current', 'page')
    // The child's title is taken off, and the item sets none: its tooltip shows the name.
    expect(link).not.toHaveAttribute('title')
    expect(link).toHaveAttribute('href', '/acme/home')
  })

  it('draws every item’s focus ring in the on-inverse tone', () => {
    setup()
    for (const link of screen.getAllByRole('link').slice(1)) {
      expect(link).toHaveClass('focus-visible:ring-c-on-inverse')
    }
  })

  it('refuses an asChild child that is not exactly one element', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      render(
        <Rail label="Applications">
          <RailItem asChild label="Console" icon={glyph}>
            <>
              <a href="/a">a</a>
            </>
          </RailItem>
        </Rail>
      )
    ).toThrow(/exactly one element child/)
    quiet.mockRestore()
  })

  it('shows an item’s name as a tooltip on focus, read once, with asChild too', async () => {
    const user = userEvent.setup()
    const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
      function RouterLink(props, ref) {
        return (
          <a ref={ref} {...props}>
            {props.children}
          </a>
        )
      }
    )
    render(
      <Rail label="Applications">
        <RailItem href="/visio" label="Visio" icon={glyph} opensElsewhere="nouvel onglet" />
        <RailItem asChild label="Console" icon={glyph}>
          <RouterLink href="/acme/home" />
        </RailItem>
      </Rail>
    )
    await user.tab()
    // The tooltip shows the name alone; the accessible name keeps the new-tab announcement.
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(/^Visio$/)
    expect(screen.getByRole('link', { name: 'Visio — nouvel onglet' })).toHaveFocus()
    await user.tab()
    const console_ = screen.getByRole('link', { name: 'Console' })
    expect(console_).toHaveFocus()
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Console')
    expect(console_).toHaveAccessibleDescription('')
  })
})
