import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '../../i18n'
import { StudioNavigation } from './StudioNavigation'

const channel = { id: 'design', label: 'design', kind: 'text' as const }
const doc = { id: 'review', title: 'Review notes', channelId: channel.id, content: 'Review' }

for (const compact of [false, true]) {
  it(`opens activity and closes after channel navigation (compact=${compact})`, async () => {
    const onChoose = vi.fn(() => null)
    const user = userEvent.setup()
    render(
      <StudioNavigation
        compact={compact}
        section="primary"
        mode="chat"
        rooms={[]}
        onChoose={onChoose}
        activity={[{ channel, unread: 3, mentions: 1, body: '@Reviewer please check the guide' }]}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Notifications' }))
    const panel = screen.getByRole(compact ? 'region' : 'dialog', { name: 'Notifications' })
    expect(panel).toHaveTextContent('Non lus: 3')
    expect(panel).toHaveTextContent('Mentions: 1')
    await user.click(within(panel).getByRole('button', { name: /#design/ }))
    expect(onChoose).toHaveBeenCalledWith(channel)
    expect(screen.queryByRole(compact ? 'region' : 'dialog', { name: 'Notifications' })).toBeNull()
  })

  it(`opens the exact document and lists attachments (compact=${compact})`, async () => {
    const user = userEvent.setup()
    const onOpenDocument = vi.fn(() => null)
    const onChoose = vi.fn(() => null)
    render(
      <StudioNavigation
        compact={compact}
        section="tools"
        mode="chat"
        rooms={[]}
        onChoose={onChoose}
        onOpenDocument={onOpenDocument}
        files={[
          { id: doc.id, title: doc.title, channel, document: doc },
          { id: 'attachment', title: 'diagram.svg', channel },
        ]}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Fichiers' }))
    await user.click(screen.getByRole('button', { name: /Review notes/ }))
    expect(onOpenDocument).toHaveBeenCalledWith(doc)
    expect(onChoose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Fichiers' }))
    await user.click(screen.getByRole('button', { name: /diagram.svg/ }))
    expect(onChoose).toHaveBeenCalledWith(channel)
  })
}

it('shows truthful empty states and returns keyboard focus on Escape', async () => {
  const user = userEvent.setup()
  const { unmount } = render(
    <StudioNavigation section="primary" mode="chat" rooms={[]} onChoose={() => null} />
  )
  const trigger = screen.getByRole('button', { name: 'Notifications' })
  await user.click(trigger)
  expect(screen.getByText('Aucun message non lu ni activité récente.')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  unmount()
  render(<StudioNavigation section="tools" mode="chat" rooms={[]} onChoose={() => null} />)
  await user.click(screen.getByRole('button', { name: 'Fichiers' }))
  expect(screen.getByText('Aucun document ni pièce jointe dans cet espace.')).toBeInTheDocument()
})
