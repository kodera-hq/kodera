import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ApiProblem } from '../../api/client'
import { CommunitySupport } from './CommunitySupport'
import { communitySupportHref, createCommunitySupportTicket } from './communitySupportClient'
const state = vi.hoisted(() => ({ stamp: {}, navigate: vi.fn(), usable: true }))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: state.navigate }) }))
vi.mock('../../auth/AuthProvider', () => ({
  useAuthLifetime: () => ({
    hasUsableCredential: () => state.usable,
    getRetirementStamp: () => state.stamp,
  }),
}))
vi.mock('./communitySupportClient', () => ({
  communitySupportHref: vi.fn(),
  createCommunitySupportTicket: vi.fn(),
}))
beforeEach(async () => {
  state.stamp = {}
  state.usable = true
  state.navigate.mockReset()
  vi.mocked(communitySupportHref).mockReset().mockResolvedValue('/community/workspace/support-id')
  vi.mocked(createCommunitySupportTicket).mockReset().mockResolvedValue({
    id: '11111111-2222-4333-8444-555555555555',
    state: 'open',
    priority: 'P2',
    queue: 'product-engineering',
    confirmation: 'ticket-created',
  })
  await i18n.changeLanguage('en')
})
async function fill() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Subject'), 'Cannot open a room')
  await user.type(
    screen.getByLabelText('How can we help?'),
    'The room stays unavailable after signing in.'
  )
  return user
}
it('opens the actual support channel with one click', async () => {
  render(<CommunitySupport organisationId="community-id" />)
  await userEvent.click(screen.getByRole('button', { name: /Join support/ }))
  expect(communitySupportHref).toHaveBeenCalledWith('community-id')
  expect(state.navigate).toHaveBeenCalledWith({ href: '/community/workspace/support-id' })
})
it('creates a private ticket and shows the receipt without retaining prose', async () => {
  render(<CommunitySupport organisationId="community-id" />)
  const user = await fill()
  await user.click(screen.getByRole('button', { name: 'Send a support request' }))
  expect(createCommunitySupportTicket).toHaveBeenCalledWith(
    'Cannot open a room',
    'The room stays unavailable after signing in.',
    'en',
    expect.any(String)
  )
  expect(screen.getByRole('status')).toHaveTextContent('11111111-2222-4333-8444-555555555555')
  expect(screen.getByLabelText('Subject')).toHaveValue('')
  expect(screen.getByLabelText('How can we help?')).toHaveValue('')
})
it('keeps one idempotency key for an unchanged retry and explains rate limits', async () => {
  vi.mocked(createCommunitySupportTicket).mockRejectedValueOnce(
    new ApiProblem({ type: null, status: 429, title: 'internal text' })
  )
  render(<CommunitySupport organisationId="community-id" />)
  const user = await fill()
  await user.click(screen.getByRole('button', { name: 'Send a support request' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Too many requests')
  await user.click(screen.getByRole('button', { name: 'Send a support request' }))
  expect(vi.mocked(createCommunitySupportTicket).mock.calls[0]![3]).toBe(
    vi.mocked(createCommunitySupportTicket).mock.calls[1]![3]
  )
})
it('does not navigate after the credential has retired', async () => {
  let resolve!: (href: string) => void
  vi.mocked(communitySupportHref).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  render(<CommunitySupport organisationId="community-id" />)
  await userEvent.click(screen.getByRole('button', { name: /Join support/ }))
  state.stamp = {}
  resolve('/community/workspace/private')
  await waitFor(() => expect(communitySupportHref).toHaveBeenCalledTimes(1))
  expect(state.navigate).not.toHaveBeenCalled()
})
it('offers the email fallback when the canonical workspace is not provisioned', () => {
  render(<CommunitySupport organisationId={undefined} />)
  expect(screen.getByText(/not available yet/)).toBeVisible()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
