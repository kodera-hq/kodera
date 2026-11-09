import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { MessagingDemoSurface } from './MessagingDemoSurface'
import { DEMO_CHANNELS, DEMO_MEMBERS, DEMO_MESSAGES, DEMO_ROOMS } from './demo-fixture'

// Every assertion below is on the rendered French, never on a key or an
// English fallback (docs/dev/I18N.md), and on the accessible name rather than
// a test id: a channel list a screen reader cannot navigate is not a channel
// list, however it looks.

describe('the messaging demo preview', () => {
  it('says on the page that it is a demonstration wired to no messaging service', () => {
    render(<MessagingDemoSurface />)
    expect(screen.getByText('Aperçu de démonstration')).toBeVisible()
    expect(screen.getByText(/Il n’est relié à aucune messagerie/, { exact: false })).toBeVisible()
  })

  it('names the application it previews, which this repository does not implement', () => {
    render(<MessagingDemoSurface />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Messagerie Tchap')
    expect(screen.getByText(/Messagerie de La Suite/)).toBeVisible()
  })

  it('lists every channel of the handoff as a real control, the open one marked current', () => {
    render(<MessagingDemoSurface />)
    const navigation = screen.getByRole('navigation', { name: 'Canaux et salons de l’aperçu' })
    for (const channel of DEMO_CHANNELS) {
      expect(
        within(navigation).getByRole('button', { name: new RegExp(channel.name) })
      ).toBeVisible()
    }
    expect(within(navigation).getByRole('button', { name: /#chantier-a13/ })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('gives an unread count a name, not only a coloured number', () => {
    render(<MessagingDemoSurface />)
    const navigation = screen.getByRole('navigation', { name: 'Canaux et salons de l’aperçu' })
    expect(within(navigation).getByRole('button', { name: /3 messages non lus/ })).toBeVisible()
  })

  it('shows the permanent rooms with their occupants and what each person is doing', () => {
    render(<MessagingDemoSurface />)
    expect(screen.getByRole('heading', { name: 'Salons — audio et visio' })).toBeVisible()
    for (const room of DEMO_ROOMS) {
      expect(screen.getByText(room.name)).toBeVisible()
    }
    const conduite = screen.getByRole('list', {
      name: 'Personnes présentes dans Conduite de travaux',
    })
    expect(within(conduite).getAllByRole('listitem')).toHaveLength(3)
    expect(within(conduite).getByText('parle')).toBeVisible()
    expect(within(conduite).getByText('micro coupé')).toBeVisible()
    // A room nobody is in reads as empty rather than as a broken count.
    expect(screen.getByText('Salon vide, 20 places')).toBeVisible()
  })

  it('renders the seeded conversation as an ordered list, each message with author, role and time', () => {
    render(<MessagingDemoSurface />)
    const conversation = screen.getByRole('region', {
      name: 'Conversation du canal #chantier-a13',
    })
    const messages = within(conversation).getAllByRole('listitem')
    expect(messages).toHaveLength(DEMO_MESSAGES.length)
    const first = messages[0]
    expect(first).toBeDefined()
    expect(within(first as HTMLElement).getByText('Sylvain Ellenstein')).toBeVisible()
    expect(within(first as HTMLElement).getByText('Conducteur')).toBeVisible()
    expect(within(first as HTMLElement).getByText('06:52')).toBeVisible()
    expect(within(conversation).getByRole('heading', { level: 3 })).toHaveTextContent(
      'mardi 8 septembre'
    )
  })

  it('lists the members it actually renders, and counts them rather than asserting a number', () => {
    render(<MessagingDemoSurface />)
    const members = screen.getByRole('region', { name: 'Membres du canal #chantier-a13' })
    expect(within(members).getAllByRole('listitem')).toHaveLength(DEMO_MEMBERS.length)
    expect(
      within(members).getByRole('heading', { name: `${DEMO_MEMBERS.length} membres` })
    ).toBeVisible()
  })

  it('offers a labelled composer that reports it sent nothing', async () => {
    const user = userEvent.setup()
    render(<MessagingDemoSurface />)
    const composer = screen.getByLabelText('Message à #chantier-a13')
    await user.type(composer, 'Bonjour')
    expect(composer).toHaveValue('Bonjour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(composer).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Rien n’a été envoyé : cet aperçu n’est relié à aucune messagerie.'
    )
  })

  it('tells the truth about a channel it carries no conversation for, rather than inventing one', async () => {
    const user = userEvent.setup()
    render(<MessagingDemoSurface />)
    await user.click(screen.getByRole('button', { name: /#annonces/ }))
    const conversation = screen.getByRole('region', { name: 'Conversation du canal #annonces' })
    expect(within(conversation).queryAllByRole('listitem')).toHaveLength(0)
    expect(within(conversation).getByText('Canal absent de l’aperçu')).toBeVisible()
    expect(
      within(conversation).getByText('Seul le canal #chantier-a13 est illustré ici.')
    ).toBeVisible()
  })
})

describe('the composer', () => {
  it('draws its field with the control edge', () => {
    render(<MessagingDemoSurface />)
    expect(screen.getByRole('textbox')).toHaveClass('border-c-border-input')
  })
})
