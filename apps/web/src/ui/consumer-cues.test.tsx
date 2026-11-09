import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Root } from 'postcss'
import { Button } from './Button/Button'
import { LinkButton } from './LinkButton/LinkButton'
import { TimelineMessage } from './TimelineMessage/TimelineMessage'
import { LINK_TEXT } from './linkText'
import { classesOf, compiled } from '../../tests/unit/ui/tailwind'

function declarations(root: Root, selector: string, property: string): string[] {
  const values: string[] = []
  root.walkRules((rule) => {
    if (rule.selector.includes(selector))
      rule.walkDecls(property, (declaration) => {
        values.push(declaration.value)
      })
  })
  return values
}

function expectRowCues(root: Root) {
  expect(declarations(root, '.hover\\:bg-c-muted:hover', 'background-color')).toContain(
    'var(--c-muted)'
  )
  expect(
    declarations(root, '.focus-within\\:bg-c-muted:focus-within', 'background-color')
  ).toContain('var(--c-muted)')
}

function expectInlineCue(root: Root) {
  expect(declarations(root, '.underline', 'text-decoration-line')).toContain('underline')
}

describe('ordinary consumer cues', () => {
  it('compiles actual non-selected message hover and focus-within to the muted role', async () => {
    render(
      <TimelineMessage author="Alice" dateTime="2026-01-01T10:00:00Z" timeLabel="10:00">
        Message
      </TimelineMessage>
    )
    expectRowCues(await compiled(classesOf(screen.getByRole('article'))))
  })

  it('compiles ordinary active ink, standalone hover and keyboard cues from real controls', async () => {
    render(
      <>
        <button className={LINK_TEXT.standalone}>Direct retry</button>
        <Button variant="tertiary">Button action</Button>
        <LinkButton variant="tertiary" href="/help">
          Help link
        </LinkButton>
      </>
    )
    for (const name of ['Direct retry', 'Button action', 'Help link']) {
      const control = screen.getByRole(name === 'Help link' ? 'link' : 'button', { name })
      expect(control).toHaveClass('text-c-ink')
      expect(control).not.toHaveClass('text-c-accent-ink')
      const css = await compiled(classesOf(control))
      expect(declarations(css, '.text-c-ink', 'color')).toContain('var(--c-ink)')
      expect(declarations(css, '.hover\\:underline:hover', 'text-decoration-line')).toContain(
        'underline'
      )
      expect(
        declarations(css, '.focus-visible\\:underline:focus-visible', 'text-decoration-line')
      ).toContain('underline')
      expect(
        declarations(css, '.focus-visible\\:ring:focus-visible', '--tw-ring-shadow').some((value) =>
          value.includes('var(--focus-ring-color)')
        )
      ).toBe(true)
    }
  })

  it('keeps inline underline at rest, destinations, and unavailable-link suppression', async () => {
    const user = userEvent.setup()
    const unavailable = vi.fn()
    render(
      <>
        <LinkButton inline href="/help">
          Inline help
        </LinkButton>
        <LinkButton inline href="/invoices" disabled onClick={unavailable}>
          Unavailable inline
        </LinkButton>
      </>
    )
    const link = screen.getByRole('link', { name: 'Inline help' })
    expect(link).toHaveClass('text-c-ink')
    expect(link).toHaveAttribute('href', '/help')
    expectInlineCue(await compiled(classesOf(link)))
    const disabled = screen.getByRole('link', { name: 'Unavailable inline' })
    expect(disabled).toHaveClass('text-c-ink-4', 'underline')
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    expect(disabled).toHaveAttribute('tabindex', '-1')
    await user.click(disabled)
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('retains primary, danger, disabled and selected-message roles', () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="destructive">Remove</Button>
        <Button variant="tertiary" disabled>
          Unavailable action
        </Button>
        <TimelineMessage author="Alice" dateTime="2026-01-01T10:00:00Z" timeLabel="10:00" focused>
          Selected
        </TimelineMessage>
      </>
    )
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass(
      'bg-c-action',
      'text-c-on-inverse'
    )
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('text-c-bad-ink')
    expect(screen.getByRole('button', { name: 'Unavailable action' })).toHaveClass('text-c-ink-4')
    const selected = screen.getByRole('article')
    expect(selected).toHaveClass('bg-c-accent-soft')
    expect(selected).not.toHaveClass('hover:bg-c-muted', 'focus-within:bg-c-muted')
    expect(selected.querySelector('[data-bar]')).toHaveClass('bg-c-accent-ink')
  })
})
