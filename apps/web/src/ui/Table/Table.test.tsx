import preset from '@kodera/design-tokens/tailwind-preset'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { THEMES, roleHex } from '../../../tests/roleHex'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowActions,
  TableStatusCell,
} from './Table'

function Example() {
  return (
    <Table caption="Personnes de l'organisation">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Nom</TableHeaderCell>
          <TableHeaderCell status>Statut</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableCell>Henri Duflot</TableCell>
          <TableStatusCell>Active</TableStatusCell>
          <TableRowActions>
            <button type="button">Retirer</button>
          </TableRowActions>
        </TableRow>
      </TableBody>
    </Table>
  )
}

const LETTER_SPACING = preset.theme.extend.letterSpacing

/** The `tracking-*` classes on one element, in source order. */
function trackingClassesOf(element: Element): string[] {
  return [...element.classList].filter((className) => className.startsWith('tracking-'))
}

/** Those of `classNames` that name no key of the preset's letter-spacing
 * scale. A `tracking-*` class outside the preset is not an error and emits no
 * warning: Tailwind's own scale answers it, on a value nobody chose. */
function unresolvedTracking(classNames: string[]): string[] {
  return classNames.filter((className) => !(className.slice('tracking-'.length) in LETTER_SPACING))
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe('Table', () => {
  it('preserves readable small header text alongside the corrected table structure', () => {
    render(<Example />)
    const header = screen.getByRole('columnheader', { name: 'Nom' })
    const head = header.closest('thead')!
    const foreground = [...header.classList].find((name) => name.startsWith('text-c-ink'))!
    const background = [...head.classList].find((name) => name.startsWith('bg-'))!
    // This was a negative control: `ink-3` once measured 3.21 here and the
    // assertion pinned it below 4.5, so the choice of a darker ink read as a
    // necessity rather than a preference. The palette has since moved (ADR-0002,
    // then the themed roles) and that assertion is simply false; narrowing it
    // would be worse than removing it. What replaces it is the fact that is true
    // now, in every theme: BOTH inks clear 4.5 here, so this element's ink is a
    // visual-hierarchy decision and no longer an accessibility one.
    for (const theme of THEMES) {
      const bg = roleHex(background, theme)
      expect(contrastRatio(roleHex(foreground, theme), bg), theme).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(roleHex('text-c-ink-3', theme), bg), theme).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('is a semantic table with the caption as its accessible name', () => {
    render(<Example />)

    expect(screen.getByRole('table', { name: "Personnes de l'organisation" })).toBeInTheDocument()
  })

  it('renders column headers and rows in reading order', () => {
    render(<Example />)

    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers[0]).toHaveTextContent('Nom')
    expect(headers[1]).toHaveTextContent('Statut')

    const row = within(table).getAllByRole('row')[1]
    expect(row).not.toBeUndefined()
    expect(within(row as HTMLElement).getByText('Henri Duflot')).toBeInTheDocument()
  })

  it('gives the status column a minimum width of 120px', () => {
    render(<Example />)

    expect(screen.getByRole('columnheader', { name: 'Statut' })).toHaveClass('min-w-[120px]')
    expect(screen.getByText('Active')).toHaveClass('min-w-[120px]')
  })

  it('puts the row actions in their own cell', () => {
    render(<Example />)

    expect(screen.getByRole('button', { name: 'Retirer' })).toBeInTheDocument()
  })

  it('wraps the table in a horizontally scrollable container', () => {
    render(<Example />)

    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('overflow-x-auto')
  })

  it('makes that container a keyboard-reachable region named by the caption', () => {
    // WCAG 2.1.1: six columns of invoice history on a narrow viewport scroll
    // inside this box, and a box that only a pointer can scroll strands the
    // keyboard. jsdom performs no layout, so axe's `scrollable-region-focusable`
    // reports neither a violation nor an incomplete here — the attributes are
    // asserted directly instead.
    render(<Example />)

    const region = screen.getByRole('region', { name: "Personnes de l'organisation" })

    expect(region).toBe(screen.getByRole('table').parentElement)
    expect(region.tabIndex).toBe(0)
    expect(region).toHaveClass('overflow-x-auto')
  })

  it('gives that region the first tab stop, ahead of the row actions', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.tab()

    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: "Personnes de l'organisation" })
    )
  })

  it('rejects a tracking class the preset never names', () => {
    // Guards the check below against passing vacuously. `wide` is not a step
    // the preset publishes, so `tracking-wide` silently takes Tailwind's own
    // 0.025em; `tight` is one, so it must be left alone.
    expect(unresolvedTracking(['tracking-wide', 'tracking-tight'])).toEqual(['tracking-wide'])
  })

  it('names no letter-spacing outside the preset on a column header', () => {
    render(<Example />)

    const header = screen.getByRole('columnheader', { name: 'Nom' })

    expect(unresolvedTracking(trackingClassesOf(header))).toEqual([])
    // What the header carries today: nothing. The preset publishes `tight` and
    // `snug` only, neither of which is the widened tracking an uppercase
    // micro-label would want — so the header names no step at all rather than
    // borrowing one from Tailwind. Update this line the day the tokens package
    // adds a `wide` step and this component consumes it.
    expect(trackingClassesOf(header)).toEqual([])
  })
})
