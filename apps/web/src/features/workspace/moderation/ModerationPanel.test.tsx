import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ModerationApiModule from './moderationApi'
import type * as IamApiModule from '../iamApi'
import type * as MembersApiModule from '../admin/membersApi'
import '../../../i18n'
import { ORG, renderPanel } from '../admin/test-support'
import { ModerationPanel } from './ModerationPanel'

const moderation = vi.hoisted(() => ({
  listReports: vi.fn(async () => []),
  moderateMember: vi.fn(async () => undefined),
}))
vi.mock('./moderationApi', async (actual) => ({
  ...(await actual<typeof ModerationApiModule>()),
  ...moderation,
}))
const iam = vi.hoisted(() => ({ listWorkspaceBans: vi.fn() }))
vi.mock('../iamApi', async (actual) => ({
  ...(await actual<typeof IamApiModule>()),
  ...iam,
}))
const directory = vi.hoisted(() => ({ queries: [] as string[] }))
vi.mock('../admin/membersApi', async (actual) => ({
  ...(await actual<typeof MembersApiModule>()),
  useDirectory: (_org: string, query = '') => {
    directory.queries.push(query)
    const all = [
      {
        id: 'member-camille',
        display_name: 'Camille Dubois',
        email: 'camille@acme.fr',
        role: 'org_member',
        state: 'active',
      },
      {
        id: 'member-marc',
        display_name: null,
        email: 'marc.petit@acme.fr',
        role: 'org_member',
        state: 'active',
      },
    ]
    const q = query.trim().toLowerCase()
    return {
      data: {
        pages: [
          {
            data: all.filter((row) =>
              `${row.display_name ?? ''} ${row.email}`.toLowerCase().includes(q)
            ),
            has_more: false,
            next_cursor: null,
          },
        ],
      },
      isFetching: false,
    }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  directory.queries = []
  iam.listWorkspaceBans.mockResolvedValue({
    data: [
      {
        id: 'b1',
        membership_id: 'member-banned',
        display_name: 'Alex Martin',
        email: 'alex@acme.fr',
        updated_at: '2026-11-01T10:00:00Z',
      },
    ],
    hasMore: false,
    nextCursor: null,
  })
})

describe('Sécurité & modération', () => {
  it('chooses the member by name from a search, never by typing a raw identifier', async () => {
    const user = userEvent.setup()
    renderPanel(<ModerationPanel organisationId={ORG} />)
    expect(screen.queryByRole('textbox', { name: /identifiant|membership/iu })).toBeNull()
    const combobox = screen.getByRole('combobox', { name: 'Personne concernée' })
    await user.type(combobox, 'cami')
    expect(directory.queries).toContain('cami')
    const listbox = screen.getByRole('listbox', { name: 'Personne concernée' })
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    await user.click(within(listbox).getByRole('option', { name: /Camille Dubois/u }))
    expect(screen.getByRole('group', { name: 'Personne concernée' })).toHaveTextContent(
      'Camille Dubois'
    )
    expect(document.body.textContent).not.toMatch(/member-camille/u)
    await user.type(screen.getByRole('textbox', { name: /motif|raison/iu }), 'Spam répété')
    await user.click(screen.getByRole('button', { name: /Appliquer/u }))
    await waitFor(() =>
      expect(moderation.moderateMember).toHaveBeenCalledWith(ORG, {
        membershipId: 'member-camille',
        action: 'mute',
        reason: 'Spam répété',
        days: 1,
      })
    )
  })

  it('picks a member with the keyboard', async () => {
    const user = userEvent.setup()
    renderPanel(<ModerationPanel organisationId={ORG} />)
    await user.type(screen.getByRole('combobox', { name: 'Personne concernée' }), 'acme')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByRole('group', { name: 'Personne concernée' })).toHaveTextContent(
      'marc.petit'
    )
  })

  it('lists bans, searches them and lifts one in a single click', async () => {
    const user = userEvent.setup()
    renderPanel(<ModerationPanel organisationId={ORG} />)
    const bans = await screen.findByRole('list', { name: 'Personnes bannies' })
    expect(within(bans).getByText('Alex Martin')).toBeVisible()
    await user.type(
      screen.getByRole('searchbox', { name: 'Rechercher une personne bannie' }),
      'alex'
    )
    await waitFor(() => expect(iam.listWorkspaceBans).toHaveBeenLastCalledWith(ORG, { q: 'alex' }))
    await user.click(screen.getByRole('button', { name: 'Lever le bannissement de Alex Martin' }))
    await waitFor(() =>
      expect(moderation.moderateMember).toHaveBeenCalledWith(ORG, {
        membershipId: 'member-banned',
        action: 'unban',
        reason: expect.any(String) as string,
      })
    )
    expect(await screen.findByText('Alex Martin peut de nouveau rejoindre l’espace.')).toBeVisible()
  })
})
