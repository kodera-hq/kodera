import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { themeIds } from '@kodera/design-tokens/themes'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KoderaStageEmblem, StageButton, StageSecondaryLink } from './KoderaStageEmblem'

const ENTRY_BOOTSTRAP = readFileSync(
  join(import.meta.dirname, '..', '..', 'entry-bootstrap.ts'),
  'utf8'
)

describe('KoderaStageEmblem & StageButton', () => {
  it('separates stage-emblem-box and stage-emblem-on classes when animated', () => {
    const { container, rerender } = render(<KoderaStageEmblem />)
    const node = container.firstElementChild as HTMLElement
    expect(node.classList.contains('stage-reticle')).toBe(true)
    expect(node.classList.contains('stage-emblem-box')).toBe(true)
    expect(node.classList.contains('stage-emblem-on')).toBe(false)

    rerender(<KoderaStageEmblem animated />)
    expect(node.classList.contains('stage-emblem-box')).toBe(true)
    expect(node.classList.contains('stage-emblem-on')).toBe(true)
  })

  it('keeps StageButton focusable while loading, suppresses clicks, and merges caller className', () => {
    const onClick = vi.fn()
    render(
      <StageButton loading onClick={onClick} className="custom-stage-action">
        Retry
      </StageButton>
    )
    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('data-loading', '')
    expect(button.classList.contains('custom-stage-action')).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('preserves caller className on StageSecondaryLink', () => {
    render(
      <StageSecondaryLink href="/home" className="custom-stage-link">
        Home
      </StageSecondaryLink>
    )
    const link = screen.getByRole('link', { name: 'Home' })
    expect(link.classList.contains('custom-stage-link')).toBe(true)
  })

  it('keeps entry-bootstrap KNOWN_THEMES synchronized with @kodera/design-tokens themeIds', () => {
    const match = ENTRY_BOOTSTRAP.match(/const KNOWN_THEMES = \[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const bootstrapIds = (match?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort()
    expect(bootstrapIds).toEqual([...themeIds].sort())
  })
})
