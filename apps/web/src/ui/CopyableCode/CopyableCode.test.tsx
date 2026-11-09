import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyableCode } from './CopyableCode'

const dnsRecord = 'TXT @ "kodera-verify=8f2c9a1d"\nCNAME visio visio.kodera.io.'

describe('CopyableCode', () => {
  it('renders multi-line content in a monospace block', () => {
    render(
      <CopyableCode
        label="Enregistrements DNS"
        value={dnsRecord}
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    const block = screen.getByText((_, element) => element?.textContent === dnsRecord)
    expect(block.tagName).toBe('PRE')
    expect(block).toHaveClass('font-mono')
  })

  it('shows the label above the block', () => {
    render(
      <CopyableCode
        label="Enregistrement TXT"
        value={dnsRecord}
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByText('Enregistrement TXT')).not.toHaveClass('sr-only')
  })

  it('calls onCopy from the copy button and never asks the user to retype the value', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(
      <CopyableCode
        label="Enregistrements DNS"
        value={dnsRecord}
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={onCopy}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copier' }))

    expect(onCopy).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('makes the scrollable block a keyboard-reachable region named by the label', () => {
    // The `<pre>` scrolls horizontally and can never hold a focusable child, so
    // without `tabIndex` the far end of a long DNS value is reachable by
    // pointer only (WCAG 2.1.1). jsdom performs no layout, so axe's
    // `scrollable-region-focusable` reports neither a violation nor an
    // incomplete here — the attributes are asserted directly instead.
    render(
      <CopyableCode
        label="Enregistrements DNS"
        value={dnsRecord}
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    const region = screen.getByRole('region', { name: 'Enregistrements DNS' })

    expect(region.tagName).toBe('PRE')
    expect(region.tabIndex).toBe(0)
    expect(region).toHaveClass('overflow-x-auto')
  })

  it('names the region from the same string when the label is not shown', () => {
    // One string, never two: the region's name is the label element itself, so
    // a hidden label cannot drift away from what the region announces.
    render(
      <CopyableCode
        label="Enregistrements DNS"
        labelHidden
        value={dnsRecord}
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByRole('region', { name: 'Enregistrements DNS' }).tabIndex).toBe(0)
    expect(screen.getByText('Enregistrements DNS')).toHaveClass('sr-only')
  })

  it('shows the copied label when the caller sets status to copied', () => {
    render(
      <CopyableCode
        label="Enregistrements DNS"
        value={dnsRecord}
        status="copied"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Copié' })).toBeInTheDocument()
  })
})
