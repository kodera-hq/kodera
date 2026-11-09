// The invitation acceptance screen (docs/specs/12-invitation-accept.md §5): the discovery check
// before any sign-in, what is sent, and what the person reads for each answer `acceptInvitation`
// can give. The connected run is the v1 smoke's E2 (tests/smoke/README.md).
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem, NetworkError } from '../../api/client'
import type * as Client from '../../api/client'
import { AcceptScreen } from './AcceptScreen'
import { forgetInvitationEntry, holdInvitationEntry, readInvitationEntry } from './entry'

const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const SLUG = 'acme-sa'
// Low entropy on purpose: the history's secret scan must not read a fixture as a key.
const FRAGMENT = 'inv1_' + 'x'.repeat(40)
const NAME = 'Acme SA'

interface Sent {
  path: string
  body: unknown
  key: unknown
}

const h = vi.hoisted(() => ({
  sent: [] as Sent[],
  discovery: undefined as (() => Promise<unknown>) | undefined,
  answers: [] as (() => Promise<unknown>)[],
  begun: [] as unknown[],
  popup: 'ok' as 'ok' | 'closed' | 'pending',
  cancelled: 0,
  /** Each pending window's rejection, which the test delivers when it chooses. */
  rejects: [] as (() => void)[],
  generation: 3,
  navigate: vi.fn(),
  removed: [] as unknown[],
  me: undefined as (() => Promise<unknown>) | undefined,
  /** The organisation's application codes, as its tenant status lists them. */
  apps: ['visio', 'messaging'] as string[],
  appsOf: [] as unknown[],
}))

// The organisation's applications come from its tenant status (`landingIn`); the choice itself,
// `landingFor`, is the real one.
vi.mock('../../app/organisationLanding', async () => {
  const { landingFor } = await import('../../app/landing')
  return {
    landingIn: (organisationId: string, role: Parameters<typeof landingFor>[0]) => {
      h.appsOf.push(organisationId)
      return Promise.resolve(landingFor(role, h.apps as never))
    },
  }
})

vi.mock('../../api/client', async (actual) => ({
  ...(await actual<typeof Client>()),
  coreApi: () => ({
    GET: (path: string) => {
      h.sent.push({ path, body: undefined, key: undefined })
      return h.me!()
    },
  }),
}))

vi.mock('../../auth/oidc', () => ({
  authAdapter: {
    getSnapshot: () => ({
      status: 'ready',
      generation: h.generation,
      credentialGeneration: 1,
      user: undefined,
    }),
    ownerClaimAuth: {
      begin: (context: unknown) => {
        h.begun.push(context)
        return {
          completed:
            h.popup === 'ok'
              ? Promise.resolve()
              : h.popup === 'pending'
                ? new Promise<void>((_resolve, reject) => {
                    h.rejects.push(() => reject(new Error('cancelled')))
                  })
                : Promise.reject(new Error('closed')),
          cancel: () => {
            h.cancelled += 1
          },
        }
      },
    },
  },
}))

vi.mock('../../api/mutations', () => ({
  mutate: (
    op: { path: string },
    init: { body?: unknown; params?: { header?: { 'Idempotency-Key'?: string } } }
  ) => {
    h.sent.push({ path: op.path, body: init.body, key: init.params?.header?.['Idempotency-Key'] })
    if (op.path === '/auth/discover') return h.discovery!()
    const answer = h.answers.shift()
    return answer ? answer() : Promise.resolve({ state: 'active', role: 'org_member' })
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ removeQueries: (filter: unknown) => h.removed.push(filter) }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to.replace('$org', SLUG)}>{children}</a>
  ),
}))

const found =
  (organisation: Record<string, unknown> = {}) =>
  () =>
    Promise.resolve({
      realm: SLUG,
      issuer: `https://id.example/realms/${SLUG}`,
      openid_configuration_url: `https://id.example/realms/${SLUG}/.well-known/openid-configuration`,
      organisation: { id: ORGANISATION_ID, slug: SLUG, name: NAME, realm: SLUG, ...organisation },
      candidates: [],
    })

const meListing =
  (memberships: { id?: string; state?: string; role?: string }[] = [{}]) =>
  () =>
    Promise.resolve({
      data: {
        organisations: memberships.map(
          ({ id = ORGANISATION_ID, state = 'active', role = 'org_member' }) => ({
            organisation: { id, slug: SLUG, name: NAME },
            role,
            state,
          })
        ),
      },
    })

const refused =
  (status: number, type = 'synthetic', retryAfterS?: number) =>
  () =>
    Promise.reject(
      new ApiProblem({
        type: `https://kodera.io/problems/${type}` as never,
        status,
        title: 'Synthetic',
        retryAfterS,
      })
    )

beforeEach(() => {
  h.apps = ['visio', 'messaging']
  h.appsOf = []
  h.sent = []
  h.answers = []
  h.begun = []
  h.removed = []
  h.popup = 'ok'
  h.cancelled = 0
  h.rejects = []
  h.generation = 3
  h.me = meListing()
  h.discovery = found()
  h.navigate.mockReset()
  forgetInvitationEntry()
  holdInvitationEntry({ organisationId: ORGANISATION_ID, organisationSlug: SLUG, secret: FRAGMENT })
})

const open = () => render(<AcceptScreen organisationId={ORGANISATION_ID} organisationSlug={SLUG} />)

async function signedIn() {
  const user = userEvent.setup()
  open()
  await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
  await screen.findByRole('heading', { name: `Rejoignez ${NAME} pour accéder à son espace` })
  return user
}

const acceptButton = () => screen.getByRole('button', { name: `Rejoindre ${NAME}` })
const accepts = () => h.sent.filter((sent) => sent.path === '/invitations/accept')

describe('the invitation acceptance screen', () => {
  it('names the organisation discovered for the link, then signs in to its realm', async () => {
    await signedIn()
    expect(h.sent[0]).toEqual({ path: '/auth/discover', body: { slug: SLUG }, key: undefined })
    expect(h.begun).toEqual([
      {
        purpose: 'invitation',
        intentId: expect.any(String),
        organisationId: ORGANISATION_ID,
        organisationSlug: SLUG,
        realm: SLUG,
      },
    ])
    expect(accepts()).toEqual([])
  })

  it.each([
    ['another organisation id', { id: '11111111-1111-4111-8111-111111111111' }],
    ['another slug', { slug: 'other-sa' }],
    ['another realm', { realm: 'other-sa' }],
  ])('refuses a link whose slug discovers %s, before any sign-in', async (_label, organisation) => {
    h.discovery = found(organisation)
    open()
    expect(
      await screen.findByRole('heading', {
        name: 'Ce lien d’invitation n’est pas valide. Vérifiez-le, ou demandez une nouvelle invitation.',
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(h.begun).toEqual([])
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
    // No organisation is named for a link discovery did not confirm: no initials, no name.
    const main = screen.getByRole('main')
    expect(main.querySelector('[role="img"]')).toBeNull()
    expect(within(main).queryByText(NAME)).toBeNull()
  })

  it('names the confirmed organisation above the sentence, and its heading is a route heading', async () => {
    open()
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveAttribute('data-route-heading')
    // The heading is drawn first and focused by an effect after it: wait for the focus, or a
    // loaded runner reads it in between.
    await waitFor(() => expect(heading).toHaveFocus())
    const card = screen.getByRole('main')
    const identity = within(card).getByText(NAME, { selector: 'p' })
    expect(identity).toBeVisible()
    // The organisation's initials are decoration: the name beside them is the text.
    expect(card.querySelector('[role="img"][aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByText('Invitation Kodera')).toHaveClass('text-c-accent-ink')
  })

  it('refuses a slug discovery cannot resolve', async () => {
    h.discovery = () =>
      Promise.resolve({
        realm: null,
        issuer: null,
        openid_configuration_url: null,
        organisation: null,
        candidates: [],
      })
    open()
    await screen.findByRole('heading', { name: /n’est pas valide/ })
    expect(h.begun).toEqual([])
  })

  it('sends the secret once with a key, then opens Espace for a member', async () => {
    const user = await signedIn()
    await user.click(acceptButton())
    expect(accepts()).toEqual([
      { path: '/invitations/accept', body: { token: FRAGMENT }, key: expect.any(String) },
    ])
    expect(h.removed).toEqual([{ queryKey: ['me'] }])
    expect(h.navigate).toHaveBeenCalledWith({ to: '/$org/workspace', params: { org: SLUG } })
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  })

  it('opens the home for a member of an organisation without Espace', async () => {
    h.apps = ['visio']
    const user = await signedIn()
    await user.click(acceptButton())
    expect(h.appsOf).toEqual([ORGANISATION_ID])
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: '/$org/home', params: { org: SLUG } })
    )
  })

  it('opens the organisation home for an admin', async () => {
    h.answers = [() => Promise.resolve({ state: 'active', role: 'org_admin' })]
    const user = await signedIn()
    await user.click(acceptButton())
    expect(h.navigate).toHaveBeenCalledWith({ to: '/$org/home', params: { org: SLUG } })
  })

  it('retries an unanswered acceptance with the same key and body', async () => {
    h.answers = [
      () => Promise.reject(new NetworkError(new Error('Synthetic outage'))),
      refused(503),
    ]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', {
      name: 'L’acceptation n’a pas abouti. Réessayez dans un instant.',
    })
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: /n’a pas abouti/ })
    await user.click(acceptButton())
    const [first, second, third] = accepts()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(h.navigate).toHaveBeenCalledTimes(1)
  })

  it('retries a rate-limited acceptance with a new key', async () => {
    h.answers = [refused(429)]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: /n’a pas abouti/ })
    await user.click(acceptButton())
    const [first, second] = accepts()
    expect(second!.body).toEqual(first!.body)
    expect(second!.key).not.toEqual(first!.key)
    expect(h.navigate).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      404,
      'Cette invitation n’existe pas ou a déjà été utilisée. Demandez une nouvelle invitation.',
    ],
    [410, 'Cette invitation a expiré ou a été retirée. Demandez une nouvelle invitation.'],
    [400, 'Nous n’avons pas pu confirmer votre invitation. Rouvrez le lien ou écrivez-nous à'],
  ])('answers %i with its sentence, no action, and forgets the secret', async (status, text) => {
    h.answers = [refused(status)]
    const user = await signedIn()
    await user.click(acceptButton())
    const heading = await screen.findByRole('heading', { name: new RegExp(`^${text}`) })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.queryByRole('button')).toBeNull()
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('tells an existing member so, and links to Espace', async () => {
    h.answers = [refused(409, 'conflict')]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: `Vous êtes déjà membre de ${NAME}` })
    expect(h.sent.at(-1)).toEqual({ path: '/me', body: undefined, key: undefined })
    expect(screen.getByRole('link', { name: 'Ouvrir les messages' })).toHaveAttribute(
      'href',
      `/${SLUG}/workspace`
    )
  })

  it('tells an existing admin so, and links to the home', async () => {
    h.me = meListing([{ role: 'org_admin' }])
    h.answers = [refused(409, 'conflict')]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: `Vous êtes déjà membre de ${NAME}` })
    expect(screen.getByRole('link', { name: 'Ouvrir l’accueil' })).toHaveAttribute(
      'href',
      `/${SLUG}/home`
    )
  })

  it('waits out a request still in flight, then resends the same key and body', async () => {
    h.answers = [refused(409, 'idempotency-key-in-flight', 1)]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: /n’a pas abouti/ })
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeDefined()
    expect(acceptButton()).toBeDisabled()
    await waitFor(() => expect(acceptButton()).toBeEnabled(), { timeout: 2500 })
    await user.click(acceptButton())
    const [first, second] = accepts()
    expect(second).toEqual(first)
    expect(h.navigate).toHaveBeenCalledTimes(1)
  })

  it.each([['idempotency-key-reuse'], ['synthetic']])(
    'does not read a 409 %s as membership',
    async (type) => {
      h.answers = [refused(409, type)]
      const user = await signedIn()
      await user.click(acceptButton())
      await screen.findByRole('heading', {
        name: /^Nous n’avons pas pu confirmer votre invitation/,
      })
      expect(screen.queryByRole('link')).toBeNull()
      expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
    }
  )

  it('sends nothing under another session than the one its sign-in produced', async () => {
    const user = await signedIn()
    h.generation = 4
    await user.click(acceptButton())
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument()
    expect(accepts()).toEqual([])
  })

  it('asks discovery again after no answer or a 5xx, and fails on a refusal', async () => {
    h.discovery = refused(503)
    const user = userEvent.setup()
    open()
    await screen.findByRole('heading', { name: /pas pu vérifier ce lien/ })
    h.discovery = found()
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument()
    expect(h.sent.filter((sent) => sent.path === '/auth/discover')).toHaveLength(2)
  })

  it('fails when discovery refuses the slug', async () => {
    h.discovery = refused(400)
    open()
    await screen.findByRole('heading', { name: /^Nous n’avons pas pu confirmer votre invitation/ })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('forgets the secret and cancels an open sign-in when the route is left', async () => {
    h.popup = 'pending'
    const user = userEvent.setup()
    const view = open()
    await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
    view.unmount()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(h.cancelled).toBe(1)
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  })

  it('keeps the secret through StrictMode’s rehearsal unmount', async () => {
    render(
      <StrictMode>
        <AcceptScreen organisationId={ORGANISATION_ID} organisationSlug={SLUG} />
      </StrictMode>
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument()
  })

  it.each([
    ['no membership', () => meListing([])],
    [
      'a membership of another organisation',
      () => meListing([{ id: '11111111-1111-4111-8111-111111111111' }]),
    ],
    ['a membership that is not active', () => meListing([{ state: 'suspended' }])],
    ['no answer', () => () => Promise.reject(new Error('Synthetic outage'))],
  ])(
    'on a 409 conflict whose /me shows %s, says the invitation cannot be used',
    async (_label, me) => {
      h.me = me()
      h.answers = [refused(409, 'conflict')]
      const user = await signedIn()
      await user.click(acceptButton())
      await screen.findByRole('heading', {
        name: 'Cette invitation ne peut pas être utilisée. Contactez la personne qui vous a invité(e).',
      })
      expect(screen.queryByRole('link')).toBeNull()
      expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
    }
  )

  it('on a 409 conflict, does not trust a /me read under another session', async () => {
    h.me = () => {
      h.generation = 4
      return meListing()()
    }
    h.answers = [refused(409, 'conflict')]
    const user = await signedIn()
    await user.click(acceptButton())
    await screen.findByRole('heading', { name: /ne peut pas être utilisée/ })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('asks for a new sign-in after a 401, with a new key', async () => {
    h.answers = [refused(401)]
    const user = await signedIn()
    await user.click(acceptButton())
    await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
    await screen.findByRole('heading', { name: /Rejoignez/ })
    await user.click(acceptButton())
    const [first, second] = accepts()
    expect(second!.key).not.toBe(first!.key)
    expect(h.begun).toHaveLength(2)
  })

  it('closes an open sign-in window on « Annuler » and offers the sign-in again', async () => {
    h.popup = 'pending'
    const user = userEvent.setup()
    open()
    await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
    const opened = await screen.findByRole('heading', {
      name: 'Une fenêtre de connexion est ouverte. Terminez la connexion dans cette fenêtre.',
    })
    await waitFor(() => expect(opened).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(h.cancelled).toBe(1)
    // A second sign-in is not undone by the first window's late refusal.
    await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
    await act(async () => h.rejects[0]!())
    expect(
      screen.getByRole('heading', {
        name: 'Une fenêtre de connexion est ouverte. Terminez la connexion dans cette fenêtre.',
      })
    ).toBeInTheDocument()
    expect(h.begun).toHaveLength(2)
    expect(accepts()).toEqual([])
  })

  it('offers the sign-in again when the popup is closed', async () => {
    h.popup = 'closed'
    const user = userEvent.setup()
    open()
    await user.click(await screen.findByRole('button', { name: 'Se connecter' }))
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument()
    expect(accepts()).toEqual([])
  })

  it('asks to reopen the link when the page holds no secret for its path', async () => {
    forgetInvitationEntry()
    open()
    expect(
      screen.getByRole('heading', { name: 'Rouvrez le lien de votre invitation pour continuer' })
    ).toBeInTheDocument()
    expect(h.sent).toEqual([])
  })

  it('forgets the secret when the page is left', async () => {
    open()
    window.dispatchEvent(new Event('pagehide'))
    expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  })
})
