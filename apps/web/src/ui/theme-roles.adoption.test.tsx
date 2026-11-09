import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Button } from './Button/Button'
import { Dialog } from './Dialog/Dialog'
import { Drawer } from './Drawer/Drawer'
import { DropdownMenu } from './DropdownMenu/DropdownMenu'
import { FOCUS_GROUND_ELEVATED } from './focusGround'
import { Combobox } from './Combobox/Combobox'
import { FileDrop } from './FileDrop/FileDrop'
import { Select } from './Select/Select'
import { TextField } from './TextField/TextField'

// The roles tokens v0.2.0 added for what the product reference did not draw
// (`elevated`, `scrim`, `border-input`, `placeholder`, `disabled`,
// `on-disabled`; kodera-design-tokens `docs/specs/shell-themes.md`, "Roles added
// beyond the reference"). Each case pins the role a primitive draws, so a
// primitive that drifts back to the role it used before fails by name. The
// contrast of every pair is gated in the tokens package, not here.

describe('overlays sit on elevated, over the scrim', () => {
  it('Dialog: elevated surface with an edge, scrim behind, offset gaps in elevated', async () => {
    const user = userEvent.setup()
    render(
      <Dialog trigger={<button type="button">Ouvrir</button>} title="Titre" closeLabel="Fermer">
        <p>Contenu</p>
      </Dialog>
    )
    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('bg-c-elevated', 'border-c-border', FOCUS_GROUND_ELEVATED)
    expect(dialog).not.toHaveClass('bg-c-surface')
    expect(document.querySelector('.bg-c-scrim')).not.toBeNull()
    expect(document.querySelector('.bg-c-shadow-2')).toBeNull()
  })

  it('Drawer: elevated surface with an edge, like the Dialog', async () => {
    const user = userEvent.setup()
    render(
      <Drawer trigger={<button type="button">Ouvrir</button>} title="Titre" closeLabel="Fermer">
        <p>Contenu</p>
      </Drawer>
    )
    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))
    expect(screen.getByRole('dialog')).toHaveClass(
      'bg-c-elevated',
      'border-c-border',
      FOCUS_GROUND_ELEVATED
    )
  })

  it('DropdownMenu: elevated, and a highlight that is tint, ink and an inset edge', async () => {
    const user = userEvent.setup()
    render(
      <DropdownMenu
        trigger={<button type="button">···</button>}
        label="Actions"
        items={[
          { label: 'Modifier', onSelect: () => {} },
          { label: 'Retirer', onSelect: () => {}, destructive: true },
        ]}
      />
    )
    await user.click(screen.getByRole('button', { name: '···' }))
    expect(screen.getByRole('menu')).toHaveClass('bg-c-elevated')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveClass(
      'data-[highlighted]:bg-c-accent-soft',
      'data-[highlighted]:text-c-accent-ink',
      'data-[highlighted]:ring-c-accent-ink'
    )
    expect(screen.getByRole('menuitem', { name: 'Retirer' })).toHaveClass(
      'data-[highlighted]:bg-c-bad-soft',
      'data-[highlighted]:ring-c-bad-ink'
    )
  })
})

describe('fields draw the control edge and the placeholder role', () => {
  it('TextField: border-input edge, placeholder hint, bad-ink edge on error', () => {
    const { rerender } = render(<TextField label="Nom" placeholder="Par exemple : GV" />)
    const input = screen.getByRole('textbox', { name: 'Nom' })
    expect(input).toHaveClass('placeholder:text-c-placeholder')
    expect(input.parentElement).toHaveClass('border-c-border-input')
    rerender(<TextField label="Nom" placeholder="Par exemple : GV" error="Requis" />)
    expect(screen.getByRole('textbox', { name: 'Nom' }).parentElement).toHaveClass(
      'border-c-bad-ink'
    )
  })
})

describe('an unavailable field is the disabled pair, never half opacity', () => {
  it('TextField: disabled fill on the field, on-disabled text, a transparent edge', () => {
    render(<TextField label="Nom" value="Groupe Vercelli" disabled readOnly />)
    const input = screen.getByRole('textbox', { name: 'Nom' })
    expect(input).toHaveClass('text-c-on-disabled')
    expect(input.parentElement).toHaveClass('bg-c-disabled', 'border-c-border')
    expect(input.parentElement).not.toHaveClass('opacity-50')
    // `:read-only` matches a disabled input too: the muted read-only ground would
    // cover the disabled fill.
    expect(input).not.toHaveClass('read-only:bg-c-muted')
  })

  it('Select: the trigger takes the disabled pair, chevron included', () => {
    render(<Select label="Rôle" options={[{ value: 'a', label: 'Admin' }]} disabled />)
    const trigger = screen.getByRole('combobox', { name: 'Rôle' })
    expect(trigger).toHaveClass('bg-c-disabled', 'text-c-on-disabled', 'border-c-border')
    expect(trigger).not.toHaveClass('opacity-50', 'text-c-ink', 'bg-c-surface')
  })

  it('Combobox: the field takes the disabled pair', () => {
    render(
      <Combobox
        label="Pays"
        options={[{ value: 'fr', label: 'France' }]}
        emptyText="Aucun pays"
        disabled
      />
    )
    const input = screen.getByRole('combobox', { name: 'Pays' })
    expect(input).toHaveClass('text-c-on-disabled')
    expect(input.parentElement).toHaveClass('bg-c-disabled', 'border-c-border')
    expect(input.parentElement).not.toHaveClass('opacity-50')
  })

  it('FileDrop: the zone takes the disabled pair, and unavailable wins over an error', () => {
    render(
      <FileDrop
        label="Justificatif"
        rejectionMessage={() => 'Refusé'}
        removeLabel="Retirer"
        disabled
        error="Fichier requis"
      />
    )
    const zone = screen.getByRole('button', { name: 'Justificatif' })
    expect(zone).toHaveClass('bg-c-disabled', 'border-c-border')
    expect(zone).not.toHaveClass('opacity-50', 'border-c-bad-ink')
  })
})

describe('an unavailable button is the disabled pair, never a faded variant', () => {
  for (const variant of ['primary', 'secondary', 'destructive'] as const) {
    it(`${variant}: disabled fill and label, a transparent border, no opacity`, () => {
      render(
        <Button variant={variant} disabled>
          Continuer
        </Button>
      )
      const button = screen.getByRole('button', { name: 'Continuer' })
      expect(button).toHaveClass('bg-c-disabled', 'text-c-on-disabled')
      expect(button).not.toHaveClass('opacity-50')
      if (variant !== 'primary') expect(button).toHaveClass('border', 'border-transparent')
    })
  }

  it('secondary, enabled: the border-input edge that tells it from a disabled button', () => {
    render(<Button variant="secondary">Annuler</Button>)
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveClass('border-c-border-input')
  })
})
