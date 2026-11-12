// Directory privacy on the People screens (contract 0.42.0, `Membership`). Core discloses a
// person's private facts (address, last sign-in, kind of account, second factor, identity) to
// that person and to those who manage people, an owner or an administrator. From any other caller
// it withholds them, omitted or `null` alike, and « a withheld fact says nothing about the
// person ». So the same list has two projections, and this file holds both to their word:
//
//   - the directory, read by an administrator: every address, every sign-in, the row menus;
//   - the colleagues' list, read by a member: names, roles and states. No column for a withheld
//     fact, no « never signed in » for a sign-in that was not told, no blank, no « null », and no
//     action that needs an address to work.
//
// The rows are answered as Core answers them: `asCoreAnswers` withholds the five facts from every
// row but the caller's own, half of them omitted and half `null`.
//
// The checks carry their own refusals (docs/dev/TESTING.md §« Writing a test that can actually
// fail »). Each mutant removes one guard through the observed modules, and `MUTANTS` names the
// words the check must refuse it with; the last block runs them all. To watch the acceptance tests
// themselves go red, arm one from the shell:
//
//   VITE_PEOPLE_PRIVACY_MUTANT=null-address-refused npx vitest run \
//     src/features/people/PeopleDirectoryPrivacy.test.tsx -t "a member"

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '../../mocks/server'
import {
  CALLER_MEMBERSHIP_ID,
  caller,
  member,
  peopleHandlers,
  type Membership,
} from '../../mocks/overlays/support/people'
import type * as FormatModule from './format'
import { disclosedEmail, personLabel, personName, seesPrivateFacts } from './format'
import { MemberDrawer } from './MemberDrawer'
import type * as MemberWireModule from './memberWire'
import { boundMember } from './memberWire'
import { PeopleScreen } from './PeopleScreen'
import type { OrganisationRole } from './roles'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'

/**
 * Each mutant removes one guard, and nothing else:
 *   - `null-address-refused`: a record whose address is `null` is taken for a malformed one, as it
 *     was before Core could withhold an address;
 *   - `label-without-fallback`: a person with neither a name nor a disclosed address is listed
 *     under no words;
 *   - `list-reads-absence`: the list is drawn as the directory for every caller, so a fact's
 *     absence is read as a fact;
 *   - `drawer-reads-absence`: the same, in a person's drawer.
 * The value is the message the checks below must refuse it with.
 */
const MUTANTS = {
  'null-address-refused': 'a colleague whose address is withheld cannot be opened',
  'label-without-fallback': 'a person is listed under no words',
  'list-reads-absence': 'the colleagues’ list draws a withheld fact',
  'drawer-reads-absence': 'a withheld sign-in is read as a fact',
} as const
type Mutant = keyof typeof MUTANTS

const probe = vi.hoisted(() => ({ mutant: null as string | null }))

vi.mock('./format', async (original) => {
  const actual = await original<typeof FormatModule>()
  return {
    ...actual,
    managesPeople: (role: OrganisationRole) =>
      probe.mutant === 'list-reads-absence' ? true : actual.managesPeople(role),
    seesPrivateFacts: (...args: Parameters<typeof actual.seesPrivateFacts>) =>
      probe.mutant === 'drawer-reads-absence' ? true : actual.seesPrivateFacts(...args),
    personLabel: (...args: Parameters<typeof actual.personLabel>) =>
      probe.mutant === 'label-without-fallback'
        ? actual.personName(args[0])
        : actual.personLabel(...args),
  }
})

vi.mock('./memberWire', async (original) => {
  const actual = await original<typeof MemberWireModule>()
  return {
    ...actual,
    boundMember: (value: unknown, organisationId: string, memberId: string) =>
      actual.boundMember(value, organisationId, memberId) &&
      !(probe.mutant === 'null-address-refused' && (value as Membership).email === null),
  }
})

/** The mutant armed from the shell for the acceptance tests; none in an ordinary run. */
const ARMED: Mutant | null = (() => {
  const named: unknown = import.meta.env['VITE_PEOPLE_PRIVACY_MUTANT']
  if (named === undefined || named === '') return null
  if (typeof named === 'string' && named in MUTANTS) return named as Mutant
  throw new Error(`VITE_PEOPLE_PRIVACY_MUTANT names no mutant: ${String(named)}`)
})()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  probe.mutant = null
})
afterAll(() => server.close())
beforeEach(() => {
  signInSynthetic()
  probe.mutant = ARMED
})

const A_MONTH_AGO = '2027-02-01T09:12:00Z'
/** Several searches, each waited for past the field's debounce. */
const SLOW = { timeout: 30_000 }

/** An organisation as Core stores it: every fact of every person. */
function organisation(callerRole: OrganisationRole) {
  const owner = member('Marie Dupont', 'marie.dupont@acme.fr', 'org_owner', { source: 'order' })
  const me = caller(callerRole)
  const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member', {
    last_seen_at: A_MONTH_AGO,
  })
  const nadia = member('Nadia Haddad', 'nadia.haddad@acme.fr', 'org_member', {
    last_seen_at: null,
  })
  const samir = member('Samir Benali', null, 'org_member', {
    account_kind: 'on_site',
    source: 'enrolment_token',
    last_seen_at: null,
  })
  // Invited, so with no name yet: only an address, which a member is not told.
  const invited = member(null, 'anne.moreau@acme.fr', 'org_member', {
    state: 'invited',
    last_seen_at: null,
  })
  return { owner, me, marc, nadia, samir, invited }
}

/** A row with its five private facts withheld, in one of the two forms the contract allows. */
function withheld(row: Membership, form: 'omitted' | 'null'): Membership {
  const publicFacts: Membership = { ...row }
  delete publicFacts.email
  delete publicFacts.identity_id
  delete publicFacts.account_kind
  delete publicFacts.mfa_enrolled
  delete publicFacts.last_seen_at
  return form === 'omitted'
    ? publicFacts
    : { ...publicFacts, email: null, identity_id: null, last_seen_at: null }
}

/** The rows as Core answers them to this caller: directory privacy, row by row. */
function asCoreAnswers(rows: Membership[], callerRole: OrganisationRole): Membership[] {
  if (callerRole === 'org_owner' || callerRole === 'org_admin') return rows
  return rows.map((row, index) =>
    row.id === CALLER_MEMBERSHIP_ID ? row : withheld(row, index % 2 === 0 ? 'omitted' : 'null')
  )
}

function openList(callerRole: OrganisationRole, rows?: Membership[]) {
  const people = organisation(callerRole)
  const onNavigate = vi.fn()
  renderWithApi(
    <PeopleScreen
      organisationId={ORG_ID}
      callerRole={callerRole}
      callerMembershipId={CALLER_MEMBERSHIP_ID}
      tab="members"
      onNavigate={onNavigate}
    />,
    [
      peopleHandlers({
        callerRole,
        members: asCoreAnswers(rows ?? Object.values(people), callerRole),
      }),
    ]
  )
  return { people, onNavigate }
}

function openDrawer(callerRole: OrganisationRole, pick: keyof ReturnType<typeof organisation>) {
  const people = organisation(callerRole)
  renderWithApi(
    <MemberDrawer
      organisationId={ORG_ID}
      callerRole={callerRole}
      callerMembershipId={CALLER_MEMBERSHIP_ID}
      memberId={people[pick].id}
      onClose={vi.fn()}
    />,
    [peopleHandlers({ callerRole, members: asCoreAnswers(Object.values(people), callerRole) })]
  )
  return people
}

async function listedTable() {
  const table = await screen.findByRole('table', { name: 'Personnes' })
  await within(table).findByRole('row', { name: /Marc Petit/ })
  return table
}

const columnsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent)

/** What a missing fact must never be drawn as: a claim about the person, a blank, or a leak. */
const ABSENCE_READ_AS_FACT = /Jamais connecté|Accès sur site|Dernière connexion|undefined|null|—|@/

/**
 * The colleagues' list keeps its word: three columns, none for a withheld fact; no row that reads
 * an absence as a fact; and every person listed under words a reader and a screen reader get.
 */
function assertColleaguesList(table: HTMLElement) {
  const columns = columnsOf(table)
  if (columns.join(' | ') !== 'Nom | Rôle | État')
    throw new Error(`the colleagues’ list draws a withheld fact (columns: ${columns.join(' | ')})`)
  for (const row of within(table).getAllByRole('row').slice(1)) {
    const text = row.textContent
    const read = ABSENCE_READ_AS_FACT.exec(text)
    if (read !== null)
      throw new Error(`the colleagues’ list draws a withheld fact (« ${read[0]} » in « ${text} »)`)
    const name = within(row).getByRole('rowheader')
    const opener = within(name).getByRole('button')
    if (name.textContent.trim() === '' || opener.textContent.trim() === '')
      throw new Error(`a person is listed under no words (row « ${text} »)`)
    if (
      within(row)
        .getAllByRole('cell')
        .some((cell) => cell.textContent.trim() === '')
    )
      throw new Error(`the colleagues’ list draws a withheld fact (an empty cell in « ${text} »)`)
  }
  if (table.querySelector('a[href^="mailto:"]') !== null)
    throw new Error('the colleagues’ list draws a withheld fact (a mailto: link)')
}

/** What the drawer says when the record it read is not one it can show. */
const UNAVAILABLE = /indisponible/i

/** A colleague's drawer, read by a member: it opens, under a name, and claims no sign-in. */
async function assertColleagueDrawer(expectedTitle: string) {
  const drawer = await screen.findByRole('dialog')
  const refused = () => within(drawer).queryByText(UNAVAILABLE)
  const opened = () => within(drawer).queryByRole('combobox', { name: 'Rôle' })
  await waitFor(() => {
    if (refused() === null && opened() === null) throw new Error('the drawer is still loading')
  })
  if (refused() !== null || opened() === null)
    throw new Error('a colleague whose address is withheld cannot be opened')
  const title = within(drawer).getByRole('heading', { level: 2 }).textContent
  if (title.trim() === '') throw new Error('a person is listed under no words (the drawer’s title)')
  expect(title).toBe(expectedTitle)
  const read = /Jamais connecté|Dernière connexion|undefined|null|@/.exec(drawer.textContent)
  if (read !== null) throw new Error(`a withheld sign-in is read as a fact (« ${read[0]} »)`)
  return drawer
}

describe('the directory, read by an administrator', () => {
  it('lists every address and every sign-in, with the row menus', async () => {
    openList('org_admin')
    const table = await listedTable()
    expect(columnsOf(table)).toEqual(['Nom', 'E-mail', 'Rôle', 'Dernière connexion', 'Actions'])
    const marc = within(table).getByRole('row', { name: /Marc Petit/ })
    expect(marc).toHaveTextContent('marc.petit@acme.fr')
    expect(marc).not.toHaveTextContent('Jamais connecté')
    expect(within(marc).getByRole('button', { name: 'Actions pour Marc Petit' })).toBeVisible()
    expect(within(table).getByRole('row', { name: /Nadia Haddad/ })).toHaveTextContent(
      'Jamais connecté'
    )
    expect(within(table).getByRole('row', { name: /Samir Benali/ })).toHaveTextContent(
      'Accès sur site'
    )
    // A pending invitation has no name yet: its address stands in, and it can be sent again.
    const invited = within(table).getByRole('row', { name: /anne\.moreau@acme\.fr/ })
    expect(invited).toHaveTextContent('En attente')
    await userEvent.click(
      within(invited).getByRole('button', { name: 'Actions pour anne.moreau@acme.fr' })
    )
    expect(screen.getByRole('menuitem', { name: "Renvoyer l'invitation" })).toBeVisible()
  })

  it('draws an account with no address as a dash that is not read out, never as a word', async () => {
    openList('org_admin')
    const table = await listedTable()
    const samir = within(table).getByRole('row', { name: /Samir Benali/ })
    const address = within(samir).getAllByRole('cell')[0]!
    expect(address).toHaveTextContent(/^—$/)
    expect(address.querySelector('[aria-hidden="true"]')).toHaveTextContent('—')
    expect(table).not.toHaveTextContent(/undefined|null/)
    expect(table.querySelector('a[href^="mailto:"]')).toBeNull()
  })

  it('searches names and addresses, and says so', async () => {
    openList('org_admin')
    const table = await listedTable()
    const search = screen.getByRole('searchbox', { name: 'Rechercher un nom ou un e-mail' })
    await userEvent.type(search, 'marc.petit@')
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(1))
    expect(within(table).getByRole('row', { name: /Marc Petit/ })).toBeVisible()
  })

  it('opens a person with their address and their last sign-in, or its absence', async () => {
    openDrawer('org_admin', 'nadia')
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('nadia.haddad@acme.fr')).toBeVisible()
    expect(within(drawer).getByText('Jamais connecté')).toBeVisible()
  })
})

describe('the colleagues’ list, read by a member', () => {
  it('a member reads names, roles and states, and no withheld fact', async () => {
    openList('org_member')
    const table = await listedTable()
    assertColleaguesList(table)
    expect(columnsOf(table)).toEqual(['Nom', 'Rôle', 'État'])
    expect(within(table).getByRole('row', { name: /Marc Petit/ })).toHaveTextContent(
      /^MPMarc PetitMembreActive$/
    )
    // Their own row is told to them in full, and is drawn as every other row is.
    expect(within(table).getByRole('row', { name: /Julie Marchand/ })).toHaveTextContent(
      /^JMJulie MarchandMembreActive$/
    )
  })

  it('a member reads a colleague with no name under their role, with a person glyph', async () => {
    openList('org_member')
    const table = await listedTable()
    assertColleaguesList(table)
    const invited = within(table).getByRole('row', { name: /En attente/ })
    const name = within(invited).getByRole('rowheader')
    // The label alone: no initial taken from it, a glyph in the avatar instead.
    expect(name).toHaveTextContent(/^Membre$/)
    expect(name.querySelector('svg')).not.toBeNull()
    expect(within(name).getByRole('button', { name: 'Membre' })).toBeVisible()
  })

  it('a member keeps the order Core gave, whatever is withheld', async () => {
    const { people } = openList('org_member')
    const table = await listedTable()
    const listed = within(table)
      .getAllByRole('rowheader')
      .map((header) => within(header).getByRole('button').textContent)
    expect(listed).toEqual([
      'Marie Dupont',
      'Julie Marchand',
      'Marc Petit',
      'Nadia Haddad',
      'Samir Benali',
      'Membre',
    ])
    expect(Object.values(people)).toHaveLength(listed.length)
  })

  it('a member searches names only, and is not offered to search an address', SLOW, async () => {
    openList('org_member')
    const table = await listedTable()
    expect(screen.queryByRole('searchbox', { name: /e-mail/i })).toBeNull()
    const search = screen.getByRole('searchbox', { name: 'Rechercher' })
    // An address the member happens to know finds nobody: it is not searched, nor told.
    await userEvent.type(search, 'marc.petit@acme.fr')
    expect(await screen.findByText(/Aucune personne ne correspond à/)).toBeVisible()
    await userEvent.clear(search)
    await userEvent.type(search, 'nadia')
    expect(await within(table).findByRole('row', { name: /Nadia Haddad/ })).toBeVisible()
    expect(within(table).getAllByRole('rowheader')).toHaveLength(1)
    // The search reads the words a person is listed under, not their state or their role's badge;
    // a colleague with no name is listed under their role, and found under it.
    await userEvent.clear(search)
    await userEvent.type(search, 'en attente')
    expect(await screen.findByText(/Aucune personne ne correspond à/)).toBeVisible()
    await userEvent.clear(search)
    await userEvent.type(search, 'membre')
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(1))
    expect(within(table).getByRole('rowheader')).toHaveTextContent(/^Membre$/)
    assertColleaguesList(table)
  })

  it('a member is offered nothing that needs an address or the right to invite', async () => {
    openList('org_member')
    const table = await listedTable()
    expect(within(table).queryByRole('button', { name: /^Actions pour/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Inviter/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: "Renvoyer l'invitation" })).toBeNull()
  })

  it('a member alone reads their own row, not an invitation to invite', async () => {
    openList('org_member', [caller('org_member')])
    const table = await screen.findByRole('table', { name: 'Personnes' })
    expect(await within(table).findByRole('row', { name: /Julie Marchand/ })).toBeVisible()
    expect(screen.queryByRole('heading', { name: "Personne pour l'instant" })).toBeNull()
    expect(screen.queryByRole('button', { name: /Inviter/ })).toBeNull()
  })

  it('a member opens a colleague whose address is withheld as null, and reads no sign-in', async () => {
    // `nadia` is the fourth row: her facts are withheld as `null`, the form the drawer once refused.
    const people = openDrawer('org_member', 'nadia')
    expect(asCoreAnswers(Object.values(people), 'org_member')[3]).toMatchObject({
      display_name: 'Nadia Haddad',
      email: null,
      last_seen_at: null,
    })
    const drawer = await assertColleagueDrawer('Nadia Haddad')
    expect(within(drawer).getByText('Active')).toBeVisible()
  })

  it('a member opens a colleague whose facts are omitted, the same', async () => {
    openDrawer('org_member', 'marc')
    await assertColleagueDrawer('Marc Petit')
  })

  it('a member opens a colleague with no name under their role', async () => {
    openDrawer('org_member', 'invited')
    await assertColleagueDrawer('Membre')
  })

  it('a member reads their own address and sign-in in their own drawer', async () => {
    openDrawer('org_member', 'me')
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('julie@acme.fr')).toBeVisible()
    expect(within(drawer).getByText(/^Dernière connexion /)).toBeVisible()
  })
})

describe('the rules, on their own', () => {
  const t = ((key: string) => `«${key}»`) as unknown as Parameters<typeof personLabel>[1]

  it('treats an omitted, a null and an empty address alike: none disclosed', () => {
    expect(disclosedEmail({})).toBeUndefined()
    expect(disclosedEmail({ email: null })).toBeUndefined()
    expect(disclosedEmail({ email: '  ' })).toBeUndefined()
    expect(disclosedEmail({ email: 'julie@acme.fr' })).toBe('julie@acme.fr')
  })

  it('names a person by their name, else their disclosed address, else their role', () => {
    expect(personName({ display_name: ' Julie ', email: 'julie@acme.fr' })).toBe('Julie')
    expect(personName({ display_name: null, email: 'julie@acme.fr' })).toBe('julie@acme.fr')
    expect(personName({ display_name: null, email: null })).toBe('')
    expect(personName({ display_name: '  ' })).toBe('')
    expect(personLabel({ display_name: null, email: null, role: 'org_member' }, t)).toBe(
      '«console.people.list.status-role-member»'
    )
    expect(personLabel({ display_name: 'Julie', role: 'org_admin' }, t)).toBe('Julie')
  })

  it('discloses private facts to the person themself and to those who manage people', () => {
    expect(seesPrivateFacts('org_owner', 'me', 'other')).toBe(true)
    expect(seesPrivateFacts('org_admin', 'me', 'other')).toBe(true)
    expect(seesPrivateFacts('org_member', 'me', 'me')).toBe(true)
    expect(seesPrivateFacts('org_member', 'me', 'other')).toBe(false)
    expect(seesPrivateFacts('org_billing', 'me', 'other')).toBe(false)
    expect(seesPrivateFacts('org_member', undefined, 'other')).toBe(false)
  })

  it('takes a membership whose address is null or omitted for a membership', () => {
    const row = { ...member('Marc Petit', null, 'org_member'), id: 'm1', organisation_id: 'o1' }
    expect(boundMember(row, 'o1', 'm1')).toBe(true)
    expect(boundMember({ ...row, email: null, last_seen_at: null }, 'o1', 'm1')).toBe(true)
    expect(boundMember({ ...row, email: 7 }, 'o1', 'm1')).toBe(false)
  })
})

// The refusals: each mutant removes one guard, and the checks above must refuse it in its own
// words. The control runs the same checks with no mutant, so a refusal is the mutant's doing.
describe('the checks refuse each mutant', () => {
  async function listVerdict(mutant: Mutant | null) {
    probe.mutant = mutant
    openList('org_member')
    assertColleaguesList(await listedTable())
  }
  async function drawerVerdict(mutant: Mutant | null, pick: 'nadia' | 'invited', title: string) {
    probe.mutant = mutant
    openDrawer('org_member', pick)
    await assertColleagueDrawer(title)
  }

  it('control: with no mutant, the list and the drawer pass', async () => {
    await expect(listVerdict(null)).resolves.toBeUndefined()
  })

  it('control: with no mutant, a colleague withheld as null opens', async () => {
    await expect(drawerVerdict(null, 'nadia', 'Nadia Haddad')).resolves.toBeUndefined()
  })

  it('mutant null-address-refused: a null address is taken for a malformed record', async () => {
    await expect(drawerVerdict('null-address-refused', 'nadia', 'Nadia Haddad')).rejects.toThrow(
      MUTANTS['null-address-refused']
    )
  })

  it('mutant label-without-fallback: a colleague with no name is listed under no words', async () => {
    await expect(listVerdict('label-without-fallback')).rejects.toThrow(
      MUTANTS['label-without-fallback']
    )
  })

  it('mutant list-reads-absence: the member is drawn the directory, dashes and « never »', async () => {
    await expect(listVerdict('list-reads-absence')).rejects.toThrow(MUTANTS['list-reads-absence'])
  })

  it('mutant drawer-reads-absence: a withheld sign-in becomes « never signed in »', async () => {
    await expect(drawerVerdict('drawer-reads-absence', 'nadia', 'Nadia Haddad')).rejects.toThrow(
      MUTANTS['drawer-reads-absence']
    )
  })
})
