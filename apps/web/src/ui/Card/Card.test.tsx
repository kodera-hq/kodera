import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Card, CardBody, CardFooter, CardHeader } from './Card'

describe('Card', () => {
  it('renders its children inside a container', () => {
    render(<Card>Contenu de la carte</Card>)

    expect(screen.getByText('Contenu de la carte')).toBeInTheDocument()
  })

  it('is white with the card shadow and the card radius by default', () => {
    render(<Card>Carte</Card>)

    const card = screen.getByText('Carte')
    expect(card).toHaveClass('bg-c-surface')
    expect(card).toHaveClass('shadow-card shadow-c-shadow-1')
    expect(card).toHaveClass('rounded-lg')
  })

  it('drops its shadow in dark and black, through the theme rule in index.css', () => {
    render(
      <>
        <Card>Carte</Card>
        <Card tone="inverse">Contrat</Card>
      </>
    )

    expect(screen.getByText('Carte')).toHaveClass('card-flat-dark')
    expect(screen.getByText('Contrat')).toHaveClass('card-flat-dark')
  })

  it('switches to the inverse ground and inverse text on the inverse tone', () => {
    render(<Card tone="inverse">Contrat</Card>)

    const card = screen.getByText('Contrat')
    expect(card).toHaveClass('bg-c-inverse')
    expect(card).toHaveClass('text-c-on-inverse')
    expect(card).not.toHaveClass('bg-c-surface')
  })

  it('lays out header, body and footer in reading order', () => {
    render(
      <Card>
        <CardHeader>En-tête</CardHeader>
        <CardBody>Corps</CardBody>
        <CardFooter>Pied</CardFooter>
      </Card>
    )

    const texts = screen.getAllByText(/En-tête|Corps|Pied/).map((node) => node.textContent)
    expect(texts).toEqual(['En-tête', 'Corps', 'Pied'])
  })

  it('concatenates the caller class with its own', () => {
    render(<Card className="w-full">Carte</Card>)

    expect(screen.getByText('Carte')).toHaveClass('w-full')
    expect(screen.getByText('Carte')).toHaveClass('rounded-lg')
  })

  it('forwards its ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Card ref={ref}>Carte</Card>)

    expect(ref.current).toBe(screen.getByText('Carte'))
  })
  it.each([
    ['default', ['border', 'border-c-border']],
    ['action', ['border-2', 'border-c-action']],
    ['accent', ['border-2', 'border-c-accent-ink']],
  ] as const)('carries exactly one edge colour for the %s edge', (edge, classes) => {
    render(<Card edge={edge}>Carte</Card>)
    const card = screen.getByText('Carte')
    expect(card).toHaveClass(...classes)
    const colours = [...card.classList].filter(
      (name) => name.startsWith('border') && name.split('-')[1] === 'c'
    )
    expect(colours).toEqual([classes[1]])
  })

  it('draws no edge of its own on the inverse tone, only the theme-scoped inverse edge', () => {
    render(
      <Card tone="inverse" edge="accent">
        Carte
      </Card>
    )
    const card = screen.getByText('Carte')
    expect([...card.classList].filter((name) => name.startsWith('border'))).toEqual([])
    // Drawn in dark and black only, by `src/index.css`; measured in a browser by
    // tests/e2e/10-appearance.spec.ts.
    expect(card).toHaveClass('inverse-edge')
  })
})
