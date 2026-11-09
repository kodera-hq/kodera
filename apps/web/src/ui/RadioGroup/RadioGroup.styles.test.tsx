import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RadioGroup } from './RadioGroup'
import { classesOf, compiled } from '../../../tests/unit/ui/tailwind'

// Compile the actual control's classes. A class-name assertion alone passes
// when the dependency has not published the utility and no CSS is emitted.
describe('the radio selection ring', () => {
  it('emits the preserved five-pixel halo only for the checked state', async () => {
    render(
      <RadioGroup
        label="Facturation"
        options={[{ value: 'monthly', label: 'Mensuel' }]}
        defaultValue="monthly"
      />
    )
    const radio = screen.getByRole('radio', { name: 'Mensuel' })
    expect(radio).toHaveAttribute('data-state', 'checked')
    expect(radio).toHaveClass('data-[state=checked]:ring-control-selection')

    const root = await compiled(classesOf(radio))
    const selectionRules: string[] = []
    root.walkRules((rule) => {
      if (!rule.selector.includes('ring-control-selection')) return
      expect(rule.selector).toContain('[data-state="checked"]')
      rule.walkDecls('--tw-ring-shadow', (declaration) => {
        selectionRules.push(declaration.value)
      })
    })
    expect(selectionRules).toEqual([
      'var(--tw-ring-inset, ) 0 0 0 calc(5px + var(--tw-ring-offset-width)) var(--tw-ring-color, var(--focus-ring-color))',
    ])
  })
})
