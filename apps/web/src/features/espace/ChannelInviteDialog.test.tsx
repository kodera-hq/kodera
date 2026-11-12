import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { communityWorkspace } from '../../mocks/demo/community'
import { createLocalWorkspaceStore } from '../../mocks/demo/workspaceStore'
import { ChannelInviteDialog } from './ChannelInviteDialog'
import { isMatrixUserId, roomInvitationLinks } from './roomInvitations'

function setup() {
  const workspace = communityWorkspace()
  const channel = workspace.categories
    .flatMap((category) => category.channels)
    .find((channel) => channel.name === 'partner-onboarding')!
  const store = createLocalWorkspaceStore(workspace, 'community')
  const room = store.getSnapshot().rooms.find((room) => room.name === channel.name)!
  return { org: 'community', channel, room, store, unavailable: false }
}

describe('universal Matrix invitation links', () => {
  it('preserves canonical aliases independently of display names and routing servers', () => {
    expect(
      roomInvitationLinks({
        roomId: '!opaque:example.test',
        alias: '#partner-onboarding:community.kodera.test',
        serverName: 'routing.example.test:8448',
        channelSlug: 'renamed',
        org: 'a/b',
        channelId: 'one/two',
        origin: 'https://console.example.test',
      })
    ).toEqual({
      matrixTo:
        'https://matrix.to/#/%23partner-onboarding%3Acommunity.kodera.test?via=routing.example.test%3A8448',
      matrixUri:
        'matrix:r/partner-onboarding:community.kodera.test?action=join&via=routing.example.test%3A8448',
      alias: '#partner-onboarding:community.kodera.test',
      web: 'https://console.example.test/a%2Fb/workspace/one%2Ftwo',
    })
  })

  it('uses the real room ID when no alias is published, including room IDs without a domain', () => {
    const links = roomInvitationLinks({
      roomId: '!opaque/hash',
      alias: null,
      serverName: 'community.example.test',
      channelSlug: 'partner-onboarding',
      org: 'community',
      channelId: 'id',
      origin: 'https://console.example.test',
    })
    expect(links.matrixTo).toBe('https://matrix.to/#/!opaque%2Fhash?via=community.example.test')
    expect(links.matrixUri).toBe(
      'matrix:roomid/opaque%2Fhash?action=join&via=community.example.test'
    )
    expect(links.alias).toBe('#partner-onboarding:community.example.test')
  })

  it.each([
    '@marie:example.org',
    '@prenom.nom:example.org',
    '@architecte:example.com',
    '@legacy=2fUser:localhost:8448',
    '@user:[2001:db8::1]:8448',
  ])('accepts an existing Matrix identity %s', (id) => expect(isMatrixUserId(id)).toBe(true))

  it.each([
    'marie:example.org',
    '@marie',
    '@marie:',
    '@:example.test',
    '@a b:example.test',
    '@marie:https://example.test',
    '@marie:example.test/path',
    '@marie:example..test',
    '@marie:-example.test',
    '@marie:example.test?bad',
    `@${'a'.repeat(255)}:example.test`,
  ])('rejects malformed identities %s', (id) => expect(isMatrixUserId(id)).toBe(false))
})

describe('Matrix channel invitation dialog', () => {
  it('copies every displayed format in one click and reports clipboard failure', async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    render(<ChannelInviteDialog {...setup()} />)
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    const dialog = screen.getByRole('dialog')
    const expected = [
      'https://matrix.to/#/%23partner-onboarding%3Ademo.invalid?via=community.kodera.io',
      '#partner-onboarding:demo.invalid',
      'matrix:r/partner-onboarding:demo.invalid?action=join&via=community.kodera.io',
      `${window.location.origin}/community/workspace/${setup().channel.id}`,
    ]
    const buttons = within(dialog).getAllByRole('button', { name: /^Copier :/ })
    for (const [index, button] of buttons.entries()) {
      await user.click(button)
      expect(clipboard).toHaveBeenLastCalledWith(expected[index])
      expect(button).toHaveTextContent('Copié')
    }
    clipboard.mockRejectedValueOnce(new Error('Clipboard denied'))
    await user.click(buttons[0]!)
    expect(within(dialog).getByRole('alert')).toHaveTextContent('La copie a échoué')
  })

  it('reports homeserver refusals and lets the user retry', async () => {
    const user = userEvent.setup()
    const props = setup()
    const invite = vi
      .spyOn(props.store, 'inviteToRoom')
      .mockRejectedValueOnce(new Error('M_FORBIDDEN'))
    render(<ChannelInviteDialog {...props} />)
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    await user.type(screen.getByRole('textbox'), '@marie:example.org')
    await user.click(screen.getByTestId('espace-channel-invite-submit'))
    expect(screen.getByRole('alert')).toHaveTextContent('L’invitation Matrix a échoué')
    await user.click(screen.getByTestId('espace-channel-invite-submit'))
    expect(invite).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Invitation Matrix envoyée')
  })

  it('keeps links usable when an injected store cannot send invitations', async () => {
    const user = userEvent.setup()
    const props = setup()
    delete props.store.inviteToRoom
    render(<ChannelInviteDialog {...props} />)
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    expect(screen.getByTestId('espace-channel-invite-submit')).toBeDisabled()
    expect(
      screen.getByText(
        'L’envoi direct est indisponible ici. Vous pouvez copier un lien vers le salon.'
      )
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Copier :/ })).toHaveLength(4)
  })

  it('prevents duplicate sends and ignores an old response after closing and reopening', async () => {
    const user = userEvent.setup()
    const props = setup()
    let finish = () => {}
    const invite = vi.spyOn(props.store, 'inviteToRoom').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(<ChannelInviteDialog {...props} />)
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    await user.type(screen.getByRole('textbox'), '@marie:example.org')
    const submit = screen.getByTestId('espace-channel-invite-submit')
    await user.dblClick(submit)
    expect(invite).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    await act(async () => finish())
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('closes on store replacement so a new identity cannot inherit an invitation draft', async () => {
    const user = userEvent.setup()
    const props = setup()
    const view = render(<ChannelInviteDialog {...props} />)
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    await user.type(screen.getByRole('textbox'), '@marie:example.org')
    view.rerender(<ChannelInviteDialog {...props} store={setup().store} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByTestId('espace-channel-invite-btn'))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})
