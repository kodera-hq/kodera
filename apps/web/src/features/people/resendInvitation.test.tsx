import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { problem } from '../../mocks/problem'
import { server } from '../../mocks/server'
import {
  CALLER_MEMBERSHIP_ID,
  defaultMembers,
  invitation,
  peopleHandlers,
} from '../../mocks/overlays/support/people'
import { PeopleScreen, type PeopleTab } from './PeopleScreen'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(signInSynthetic)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function RetryScreen({ initialTab }: { initialTab: PeopleTab }) {
  const [tab, setTab] = useState(initialTab)
  return (
    <PeopleScreen
      organisationId={ORG_ID}
      callerRole="org_admin"
      callerMembershipId={CALLER_MEMBERSHIP_ID}
      tab={tab}
      onNavigate={(target) => {
        if (target.to === '' || target.to === 'invitations') {
          setTab(target.to === '' ? 'members' : 'invitations')
        }
      }}
    />
  )
}

function completedSendWithLostResponse(initialTab: PeopleTab) {
  const pending = invitation('retry@example.test')
  const handlers = peopleHandlers({
    callerRole: 'org_admin',
    members: defaultMembers('org_admin'),
    invitations: [pending],
  })
  const realResend = handlers.find(
    (handler) => handler.info.path === '*/api/v1/invitations/:invitation_id/actions/resend'
  )
  if (realResend === undefined) throw new Error('The stateful resend handler was not found.')
  const keys: (string | null)[] = []
  const lostFirstResponse = http.post(
    '*/api/v1/invitations/:invitation_id/actions/resend',
    async ({ request }) => {
      keys.push(request.headers.get('Idempotency-Key'))
      const result = await realResend.run({ request, requestId: crypto.randomUUID() })
      if (result?.response === undefined)
        throw new Error('The resend handler declined the request.')
      return keys.length === 1 ? HttpResponse.error() : result.response
    }
  )
  renderWithApi(<RetryScreen initialTab={initialTab} />, [handlers, [lostFirstResponse]])
  const sentCount = async () => {
    const response = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/invitations`
    )
    const body = (await response.json()) as { data: { id: string; sent_count: number }[] }
    return body.data.find((row) => row.id === pending.id)?.sent_count
  }
  return { keys, sentCount }
}

async function pressResend(tab: PeopleTab) {
  const table = await screen.findByRole('table', {
    name: tab === 'members' ? 'Personnes' : 'Invitations',
  })
  const row = await within(table).findByRole('row', { name: /retry@example.test/ })
  if (tab === 'members') {
    await userEvent.click(within(row).getByRole('button', { name: /^Actions pour/ }))
    await userEvent.click(
      screen.getByRole('menuitem', { name: i18n.t('console.people.members.action-resend') })
    )
  } else {
    await userEvent.click(
      within(row).getByRole('button', { name: i18n.t('console.people.members.action-resend') })
    )
  }
}

describe('one resend intention across lost responses', () => {
  it.each(['members', 'invitations'] as const)(
    '%s retries the completed send with the same key, then starts a new confirmed intention',
    async (tab) => {
      const { keys, sentCount } = completedSendWithLostResponse(tab)
      await pressResend(tab)
      await screen.findByText(i18n.t('console.common.error-unavailable'))
      expect(await sentCount()).toBe(2)
      await pressResend(tab)
      await screen.findByText(
        i18n.t('console.people.members.toast-resent', { person: 'retry@example.test' })
      )
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/)
      expect(keys[1]).toBe(keys[0])
      expect(await sentCount()).toBe(2)
      await pressResend(tab)
      await waitFor(() => expect(keys).toHaveLength(3))
      expect(keys[2]).not.toBe(keys[1])
      await waitFor(async () => expect(await sentCount()).toBe(3))
    }
  )

  it('keeps the failed member-row intention when the same invitation is retried on its tab', async () => {
    const { keys, sentCount } = completedSendWithLostResponse('members')
    await pressResend('members')
    await screen.findByText(i18n.t('console.common.error-unavailable'))
    await userEvent.click(screen.getByRole('tab', { name: /^Invitations/ }))
    await pressResend('invitations')
    await screen.findByText(
      i18n.t('console.people.members.toast-resent', { person: 'retry@example.test' })
    )
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(await sentCount()).toBe(2)
  })
})

describe('a resend Core refuses as final', () => {
  it.each([
    ['members', 'invitation-expired'],
    ['invitations', 'invitation-revoked'],
  ] as const)('%s says a %s invitation cannot be sent again', async (tab, type) => {
    const handlers = peopleHandlers({
      callerRole: 'org_admin',
      members: defaultMembers('org_admin'),
      invitations: [invitation('retry@example.test')],
    })
    const gone = http.post('*/api/v1/invitations/:invitation_id/actions/resend', () =>
      problem(`https://kodera.io/problems/${type}`)
    )
    renderWithApi(<RetryScreen initialTab={tab} />, [handlers, [gone]])
    await pressResend(tab)
    // Final, not « réessayez »: the contract says to invite the address again.
    await screen.findByText(i18n.t('console.people.members.error-resend-gone'))
    expect(screen.queryByText(i18n.t('console.common.error-unavailable'))).toBeNull()
  })
})

// These boundary tests use the real stateful handler and its replay cell.
// Stored counters are model evidence, not a live Core or mail-transport claim.
type ResendReplyFault = (reply: Response, requestNumber: number) => Response | Promise<Response>
function resendReceiptFixture(initialTab: PeopleTab, fault: ResendReplyFault) {
  const pending = invitation('retry@example.test')
  const handlers = peopleHandlers({
    callerRole: 'org_admin',
    members: defaultMembers('org_admin'),
    invitations: [pending],
  })
  const handler = handlers.find(
    (entry) =>
      entry.info.method === 'POST' &&
      entry.info.path === '*/api/v1/invitations/:invitation_id/actions/resend'
  )
  if (!handler) throw new Error('Actual stateful resend handler missing.')
  const requests: { invitationId: string; key: string }[] = []
  const store = async () => {
    const response = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/invitations`
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { id: string; organisation_id: string; sent_count: number }[]
    }
    const rows = body.data.filter((row) => row.id === pending.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: pending.id, organisation_id: ORG_ID })
    return rows[0]!
  }
  const boundary = http.post(
    '*/api/v1/invitations/:invitation_id/actions/resend',
    async ({ request, params }) => {
      const key = request.headers.get('Idempotency-Key')
      if (!key || params['invitation_id'] !== pending.id)
        throw new Error('Resend request is not bound to the expected invitation/key.')
      requests.push({ invitationId: String(params['invitation_id']), key })
      const number = requests.length
      const result = await handler.run({ request: request.clone(), requestId: crypto.randomUUID() })
      if (result?.response?.status !== 200)
        throw new Error('Actual stateful resend did not complete with200.')
      return fault(result.response, number)
    }
  )
  renderWithApi(<RetryScreen initialTab={initialTab} />, [handlers, [boundary]])
  return { requests, store }
}
async function changedResendReply(
  reply: Response,
  edit: (body: Record<string, unknown>) => unknown
) {
  return new HttpResponse(JSON.stringify(edit((await reply.json()) as Record<string, unknown>)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
const RESEND_SUCCESS = () =>
  i18n.t('console.people.members.toast-resent', { person: 'retry@example.test' })
const RESEND_UNAVAILABLE = () => i18n.t('console.common.error-unavailable')
async function resendOutcome() {
  await screen.findAllByText((text) => [RESEND_SUCCESS(), RESEND_UNAVAILABLE()].includes(text))
}
const unusableResendReplies: { name: string; fault: ResendReplyFault }[] = [
  { name: 'null', fault: () => HttpResponse.json(null) },
  { name: 'array', fault: () => HttpResponse.json([]) },
  { name: 'primitive', fault: () => HttpResponse.json(7) },
  {
    name: 'empty body',
    fault: () => new HttpResponse(null, { status: 200, headers: { 'Content-Length': '0' } }),
  },
  {
    name: 'missing id',
    fault: (reply) => changedResendReply(reply, ({ id: _id, ...body }) => body),
  },
  {
    name: 'numeric id',
    fault: (reply) => changedResendReply(reply, (body) => ({ ...body, id: 7 })),
  },
  {
    name: 'wrong invitation',
    fault: (reply) => changedResendReply(reply, (body) => ({ ...body, id: crypto.randomUUID() })),
  },
  {
    name: 'missing organisation',
    fault: (reply) => changedResendReply(reply, ({ organisation_id: _org, ...body }) => body),
  },
  {
    name: 'numeric organisation',
    fault: (reply) => changedResendReply(reply, (body) => ({ ...body, organisation_id: 7 })),
  },
  {
    name: 'wrong organisation',
    fault: (reply) =>
      changedResendReply(reply, (body) => ({ ...body, organisation_id: crypto.randomUUID() })),
  },
  {
    name: 'organisation case drift',
    fault: (reply) =>
      changedResendReply(reply, (body) => ({ ...body, organisation_id: ORG_ID.toUpperCase() })),
  },
]

async function expectReceiptRecovery(tab: PeopleTab, fault: ResendReplyFault, crossTab = false) {
  const fixture = resendReceiptFixture(tab, (reply, number) =>
    number === 1 ? fault(reply, number) : reply
  )
  expect((await fixture.store()).sent_count).toBe(1)
  await pressResend(tab)
  await resendOutcome()
  expect(fixture.requests).toHaveLength(1)
  const first = await fixture.store()
  expect(first.sent_count).toBe(2)
  // FIRST semantic assertion after actual200 and an independent exact-target GET.
  expect(
    screen.queryByText(RESEND_SUCCESS()),
    'UNBOUND_RESEND_RECEIPT_CANNOT_ANNOUNCE_SUCCESS after completed200 and GETcount2'
  ).toBeNull()
  expect(screen.getByText(RESEND_UNAVAILABLE())).toBeVisible()
  const retryTab = crossTab ? 'invitations' : tab
  if (crossTab) await userEvent.click(screen.getByRole('tab', { name: /^Invitations/ }))
  expect(fixture.requests).toHaveLength(1)
  await pressResend(retryTab)
  await screen.findByText(RESEND_SUCCESS())
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.requests[1]).toEqual(fixture.requests[0])
  expect(fixture.requests[0]!.key).toMatch(/^[a-f0-9-]{36}$/)
  expect(await fixture.store()).toEqual(first)
  await pressResend(retryTab)
  await waitFor(() => expect(fixture.requests).toHaveLength(3))
  expect(fixture.requests[2]!.key).not.toBe(fixture.requests[1]!.key)
  await waitFor(async () => expect((await fixture.store()).sent_count).toBe(3))
  await waitFor(() => expect(screen.getAllByText(RESEND_SUCCESS())).toHaveLength(2))
}

describe('resend receipt correlation', () => {
  describe.each(['members', 'invitations'] as const)('%s entrypoint', (tab) => {
    it.each(unusableResendReplies)(
      '$name cannot confirm or release the unresolved resend',
      async ({ fault }) => {
        await expectReceiptRecovery(tab, fault)
      }
    )
    it.each([
      { name: 'network', fault: () => HttpResponse.error() },
      {
        name: 'registered503',
        fault: () =>
          HttpResponse.json(
            { type: 'https://kodera.io/problems/service-unavailable', status: 503 },
            { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
          ),
      },
      {
        name: 'malformed JSON reader',
        fault: () =>
          new HttpResponse('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      },
    ])('$name keeps the same key through deliberate recovery', async ({ fault }) => {
      await expectReceiptRecovery(tab, fault)
    })
    it.each(['ordinary', 'optional fields absent'] as const)(
      '%s valid receipt permits a later new intention',
      async (kind) => {
        const fixture = resendReceiptFixture(tab, (reply) =>
          kind === 'ordinary'
            ? reply
            : changedResendReply(
                reply,
                ({ sent_count: _count, last_sent_at: _last, ...body }) => body
              )
        )
        await pressResend(tab)
        await screen.findByText(RESEND_SUCCESS())
        expect((await fixture.store()).sent_count).toBe(2)
        expect(screen.queryByText(RESEND_UNAVAILABLE())).toBeNull()
        await pressResend(tab)
        await waitFor(() => expect(fixture.requests).toHaveLength(2))
        expect(fixture.requests[1]!.key).not.toBe(fixture.requests[0]!.key)
        await waitFor(async () => expect((await fixture.store()).sent_count).toBe(3))
        await waitFor(() => expect(screen.getAllByText(RESEND_SUCCESS())).toHaveLength(2))
      }
    )
  })
  it('retains an unusable member-row receipt intention across a tab change', async () => {
    await expectReceiptRecovery('members', () => HttpResponse.json(null), true)
  })
  it('does not let an old valid response clear a newer still-unconfirmed intention', async () => {
    let releaseOld!: () => void, releaseNew!: () => void
    const oldReply = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    const newReply = new Promise<void>((resolve) => {
      releaseNew = resolve
    })
    const fixture = resendReceiptFixture('invitations', async (reply, number) => {
      if (number === 1) await oldReply
      if (number === 3) await newReply
      return reply
    })
    try {
      await pressResend('invitations')
      await waitFor(async () => expect((await fixture.store()).sent_count).toBe(2))
      await pressResend('invitations')
      await screen.findByText(RESEND_SUCCESS())
      expect(fixture.requests[1]).toEqual(fixture.requests[0])
      await pressResend('invitations')
      await waitFor(async () => expect((await fixture.store()).sent_count).toBe(3))
      expect(fixture.requests[2]!.key).not.toBe(fixture.requests[0]!.key)
      releaseOld()
      await waitFor(() => expect(screen.getAllByText(RESEND_SUCCESS())).toHaveLength(2))
      await pressResend('invitations')
      await waitFor(() => expect(fixture.requests).toHaveLength(4))
      expect(fixture.requests[3]!.key, 'OLD_VALID_RESPONSE_CANNOT_CLEAR_NEWER_KEY').toBe(
        fixture.requests[2]!.key
      )
      expect((await fixture.store()).sent_count).toBe(3)
      await waitFor(() => expect(screen.getAllByText(RESEND_SUCCESS())).toHaveLength(3))
    } finally {
      releaseOld()
      releaseNew()
    }
    await waitFor(() => expect(screen.getAllByText(RESEND_SUCCESS())).toHaveLength(4))
    expect(fixture.requests).toHaveLength(4)
    expect((await fixture.store()).sent_count).toBe(3)
  })
})
