import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog/Dialog'
import { Drawer } from './Drawer/Drawer'
import { DropdownMenu } from './DropdownMenu/DropdownMenu'
import { Popover } from './Popover/Popover'
import { Tooltip } from './Tooltip/Tooltip'

/**
 * The story a11y gate (`stories-a11y.test.tsx`) only scans the element it
 * rendered into — a portal's content lands as a sibling of that element in
 * the real DOM, so a story stays "clean" whether or not the primitive is
 * still wiring its `container` prop through to Radix's `Portal`. Nothing else
 * in the suite would notice that regression either, since every interaction
 * test queries `screen` globally rather than a scoped root.
 *
 * This file is the permanent check: it renders each overlay primitive with a
 * `container` prop pointing at a node inside the render tree, and asserts the
 * portalled role element is a descendant of that node. Each primitive's pair
 * of tests also proves the assertion is not vacuous — the second test in the
 * pair renders the same primitive without `container` and asserts the
 * content lands outside the target node instead, which is what would happen
 * silently if a primitive's `container` prop stopped reaching its `Portal`.
 */
function LocalPortalTarget({
  children,
}: {
  children: (container: HTMLDivElement | null) => ReactNode
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  return (
    <div>
      <div data-testid="portal-target" ref={setNode} />
      {children(node)}
    </div>
  )
}

describe('portal containment', () => {
  describe('Dialog', () => {
    it('keeps its content inside the given container', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {(container) => (
            <Dialog
              container={container}
              trigger={<button type="button">Ouvrir</button>}
              title="Titre"
              closeLabel="Fermer"
            >
              <p>Contenu.</p>
            </Dialog>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

      expect(target).toContainElement(screen.getByRole('dialog'))
    })

    it('lands outside the target node when the container prop is dropped', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {() => (
            <Dialog
              trigger={<button type="button">Ouvrir</button>}
              title="Titre"
              closeLabel="Fermer"
            >
              <p>Contenu.</p>
            </Dialog>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

      expect(target).not.toContainElement(screen.getByRole('dialog'))
    })
  })

  describe('Drawer', () => {
    it('keeps its content inside the given container', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {(container) => (
            <Drawer
              container={container}
              trigger={<button type="button">Ouvrir</button>}
              title="Titre"
              closeLabel="Fermer"
            >
              <p>Contenu.</p>
            </Drawer>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

      expect(target).toContainElement(screen.getByRole('dialog'))
    })

    it('lands outside the target node when the container prop is dropped', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {() => (
            <Drawer
              trigger={<button type="button">Ouvrir</button>}
              title="Titre"
              closeLabel="Fermer"
            >
              <p>Contenu.</p>
            </Drawer>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Ouvrir' }))

      expect(target).not.toContainElement(screen.getByRole('dialog'))
    })
  })

  describe('Popover', () => {
    it('keeps its content inside the given container', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {(container) => (
            <Popover
              container={container}
              trigger={<button type="button">Filtrer</button>}
              label="Filtrer"
            >
              <p>Contenu du filtre.</p>
            </Popover>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Filtrer' }))

      expect(target).toContainElement(screen.getByRole('dialog'))
    })

    it('lands outside the target node when the container prop is dropped', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {() => (
            <Popover trigger={<button type="button">Filtrer</button>} label="Filtrer">
              <p>Contenu du filtre.</p>
            </Popover>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: 'Filtrer' }))

      expect(target).not.toContainElement(screen.getByRole('dialog'))
    })
  })

  describe('DropdownMenu', () => {
    it('keeps its content inside the given container', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {(container) => (
            <DropdownMenu
              container={container}
              trigger={<button type="button">···</button>}
              label="Actions"
              items={[{ label: 'Modifier', onSelect: vi.fn() }]}
            />
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: '···' }))

      expect(target).toContainElement(screen.getByRole('menu'))
    })

    it('lands outside the target node when the container prop is dropped', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {() => (
            <DropdownMenu
              trigger={<button type="button">···</button>}
              label="Actions"
              items={[{ label: 'Modifier', onSelect: vi.fn() }]}
            />
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.click(screen.getByRole('button', { name: '···' }))

      expect(target).not.toContainElement(screen.getByRole('menu'))
    })
  })

  describe('Tooltip', () => {
    it('keeps its content inside the given container', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {(container) => (
            <Tooltip content="Info" container={container}>
              <button type="button">Copier</button>
            </Tooltip>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.tab()

      expect(target).toContainElement(await screen.findByRole('tooltip'))
    })

    it('lands outside the target node when the container prop is dropped', async () => {
      const user = userEvent.setup()
      render(
        <LocalPortalTarget>
          {() => (
            <Tooltip content="Info">
              <button type="button">Copier</button>
            </Tooltip>
          )}
        </LocalPortalTarget>
      )
      const target = screen.getByTestId('portal-target')

      await user.tab()

      expect(target).not.toContainElement(await screen.findByRole('tooltip'))
    })
  })
})
