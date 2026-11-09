import { createHash } from 'node:crypto'
import { flushSync } from 'react-dom'
import { onTrack, type AnalyticsEvent } from '../../analytics/track'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { PeopleScreen } from './PeopleScreen'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { ApiProblem, NetworkError } from '../../api/client'
import {
  CALLER_MEMBERSHIP_ID,
  defaultMembers,
  peopleHandlers,
} from '../../mocks/overlays/support/people'
import { server } from '../../mocks/server'
import { scenario as defaultPeople } from '../../mocks/overlays/people.default'
import { handlers as allRejected } from '../../mocks/overlays/people.invite-all-rejected'
import { handlers as seatLimit } from '../../mocks/overlays/people.seat-limit'
import { InviteDrawer, type InviteDrawerProps } from './InviteDrawer'
import type { OrganisationRole } from './roles'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'
import { http, HttpResponse } from 'msw'
import { StrictMode, Suspense, useState } from 'react'
import * as peopleQueries from './queries'
import { authAdapter } from '../../auth/oidc'
import { beforeSignIn } from '../../auth/beforeSignIn'
import {
  INVITATION_RECOVERY_KEY,
  saveInvitation,
  readInvitation,
  type InvitationOwner,
} from './invitationRecovery'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(signInSynthetic)

function renderDrawer(
  overlays: Parameters<typeof renderWithApi>[1],
  callerRole: OrganisationRole = 'org_admin'
) {
  const onClose = vi.fn()
  const onSent = vi.fn()
  renderWithApi(
    <InviteDrawer
      organisationId={ORG_ID}
      callerRole={callerRole}
      onClose={onClose}
      onSent={onSent}
    />,
    overlays
  )
  return { onClose, onSent }
}

function paste(text: string) {
  const field = screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  fireEvent.change(field, { target: { value: text } })
  fireEvent.blur(field)
  return field
}

describe('Invite by email (03-people.md §4.2)', () => {
  it('recognises a spreadsheet paste as separate addresses and counts them', async () => {
    renderDrawer([defaultPeople()])
    const field = paste('julie.leroy@acme.fr, marc.petit@acme.fr\nsamir.benali@acme.fr')
    const counter = await screen.findByText('3 adresses reconnues · 0 en double · 0 invalides')
    expect(counter).toHaveAttribute('aria-live', 'polite')
    expect(field).toHaveAccessibleDescription(expect.stringContaining('3 adresses reconnues'))
    expect(screen.getByRole('button', { name: 'Envoyer 3 invitations' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Retirer samir.benali@acme.fr' })).toBeVisible()
  })

  it('says before sending that the invitation is valid for 14 days, as Core issues it', async () => {
    renderDrawer([defaultPeople()])
    const field = paste('julie.leroy@acme.fr')
    expect(field).toHaveAccessibleDescription(
      expect.stringContaining('Elles recevront une invitation valable 14 jours.')
    )
  })

  it('describes each role by what it can do, and shows billing to an owner only', () => {
    renderDrawer([defaultPeople()], 'org_admin')
    expect(
      screen.getByRole('radio', {
        name: 'Administrateur — peut inviter et retirer, sans accès à la facturation',
      })
    ).toBeVisible()
    expect(screen.queryByRole('radio', { name: /Facturation/ })).toBeNull()
  })

  it('offers billing to an owner', () => {
    renderDrawer([defaultPeople()], 'org_owner')
    expect(screen.getByRole('radio', { name: /^Facturation/ })).toBeVisible()
  })

  it('asks for at least one address', async () => {
    renderDrawer([defaultPeople()])
    const field = screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
    expect(field).toHaveClass('border-c-border-input')
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }))
    expect(await screen.findByText('Saisissez au moins une adresse e-mail.')).toBeVisible()
    // The error edge is the readable error ink, as on every other field.
    expect(field).toHaveClass('border-c-bad-ink')
  })

  it('stays open on a partial failure, names each failure, and retries only the failures', async () => {
    const bodies: string[][] = []
    let call = 0
    const { onSent } = renderDrawer([
      defaultPeople(),
      [
        http.post('*/api/v1/organisations/:org/invitations', async ({ request }) => {
          const body = (await request.clone().json()) as { invitations: { email: string }[] }
          bodies.push(body.invitations.map((row) => row.email))
          call += 1
          if (call > 1) return undefined
          const outcomes = ['created', 'invalid_email', 'created', 'already_member'] as const
          return HttpResponse.json({
            created: 2,
            skipped: 1,
            failed: 1,
            results: body.invitations.map((row, i) => ({
              email: row.email,
              outcome: outcomes[i],
              invitation: null,
            })),
          })
        }),
      ],
    ])
    paste('anne@acme.fr\nbad@acme.fr\npaul@acme.fr\nmarc.petit@acme.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 4 invitations' }))

    const result = await screen.findByRole('region', {
      name: "2 invitations envoyées, 2 n'ont pas abouti",
    })
    expect(within(result).getByText('bad@acme.fr').closest('li')).toHaveTextContent(
      'Adresse invalide'
    )
    expect(within(result).getByText('marc.petit@acme.fr').closest('li')).toHaveTextContent(
      'Déjà membre de votre organisation'
    )
    expect(onSent).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: "Réessayer l'adresse en échec" }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual(['bad@acme.fr'])
  })

  it('keeps every address when all are rejected', async () => {
    renderDrawer([defaultPeople(), allRejected])
    const field = paste('x@acme.fr, y@acme.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 2 invitations' }))
    expect(
      await screen.findByRole('region', { name: "0 invitations envoyées, 2 n'ont pas abouti" })
    ).toBeVisible()
    expect(field).toHaveValue('x@acme.fr\ny@acme.fr')
  })

  it('closes and reports the count when every invitation is created', async () => {
    const { onSent } = renderDrawer([defaultPeople()])
    paste('nouveau@acme.fr; autre@acme.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 2 invitations' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(2))
  })

  it('names the next step when the seat limit refuses the batch', async () => {
    const { onSent, onClose } = renderDrawer([defaultPeople(), seatLimit])
    paste('nouveau@acme.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    expect(
      await screen.findByText(
        `Cette invitation n'a pas pu être créée. Écrivez-nous à ${SUPPORT_EMAIL}.`
      )
    ).toBeVisible()
    const contact = screen.getByRole('link', { name: 'Nous écrire' })
    expect(contact).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
    expect(screen.getByRole('textbox')).toHaveValue('nouveau@acme.fr')
    contact.focus()
    expect(contact).toHaveFocus()
    expect(onSent).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the addresses and offers a retry when the send fails entirely', async () => {
    renderDrawer([
      defaultPeople(),
      [http.post('*/api/v1/organisations/:org/invitations', () => HttpResponse.error())],
    ])
    const field = paste('nouveau@acme.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    expect(await screen.findByText(INVITE_UNKNOWN)).toBeVisible()
    expect(field).toHaveValue('nouveau@acme.fr')
  })
})

const recoveryOwner: InvitationOwner = {
  issuer: 'https://id.example.test/realms/acme-sa',
  subject: 'owner',
  organisationId: ORG_ID,
  membershipId: '00000000-0000-4000-8000-000000000002',
  identityId: '00000000-0000-4000-8000-000000000003',
  generation: 1,
  role: 'org_owner',
}
function recoveryDrawer(overlays: Parameters<typeof renderWithApi>[1] = [defaultPeople()]) {
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: {
      realm: 'acme-sa',
      identity: { issuer: recoveryOwner.issuer, subject: recoveryOwner.subject },
    },
  })
  return renderWithApi(
    <StrictMode>
      <InviteDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        recoveryOwner={recoveryOwner}
        onClose={vi.fn()}
        onSent={vi.fn()}
      />
    </StrictMode>,
    overlays
  )
}
describe('actual unsent invitation recovery', () => {
  beforeEach(() => sessionStorage.clear())
  it('commits exact raw text and role once without an invitation request or nonce', async () => {
    const nonce = vi.spyOn(crypto, 'randomUUID')
    let posts = 0
    saveInvitation(recoveryOwner, {
      text: 'anne@example.test\nunfinished@',
      role: 'org_admin',
      open: true,
    })
    recoveryDrawer([
      defaultPeople(),
      [
        http.post('*/api/v1/organisations/:org/invitations', () => {
          posts++
          return HttpResponse.error()
        }),
      ],
    ])
    expect(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })).toHaveValue(
      'anne@example.test\nunfinished@'
    )
    expect(screen.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
    await waitFor(() => expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull())
    expect(posts).toBe(0)
    expect(nonce).not.toHaveBeenCalled()
  })
  it('saves only the real last fields at the boundary even when the credential has expired', () => {
    recoveryDrawer()
    paste('raw unfinished@\nsecond@')
    fireEvent.click(screen.getByRole('radio', { name: /^Administrateur —/ }))
    vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue(undefined)
    beforeSignIn()
    expect(readInvitation(recoveryOwner)?.draft).toEqual({
      text: 'raw unfinished@\nsecond@',
      role: 'org_admin',
      open: true,
    })
  })
  it('does not consume fields from an unmounted restoration effect', async () => {
    saveInvitation(recoveryOwner, { text: 'unfinished@', role: 'org_admin', open: true })
    const rendered = recoveryDrawer()
    rendered.unmount()
    await Promise.resolve()
    expect(readInvitation(recoveryOwner)?.draft.text).toBe('unfinished@')
  })
  it('permanently excludes a malformed-only batch outcome even after editing it', () => {
    recoveryDrawer()
    paste('initial@example.test')
    beforeSignIn()
    expect(readInvitation(recoveryOwner)).toBeDefined()
    paste('malformed')
    fireEvent.click(screen.getByRole('button', { name: /^Envoyer/ }))
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
    paste('new-valid@example.test')
    beforeSignIn()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  })
  it('purges before allocating a nonce and excludes a pending real invitation request', async () => {
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      recoveryDrawer([
        defaultPeople(),
        [
          http.post('*/api/v1/organisations/:org/invitations', async () => {
            resolve()
            await new Promise<void>((done) => {
              release = done
            })
            return HttpResponse.error()
          }),
        ],
      ])
    })
    paste('new@example.test')
    beforeSignIn()
    expect(readInvitation(recoveryOwner)).toBeDefined()
    const nonce = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
      return '00000000-0000-4000-8000-000000000009'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await started
    beforeSignIn()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
    expect(nonce).toHaveBeenCalledTimes(1)
    release()
    await screen.findByText(INVITE_UNKNOWN)
    paste('another@example.test')
    beforeSignIn()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  })
})

it('preserves an aborted Suspense restoration without consuming during render', async () => {
  sessionStorage.clear()
  saveInvitation(recoveryOwner, { text: 'unfinished@', role: 'org_admin', open: true })
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: {
      realm: 'acme-sa',
      identity: { issuer: recoveryOwner.issuer, subject: recoveryOwner.subject },
    },
  })
  function Pending(): never {
    throw new Promise(() => {})
  }
  renderWithApi(
    <Suspense fallback={<p>pending</p>}>
      <InviteDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        recoveryOwner={recoveryOwner}
        onClose={vi.fn()}
        onSent={vi.fn()}
      />
      <Pending />
    </Suspense>
  )
  await Promise.resolve()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(readInvitation(recoveryOwner)?.draft.text).toBe('unfinished@')
})
it('preserves an intervening newer save when the actual restoration commits', async () => {
  sessionStorage.clear()
  saveInvitation(recoveryOwner, { text: 'original@', role: 'org_admin', open: true })
  recoveryDrawer()
  expect(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })).toHaveValue(
    'original@'
  )
  saveInvitation(recoveryOwner, { text: 'newer@', role: 'org_admin', open: true })
  await Promise.resolve()
  expect(readInvitation(recoveryOwner)?.draft.text).toBe('newer@')
})
it('excludes the real gap after the batch key is released but before invalidation/result completion', async () => {
  sessionStorage.clear()
  let release!: () => void
  const invalidate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  vi.spyOn(peopleQueries, 'useInvalidatePeople').mockReturnValue(invalidate)
  recoveryDrawer([defaultPeople(), allRejected])
  paste('new@example.test')
  beforeSignIn()
  expect(readInvitation(recoveryOwner)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
  beforeSignIn()
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  release()
  await screen.findByRole('region', { name: "0 invitations envoyées, 1 n'ont pas abouti" })
  paste('changed@example.test')
  beforeSignIn()
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
})
it.each(['partial', 'all rejected', 'quota'] as const)(
  'never revives a settled %s operation as an unsent draft',
  async (outcome) => {
    sessionStorage.clear()
    const partial = [
      http.post('*/api/v1/organisations/:org/invitations', async ({ request }) => {
        const body = (await request.json()) as { invitations: { email: string }[] }
        return HttpResponse.json({
          created: 1,
          skipped: 0,
          failed: 1,
          results: body.invitations.map((row, index) => ({
            email: row.email,
            outcome: index === 0 ? 'created' : 'failed',
            invitation: null,
          })),
        })
      }),
    ]
    recoveryDrawer([
      defaultPeople(),
      outcome === 'quota' ? seatLimit : outcome === 'all rejected' ? allRejected : partial,
    ])
    paste('first@example.test\nsecond@example.test')
    beforeSignIn()
    expect(readInvitation(recoveryOwner)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer 2 invitations' }))
    if (outcome === 'quota')
      await screen.findByText(
        `Cette invitation n'a pas pu être créée. Écrivez-nous à ${SUPPORT_EMAIL}.`
      )
    else
      await screen.findByRole('region', {
        name:
          outcome === 'partial'
            ? "1 invitations envoyées, 1 n'ont pas abouti"
            : "0 invitations envoyées, 2 n'ont pas abouti",
      })
    paste('third@example.test')
    fireEvent.click(screen.getByRole('radio', { name: /^Administrateur —/ }))
    beforeSignIn()
    expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  }
)

it('stops before nonce and Core when an existing recovery slot cannot be durably invalidated', async () => {
  sessionStorage.clear()
  let posts = 0
  recoveryDrawer([
    defaultPeople(),
    [
      http.post('*/api/v1/organisations/:org/invitations', () => {
        posts++
        return HttpResponse.error()
      }),
    ],
  ])
  paste('unsent@example.test')
  beforeSignIn()
  expect(readInvitation(recoveryOwner)).toBeDefined()
  const nonce = vi.spyOn(crypto, 'randomUUID')
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
  await screen.findByText(
    "Aucune invitation n'a été envoyée. Vos adresses sont conservées : réessayez."
  )
  expect(nonce).not.toHaveBeenCalled()
  expect(posts).toBe(0)
  expect(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })).toHaveValue(
    'unsent@example.test'
  )
})

// The real stateful handler commits before its reply is lost. Replay cells
// use (organisation,key); the original body fingerprint lives INSIDE the cell.
type InvitationReplyLoss =
  | 'network'
  | 'registered-503'
  | 'unregistered-503'
  | 'non-json-503'
  | ((reply: Response, effectNumber: number) => Response | Promise<Response>)
type RecordedInvitationBody = {
  invitations: { email: string; role: string }[]
  send_email: boolean
  locale: string
}
function invitationReplyLoss(fault: InvitationReplyLoss, held = false) {
  const handlers = peopleHandlers({
    callerRole: 'org_admin',
    members: defaultMembers('org_admin'),
    invitations: [],
  })
  const effect = handlers.find(
    (h) =>
      h.info.method === 'POST' &&
      h.info.path === '*/api/v1/organisations/:organisation_id/invitations'
  )
  if (!effect) throw new Error('The actual stateful invitation handler is missing.')
  const receipts = new Map<string, { bodyFingerprint: string; response: Response }>()
  const requests: {
    organisation: string
    key: string
    bodyFingerprint: string
    body: RecordedInvitationBody
  }[] = []
  let effectCalls = 0,
    firstEffect = true
  let release!: () => void, markCommitted!: () => void
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve
  })
  const committed = new Promise<void>((resolve) => {
    markCommitted = resolve
  })
  const boundary = http.post(
    '*/api/v1/organisations/:organisation_id/invitations',
    async ({ params, request }) => {
      const organisation = String(params['organisation_id']),
        key = request.headers.get('Idempotency-Key')
      if (organisation !== ORG_ID || key === null)
        throw new Error('Unbound organisation or missing intention key.')
      const text = await request.clone().text()
      const bodyFingerprint = createHash('sha256').update(text).digest('hex')
      requests.push({ organisation, key, bodyFingerprint, body: JSON.parse(text) })
      const scope = JSON.stringify([organisation, key]),
        previous = receipts.get(scope)
      if (previous) {
        if (previous.bodyFingerprint !== bodyFingerprint)
          return HttpResponse.json(
            {
              type: 'https://kodera.io/problems/idempotency-key-reuse',
              status: 409,
              title: 'The key belongs to another body.',
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } }
          )
        const replay = previous.response.clone()
        replay.headers.set('Idempotency-Replayed', 'true')
        return replay
      }
      effectCalls++
      const executed = await effect.run({
        request: request.clone(),
        requestId: crypto.randomUUID(),
      })
      if (executed?.response?.status !== 201)
        throw new Error('The actual invitation effect did not complete with 201.')
      receipts.set(scope, { bodyFingerprint, response: executed.response.clone() })
      const wasFirst = firstEffect
      firstEffect = false
      if (wasFirst) {
        markCommitted()
        if (held) await heldResponse
      }
      if (typeof fault === 'function') return fault(executed.response, effectCalls)
      if (!wasFirst) return executed.response
      if (fault === 'network') return HttpResponse.error()
      if (fault === 'non-json-503')
        return new HttpResponse('Upstream reply unavailable.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        })
      return HttpResponse.json(
        {
          type:
            fault === 'registered-503'
              ? 'https://kodera.io/problems/service-unavailable'
              : 'https://example.test/problems/unregistered-upstream-failure',
          status: 503,
          title: 'The reply could not be delivered.',
        },
        { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
      )
    }
  )
  return {
    overlays: [handlers, [boundary]],
    requests,
    committed,
    release,
    effectCalls: () => effectCalls,
  }
}
async function invitationStoreWitness(email: string) {
  const [invitesReply, membersReply] = await Promise.all([
    fetch(`https://core.example.test/api/v1/organisations/${ORG_ID}/invitations`),
    fetch(`https://core.example.test/api/v1/organisations/${ORG_ID}/memberships?state=invited`),
  ])
  expect(invitesReply.status).toBe(200)
  expect(membersReply.status).toBe(200)
  const invites = (await invitesReply.json()) as { data: peopleQueries.Invitation[] }
  const members = (await membersReply.json()) as { data: peopleQueries.Membership[] }
  return {
    invitations: invites.data.filter((r) => r.email === email),
    memberships: members.data.filter((r) => r.email === email),
  }
}
async function expectCommittedInvitation(email: string, role = 'org_member') {
  const stored = await invitationStoreWitness(email)
  expect(stored.invitations).toHaveLength(1)
  expect(stored.memberships).toHaveLength(1)
  expect(stored.invitations[0]).toMatchObject({
    organisation_id: ORG_ID,
    role,
    state: 'pending',
    sent_count: 1,
    membership_id: stored.memberships[0]!.id,
  })
  expect(stored.memberships[0]).toMatchObject({ organisation_id: ORG_ID, role, state: 'invited' })
  return stored
}
describe('invitation outcome uncertainty', () => {
  it.each(['network', 'registered-503'] as const)(
    '%s must not claim zero after an actual committed batch loses its reply',
    async (fault) => {
      const fixture = invitationReplyLoss(fault)
      const { onSent, onClose } = renderDrawer(fixture.overlays)
      const field = paste('committed@example.test')
      await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
      await fixture.committed
      await expectCommittedInvitation('committed@example.test')
      const alert = await invitationFeedback()
      expect(fixture.effectCalls()).toBe(1)
      expect(fixture.requests).toHaveLength(1)
      expect(field).toHaveValue('committed@example.test')
      expect(onSent).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      // FIRST semantic assertion, after completed effect + actual GET witness.
      // A missing new catalogue key/string cannot be this predecessor red.
      expect(
        alert,
        'FALSE_ZERO_SEND_ABSENT after committed effect and GET witness'
      ).not.toHaveTextContent("Aucune invitation n'a été envoyée.")
      expect(alert).toHaveTextContent(/résultat.*confirmé/i)
    }
  )
  it.each(['unregistered-503', 'non-json-503'] as const)(
    '%s reaches the real client as ApiProblem with null type after the effect',
    async (fault) => {
      const fixture = invitationReplyLoss(fault)
      for (const handlers of fixture.overlays) server.use(...handlers)
      const failure = await peopleQueries
        .inviteBatch(
          ORG_ID,
          [{ email: 'classified@example.test', role: 'org_member' }],
          crypto.randomUUID()
        )
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ApiProblem)
      expect(failure).toMatchObject({ status: 503, type: null })
      await fixture.committed
      await expectCommittedInvitation('classified@example.test')
      expect(fixture.effectCalls()).toBe(1)
      expect(fixture.requests).toHaveLength(1)
    }
  )
  it('deliberately replays the same org/key/body receipt without a second effect', async () => {
    const fixture = invitationReplyLoss('network')
    const { onSent } = renderDrawer(fixture.overlays)
    paste('replayed@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await invitationFeedback()
    const before = await expectCommittedInvitation('replayed@example.test')
    expect(fixture.requests).toHaveLength(1)
    expect(onSent).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
    expect(onSent).toHaveBeenCalledWith(1)
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[0]!.key).toMatch(/^[a-f0-9-]{36}$/)
    expect(fixture.requests[1]).toEqual(fixture.requests[0])
    expect(fixture.effectCalls()).toBe(1)
    expect(await expectCommittedInvitation('replayed@example.test')).toEqual(before)
  })
  it('refuses same-org/key different-body replay without effects or replacing the original receipt', async () => {
    const fixture = invitationReplyLoss('network')
    const { onSent } = renderDrawer(fixture.overlays)
    paste('original@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await invitationFeedback()
    const original = fixture.requests[0]!
    await expect(
      peopleQueries.inviteBatch(
        ORG_ID,
        [{ email: 'different@example.test', role: 'org_admin' }],
        original.key
      )
    ).rejects.toMatchObject({
      status: 409,
      type: 'https://kodera.io/problems/idempotency-key-reuse',
    })
    expect(fixture.effectCalls()).toBe(1)
    expect(await invitationStoreWitness('different@example.test')).toEqual({
      invitations: [],
      memberships: [],
    })
    expect(fixture.requests[1]!.key).toBe(original.key)
    expect(fixture.requests[1]!.bodyFingerprint).not.toBe(original.bodyFingerprint)
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
    expect(onSent).toHaveBeenCalledWith(1)
    expect(fixture.requests[2]).toEqual(original)
    expect(fixture.effectCalls()).toBe(1)
    await expectCommittedInvitation('original@example.test')
  })
  it('preserves held-response edits to both addresses and role without an automatic resend', async () => {
    const fixture = invitationReplyLoss('network', true)
    const { onSent } = renderDrawer(fixture.overlays)
    const field = paste('prior@example.test')
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
      await fixture.committed
      await expectCommittedInvitation('prior@example.test')
      expect(field).toBeEnabled()
      const admin = screen.getByRole('radio', { name: /^Administrateur —/ })
      expect(admin).toBeEnabled()
      fireEvent.change(field, { target: { value: 'edited@example.test' } })
      await userEvent.click(admin)
      expect(field).toHaveValue('edited@example.test')
      expect(admin).toBeChecked()
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0]!.body.invitations).toEqual([
        { email: 'prior@example.test', role: 'org_member' },
      ])
    } finally {
      fixture.release()
    }
    await invitationFeedback()
    expect(field).toHaveValue('edited@example.test')
    expect(screen.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
    expect(fixture.requests).toHaveLength(1)
    expect(onSent).not.toHaveBeenCalled()
    // A changed-payload deliberate send is new; current fields need not be
    // the old intention. Guidance cannot promise that they are unchanged.
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer 1 invitation' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]!.key).not.toBe(fixture.requests[0]!.key)
    expect(fixture.requests[1]!.body.invitations).toEqual([
      { email: 'edited@example.test', role: 'org_admin' },
    ])
    expect(fixture.effectCalls()).toBe(2)
    await expectCommittedInvitation('prior@example.test')
    await expectCommittedInvitation('edited@example.test', 'org_admin')
  })
})

// Response-reader feasibility: these exercise the actual MSW/fetch/json path,
// not a throwing mutation stub or a claim about physical browser cancellation.
describe('actual invitation response reader', () => {
  it.each(['TypeError', 'AbortError'] as const)(
    'propagates a modeled body-reader %s after successful headers without NetworkError wrapping',
    async (name) => {
      const fixture = invitationReplyLoss(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"created":'))
            queueMicrotask(() =>
              controller.error(
                name === 'AbortError'
                  ? new DOMException('Synthetic response reader interruption', 'AbortError')
                  : new TypeError('Synthetic response reader interruption')
              )
            )
          },
        })
        return new HttpResponse(stream, {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      })
      for (const handlers of fixture.overlays) server.use(...handlers)
      const failure = await peopleQueries
        .inviteBatch(
          ORG_ID,
          [{ email: 'reader@example.test', role: 'org_member' }],
          crypto.randomUUID()
        )
        .catch((error: unknown) => error)
      expect(failure).not.toBeInstanceOf(NetworkError)
      expect(failure).toMatchObject({ name, message: 'Synthetic response reader interruption' })
      await fixture.committed
      await expectCommittedInvitation('reader@example.test')
      expect(fixture.requests).toHaveLength(1)
    }
  )
})

const INVITE_UNKNOWN =
  "Le résultat de l'envoi n'a pas pu être confirmé. Pour réessayer le même envoi, utilisez ses adresses et son rôle d'origine. Les champs actuels peuvent avoir été modifiés."
const INVITE_CONFIRMED =
  "Le résultat de cet envoi est confirmé, mais l'écran n'a pas pu être finalisé. Vérifiez les invitations avant un nouvel envoi."
const INVITE_REFUSED =
  "Cette demande d'invitation a été refusée. Vérifiez les informations ou contactez l'assistance."
const INVITE_ZERO = "Aucune invitation n'a été envoyée. Vos adresses sont conservées : réessayez."
function invitationFeedback() {
  return screen.findByText((text) =>
    [INVITE_ZERO, INVITE_UNKNOWN, INVITE_CONFIRMED, INVITE_REFUSED].includes(text)
  )
}
function inviteSubmit() {
  return screen.getByRole('button', { name: /^(Envoyer|Réessayer)/ })
}
async function settleInvitation() {
  await waitFor(() => expect(inviteSubmit()).not.toHaveAttribute('aria-busy', 'true'))
}
function submitInvitationForm() {
  const form = screen
    .getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
    .closest('form')
  if (!form) throw new Error('Actual invitation form missing.')
  fireEvent.submit(form)
}
async function bodyReply(
  reply: Response,
  edit: (body: peopleQueries.InvitationBatchResult) => unknown
) {
  return new HttpResponse(
    JSON.stringify(edit((await reply.json()) as peopleQueries.InvitationBatchResult)),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }
  )
}
function controlledAuth() {
  let snapshot = authAdapter.getSnapshot()
  const listeners = new Set<() => void>()
  vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(() => snapshot)
  vi.spyOn(authAdapter, 'subscribe').mockImplementation((fn) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  })
  return {
    snapshot: () => snapshot,
    publish(patch: Partial<AuthSessionSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...patch }
        for (const fn of [...listeners]) fn()
      })
    },
  }
}
function changingInvitation(overlays: Parameters<typeof renderWithApi>[1], onSent = vi.fn()) {
  const onClose = vi.fn()
  let replace!: (patch: Partial<InviteDrawerProps>) => void
  function Host() {
    const [props, setProps] = useState<InviteDrawerProps>({
      organisationId: ORG_ID,
      callerRole: 'org_admin',
      onClose,
      onSent,
    })
    replace = (patch) => {
      flushSync(() => setProps((old) => ({ ...old, ...patch })))
    }
    return <InviteDrawer {...props} />
  }
  const view = renderWithApi(<Host />, overlays)
  return {
    ...view,
    onSent,
    onClose,
    replace: (patch: Partial<InviteDrawerProps>) => act(() => replace(patch)),
  }
}
// Await an actually delivered full POST body and a task turn before a
// negative publication assertion. This is not a merely started/held write.
async function finishInvitationReply(release: () => void) {
  const delivered = new Promise<void>((resolve) => {
    const listener = async ({ request, response }: { request: Request; response: Response }) => {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/invitations'))
        return
      server.events.removeListener('response:mocked', listener)
      await response.clone().text()
      resolve()
    }
    server.events.on('response:mocked', listener)
  })
  await act(async () => {
    release()
    await delivered
    await new Promise((done) => setTimeout(done, 0))
  })
}
function holdInvitation() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

type InvalidBatchCase = {
  label: string
  edit?: (b: peopleQueries.InvitationBatchResult) => unknown
  response?: () => Response
}
const INVALID_BATCHES: InvalidBatchCase[] = [
  {
    label: 'malformed JSON',
    response: () =>
      new HttpResponse('{"created":', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
  {
    label: 'empty 201',
    response: () => new HttpResponse(null, { status: 201, headers: { 'Content-Length': '0' } }),
  },
  { label: 'null body', edit: () => null },
  { label: 'missing results', edit: () => ({ created: 2, skipped: 0, failed: 0 }) },
  { label: 'null results', edit: (b) => ({ ...b, results: null }) },
  { label: 'non-array results', edit: (b) => ({ ...b, results: {} }) },
  { label: 'null row', edit: (b) => ({ ...b, results: [null, b.results[1]] }) },
  { label: 'negative count', edit: (b) => ({ ...b, created: -1 }) },
  { label: 'fractional count', edit: (b) => ({ ...b, created: 1.5 }) },
  { label: 'nonfinite count encoded null', edit: (b) => ({ ...b, created: Infinity }) },
  { label: 'string count', edit: (b) => ({ ...b, created: '2' }) },
  { label: 'count exceeds submitted rows', edit: (b) => ({ ...b, created: 3 }) },
  { label: 'missing count', edit: (b) => ({ results: b.results, skipped: 0, failed: 0 }) },
  { label: 'category mismatch with equal total', edit: (b) => ({ ...b, created: 1, skipped: 1 }) },
  { label: 'inconsistent total', edit: (b) => ({ ...b, failed: 1 }) },
  { label: 'duplicate address', edit: (b) => ({ ...b, results: [b.results[0], b.results[0]] }) },
  { label: 'missing row', edit: (b) => ({ ...b, results: b.results.slice(0, 1) }) },
  { label: 'extra row', edit: (b) => ({ ...b, results: [...b.results, b.results[0]] }) },
  { label: 'wrong order', edit: (b) => ({ ...b, results: [...b.results].reverse() }) },
  {
    label: 'wrong address',
    edit: (b) => ({
      ...b,
      results: b.results.map((r, i) => (i ? r : { ...r, email: 'wrong@example.test' })),
    }),
  },
  {
    label: 'unknown outcome',
    edit: (b) => ({
      ...b,
      results: b.results.map((r, i) => (i ? r : { ...r, outcome: 'not-a-result' })),
    }),
  },
]
describe('invitation stage and receipt contract', () => {
  it.each(INVALID_BATCHES)(
    '$label cannot confirm or discharge a committed intention',
    async (variant) => {
      const fixture = invitationReplyLoss((reply, n) =>
        n !== 1 ? reply : variant.response ? variant.response() : bodyReply(reply, variant.edit!)
      )
      const { onSent } = renderDrawer(fixture.overlays)
      const field = paste('first@example.test\nsecond@example.test')
      await userEvent.click(inviteSubmit())
      await fixture.committed
      await expectCommittedInvitation('first@example.test')
      await expectCommittedInvitation('second@example.test')
      await settleInvitation()
      expect(onSent, 'MALFORMED_RECEIPT_IS_NOT_CONFIRMATION').not.toHaveBeenCalled()
      expect(field, 'MALFORMED_RECEIPT_CANNOT_ERASE_DRAFT').toHaveValue(
        'first@example.test\nsecond@example.test'
      )
      const feedback = await invitationFeedback()
      expect(feedback, 'UNUSABLE_ACK_CANNOT_ASSERT_ZERO_EFFECT').not.toHaveTextContent(
        "Aucune invitation n'a été envoyée."
      )
      expect(feedback).toHaveTextContent(INVITE_UNKNOWN)
      await userEvent.click(inviteSubmit())
      await waitFor(() => expect(fixture.requests).toHaveLength(2))
      expect(fixture.requests[1]!.key, 'UNCONFIRMED_RECEIPT_RETAINS_ORIGINAL_KEY').toBe(
        fixture.requests[0]!.key
      )
      await waitFor(() => expect(onSent).toHaveBeenCalledWith(2))
      expect(onSent).toHaveBeenCalledTimes(1)
      expect(fixture.effectCalls()).toBe(1)
    }
  )
  it.each(['TypeError', 'AbortError'] as const)(
    'retains the key after actual response body-reader %s',
    async (name) => {
      const fixture = invitationReplyLoss((reply, n) =>
        n !== 1
          ? reply
          : new HttpResponse(
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"created":'))
                  queueMicrotask(() =>
                    c.error(
                      name === 'AbortError'
                        ? new DOMException('Synthetic reader interruption', 'AbortError')
                        : new TypeError('Synthetic reader interruption')
                    )
                  )
                },
              }),
              { status: 201 }
            )
      )
      const { onSent } = renderDrawer(fixture.overlays)
      paste('body@example.test')
      await userEvent.click(inviteSubmit())
      const feedback = await invitationFeedback()
      await expectCommittedInvitation('body@example.test')
      expect(onSent).not.toHaveBeenCalled()
      expect(feedback, 'BODY_READER_FAILURE_IS_NOT_ZERO_EFFECT').not.toHaveTextContent(
        "Aucune invitation n'a été envoyée."
      )
      await userEvent.click(inviteSubmit())
      await waitFor(() => expect(onSent).toHaveBeenCalledWith(1))
      expect(fixture.requests[1]!.key).toBe(fixture.requests[0]!.key)
      expect(fixture.effectCalls()).toBe(1)
    }
  )
  it.each([
    'null invitation and omitted optional fields',
    'case-only email differences',
    'normal receipt',
  ] as const)('%s is consumed and normal success discharges its key', async (variant) => {
    const fixture = invitationReplyLoss((reply, n) =>
      n !== 1
        ? reply
        : bodyReply(reply, (b) => ({
            created: b.created,
            skipped: b.skipped,
            failed: b.failed,
            results: b.results.map((r) => ({
              email: variant === 'case-only email differences' ? r.email.toUpperCase() : r.email,
              outcome: r.outcome,
              ...(variant === 'null invitation and omitted optional fields'
                ? { invitation: null }
                : {}),
            })),
          }))
    )
    const { onSent } = renderDrawer(fixture.overlays)
    paste('valid@example.test')
    await userEvent.click(inviteSubmit())
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(1))
    await userEvent.click(inviteSubmit())
    await waitFor(() => expect(fixture.requests).toHaveLength(2))
    expect(fixture.requests[1]!.key).not.toBe(fixture.requests[0]!.key)
    await settleInvitation()
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(fixture.effectCalls()).toBe(2)
  })
  it('counts only API-valid submitted rows, with local invalid rows separate', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const { onSent } = renderDrawer(fixture.overlays)
    paste('valid@example.test\nmalformed')
    await userEvent.click(inviteSubmit())
    await screen.findByRole('region', { name: "1 invitations envoyées, 1 n'ont pas abouti" })
    expect(fixture.requests[0]!.body.invitations).toEqual([
      { email: 'valid@example.test', role: 'org_member' },
    ])
    expect(onSent).not.toHaveBeenCalled()
  })
  it.each([400, 401, 403, 404, 409, 422, 429, 499])(
    'HTTP%s without quota is neutral refusal, preserving current key policy',
    async (status) => {
      const fixture = invitationReplyLoss(() =>
        HttpResponse.json(
          { type: 'https://example.test/problems/unregistered-refusal', status },
          { status }
        )
      )
      const { onSent } = renderDrawer(fixture.overlays)
      paste('refused@example.test')
      await userEvent.click(inviteSubmit())
      const feedback = await invitationFeedback()
      expect(onSent).not.toHaveBeenCalled()
      expect(feedback, 'REFUSAL_IS_NOT_A_ZERO_COUNT').not.toHaveTextContent(
        "Aucune invitation n'a été envoyée."
      )
      expect(feedback).toHaveTextContent(INVITE_REFUSED)
      await userEvent.click(inviteSubmit())
      await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
      expect(fixture.requests[1]!.key).toBe(fixture.requests[0]!.key)
    }
  )
  it.each([400, 503, 599])(
    'HTTP%s carrying quota type cannot use the exact409 quota branch',
    async (status) => {
      const fixture = invitationReplyLoss(() =>
        HttpResponse.json(
          { type: 'https://kodera.io/problems/quota-exceeded', status },
          { status }
        )
      )
      const { onSent } = renderDrawer(fixture.overlays)
      paste('quota-type@example.test')
      await userEvent.click(inviteSubmit())
      await settleInvitation()
      expect(onSent).not.toHaveBeenCalled()
      expect(
        screen.queryByRole('link', { name: 'Nous écrire' }),
        'QUOTA_REQUIRES_EXACT_409_NOT_TYPE_ALONE'
      ).toBeNull()
      expect(await invitationFeedback()).toHaveTextContent(
        status >= 500 ? INVITE_UNKNOWN : INVITE_REFUSED
      )
    }
  )
})

describe('invitation invocation ownership and confirmed fallback', () => {
  it('rejects two rapid form invocations before React sending state can arbitrate', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const { onSent } = renderDrawer(fixture.overlays)
    paste('rapid@example.test')
    act(() => {
      submitInvitationForm()
      submitInvitationForm()
    })
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    await settleInvitation()
    expect(fixture.requests, 'ONE_SYNCHRONOUS_FLIGHT').toHaveLength(1)
    expect(onSent).toHaveBeenCalledTimes(1)
  })
  it('acquires its flight before submission tracking can reenter', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const { onSent } = renderDrawer(fixture.overlays)
    paste('submission-reentry@example.test')
    let entered = false
    const stop = onTrack((event) => {
      if (event.name === 'people_invite_submitted' && !entered) {
        entered = true
        submitInvitationForm()
      }
    })
    try {
      await userEvent.click(inviteSubmit())
      await waitFor(() => expect(onSent).toHaveBeenCalled())
      await settleInvitation()
      expect(entered).toBe(true)
      expect(fixture.requests, 'FLIGHT_PRECEDES_EXTERNAL_SUBMISSION_TRACKING').toHaveLength(1)
      expect(onSent).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
  it.each(['result tracking', 'onSent'] as const)(
    '%s throwing after a valid receipt keeps confirmation and blocks settled-payload replay',
    async (kind) => {
      const fixture = invitationReplyLoss((r) => r)
      const onSent = vi.fn(() => {
        if (kind === 'onSent') throw new Error('Synthetic callback failure')
      })
      let trackingAttempts = 0
      const stop = onTrack((event) => {
        if (event.name === 'people_invite_result') {
          trackingAttempts++
          if (kind === 'result tracking') throw new Error('Synthetic result sink failure')
        }
      })
      try {
        renderWithApi(
          <InviteDrawer
            organisationId={ORG_ID}
            callerRole="org_admin"
            onClose={vi.fn()}
            onSent={onSent}
          />,
          fixture.overlays
        )
        paste('acknowledged@example.test')
        await userEvent.click(inviteSubmit())
        const feedback = await invitationFeedback()
        await expectCommittedInvitation('acknowledged@example.test')
        expect(feedback, 'VALID_ACK_CANNOT_BECOME_ZERO_OR_UNKNOWN').not.toHaveTextContent(
          "Aucune invitation n'a été envoyée."
        )
        expect(feedback).toHaveTextContent(INVITE_CONFIRMED)
        const count = onSent.mock.calls.length
        act(() => submitInvitationForm())
        await expectCommittedInvitation('acknowledged@example.test')
        await settleInvitation()
        expect(fixture.requests).toHaveLength(1)
        expect(trackingAttempts).toBe(1)
        expect(onSent).toHaveBeenCalledTimes(count)
        expect(count).toBe(kind === 'onSent' ? 1 : 0)
      } finally {
        stop()
      }
    }
  )
  it('marks confirmation before a result listener reenters and throws', async () => {
    const fixture = invitationReplyLoss((r) => r)
    let entered = false
    const stop = onTrack((event) => {
      if (event.name === 'people_invite_result' && !entered) {
        entered = true
        submitInvitationForm()
        throw new Error('Synthetic reentrant result failure')
      }
    })
    try {
      const { onSent } = renderDrawer(fixture.overlays)
      paste('result-reentry@example.test')
      await userEvent.click(inviteSubmit())
      await invitationFeedback()
      await expectCommittedInvitation('result-reentry@example.test')
      await settleInvitation()
      expect(entered).toBe(true)
      expect(fixture.requests, 'CONFIRMED_REENTRY_CANNOT_START_NEW_KEY').toHaveLength(1)
      expect(onSent).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
  it('marks onSent attempted before that callback reenters and throws', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const onSent = vi.fn(() => {
      if (onSent.mock.calls.length === 1) {
        submitInvitationForm()
        throw new Error('Synthetic onSent reentry')
      }
    })
    renderWithApi(
      <InviteDrawer
        organisationId={ORG_ID}
        callerRole="org_admin"
        onClose={vi.fn()}
        onSent={onSent}
      />,
      fixture.overlays
    )
    paste('callback-reentry@example.test')
    await userEvent.click(inviteSubmit())
    await invitationFeedback()
    await expectCommittedInvitation('callback-reentry@example.test')
    await settleInvitation()
    expect(fixture.requests, 'CALLBACK_ATTEMPT_PRECEDES_EXTERNAL_REENTRY').toHaveLength(1)
    expect(onSent).toHaveBeenCalledTimes(1)
  })
  it('preserves the current edited draft in known-ACK fallback and permits a changed deliberate intention', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const onSent = vi.fn(() => {
      if (onSent.mock.calls.length === 1) {
        fireEvent.change(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' }), {
          target: { value: 'later@example.test' },
        })
        fireEvent.click(screen.getByRole('radio', { name: /^Administrateur —/ }))
        throw new Error('Synthetic finalization interruption')
      }
    })
    renderWithApi(
      <InviteDrawer
        organisationId={ORG_ID}
        callerRole="org_admin"
        onClose={vi.fn()}
        onSent={onSent}
      />,
      fixture.overlays
    )
    const field = paste('before@example.test')
    await userEvent.click(inviteSubmit())
    const feedback = await invitationFeedback()
    expect(field).toHaveValue('later@example.test')
    expect(screen.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
    expect(feedback, 'CONFIRMED_DRAFT_EDIT_IS_NOT_UNKNOWN_POST').not.toHaveTextContent(
      "Aucune invitation n'a été envoyée."
    )
    expect(feedback).toHaveTextContent(INVITE_CONFIRMED)
    await userEvent.click(inviteSubmit())
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2))
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]!.key).not.toBe(fixture.requests[0]!.key)
    expect(fixture.requests[1]!.body.invitations).toEqual([
      { email: 'later@example.test', role: 'org_admin' },
    ])
  })
  it('retains a zero-created all-rejected receipt when result tracking fails, without a positive-created toast', async () => {
    const stop = onTrack((event) => {
      if (event.name === 'people_invite_result') throw new Error('Synthetic rejected-result sink')
    })
    try {
      const { onSent } = renderDrawer([defaultPeople(), allRejected])
      paste('rejected@example.test')
      await userEvent.click(inviteSubmit())
      const feedback = await invitationFeedback()
      expect(feedback, 'ZERO_CREATED_VALID_RECEIPT_IS_STILL_KNOWN').not.toHaveTextContent(
        "Aucune invitation n'a été envoyée."
      )
      expect(feedback).toHaveTextContent(INVITE_CONFIRMED)
      expect(onSent).not.toHaveBeenCalled()
      expect(screen.queryByText('1 invitation envoyée')).toBeNull()
    } finally {
      stop()
    }
  })
  it('does not turn default real list/count refetch errors into a batch failure', async () => {
    const fixture = invitationReplyLoss((r) => r)
    let refusedReads = 0
    const failedReads = ['memberships', 'memberships/count', 'invitations'].map((path) =>
      http.get(`*/api/v1/organisations/:org/${path}`, () => {
        if (!fixture.effectCalls()) return undefined
        refusedReads++
        return HttpResponse.json(
          { type: 'https://kodera.io/problems/service-unavailable', status: 503 },
          { status: 503 }
        )
      })
    )
    const onSent = vi.fn()
    renderWithApi(
      <PeopleScreen
        organisationId={ORG_ID}
        callerRole="org_admin"
        callerMembershipId={CALLER_MEMBERSHIP_ID}
        tab="members"
        onNavigate={vi.fn()}
      >
        <InviteDrawer
          organisationId={ORG_ID}
          callerRole="org_admin"
          onClose={vi.fn()}
          onSent={onSent}
        />
      </PeopleScreen>,
      [...fixture.overlays, failedReads]
    )
    paste('list-error@example.test')
    await userEvent.click(inviteSubmit())
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(1))
    await waitFor(() => expect(refusedReads).toBeGreaterThan(0))
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(INVITE_UNKNOWN)).toBeNull()
    expect(fixture.requests).toHaveLength(1)
  })
})

describe('invitation live committed context', () => {
  it.each([
    'unmount',
    'dismissal',
    'organisation',
    'caller',
    'generation',
    'pending',
    'realm',
    'identity',
    'caller away and back',
    'auth away and back',
  ] as const)(
    'retires a held receipt after %s without undoing the actual effect',
    async (boundary) => {
      const auth = controlledAuth()
      const fixture = invitationReplyLoss((r) => r, true)
      const events: AnalyticsEvent[] = []
      const stop = onTrack((event) => events.push(event))
      const view = changingInvitation(fixture.overlays)
      try {
        paste('retired@example.test')
        await userEvent.click(inviteSubmit())
        await fixture.committed
        await expectCommittedInvitation('retired@example.test')
        if (boundary === 'unmount') view.unmount()
        else if (boundary === 'dismissal')
          await userEvent.click(screen.getByRole('button', { name: 'Annuler' }))
        else if (boundary === 'organisation') view.replace({ organisationId: 'replacement-org' })
        else if (boundary === 'caller') view.replace({ callerRole: 'org_owner' })
        else if (boundary === 'caller away and back') {
          view.replace({ callerRole: 'org_owner' })
          view.replace({ callerRole: 'org_admin' })
        } else if (boundary === 'generation')
          auth.publish({ generation: auth.snapshot().generation + 1 })
        else if (boundary === 'pending') auth.publish({ status: 'pending' })
        else if (boundary === 'realm') auth.publish({ user: { realm: 'replacement-realm' } })
        else if (boundary === 'identity')
          auth.publish({
            user: {
              realm: 'acme-sa',
              identity: {
                issuer: 'https://id.example.test/realms/acme-sa',
                subject: 'replacement',
              },
            },
          })
        else {
          const original = auth.snapshot()
          auth.publish({ status: 'pending' })
          auth.publish(original)
        }
        await finishInvitationReply(fixture.release)
        expect(fixture.requests).toHaveLength(1)
        expect(view.onSent, 'OBSOLETE_CONTEXT_CANNOT_CALLBACK').not.toHaveBeenCalled()
        expect(
          events.filter((e) => e.name === 'people_invite_result'),
          'OBSOLETE_CONTEXT_CANNOT_ANNOUNCE'
        ).toHaveLength(0)
        expect(view.onClose).toHaveBeenCalledTimes(boundary === 'dismissal' ? 1 : 0)
        if (boundary !== 'unmount') expect(screen.queryByText('1 invitation envoyée')).toBeNull()
      } finally {
        fixture.release()
        stop()
      }
    }
  )
  it.each([false, true])(
    'keeps a legitimate receipt through same-owner credential rotation (processed identity present: %s)',
    async (identityPresent) => {
      const auth = controlledAuth()
      if (identityPresent)
        auth.publish({
          user: {
            realm: 'acme-sa',
            identity: { issuer: 'https://id.example.test/realms/acme-sa', subject: 'same-owner' },
          },
        })
      const fixture = invitationReplyLoss((r) => r, true)
      const { onSent } = renderDrawer(fixture.overlays)
      paste('rotation@example.test')
      try {
        await userEvent.click(inviteSubmit())
        await fixture.committed
        vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic-renewed')
        auth.publish({ credentialGeneration: auth.snapshot().credentialGeneration + 1 })
        await finishInvitationReply(fixture.release)
        await waitFor(() => expect(onSent).toHaveBeenCalledWith(1))
        expect(onSent).toHaveBeenCalledTimes(1)
        expect(fixture.requests).toHaveLength(1)
      } finally {
        fixture.release()
      }
    }
  )
  it('rechecks committed context after a nonthrowing external result listener changes it', async () => {
    const fixture = invitationReplyLoss((r) => r)
    const view = changingInvitation(fixture.overlays)
    const stop = onTrack((event) => {
      if (event.name === 'people_invite_result') view.replace({ callerRole: 'org_owner' })
    })
    try {
      paste('listener-context@example.test')
      await userEvent.click(inviteSubmit())
      await fixture.committed
      await settleInvitation()
      expect(view.onSent, 'CONTEXT_RECHECK_AFTER_EXTERNAL_CALLBACK').not.toHaveBeenCalled()
      expect(screen.queryByText('1 invitation envoyée')).toBeNull()
      expect(fixture.requests).toHaveLength(1)
    } finally {
      stop()
    }
  })
  it('an old finally cannot release a replacement context flight or its receipt', async () => {
    const first = holdInvitation(),
      second = holdInvitation()
    const fixture = invitationReplyLoss(async (reply, n) => {
      await (n === 1 ? first.promise : second.promise)
      return reply
    })
    const view = changingInvitation(fixture.overlays)
    paste('old-flight@example.test')
    try {
      await userEvent.click(inviteSubmit())
      await fixture.committed
      view.replace({ callerRole: 'org_owner' })
      fireEvent.change(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' }), {
        target: { value: 'new-flight@example.test' },
      })
      act(() => submitInvitationForm())
      await waitFor(() => expect(fixture.requests).toHaveLength(2))
      await finishInvitationReply(first.release)
      expect(view.onSent, 'OLD_RECEIPT_MUST_NOT_COMPLETE_NEW_CONTEXT').not.toHaveBeenCalled()
      expect(inviteSubmit(), 'OLD_FINALLY_MUST_NOT_CLEAR_NEW_BUSY').toHaveAttribute(
        'aria-busy',
        'true'
      )
      act(() => submitInvitationForm())
      await expectCommittedInvitation('new-flight@example.test')
      expect(fixture.requests).toHaveLength(2)
      await finishInvitationReply(second.release)
      await waitFor(() => expect(view.onSent).toHaveBeenCalledTimes(1))
      expect(view.onSent).toHaveBeenCalledWith(1)
    } finally {
      first.release()
      second.release()
    }
  })
})

describe('invitation review regressions', () => {
  it.each(['unknown reply', 'neutral refusal', 'confirmed fallback'] as const)(
    '%s has one error announcement distinct from the address counter',
    async (kind) => {
      const fixture = invitationReplyLoss(
        kind === 'unknown reply'
          ? 'network'
          : kind === 'neutral refusal'
            ? () => HttpResponse.json({ status: 422 }, { status: 422 })
            : (reply) => reply
      )
      const onSent = vi.fn(() => {
        if (kind === 'confirmed fallback') throw new Error('Synthetic finalization failure')
      })
      renderWithApi(
        <InviteDrawer
          organisationId={ORG_ID}
          callerRole="org_admin"
          onClose={vi.fn()}
          onSent={onSent}
        />,
        fixture.overlays
      )
      const field = paste('announcement@example.test')
      const counter = document.getElementById(
        field
          .getAttribute('aria-describedby')!
          .split(' ')
          .find((id) => document.getElementById(id)?.hasAttribute('aria-live'))!
      )!
      expect(counter).toHaveAttribute('aria-live', 'polite')
      expect(screen.queryAllByRole('alert')).toHaveLength(0)
      await userEvent.click(inviteSubmit())
      const feedback = await invitationFeedback()
      await expectCommittedInvitation('announcement@example.test')
      await settleInvitation()
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.effectCalls()).toBe(1)
      expect(onSent).toHaveBeenCalledTimes(kind === 'confirmed fallback' ? 1 : 0)
      // First announcement assertion follows the actual outcome and GET witness.
      const alerts = screen.queryAllByRole('alert')
      expect(alerts, 'SEND_OUTCOME_HAS_ONE_ALERT_OWNER').toHaveLength(1)
      const alert = alerts[0]!
      expect(alert).toContainElement(feedback)
      expect(alert).toHaveTextContent(
        kind === 'unknown reply'
          ? INVITE_UNKNOWN
          : kind === 'neutral refusal'
            ? INVITE_REFUSED
            : INVITE_CONFIRMED
      )
      expect(within(alert).queryAllByRole('alert')).toHaveLength(0)
      expect(alert.parentElement!.closest('[role="alert"], [aria-live]')).toBeNull()
      expect(counter).toBeInTheDocument()
      expect(counter).not.toContainElement(feedback)
      expect(counter).not.toHaveAttribute('role', 'alert')
    }
  )

  it.each(['removed', 'replaced', 'kept'] as const)(
    'uses the %s local-invalid snapshot when deliberately replaying the same valid batch',
    async (edit) => {
      const fixture = invitationReplyLoss('network')
      const { onSent } = renderDrawer(fixture.overlays)
      const field = paste('local-replay@example.test\noriginal-malformed')
      await userEvent.click(inviteSubmit())
      await fixture.committed
      const before = await expectCommittedInvitation('local-replay@example.test')
      await invitationFeedback()
      await settleInvitation()
      expect(onSent).not.toHaveBeenCalled()
      const currentInvalid =
        edit === 'removed'
          ? ''
          : edit === 'replaced'
            ? 'replacement-malformed'
            : 'original-malformed'
      fireEvent.change(field, {
        target: { value: ['local-replay@example.test', currentInvalid].filter(Boolean).join('\n') },
      })
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.effectCalls()).toBe(1)
      await userEvent.click(inviteSubmit())
      await settleInvitation()
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.requests[1]).toEqual(fixture.requests[0])
      expect(fixture.requests[0]!.body.invitations).toEqual([
        { email: 'local-replay@example.test', role: 'org_member' },
      ])
      expect(fixture.effectCalls()).toBe(1)
      expect(await expectCommittedInvitation('local-replay@example.test')).toEqual(before)
      if (edit === 'removed') {
        expect(onSent, 'REMOVED_LOCAL_INVALID_CANNOT_SUPPRESS_COMPLETION').toHaveBeenCalledTimes(1)
        expect(onSent).toHaveBeenCalledWith(1)
        expect(field).toHaveValue('local-replay@example.test')
        expect(screen.queryByRole('region', { name: /n'ont pas abouti/ })).toBeNull()
        expect(screen.queryByText('original-malformed')).toBeNull()
      } else {
        expect(field, 'RETRY_USES_CURRENT_INVOCATION_LOCAL_INVALID').toHaveValue(currentInvalid)
        const result = screen.getByRole('region', {
          name: "1 invitations envoyées, 1 n'ont pas abouti",
        })
        expect(within(result).getByText(currentInvalid).closest('li')).toHaveTextContent(
          'Adresse invalide'
        )
        if (edit === 'replaced') expect(within(result).queryByText('original-malformed')).toBeNull()
        expect(onSent).not.toHaveBeenCalled()
      }
    }
  )

  it('uses invocation-time local validation rather than reading edits after the reply', async () => {
    const fixture = invitationReplyLoss((reply) => reply, true)
    const { onSent } = renderDrawer(fixture.overlays)
    const field = paste('local-held@example.test\nsubmitted-malformed')
    try {
      await userEvent.click(inviteSubmit())
      await fixture.committed
      await expectCommittedInvitation('local-held@example.test')
      fireEvent.change(field, {
        target: { value: 'local-held@example.test\nlater-malformed' },
      })
      expect(fixture.requests).toHaveLength(1)
    } finally {
      fixture.release()
    }
    const result = await screen.findByRole('region', {
      name: "1 invitations envoyées, 1 n'ont pas abouti",
    })
    expect(field).toHaveValue('submitted-malformed')
    expect(within(result).getByText('submitted-malformed')).toBeVisible()
    expect(within(result).queryByText('later-malformed')).toBeNull()
    expect(onSent).not.toHaveBeenCalled()
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.effectCalls()).toBe(1)
  })
})
