import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { compiled } from '../../../tests/unit/ui/tailwind'
import { TOUCH_TARGET } from '../touchTarget'
import { ACTIONS_TOUCH_TARGET, SidebarCategory } from './SidebarCategory'

function rows() {
  return (
    <>
      <li>
        <a href="#general">général</a>
      </li>
      <li>
        <button type="button">lounge</button>
      </li>
    </>
  )
}

describe('SidebarCategory', () => {
  it('is a disclosure button that names and controls the list of its rows', () => {
    render(<SidebarCategory label="Équipe">{rows()}</SidebarCategory>)
    const header = screen.getByRole('button', { name: 'Équipe' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'Équipe' })
    expect(header).toHaveAttribute('aria-controls', list.id)
    expect(list.querySelectorAll('li')).toHaveLength(2)
  })

  it('draws the header in sentence case, c-ink-3 semibold, with a chevron that turns', async () => {
    const user = userEvent.setup()
    render(<SidebarCategory label="Équipe">{rows()}</SidebarCategory>)
    const header = screen.getByRole('button', { name: 'Équipe' })
    expect(header).toHaveClass('text-c-ink-3', 'font-semibold')
    expect(header).not.toHaveClass('uppercase')
    const chevron = header.querySelector('[data-glyph="chevron"]')
    expect(chevron).toHaveClass('rotate-90')
    await user.click(header)
    expect(chevron).not.toHaveClass('rotate-90')
  })

  it('folds and unfolds on click, Enter and Space, uncontrolled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <SidebarCategory label="Équipe" onOpenChange={onOpenChange}>
        {rows()}
      </SidebarCategory>
    )
    const header = screen.getByRole('button', { name: 'Équipe' })
    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('link', { name: 'général' })).toBeNull()
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(onOpenChange.mock.calls).toEqual([[false], [true], [false]])
  })

  it('is reached by Tab before its rows', async () => {
    const user = userEvent.setup()
    render(<SidebarCategory label="Équipe">{rows()}</SidebarCategory>)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Équipe' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'général' })).toHaveFocus()
  })

  it('starts closed with defaultOpen false', () => {
    render(
      <SidebarCategory label="Archives" defaultOpen={false}>
        {rows()}
      </SidebarCategory>
    )
    expect(screen.getByRole('button', { name: 'Archives' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('follows a controlled open state and only reports the change', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <SidebarCategory label="Équipe" open={false} onOpenChange={onOpenChange}>
        {rows()}
      </SidebarCategory>
    )
    const header = screen.getByRole('button', { name: 'Équipe' })
    await user.click(header)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    rerender(
      <SidebarCategory label="Équipe" open onOpenChange={onOpenChange}>
        {rows()}
      </SidebarCategory>
    )
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('works as a controlled category in a parent', async () => {
    const user = userEvent.setup()
    function Parent() {
      const [open, setOpen] = useState(true)
      return (
        <SidebarCategory label="Équipe" open={open} onOpenChange={setOpen}>
          {rows()}
        </SidebarCategory>
      )
    }
    render(<Parent />)
    await user.click(screen.getByRole('button', { name: 'Équipe' }))
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('renders its actions beside the header, outside the disclosure button', () => {
    render(
      <SidebarCategory
        label="Équipe"
        actions={<button type="button" aria-label="Créer un canal" />}
      >
        {rows()}
      </SidebarCategory>
    )
    const action = screen.getByRole('button', { name: 'Créer un canal' })
    expect(screen.getByRole('button', { name: 'Équipe' })).not.toContainElement(action)
  })

  it('gives each action the 44 px floor under narrow, from the wrapper', () => {
    render(
      <SidebarCategory
        label="Équipe"
        actions={<button type="button" aria-label="Créer un canal" />}
      >
        {rows()}
      </SidebarCategory>
    )
    const wrapper = screen.getByRole('button', { name: 'Créer un canal' }).parentElement
    expect(wrapper).toHaveClass(...ACTIONS_TOUCH_TARGET.split(' '))
    expect(ACTIONS_TOUCH_TARGET).toBe(
      TOUCH_TARGET.split(' ')
        .map((name) => `*:${name}`)
        .join(' ')
    )
  })

  it('compiles the child floor to a rule on each direct child, under the narrow query', async () => {
    const root = await compiled(ACTIONS_TOUCH_TARGET.split(' '))
    const found: string[] = []
    root.walkDecls((declaration) => {
      if (declaration.value !== '44px') return
      const rule = declaration.parent as { selector?: string; parent?: { params?: string } }
      found.push(`${declaration.prop} ${rule.selector ?? ''} @ ${rule.parent?.params ?? ''}`)
    })
    expect(found).toHaveLength(2)
    for (const line of found) {
      expect(line).toMatch(/> \*/)
      expect(line).toMatch(/@ .*min-width/)
    }
  })

  it('gives two categories on one page distinct ids', () => {
    render(
      <>
        <SidebarCategory label="Équipe">{rows()}</SidebarCategory>
        <SidebarCategory label="Projets">{rows()}</SidebarCategory>
      </>
    )
    const team = screen.getByRole('button', { name: 'Équipe' })
    const projects = screen.getByRole('button', { name: 'Projets' })
    expect(team.getAttribute('aria-controls')).not.toBe(projects.getAttribute('aria-controls'))
    expect(screen.getByRole('list', { name: 'Équipe' }).id).toBe(team.getAttribute('aria-controls'))
    expect(screen.getByRole('list', { name: 'Projets' }).id).toBe(
      projects.getAttribute('aria-controls')
    )
  })

  it('takes the 44 px touch floor under narrow, and a visible focus ring', () => {
    render(<SidebarCategory label="Équipe">{rows()}</SidebarCategory>)
    expect(screen.getByRole('button', { name: 'Équipe' })).toHaveClass(
      'narrow:min-h-[44px]',
      'focus-visible:ring'
    )
  })
})

it('announces category audience metadata without changing its name or disclosure behavior', async () => {
  const user = userEvent.setup()
  render(
    <SidebarCategory label="Core Kodera" description="Private — core team">
      {rows()}
    </SidebarCategory>
  )
  const header = screen.getByRole('button', { name: 'Core Kodera' })
  expect(header).toHaveAccessibleDescription('Private — core team')
  await user.click(header)
  expect(header).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Private — core team')).toBeVisible()
})
