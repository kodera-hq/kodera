import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { classesOf, compiled } from '../../tests/unit/ui/tailwind'
import { Banner } from './Banner/Banner'
import { Button } from './Button/Button'
import { Card } from './Card/Card'
import { Checkbox } from './Checkbox/Checkbox'
import { LinkButton } from './LinkButton/LinkButton'
import { Switch } from './Switch/Switch'
import { ToastProvider, useToast } from './Toast/Toast'

// Compiles the rendered element's own classes with the console's stylesheet,
// `src/index.css`, where `focus-offset` and `focus-ground-*` live. A class
// assertion alone passes when the utility it names emits nothing.
async function declarations(element: Element): Promise<Map<string, string>> {
  const root = await compiled(classesOf(element))
  const classes = new Set(element.classList)
  const found = new Map<string, string>()
  root.walkRules((rule) => {
    // `.focus-visible\:ring-offset-2:focus-visible` names the class
    // `focus-visible:ring-offset-2`; the element state after it is dropped.
    const own = rule.selectors.some((selector) => {
      const match = /^\.((?:\\.|[\w-])+)(?::focus-visible)?$/.exec(selector)
      return match !== null && classes.has((match[1] ?? '').replace(/\\(.)/g, '$1'))
    })
    if (own) rule.walkDecls((declaration) => void found.set(declaration.prop, declaration.value))
  })
  return found
}

async function expectOffsetRing(element: Element) {
  const found = await declarations(element)
  expect(found.get('--tw-ring-offset-width')).toBe('2px')
  expect(found.get('--tw-ring-offset-color')).toBe('var(--focus-ring-ground)')
}

async function expectGround(element: Element, ground: 'inverse' | 'bad') {
  const found = await declarations(element)
  expect(found.get('--focus-ring-color')).toBe('var(--focus-ring-on-inverse-color)')
  expect(found.get('--focus-ring-ground')).toBe(`var(--c-${ground})`)
}

describe('a control with a fill or an edge of its own draws its ring 2 px off it', () => {
  for (const variant of ['primary', 'secondary', 'destructive'] as const) {
    it(`Button ${variant}, pressable and loading`, async () => {
      render(
        <>
          <Button variant={variant}>Continuer</Button>
          <Button variant={variant} loading>
            Envoi
          </Button>
        </>
      )
      await expectOffsetRing(screen.getByRole('button', { name: 'Continuer' }))
      await expectOffsetRing(screen.getByRole('button', { name: 'Envoi' }))
    })

    it(`LinkButton ${variant}`, async () => {
      render(
        <LinkButton href="/aide" variant={variant}>
          Aide
        </LinkButton>
      )
      await expectOffsetRing(screen.getByRole('link', { name: 'Aide' }))
    })
  }

  it('tertiary Button keeps the plain ring: it has no box', async () => {
    render(<Button variant="tertiary">Annuler</Button>)
    const found = await declarations(screen.getByRole('button', { name: 'Annuler' }))
    expect(found.has('--tw-ring-offset-width')).toBe(false)
  })

  it('Checkbox, unchecked and checked', async () => {
    render(
      <>
        <Checkbox label="Accepter" />
        <Checkbox label="Accepté" defaultChecked />
      </>
    )
    await expectOffsetRing(screen.getByRole('checkbox', { name: 'Accepter' }))
    await expectOffsetRing(screen.getByRole('checkbox', { name: 'Accepté' }))
  })

  it('Switch, off and on', async () => {
    render(
      <>
        <Switch label="Éteint" />
        <Switch label="Allumé" defaultChecked />
      </>
    )
    await expectOffsetRing(screen.getByRole('switch', { name: 'Éteint' }))
    await expectOffsetRing(screen.getByRole('switch', { name: 'Allumé' }))
  })
})

describe('a container in a strong fill gives the controls inside it the on-inverse ring', () => {
  it('Card inverse', async () => {
    render(
      <Card tone="inverse" data-testid="card">
        x
      </Card>
    )
    await expectGround(screen.getByTestId('card'), 'inverse')
  })

  it('Banner success', async () => {
    render(<Banner kind="success" headline="Domaine vérifié." />)
    await expectGround(screen.getByRole('status'), 'inverse')
  })

  function Trigger({ kind }: { kind: 'success' | 'error' }) {
    const notify = useToast()
    return (
      <button type="button" onClick={() => notify({ kind, title: 'Titre' })}>
        Déclencher
      </button>
    )
  }

  for (const [kind, ground] of [
    ['success', 'inverse'],
    ['error', 'bad'],
  ] as const) {
    it(`Toast ${kind}`, async () => {
      render(
        <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
          <Trigger kind={kind} />
        </ToastProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Déclencher' }))
      const close = await screen.findByRole('button', { name: 'Fermer' })
      const toast = close.closest('li')
      expect(toast).not.toBeNull()
      await expectGround(toast as Element, ground)
    })
  }
})
