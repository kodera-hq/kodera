import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { PassportContext, type PassportServices } from './passportContext'
import { UserProfilePopover, type MemberProfile } from './UserProfilePopover'

const MEMBER: MemberProfile = {
  userId: '@miguel:kodera.test',
  name: 'Miguel Victoria',
  presence: 'online',
  role: 'admin',
}

function renderCard(services: PassportServices | null, onMention?: () => void) {
  render(
    <PassportContext.Provider value={services}>
      <UserProfilePopover
        member={MEMBER}
        onMention={onMention}
        trigger={<button type="button">Miguel Victoria</button>}
      />
    </PassportContext.Provider>
  )
}

describe('UserProfilePopover (Kodera Passport)', () => {
  it('shows the passport banner, presence, role and tag pills, and the bio', async () => {
    const user = userEvent.setup()
    renderCard({
      subscribe: () => () => undefined,
      getSnapshot: () => 1,
      getPassport: () => ({
        accent: 't4',
        bio: 'Sons et lumière',
        tags: ['design'],
        onboarded: true,
      }),
    })
    await user.click(screen.getByRole('button', { name: 'Miguel Victoria' }))
    const card = await screen.findByRole('dialog', { name: 'Miguel Victoria' })
    expect(card.querySelector('[data-passport-accent="t4"]')).not.toBeNull()
    expect(card.querySelector('[data-presence="online"]')).not.toBeNull()
    expect(within(card).getByText('Admin')).toBeInTheDocument()
    expect(within(card).getByText('En ligne')).toBeInTheDocument()
    expect(within(card).getByText('design')).toBeInTheDocument()
    expect(within(card).getByText('Sons et lumière')).toBeInTheDocument()
    for (const button of within(card).getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
      expect(button.textContent?.replace('@', '').trim()).toBe('')
    }
  })

  it('writes to the member in one press from the card', async () => {
    const user = userEvent.setup()
    const sendDirect = vi.fn(async () => undefined)
    renderCard(
      { subscribe: () => () => undefined, getSnapshot: () => 1, sendDirect },
      () => undefined
    )
    await user.click(screen.getByRole('button', { name: 'Miguel Victoria' }))
    const field = await screen.findByRole('textbox', { name: 'Message à Miguel Victoria' })
    const send = screen.getByRole('button', { name: 'Envoyer à Miguel Victoria' })
    expect(send).toBeDisabled()
    await user.type(field, 'Salut !{Enter}')
    await waitFor(() => expect(sendDirect).toHaveBeenCalledWith('@miguel:kodera.test', 'Salut !'))
    expect(await screen.findByRole('status')).toHaveTextContent('Message envoyé')
    expect(field).toHaveValue('')
  })

  it('offers no message field on the member’s own card', async () => {
    const user = userEvent.setup()
    renderCard({ subscribe: () => () => undefined, getSnapshot: () => 1, sendDirect: vi.fn() })
    await user.click(screen.getByRole('button', { name: 'Miguel Victoria' }))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
