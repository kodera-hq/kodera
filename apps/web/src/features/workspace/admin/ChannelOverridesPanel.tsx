// Administration › Salons & permissions: for one channel and one role, each capability is
// allowed, inherited from the role, or denied. The whole channel's overrides are replaced in one
// PUT — Core keeps allow and deny disjoint and applies the replacement atomically.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../../../ui/Button/Button'
import { cx } from '../../../ui/cx'
import { Select } from '../../../ui/Select/Select'
import {
  getChannelOverrides,
  isIamUnsupported,
  overrideState,
  setChannelOverrides,
  withOverride,
  type ChannelOverride,
  type OverrideState,
  type WorkspaceCapability,
} from '../iamApi'
import { CAPABILITY_GROUPS, mayGrant, mayManage, type RoleAuthority } from './WorkspaceRolesPanel'
import { iamKeys, retryUnlessUnsupported, useWorkspaceChannels, useWorkspaceRoles } from './useIam'
import {
  Loading,
  Notice,
  Panel,
  problemText,
  RoleDot,
  Unsupported,
  useAdminCopy,
  useDraft,
} from './shared'

const STATES: readonly OverrideState[] = ['allow', 'inherit', 'deny']
const GLYPH: Record<OverrideState, string> = { allow: '✓', inherit: '/', deny: '✕' }
const TONE: Record<OverrideState, string> = {
  allow: 'aria-checked:bg-c-ok-soft aria-checked:text-c-ok-ink',
  inherit: 'aria-checked:bg-c-muted aria-checked:text-c-ink',
  deny: 'aria-checked:bg-c-bad-soft aria-checked:text-c-bad-ink',
}

export function TriState({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: OverrideState
  disabled: boolean
  onChange: (state: OverrideState) => void
}) {
  const copy = useAdminCopy()
  // WAI-ARIA radio-group pattern: the checked option is the group's only Tab stop, and the
  // arrow keys move both the selection and the focus, wrapping around at both ends.
  const options = useRef<(HTMLButtonElement | null)[]>([])
  function move(event: KeyboardEvent<HTMLButtonElement>, from: number, delta: 1 | -1) {
    event.preventDefault()
    const state = STATES[(from + delta + STATES.length) % STATES.length]
    if (state === undefined) return
    onChange(state)
    options.current[STATES.indexOf(state)]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-c-border"
    >
      {STATES.map((state, index) => (
        <button
          key={state}
          ref={(node) => {
            options.current[index] = node
          }}
          type="button"
          role="radio"
          aria-checked={value === state}
          tabIndex={value === state ? 0 : -1}
          aria-label={copy.override[state]}
          title={copy.override[state]}
          disabled={disabled}
          onClick={() => onChange(state)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, index, 1)
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, index, -1)
          }}
          className={cx(
            'flex h-8 w-10 items-center justify-center text-sm text-c-ink-3 focus-visible:ring focus-visible:outline-hidden focus-visible:ring-inset',
            'narrow:h-[44px] narrow:w-[44px]',
            TONE[state]
          )}
        >
          <span aria-hidden="true">{GLYPH[state]}</span>
        </button>
      ))}
    </div>
  )
}

export function ChannelOverridesPanel({
  organisationId,
  authority,
}: {
  organisationId: string
  authority: RoleAuthority
}) {
  const copy = useAdminCopy()
  const client = useQueryClient()
  const channels = useWorkspaceChannels(organisationId)
  const roles = useWorkspaceRoles(organisationId)
  const [channelId, setChannelId] = useState<string | undefined>(undefined)
  const [roleId, setRoleId] = useState<string | undefined>(undefined)
  const channel = channelId ?? channels[0]?.id
  const role = roleId ?? roles.data?.roles[0]?.id
  const overrides = useQuery({
    queryKey: iamKeys.overrides(organisationId, channel ?? ''),
    queryFn: () => getChannelOverrides(organisationId, channel ?? ''),
    enabled: channel !== undefined,
    retry: retryUnlessUnsupported,
  })
  const [draft, setDraft] = useDraft<ChannelOverride[]>(overrides.data)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })
  const selectedChannel = useMemo(
    () => channels.find((item) => item.id === channel),
    [channels, channel]
  )
  const selectedRole = useMemo(
    () => roles.data?.roles.find((item) => item.id === role),
    [roles.data, role]
  )
  const applicableGroups = useMemo(() => {
    const kind = selectedChannel?.kind ?? 'text'
    const enforced: ReadonlySet<WorkspaceCapability> =
      kind === 'audio'
        ? new Set<WorkspaceCapability>(['channel.view', 'media.connect', 'media.speak'])
        : new Set<WorkspaceCapability>(['channel.view', 'message.post'])
    return CAPABILITY_GROUPS.flatMap((group) => {
      const items = group.items.filter((item) => enforced.has(item))
      return items.length > 0 ? [{ key: group.key, items }] : []
    })
  }, [selectedChannel?.kind])

  if (roles.isError)
    return isIamUnsupported(roles.error) ? (
      <Unsupported />
    ) : (
      <Notice tone="bad" text={problemText(roles.error, copy)} />
    )
  if (overrides.isError && isIamUnsupported(overrides.error)) return <Unsupported />
  if (roles.data === undefined) return <Loading />
  if (channels.length === 0)
    return (
      <Panel title={copy.sections.channels} hint={copy.channelsHint}>
        <p className="text-sm text-c-ink-2">{copy.channelsEmpty}</p>
      </Panel>
    )
  if (roles.data.roles.length === 0)
    return (
      <Panel title={copy.sections.channels} hint={copy.channelsHint}>
        <p className="text-sm text-c-ink-2">{copy.rolesEmpty}</p>
      </Panel>
    )

  const editable = selectedRole !== undefined && mayManage(authority, selectedRole)
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(overrides.data)
  const overridden = new Set((draft ?? []).map((row) => row.role_id))
  // Core refuses the whole PUT when one row names a role the caller cannot manage or a
  // capability a non-admin delegate does not hold: those cells stay read-only.
  const roleById = new Map(roles.data.roles.map((item) => [item.id, item]))
  const rowsBlocked = (draft ?? []).some((row) => {
    const rowRole = roleById.get(row.role_id)
    if (rowRole === undefined || !mayManage(authority, rowRole)) return true
    return [...row.allow, ...row.deny].some((capability) => !mayGrant(authority, capability))
  })

  function save() {
    if (draft === undefined || channel === undefined) return
    setBusy(true)
    setNotice({ text: copy.saving, tone: 'neutral' })
    void setChannelOverrides(organisationId, channel, draft)
      .then(
        (saved) => {
          client.setQueryData(iamKeys.overrides(organisationId, channel), saved)
          void client.invalidateQueries({ queryKey: ['workspace', organisationId] })
          setNotice({ text: copy.saved, tone: 'neutral' })
        },
        (error: unknown) => setNotice({ text: problemText(error, copy), tone: 'bad' })
      )
      .finally(() => setBusy(false))
  }

  return (
    <Panel title={copy.sections.channels} hint={copy.channelsHint}>
      <div className="grid grid-cols-2 gap-3 narrow:grid-cols-1">
        <Select
          label={copy.channel}
          {...(channel === undefined ? {} : { value: channel })}
          options={channels.map((item) => ({
            value: item.id,
            label: `${item.kind === 'audio' ? '🔊' : '#'} ${item.name}`,
          }))}
          onValueChange={(value) => {
            setChannelId(value)
            setNotice({ text: '', tone: 'neutral' })
          }}
        />
        <Select
          label={copy.role}
          {...(role === undefined ? {} : { value: role })}
          options={roles.data.roles.map((item) => ({
            value: item.id,
            label: `${item.name}${overridden.has(item.id) ? ' •' : ''}`,
          }))}
          onValueChange={setRoleId}
        />
      </div>
      {selectedRole === undefined ? null : (
        <p className="flex items-center gap-2 text-sm text-c-ink-2">
          <RoleDot color={selectedRole.color} />
          {editable ? copy.overrideFor(selectedRole.name) : copy.roleAboveYou}
        </p>
      )}
      {overrides.data === undefined || draft === undefined || role === undefined ? (
        overrides.isError ? (
          <Notice tone="bad" text={problemText(overrides.error, copy)} />
        ) : (
          <Loading />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {applicableGroups.map((group) => (
            <fieldset key={group.key} className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-semibold text-c-ink-3">
                {copy.capabilityGroup[group.key]}
              </legend>
              {group.items.map((capability: WorkspaceCapability) => (
                <div
                  key={capability}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-c-sunken"
                >
                  <span className="text-sm">{copy.capability[capability]}</span>
                  <TriState
                    label={copy.capability[capability]}
                    value={overrideState(draft, role, capability)}
                    disabled={!editable || busy || rowsBlocked || !mayGrant(authority, capability)}
                    onChange={(state) => setDraft(withOverride(draft, role, capability, state))}
                  />
                </div>
              ))}
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>
              {copy.save}
            </Button>
            {dirty ? (
              <Button variant="tertiary" onClick={() => overrides.data && setDraft(overrides.data)}>
                {copy.discard}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <Notice text={notice.text} tone={notice.tone} />
    </Panel>
  )
}
