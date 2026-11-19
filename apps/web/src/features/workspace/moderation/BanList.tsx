// The workspace's ban list, searchable by name or address, with a one-click unban. An unban is
// the contract's `unban` moderation action, audited like every other.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Avatar } from '../../../ui/Avatar/Avatar'
import { Button } from '../../../ui/Button/Button'
import { TextField } from '../../../ui/TextField/TextField'
import { isIamUnsupported, listWorkspaceBans } from '../iamApi'
import { UnbanIcon } from '../admin/AdminIcons'
import { iamKeys, retryUnlessUnsupported } from '../admin/useIam'
import {
  Loading,
  Notice,
  Panel,
  problemText,
  Unsupported,
  useAdminCopy,
  useDateTime,
} from '../admin/shared'
import { moderateMember } from './moderationApi'

export function BanList({ organisationId, epoch = 0 }: { organisationId: string; epoch?: number }) {
  const copy = useAdminCopy()
  const date = useDateTime()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const q = search.trim()
  const bans = useQuery({
    queryKey: [...iamKeys.bans(organisationId, q), epoch],
    queryFn: () => listWorkspaceBans(organisationId, { q }),
    retry: retryUnlessUnsupported,
  })
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })

  if (bans.isError && isIamUnsupported(bans.error))
    return (
      <Panel title={copy.bansTitle}>
        <Unsupported />
      </Panel>
    )

  return (
    <Panel title={copy.bansTitle} hint={copy.bansHint}>
      <TextField
        label={copy.bansSearch}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Notice text={notice.text} tone={notice.tone} />
      {bans.isError ? (
        <Notice tone="bad" text={problemText(bans.error, copy)} />
      ) : bans.data === undefined ? (
        <Loading />
      ) : bans.data.data.length === 0 ? (
        <p className="text-sm text-c-ink-2">{q === '' ? copy.bansEmpty : copy.noMatch}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-c-border-soft" aria-label={copy.bansTitle}>
          {bans.data.data.map((ban) => {
            const name = ban.display_name?.trim() || ban.email.split('@')[0] || copy.unnamed
            return (
              <li key={ban.id} className="flex items-center gap-3 py-2">
                <Avatar name={name} identity={ban.membership_id} size="xs" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  <p className="truncate text-xs text-c-ink-3">
                    {ban.email} · {copy.bannedOn(date(ban.updated_at))}
                  </p>
                </div>
                <Button
                  variant="tertiary"
                  size="sm"
                  iconOnly
                  icon={<UnbanIcon />}
                  aria-label={copy.unban(name)}
                  loading={pending === ban.id}
                  disabled={pending !== null && pending !== ban.id}
                  onClick={() => {
                    setPending(ban.id)
                    void moderateMember(organisationId, {
                      membershipId: ban.membership_id,
                      action: 'unban',
                      reason: copy.unbanReason,
                    })
                      .then(
                        () => setNotice({ text: copy.unbanned(name), tone: 'neutral' }),
                        (error: unknown) =>
                          setNotice({ text: problemText(error, copy), tone: 'bad' })
                      )
                      .finally(() => {
                        setPending(null)
                        void client.invalidateQueries({ queryKey: iamKeys.bans(organisationId, q) })
                      })
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
