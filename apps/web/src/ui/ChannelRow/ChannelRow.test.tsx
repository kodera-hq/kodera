import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef } from 'react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Avatar } from '../Avatar/Avatar'
import { ChannelRow } from './ChannelRow'

function inList(node: ReactNode) {
  return render(<ul>{node}</ul>)
}

describe('ChannelRow', () => {
  it('is a link inside a list item, named by the channel', () => {
    inList(<ChannelRow href="#general" name="général" />)
    const link = screen.getByRole('link', { name: 'général' })
    expect(link).toHaveAttribute('href', '#general')
    expect(link.closest('li')).not.toBeNull()
    expect(link).toHaveTextContent('#')
  })

  it('reads every state in the caller’s words, in order', () => {
    inList(
      <ChannelRow
        href="#general"
        name="général"
        unread="non lu"
        mentions={{ count: 3, label: '3 mentions' }}
        readOnly="lecture seule"
      />
    )
    expect(
      screen.getByRole('link', { name: 'général, non lu, 3 mentions, lecture seule' })
    ).toBeInTheDocument()
  })

  it('marks the selected channel with aria-current, the accent pair and a bar', () => {
    inList(
      <>
        <ChannelRow href="#a" name="annonces" selected />
        <ChannelRow href="#b" name="général" />
      </>
    )
    const selected = screen.getByRole('link', { name: 'annonces' })
    expect(selected).toHaveAttribute('aria-current', 'page')
    expect(selected).toHaveClass('bg-c-accent-soft', 'text-c-accent-ink', 'font-semibold')
    expect(selected.querySelector('[data-selected-bar]')).toHaveClass(
      'bg-c-accent-ink',
      'w-[3px]',
      'rounded-full',
      'top-1',
      'bottom-1'
    )
    // The `#` glyph takes the row's accent ink while current (docs/specs/workspace-dark-roles.md).
    expect(within(selected).getByText('#')).toHaveClass('text-c-accent-ink')
    const idle = screen.getByRole('link', { name: 'général' })
    expect(within(idle).getByText('#')).toHaveClass('text-c-ink-3')
    expect(idle).not.toHaveAttribute('aria-current')
    expect(idle).not.toHaveClass('bg-c-accent-soft')
    expect(idle.querySelector('[data-selected-bar]')).toBeNull()
  })

  it('draws unread as c-ink semibold against the idle regular c-ink-2', () => {
    inList(
      <>
        <ChannelRow href="#a" name="support" unread="non lu" />
        <ChannelRow href="#b" name="général" />
      </>
    )
    expect(screen.getByRole('link', { name: 'support, non lu' })).toHaveClass(
      'text-c-ink',
      'font-semibold'
    )
    expect(screen.getByRole('link', { name: 'général' })).toHaveClass(
      'text-c-ink-3',
      'font-regular',
      'hover:bg-c-muted',
      'hover:text-c-ink'
    )
  })

  it('treats an empty label as off, in the look and in the name alike', () => {
    inList(
      <ChannelRow
        href="#a"
        name="général"
        unread=""
        readOnly=""
        mentions={{ count: 2, label: '' }}
      />
    )
    const link = screen.getByRole('link', { name: 'général' })
    expect(link).toHaveClass('text-c-ink-3', 'font-regular')
    expect(link).not.toHaveClass('text-c-ink')
    expect(link.querySelector('[data-glyph="lock"]')).toBeNull()
    expect(link.querySelector('.bg-c-action')).toBeNull()
  })

  it('draws the lock in c-ink-3', () => {
    inList(<ChannelRow href="#a" name="annonces" readOnly="lecture seule" />)
    const lock = screen
      .getByRole('link', { name: 'annonces, lecture seule' })
      .querySelector('[data-glyph="lock"]')
    expect(lock?.parentElement).toHaveClass('text-c-ink-3')
  })

  it('leads a direct message with the caller’s avatar in place of the #', () => {
    inList(
      <ChannelRow
        href="#dm"
        name="Nadia Chevalier"
        unread="non lu"
        leading={<Avatar name="Nadia Chevalier" size="xs" aria-hidden="true" />}
      />
    )
    const link = screen.getByRole('link', { name: 'Nadia Chevalier, non lu' })
    expect(link).not.toHaveTextContent('#')
    expect(link.querySelector('[data-leading] .h-5')).not.toBeNull()
  })

  it('draws no children inside its own link', () => {
    inList(
      <ChannelRow href="#a" name="général">
        <span>intrus</span>
      </ChannelRow>
    )
    expect(screen.queryByText('intrus')).toBeNull()
  })

  it('draws the mention count on c-action in c-on-inverse, hidden from the name', () => {
    inList(<ChannelRow href="#a" name="général" mentions={{ count: 3, label: '3 mentions' }} />)
    const link = screen.getByRole('link', { name: 'général, 3 mentions' })
    const pill = within(link).getByText('3')
    expect(pill).toHaveClass('bg-c-action', 'text-c-on-inverse', 'rounded-full')
    expect(pill).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws no pill and says nothing for zero mentions', () => {
    inList(<ChannelRow href="#a" name="général" mentions={{ count: 0, label: '0 mention' }} />)
    const link = screen.getByRole('link', { name: 'général' })
    expect(link.querySelector('.bg-c-action')).toBeNull()
  })

  it('draws a lock for a read-only channel and none otherwise', () => {
    inList(
      <>
        <ChannelRow href="#a" name="annonces" readOnly="lecture seule" />
        <ChannelRow href="#b" name="général" />
      </>
    )
    expect(
      screen
        .getByRole('link', { name: 'annonces, lecture seule' })
        .querySelector('[data-glyph="lock"]')
    ).not.toBeNull()
    expect(
      screen.getByRole('link', { name: 'général' }).querySelector('[data-glyph="lock"]')
    ).toBeNull()
  })

  it('is 32 px, 44 px under narrow, with a visible focus ring, and reached by Tab', async () => {
    const user = userEvent.setup()
    inList(<ChannelRow href="#a" name="général" />)
    const link = screen.getByRole('link', { name: 'général' })
    expect(link).toHaveClass('min-h-8', 'narrow:min-h-[44px]', 'focus-visible:ring')
    await user.tab()
    expect(link).toHaveFocus()
  })

  it('passes clicks to the caller', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
    inList(<ChannelRow href="#a" name="général" onClick={onClick} />)
    await user.click(screen.getByRole('link', { name: 'général' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders the router’s link with asChild, keeping its props and not its state', () => {
    const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
      function RouterLink(props, ref) {
        return (
          <a ref={ref} data-router="" {...props}>
            {props.children}
          </a>
        )
      }
    )
    inList(
      <ChannelRow asChild name="général" selected unread="non lu">
        <RouterLink
          href="/acme/espace/general"
          aria-current="false"
          aria-label="Autre"
          title="Autre titre"
        />
      </ChannelRow>
    )
    const link = screen.getByRole('link', { name: 'général, non lu' })
    expect(link).toHaveAttribute('data-router')
    expect(link).toHaveAttribute('href', '/acme/espace/general')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link).not.toHaveAttribute('title')
    expect(link).toHaveClass('bg-c-accent-soft', 'min-h-8')
  })

  it('refuses an asChild child that is not exactly one element', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      inList(
        <ChannelRow asChild name="général">
          <>
            <a href="/a">a</a>
          </>
        </ChannelRow>
      )
    ).toThrow(/exactly one element child/)
    quiet.mockRestore()
  })
})
