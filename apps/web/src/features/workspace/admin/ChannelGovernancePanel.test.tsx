import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import ChannelGovernancePanel from './ChannelGovernancePanel'
import type { PartnerAgreement } from './channelGovernanceApi'
import { ORG, renderPanel } from './test-support'

const api = vi.hoisted(() => ({
  readGovernance: vi.fn(),
  proposeAgreement: vi.fn(),
  transitionAgreement: vi.fn(),
  grantGuest: vi.fn(),
  revokeGuest: vi.fn(),
}))
vi.mock('./channelGovernanceApi', () => api)
vi.mock('./useIam', () => ({
  useWorkspaceChannels: () => [{ id: 'channel', name: 'Shared channel', kind: 'text' }],
}))

const agreement: PartnerAgreement = {
  id: 'agreement',
  organisationId: ORG,
  partnerOrganisationId: 'peer',
  channelId: 'channel',
  partnerChannelId: 'remote-channel',
  matrixRoomId: '!shared:local.example.org',
  localHomeserver: 'local.example.org',
  partnerHomeserver: 'peer.example.org',
  federationMode: 'partner',
  state: 'active',
  revision: 4,
  replicatedHistoryErasable: false,
  historyNotice: 'Previously replicated history cannot be erased remotely.',
}

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('en')
  api.readGovernance.mockResolvedValue({
    enforcementReady: true,
    agreements: [agreement],
    guests: [],
  })
  api.transitionAgreement.mockResolvedValue({ ...agreement, state: 'suspended', revision: 5 })
})

it('discloses replicated history, requires acknowledgement and sends the displayed revision', async () => {
  const user = userEvent.setup()
  renderPanel(<ChannelGovernancePanel organisationId={ORG} />)
  expect(await screen.findByText(/Matrix history already replicated/)).toBeInTheDocument()
  const form = screen.getByRole('form', { name: 'Propose a partner channel' })
  expect(within(form).getByRole('button', { name: 'Propose a partner channel' })).toBeDisabled()
  expect(within(form).getByRole('checkbox')).not.toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Suspend' }))
  await waitFor(() =>
    expect(api.transitionAgreement).toHaveBeenCalledWith(ORG, agreement, 'suspend')
  )
  expect(await screen.findByRole('status', { name: '' })).toBeInTheDocument()
})

it('offers acceptance only to the partner and keeps failures visible', async () => {
  const user = userEvent.setup()
  api.readGovernance.mockResolvedValue({
    enforcementReady: true,
    agreements: [{ ...agreement, state: 'proposed', partnerOrganisationId: ORG }],
    guests: [],
  })
  api.transitionAgreement.mockRejectedValue(new Error('revision changed'))
  renderPanel(<ChannelGovernancePanel organisationId={ORG} />)
  await user.click(await screen.findByRole('button', { name: 'Accept agreement' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
})

it('localizes the history notice and exposes guest limits in French', async () => {
  await i18n.changeLanguage('fr')
  renderPanel(<ChannelGovernancePanel organisationId={ORG} />)
  expect(await screen.findByText(/L’historique Matrix déjà répliqué/)).toBeInTheDocument()
  expect(screen.getByText(/Les invités ne peuvent pas parcourir/)).toBeInTheDocument()
  expect(screen.getByLabelText('Référence de l’identité invitée')).toBeRequired()
})

it('shows the operator hold and supports retry after a failed read', async () => {
  api.readGovernance
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue({ enforcementReady: false, agreements: [], guests: [] })
  const user = userEvent.setup()
  renderPanel(<ChannelGovernancePanel organisationId={ORG} />)
  await user.click(await screen.findByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText(/Sharing is not enabled/)).toBeInTheDocument()
})
