import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DefinitionList } from './DefinitionList'

const items = [
  { term: 'Nom', description: 'Acme Construction' },
  { term: 'SIRET', description: '123 456 789 00012' },
]

describe('DefinitionList', () => {
  it('renders a real dl/dt/dd structure', () => {
    const { container } = render(<DefinitionList items={items} />)

    expect(container.querySelector('dl')).not.toBeNull()
    expect(container.querySelectorAll('dt')).toHaveLength(2)
    expect(container.querySelectorAll('dd')).toHaveLength(2)
  })

  it('pairs each term with its description in order', () => {
    const { container } = render(<DefinitionList items={items} />)

    const terms = Array.from(container.querySelectorAll('dt')).map((node) => node.textContent)
    const descriptions = Array.from(container.querySelectorAll('dd')).map(
      (node) => node.textContent
    )
    expect(terms).toEqual(['Nom', 'SIRET'])
    expect(descriptions).toEqual(['Acme Construction', '123 456 789 00012'])
  })

  it('accepts a node as a description, not only a string', () => {
    render(<DefinitionList items={[{ term: 'Statut', description: <strong>Actif</strong> }]} />)

    expect(screen.getByText('Actif').tagName).toBe('STRONG')
  })
})
