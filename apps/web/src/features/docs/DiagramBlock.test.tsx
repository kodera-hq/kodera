import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiagramSvgPreview, createDiagramDomNode } from './DiagramBlock'

describe('CSP-safe SVG diagram renderer', () => {
  it('renders flowcharts with zero <style> elements and zero inline style attributes', () => {
    const source = [
      'flowchart LR',
      '  Spec[Specification] --> Gate{Checks green?}',
      '  Gate -->|Yes| Ship(Release)',
    ].join('\n')

    const { container } = render(
      <DiagramSvgPreview source={source} ariaLabel="Release workflow" />
    )

    const svg = screen.getByRole('img', { name: 'Release workflow' })
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg).toHaveTextContent('Specification')
    expect(svg).toHaveTextContent('Checks green?')
    expect(svg).toHaveTextContent('Release')
    expect(svg).toHaveTextContent('Yes')
    expect(container.querySelectorAll('style')).toHaveLength(0)
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('renders sequence diagrams via both React and DOM builders without style attributes', () => {
    const source = [
      'sequenceDiagram',
      '  participant Web as Browser',
      '  participant Core as Core API',
      '  Web->>Core: POST collab-session',
      '  Core-->>Web: Short-lived ticket',
    ].join('\n')

    const { container } = render(
      <DiagramSvgPreview source={source} ariaLabel="Collab handshake" />
    )
    expect(screen.getByRole('img', { name: 'Collab handshake' })).toHaveTextContent(
      'POST collab-session'
    )
    expect(container.querySelectorAll('style')).toHaveLength(0)
    expect(container.querySelectorAll('[style]')).toHaveLength(0)

    const domNode = createDiagramDomNode(document, source, 'DOM handshake')
    expect(domNode.tagName.toLowerCase()).toBe('svg')
    expect(domNode.querySelectorAll('style')).toHaveLength(0)
    expect(domNode.querySelectorAll('[style]')).toHaveLength(0)
  })
})
