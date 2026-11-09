// The claim screen's outcome mapping (docs/specs/09-owner-claim.md §5): what is sent, what the
// person reads and which action remains, for each answer `consumeOwnerClaim` can give. The
// connected journey itself is `tests/e2e/journey/first-owner.spec.ts`.
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem, NetworkError } from '../../api/client'
import type * as CoreClientModule from '../../api/client'
import type { OwnerClaimBorrow, OwnerClaimDispatchSource } from '../../api/client'
import { EXAMPLES } from '../../mocks/generated/examples'
import { ClaimScreen } from './ClaimScreen'
import { forgetClaimEntry, holdClaimEntry, readClaimEntry } from './entry'

const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const SLUG = 'acme-sa'
const SECRET = 'synthetic-invitation-secret'
const problemType = (suffix: string) => `https://kodera.io/problems/${suffix}`

const h = vi.hoisted(() => ({
  sent: [] as { key: unknown; body: unknown; bearer: unknown }[],
  answers: [] as (() => Promise<unknown>)[],
  bootstrapState: 'issued',
  owner: true as boolean,
  navigate: vi.fn(),
  popup: 'ok' as 'ok' | 'pending',
  begun: 0,
  cancelled: 0,
  /** Each pending window's rejection, which the test delivers when it chooses. */
  rejects: [] as (() => void)[],
}))

vi.mock('../../auth/oidc', () => ({
  authAdapter: {
    getSnapshot: () => ({
      status: 'ready',
      generation: 3,
      credentialGeneration: 1,
      user: { identity: { issuer: 'https://id.example/realms/acme-sa', subject: 'person' } },
    }),
    getAccessToken: () => 'synthetic-access',
    ownerClaimAuth: {
      begin: () => {
        h.begun += 1
        return {
          completed:
            h.popup === 'ok'
              ? Promise.resolve()
              : new Promise<void>((_resolve, reject) => {
                  h.rejects.push(() => reject(new Error('cancelled')))
                }),
          cancel: () => {
            h.cancelled += 1
          },
        }
      },
    },
  },
}))

vi.mock('../../api/client', async () => ({
  ...(await vi.importActual<typeof CoreClientModule>('../../api/client')),
  coreApi: () => ({
    GET: () =>
      Promise.resolve({
        data: {
          ...(EXAMPLES.getOrganisationBootstrap.body as object),
          claim: {
            ...(EXAMPLES.getOrganisationBootstrap.body as { claim: object }).claim,
            state: h.bootstrapState,
          },
        },
      }),
  }),
  dispatchOwnerClaim: (source: OwnerClaimDispatchSource) => {
    const borrow = source.borrow() as OwnerClaimBorrow
    h.sent.push({
      key: borrow.idempotencyKey,
      body: borrow.body,
      bearer: borrow.expectedAccessToken,
    })
    source.releaseBorrow(borrow)
    const answer = h.answers.shift()
    return { kind: 'started', result: answer ? answer() : Promise.resolve({}), retire: () => {} }
  },
}))

vi.mock('./freshOwner', () => ({
  loadFreshClaimOwner: () =>
    Promise.resolve(h.owner ? { organisationId: ORGANISATION_ID } : undefined),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  Link: ({ children }: { children: ReactNode }) => <a href={`/${SLUG}/order`}>{children}</a>,
}))

const refusal = (suffix: string, status: number, retryAfterS?: number) => () =>
  Promise.reject(
    new ApiProblem({ type: problemType(suffix) as never, status, title: 'Synthetic', retryAfterS })
  )

beforeEach(() => {
  h.sent = []
  h.answers = []
  h.bootstrapState = 'issued'
  h.owner = true
  h.navigate.mockReset()
  h.popup = 'ok'
  h.begun = 0
  h.cancelled = 0
  h.rejects = []
  forgetClaimEntry()
  holdClaimEntry({ organisationId: ORGANISATION_ID, organisationSlug: SLUG, secret: SECRET })
})

async function signedInToConfirm() {
  const user = userEvent.setup()
  render(<ClaimScreen organisationId={ORGANISATION_ID} organisationSlug={SLUG} />)
  await user.click(screen.getByRole('button', { name: 'Se connecter' }))
  await screen.findByRole('heading', {
    name: 'Confirmez que vous devenez propriétaire de votre organisation',
  })
  return user
}

const confirmButton = () => screen.getByRole('button', { name: 'Devenir propriétaire' })

describe('the first-owner claim screen', () => {
  it('closes an open sign-in window on « Annuler » and offers the sign-in again', async () => {
    h.popup = 'pending'
    const user = userEvent.setup()
    render(<ClaimScreen organisationId={ORGANISATION_ID} organisationSlug={SLUG} />)
    await user.click(screen.getByRole('button', { name: 'Se connecter' }))
    expect(
      await screen.findByRole('heading', {
        name: 'Une fenêtre de connexion est ouverte. Terminez la connexion dans cette fenêtre.',
      })
    ).toHaveFocus()
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
    expect(h.begun).toBe(2)
    expect(h.sent).toEqual([])
  })

  it('sends the secret once, then goes to Order once the fresh owner read agrees', async () => {
    const user = await signedInToConfirm()
    await user.click(confirmButton())
    expect(h.sent).toEqual([
      {
        key: expect.stringMatching(/^[!-~]{16,255}$/),
        body: { token: SECRET },
        bearer: 'synthetic-access',
      },
    ])
    await vi.waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: '/$org/order', params: { org: SLUG } })
    )
    expect(readClaimEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  })

  it('waits the 503’s second, then retries with the same key and body', async () => {
    h.answers.push(refusal('service-unavailable', 503, 1))
    const user = await signedInToConfirm()
    await user.click(confirmButton())
    await screen.findByRole('heading', { name: /La confirmation n’a pas abouti/ })
    expect(confirmButton()).toBeDisabled()
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)))
    expect(confirmButton()).toBeEnabled()
    await user.click(confirmButton())
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled())
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toEqual(h.sent[0])
  })

  it.each([
    ['no network', () => Promise.reject(new NetworkError(undefined))],
    ['an unreadable 200', () => Promise.reject(new SyntaxError('Unexpected token <'))],
    ['an abort', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
  ])('treats %s as unknown and lets the person retry the same request', async (_, answer) => {
    h.answers.push(answer)
    const user = await signedInToConfirm()
    await user.click(confirmButton())
    await screen.findByRole('heading', { name: /La confirmation n’a pas abouti/ })
    await user.click(confirmButton())
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled())
    expect(h.sent[1]).toEqual(h.sent[0])
  })

  it.each([
    ['owner-claim-expired', 410, 'Cette invitation a expiré. Demandez-nous un nouveau lien.'],
    [
      'owner-claim-consumed',
      409,
      'Cette invitation a déjà été utilisée. Connectez-vous normalement.',
    ],
    [
      'invalid-state-transition',
      409,
      'Cette invitation a déjà été utilisée. Connectez-vous normalement.',
    ],
    ['owner-claim-identity-mismatch', 403, 'Connectez-vous avec le compte qui a reçu l’invitation'],
    // Also Core's answer to a login older than its bound: final, no second sign-in or POST.
    [
      'mfa-required',
      403,
      'Activez la double authentification, puis rouvrez le lien de votre invitation',
    ],
    ['not-found', 404, /Ce lien d’invitation n’est pas valide/],
    ['forbidden', 403, /Nous n’avons pas pu confirmer votre invitation/],
  ])('says what a %s refusal means and offers no retry', async (suffix, status, message) => {
    h.answers.push(refusal(suffix, status))
    const user = await signedInToConfirm()
    await user.click(confirmButton())
    const heading = await screen.findByRole('heading', { name: message })
    expect(heading).toHaveFocus()
    expect(screen.queryByRole('button')).toBeNull()
    expect(h.sent).toHaveLength(1)
    expect(readClaimEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  })

  describe('the page-time deadline before the confirm', () => {
    const realNow = performance.now.bind(performance)
    let elapsedMs = 0
    beforeEach(() => {
      elapsedMs = 0
      vi.spyOn(performance, 'now').mockImplementation(() => realNow() + elapsedMs)
      return () => vi.restoreAllMocks()
    })

    it('sends the confirm whatever the device clock says: no auth_time is read', async () => {
      const realDate = Date.now.bind(Date)
      vi.spyOn(Date, 'now').mockImplementation(() => realDate() + 10 * 60 * 1000)
      const user = await signedInToConfirm()
      await user.click(confirmButton())
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled())
      expect(h.sent).toHaveLength(1)
    })

    it('sends the confirm 299 s after the sign-in returned', async () => {
      const user = await signedInToConfirm()
      elapsedMs = 299_000
      await user.click(confirmButton())
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled())
      expect(h.sent).toHaveLength(1)
    })

    it('sends nothing 300 s after the sign-in returned, and asks for a new sign-in with the link kept', async () => {
      const user = await signedInToConfirm()
      elapsedMs = 300_000
      await user.click(confirmButton())
      const again = await screen.findByRole('heading', {
        name: 'Connectez-vous avec le compte invité pour devenir propriétaire de votre organisation',
      })
      expect(again).toHaveFocus()
      expect(h.sent).toEqual([])
      expect(readClaimEntry(ORGANISATION_ID, SLUG)).toBeDefined()
      // The new sign-in restarts the page clock, so its confirm is sent.
      await user.click(screen.getByRole('button', { name: 'Se connecter' }))
      await user.click(await screen.findByRole('button', { name: 'Devenir propriétaire' }))
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalled())
      expect(h.sent).toHaveLength(1)
    })
  })

  it('offers a way on when the claim succeeded but the owner read did not', async () => {
    h.owner = false
    const user = await signedInToConfirm()
    await user.click(confirmButton())
    await screen.findByRole('heading', { name: /Votre invitation est confirmée/ })
    expect(screen.getByRole('link', { name: 'Continuer' })).toHaveAttribute(
      'href',
      `/${SLUG}/order`
    )
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('asks for the link again once the page has been left', async () => {
    const user = await signedInToConfirm()
    window.dispatchEvent(new Event('pagehide'))
    await user.click(confirmButton())
    await screen.findByRole('heading', {
      name: 'Rouvrez le lien de votre invitation pour continuer',
    })
    expect(h.sent).toEqual([])
  })
})
