import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { THEMES, roleHex } from '../../../tests/roleHex'
import { QrPanel } from './QrPanel'

const code = {
  label: 'Ou saisissez la clé',
  value: 'JBSW Y3DP EHPK 3PXP',
  status: 'idle' as const,
  copyLabel: 'Copier',
  copiedLabel: 'Copié',
  onCopy: () => {},
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

describe('QrPanel', () => {
  it('renders the QR as an SVG image with its text alternative', () => {
    render(
      <QrPanel
        value="otpauth://totp/Kodera:claire@acme.fr"
        alt="Code QR de connexion à l'application d'authentification"
        code={code}
        failureMessage="Le code QR est indisponible."
      />
    )

    expect(
      screen.getByRole('img', {
        name: "Code QR de connexion à l'application d'authentification",
      })
    ).toBeInTheDocument()
  })

  it('renders the copyable short code beside the QR', () => {
    render(
      <QrPanel
        value="otpauth://totp/Kodera:claire@acme.fr"
        alt="Code QR"
        code={code}
        failureMessage="Le code QR est indisponible."
      />
    )

    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument()
  })

  it('calls onCopy when the code button is activated', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(
      <QrPanel
        value="otpauth://totp/Kodera:claire@acme.fr"
        alt="Code QR"
        code={{ ...code, onCopy }}
        failureMessage="Le code QR est indisponible."
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copier' }))

    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('renders the failure state, never a broken image, when value is empty', () => {
    render(
      <QrPanel value="" alt="Code QR" code={code} failureMessage="Le code QR est indisponible." />
    )

    expect(screen.getByText('Le code QR est indisponible.')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
    // The short code stays reachable even when the image cannot be built.
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
  })

  it('keeps the failure placeholder readable on its muted surface', () => {
    // Small text on `bg-c-muted`: the same pair `Table` and
    // `CopyableField` already moved off `ink-3`, which measures short of the
    // 4.5:1 WCAG AA floor with the pinned tokens. jsdom cannot measure
    // contrast, so this reads the token values the role classes resolve to, in
    // each theme.
    render(
      <QrPanel value="" alt="Code QR" code={code} failureMessage="Le code QR est indisponible." />
    )
    const placeholder = screen.getByText('Le code QR est indisponible.')
    const foreground = [...placeholder.classList].find((name) => name.startsWith('text-c-ink'))!
    const background = [...placeholder.classList].find((name) => name.startsWith('bg-'))!
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

  it('renders the failure state when value is only whitespace', () => {
    render(
      <QrPanel
        value="   "
        alt="Code QR"
        code={code}
        failureMessage="Le code QR est indisponible."
      />
    )

    expect(screen.getByText('Le code QR est indisponible.')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders the failure state when the value overflows what a QR can encode', () => {
    render(
      <QrPanel
        value={'x'.repeat(5000)}
        alt="Code QR"
        code={code}
        failureMessage="Le code QR est indisponible."
      />
    )

    expect(screen.getByText('Le code QR est indisponible.')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
