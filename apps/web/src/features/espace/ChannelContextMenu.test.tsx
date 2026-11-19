import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ChannelContextMenu, menuAnchor, type ChannelMenuTarget } from './ChannelContextMenu'

const target: ChannelMenuTarget = {
  channelId: 'c1',
  label: 'général',
  kind: 'text',
  clientX: 40,
  clientY: 80,
}

describe('ChannelContextMenu', () => {
  it('lists only the actions the view can carry out, permissions for admins only', async () => {
    const user = userEvent.setup()
    const onCopyLink = vi.fn()
    const onClose = vi.fn()
    render(
      <ChannelContextMenu
        target={target}
        onClose={onClose}
        onSettings={vi.fn()}
        onToggleMute={vi.fn()}
        isMuted={() => true}
        onCopyLink={onCopyLink}
        onPermissions={vi.fn()}
        canManage={() => false}
      />
    )
    const menu = screen.getByRole('menu', { name: 'Actions pour #général' })
    expect(menu).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Paramètres du salon',
      'Réactiver les notifications',
      'Copier le lien',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Copier le lien' }))
    expect(onCopyLink).toHaveBeenCalledWith(target)
    expect(onClose).toHaveBeenCalled()
  })

  it('offers permissions to an admin and draws nothing without actions', () => {
    const view = render(
      <ChannelContextMenu
        target={target}
        onClose={vi.fn()}
        onPermissions={vi.fn()}
        canManage={() => true}
      />
    )
    expect(screen.getByRole('menuitem', { name: 'Permissions' })).toBeInTheDocument()
    view.rerender(<ChannelContextMenu target={target} onClose={vi.fn()} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('places a keyboard-opened menu under its row', () => {
    const row = document.createElement('a')
    row.getBoundingClientRect = () => ({ left: 10, bottom: 50 }) as DOMRect
    expect(menuAnchor({ ...target, clientX: 0, clientY: 0, trigger: row })).toEqual({
      x: 26,
      y: 50,
    })
    expect(menuAnchor(target)).toEqual({ x: 40, y: 80 })
  })
})
