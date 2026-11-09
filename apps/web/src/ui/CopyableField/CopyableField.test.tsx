import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyableField } from './CopyableField'

describe('CopyableField', () => {
  it('keeps stacked values selectable and their copy control keyboard-operable', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(
      <CopyableField
        layout="stacked"
        label="Visio"
        value="https://visio.example.test"
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={onCopy}
      />
    )
    expect(screen.getByText('https://visio.example.test')).toBeVisible()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Copier' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('shows the label and the value', () => {
    render(
      <CopyableField
        label="Clé API"
        value="F-2026-0042"
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByText('Clé API')).toBeInTheDocument()
    expect(screen.getByText('F-2026-0042')).toBeInTheDocument()
  })

  it('renders the value in mono', () => {
    render(
      <CopyableField
        label="Clé API"
        value="F-2026-0042"
        status="idle"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByText('F-2026-0042')).toHaveClass('font-mono')
  })

  it('calls onCopy when the button is activated, and never asks the user to retype the value', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(
      <CopyableField
        label="Clé API"
        value="F-2026-0042"
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

  it('shows the copied label when the caller sets status to copied', () => {
    render(
      <CopyableField
        label="Clé API"
        value="F-2026-0042"
        status="copied"
        copyLabel="Copier"
        copiedLabel="Copié"
        onCopy={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Copié' })).toBeInTheDocument()
  })
})
