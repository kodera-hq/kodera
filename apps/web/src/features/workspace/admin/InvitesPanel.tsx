// Administration › Invitations: every active invite link — who made it, where it leads, how
// often it was used, when it ends and which roles it hands out — with revocation behind a
// confirmation, a new-link form, and the workspace-wide pause.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '../../../ui/Button/Button'
import { Checkbox } from '../../../ui/Checkbox/Checkbox'
import { CopyableField } from '../../../ui/CopyableField/CopyableField'
import { Select } from '../../../ui/Select/Select'
import { Switch } from '../../../ui/Switch/Switch'
import { TextField } from '../../../ui/TextField/TextField'
import {
  createInvite,
  isIamUnsupported,
  listInvites,
  updateWorkspaceProfile,
  type WorkspaceRole,
} from '../iamApi'
import { expiryIn, inviteUrl, revokeInviteLink } from '../moderation/moderationApi'
import { PlusIcon, RevokeIcon } from './AdminIcons'
import { iamKeys, useWorkspaceChannels, useWorkspaceProfile, useWorkspaceRoles } from './useIam'
import { mayManage, type RoleAuthority } from './WorkspaceRolesPanel'
import {
  ConfirmIconAction,
  Loading,
  Notice,
  Panel,
  problemText,
  RolePill,
  useAdminCopy,
  useDateTime,
} from './shared'

const NO_CHANNEL = 'none'

export function InvitesPanel({
  organisationId,
  authority,
}: {
  organisationId: string
  authority: RoleAuthority
}) {
  const copy = useAdminCopy()
  const date = useDateTime()
  const client = useQueryClient()
  const channels = useWorkspaceChannels(organisationId)
  const roles = useWorkspaceRoles(organisationId)
  const profile = useWorkspaceProfile(organisationId)
  const invites = useQuery({
    queryKey: iamKeys.invites(organisationId),
    queryFn: () => listInvites(organisationId),
  })
  const [creating, setCreating] = useState(false)
  const [days, setDays] = useState('7')
  const [maxUses, setMaxUses] = useState('25')
  const [role, setRole] = useState<'org_member' | 'moderator'>('org_member')
  const [channelId, setChannelId] = useState(NO_CHANNEL)
  const [autoRoles, setAutoRoles] = useState<string[]>([])
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })
  const reload = () => void client.invalidateQueries({ queryKey: iamKeys.invites(organisationId) })
  const roleById = new Map<string, WorkspaceRole>((roles.data?.roles ?? []).map((r) => [r.id, r]))
  const channelName = (id: string | null) => {
    if (id === null) return copy.inviteNoChannel
    const found = channels.find((channel) => channel.id === id)
    return found === undefined ? copy.inviteChannelGone : `#${found.name}`
  }
  const paused = profile.data?.value.invites_paused === true

  function togglePause(next: boolean) {
    if (profile.data === undefined) return
    setBusy(true)
    void updateWorkspaceProfile(organisationId, { invites_paused: next }, profile.data.etag)
      .then(
        (saved) => {
          client.setQueryData(iamKeys.profile(organisationId), saved)
          setNotice({ text: next ? copy.invitesPausedOn : copy.invitesPausedOff, tone: 'neutral' })
        },
        (error: unknown) => {
          setNotice({ text: problemText(error, copy), tone: 'bad' })
          // A stale tag (412/428) means the profile moved on: reload it so the next toggle
          // carries a fresh etag instead of failing again.
          void profile.refetch()
        }
      )
      .finally(() => setBusy(false))
  }

  function create() {
    setBusy(true)
    setNotice({ text: '', tone: 'neutral' })
    // Core refuses an auto-role the caller cannot manage (403): never send one.
    const manageableRoles = autoRoles.filter((id) => {
      const item = roleById.get(id)
      return item !== undefined && mayManage(authority, item)
    })
    void createInvite(organisationId, {
      expiresAt: expiryIn(Number(days)),
      maxUses: Number(maxUses),
      role,
      channelId: channelId === NO_CHANNEL ? undefined : channelId,
      autoRoleIds: manageableRoles,
    })
      .then(
        ({ code }) => {
          // The code is shown once: Core keeps only its digest.
          setCreated(inviteUrl(code))
          setCopied(false)
          setCreating(false)
          setAutoRoles([])
          reload()
        },
        (error: unknown) => setNotice({ text: problemText(error, copy), tone: 'bad' })
      )
      .finally(() => setBusy(false))
  }

  return (
    <Panel
      title={copy.sections.invites}
      hint={copy.invitesHint}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon />}
          disabled={paused || creating}
          onClick={() => setCreating(true)}
        >
          {copy.inviteCreate}
        </Button>
      }
    >
      {profile.isError && isIamUnsupported(profile.error) ? null : (
        <Switch
          label={copy.invitesPause}
          help={copy.invitesPauseHint}
          checked={paused}
          disabled={busy || profile.data === undefined}
          onCheckedChange={togglePause}
        />
      )}
      {creating ? (
        <form
          aria-label={copy.inviteCreate}
          className="flex flex-col gap-4 rounded-md bg-c-sunken p-4"
          onSubmit={(event) => {
            event.preventDefault()
            create()
          }}
        >
          <div className="grid grid-cols-2 gap-3 narrow:grid-cols-1">
            <TextField
              label={copy.inviteDays}
              type="number"
              min={1}
              max={30}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            <TextField
              label={copy.inviteUses}
              type="number"
              min={1}
              max={10000}
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
            />
            <Select
              label={copy.inviteRole}
              value={role}
              onValueChange={(value) => setRole(value === 'moderator' ? 'moderator' : 'org_member')}
              options={[
                { value: 'org_member', label: copy.inviteRoleMember },
                { value: 'moderator', label: copy.inviteRoleModerator },
              ]}
            />
            <Select
              label={copy.inviteChannel}
              value={channelId}
              onValueChange={setChannelId}
              options={[
                { value: NO_CHANNEL, label: copy.inviteNoChannel },
                ...channels
                  .filter((channel) => channel.kind === 'text')
                  .map((channel) => ({ value: channel.id, label: `#${channel.name}` })),
              ]}
            />
          </div>
          {(roles.data?.roles.length ?? 0) === 0 ? null : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{copy.inviteAutoRoles}</legend>
              <div className="grid grid-cols-2 gap-2 narrow:grid-cols-1">
                {(roles.data?.roles ?? []).map((item) => (
                  <Checkbox
                    key={item.id}
                    label={item.name}
                    checked={autoRoles.includes(item.id)}
                    disabled={!mayManage(authority, item)}
                    onCheckedChange={(checked) =>
                      setAutoRoles((current) =>
                        checked === true
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id)
                      )
                    }
                  />
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              {copy.inviteCreate}
            </Button>
            <Button type="button" variant="tertiary" onClick={() => setCreating(false)}>
              {copy.cancel}
            </Button>
          </div>
        </form>
      ) : null}
      {created === null ? null : (
        <div className="flex flex-col gap-2">
          <CopyableField
            label={copy.inviteNew}
            value={created}
            layout="stacked"
            status={copied ? 'copied' : 'idle'}
            copyLabel={copy.copy}
            copiedLabel={copy.copied}
            onCopy={() => {
              void navigator.clipboard?.writeText(created).then(
                () => setCopied(true),
                () => setNotice({ text: copy.problemGeneric, tone: 'bad' })
              )
            }}
          />
          <p className="text-xs text-c-ink-3">{copy.inviteOnce}</p>
        </div>
      )}
      <Notice text={notice.text} tone={notice.tone} />
      {invites.isError ? (
        <Notice tone="bad" text={problemText(invites.error, copy)} />
      ) : invites.data === undefined ? (
        <Loading />
      ) : invites.data.length === 0 ? (
        <p className="text-sm text-c-ink-2">{copy.invitesEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{copy.sections.invites}</caption>
            <thead className="text-xs text-c-ink-3">
              <tr>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteHost}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteCode}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteChannel}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteUsesShort}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteExpires}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {copy.inviteAutoRoles}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">{copy.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-c-border-soft">
              {invites.data.map((link) => (
                <tr key={link.id}>
                  <td className="py-2 pr-3">{link.host ?? copy.unnamed}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-c-ink-2">
                    <span aria-label={copy.inviteCodeHidden}>•••• {link.id.slice(-4)}</span>
                  </td>
                  <td className="py-2 pr-3">{channelName(link.channelId)}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {link.usesCount} / {link.maxUses}
                  </td>
                  <td className="py-2 pr-3">{date(link.expiresAt)}</td>
                  <td className="py-2 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {link.role === 'moderator' ? (
                        <span className="text-xs text-c-ink-2">{copy.inviteRoleModerator}</span>
                      ) : null}
                      {link.autoRoleIds.map((id) => {
                        const found = roleById.get(id)
                        return found === undefined ? null : <RolePill key={id} role={found} />
                      })}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    <ConfirmIconAction
                      icon={<RevokeIcon />}
                      label={copy.inviteRevoke(channelName(link.channelId))}
                      title={copy.inviteRevokeTitle}
                      consequence={copy.inviteRevokeConsequence}
                      confirmLabel={copy.inviteRevokeConfirm}
                      busy={busy}
                      onConfirm={() =>
                        void revokeInviteLink(organisationId, link.id).then(
                          () => {
                            setNotice({ text: copy.inviteRevoked, tone: 'neutral' })
                            reload()
                          },
                          (error: unknown) =>
                            setNotice({ text: problemText(error, copy), tone: 'bad' })
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
