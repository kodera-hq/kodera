import { useQuery } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/Button/Button'
import { TextField } from '../../../ui/TextField/TextField'
import { Select } from '../../../ui/Select/Select'
import { useWorkspaceChannels } from './useIam'
import { channelGovernanceCopy } from './channelGovernanceMessages'
import {
  grantGuest,
  proposeAgreement,
  readGovernance,
  revokeGuest,
  transitionAgreement,
} from './channelGovernanceApi'

export default function ChannelGovernancePanel({ organisationId }: { organisationId: string }) {
  const { i18n } = useTranslation()
  const copy = channelGovernanceCopy(i18n.resolvedLanguage)
  const noticeId = useId()
  const governance = useQuery({
    queryKey: ['channel-governance', organisationId],
    queryFn: () => readGovernance(organisationId),
  })
  const channels = useWorkspaceChannels(organisationId)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'failure' | null>(null)
  const [channel, setChannel] = useState('')
  const [guestChannel, setGuestChannel] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [allowCalls, setAllowCalls] = useState(false)
  const audio = channels.some((item) => item.id === guestChannel && item.kind === 'audio')
  const options = channels.map((item) => ({ value: item.id, label: item.name }))

  async function change(effect: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await effect()
      await governance.refetch()
      setNotice('saved')
    } catch {
      setNotice('failure')
    } finally {
      setBusy(false)
    }
  }

  function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!accepted || !channel) return
    const fields = new FormData(event.currentTarget)
    void change(() =>
      proposeAgreement(organisationId, {
        partnerOrganisationId: String(fields.get('partner')),
        channelId: channel,
        partnerChannelId: String(fields.get('partnerChannel')),
        localHomeserver: String(fields.get('localServer')),
        partnerHomeserver: String(fields.get('partnerServer')),
        matrixRoomId: String(fields.get('matrixRoom')),
        historyDisclosureAccepted: true,
      })
    )
  }

  function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!guestChannel) return
    const fields = new FormData(event.currentTarget)
    const expires = new Date(String(fields.get('expires')))
    if (!Number.isFinite(expires.getTime())) return
    void change(() =>
      grantGuest(organisationId, {
        guestIdentityId: String(fields.get('identity')),
        matrixUserId: String(fields.get('matrixUser')),
        channelId: guestChannel,
        matrixRoomId: String(fields.get('matrixRoom')),
        expiresAt: expires.toISOString(),
        allowCalls: audio && allowCalls,
      })
    )
  }

  if (governance.isPending) return <p role="status">{copy.loading}</p>
  if (governance.isError)
    return (
      <div role="alert">
        <p>{copy.loadFailure}</p>
        <Button
          onClick={() => {
            void governance.refetch()
          }}
        >
          {copy.refresh}
        </Button>
      </div>
    )

  return (
    <div className="flex flex-col gap-6">
      <p>{copy.introduction}</p>
      {!governance.data.enforcementReady ? <p role="status">{copy.held}</p> : null}
      <p id={noticeId} className="rounded-md border border-c-border bg-c-sunken p-4 text-sm">
        {copy.history}
      </p>
      <p role={notice === 'failure' ? 'alert' : 'status'} aria-live="polite">
        {notice ? copy[notice] : ''}
      </p>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          void governance.refetch()
        }}
      >
        {copy.refresh}
      </Button>
      <section className="flex flex-col gap-3" aria-label={copy.agreements}>
        <h3 className="font-semibold">{copy.agreements}</h3>
        {governance.data.agreements.map((agreement) => (
          <article
            key={agreement.id}
            className="flex flex-col gap-3 rounded-md border border-c-border p-4"
          >
            <p>
              {agreement.localHomeserver} · {agreement.partnerHomeserver}
            </p>
            <p>{copy.states[agreement.state]}</p>
            <div className="flex flex-wrap gap-3">
              {agreement.state === 'proposed' &&
              agreement.partnerOrganisationId === organisationId ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    void change(() => transitionAgreement(organisationId, agreement, 'activate'))
                  }}
                >
                  {copy.activate}
                </Button>
              ) : null}
              {agreement.state === 'active' ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    void change(() => transitionAgreement(organisationId, agreement, 'suspend'))
                  }}
                >
                  {copy.suspend}
                </Button>
              ) : null}
              {agreement.state === 'suspended' && agreement.organisationId === organisationId ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    void change(() => transitionAgreement(organisationId, agreement, 'repropose'))
                  }}
                >
                  {copy.repropose}
                </Button>
              ) : null}
              {agreement.state !== 'revoked' ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    void change(() => transitionAgreement(organisationId, agreement, 'revoke'))
                  }}
                >
                  {copy.revoke}
                </Button>
              ) : null}
            </div>
          </article>
        ))}
      </section>
      <form
        onSubmit={propose}
        aria-label={copy.propose}
        aria-describedby={noticeId}
        className="flex flex-col gap-4 rounded-lg border border-c-border p-5"
      >
        <h3 className="font-semibold">{copy.propose}</h3>
        <TextField required label={copy.partner} name="partner" />
        <Select
          label={copy.channel}
          value={channel}
          onValueChange={setChannel}
          options={options}
          placeholder={copy.choose}
        />
        <TextField required label={copy.partnerChannel} name="partnerChannel" />
        <TextField
          required
          label={copy.localServer}
          name="localServer"
          placeholder="matrix.example.org"
        />
        <TextField
          required
          label={copy.partnerServer}
          name="partnerServer"
          placeholder="partner.example.org"
        />
        <TextField required label={copy.matrixRoom} name="matrixRoom" />
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          {copy.accepted}
        </label>
        <Button
          type="submit"
          disabled={busy || !governance.data.enforcementReady || !accepted || !channel}
        >
          {copy.propose}
        </Button>
      </form>
      <section className="flex flex-col gap-3" aria-label={copy.guests}>
        <h3 className="font-semibold">{copy.guests}</h3>
        <p className="text-sm text-c-ink-2">{copy.guestHint}</p>
        {governance.data.guests.map((guest) => (
          <article
            key={guest.id}
            className="flex flex-col gap-3 rounded-md border border-c-border p-4"
          >
            <p>{guest.matrixUserId}</p>
            <time dateTime={guest.expiresAt}>
              {new Date(guest.expiresAt).toLocaleString(i18n.resolvedLanguage)}
            </time>
            {guest.revokedAt === null ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void change(() => revokeGuest(organisationId, guest))
                }}
              >
                {copy.revoke}
              </Button>
            ) : (
              <p>{copy.inactive}</p>
            )}
          </article>
        ))}
      </section>
      <form
        onSubmit={grant}
        aria-label={copy.grant}
        className="flex flex-col gap-4 rounded-lg border border-c-border p-5"
      >
        <h3 className="font-semibold">{copy.grant}</h3>
        <TextField required label={copy.identity} name="identity" />
        <TextField
          required
          label={copy.matrixUser}
          name="matrixUser"
          placeholder="@guest:example.org"
        />
        <Select
          label={copy.channel}
          value={guestChannel}
          onValueChange={setGuestChannel}
          options={options}
          placeholder={copy.choose}
        />
        <TextField required label={copy.matrixRoom} name="matrixRoom" />
        <TextField required label={copy.expires} name="expires" type="datetime-local" />
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            disabled={!audio}
            checked={audio && allowCalls}
            onChange={(event) => setAllowCalls(event.target.checked)}
          />
          {copy.calls}
        </label>
        <Button type="submit" disabled={busy || !governance.data.enforcementReady || !guestChannel}>
          {copy.grant}
        </Button>
      </form>
      {governance.data.agreements.length === 0 && governance.data.guests.length === 0 ? (
        <p>{copy.empty}</p>
      ) : null}
    </div>
  )
}
