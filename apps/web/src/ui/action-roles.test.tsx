// Ordinary helper actions use ink with inline/hover/keyboard underline cues.
// Navigation hover, selected state text and edges retain accent ink. Token
// ratios and unchanged minima are asserted in tests/unit/ui/action-roles.test.ts;
// actual compiled helper cues are asserted in consumer-cues.test.tsx.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { conflictKey } from '../../tests/unit/ui/classConflicts'
import { Breadcrumb } from './Breadcrumb/Breadcrumb'
import { Button } from './Button/Button'
import { Checkbox } from './Checkbox/Checkbox'
import { Combobox } from './Combobox/Combobox'
import { DocumentViewer } from './DocumentViewer/DocumentViewer'
import { FileDrop } from './FileDrop/FileDrop'
import { LinkButton } from './LinkButton/LinkButton'
import { ProgressList } from './ProgressList/ProgressList'
import { RadioGroup } from './RadioGroup/RadioGroup'
import { Select } from './Select/Select'
import { Tabs } from './Tabs/Tabs'
import { TextField } from './TextField/TextField'

/** Every class on `element` and below it. */
function classesIn(element: Element): string[] {
  return [element, ...element.querySelectorAll('*')].flatMap((node) => [...node.classList])
}

/** `c-action` used as text colour or as an edge, under any variant prefix. */
const ACTION_AS_TEXT_OR_EDGE = /^(?:[^:]+:)*(?:text|border|ring|outline)-c-action(?:-hover)?$/

function expectNoActionTextOrEdge(element: Element) {
  expect(classesIn(element).filter((name) => ACTION_AS_TEXT_OR_EDGE.test(name))).toEqual([])
  expectNoColourConflict(element)
}

/** No element carries two colour classes for one property under one variant:
 * the stylesheet, not the source, would pick the one that shows. */
function expectNoColourConflict(root: Element) {
  const conflicts: string[] = []
  for (const node of [root, ...root.querySelectorAll('*')]) {
    const byKey = new Map<string, string>()
    for (const name of node.classList) {
      const key = conflictKey(name)
      if (key === undefined) continue
      const other = byKey.get(key)
      if (other === undefined) byKey.set(key, name)
      else conflicts.push(`${other} + ${name}`)
    }
  }
  expect(conflicts).toEqual([])
}

describe('ordinary helper text is ink; navigation hover stays accent ink', () => {
  it('Button tertiary', () => {
    render(<Button variant="tertiary">Réessayer</Button>)
    const button = screen.getByRole('button', { name: 'Réessayer' })
    expect(button).toHaveClass('text-c-ink', 'hover:underline')
    expect(button).not.toHaveClass('underline')
    expectNoActionTextOrEdge(button)
  })

  it('LinkButton inline: inside running text, underlined at rest', () => {
    render(
      <p>
        Consultez la{' '}
        <LinkButton inline href="/statut">
          page de statut
        </LinkButton>
        .
      </p>
    )
    const link = screen.getByRole('link', { name: 'page de statut' })
    expect(link).toHaveClass('text-c-ink', 'underline')
    expect(link).not.toHaveClass('inline-flex', 'hover:underline', 'h-10')
    expectNoActionTextOrEdge(link)
  })

  it('LinkButton tertiary', () => {
    render(
      <LinkButton variant="tertiary" href="/aide">
        Aide
      </LinkButton>
    )
    const link = screen.getByRole('link', { name: 'Aide' })
    expect(link).toHaveClass('text-c-ink', 'hover:underline')
    expect(link).not.toHaveClass('underline')
    expectNoActionTextOrEdge(link)
  })

  it('keeps the primary fill on action, with on-inverse text', () => {
    render(<Button>Continuer</Button>)
    expect(screen.getByRole('button', { name: 'Continuer' })).toHaveClass(
      'bg-c-action',
      'text-c-on-inverse'
    )
  })

  it('DocumentViewer table of contents', () => {
    render(
      <DocumentViewer
        label="Contrat"
        tocLabel="Sommaire"
        progressLabel="Progression"
        status="ready"
        sections={[{ id: 'a', heading: '1. Rôles', paragraphs: ['Texte.'] }]}
      />
    )
    const entry = screen.getByRole('button', { name: '1. Rôles' })
    expect(entry).toHaveClass('text-c-ink', 'hover:underline')
    expectNoActionTextOrEdge(screen.getByRole('navigation', { name: 'Sommaire' }))
  })

  it('Breadcrumb hover', () => {
    render(
      <Breadcrumb
        ariaLabel="Fil"
        items={[{ label: 'Organisation', href: '/o' }, { label: 'Ici' }]}
      />
    )
    const link = screen.getByRole('link', { name: 'Organisation' })
    expect(link).toHaveClass('text-c-ink-3', 'hover:text-c-accent-ink', 'hover:underline')
    expect(link).not.toHaveClass('underline')
    expectNoActionTextOrEdge(screen.getByRole('navigation', { name: 'Fil' }))
  })
})

describe('state text and edges are the accent ink', () => {
  it('Tabs: the active label and its underline', () => {
    render(
      <Tabs
        ariaLabel="Sections"
        value="a"
        onValueChange={() => {}}
        items={[
          { value: 'a', label: 'Personnes', content: null },
          { value: 'b', label: 'Domaines', content: null },
        ]}
      />
    )
    const tab = screen.getByRole('tab', { name: 'Personnes' })
    expect(tab).toHaveClass(
      'data-[state=active]:text-c-accent-ink',
      'data-[state=active]:border-c-accent-ink'
    )
    expectNoActionTextOrEdge(screen.getByRole('tablist'))
  })

  it('ProgressList: the running step caption, ring and spinner', () => {
    const { container } = render(
      <ProgressList
        steps={[{ id: 's', label: 'Serveur', status: 'running', caption: 'Environ 2 min' }]}
        statusLabels={{
          pending: 'En attente',
          running: 'En cours',
          done: 'Terminé',
          failed: 'Échoué',
          skipped: 'Ignoré',
        }}
      />
    )
    expect(screen.getByText('Environ 2 min')).toHaveClass('text-c-accent-ink')
    const ring = container.querySelector('li span.rounded-full')
    expect(ring).toHaveClass('border-2', 'border-c-accent-ink')
    expect(classesIn(container)).toContain('text-c-accent-ink')
    expectNoActionTextOrEdge(container)
  })

  it('Checkbox: the checked edge is the accent ink around the action fill', () => {
    render(<Checkbox label="Accepter" defaultChecked />)
    const box = screen.getByRole('checkbox', { name: 'Accepter' })
    expect(box).toHaveClass(
      'data-[state=checked]:border-c-accent-ink',
      'data-[state=checked]:bg-c-action',
      'data-[state=indeterminate]:border-c-accent-ink'
    )
    expect(box.querySelector('.text-c-on-inverse')).not.toBeNull()
    expectNoActionTextOrEdge(box)
  })

  it('RadioGroup: the checked edge and dot are the accent ink', () => {
    render(
      <RadioGroup
        label="Facturation"
        defaultValue="m"
        options={[
          { value: 'm', label: 'Mensuel' },
          { value: 'a', label: 'Annuel' },
        ]}
      />
    )
    const radio = screen.getByRole('radio', { name: 'Mensuel' })
    expect(radio).toHaveClass('data-[state=checked]:border-c-accent-ink')
    // The checked halo sets the ring colour; focus has to override it on the
    // checked radio as well as on an unchecked one.
    expect(radio).toHaveClass(
      'focus-visible:ring-c-accent-ink',
      'data-[state=checked]:focus-visible:ring-c-accent-ink'
    )
    expect(radio.firstElementChild).toHaveClass('bg-c-accent-ink')
    expectNoActionTextOrEdge(screen.getByRole('radiogroup'))
  })

  it('TextField: the focused edge', () => {
    render(<TextField label="Nom" />)
    const wrapper = screen.getByLabelText('Nom').parentElement
    expect(wrapper).toHaveClass('border-c-border-input', 'focus-within:border-c-accent-ink')
    expectNoActionTextOrEdge(wrapper as Element)
  })

  it('Combobox: the highlighted option paints by its data attribute, not beside the base ink', () => {
    render(<Combobox label="Pays" emptyText="Aucun" options={[{ value: 'fr', label: 'France' }]} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'Pays' }))
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Pays' }), { key: 'ArrowDown' })
    const option = screen.getByRole('option', { name: 'France' })
    expect(option).toHaveAttribute('data-highlighted')
    expect(option).toHaveClass(
      'text-c-ink',
      'data-[highlighted]:bg-c-accent-soft',
      'data-[highlighted]:text-c-accent-ink'
    )
    expectNoColourConflict(option)
  })

  it('Combobox: the focused edge', () => {
    render(<Combobox label="Pays" emptyText="Aucun" options={[{ value: 'fr', label: 'France' }]} />)
    const wrapper = screen.getByRole('combobox', { name: 'Pays' }).parentElement
    expect(wrapper).toHaveClass('border-c-border-input', 'focus-within:border-c-accent-ink')
    expectNoActionTextOrEdge(wrapper as Element)
  })

  it('Select: the focused edge', () => {
    render(<Select label="Rôle" placeholder="Choisir" options={[{ value: 'a', label: 'Admin' }]} />)
    const trigger = screen.getByRole('combobox', { name: 'Rôle' })
    expect(trigger).toHaveClass('border-c-border-input', 'focus-visible:border-c-accent-ink')
    expectNoActionTextOrEdge(trigger)
  })

  it('FileDrop: one edge colour per state', () => {
    const { rerender } = render(
      <FileDrop label="Justificatif" rejectionMessage={() => 'Refusé'} removeLabel="Retirer" />
    )
    const zone = screen.getByRole('button', { name: 'Justificatif' })
    const edges = () => [...zone.classList].filter((name) => conflictKey(name) === 'border')
    expect(edges()).toEqual(['border-c-border-input'])
    expect(zone).toHaveClass('hover:border-c-accent-ink')
    expectNoActionTextOrEdge(zone)

    fireEvent.dragOver(zone)
    expect(edges()).toEqual(['border-c-accent-ink'])
    expect(zone).toHaveClass('bg-c-accent-soft')
    expectNoActionTextOrEdge(zone)

    fireEvent.dragLeave(zone)
    rerender(
      <FileDrop
        label="Justificatif"
        rejectionMessage={() => 'Refusé'}
        removeLabel="Retirer"
        error="Ajoutez un justificatif."
      />
    )
    expect(edges()).toEqual(['border-c-bad-ink'])
    expectNoActionTextOrEdge(zone)
  })
})
