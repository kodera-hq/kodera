import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadPanel } from './ThreadPanel'
import type { ThreadPanelProps } from './ThreadPanel'

function setup(props: Partial<ThreadPanelProps> = {}) {
  const onClose = vi.fn()
  render(
    <ThreadPanel
      label="Fil de discussion"
      title="Fil de discussion"
      channel="# projet-atlas"
      closeLabel="Fermer le fil"
      onClose={onClose}
      parent={<p>Message d’origine</p>}
      repliesLabel="Réponses"
      composer={<textarea aria-label="Répondre dans le fil" />}
      {...props}
    >
      <p>Première réponse</p>
    </ThreadPanel>
  )
  return { onClose }
}

describe('ThreadPanel', () => {
  it('is a named complementary landmark with a heading and the parent channel', () => {
    setup()
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByRole('heading', { name: 'Fil de discussion' })).toBeInTheDocument()
    expect(within(panel).getByText('# projet-atlas')).toBeInTheDocument()
  })

  it('fills its three slots: the parent, the replies region and the composer', () => {
    setup()
    const panel = screen.getByRole('complementary')
    expect(within(panel).getByText('Message d’origine')).toBeInTheDocument()
    const replies = within(panel).getByRole('region', { name: 'Réponses' })
    expect(within(replies).getByText('Première réponse')).toBeInTheDocument()
    expect(replies).toHaveClass('overflow-y-auto')
    expect(replies).toHaveAttribute('tabindex', '0')
    expect(within(panel).getByRole('textbox', { name: 'Répondre dans le fil' })).toBeInTheDocument()
  })

  it('is shell-dock-width wide, and the full width under narrow', () => {
    setup()
    expect(screen.getByRole('complementary')).toHaveClass('w-shell-dock-width', 'narrow:w-full')
  })

  it('closes from its button and returns focus to the caller’s target', async () => {
    const user = userEvent.setup()
    const opener = createRef<HTMLButtonElement>()
    render(
      <button ref={opener} type="button">
        6 réponses
      </button>
    )
    const { onClose } = setup({ returnFocusTo: opener })
    await user.click(screen.getByRole('button', { name: 'Fermer le fil' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(opener.current).toHaveFocus()
  })

  it('closes on Escape from inside the panel', async () => {
    const user = userEvent.setup()
    const opener = createRef<HTMLButtonElement>()
    render(
      <button ref={opener} type="button">
        6 réponses
      </button>
    )
    const { onClose } = setup({ returnFocusTo: opener })
    screen.getByRole('textbox', { name: 'Répondre dans le fil' }).focus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(opener.current).toHaveFocus()
  })

  it('stays open when a child handles Escape itself', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <ThreadPanel
        label="Fil de discussion"
        title="Fil de discussion"
        channel="# projet-atlas"
        closeLabel="Fermer le fil"
        onClose={onClose}
        parent={null}
        repliesLabel="Réponses"
        composer={
          <input
            aria-label="Mentionner"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.preventDefault()
            }}
          />
        }
      >
        {null}
      </ThreadPanel>
    )
    screen.getByRole('textbox', { name: 'Mentionner' }).focus()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores Escape pressed outside the panel', async () => {
    const user = userEvent.setup()
    render(<button type="button">Ailleurs</button>)
    const { onClose } = setup()
    screen.getByRole('button', { name: 'Ailleurs' }).focus()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('sizes its header on a spacing step, not the rail’s geometry', () => {
    setup()
    const header = screen.getByRole('heading', { name: 'Fil de discussion' }).closest('header')
    expect(header).toHaveClass('min-h-12')
    expect(header).not.toHaveClass('h-shell-rail-item-width')
  })

  it('closes without moving focus when no target is given', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.click(screen.getByRole('button', { name: 'Fermer le fil' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('gives the close button the 44 px floor under narrow and a visible ring', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Fermer le fil' })).toHaveClass(
      'narrow:min-h-[44px]',
      'narrow:min-w-[44px]',
      'focus-visible:ring'
    )
  })

  it('names its close button, an icon, with a tooltip under the pointer, read once', async () => {
    const user = userEvent.setup()
    setup()
    const close = screen.getByRole('button', { name: 'Fermer le fil' })
    await user.hover(close)
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Fermer le fil')
    expect(close).toHaveAccessibleDescription('')
  })
})
