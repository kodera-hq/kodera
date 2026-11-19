import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { KODERA_ICON_NAMES, KoderaIcon } from './KoderaIcons'
it('renders every geometric icon with inherited ink and decorative semantics', () => {
  const { container } = render(
    <>
      {KODERA_ICON_NAMES.map((name) => (
        <KoderaIcon key={name} name={name} />
      ))}
    </>
  )
  for (const svg of container.querySelectorAll('svg')) {
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg).toHaveAttribute('stroke-width', '1.75')
    expect(svg.querySelectorAll('path')).toHaveLength(2)
    expect(svg).not.toHaveAttribute('style')
  }
})
